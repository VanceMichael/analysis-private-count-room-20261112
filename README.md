# private-count-room

person 是合成人员键，同一人员可以多次出现，现有清点是内部数据核对。

项目提供本地记录校验、输入指纹、按 `region` 的原始核算，以及受约束的
**差分隐私交叉计数**入口（`private-count`）。后者只对仓库中的合成人员计数，
不接真实身份库，只发布带机制参数的噪声计数。分析人员可以保留完整输入并
复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，
字段约定见 `docs/data.md`，隐私入口的完整说明见 `docs/private-count.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js private-count --state var/privacy-state \
  --query '{"partner":"expo-a","filter":{"region":"east","industry":"*","day":"*"},
            "budget":{"mechanism":"pure-epsilon","epsilon":0.25,"delta":0}}'
npm run demo
```

`npm run demo` 在本地打印输入、现有核算及配置并生成 `var/summary.json`，
随后运行差分隐私短演示（同义查询复用缓存、预算耗尽后拒绝），不访问网络、
不等待真实业务时间。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t private-count-room:local .
docker run --rm --network none private-count-room:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：现有业务分组核算（原始计数，仅供内部核对）。
- `src/query.js`：合作方策略、预算池与查询规范化。
- `src/privacy.js`：person 级截断、去重计数与灵敏度。
- `src/noise.js`：系统安全随机源、Laplace 机制与测试用随机序列。
- `src/ledger.js`：跨进程锁、原子持久化、恢复扫描与缓存键。
- `src/privacy-count.js`：扣费—噪声—登记的单次隐私计数流程。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `support/private-count-child.js`：测试/演示用的独立随机源子进程入口。
- `scripts/`：现有演示与差分隐私短演示。
- `test/`：输入约束、领域核对、隐私口径、并发与故障恢复回归。
- `data/`：合成记录、独立核对值及本地业务配置。
