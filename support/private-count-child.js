// 测试/演示专用子进程入口：显式注入独立随机源，可按需在故障点退出。
// 用法：[stateDir, queryJson, unit, fault, optionsJson?]
import { runPrivateCount } from '../src/privacy-count.js';
import { sequenceNoiseSource } from '../src/noise.js';

const [stateDir, queryText, unitText = '0.5', faultName = 'none', optionsText = '{}'] =
  process.argv.slice(2);

const source = sequenceNoiseSource([Number(unitText)]);
const faults = faultName === 'none' ? {} : { [faultName]: 'exit' };
const options = JSON.parse(optionsText);
try {
  const result = await runPrivateCount({
    stateDir,
    request: JSON.parse(queryText),
    noiseSource: source,
    faults,
    datasetPath: options.datasetPath,
    policyPath: options.policyPath,
    resultPath: options.resultPath ?? null,
    logPath: options.logPath ?? null,
    storeOptions: { lockTimeoutMs: 30_000 }
  });
  process.stdout.write(JSON.stringify({ ok: true, draws: source.draws, result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, draws: source.draws,
    code: error.code ?? null, message: error.message,
    details: error.details ?? {} }) + '\n');
  process.exitCode = 1;
}
