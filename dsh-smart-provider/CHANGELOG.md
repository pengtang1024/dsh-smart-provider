# Changelog

本项目所有显著变更都记录在本文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.1] - 2026-11-25

### Fixed

- **P1 水合误判免费**：`lib/health-persistence.js` 回放 `cost.jsonl` 时，过去只读 `estimated_cost_usd`，把无价表粗估（`price_known:false` / `estimated:true`）的占位 0 当成实测免费证据，20 行即可让 `deepseek-account/deepseek-flash` 进入 UI「可能免费」区。现在只有 `price_known===true && estimated!==true` 的零成本行才作为免费证据回灌 L1；正成本无论价格标记如何仍计入 metered。`probe-cache.jsonl` 的 `free` / `metered` verdict 已带上游 billingSource 证据，保持不变；`unknown` + cost=0 继续按 probe.js 口径保持 UNKNOWN。历史旧行（无 `price_known`）统一按「无证据」处理，不回放为免费（正成本仍回放为 metered）。真实免费不受影响：`x-opencode-free` 零价声明、`billingSource=free` 的上游确认、真实 20 条 `cost=0 && price_known=true` 仍判 FREE。核对 `cost-stats` 的 savings：无价表零成本行仍标记 `known:false` / `estimatedUsd:null`，不会把估算 0 当成实际节省金额。
- **回归测试**：新增 `test/hydration-billing.test.mjs`（9 条：估算零成本 21 行 UNKNOWN、真实零价 21 行 FREE、`estimated:false` 零价 FREE、probe 上游 free 高置信 FREE、probe unknown 零成本 UNKNOWN、旧行无价格标记不算免费、旧行正成本 METERED、savings 不伪造金额，以及无价表 deepseek 估算零触发证明），并注册进 `--unit` 白名单；`test/persistence.test.mjs` 中「20 条零成本→FREE」的夹具显式写 `price_known:true`，保持原有真实免费断言。npm test 168/168、test:unit 132/132，退出码 0；README 英文摘要同步实测数字。

## [1.2.0] - 2026-11-25

### Added

- **冷启动健康水合**：新增 `lib/health-persistence.js`。插件激活时从 `cost.jsonl` + `probe-cache.jsonl` 纯读重放已持久化的健康证据 —— L1 逐行走 `updateHealth()`（与实时路径、探测共用同一个分类入口，键保持 `(provider, modelId)` 元组粒度），L2 交给既有的 `rebuildFromLedger()` 重建后合并进适配器持有的同一注册表对象，探测结论（free / metered / unknown）回灌 L1。此前 `buildHealthDeps()` 交出空注册表、`rebuildFromLedger()` 没有调用方，每次重载都会清零已经由真实流量证明过的路由判决、计费置信度与账号冷却/连击。读取上界 = 4 MiB 尾部字节窗 + 5000 行（`DEFAULT_HYDRATION_BOUNDS`，常量、不可配）；只读，文件缺失 / 目录不存在 / 损坏行 / 半行 / 尾部截断都不抛错；`health=false` 时完全不水合（连文件都不打开）；重放不覆盖更新的实时证据（按时间戳比对）；一行 info 汇总重放与跳过计数。
- **tier 诊断可行动化**：新增 `explainTierMiss()`。层一没有候选匹配时 relax 行为不变（不阻断请求、所有路由可用），但告警从「只报任务类型」升级为可照做的诊断：缺失的位置标签、每个候选路由实际携带的标签（超过 8 个截断并注明剩余数量）、该标签为什么无法自动推导（`thrifty` / `swift` 永远只能手填）、可复制的 `positionOverrides` 两种写法、`tierPolicy` 只能改尝试顺序而不能凭空造标签的边界说明，以及明确的 NOT blocked。首行字面保持不变，`grep 'relaxing to all available routes'` 仍然有效；空路由列表也会留一行可行动告警而不是静默返回 `[]`。
- **query-cost 报表追加两段**：`scripts/query-cost.mjs` 在原有花费汇总与分组花费表之后新增 **failure rate**（每组 `failed / calls`，只有真实 `failure_code` 才算失败，缺失或空串算成功）与 **latency**（ttft 均值、nearest-rank `p50`、ttft 样本数、tok/s 均值、tps 样本数）。缺延迟键的老行被排除在延迟统计之外、绝不当 0ms；样本 <3 打 `*`；无样本打 `-`；整次选择无样本给诚实空态文案；垃圾值不产生 `NaN` / `Infinity`。
- **测试门禁自动发现 + 发现守卫**：`scripts/run-tests.mjs` 全量模式扫 `test/*.test.mjs` 自动执行（**新增测试文件无需注册**）；`test/` 下存在未被执行的 `.mjs` 即非 0 退出并逐个点名，`test/` 下一个 suite 都没有也非 0 退出（避免「跑 0 个测试=成功」）。

### Changed

- **`positionOverrides` 双形态**：对象形态 `{ "vendor/model": { "tags": [...] } }`（主推，与 `registry/position-overrides.user.yaml` 的 `overrides` 同形）与数组形态 `{ "vendor/model": [...] }` 都受支持；两者都经小写/去空格/白名单过滤后与 catalog 自动推导结果**保守合并**（不是替换）。README §七 的配置示例改为对象形态，并点明两种写法都有效。
- **`tierLimit` 语义明确化**：非有限值（`NaN`）、`-1`、`0` 回落默认 2 层，小数向下取整（`2.9 → 2`），`1` / `2` 正常切片；该语义写进配置字段说明与 `selectTiers()` 的 JSDoc。
- **文档与包结构同步**：README / docs/DETAIL.md 同步以上改动、包结构（`lib/health-persistence.js`、`test/persistence.test.mjs`、`test/routing-tier.test.mjs`、`test/query-cost.test.mjs`）与实测验证数字（`npm test` 159/159、`npm run test:unit` 123/123，2026-11-25，退出码 0）；README §十 改写为「自动发现 + 发现守卫」门禁说明，§十一 新增两条已知限制。
- 版本号 `1.1.0 → 1.2.0`（本次三块改动均为 feat 级）。

### Fixed

- **`positionOverrides` 数组形态静默无效**：实现此前只读 `.tags`，用户照 README 文档写的数组形态被完全忽略 —— `selectTiers` 依旧报 `no tier matches ... relaxing`，且没有任何提示。现在两种形态等价生效。**这是一处可感知的行为变化**：以前「配了等于没配」的数组写法开始真正影响选路。
- **`tierLimit` 非法值让层一自相矛盾**：`-1` 会静默丢掉最后一层、`0` 会在已有匹配的情况下一层都不选，与「层一永不阻断请求」的契约打架；现在统一回落默认值。
- **测试门禁假绿**：新测试文件躺在 `test/` 却没注册进清单时，门禁照样全绿而测试从未执行（连续三个 task 踩过）；现在自动发现 + 发现守卫把「存在但永不执行」变成非 0 退出。

## [1.1.0] - 2026-11-25

### Added

- **延迟度量**：`cost.jsonl` 每条记录新增 `started_at` / `first_token_at` / `finished_at`（ISO 时间戳）、`ttft_ms`（首 token 延迟）、`duration_ms`（尝试总耗时）与 `tokens_per_second`（输出吞吐）字段；缺数据时整段不写（不留 0 或 null），无延迟键的旧行聚合行为不变。
- **实测速度因子**：账号择优 ranking 的速度因子改为「实测优先 → `speedTier` → 中性回退」三级取值——优先用本次会话账本的真实延迟证据（`ctx.speedEvidence`，按 `account_id` 归集），无实测再选手填档位，两者皆无取中性值；未启用 routing 时评分与旧版逐字节一致（回归测试锁定）。

### Changed

- **定价产品化（用户数据不再随包分发）**：随包默认表 `lib/pricing.json` 降级为仅含零价免费档声明（当前 4 行，由 `scripts/gen-custom-routes.mjs` 从本地注册表生成）；作者 151 行真实价格导出降级为 `lib/pricing.example.json`，仅作导入格式示例、不在默认加载路径。
- 新增价格表解析顺序：`DSH_SMART_PRICING_FILE` 环境变量 → `registry/pricing.user.json` → 产品默认表；无表可查的模型返回 tier 粗估（`known:false` / `estimated:true`，金额恒 0），绝不用账号历史价格冒充单价。
- `scripts/gen-custom-routes.mjs` / `scripts/validate-custom-routes.mjs` 对「无 providers 锚点」的 app-managed cordis 形态诚实降级（可见 WARN + 跳过 providers 块 + 退出码 0），不再静默失败。
- README / docs/DETAIL.md 同步以上功能点、包结构（`pricing.example.json`、`test/pricing.test.mjs`、`test/latency.test.mjs`、`test/compaction.test.mjs`）与验证数字（npm test 109/109、test:unit 79/79）；§十一删除「自动测速属于未来计划」的旧口径，改为已落地说明（实测优先 → `speedTier` → 中性回退）。

### Fixed

- 修复价格查询在默认表缺失真实单价时的行为：此前可能回退到账号历史价格，现在明确走 tier 粗估并标记 `estimated:true`。
- 修复延迟数据缺失时的账本污染：时间戳无效或不有序时不再写出无意义的 `ttft_ms` / `duration_ms`。
- **虚拟模型 contextWindow（task-5，工作树内验证）**：`lib/adapter.js` 为虚拟模型声明真实 `contextWindow`（首跳 catalog 缺失时取保守下限 128000），修复宿主压缩预检因 `context === undefined` 报 "no context capacity" 的问题；`test/compaction.test.mjs` 锁定该行为，全套测试 109/109 通过。
