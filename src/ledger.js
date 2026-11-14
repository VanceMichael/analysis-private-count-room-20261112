import { hostname } from 'node:os';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrivacyCountError } from './errors.js';
import { canonical, fingerprint } from './dataset.js';

const LEDGER_VERSION = 1;
const MAX_AUDIT_EVENTS = 1000;

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // 部分文件系统不支持目录 fsync；文件本身已经 fsync 后原子替换。
  } finally {
    if (handle) await handle.close();
  }
}

/** 先写临时文件、fsync、再原子替换；读者只会看到完整旧文件或完整新文件。 */
export async function writeJsonAtomic(path, value) {
  const destination = resolve(path);
  const directory = resolve(destination, '..');
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(canonical(value), null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(() => {});
  }
}

function ledgerPathOf(stateDir) {
  return join(resolve(stateDir), 'ledger.json');
}

function lockPathOf(stateDir) {
  return join(resolve(stateDir), 'ledger.lock');
}

export function emptyLedger(identity) {
  return {
    version: LEDGER_VERSION,
    datasetVersion: identity.datasetVersion,
    policyHash: identity.policyHash,
    scopes: {},
    entries: {},
    reservations: {},
    audit: []
  };
}

export function validateLedgerIdentity(ledger, identity) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)
    || ledger.version !== LEDGER_VERSION
    || ledger.datasetVersion !== identity.datasetVersion
    || ledger.policyHash !== identity.policyHash) {
    throw new PrivacyCountError('STATE_MISMATCH',
      '持久状态与当前数据集版本或合作方策略不一致，请使用新的状态目录');
  }
  for (const field of ['scopes', 'entries', 'reservations']) {
    if (ledger[field] === null || typeof ledger[field] !== 'object' || Array.isArray(ledger[field])) {
      throw new PrivacyCountError('STATE_MISMATCH', '持久状态格式无效');
    }
  }
  if (!Array.isArray(ledger.audit)) ledger.audit = [];
  return ledger;
}

async function readLedgerFile(stateDir, identity) {
  let text;
  try {
    text = await readFile(ledgerPathOf(stateDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLedger(identity);
    throw error;
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch {
    throw new PrivacyCountError('STATE_MISMATCH', '持久状态无法解析，拒绝继续以免丢失预算记录');
  }
  return validateLedgerIdentity(ledger, identity);
}

/**
 * 恢复扫描。reservation 先扣费、后计算噪声，所以：
 * - 已有同 txid 的 entry → 标记 committed；
 * - 同主机且进程已退出 → orphaned（预算不退，避免崩溃后免费重抽）；
 * - 跨主机或无法确认 → 只有超过 orphanAfterMs 才 orphaned，防止误伤慢请求。
 */
export function reconcileReservations(ledger, { orphanAfterMs = 15 * 60_000, now = Date.now() } = {}) {
  let changed = false;
  const host = hostname();
  for (const [txid, reservation] of Object.entries(ledger.reservations)) {
    if (reservation.status !== 'reserved') continue;
    const entry = ledger.entries[reservation.cacheKey];
    if (entry && entry.txid === txid) {
      reservation.status = 'committed';
      changed = true;
      continue;
    }
    const dead = reservation.hostname === host && !processAlive(reservation.pid);
    const expired = now - Date.parse(reservation.at) > orphanAfterMs;
    if (dead || expired) {
      reservation.status = 'orphaned';
      ledger.audit.push({ at: new Date(now).toISOString(), event: 'orphaned-reservation',
        txid, cacheKey: reservation.cacheKey, scopeKey: reservation.scopeKey,
        epsilonMicro: reservation.epsilonMicro, reason: dead ? 'process-exited' : 'timeout' });
      changed = true;
    }
  }
  if (ledger.audit.length > MAX_AUDIT_EVENTS) {
    ledger.audit = ledger.audit.slice(-MAX_AUDIT_EVENTS);
    changed = true;
  }
  return changed;
}

export class LedgerStore {
  constructor(stateDir, identity, options = {}) {
    this.stateDir = resolve(stateDir);
    this.identity = identity;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.orphanAfterMs = options.orphanAfterMs ?? 15 * 60_000;
    this.snapshotWaitMs = options.snapshotWaitMs ?? 10_000;
    this.lockToken = null;
  }

  async acquire() {
    await mkdir(this.stateDir, { recursive: true });
    const path = lockPathOf(this.stateDir);
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ token, pid: process.pid,
          hostname: hostname(), at: new Date().toISOString() }));
        await handle.sync();
        await handle.close();
        this.lockToken = token;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (await this.isStaleLock(path)) {
        const claimed = `${path}.${randomUUID()}.stale`;
        try {
          await rename(path, claimed);
          await unlink(claimed).catch(() => {});
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new PrivacyCountError('STATE_BUSY', '状态目录正被其他请求占用，请稍后重试');
      }
      await sleep(5 + Math.floor(Math.random() * 20));
    }
  }

  async isStaleLock(path) {
    let info;
    try {
      info = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      try {
        const handle = await open(path, 'r');
        const stats = await handle.stat();
        await handle.close();
        return Date.now() - stats.mtimeMs > this.lockStaleMs;
      } catch {
        return true;
      }
    }
    if (info.hostname === hostname() && !processAlive(info.pid)) return true;
    const createdAt = Date.parse(info.at);
    return !Number.isFinite(createdAt) || Date.now() - createdAt > this.lockStaleMs;
  }

  async release() {
    if (this.lockToken === null) return;
    const path = lockPathOf(this.stateDir);
    try {
      const info = JSON.parse(await readFile(path, 'utf8'));
      if (info.token === this.lockToken) await unlink(path);
    } catch {
      // 锁文件已被清理；无需额外动作。
    }
    this.lockToken = null;
  }

  /**
   * 单写者事务：锁内读账本，回调只在 commit() 时持久化。
   * 拒绝路径不调用 commit，因此不产生任何磁盘副作用。
   * 事务在锁内可能已把其他进程的孤儿 reservation 标为 orphaned，
   * 这时即使回调决定拒绝，也需要把恢复结果写回；因此有两个提交点。
   */
  async transact(work) {
    await this.acquire();
    try {
      const ledger = await readLedgerFile(this.stateDir, this.identity);
      const reconciled = reconcileReservations(ledger, { orphanAfterMs: this.orphanAfterMs });
      let dirty = reconciled;
      const commit = async () => {
        await writeJsonAtomic(ledgerPathOf(this.stateDir), ledger);
        dirty = false;
      };
      const result = await work(ledger, commit);
      if (dirty) await commit();
      return result;
    } finally {
      await this.release();
    }
  }

  /** 只读快照，用于等待并发中的同名查询；不拿锁。 */
  async snapshot() {
    return readLedgerFile(this.stateDir, this.identity);
  }

  async waitForEntry(txid, cacheKey) {
    const deadline = Date.now() + this.snapshotWaitMs;
    for (;;) {
      const ledger = await this.snapshot();
      const entry = ledger.entries[cacheKey];
      if (entry && entry.txid === txid) return entry;
      const reservation = ledger.reservations[txid];
      if (!reservation || reservation.status === 'orphaned') return null;
      // 同一主机上持有扣费的进程已经退出时无需等到超时：该次请求已作废。
      if (reservation.hostname === hostname() && !processAlive(reservation.pid)) return null;
      if (Date.now() >= deadline) return null;
      await sleep(10);
    }
  }
}

export function policyFingerprint(policy) {
  return fingerprint(canonical(policy));
}

export function cacheKeyOf({ datasetVersion, datasetFingerprint, policyHash, queryCanonical }) {
  return fingerprint({ datasetVersion, datasetFingerprint, policyHash, query: queryCanonical });
}
