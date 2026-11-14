// 短演示：同义查询复用同一份持久缓存，预算按共享池扣减直到耗尽。
// 只用本地合成人员与临时状态目录，不访问网络，不接真实身份库。
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrivateCount } from '../src/privacy-count.js';
import { systemNoiseSource } from '../src/noise.js';

const stateDir = join(tmpdir(), 'privacy-count-demo');
const makeQuery = ({ partner = 'expo-a', filter, epsilon = 0.25 }) => ({
  partner, filter, budget: { mechanism: 'pure-epsilon', epsilon, delta: 0 }
});
const show = result => JSON.stringify({
  cache: result.cache,
  noisyCount: result.noisyCount,
  epsilon: result.epsilon,
  remaining: result.budget.remainingMicro / 1e6
});

await rm(stateDir, { recursive: true, force: true });
await mkdir(stateDir, { recursive: true });

const first = await runPrivateCount({
  stateDir,
  request: makeQuery({ filter: { region: 'east', industry: '*', day: '*' } }),
  noiseSource: systemNoiseSource()
});
console.log('首次查询：', show(first));

// 语义等价：字段顺序不同，规范化后命中同一个缓存键，不扣费也不重新抽噪声。
const same = await runPrivateCount({
  stateDir,
  request: {
    budget: { delta: 0, epsilon: 0.25, mechanism: 'pure-epsilon' },
    filter: { day: '*', industry: '*', region: 'east' },
    partner: 'expo-a'
  },
  noiseSource: systemNoiseSource()
});
console.log('同义查询：', show(same), '同一份噪声 =', same.noisyCount === first.noisyCount);

// 不同条件各自付一次 0.25；共享池上限 2.0，因此第一次查询后再付 7 次刚好用尽。
const filters = [
  { region: 'west', industry: '*', day: '*' },
  { region: '*', industry: 'food', day: '*' },
  { region: '*', industry: 'tech', day: '*' },
  { region: '*', industry: '*', day: 1 },
  { region: '*', industry: '*', day: 2 },
  { region: '*', industry: '*', day: 3 },
  { region: 'east', industry: 'food', day: '*' }
];
for (const filter of filters) {
  const result = await runPrivateCount({ stateDir, request: makeQuery({ filter, partner: 'expo-b' }),
    noiseSource: systemNoiseSource() });
  console.log('新条件：', show(result));
}
try {
  await runPrivateCount({
    stateDir,
    request: makeQuery({ filter: { region: 'east', industry: 'tech', day: '*' } }),
    noiseSource: systemNoiseSource()
  });
  console.log('意外：预算未耗尽');
} catch (error) {
  console.log('预算耗尽：', error.code, '— 未扣费、未返回任何计数。');
}

await rm(stateDir, { recursive: true, force: true });
