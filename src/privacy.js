/**
 * 纯 epsilon Laplace 机制：scale = sensitivity / epsilon。
 * 以 53 位单位 u 做逆变换：u < 0.5 时 b·ln(2u)，否则 -b·ln(2(1-u))。
 * epsilon 以微单位传入，避免浮点预算累加误差。
 */
export function laplaceNoise(unit, sensitivity, epsilonMicro) {
  if (!(unit > 0 && unit < 1)) throw new Error('随机单位应位于 (0, 1)');
  if (!(sensitivity > 0) || !Number.isSafeInteger(epsilonMicro) || epsilonMicro <= 0) {
    throw new Error('灵敏度与 epsilon 应为正数');
  }
  const scale = (sensitivity * 1e6) / epsilonMicro;
  return unit < 0.5 ? scale * Math.log(2 * unit) : -scale * Math.log(2 * (1 - unit));
}

/** 数据无关的展示舍入；只固定输出精度，不改变已采样的噪声值。 */
export function roundTo(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * person 级贡献截断：每人先按记录 id 稳定排序，再只保留前 limit 条。
 * 截断只依赖记录本身，不依赖查询条件，因此后续查询的灵敏度对任意交互都成立。
 */
export function clipContributions(records, limit) {
  const groups = new Map();
  for (const row of records) {
    if (!groups.has(row.person)) groups.set(row.person, []);
    groups.get(row.person).push(row);
  }
  const clipped = [];
  for (const rows of groups.values()) {
    rows.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    clipped.push(...rows.slice(0, limit));
  }
  return clipped;
}

function matches(row, filter) {
  return (filter.region === '*' || row.region === filter.region)
    && (filter.industry === '*' || row.industry === filter.industry)
    && (filter.day === '*' || row.day === filter.day);
}

/** 发布统计量：截断后命中过滤条件的去重 person 数。 */
export function countPeople(records, filter, contributionLimit) {
  const people = new Set();
  for (const row of clipContributions(records, contributionLimit)) {
    if (matches(row, filter)) people.add(row.person);
  }
  return people.size;
}

/**
 * 截断之后发布的是去重 person 数：增删一个 person 对该计数的影响恒为 1，
 * 所以全局灵敏度为 1，与每人保留几条无关。贡献上限影响的是单个 person
 * 能进入统计的记录条数，而不是这个去重计数的可辨识性。
 * 这里没有用行数或 visits 作为统计量，避免把访问次数误当人数。
 */
export function computeSensitivity() {
  return 1;
}
