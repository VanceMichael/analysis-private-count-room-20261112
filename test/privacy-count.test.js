import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCountryPolicy, normalizeQuery, budgetScopeOf } from '../src/query.js';
import { clipContributions, countPeople, laplaceNoise } from '../src/privacy.js';
import { sequenceNoiseSource, systemNoiseSource } from '../src/noise.js';

const policyRaw = JSON.parse(await readFile('data/policy.json', 'utf8'));
const policy = createCountryPolicy(policyRaw);
const records = JSON.parse(await readFile('data/records.json', 'utf8')).records;
const child = join(import.meta.dirname, '..', 'support', 'private-count-child.js');

const queryFor = (partner = 'expo-a', filter = { region: '*', industry: '*', day: '*' }, epsilon = 0.25) => ({
  partner, filter,
  budget: { mechanism: 'pure-epsilon', epsilon, delta: 0 }
});

function eightDistinctQueries() {
  const filters = [
    { region: 'east', industry: 'food', day: '*' },
    { region: 'east', industry: 'tech', day: '*' },
    { region: 'west', industry: 'food', day: '*' },
    { region: 'west', industry: 'tech', day: '*' },
    { region: 'east', industry: '*', day: 1 },
    { region: 'west', industry: '*', day: 2 },
    { region: '*', industry: 'food', day: 3 },
    { region: '*', industry: 'tech', day: 1 }
  ];
  return filters.map((filter, index) => queryFor(index % 2 === 0 ? 'expo-a' : 'expo-b', filter));
}

function runChild(state, query, unit = '0.5', fault = 'none', options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childProcess = spawn(process.execPath,
      [child, state, JSON.stringify(query), String(unit), fault, JSON.stringify(options)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    childProcess.stdout.on('data', chunk => { stdout += chunk; });
    childProcess.stderr.on('data', chunk => { stderr += chunk; });
    childProcess.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    childProcess.on('error', rejectPromise);
  });
}

async function ledgerOf(state) {
  return JSON.parse(await readFile(join(state, 'ledger.json'), 'utf8'));
}

async function makeState() {
  return mkdtemp(join(tmpdir(), 'privacy-count-'));
}

test('person 截断先于计数，灵敏度为 1 且去重 person 不受行数影响', () => {
  const rows = [
    { id: 'a1', person: 'a', region: 'east', industry: 'food', day: 1, visits: 9 },
    { id: 'a2', person: 'a', region: 'east', industry: 'food', day: 2, visits: 9 },
    { id: 'a3', person: 'a', region: 'east', industry: 'food', day: 3, visits: 9 },
    { id: 'b1', person: 'b', region: 'west', industry: 'tech', day: 1, visits: 9 }
  ];
  assert.equal(clipContributions(rows, 2).length, 3);
  assert.equal(clipContributions(rows, 999).length, 4);
  const filter = { region: '*', industry: '*', day: '*' };
  assert.equal(countPeople(rows, filter, 1), 2);
  assert.equal(countPeople(rows, filter, 100), 2);
  assert.equal(countPeople(rows, { ...filter, region: 'east' }, 100), 1);
});

test('Laplace 逆变换关于 0.5 对称，且尺度为 sensitivity/epsilon', () => {
  const up = laplaceNoise(0.25, 1, 250_000);
  const down = laplaceNoise(0.75, 1, 250_000);
  assert.ok(up < 0 && down > 0);
  assert.ok(Math.abs(up + down) < 1e-9);
  assert.ok(Math.abs(Math.abs(up) - 4 * Math.LN2) < 1e-6);
  assert.throws(() => laplaceNoise(0, 1, 250_000), /随机单位/);
  assert.throws(() => laplaceNoise(1, 1, 250_000), /随机单位/);
});

test('系统随机源只返回 (0,1) 且不暴露种子或状态', () => {
  const source = systemNoiseSource();
  assert.equal(source.description, 'system-cryptographic');
  const values = new Set();
  for (let index = 0; index < 100; index += 1) {
    const unit = source.nextUnit();
    assert.ok(unit > 0 && unit < 1);
    values.add(unit);
  }
  assert.equal(values.size, 100);
  assert.deepEqual(Object.keys(source), ['description', 'nextUnit']);
});

test('规范化查询：字段顺序同义、越界字段拒绝且错误不区分原因', () => {
  const base = normalizeQuery(queryFor(), policy);
  const reordered = { budget: { delta: 0, epsilon: 0.25, mechanism: 'pure-epsilon' },
    filter: { day: '*', industry: '*', region: '*' }, partner: 'expo-a' };
  assert.equal(normalizeQuery(reordered, policy).queryHash, base.queryHash);
  assert.equal(normalizeQuery({ ...queryFor(), filter: { region: 'east', industry: '*', day: '*' } }, policy)
    .queryHash === base.queryHash, false);
  for (const bad of [
    { ...queryFor(), filter: { region: 'east', industry: '*', day: '*', age: 1 } },
    { ...queryFor(), filter: { region: 'north', industry: '*', day: '*' } },
    { ...queryFor(), filter: { region: 'east', industry: '*', day: 0.5 } },
    { ...queryFor(), filter: { region: 'east' } },
    { ...queryFor(), budget: { mechanism: 'laplace', epsilon: 0.25, delta: 0 } },
    { ...queryFor(), budget: { mechanism: 'pure-epsilon', epsilon: 1, delta: 0 } },
    { ...queryFor(), budget: { mechanism: 'pure-epsilon', epsilon: 0.25001, delta: 0 } },
    { ...queryFor(), budget: { mechanism: 'pure-epsilon', epsilon: 0.25, delta: 0.1 } },
    { ...queryFor(), budget: { mechanism: 'pure-epsilon', epsilon: 0.25, delta: 0, expression: 'x' } },
    { ...queryFor(), partner: 'unknown' },
    { ...queryFor(), count: { min: 0, max: 10 } },
    { ...queryFor(), limit: 50 }
  ]) {
    assert.throws(() => normalizeQuery(bad, policy), error => error.code === 'INVALID_QUERY');
  }
  const first = queryFor();
  first.filter.region = 'east';
  assert.deepEqual(normalizeQuery(first, policy).filter.region, 'east');
  assert.deepEqual(Object.keys(normalizeQuery(queryFor(), policy).filter), ['region', 'industry', 'day']);
});

test('预算池由数据集版本和共享策略决定', () => {
  const sharedA = budgetScopeOf(policy, 'expo-a');
  const sharedB = budgetScopeOf(policy, 'expo-b');
  const independent = budgetScopeOf(policy, 'expo-c');
  assert.equal(sharedA.key, sharedB.key);
  assert.equal(sharedA.key, 'synthetic-v1:shared');
  assert.notEqual(sharedA.key, independent.key);
  assert.equal(independent.ceilingMicro, 1_000_000);
  assert.equal(policyRaw.contributionLimit, 2);
  assert.equal(policyRaw.sensitivity, 1);
});

test('fresh 请求扣费一次、同义请求命中缓存且不重复扣费', async () => {
  const state = await makeState();
  try {
    const first = await runChild(state, queryFor());
    assert.equal(first.code, 0, first.stderr);
    const parsed = JSON.parse(first.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.draws, 1);
    assert.equal(parsed.result.cache, 'miss');
    assert.equal(parsed.result.budget.spentMicro, 250_000);
    assert.equal(parsed.result.noisyCount, 32, '真实 32 人，0.5 随机单位对应 0 噪声');

    const reordered = JSON.parse(first.stdout).result.query;
    const again = await runChild(state, {
      budget: { delta: 0, epsilon: reordered.epsilon, mechanism: 'pure-epsilon' },
      filter: { day: '*', industry: '*', region: '*' },
      partner: 'expo-a'
    });
    const repeat = JSON.parse(again.stdout);
    assert.equal(repeat.result.cache, 'hit');
    assert.equal(repeat.result.noisyCount, 32);
    assert.equal(repeat.result.txid, parsed.result.txid);
    assert.equal(repeat.draws, 0, '缓存命中不调用随机源');
    assert.equal(repeat.result.budget.spentMicro, 250_000);

    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 250_000);
    assert.equal(Object.keys(ledger.entries).length, 1);
    assert.equal(Object.values(ledger.reservations)[0].status, 'committed');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('共享合作方消耗同一预算池，独立合作方不计入共享池', async () => {
  const state = await makeState();
  try {
    const a = JSON.parse((await runChild(state, queryFor('expo-a'))).stdout);
    const b = JSON.parse((await runChild(state,
      queryFor('expo-b', { region: 'west', industry: '*', day: '*' }))).stdout);
    const c = JSON.parse((await runChild(state,
      queryFor('expo-c', { region: 'east', industry: '*', day: '*' }))).stdout);
    assert.equal(a.result.budget.spentMicro, 250_000);
    assert.equal(b.result.budget.spentMicro, 500_000);
    assert.equal(b.result.budget.shareBudgetPolicy, 'shared');
    assert.equal(c.result.budget.key, 'synthetic-v1:partner:expo-c');
    assert.equal(c.result.budget.spentMicro, 250_000);
    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 500_000);
    assert.equal(ledger.scopes['synthetic-v1:partner:expo-c'].spentMicro, 250_000);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('预算耗尽时拒绝不扣费、不抽噪声、不写账本、不泄露计数', async () => {
  const state = await makeState();
  try {
    // 独立合作方 expo-c 的池只有 1.0 epsilon；先花掉 4 次 × 0.25。
    for (let index = 0; index < 4; index += 1) {
      const filters = [{ region: 'east' }, { region: 'west' }, { industry: 'food' }, { industry: 'tech' }];
      const filter = { ...filters[index], industry: filters[index].industry ?? '*',
        region: filters[index].region ?? '*', day: '*' };
      assert.equal(JSON.parse((await runChild(state, queryFor('expo-c', filter))).stdout).ok, true);
    }
    const before = await ledgerOf(state);
    assert.equal(before.scopes['synthetic-v1:partner:expo-c'].spentMicro, 1_000_000);
    const denied = await runChild(state,
      queryFor('expo-c', { region: 'east', industry: 'food', day: '*' }));
    const payload = JSON.parse(denied.stdout);
    assert.equal(denied.code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'BUDGET_EXHAUSTED');
    assert.equal(payload.draws, 0, '拒绝路径不抽取噪声');
    assert.ok(!/noisyCount|rawCount|"16"|"32"/.test(denied.stdout), '拒绝输出不含任何计数');
    const after = await ledgerOf(state);
    assert.deepEqual(after, before, '拒绝请求不得产生任何账本副作用');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('可用预算以微单位精确累加，边界请求仍可付费', async () => {
  const state = await makeState();
  try {
    // 共享池 2.0 epsilon，单次 0.25：8 次互不相同的查询正好用尽。
    for (const query of eightDistinctQueries()) {
      const run = JSON.parse((await runChild(state, query)).stdout);
      assert.equal(run.ok, true, `查询 ${JSON.stringify(query.filter)} 应成功`);
    }
    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 2_000_000);
    const denied = JSON.parse((await runChild(state,
      queryFor('expo-a', { region: '*', industry: 'food', day: 1 }))).stdout);
    assert.equal(denied.code, 'BUDGET_EXHAUSTED');
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 2_000_000);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('并发子进程不能同时透支共享预算', async () => {
  const state = await makeState();
  try {
    // 先把共享池用到只剩 0.25 epsilon，再让两个不同查询并发争抢这一份额度。
    for (const query of eightDistinctQueries().slice(0, 7)) {
      assert.equal(JSON.parse((await runChild(state, query)).stdout).ok, true);
    }
    const contenders = await Promise.all([
      runChild(state, queryFor('expo-a', { region: 'east', industry: '*', day: 3 })),
      runChild(state, queryFor('expo-b', { region: 'west', industry: '*', day: 1 }))
    ]);
    const outcomes = contenders.map(run => JSON.parse(run.stdout));
    assert.equal(outcomes.filter(outcome => outcome.ok).length, 1, '只允许一个请求扣费成功');
    assert.equal(outcomes.filter(outcome => outcome.code === 'BUDGET_EXHAUSTED').length, 1);
    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 2_000_000, '总支出不超过上限');
    const reservations = Object.values(ledger.reservations);
    assert.equal(reservations.length, 8);
    assert.ok(reservations.every(reservation => reservation.status === 'committed'));
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('扣费后进程退出：预算保留，恢复扫描标记孤儿，后续不会免费重抽', async () => {
  const state = await makeState();
  try {
    const query = queryFor('expo-c', { region: 'east', industry: '*', day: '*' });
    const crashed = await runChild(state, query, '0.9', 'afterNoise');
    assert.equal(crashed.code, 71);
    assert.equal(crashed.stdout, '');
    let ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:partner:expo-c'].spentMicro, 250_000);
    const orphan = Object.values(ledger.reservations)[0];
    assert.equal(orphan.status, 'reserved');

    // 重启：恢复扫描发现进程已退出，标为孤儿；缓存里没有那次噪声。
    // 同名重试不是“免费重抽”，而是一次新的付费查询。
    const restarted = JSON.parse((await runChild(state, query, '0.1')).stdout);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.draws, 1);
    assert.equal(restarted.result.cache, 'miss');
    assert.notEqual(restarted.result.txid, orphan.txid);
    ledger = await ledgerOf(state);
    assert.equal(ledger.reservations[orphan.txid].status, 'orphaned');
    assert.equal(ledger.scopes['synthetic-v1:partner:expo-c'].spentMicro, 500_000);
    assert.ok(ledger.audit.some(event => event.event === 'orphaned-reservation'
      && event.txid === orphan.txid));
    // 剩余 0.5 epsilon 只够两次不同查询；之后的请求被拒绝且不再扣费。
    const westFood = JSON.parse((await runChild(state,
      queryFor('expo-c', { region: 'west', industry: 'food', day: '*' }), '0.3')).stdout);
    const westTech = JSON.parse((await runChild(state,
      queryFor('expo-c', { region: 'west', industry: 'tech', day: '*' }), '0.7')).stdout);
    assert.equal(westFood.ok, true);
    assert.equal(westTech.ok, true);
    const denied = JSON.parse((await runChild(state,
      queryFor('expo-c', { region: '*', industry: 'food', day: 1 }), '0.2')).stdout);
    assert.equal(denied.code, 'BUDGET_EXHAUSTED');
    assert.equal(denied.draws, 0);
    const finalLedger = await ledgerOf(state);
    assert.equal(finalLedger.scopes['synthetic-v1:partner:expo-c'].spentMicro, 1_000_000);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('结果登记后退出：重启命中同一缓存，不重复扣费也不重抽噪声', async () => {
  const state = await makeState();
  try {
    const query = queryFor('expo-a', { region: 'east', industry: '*', day: '*' });
    const crashed = await runChild(state, query, '0.5', 'afterCommit');
    assert.equal(crashed.code, 72);
    const ledger = await ledgerOf(state);
    const entry = Object.values(ledger.entries)[0];
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 250_000);

    const restarted = JSON.parse((await runChild(state, query, '0.9')).stdout);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.draws, 0);
    assert.equal(restarted.result.cache, 'hit');
    assert.equal(restarted.result.noisyCount, entry.result.noisyCount);
    const after = await ledgerOf(state);
    assert.equal(after.scopes['synthetic-v1:shared'].spentMicro, 250_000);
    assert.equal(Object.keys(after.entries).length, 1);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('扣费在噪声之前：故障点 afterReserve 退出后重新请求被拒绝', async () => {
  const state = await makeState();
  try {
    const query = queryFor('expo-c', { region: 'west', industry: '*', day: '*' });
    const crashed = await runChild(state, query, '0.5', 'afterReserve');
    assert.equal(crashed.code, 70);
    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:partner:expo-c'].spentMicro, 250_000);
    assert.equal(Object.keys(ledger.entries).length, 0);
    const retry = JSON.parse((await runChild(state, query)).stdout);
    assert.equal(retry.ok, true);
    assert.equal(retry.result.cache, 'miss');
    const after = await ledgerOf(state);
    assert.equal(after.scopes['synthetic-v1:partner:expo-c'].spentMicro, 500_000);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('审计日志只含机制参数与预算，不含真实人数或噪声样本', async () => {
  const state = await makeState();
  try {
    const logPath = join(state, 'audit.log');
    const run = JSON.parse((await runChild(state, queryFor('expo-a'),
      '0.5', 'none', { resultPath: join(state, 'result.json'), logPath })).stdout);
    assert.equal(run.ok, true);
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(),
      ['at', 'cache', 'epsilonMicro', 'event', 'mechanism', 'partner', 'queryHash',
        'remainingMicro', 'scopeKey', 'spentMicro'].sort());
    assert.ok(!('rawCount' in lines[0]) && !('noisyCount' in lines[0]));
    const resultText = await readFile(join(state, 'result.json'), 'utf8');
    assert.ok(!resultText.includes('"rawCount"'), '结果文档不包含原始人数');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('并发同义查询只产生一份噪声计费，另一份扣费退回', async () => {
  const state = await makeState();
  try {
    const query = queryFor('expo-a', { region: 'east', industry: 'food', day: '*' });
    const runs = await Promise.all([runChild(state, query), runChild(state, query)]);
    const outcomes = runs.map(run => JSON.parse(run.stdout));
    assert.ok(outcomes.every(outcome => outcome.ok), '两个请求都返回结果');
    assert.equal(outcomes.filter(outcome => outcome.result.cache === 'miss').length, 1);
    assert.equal(new Set(outcomes.map(outcome => outcome.result.noisyCount)).size, 1,
      '同一缓存键只存在一份噪声结果');
    const ledger = await ledgerOf(state);
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 250_000,
      '同一语义查询无论并发与否都只扣一次');
    const reservations = Object.values(ledger.reservations);
    assert.equal(reservations.length, 1, '等待方看到 in-flight 后不会重复扣费');
    assert.equal(reservations[0].status, 'committed');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('状态目录与数据集版本或策略绑定，不静默混用', async () => {
  const state = await makeState();
  try {
    assert.equal(JSON.parse((await runChild(state, queryFor())).stdout).ok, true);
    const dataset = JSON.parse(await readFile('data/records.json', 'utf8'));
    dataset.datasetVersion = 'synthetic-v2';
    const datasetV2 = join(state, 'records-v2.json');
    await writeFile(datasetV2, JSON.stringify(dataset));
    const policyV2 = join(state, 'policy-v2.json');
    await writeFile(policyV2, JSON.stringify({ ...policyRaw, datasetVersion: 'synthetic-v2' }));
    // 旧账本属于 synthetic-v1：换成 v2 数据集与策略后必须拒绝，而不是接着花旧预算。
    const mismatch = JSON.parse((await runChild(state, queryFor(), '0.5', 'none',
      { datasetPath: datasetV2, policyPath: policyV2 })).stdout);
    assert.equal(mismatch.code, 'STATE_MISMATCH');
    assert.equal(mismatch.draws, 0);
    const ledger = await ledgerOf(state);
    assert.equal(ledger.datasetVersion, 'synthetic-v1');
    assert.equal(ledger.scopes['synthetic-v1:shared'].spentMicro, 250_000);

    // 数据集版本变化后使用新状态目录：新池、新缓存，账本随版本标识。
    const newState = await makeState();
    try {
      const v2Run = JSON.parse((await runChild(newState, queryFor(), '0.5', 'none',
        { datasetPath: datasetV2, policyPath: policyV2 })).stdout);
      assert.equal(v2Run.ok, true);
      assert.equal(v2Run.result.datasetVersion, 'synthetic-v2');
      const v2Ledger = await ledgerOf(newState);
      assert.equal(v2Ledger.datasetVersion, 'synthetic-v2');
      assert.ok(v2Ledger.scopes['synthetic-v2:shared']);
    } finally { await rm(newState, { recursive: true, force: true }); }
  } finally { await rm(state, { recursive: true, force: true }); }
});
