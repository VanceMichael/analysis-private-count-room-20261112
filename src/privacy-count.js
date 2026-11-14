import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrivacyCountError } from './errors.js';
import { canonical, loadDataset } from './dataset.js';
import { budgetScopeOf, createCountryPolicy, normalizeQuery } from './query.js';
import { countPeople, computeSensitivity, roundTo } from './privacy.js';
import { laplaceNoise } from './noise.js';
import { LedgerStore, cacheKeyOf, policyFingerprint } from './ledger.js';
import { writeResult } from './output.js';

export const MECHANISM = Object.freeze({
  name: 'laplace',
  guarantee: 'pure-epsilon',
  unit: 'person',
  postProcessing: Object.freeze({
    clipping: 'before-noise: each person contributes at most the policy limit',
    rounding: 'published value rounded to 6 decimal places (data-independent)',
    consistency: 'none: no zero-clipping and no consistency with totals'
  })
});

function audit(ledger, event) {
  ledger.audit.push({ at: new Date().toISOString(), ...event });
}

function publicQuery(query) {
  return { partner: query.partner, filter: query.filter,
    epsilon: query.epsilon, epsilonMicro: query.epsilonMicro, delta: 0 };
}

function scopeView(ledger, scopeKey, ceilingMicro) {
  const spentMicro = ledger.scopes[scopeKey]?.spentMicro ?? 0;
  return { key: scopeKey, ceilingMicro, spentMicro, remainingMicro: ceilingMicro - spentMicro };
}

async function loadPolicy(path) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new PrivacyCountError('POLICY_INVALID', '无法读取合作方策略');
  }
  return createCountryPolicy(raw);
}

/**
 * 关键顺序：截断 → 真实计数 → 锁内原子扣费 → 锁外生成噪声 → 锁内登记结果。
 *
 * - 命中持久缓存时不扣费也不抽噪声，同义查询返回同一份噪声结果。
 * - 预算不足时只读拒绝：不写账本、不生成噪声、不返回任何计数。
 * - 扣费先于噪声：进程在抽噪声后退出，预算已落盘，恢复扫描只会把该请求
 *   标为孤儿，不会让它免费重抽。
 */
export async function runPrivateCount({
  datasetPath = 'data/records.json',
  policyPath = 'data/policy.json',
  stateDir = 'var/privacy-state',
  request,
  noiseSource,
  resultPath = null,
  logPath = null,
  storeOptions = {},
  faults = {}
} = {}) {
  if (!noiseSource || typeof noiseSource.nextUnit !== 'function') {
    throw new PrivacyCountError('NOISE_SOURCE', '必须显式提供随机源');
  }
  const policy = await loadPolicy(policyPath);
  const dataset = await loadDataset(datasetPath);
  if (dataset.datasetVersion !== policy.datasetVersion) {
    throw new PrivacyCountError('DATASET_MISMATCH', '策略中的数据集版本与输入文件不一致');
  }
  const query = normalizeQuery(request, policy);
  const scope = budgetScopeOf(policy, query.partner);
  const policyHash = policyFingerprint(policy);
  const identity = { datasetVersion: policy.datasetVersion, policyHash };
  const cacheKey = cacheKeyOf({ datasetVersion: policy.datasetVersion,
    datasetFingerprint: dataset.fingerprint, policyHash, queryCanonical: query.canonical });
  const store = new LedgerStore(stateDir, identity, storeOptions);
  const sensitivity = computeSensitivity(policy.contributionLimit);
  if (policy.sensitivity !== sensitivity) {
    throw new PrivacyCountError('POLICY_INVALID', '策略声明的灵敏度与实现不一致');
  }
  const rawCount = countPeople(dataset.records, query.filter, policy.contributionLimit);

  const decision = await store.transact(async (ledger, commit) => {
    const cached = ledger.entries[cacheKey];
    if (cached) return { status: 'cache', entry: cached };
    const inFlight = Object.values(ledger.reservations).find(reservation =>
      reservation.status === 'reserved' && reservation.scopeKey === scope.key
      && reservation.cacheKey === cacheKey);
    if (inFlight) return { status: 'in-flight', reservation: inFlight };
    const scopeState = ledger.scopes[scope.key] ?? { ceilingMicro: scope.ceilingMicro, spentMicro: 0 };
    if (scopeState.ceilingMicro !== scope.ceilingMicro) {
      throw new PrivacyCountError('STATE_MISMATCH', '持久状态中的预算上限与当前策略不一致');
    }
    if (scopeState.spentMicro + query.epsilonMicro > scopeState.ceilingMicro) {
      return { status: 'exhausted' };
    }
    const txid = randomUUID();
    ledger.reservations[txid] = {
      txid,
      cacheKey,
      scopeKey: scope.key,
      epsilonMicro: query.epsilonMicro,
      status: 'reserved',
      pid: process.pid,
      hostname: hostname(),
      at: new Date().toISOString(),
      queryHash: query.queryHash
    };
    scopeState.spentMicro += query.epsilonMicro;
    ledger.scopes[scope.key] = scopeState;
    audit(ledger, { event: 'reserved', txid, cacheKey, scopeKey: scope.key,
      epsilonMicro: query.epsilonMicro, spentMicro: scopeState.spentMicro });
    await commit();
    // 故障注入点：扣费已落盘、噪声尚未生成时退出，用于证明重启后不会免费重抽。
    if (faults.afterReserve === 'exit') process.exit(70);
    return { status: 'fresh', reservation: ledger.reservations[txid] };
  });

  if (decision.status === 'exhausted') {
    throw new PrivacyCountError('BUDGET_EXHAUSTED', '预算已耗尽，请求未扣费', {
      budget: { scope: scope.key, ceilingMicro: scope.ceilingMicro }
    });
  }

  let entry = decision.entry ?? null;
  let charged = false;
  if (decision.status === 'in-flight') {
    entry = await store.waitForEntry(decision.reservation.txid, cacheKey);
    if (!entry) throw new PrivacyCountError('IN_FLIGHT', '同名查询正在进行，请稍后重试');
  }

  if (!entry) {
    const ledger = await store.snapshot();
    const reservation = ledger.reservations[decision.reservation.txid];
    if (!reservation || reservation.status !== 'reserved') {
      throw new PrivacyCountError('PAID_STATE_LOST', '扣费状态已失效，结果不发布');
    }
    // 噪声在锁外生成，缩短持锁时间；扣费此时已持久化。
    const unit = noiseSource.nextUnit();
    const noise = laplaceNoise(unit, sensitivity, query.epsilonMicro);
    // 故障注入点：噪声已生成但未登记，模拟进程在生成噪声后退出。
    if (faults.afterNoise === 'exit') process.exit(71);
    const noisy = roundTo(rawCount + noise, 6);
    const result = {
      partner: query.partner,
      query: publicQuery(query),
      mechanism: MECHANISM.name,
      guarantee: MECHANISM.guarantee,
      unit: MECHANISM.unit,
      sensitivity,
      contributionLimit: policy.contributionLimit,
      epsilon: query.epsilon,
      epsilonMicro: query.epsilonMicro,
      delta: 0,
      noisyCount: noisy,
      postProcessing: { ...MECHANISM.postProcessing },
      datasetVersion: policy.datasetVersion,
      inputFingerprint: dataset.fingerprint
    };
    const published = await store.transact(async (current, commit) => {
      const cached = current.entries[cacheKey];
      if (cached) {
        // 理论上 in-flight 检查已挡住这条路；若仍发生（例如恢复扫描后重放），
        // 本次没有发布自己的噪声，就把这份扣费退回，保证同一缓存键只计一次。
        const mine = current.reservations[decision.reservation.txid];
        if (mine && mine.status === 'reserved') {
          mine.status = 'refunded';
          const scopeState = current.scopes[mine.scopeKey];
          if (scopeState) {
            scopeState.spentMicro -= mine.epsilonMicro;
            audit(current, { event: 'refunded', txid: mine.txid, cacheKey,
              scopeKey: mine.scopeKey, epsilonMicro: mine.epsilonMicro,
              spentMicro: scopeState.spentMicro, reason: 'same-cache-key-published' });
          }
          await commit();
        }
        return { stored: cached, reused: true };
      }
      const reservation = current.reservations[decision.reservation.txid];
      if (!reservation || reservation.status !== 'reserved') {
        throw new PrivacyCountError('PAID_STATE_LOST', '该次扣费已过期，结果不发布');
      }
      const stored = {
        txid: decision.reservation.txid,
        cacheKey,
        scopeKey: scope.key,
        epsilonMicro: query.epsilonMicro,
        status: 'published',
        publishedAt: new Date().toISOString(),
        result
      };
      current.entries[cacheKey] = stored;
      current.reservations[decision.reservation.txid].status = 'committed';
      audit(current, { event: 'committed', txid: decision.reservation.txid,
        cacheKey, scopeKey: scope.key, epsilonMicro: query.epsilonMicro });
      await commit();
      // 故障注入点：结果已登记后退出。
      if (faults.afterCommit === 'exit') process.exit(72);
      return { stored, reused: false };
    });
    entry = published.stored;
    charged = !published.reused;
  }

  const finalCache = charged ? 'miss' : 'hit';

  const after = await store.snapshot();
  const budget = { ...scopeView(after, scope.key, scope.ceilingMicro),
    shareBudgetPolicy: scope.shareBudget ? 'shared' : 'per-partner' };
  const document = { ...entry.result, cache: finalCache, txid: entry.txid, budget };
  if (logPath) {
    // 审计日志只记机制参数、预算与结果状态；不写真实人数、噪声样本或随机源状态。
    await appendFile(resolve(logPath), JSON.stringify(canonical({
      at: new Date().toISOString(),
      event: 'private-count',
      partner: query.partner,
      queryHash: query.queryHash,
      cache: finalCache,
      mechanism: MECHANISM.name,
      epsilonMicro: entry.epsilonMicro,
      scopeKey: scope.key,
      spentMicro: budget.spentMicro,
      remainingMicro: budget.remainingMicro
    })) + '\n', { mode: 0o600 });
  }
  if (resultPath) await writeResult(resultPath, document);
  return document;
}
