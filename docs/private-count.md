# 受约束的差分隐私计数（private-count）

`private-count` 只在本地对 `data/records.json` 中的合成人员做交叉计数，
不接真实身份库、不访问网络。它回答的是“在公开字典允许的过滤条件下有多少
个不同 person”，并只发布带机制参数的噪声计数。

```sh
node src/cli.js private-count \
  --state var/privacy-state \
  --query '{"partner":"expo-a","filter":{"region":"east","industry":"*","day":"*"},
            "budget":{"mechanism":"pure-epsilon","epsilon":0.25,"delta":0}}'
```

`npm run demo` 会额外运行 `scripts/private-count-demo.js`：先展示同义查询复用
同一份缓存噪声，再把共享预算用尽并展示拒绝。所有演示只用临时状态目录。

## 隐私口径

| 项目 | 值 |
| --- | --- |
| 隐私单位 | `person` |
| 贡献限制 | 先按 `data/policy.json` 的 `contributionLimit` 截断每人记录，再统计 |
| 发布量 | 截断后命中过滤条件的去重 person 数，灵敏度 1 |
| 机制 | Laplace（纯 epsilon），`delta = 0`，尺度 `sensitivity / epsilon` |
| 随机源 | `crypto.randomBytes` 派生的 53 位单位；正式命令不使用、也不暴露种子 |
| 后处理 | 结果做数据无关的 6 位小数舍入；**不做裁零**，**不做**与总量的一致化 |

截断只依赖记录本身（按记录 id 稳定排序取前 N 条），不依赖查询条件，
因此同一份截断数据上任意多次查询的灵敏度都成立。若未来改为行计数或
`visits` 口径，必须重新定义机制与灵敏度，不能沿用这一入口。

噪声样本、随机源状态、真实人数都不会写入结果文档或审计日志；结果是
`noisyCount` 及其机制参数，不会附带可供反推的原始计数。拒绝响应只有错误码，
不含任何计数，也不扣预算。

## 查询约束

请求只有三个部分，未列出的字段一律拒绝，并且所有拒绝使用同一错误码与文本，
避免成为字典探测通道：

- `partner`：必须是策略中列出的合作方；
- `filter`：只允许 `region`、`industry`、`day`，取值必须是策略公开字典中的值，
  或用 `*` 表示不过滤；不支持任意表达式、任意字段或区间；
- `budget`：必须是 `{"mechanism":"pure-epsilon","epsilon":E,"delta":0}`，
  `E` 不得超过 `epsilonQueryMicro / 1e6`，且必须精确到 1e-6。

规范化表单按固定维度顺序、微单位 epsilon 和 `*` 通配生成，
字段顺序、对象键顺序不同的语义等价查询会得到同一个 `queryHash`。

## 预算与持久状态

预算池键为 `<datasetVersion>:shared` 或 `<datasetVersion>:partner:<id>`：

- `shareBudget: true` 的合作方共用同一个池（`expo-a`、`expo-b` 在演练策略中共享
  2.0 epsilon），合作方之间会互相消耗额度；
- `shareBudget: false` 的合作方各有独立池（`expo-c` 为 1.0 epsilon）；
- 数据集版本变化会形成新的池，旧账本不会被静默迁移；账本与策略指纹绑定，
  不符时直接拒绝并要求新的状态目录。

预算以微单位整数累加，避免浮点误差。一次成功查询的提交顺序是：

1. 锁内检查缓存与剩余额度；
2. 锁内写入 reservation 并扣减预算、`fsync`、原子替换账本，然后释放锁；
3. 锁外生成噪声（此时崩溃也会保留已扣的预算）；
4. 锁内登记缓存条目并标记 `committed`。

命中原缓存不扣费也不生成新噪声。并发请求通过锁文件和账本内的 `in-flight`
记录串行化，不会同时透支。进程在扣费后退出时，下一次恢复扫描会把该
reservation 标记为 `orphaned`，预算不退；同名重试只能作为一次新的付费查询，
不会免费拿到第二份噪声。

## 测试

```sh
npm test
```

`test/privacy-count.test.js` 通过本地并发子进程与故障注入覆盖：

- 扣费幂等：同义查询/并发同义查询只计一次，命中缓存不消耗随机源；
- 拒绝无副作用：预算耗尽时账本字节不变、随机源未抽取、输出不出现计数；
- 故障点 `afterReserve`、`afterNoise`、`afterCommit` 模拟进程退出，
  证明重启后缓存与预算一致，不会免费重抽；
- 并发争抢最后一个额度时只有一个请求成功、总支出不超过上限。

子进程入口在 `support/private-count-child.js`，它显式注入独立随机序列；
正式 CLI 只使用系统安全随机源。
