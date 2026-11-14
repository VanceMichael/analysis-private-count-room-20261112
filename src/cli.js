import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { PrivacyCountError } from './errors.js';
import { runPrivateCount } from './privacy-count.js';
import { systemNoiseSource } from './noise.js';

const COMMAND_OPTIONS = {
  summary: ['--input', '--out'],
  inspect: ['--input', '--out'],
  'private-count': ['--input', '--policy', '--state', '--query', '--out', '--log']
};

const COMMAND_LABEL = '命令应为 summary、inspect 或 private-count';

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error(COMMAND_LABEL);
  const allowed = COMMAND_OPTIONS[command];
  const result = { command, input: 'data/records.json' };
  if (command === 'private-count') {
    result.policy = 'data/policy.json';
    result.state = 'var/privacy-state';
  }
  const seen = new Set();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${allowed.join(' 或 ')}`);
    }
    if (seen.has(name)) throw new Error('参数不可重复');
    seen.add(name);
    result[name.slice(2)] = value;
  }
  if (command === 'private-count' && !result.query) throw new Error('private-count 需要 --query JSON');
  return result;
}

function parseQuery(text) {
  let query;
  try {
    query = JSON.parse(text);
  } catch {
    throw new PrivacyCountError('INVALID_QUERY', '请求被拒绝');
  }
  return query;
}

export async function main(args, { noiseSource = systemNoiseSource(), faults = {} } = {}) {
  const options = parseArguments(args);
  if (options.command === 'private-count') {
    return runPrivateCount({
      datasetPath: options.input,
      policyPath: options.policy,
      stateDir: options.state,
      request: parseQuery(options.query),
      noiseSource,
      resultPath: options.out ?? null,
      logPath: options.log ?? null,
      faults
    });
  }
  const dataset = await loadDataset(options.input);
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint, datasetVersion: dataset.datasetVersion,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    const prefix = error instanceof PrivacyCountError ? `[${error.code}] ` : '';
    process.stderr.write(`处理失败：${prefix}${error.message}\n`);
    process.exitCode = 1;
  });
}
