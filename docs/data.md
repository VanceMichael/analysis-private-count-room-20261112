# 数据与现有口径

person 是合成人员键，同一人员可以多次出现，现有清点是内部数据核对。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `person` | `string` |
| `region` | `string` |
| `industry` | `string` |
| `day` | `integer` |
| `visits` | `integer` |

现有 `summary` 按 `region` 清点记录，`sum` 为 `visits` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存差分隐私计数入口的策略，`private-count` 会消费它，`summary`/`inspect` 仍不消费分析配置。

`inspect` 返回输入行数、字段列表、数据集版本与 SHA-256 指纹；指纹不依赖字段或记录排列，数据集版本是 `datasetVersion` 字段（当前为 `synthetic-v1`）。数据文件版本或数据集版本与策略不一致时直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

`private-count` 只使用这里的合成记录，详见 `docs/private-count.md`：隐私单位为 person，先按 `contributionLimit` 截断每人记录条数再统计去重人数；过滤字段只限公开字典中的 `region`、`industry` 与 `day` 桶。
