import { createHash } from 'node:crypto';
import { PrivacyCountError } from './errors.js';
import { canonical } from './dataset.js';

const WILDCARD = '*';
const SUPPORTED_DIMENSIONS = ['region', 'industry', 'day'];
const MICRO = 1_000_000;

// 规范性拒绝使用同一文本与同一错误码，避免请求方靠错误差异探测公开字典之外的取值。
function reject() {
  return new PrivacyCountError('INVALID_QUERY', '请求被拒绝');
}

function policyError(message = '策略格式无效') {
  return new PrivacyCountError('POLICY_INVALID', message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectExactKeys(object, allowed, makeError = reject) {
  if (!isPlainObject(object)) throw makeError();
  const keys = Object.keys(object);
  if (keys.length !== allowed.length) throw makeError();
  for (const key of allowed) if (!Object.hasOwn(object, key)) throw makeError();
  for (const key of keys) if (!allowed.includes(key)) throw makeError();
  return object;
}

function readSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw reject();
  return value;
}

function readText(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) throw reject();
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw policyError(`${label} 应为正整数`);
  return value;
}

function isSortedUniqueStrings(values) {
  return Array.isArray(values) && values.length > 0
    && values.every(value => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length
    && values.every((value, index) => index === 0 || values[index - 1].localeCompare(value, 'en') < 0);
}

/**
 * 合作方策略。字段只来自受控配置文件：
 * - contributionLimit：person 级贡献上限，先截断再计算统计量；
 * - sensitivity：发布去重 person 数时的全局灵敏度，必须为 1；
 * - epsilonQueryMicro：单次查询上限（微单位，1e-6 epsilon = 1）；
 * - epsilonTotalMicro：每个预算池的跨查询上限；
 * - dayBuckets：唯一允许的日期桶；
 * - allowed.region / allowed.industry：公开字典，不接受其他字段或表达式；
 * - partners.<id>.shareBudget：是否与其他合作方共享预算池。
 */
export function createCountryPolicy(raw) {
  expectExactKeys(raw, ['datasetVersion', 'mechanism', 'contributionLimit', 'sensitivity',
    'epsilonQueryMicro', 'epsilonTotalMicro', 'dayBuckets', 'allowed', 'partners'], policyError);
  if (raw.mechanism !== 'pure-epsilon') throw policyError('策略机制应为纯 epsilon');
  const contributionLimit = positiveInteger(raw.contributionLimit, '贡献上限');
  const sensitivity = positiveInteger(raw.sensitivity, '灵敏度');
  if (sensitivity !== 1) {
    throw policyError('发布去重 person 数时全局灵敏度应为 1；行计数等口径需另行定义机制');
  }
  const epsilonQueryMicro = positiveInteger(raw.epsilonQueryMicro, '单次查询预算');
  const epsilonTotalMicro = positiveInteger(raw.epsilonTotalMicro, '总预算');
  if (epsilonQueryMicro > epsilonTotalMicro) throw policyError('单次查询预算不得超过总预算');
  if (!Array.isArray(raw.dayBuckets) || raw.dayBuckets.length === 0
    || raw.dayBuckets.some(day => !Number.isSafeInteger(day))
    || !raw.dayBuckets.every((day, index) => index === 0 || raw.dayBuckets[index - 1] < day)) {
    throw policyError('日期桶应为严格递增的安全整数');
  }
  expectExactKeys(raw.allowed, ['region', 'industry'], policyError);
  for (const dimension of ['region', 'industry']) {
    if (!isSortedUniqueStrings(raw.allowed[dimension])) {
      throw policyError(`公开字典 ${dimension} 应为排序后的唯一非空字符串`);
    }
  }
  if (!isPlainObject(raw.partners) || Object.keys(raw.partners).length === 0) {
    throw policyError('策略缺少合作方');
  }
  const partners = {};
  for (const [partnerId, entry] of Object.entries(raw.partners)) {
    if (typeof partnerId !== 'string' || partnerId.length === 0 || partnerId !== partnerId.trim()) {
      throw policyError('合作方标识应为非空字符串');
    }
    expectExactKeys(entry, ['shareBudget', 'epsilonBudgetMicro'], policyError);
    if (typeof entry.shareBudget !== 'boolean') throw policyError('共享预算标记应为布尔');
    if (!Number.isSafeInteger(entry.epsilonBudgetMicro) || entry.epsilonBudgetMicro < 0) {
      throw policyError('合作方预算应为非负安全整数');
    }
    if (entry.shareBudget && entry.epsilonBudgetMicro !== epsilonTotalMicro) {
      throw policyError('共享预算池的上限应等于 epsilonTotalMicro');
    }
    if (!entry.shareBudget && entry.epsilonBudgetMicro > epsilonTotalMicro) {
      throw policyError('合作方独立预算不得超过 epsilonTotalMicro');
    }
    partners[partnerId] = Object.freeze({ shareBudget: entry.shareBudget,
      epsilonBudgetMicro: entry.epsilonBudgetMicro });
  }
  return Object.freeze({
    datasetVersion: readText(raw.datasetVersion),
    mechanism: 'pure-epsilon',
    contributionLimit,
    sensitivity,
    epsilonQueryMicro,
    epsilonTotalMicro,
    dayBuckets: Object.freeze([...raw.dayBuckets]),
    allowed: Object.freeze({ region: Object.freeze([...raw.allowed.region]),
      industry: Object.freeze([...raw.allowed.industry]) }),
    partners: Object.freeze(partners)
  });
}

/**
 * 预算池只由数据集版本与合作方策略决定：
 * 共享合作方进同一个池，独立合作方各有一个池；数据集版本变化会开新池。
 */
export function budgetScopeOf(policy, partnerId) {
  const partner = policy.partners[partnerId];
  if (!partner) throw reject();
  return {
    key: `${policy.datasetVersion}:${partner.shareBudget ? 'shared' : `partner:${partnerId}`}`,
    ceilingMicro: partner.epsilonBudgetMicro,
    shareBudget: partner.shareBudget
  };
}

/**
 * 将外部查询规范化为内部表示。仅接受公开字典、固定机制与显式 epsilon，
 * 不接受任意表达式；规范形式同时用于缓存键与账本登记，字段顺序不会产生新噪声。
 */
export function normalizeQuery(raw, policy) {
  expectExactKeys(raw, ['partner', 'filter', 'budget']);
  const partner = readText(raw.partner);
  if (!Object.hasOwn(policy.partners, partner)) throw reject();

  expectExactKeys(raw.filter, SUPPORTED_DIMENSIONS);
  const filter = {};
  for (const dimension of SUPPORTED_DIMENSIONS) {
    const value = raw.filter[dimension];
    const dictionary = dimension === 'day' ? policy.dayBuckets : policy.allowed[dimension];
    if (value !== WILDCARD && !dictionary.includes(value)) throw reject();
    filter[dimension] = value;
  }

  expectExactKeys(raw.budget, ['mechanism', 'epsilon', 'delta']);
  if (raw.budget.mechanism !== 'pure-epsilon' || raw.budget.delta !== 0) throw reject();
  if (typeof raw.budget.epsilon !== 'number' || !Number.isFinite(raw.budget.epsilon)
    || raw.budget.epsilon <= 0) throw reject();
  const epsilonMicro = Math.round(raw.budget.epsilon * MICRO);
  if (epsilonMicro < 1 || Math.abs(raw.budget.epsilon * MICRO - epsilonMicro) > 1e-6) throw reject();
  if (epsilonMicro > policy.epsilonQueryMicro) throw reject();

  const canonicalQuery = canonical({
    partner,
    filter: { region: filter.region, industry: filter.industry, day: filter.day },
    mechanism: 'pure-epsilon',
    epsilonMicro,
    delta: 0
  });
  return Object.freeze({
    partner,
    filter: Object.freeze(filter),
    epsilonMicro,
    epsilon: epsilonMicro / MICRO,
    canonical: canonicalQuery,
    queryHash: createHash('sha256').update(JSON.stringify(canonicalQuery)).digest('hex')
  });
}

export { WILDCARD, SUPPORTED_DIMENSIONS };
