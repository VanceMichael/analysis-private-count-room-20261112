import { randomBytes } from 'node:crypto';

/**
 * 系统安全随机源。每次取 53 位来自 crypto.randomBytes 的熵，返回严格位于 (0, 1)
 * 的浮点数，避免逆变换在端点取到无穷值。正式命令只使用这个源；
 * 随机单位与种子都不进入查询、结果或日志，也不向外暴露内部状态。
 */
export function systemNoiseSource() {
  return Object.freeze({
    description: 'system-cryptographic',
    nextUnit() {
      const bytes = randomBytes(8);
      const value = bytes.readBigUInt64BE(0) >> 11n;
      return (Number(value) + 0.5) / 2 ** 53;
    }
  });
}

/** 测试/演示专用：按给定单位序列注入独立随机源，不接触系统熵，也不复用正式源。 */
export function sequenceNoiseSource(units, description = 'test-sequence') {
  let index = 0;
  return {
    description,
    get draws() { return index; },
    nextUnit() {
      if (index >= units.length) throw new Error('测试随机源已耗尽');
      const unit = units[index++];
      if (!(unit > 0 && unit < 1)) throw new Error('测试随机单位应位于 (0, 1)');
      return unit;
    }
  };
}

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
