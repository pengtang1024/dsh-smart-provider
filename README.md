# dsh-smart-provider（DSH 智能模型路由）

`smart` 是一个 DSH 元提供商：它本身不调用任何大模型 API，而是在你**已配置的供应商路由**之间按序故障转移，并提供离线成本统计。它是**通用智能路由**，不是某一个账号的「省钱脚本」——四个目标是省钱 / 高性能 / 高能力 / 复合（智能），由每个用户按自己的需要选；**代码默认是中立的**（均衡权重 .25，不偏向任何单一目标），「省钱优先」是用户自己的 config 值（`cost-first` 策略），不是出厂默认。

简体中文 → [docs/DETAIL.md](docs/DETAIL.md)
English → [docs/DETAIL.en.md](docs/DETAIL.en.md)
Español → [docs/DETAIL.es.md](docs/DETAIL.es.md)
Français → [docs/DETAIL.fr.md](docs/DETAIL.fr.md)
Deutsch → [docs/DETAIL.de.md](docs/DETAIL.de.md)
Русский → [docs/DETAIL.ru.md](docs/DETAIL.ru.md)
Português → [docs/DETAIL.pt.md](docs/DETAIL.pt.md)

**本地化：自动跟随当前 DSH 语言（无需选择）。** 设置页文案随 DSH 当前语言实时切换，不提供语言选择器：zh / en / de / es / fr / pt / ru 七语设置文案内联同一 248 活跃 key 键集；缺译文或尚未支持的语言（如 ja）自动回退 en，绝不显示裸 key。机制沿用 `ctx.locale.register(NS, { zh, en, de, es, fr, pt, ru })` + `ctx.locale.bind(NS)` + slot 的 `useSyncExternalStore`，切换语言即时生效。

实现依据父工作区的设计文档：

- `meta-provider-设计方案.md` —— 核心骨架、错误分类、仅在响应建立前回退
- `多账号池设计方案.md` —— 跨账号即跨路由、跳级（hop 级）冷却
- `方案盲点审查.md` —— 三处 P0 修复，以及性能审查的后续项
- `可用性自动管理设计.md` —— L1 路由健康注册表：故障分类 P0–P4、状态机、计费证据等级
- `账号池自动管理深化设计.md` —— L2 账号四状态与半开恢复、L2a 拓扑分类
- `落地规格.md` —— 四稿合并后的分期规格与冲突裁决（开发强约束）

**当前状态：插件已安装并启用，已设为默认模型，插件状态 ACTIVE。** 智能路由默认生效，省钱链路、配置页真读写、P1（资源自适应 / 中立默认 / 动态链）、P2（两层智能路由）、三层健康自动管理（默认开启）均已落地并独立验收。详见下文与 `docs/DETAIL.md`。

---

## 一、已落地能力（有验收证据）

- **智能路由默认生效。** `smart/auto` 是默认模型，已在真实会话中验证选路、回退、成本记录与会话记录。
- **省钱真落地（用户可选，不是默认）。** 自建免费路由 `x-opencode-free`（`hy4-flash-free`）排在 `auto` 链首，真实账本里该路由的每一笔 `estimated_cost_usd` 都是 `0`（已核对 213+ 笔，最近一次全量统计 487 笔 cost=0）；遇到 402/配额错误自动 fallback 到付费路由（`opencode-go`）。免费档由 `registry/custom-routes.user.yaml` 的 `tier: free` 自动排首，不需要改代码。
- **配置页真读写（2.2.0 起为三个 Tab：总览 / 路由设置 / 花费与健康）。** 设置页展示来自 pi-ai 的真实资源（当前约 49 provider / 58 model，数量随你的 DSH 实时注册表变化）、真实凭据名与账号健康，并可写回插件配置；「花费与健康」走 `@Remote` 真账通道（`lib/cost-stats.js` 读真实 `cost.jsonl` + `lib/remote.js` 暴露 `smartProvider.cost()` / `costDetail()`），明细带 ttft 与 tok/s 两列，不再依赖硬编码或空壳状态。保存按钮常驻卡片头、有「未保存」标记、切 Tab 会拦住未保存草稿；删除一律二次确认；加载 / 空 / 错三态分家，诊断信息收进默认折叠区。详见 §六末的设置页结构说明。
- **P1（资源自适应）。** `chains` 动态生成（`discoverAutoChain()` 从实时注册表按 provider/model 名排序建中立 `auto` 链，不内置任何具体用户的模型 id）；内置默认链刻意为空 `DEFAULT_CHAINS={auto:[]}`，没配时使用用户当前真实拥有的路由；老配置（`chains` / `accounts` / `custom-routes.user.yaml`）原样保留、不覆盖；定价表缺失字段有降级回退（reasoning / cacheOutput 回退到 output，cacheRead / cacheWrite 回退到 input）；策略默认中立 `.25`（`balanced`）。
- **三层健康自动管理默认开启。** 模型层（L1 `availability.js`）、账号层（L2 `account-health.js`）、拓扑层（L2a `provider-topology.js`）分开记账，注册表与设置页首屏共享同一对象引用。关键纠偏：参数不兼容/缺 header 的 4xx **不再连累模型健康**；冷却到期只变 `HALF_OPEN`，要一次真实请求成功才回到 `ACTIVE`（没有证据就没有恢复）；自带账号池的路由不会被再套一层。默认开启、可显式 opt-out，关闭后逐字节回 legacy。详见 §六。
- **P2（两层智能路由）。** `lib/routing.js` 四个纯函数：`classifyTask`（请求分类）、`derivePosition`（模型位置标签）、`selectTiers`（层一候选层选择）、`resolveRoutingPolicy`（预设解析）。**默认启用、中立等权（`balanced`）；可显式关闭**：`ranking.routing.enabled=false` 时该代码路径逐字节等于现状（legacy），不选路、不加评分；默认开启时也不偏向省钱 / 速度，四因子等权 .25。支持的策略预设共 8 种：`balanced` / `cost-first` / `speed-first` / `reasoning-first` / `longctx-first` / `vision-first` / `legacy` / `custom`。

---

## 二、包结构

```
dsh-smart-provider/
├── package.json              bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml          一条 Host 插件行 —— 刻意不写 smart: provider 块
├── index.js                  插件入口：registerAdapter(['smart'], adapter)，注册 @Remote 与只读 host 命令
├── schema.js                 配置 schema（schemastery 通过磁盘锚点加载，routing 字段 volatile）
├── lib/
│   ├── dsh.js                DSH 包加载器（createRequire 锚定真实 manifest）
│   ├── adapter.js            SmartAdapter：双层故障转移、账号冷却、P0-1/2/3、P2 选路接入
│   ├── chains.js             默认链（空）、动态 auto 链发现、链校验、resolveChain
│   ├── account-pool.js       账号模型、模型→账号池、双层 plan()
│   ├── availability.js       L1 路由健康注册表：故障分类 P0–P4、状态机、计费置信度、投影
│   ├── account-health.js     L2 账号状态机：冷却/退避/半开恢复、失败分层、账本重建
│   ├── provider-topology.js  L2a 拓扑分类：自带池 vs 直连，纯结构化证据（无白名单）
│   ├── health-setup.js       L7 接线：默认开启、opt-out 解析、注册表组装
│   ├── health-persistence.js 冷启动水合：从 cost.jsonl / probe-cache.jsonl 只读重放健康证据（task-6）
│   ├── probe.js              极小真实探测（1 token）+ TTL 缓存，替代按名字猜免费
│   ├── ranking.js            账号择优评分（默认启用，中立 .25 默认，可显式关闭）
│   ├── routing.js            P2 两层智能路由四个纯函数（默认启用、中立等权，可显式关闭）
│   ├── cost-meter.js         非阻塞批量 JSONL 写入（含 account_id 字段）
│   ├── cost-stats.js         读取真实 cost.jsonl 并聚合（供成本 Tab / @Remote）
│   ├── remote.js             @Remote 服务 smartProvider.cost()
│   ├── pricing.js            离线价格查询 + 美元估算（零价默认表 + tier 粗估降级）
│   ├── pricing.json          产品默认价格表：仅零价（免费档）声明，不含真实单价
│   └── pricing.example.json  作者 151 行真实价格导出（仅示例，不在默认加载路径）
├── registry/
│   ├── custom-routes.user.yaml  自建路由唯一人工编辑点（x-opencode-free 在此）
│   ├── custom-routes.yaml    生成后的自定义路由配置
│   └── registry-lib.mjs      注册表读取工具库
├── scripts/
│   ├── query-cost.mjs        “模型 X 花了多少钱 / 占比多少” 命令行工具
│   ├── gen-custom-routes.mjs 由 user.yaml 生成自定义路由配置
│   ├── validate-custom-routes.mjs 自定义路由配置校验
│   └── run-tests.mjs         统一验证入口：语法检查 + 自动发现的全部测试（含发现守卫，自动选 Electron Node）
├── test/                    放进来就会被执行（*.test.mjs，无需注册；见 §十）
│   ├── account-pool.test.mjs 账号池回归测试（需 DSH runtime 读 app.asar；全量门禁）
│   ├── compaction.test.mjs   虚拟模型 contextWindow / 压缩预检回归测试（task-5，需 DSH runtime；全量门禁）
│   ├── config.test.mjs       配置 schema 声明回归测试（E1A，2 条纯逻辑，--unit 白名单）
│   ├── cooldown-consistency.test.mjs 双冷却权威一致性契约回归测试（14 条纯逻辑，--unit 白名单）
│   ├── custom-routes.test.mjs 自建路由生成 / 校验回归测试（需 DSH runtime；全量门禁）
│   ├── health-snapshot.test.mjs 健康快照纯函数回归测试（16 条纯逻辑，--unit 白名单）
│   ├── health-taxonomy.test.mjs 健康失败码分类一致性回归测试（E0A1，10 条纯逻辑，--unit 白名单）
│   ├── health.test.mjs       健康层回归测试（65 条纯逻辑，--unit 白名单）
│   ├── hydration-billing.test.mjs 水合计费证据回归测试（12 条纯逻辑，--unit 白名单）
│   ├── latency.test.mjs      延迟度量与速度因子回归测试（需 DSH runtime；全量门禁）
│   ├── loading.test.mjs      加载路径回归测试（需 DSH runtime；全量门禁）
│   ├── note-failure-override.test.mjs noteFailure 冷却覆盖契约回归测试（E1D，3 条纯逻辑，--unit 白名单）
│   ├── persistence.test.mjs  冷启动水合回归测试（task-6，19 条纯逻辑，--unit 白名单）
│   ├── pricing.test.mjs      定价降级与解析顺序回归测试（纯逻辑，--unit 白名单）
│   ├── probe.test.mjs        probe 缓存新鲜度回归测试（D1，8 条纯逻辑，--unit 白名单）
│   ├── query-cost.test.mjs   query-cost 报表段回归测试（task-8，11 条纯逻辑，--unit 白名单）
│   ├── ranking.test.mjs      路由排序回归测试（纯逻辑，--unit 白名单）
│   ├── remote-surface.test.mjs @Remote 路由面契约回归测试（9 条纯逻辑，--unit 白名单）
│   └── routing-tier.test.mjs tier 选择 / relax 诊断 / 手填标签回归测试（task-7，14 条纯逻辑，--unit 白名单）
│                             共 24 个测试文件 / 318 条断言（全量）；--unit 白名单 17 个测试文件 / 260 条（纯逻辑）
├── locale/{en,zh}.json       插件显示元数据
├── docs/DETAIL.md            插件管理器详情页
├── icon.svg                  原创图标
└── README.md                 本文档
```

---

## 三、三处 P0 修复

### P0-1 —— 重试叠加（代价最高的一处）

注册的 smart 路由使用显式零重试策略：
`resolveRetryPolicy({mode:'normal', maxRetries:0, retryableCodes:['SERVER']})`。

`retryableCodes` 必须非空，因为 normal 策略的 schema 要求 `.min(1)` —— 空数组会被拒绝。在 `maxRetries: 0` 下，外层 `agent/request-error` 永远无法把整条链重放 5 次（审查中最坏情况是 3 跳 × 6 = 18 次计费请求）。`ABORTED` 永远不会被转换成可重试的 finish。

### P0-2 —— 虚拟模型的可发现性

`SmartAdapter` 覆写了以下方法：

- `listModels()` —— 对外声明 `smart/auto` 以及每一条已配置链的 key，让图形界面、ACP 与子代理的模型发现都能选中它。
- `imageRequestPricing()` —— 委托给第一跳真实 hop 的适配器，避免图片请求被 “4 chars/token” 兜底启发式错误计价。
- `providerRetryPolicy()` —— 返回 P0-1 解析出的零重试策略。

另外 `resolveModel()` 委托给 `runtime.resolveModelInfo()` —— **不是** `runtime.resolveModel()`；后者在 `LlmRuntime` 上并不存在，第一跳就会抛 TypeError（性能审查，task-25 捕获）。

### P0-3 —— 真实跳次的可见性

每次跳次尝试之前，适配器都会向当前会话追加一条可忽略（ignorable）的插件记录：
`plugin:dsh-smart-provider/hop-selected`，载荷为
`{event:'smart/hop-selected', hopIndex, provider, model, accountId, failureCode, at}`
（`accountId` 标识真正服务本次尝试的账号池账号）。

为什么用插件记录而不是原始 `smart/hop-selected` 事件：DSH 的会话持久化层拒绝恢复含有未知**不可忽略**事件类型的日志。插件记录是官方认可的仓库外扩展方式 —— 可忽略、fork/恢复时保留、可用 `pluginRecordOf()` 读取。所需的全部事实（hopIndex、实际 provider/model、触发的失败码）都在其中。

**验证口径：** 在解压后的会话日志上用 `grep 'hop-selected'`；不要期待存在一个名为 `smart/hop-selected` 的顶层事件。

---

## 四、账号池 —— “多账号” 是池化，不是扁平跳链

**模型与账号是两个正交维度。** 切换链决定**试哪个模型**；账号池决定**用哪个凭据/路由**服务该模型。某个账号遇到 402 不再冻结整个模型。

```
model: deepseek-v4.1-flash
  ├── account A  (route opencode-go,      key ref KEY_A)   健康
  ├── account B  (route opencode-go-alt,  key ref KEY_B)   冷却中
  └── account C  (route opencode-zen,     key ref KEY_C)   健康
```

DSH/pi-ai 每条 provider 路由只绑定一个 key（单 `apiKeyEnv` —— 已核实），因此**同一厂商的第二个账号 = 第二条 provider 路由**。池记录 `model -> account[]`，每个账号形如
`{id, provider(route), credentialRef, models[], health}`。

### 选择逻辑（两层）

1. **模型层** —— `resolveChain(outerModel, chains)` 产出有序的 `{provider, model}` 跳次；未配置 chains 时用 `discoverAutoChain()` 从实时注册表生成的中立 `auto` 链。
2. **账号层** —— 对每一跳的模型，池把它展开为该模型所有健康账号，排序规则：本跳自身路由上的账号优先，然后最少使用优先（轮询）。转向下一个模型之前，会尝试该模型的每一个健康账号。
3. **冷却是账号级的** —— 只以 `SmartAdapter.cooldowns` 中的 `accountId` 为键（原来是 `provider/model`）。账号 A 上的 402 只跳过 A；同模型的账号 B、C 仍然可选。
4. 一旦有任意内容块（content chunk）发出，响应即提交 —— 仅在建立前回退的规则不变。

### 配置（可选）

在插件配置里加 `accounts` 数组，每一项即一个账号：

```json
{
  "chains": {
    "auto": [{ "provider": "opencode-go", "model": "deepseek-v4.1-flash" }]
  },
  "accounts": [
    { "id": "go-primary", "provider": "opencode-go",     "credentialRef": "OPENCODE_GO_API_KEY",  "models": ["deepseek-v4.1-flash", "glm-5.3-flash"] },
    { "id": "go-alt",     "provider": "opencode-go-alt", "credentialRef": "OPENCODE_GO_KEY_B",    "models": ["deepseek-v4.1-flash"] }
  ]
}
```

- `id` —— 稳定的账号标识；**这是冷却键**，也是跳次记录与成本行里写入的 `accountId`。
- `provider` —— 已存在的 DSH 路由名（一条路由 = 一个 key）。把第二个账号注册为 `llm-pi-ai.providers` 里的第二条路由即可，无需改动 DSH 生产代码。
- `credentialRef` —— 仅用于文档与脱敏展示；真实 key 始终留在 DSH 凭据中，绝不写入此配置。
- `models` —— 该账号可服务的模型 id 列表。

显式账号会替换同一路由上的隐式跳次账号，因此配置池不会重排既有链。`normalizeAccounts()` 会丢弃格式错误的条目（缺 id/provider/models、id 重复），而不是让请求失败。

### 向后兼容（未配置 `accounts` 时）

当 `accounts` 缺失或为空，`AccountPool` 处于隐式模式：每个链跳次恰好对应一个账号，id 为 `hop:<provider>/<model>`，尝试顺序即链顺序，冷却/可见性/成本保持原有的 per-hop 语义。**只有配置池路径是新行为；默认路径逐字节不变。**

---

## 五、账号择优 ranking（P1，默认启用 + 中立等权）

`ranking.js` 提供多因子账号评分（成本 / 速度 / 等级 / 负载），**默认启用、中立均衡**（四因子等权 .25，不偏向省钱 / 速度）；显式 `enabled:false` 或 `strategy:'legacy'` 时排序完全保持旧行为（路线优先 + 最少使用）。策略预设：`legacy` / `balanced`（中立 .25）/ `cost-first` / `speed-first` / `tier-first` / `custom`。权重可自定义并在保存时归一化到和 = 1；典型 token 配比仅影响排序、不影响计费；`historical` 账本反哺用最近 N 条真实成本记录校正配比，但**不能反推真实单价**。配置字段清单见 `lib/ranking.js` 的 `RANKING_CONFIG_SCHEMA`。账号级字段见同文件的 `ACCOUNT_RANKING_FIELDS`，其中计费 / 额度相关两项：

| 字段 | 标签 | 类型 | 取值 / 范围 | 默认 | 显示条件 | 说明 |
|---|---|---|---|---|---|---|
| `costModel` | 计费形态 | enum | `metered` / `subscription` / `free` | `metered` | —— | 订阅制用额度消耗代价代替价格 |
| `quotaCost` | 额度消耗代价 | number | 0–1（`min: 0`，`max: 1`） | —— | `costModel = subscription` | —— |

**速度因子的取值顺序（已落地）**：优先用本次会话账本里的真实延迟证据（`ctx.speedEvidence`，来自 `cost.jsonl` 的 `ttft_ms` / `tokens_per_second`，按 `account_id` 归集）；没有实测数据时回退到手填的 `speedTier`（fast/normal/slow）；两者都没有时取中性值 0.5。未启用 routing 或无任何证据时，评分结果与旧版逐字节一致（有回归测试锁定：`speed factor fallback chain: measured > speedTier > neutral`）。2.2.0 起这条取值顺序在账号池的 `plan()` 阶段同样生效：`lib/account-pool.js` / `lib/adapter.js` 把按 `account_id` 归集的实测证据注入 `speedEvidence`，由 `test/account-pool.test.mjs` 与 `test/latency.test.mjs` 锁定。

**这些字段在设置页里直接可改。** 账号级字段（`tier` / `speedTier` / `priceTier` / `costModel` / `quotaCost` / `priceMultiplier` / `priceOverrides` / `priority` / `weight`）在「路由设置 → 账号池与择优」的账号行里编辑，取值来自 `lib/ranking.js` 的 `ACCOUNT_RANKING_FIELDS`（与 Host 同源，客户端不另写一份）。保存时按 Host 默认值补全、`quotaCost` 只在 `costModel=subscription` 时写入；整行按「展开原对象再覆盖」重建，所以用户手写的、模板里没有的字段会原样保留，不会被一次保存抹掉。

---

## 六、三层健康自动管理（默认开启）

产品意图是“自动正确管理”，所以这套机制**默认开启**，用户只能显式关闭、不需要开启。它把「模型坏了」「账号坏了」「这个路由自带池，别插手」三种完全不同的故障分开记账：旧实现只有一个 `isHealthy = !cooldown`，把三者混成一团，且冷却中的账号永远收不到能证明它恢复的那次请求，恢复只能靠时间到点。

| 层 | 模块 | 负责什么 | 判定粒度 |
|---|---|---|---|
| L1 路由健康 | `lib/availability.js` | 模型/端点是否可用、是否免费 | 精确 `(provider, modelId)` 元组，绝不按 provider 或裸 modelId 合并 |
| L2 账号健康 | `lib/account-health.js` | 凭据/额度是否可用、冷却与半开恢复 | `accountId` |
| L2a 拓扑 | `lib/provider-topology.js` | 这个路由是不是自带账号池（是就别再包一层） | `provider`（仅作证据标签，不参与分类） |
| L7 接线 | `lib/health-setup.js` | 默认开启、opt-out、注册表共享 | —— |
| 探测 | `lib/probe.js` | 用一次真实极小请求替代“按模型名猜免费/付费” | `(provider, modelId)` |

三个注册表是**同一个对象引用**：适配器写入的就是设置页首屏读取的，没有第二份镜像。

### L1 —— 故障分类的关键纠偏

`classifyFailure()` 按 P0→P4 顺序判定，**请求形状问题绝不连累模型健康**：

| 优先级 | 类别 | 影响模型健康 | 例子 |
|---|---|---|---|
| P0 | `SESSION_HEADER` / `PARAM_COMPAT` | 否 | 缺 session 头、`max_completion_tokens` 不支持、`developer` role |
| P1 | `RENAMED` / `OFFLINE` | 是 | 404/UNKNOWN_MODEL，配合上游 id 列表判定重命名还是下线 |
| P2 | `QUOTA` / `RATE_LIMIT` / `AUTH` | 否 | 402、429、401/403 —— 这是账号层的问题 |
| P3 | `SERVER_JITTER` | 连续 3 次才降级 | 5xx、timeout、stream closed |
| P4 | `UNKNOWN` | 否 | 无特征指纹的裸 400 |

**这是设计里最重要的一条纠偏**：旧实现把所有 4xx 都塞进 `SERVER` 粗桶，于是一个参数不兼容的请求会把一个好模型打成不可用。现在裸 400 落 `UNKNOWN`，`max_completion_tokens` 这类消息落 `PARAM_COMPAT`，两者都不动模型健康。

状态机：`UNKNOWN → HEALTHY`（任意一次成功）；`OFFLINE` 连续 3 次 → `DEPRECATED`；`SERVER_JITTER` 连续 3 次 → `DEGRADED`。**双源零样本一定是 `UNKNOWN` 且 confidence 0，绝不判成“不可用”**。`DEPRECATED`/`DEGRADED` 也不从候选池删除，只是排到后面。

`updateHealth()` 是纯函数：返回新记录、不改入参；虚拟路由副本（如 `smart` 自身）**永不写健康**。

### L1 —— 免费/付费的证据等级

不靠模型名猜。**用户口径「名字带 free 或者倍率为 0 的可以默认认为免费」已实现为弱信号 / 用户声明默认值（free-signal-v1，未实测）**：名字含 `free`、`priceMultiplier=0`（或 `costModel=free` / `priceTier=free`）即「默认免费（未实测）」：只用于候选收录 / 筛选 / 排序代理与显示「可能免费（未实测）」，等级为 `weak` / `declared`，**不写 L1 billingTier=FREE**；可被真实付费证据（probe `metered`、账本正成本、付费 billingSource、真实正价）推翻。`probeVerdict=unknown` 不阻断弱信号；估算零价（`estimated:true`）不是证据；只有有限数值 `0` 算倍率零。真凭实据的强度：上游 `billingSource`/`cost>0`（高，0.95）> 自己的付费样本（高）> 账本里 20 条以上 cost=0 样本（中，0.7）。只有价格标记、没有任何真实样本时结论是 `UNKNOWN`，不是 `free`。**重命名会强制清零计费证据**：旧价格不能顺延给新 id，必须重新确认，否则“省钱”就是假的。设置页账号行的「价格倍率」可直接修改（留空 / 非法值按 1，`0` = 声明免费）；当前部分路由 probe 多为 `unknown` 的根因尚在验证，不据此宣称任何模型一定免费。免费标签分实测 / 声明 / 未实测三档；实测档按来源显示「已确认免费·价格表 / ·探测 / ·账单」后缀，且按 `(provider, modelId)` 元组取证据（同名模型不跨 provider 串标）；账号倍率 0 属声明级，可被实测付费证据推翻。

### L2 —— 半开恢复，而不是时间到点自动复活

四个状态与排序权重：

| 状态 | 权重 | 含义 |
|---|---|---|
| `ACTIVE` | 1.0 | 最近一次真实请求成功 |
| `UNKNOWN` | 0.8 | 还没有证据 |
| `HALF_OPEN` | 0.5 | 冷却到期，**允许一次**真实用户请求来证明自己 |
| `COOLING` | 0 | 冷却中，不参与排序 |

冷却到期只会变成 `HALF_OPEN`，永远不会直接 `ACTIVE`；没有真实流量就一直停在 `HALF_OPEN`（**没有证据就没有恢复**）。每次真实请求消耗一个半开许可，结果是成功才回到 `ACTIVE` 并清零连击，失败则继续冷却。全程不需要探测请求。

基础冷却与连击退避（`base × 2^(streak-1)`，上限 24h）：配额 30min、鉴权 24h、限流 1min、抖动 5s。**第一次失败用基础值**，不是翻倍值。

失败分层：`SESSION_HEADER`/`PARAM_COMPAT`（请求构造问题）、`RENAMED`/`OFFLINE`（模型层问题）都**不冷却账号**——“谁的问题谁负责”。`UNKNOWN` 只加样本不惩罚。

### L2a —— 自带账号池的路由不要重复包一层

有些插件对外是一条路由、内部已经轮换多个账号。再给它套一层账号池，两个池会互相打架。所以先分拓扑，再决定要不要建账号层：

| 证据 | 优先级 | 判定 |
|---|---|---|
| `provider.aggregatesAccounts === true/false` | P0 | 直接采信声明 |
| 同一 provider+model 观测到 >1 个不同 `account_id` | P1 | 自带池 |
| 声明里有 `accounts`/`regions` 数组或 `pool` 能力 | P1 | 自带池 |
| 无任何结构化证据 | P2 | `UNKNOWN`（保守按 direct 处理，但标记未确认） |

**硬规则：没有 provider 名字白/黑名单**，分类只能来自结构化证据，`provider` 字符串只用于挂证据与告警。判定为自带池时不建账号层，但**不会静默丢掉**用户配置的 account —— 产生 `AGGREGATOR_ACCOUNTS_IGNORED` 告警交由首屏展示。用户可用 `forceAccountLayer: true` 显式覆盖，这是可逆的显式选择，不是产品默认。

### 探测 —— 一次 1 token，绝不挡人

客户端拿不到 `stream`（只有 Host 有），所以探测在 Host 侧：每个 `(provider, model)` 发**一次 max_tokens=1** 的请求，读 `usage.cost`/`billingSource` 得出 `free`/`metered`/`unknown`。结论写入 L1 并带正确的置信度；缓存 7 天，单次调用最多 3 个真实探测，超出返回诚实的 `unknown`（附身份，不隐藏）。`unknown` **永不阻断**——“不能挡”这条规则优先于任何猜测。

### 冷启动水合 —— 重放磁盘上已经证明过的证据（1.2.0）

`buildHealthDeps()` 交出的注册表是**空**的，于是 1.2.0 以前每次重载/重启插件，L1 的路由判决（`HEALTHY` / `DEGRADED` / `DEPRECATED`、免费还是付费的计费置信度）与 L2 的账号状态（冷却、连击、样本）全部清零 —— 而这些证据早已被真实流量证明过、就躺在 `cost.jsonl` 里，连 `rebuildFromLedger()` 都没有任何调用方。

现在激活时由 `lib/health-persistence.js` **纯读重放**一次：

- **L1 路由层** —— `cost.jsonl` 逐行走 `updateHealth()`，和实时路径、探测共用同一个分类入口（不另写第二套判定），键保持 `(provider, modelId)` 元组粒度，绝不按 provider 或裸 modelId 合并；`probe-cache.jsonl` 里记录的探测结论（`free` / `metered` / `unknown`）也回灌进 L1，同一 `(provider, model)` 只取最新一条，`unknown` 保持诚实样本、不硬判成免费。
- **L2 账号层** —— 同一批行交给 `rebuildFromLedger()` 重建冷却/连击/样本，结果**合并进适配器持有的那个注册表对象**，不是造一份新注册表：首屏读到的就是它。
- **上界 = 4 MiB 尾部字节窗 + 5000 行**（`DEFAULT_HYDRATION_BOUNDS`）。理由：最新几行才代表当前结论；两层本来就有样本上限（L1 滑窗 200、L2 按连击封顶），L1 的计费置信度 20 条免费样本即饱和，重放更老的行不会改变任何判决，只会增加启动耗时。字节窗从行中间开始的那半行会被丢掉，行窗超限时只保留最新 `maxLines` 行。**这两个是常量，没有暴露成用户配置**（见 §十一）。
- **只读 + 容错**：只 `open(file, 'r')` —— 不 mkdir、不 append、不改写。文件缺失（首次运行）、目录不存在、半行（进程被杀在 append 中途）、损坏行、非对象行一律不抛错：坏账本绝不能挡住插件激活。被跳过的行数与原因（`malformed` / `no-key` / `newer-live`）都进 info 汇总。
- **不覆盖更新的实时证据**：水合是 `ctx.effect` 里的 fire-and-forget（`apply()` 是同步的，激活不等磁盘），真实请求可能先落地。每行重放前都比对注册表已有记录的时间戳/`updatedAt`，已经有更新证据就跳过（`newer-live`）；时间戳缺失或非法的行按 0 处理，因此必输给任何实时记录。
- **`health=false` 时不水合**：显式关闭（`health:false` / `health.enabled:false` / `ranking.health.enabled:false`）时 `buildHealthDeps()` 返回 `undefined`，水合返回 `{hydrated:false, reason:'health-disabled'}`，**连文件都不打开**，legacy 路径逐字节不变。
- **一行 info 汇总**，可用来核对实际重放了什么（实际是一条单行，下面为便于阅读折了行）：

```
smart health hydrate: cost.jsonl rows=224 replayed(L1)=224 skipped(L1)=0 (malformed=0 no-key=0 newer-live=0)
  L2 accounts=3 (newer-live=0 no-account=0) | probe-cache.jsonl rows=3 replayed=1 skipped=0
  (malformed=0 duplicate=2 newer-live=0) | total skipped rows=0 | truncated lines=0+0 bytes=0+0
  | bounds maxBytes=4194304 maxLines=5000
```

这是本机 2026-11-25 对真实账本的一次只读重放：224 行只落到 **4** 个 `(provider, modelId)` 键 —— 行数不等于路由数，L1 是按元组归集的；`probe-cache.jsonl` 的 3 行里 2 行同键被 `duplicate` 计数、只回灌最新 1 条。

### 关闭方式

`health` 与 `ranking.health` 都是 volatile，设置页改完即时生效，无需重启。任一种写法即关闭，且关闭后代码路径逐字节回到 legacy：

```json
{ "health": false }
{ "health": { "enabled": false } }
{ "ranking": { "health": { "enabled": false } } }
```

`health` 里可调 `accountHealth`（`halfOpenPermits` / `backoffFactor` / `maxCooldownMs` / `defaultCooldownMs`）、`topologyOpts`（`declaredFlag` / `observedAccountIds` / `declaration`）、`virtualProviders`（额外虚拟路由；`smart` 永远在内）、`currentIdList`（判定重命名用）。

### 设置页结构（2.2.0：三个 Tab；2.5.0 视觉精简）

设置页的 Tab 从四个收敛到三个 —— 普通用户 30 秒内只需要「看状态 / 选怎么选 / 看花费」。原「切换链」与「账号池 + 择优」合并进同一个**路由设置**，但两张卡各自保留自己的保存按钮与保存语义（`chains` 与 `accounts`+`ranking` 是两个独立的写操作，不会一次改动牵连另一块）。2.5.0 起三个 Tab 按 Apple HIG 风格精简信息层级：总览 hero 合并配置事实与健康摘要、预设按钮只在总览一处；花费与健康把明细 / 趋势 / 账本收进「详细数据」折叠、明细首屏只看 Top 10，健康两表改为摘要行 + 可展开明细（异常默认展开）；版本号行新增 GitHub star 入口。所有折叠只改变信息层级，字段与读写语义不变。

| Tab | 内容 | 写什么 |
|---|---|---|
| **总览** | 当前链路与模型池状态、账号健康摘要、探测结论、一键策略预设（`balanced` / `cost-first` / `speed-first`）、花费入口 | 预设按钮同时写 `ranking.strategy`、`ranking.routing.strategy`（层一档位读的是后者，只写前者等于「点了一键预设但档位没变」）与该预设权重；首屏常驻，不必先滚到别的卡 |
| **路由设置** | 切换链卡：按模型分组的跳次编辑、保存、**清空自定义链路**（二次确认后写 `chains: {}`，回到默认空 `auto` 链 + 自动发现）<br>账号池与择优卡：账号行（`id` / `provider` / `credentialRef` / `models` / 等级与计费细节）/ 排序策略与权重 / 精选权重 | 两张卡各写各的键；账号卡只有在你真的改过 `ranking` / `routing` 时才写该键，加个账号不会顺手关掉择优 |
| **花费与健康** | 成本概览（总花费 / 笔数 / 免费·付费·失败 / 按 provider）+ 逐笔明细（时间 / 模型 / tokens / **ttft** / **tok/s** / 花费 / 状态）+ 账号健康与冷却面板（见下） | 只读（`@Remote` 真账 + 实时注册表），唯一写操作是手动「重新读取」 |

交互约定（2.2.0 一并落地，都锁在 `client.js` 里、不需要配置）：

- **保存入口常驻卡片头**：不展开任何折叠区也看得见；草稿与打开时快照有差异即显示「未保存」。
- **切 Tab 保护**：路由设置里有未保存草稿时切 Tab 会先确认（「切换（丢弃修改）」/「留在本页」），绝不静默丢改动。
- **删除二次确认**：删链路组 / 跳次 / 账号，第一次点击变成确认按钮，3 秒不确认自动回退。
- **加载 / 空 / 错三态分家**：加载中、真的没有数据、通道出错各有各的文案与颜色，不拿空表冒充「没有数据」。
- **诊断折叠**：`form` / `state` / 错误码这类内部串收进默认折叠的「诊断」，只有失败时默认展开。
- **对话页预估总额 pill（2.4.0，2.4.1 补齐设置入口）**：三个 volatile 配置项 `costPillEnabled`（默认 `false`，只有显式 `true` 才显示）、`costPillPosition`（默认 `conversation.input.right`；可选 `conversation.session.header.utilities` 会话标题栏工具区 / `conversation.input.dock` 输入框上方条目；非法值回落默认）、`costPillRefreshMs`（默认 60000 毫秒，最小 1000 毫秒）。2.4.1 起总览首屏有「对话页消耗显示」卡片，三个字段都有控件且即时写回，不必再手改配置。显示的是 `@Remote` 真账 `statsSince()` 的两位小数美元累计值与当前统计起点；「立即刷新」按钮常驻，定时刷新只在配置了间隔后运行且页面不可见时暂停。详见 §六末「对话页预估总额 pill」。
- **账号字段可编辑且不丢未知字段**：`speedTier` / `priceTier` / `costModel` / `quotaCost` / `priority` 直接在账号行里改（取值来自 `lib/ranking.js` 的 `ACCOUNT_RANKING_FIELDS`，与 Host 同源）；`quotaCost` 只在 `costModel=subscription` 时写入；整行按「展开原对象再覆盖」重建，用户手写的其他键原样保留。
- **`credentialRef` 可输入**（只写引用名，绝不写明文 key；留空表示用 DSH 已登录账号），模型选择器支持关键字搜索 / 只看免费 / 全选。
- **不完整行不再静默丢弃**：账号行缺 `id` 或缺 `provider` 会被标红并拦住整次保存，而不是被 `filter` 掉还提示「已保存」。

### 设置页「账号健康 / 冷却」面板（1.3.0）

这一块此前只有一段占位说明。现在它读的是 Host 的实时注册表，不是估算、也不是缓存镜像：`lib/remote.js` 的 `@Remote` 方法 `smartProvider.accountHealth()` 把 `index.js` 注入的惰性 reader 结果交给纯函数 `lib/health-snapshot.js`（`buildHealthSnapshot()`：无 I/O、不改入参、永不抛错；读路径**不写注册表**，`COOLING` 过期是纯推导成 `HALF_OPEN`，有效冷却取账号记录与适配器两层 `until` 的较大值）。

面板两张表：**账号池状态**（账号 / 路由 / 状态 / 剩余冷却 / 连续失败 / 尝试次数 / 成功·失败样本，链路派生的隐式账号标「自动派生」）与**各模型路由健康**（路由 / 模型 / 健康 / 计费档 / 可信度 / 样本）。状态只有四种读法：

| 显示 | 什么时候 | 颜色 |
|---|---|---|
| 暂无数据 | 没有任何样本，或字段缺失 / 值畸形（`UNKNOWN`）| 中性灰 |
| 健康 | 最近一次真实请求成功（`ACTIVE` / `HEALTHY`）| 绿 |
| 冷却中 | 正在冷却；剩余时间取两层 `until` 的较大值 | 警告色（**不是红**）|
| 半开待验证 | 冷却到期，等一次真实请求证明自己 | 警告色（**不是红**）|

**诚实约定**：零样本一律显示「暂无数据」，绝不显示「不可用」，也绝不因为"没有坏消息"就涂成绿色；未知值一律退中性灰。健康层被关闭时（`health: false` / `health.enabled: false` / `ranking.health.enabled: false`）面板直接说「健康层当前是关闭的」，不假装正常、不拿空表冒充健康；通道本身不可用时显示诊断行，把失败原因摊开而不是静默留白。刷新方式是**快照时间 + 手动「重新读取」按钮**，刻意不用 `setInterval` 倒计时 —— 定时器在设置页反复挂载/卸载时会泄漏。

### 对话页预估总额 pill（2.4.0，2.4.1 补齐设置入口）

设置页（`costPillEnabled` 等字段）配置的是对话页的累计估算成本显示，默认关闭：只有显式 `"costPillEnabled": true` 才挂载，读的是 `@Remote` 的 `smartProvider.statsSince()` 真账汇总（`cost.jsonl`，按统计起点过滤），显示两位小数美元金额与当前起点；读取失败显示错误行，不拿估算占位冒充真账。2.4.1 起总览首屏直接提供「对话页消耗显示」卡片（开关 / 位置 / 刷新间隔三个控件），保存即生效、无需重启。

| 配置字段 | 默认值 | 取值 / 说明 |
|---|---|---|
| `costPillEnabled` | `false` | 显式 `true` 才显示；volatile，即时生效 |
| `costPillPosition` | `conversation.input.right` | 挂载点三档：`conversation.input.right`（输入框右侧紧凑位）、`conversation.session.header.utilities`（会话标题栏工具区）、`conversation.input.dock`（输入框上方条目）；非法值回落默认档 |
| `costPillRefreshMs` | `60000` | 定时刷新间隔，最小 1000 毫秒；**定时监控默认关**（初装不轮询），手动「立即刷新」按钮常驻；页面不可见时暂停并中止在途请求，回到前台再续 |

**「从现在重新统计」的清理语义**：先二次确认（「只设置新统计起点，不删除成本账本。确定继续？」），确认后 `smartProvider.clearStats()` 只在 `cost.jsonl` 旁的 `stats-state.json` 写入新的 `since` / `clearedAt`，**账本文件逐字节不变**，健康证据也不受影响；pill 与「花费与健康」页的累计数从新起点重新计数，历史行仍在磁盘上。它不删除、不回滚任何账本数据。

## 七、两层智能路由 routing（P2，默认启用 + 中立等权）

### 配置方式

routing 配置嵌在 `ranking` 对象下（`schema.js` 的 `routing` 字段声明为 volatile，配置页可改、无需重启）。默认启用、中立等权：完全没有用户 `ranking` 配置时由 `index.js` 注入 `DEFAULT_RANKING_CONFIG.routing`（`enabled:true` / `balanced` / 四因子 .25）；用户显式写了 `ranking.routing` 时以其为准，`null` 或 `enabled !== true` 时该代码路径完全不运行、逐字节回 legacy。字段格式：

```json
{
  "ranking": {
    "enabled": false,
    "strategy": "balanced",
    "routing": {
      "enabled": true,
      "strategy": "balanced",
      "tierPolicy": "auto",
      "weights": { "cost": 0.25, "speed": 0.25, "tier": 0.25, "load": 0.25 },
      "positionOverrides": { "vendor/model": { "tags": ["reasoning", "longctx"] } },
      "tierLimit": 2,
      "longContextTokens": 200000,
      "dynamicAuto": []
    }
  }
}
```

- `enabled` —— 必须为 `true` 才激活；否则逐字节走 legacy。
- `strategy` —— 8 种预设之一：`balanced` / `cost-first` / `speed-first` / `reasoning-first` / `longctx-first` / `vision-first` / `legacy` / `custom`；`balanced` 是中立默认，省钱（cost-first）是显式选择。
- `tierPolicy` —— 层一强制层（`auto` 不强制；`reasoning-first` / `longctx-first` / `vision-first` 会强制优先选对应位置）。
- `weights` —— 层二账号评分权重，自定义时归一化；routing 启用时会覆盖 ranking 的权重。
- `positionOverrides` —— 手动指定某模型的位置标签（键用 `provider/model` 或 `model`）。**两种形态都受支持**：上面示例的对象形态 `{ "vendor/model": { "tags": ["reasoning"] } }`（**主推**，与 `registry/position-overrides.user.yaml` 里的 `overrides` 完全同形，方便同一份东西在文件与 cordis 配置之间搬），以及数组形态 `{ "vendor/model": ["reasoning"] }`。两种形态都先做小写 / 去空格 / 白名单过滤，再与 catalog 自动推导出的能力标签**保守合并**（合并，不是替换）。**可感知的行为变化**：1.2.0 之前实现只读 `.tags`，于是 README 自己写的数组形态是**静默无效**的 —— 你照文档配了 `positionOverrides`，`selectTiers` 依旧报 `no tier matches ... relaxing`，且没有任何提示；现在数组形态同样生效，两种写法等价。
- `tierLimit` —— 最多选几个候选层（默认 2）。**语义**：非有限值（`NaN`）、`-1`、`0` 一律回落到默认 2（以前 `-1` 会静默少一层、`0` 会匹配上了也一层都不选，直接和「层一永不阻断请求」的契约打架）；小数向下取整（`2.9 → 2`）；`1` / `2` 正常切片。
- `longContextTokens` —— 长上下文判定阈值（默认 200000；tokens 用 chars/4 估算，仅用于选路、不用于计费）。
- `dynamicAuto` —— 动态 auto 链；只在用户没有配置该 outer model 与 `*` 时生效，显式配置始终优先（向后兼容）。

### 位置标签：自动推导 vs 手填

`derivePosition()` 从模型 catalog 元数据自动推导：

- `reasoning === true` → `reasoning`
- `contextWindow >= 200000` → `longctx`
- `input` 含 `image` → `vision`
- `tool !== false` → `tool`（聊天模型默认具备，保守策略避免误杀）
- 所有模型都带 `general`

自动结果总是保守、不会因缺元数据而失败。手填（`positionOverrides`，对象形态 `{tags:[...]}` 与数组形态 `[...]` 都收，见上）走的是**合并**而不是替换：手填标签经小写/去空格/白名单过滤后并入 catalog 自动推导出的能力标签，来源标记为 `auto` / `user` / `mixed`。合并是有意的——早期版本用替换，结果给一个免费模型打上 `thrifty` 就把它的 `vision` 冲掉了，能力过滤静默失效。

`thrifty` 与 `swift` **永远无法自动推导**：它们描述的是「便宜」和「快」，catalog 里没有这两个字段，只能靠 `positionOverrides` 手填（`registry/position-overrides.user.yaml` 就是为此存在的）。手填适合 catalog 元数据缺失或不准确时纠正位置。

### relax 诊断 —— 从「一句话」到「照做就行」（1.2.0）

层一没有候选匹配时不阻断请求：所有可用路由原样放行（relax）。这条规则没变，变的是**告警内容**。以前只报任务类型（`smart routing: no tier matches task "reasoning"; relaxing to all available routes`），你自己得去猜为什么、该改哪里；现在首行**字面保持不变**（`grep 'relaxing to all available routes'` 的老做法继续有效，诊断是紧跟其后的续行），续行把整件事说清楚。

本机直接调用 `selectTiers()` 的实测输出（两个假想路由都不带 `reasoning`）：

```
smart routing: no tier matches task "reasoning"; relaxing to all available routes
  task: kind="reasoning" signals=[hard-tokens]
  needed position tag(s): "reasoning" — no candidate route carries "reasoning"
  candidate routes (2) and the position tags they do carry:
    - vendor/cheap-flash: tool, general
    - vendor/big-flash: tool, general, longctx
  why "reasoning" is missing everywhere: auto-derived only when the model catalog reports reasoning:true
  fix — declare the tag for a model you actually have (both shapes below work, copy either one):
    "ranking": {"routing":{"positionOverrides":{"vendor/cheap-flash/<model-id>":["reasoning"]}}}
    registry form: {"overrides":{"vendor/cheap-flash/<model-id>":{"tags":["reasoning"]}}}
    key = "vendor/cheap-flash/<model-id>" (replace <model-id> with a model served by route "vendor/cheap-flash"); a bare model id also works
  note: tierPolicy only reorders which tier is tried first; it cannot invent a tag that no route carries
  relax outcome: all 2 route(s) stay available; the request is NOT blocked
```

诊断固定给出五件事：缺的是哪个位置标签；每个候选路由**实际**带哪些标签（超过 8 个路由会截断并注明「还有 N 个」，不刷屏）；这个标签为什么自动推导不出来（每种标签一条原因，例如 `longctx` 只在 `contextWindow >= longContextTokens` 时自动出现，调大阈值会让更多请求掉进这个坑）；**可复制**的修法（cordis 配置形态与 registry 形态各一份，键用候选里第一个真实路由）；以及 `tierPolicy` 只能改「先试哪层」、**不能凭空造出没有路由携带的标签**这条边界。最后一句明确 `NOT blocked`。空路由列表也留一行可行动告警，不再静默返回 `[]`。

### 向后兼容

P2 的全部逻辑前置于 `if (this.routing)`，未启用时 `classifyTask` / `derivePosition` / `selectTiers` / `resolveRoutingPolicy` 一个都不会运行；`resolveChain` 的 `dynamicAuto` 也只在没有显式链时介入。**未配置 routing 时行为逐字节等于现状**；配置错误只会 WARN 并回退 legacy，不会崩溃。

---

## 八、成本统计设计

DSH 自身没有货币级计量（`dsh-token-meter` 明确说 “not a billing record”），因此本包自行计量：

1. **token 来源** —— 适配器在终止 `finish` 块之前捕获 `{type:'usage'}` 块（携带 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`）。正常、出错、中止的流都会保留 usage，因此 token 计数可靠。
2. **价格来源** —— 定价是用户数据，不随包分发真实单价。默认加载的是 `lib/pricing.json`（产品默认表，只含由 `scripts/gen-custom-routes.mjs` 从本地注册表生成的零价免费档声明，当前 4 行）；真实单价通过 `DSH_SMART_PRICING_FILE` 环境变量或 `registry/pricing.user.json` 导入（解析顺序：环境变量 → `registry/pricing.user.json` → 产品默认表）。两者都缺时，无表可查的模型返回 tier 粗估（`known:false` / `estimated:true`，金额恒为 0），绝不用任何账号的历史价格冒充单价。作者当时的 151 行真实价格导出降级为 `lib/pricing.example.json`，仅作导入格式示例，**不在默认加载路径**。记录的是公开标价/token，**不是账单** —— 未建模订阅与折扣；缺字段按降级表回退。
3. **JSONL 行** —— 每个完成的 hop 追加一行到 `~/.dsh/smart-provider/cost.jsonl`，字段包括：`timestamp`、`outer_model`、`actual_provider`、`actual_model`、`input_tokens`、`output_tokens`、`estimated_cost_usd`、`hop_index`、`failure_code`，以及 `account_id`（服务该尝试的池账号；未配置池时为 `hop:provider/model`）和诊断字段：`cache_read_tokens`、`cache_write_tokens`、`usage_complete`、`price_known`、`request_id`、`seq`。
   **延迟度量字段（缺数据时整段不写，不留 0 或 null）**：`started_at` / `first_token_at` / `finished_at`（ISO 时间戳）、`ttft_ms`（首 token 延迟 = first_token_at − started_at，两端点齐备且有序才写）、`duration_ms`（本次尝试总耗时）、`tokens_per_second`（输出 token 数 ÷ 全时长；DSH 的 usage 块只有 token 计数、没有逐 token 时间线，因此刻意用全时长而非 first_token_at 之后的时间窗，不做无依据的细化）。`lib/cost-stats.js` 对含这些键的行原样聚合，对不含的旧行行为不变。
   `usage_complete=false` 表示没有上报 usage 块（不是“零 token”）。
4. **非阻塞写入** —— 入队只是内存 push；后台 flusher 按批（默认 16 条或 2 秒）执行一次 `fs.appendFile`。不等待流。磁盘错误转给 `ctx.logger.warn`，绝不传播进 LLM 流。
5. **「花费与健康」Tab 真账** —— `lib/cost-stats.js` 读真实 `cost.jsonl` 并聚合（总花费 / 免费笔数 / 付费笔数 / 失败笔数 / 按 provider 拆分），经 `lib/remote.js` 的 `@Remote` 服务 `smartProvider.cost()`（概览）与 `smartProvider.costDetail()`（逐笔明细 + 按模型汇总 + 节省估算）提供给设置页，不依赖估算占位。明细列为 时间 / 模型 / tokens / **ttft** / **tok/s** / 花费 / 状态，缺值显示 `—` 而不是 0；明细的 strict codec 覆盖全部 6 个延迟字段（`started_at` / `first_token_at` / `finished_at` / `ttft_ms` / `duration_ms` / `tokens_per_second`），否则它们会在过线时被静默剥掉。降级路径（`costDetail` 抛错时）返回冻结的 `EMPTY_COST_DETAIL`，形状与 strict schema 逐字段一致 —— 面板不会因此永久停在加载态。**成本趋势按本地自然日分桶**（`localDayOf()`，逐时刻取时区偏移，DST 行不错位），不按 UTC 切日；老账本不迁移，读时按当前时区重新分桶。
6. **查询脚本** —— 命令行回答花费 / 占比 / 失败率 / 延迟问题（1.2.0 起报表追加两段，见下）：

```bash
# 按实际模型汇总（含花费占比列）
node scripts/query-cost.mjs

# 单个模型：美元花费及占全部记录花费的比例
node scripts/query-cost.mjs --model kimi-k3

# 按外层模型 / provider / 账号 / 时间过滤
node scripts/query-cost.mjs --outer auto
node scripts/query-cost.mjs --provider opencode-go
node scripts/query-cost.mjs --account acctA
node scripts/query-cost.mjs --by-account          # 按 account_id 汇总花费
node scripts/query-cost.mjs --since 2026-11-23
```

**报表结构（1.2.0 起）**：前两段（花费汇总 + 分组花费表）**逐字节不变**，老用法不受影响；其后追加两段：

- **failure rate（按分组）** —— 该组 `failed / calls`。只有真的写了 `failure_code` 的行算失败；`failure_code` 缺失、`null` 或空串算成功（不会把「没记失败码」误读成失败）。
- **latency（按分组）** —— `ttft ms` 均值、`p50 ms`、`ttft n` 样本数、`tok/s` 均值、`tps n` 样本数。
  - **缺延迟键的老行不计入延迟统计**，绝不当成 0ms —— 一个 0 会把均值静默拉低，报出一个从未观测到的「变快」。`ttft_ms` 真的等于 0 是合法样本，「没有这个键」是另一件事，两者不能混。
  - `p50` 用 **nearest-rank**，不做插值：偶数样本的插值中位数是任何一次请求都没产生过的数字，这份报表只印实测值。
  - 样本 <3 时在 `ttft n` 后打 `*`（一两行的均值不是趋势）；某组某个指标没样本打 `-`；整次选择都没有延迟样本时打一行诚实的空态文案，而不是一片 0。
  - 垃圾值（`"abc"`、`NaN`、`Infinity`、负数 ttft、0 tok/s）进不了统计，报表里永远不会出现 `NaN` / `Infinity`。

本机实测（2026-11-25，真实账本 221 条，`node scripts/query-cost.mjs`，退出码 0）节选：

```
failure rate (per route):
  route                                           calls  failed   fail%
  workbuddy/deepseek-v4-pro                           3       0    0.0%
  workbuddy/deepseek-v4-flash                         2       0    0.0%
  deepseek-account/deepseek-flash                   216       0    0.0%

latency (per route):
  route                                           ttft ms  p50 ms  ttft n    tok/s  tps n
  workbuddy/deepseek-v4-pro                             -       -       0        -      0
  workbuddy/deepseek-v4-flash                           -       -       0        -      0
  deepseek-account/deepseek-flash                     415     318     182    153.8    182
  '-' = no sample for that metric (rows without the key are skipped, not counted as 0)
```

前两条 route 的 `-` 正是「1.1.0 之前写下的老行没有延迟键」：它们照常计入 `calls` / `failed`，但不贡献任何延迟样本。

---

## 九、配置说明

默认链在 `lib/chains.js`，内置表刻意为空；未配置时由 `discoverAutoChain()` 从实时 DSH 注册表生成中立 `auto` 链。插件配置的 `chains` / `accounts` / `ranking.routing` 都是 volatile（配置页改完即时生效，无需重启）。

自建路由（如 `x-opencode-free`）只在 `registry/custom-routes.user.yaml` 声明（唯一人工编辑点），改完跑 `node scripts/validate-custom-routes.mjs` 与 `node scripts/gen-custom-routes.mjs --write`；`credentialRef` 只放凭据引用名，绝不放明文 key。

**导入真实价格表**：定价是用户数据，插件不随包分发真实单价。把你的价格表写成一个 JSON 文件（格式参照 `lib/pricing.example.json`），然后二选一：设 `DSH_SMART_PRICING_FILE` 环境变量指向该文件，或放到 `registry/pricing.user.json`（随包一起被读取）。解析顺序：`DSH_SMART_PRICING_FILE` → `registry/pricing.user.json` → 产品默认表 `lib/pricing.json`（仅零价免费档声明）。都没有匹配行时，该模型返回 tier 粗估（`known:false` / `estimated:true`，金额恒 0），不会静默用错价。

要新增同厂商的第二个账号，在 `llm-pi-ai.providers` 里用独立的 `apiKeyEnv` 注册第二条路由（例如 `opencode-go-alt`）。然后要么加一条指向它的 hop（旧的扁平写法），要么——推荐——在 `accounts` 池数组里同时声明两条路由，使账号级冷却生效。两种方式都不需要改 DSH 生产代码。

**切勿**在 `llm-pi-ai.providers` 里添加 `smart:` 块 —— 该路由由 `registerAdapter` 注册，两边都做会触发 `DUPLICATE_ADAPTER`。

### 安装

DSH 的安装单位是「组合包」：profile 的 `dependencies` 里要有这个包，`dsh.profile.bundles` 里要选中它，它的 `cordis.patch.yml` 才会进入 patch 链。官方 `installBundle` 这三件事一起做，不需要手改：

- 图形界面：插件 → 添加插件 → 选择本目录；
- `dsh plugin --profile <profile> add link:<本包绝对目录>`（headless/CLI 环境同样可用，等价于 `plugin-cli.js <profile> add ...`）；
- 插件管理服务 / `plugin_manager` 工具的 `install_bundle`。

本地目录安装保存为 `link:` 依赖，源码改动直接生效、不必重装。装好且激活后，host 日志应出现：

```
dsh-smart-provider: declared smart configurable provider (Smart Gateway)
dsh-smart-provider: registered smart adapter with N chain keys
dsh-smart-provider: discovered N neutral auto hop(s) from live registry
```

按卸载：`dsh plugin --profile <profile> remove @local/dsh-smart-provider`。

### 运行时依赖契约

- **只硬依赖 `llm` 服务。** `sessions` / `commands` / `credentials` 一律通过 `ctx.get()` 按需读取，缺失时对应功能降级（无 hop 记录 / 无只读命令 / 凭据名为空），**不会导致插件加载失败**。
- 用到的 DSH 包（`dsh-llm` / `dsh-session` / `dsh-typert-protocol` / `schemastery`）在 `peerDependencies` 里声明；DSH 兼容门禁对当前运行时（`0.2.2-rc.5`）判定为满足。
- 这些包一律通过 `lib/dsh.js` 的 manifest 锚点解析（profile → Electron resources → 各平台安装根），**不依赖「当前 profile 恰好装了它」**，所以 `link:` 进任意 profile（包括最小 headless）都能加载。

---

## 十、构建时已执行的验证

以下命令均在本包目录执行。DSH 运行时探针使用 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE"` —— 必须用 Electron 的 Node，因为 `@deepseek-ai/dsh-llm` 在 `app.asar` 内部，普通 Node 读不了 asar。

### 测试门禁：自动发现 + 发现守卫（1.2.0 的根治项）

`scripts/run-tests.mjs` 不再维护硬编码清单，全量模式**扫 `test/*.test.mjs` 并全部执行**：**新增测试文件不需要注册**，放进 `test/` 且以 `.test.mjs` 结尾就会跑。

光有自动发现还不够：文件名拼错、扩展名写错、把一个 helper 停在 `test/` 里，都会变成「文件在磁盘上、却永远不执行」的假绿（连续三个 task 都踩过同一个坑：新测试躺在盘上而没人把它加进数组，门禁照样全绿）。所以门禁带**发现守卫**：`test/` 下只要有未被执行的 `.mjs` 文件，就非 0 退出并逐个点名，提示改成 `<name>.test.mjs` 或移出 `test/`。守卫在两种模式下都**先跑**（`--unit` 也一样），所以漏跑在最快的门禁上就会暴露；反向也兜住：`test/` 下一个 `*.test.mjs` 都没有时同样非 0 退出（否则「跑了 0 个测试」也会显示成功）。

本机实测（2026-11-25）：临时放一个 `test/_guard_probe.tmp.mjs` 后跑 `npm run test:unit`，**EXIT=1**，stderr 为

```
FAIL: 1 file(s) under test/ are never executed by the full gate:
  test/_guard_probe.tmp.mjs
Rename it to <name>.test.mjs (or move it out of test/) so it actually runs.
```

`--unit` 是一个**纯逻辑白名单**（当前 17 个测试文件：`health` / `ranking` / `pricing` / `query-cost` / `routing-tier` / `persistence` / `hydration-billing` / `health-snapshot` / `remote-surface` / `probe` / `health-taxonomy` / `cooldown-consistency` / `note-failure-override` / `config` / `free-policy` / `free-ui-chain` / `stats-host`），其余需要 DSH runtime 的测试文件会被明确打印成「不在 --unit 覆盖内」，不会被静默跳过；白名单里写了但文件不存在的条目会打 WARN —— 否则子集悄悄缩小又是一次假绿。

```bash
# 1) 一条命令跑完整验证门槛（语法检查 + 全部自动发现的测试，自动选运行时）
npm test
# => 发现 24 个测试文件；语法检查逐文件 ok；tests 318 / pass 318 / fail 0（2026-11-26 实测，退出码 0）

# 2) 只跑纯逻辑子集（15 个测试文件，任何 Node 都行，无需 DSH；会打印未覆盖的文件）
npm run test:unit
# => 17 个测试文件，tests 260 / pass 260 / fail 0（2026-11-26 实测，退出码 0）

# 3) 不带 npm 时等价写法（全量就是发现出来的那批文件）
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.mjs

# 4) JSON 完整性（默认表当前 4 行零价声明；示例导出 151 行）
node -e 'const p=require("./lib/pricing.json"); if(p._rows!==p.entries.length)throw Error("mismatch")'
# 退出码：0

# 5) 真实 DSH 运行时冒烟（P0-1/P0-2/P0-3、回退、成本、会话记录）
#    退出码：0 —— 完整冒烟 PASS
```

**2.4.0 的两套门禁口径（2026-11-26 实测）**：

```bash
# 纯逻辑子集：任何 Node 都行，不需要 DSH runtime
env -u DSH_NODE_EXECUTABLE node scripts/run-tests.mjs --unit
# => 17 个测试文件 / tests 260 / pass 260 / fail 0，退出码 0
#    （补 CHANGELOG 标题前为 259/1，唯一 fail 是 FX3-5 版本号一致性）

# 全量：必须用 Electron 的 Node（@deepseek-ai/* 在 app.asar 内部）
DSH_NODE_EXECUTABLE="/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT" node scripts/run-tests.mjs
# => 24 个测试文件 / tests 318 / pass 318 / fail 0，退出码 0
#    （补 CHANGELOG 标题前为 317/1，同一条 FX3-5）
```

FX3-5 是 `test/free-ui-chain.test.mjs` 的三处版本一致性门禁（package.json / `client.js` 的 `PLUGIN_VERSION` / CHANGELOG 标题），不是功能回归；收口文档落盘前红、落盘后绿，两轮均已实测。相对 2.3.x，本次新增注册了 `free-ui-chain` 与 `stats-host` 两套纯逻辑测试，另有 `free-signal-tuple` / `free-exact-price` 等套件随全量发现执行；准确清单以运行时输出为准。

此前两套门禁并发跑会出现偶发假红：`--unit` 里的探针 TTL 用例用 5ms TTL 卡「刚写完还算新鲜」的边界，与 `appendFile` 的落盘排队竞速（verifier 复现 25 次跑 2 次红）。该用例已改为**注入时钟**推进 —— TTL 判定是纯 `probedAt + ttl > Date.now()` 比较，用例内把 `Date.now` 换成可控值并在 `finally` 还原，过期靠推进时钟而不是睡眠，语义不变、不再依赖真实时序。并发跑也不会再假红；仍建议串行，便于读数对账。

运行时冒烟验证了：`LlmRuntime.prototype.resolveModel` 不存在而 `resolveModelInfo` 存在（task-25 的 bug）；零重试策略；`listModels` 中的 `smart/auto`；仅在建立前回退（AUTH 切跳、发出内容后的错误不切、ABORTED 永不切）；带 `usage_complete` 的 JSONL 行写入；真实会话中出现的 `plugin:dsh-smart-provider/hop-selected` 记录；以及该记录在会话恢复时被保留。

加载路径的 4 条断言（`test/loading.test.mjs`，需 Electron runtime）锁住两个真实缺陷：`inject` 只能有 `llm`（否则最小 profile 会卡在 `waiting for service`），以及 `lib/remote.js` 能在「profile 没有该包」时经锚点回退拿到 Typert 基类。

真实端到端（本机实测，2026-11-25）：用一个最小 headless profile（`@deepseek-ai/dsh-base` + `dsh-headless` + 本包 + 一条真实 provider 连接器）把默认模型指向 `smart/auto`，执行 `dsh --profile headless --patch <overlay> "<prompt>"`。两次提问都拿到真实回答；`~/.dsh/smart-provider/cost.jsonl` 记下 5 行，`outer_model=auto`，实际路由为 `workbuddy/deepseek-v4-flash` 与 `workbuddy/deepseek-v4-pro`（链在两条真实跳次之间选择），最后一笔 `input=349 / output=11 / price_known=true / usage_complete=true / estimated_cost_usd=0.00096` —— 选路、真实调用、usage 捕获与计价全链路跑通。

复现这个端到端（不需要碰 desktop profile）：

```bash
NODE="$DSH_NODE_EXECUTABLE"                        # Electron 二进制
ASAR="/Applications/DSH NEXT.app/Contents/Resources/app.asar"
# 1) 建最小 headless profile，装本包 + 一条真实 provider 连接器
ELECTRON_RUN_AS_NODE=1 "$NODE" "$ASAR/lib/plugin-cli.js" headless add "link:$PWD"
ELECTRON_RUN_AS_NODE=1 "$NODE" "$ASAR/lib/plugin-cli.js" headless add <provider 连接器包@版本>
# 2) overlay 把默认模型指到 smart/auto
printf '%s\n' '- id: agent-default-model' '  name: "@deepseek-ai/dsh-agent-default-model"' \
  '  config: { provider: smart, model: auto }' > /tmp/smart-override.yml
# 3) 一次性提问，答案经 smart 的链路由返回
ELECTRON_RUN_AS_NODE=1 "$NODE" "$ASAR/lib/desktop-cli.js" --profile headless \
  --patch /tmp/smart-override.yml "只回复 OK"
```

健康层的 55 条断言全部是纯逻辑回归（`test/health.test.mjs`），覆盖：故障分类的 P0/P2 不连累模型、5xx 与 404 的三次阈值、计费证据等级与重命名清零、账号冷却退避与封顶、冷却到期只变半开、半开只发一个许可、自带池路由不被冷却、拓扑无名字白名单、默认开启与四种 opt-out 写法、探测的 1 token 与 TTL 缓存命中。其中探测用例把缓存重定向到临时目录，不写用户家目录。

1.2.0 新增的三个纯逻辑 suite（条数均为本机实测：`node --test <file>` 逐文件跑出来的）：

- `test/persistence.test.mjs` **19 条** —— 冷启动水合：L1/L2/probe 三层分别重放、按 `(provider,modelId)` 归集、缺失文件与目录、损坏行 / 半行 / 尾部截断、行窗与字节窗上界（含边界对齐、过紧窗口返回 0 行）、默认上界就是 4 MiB / 5000 行、四种 opt-out 形态都不水合且不读文件、重放不覆盖更新的实时证据（时间戳为 0 的行必输）、以及「只读：不创建也不修改任何文件」。
- `test/routing-tier.test.mjs` **14 条** —— 层一选择与 relax 诊断：标签匹配与静默、relax 时点名缺失标签 / 候选实际标签 / 可复制修法、结构化证据 `explainTierMiss()`、候选列表截断、空路由列表仍有可行动告警、**positionOverrides 数组形态生效**、两种形态都接受且与 catalog 标签合并、`tierLimit` 的 `-1/0/NaN`/小数/1/2 语义、诊断是只读的且永不抛错。
- `test/query-cost.test.mjs` **11 条** —— 报表：混合账本里旧行被排除在延迟统计之外（不当 0ms）、全旧账本的空态文案、只有吞吐没有 ttft、空账本、垃圾延迟值不产生 NaN/Infinity、`ttft_ms=0` 是真实样本、`p50` 在 n=1..4 用 nearest-rank、失败率只认真实失败码、老 CLI 表面（花费列 / `--model` 脚注 / `--by-account` / `--since`）未变、缺账本路径是诚实空态、`--help` 记录了两段追加与排除规则。

注意：schemastery 的 schema 是可调用的（`Config({})`），不是 zod 风格（`Config.parse()`）；在加载器之外，volatile 字段返回的是标记对象，`apply()` 会做防御性强制转换。

## 十一、尚未验证 / 注意事项

- **水合上界是常量，不可配（1.2.0 的已知限制）**：`DEFAULT_HYDRATION_BOUNDS`（4 MiB 尾部字节窗 / 5000 行）没有暴露成用户配置。设计判断是「最新几千行足够决定所有判决」（L1 滑窗 200、L2 按连击封顶、计费置信度 20 条饱和），但这仍是一条硬编码假设：账本极端大、或某天真需要回放更老的证据时，改不了，只能等后续版本。
- **relax 诊断每次都完整打印**：诊断本身很有用，但 relax 是每次请求都会走的热路径 —— 如果一段时间里每个请求都 relax，同一份诊断会被反复刷进日志。按配置/按标签集合做 warn-once 去重还没做（已立 backlog 卡 task-11）。
- 成本估算是离线标价，未与 provider 真实账单对账；订阅与折扣未建模。
- 健康层的判定逻辑有完整单元回归，但**尚未与真实多账号故障场景对账**：半开恢复、连击退避、拓扑自动升级的收益数字依赖用户自己的资源和流量，本文档不承诺具体收益。真实效果的观察口径是 `cost.jsonl` 里的 `failure_code` 分布与 `smart-health` 命令输出的账号状态。
- P2 两层路由默认启用、中立等权；8 预设在真实多账号场景下的效果，依赖用户自己的配置与资源，本文档不承诺具体收益数字；可显式 `enabled=false` 关闭。
- 自动测速已落地：`cost.jsonl` 每行带 `started_at` / `first_token_at` / `ttft_ms` / `duration_ms` / `tokens_per_second`（缺数据不写字段），ranking 的速度因子按「实测优先 → `speedTier` → 中性回退」取值。仍缺的是真实多账号场景下实测证据对选路效果的量化收益——那依赖用户自己的流量，本文档不承诺数字。
- HMR 的监听列表可能为空（日志 `watching []`）：此时**源码改动不会自动重载**，需要触发一次 profile 重组合（改配置 / 重装）或重启，宿主才会跑新代码。安装新组合包本身会立即触发重组合，不需要重启。
- 最小 profile 里没有 `sessions` 服务，因此没有 `hop-selected` 会话记录；该记录依赖 `sessions`，属可选降级（账本中的 `account_id` 仍然完整）。
- 配置页显示的 provider / model 数量随用户 DSH 实时注册表变化，文档不写死。
- **对话页 pill 默认不显示（2.4.0；2.4.1 起设置页首屏可开关）**：`costPillEnabled` 默认 `false`，定时监控默认关；只有显式开启并配置 `costPillRefreshMs` 才轮询。它显示的是按统计起点过滤的**估算**累计成本（公开标价口径，不是 provider 真实账单），金额两位小数；默认挂载点是 `conversation.input.right`，其它挂载点依赖宿主提供的对话页插槽，插槽不可用时不要假设 pill 一定出现。
- **自动探测复选框与执行口径（2.4.1）**：未配置 `probeEnabled` 时显示勾选且确实执行自动探测，只有显式保存 `false` 才关闭；不再出现「界面显示关、后台却探测」的分叉。
- **「从现在重新统计」不是清账（2.4.0）**：`clearStats()` 只写 `stats-state.json` 的统计起点，`cost.jsonl` 与既有健康证据都不动；历史花费仍在磁盘上，只是不再计入显示金额。不要把它当作隐私清除或账单删除功能。
- **免费标签的「已确认免费」现在带来源后缀（2.4.0）**：价格表声明显示 `已确认免费·价格表`，探测显示 `已确认免费·探测`，账本显示 `已确认免费·账单`；弱信号仍是「可能免费（未实测）」。免费标签按 `(provider, modelId)` 元组取证据，不再让同名模型跨 provider 串标；probe 多为 `unknown` 的根因仍未定论。
- **`yaml` 依赖的探测链（无写死家目录）**：`registry/registry-lib.mjs` 只在 DSH profile 里找 `yaml`，按 `DSH_HOME` → `HOME` → `os.homedir()` 的优先级组候选锚点（三者都指向**当前用户**，重复项去重后逐个尝试）。全部失败时抛错并列出试过的每个锚点，提示用 `DSH_HOME` 指安装根；**不再**回退到任何写死的他人家目录。该文件没有独立测试文件，因此这条改动靠全量门禁的语法检查 + 本机三种环境（普通 `HOME`、`env -u HOME -u DSH_HOME`、显式 `DSH_HOME`）的加载冒烟来守。
- **仓库目录移动后插件不加载（link 指向旧路径）**：profile 里用 `link:` 装本包时记录的是安装当时的绝对路径，仓库被移动 / 改名 / 重新克隆后这条 link 仍指向旧目录 —— 表现为设置页分区消失、插件状态不是 ACTIVE、日志里找不到 `plugin:dsh-smart-provider` 而是加载失败。修法：在 profile 上重新 link 到新路径（`dsh plugin --profile <p> add link:<新路径>`，或编辑 profile 清单里那条 link 指向），然后**重启 App**（或触发一次 profile 重组合）让宿主重新解析。注意 HMR 也救不了这种情况：监听的是旧路径。

---

## English summary (secondary)

`smart` is a DSH meta-provider that fails over across your already-configured provider routes with an offline cost meter. It is a **general intelligent router** (goals: cost / speed / capability / composite), neutral by default in code — saving-first is an opt-in user config. It is **installed and enabled** as the default model. Verified capabilities include: `smart/auto` in real sessions, the `x-opencode-free` free first hop (cost=0, 213+ real ledger rows) with 402→paid fallback, a three-tab settings page (overview / routing / cost & health) with real pi-ai resources, visible save buttons with an unsaved-changes marker, a switch-tab guard, two-step deletes, honest loading/empty/error states, collapsed diagnostics, and an `@Remote` real-ledger cost tab whose detail table carries ttft and tok/s columns and whose degraded payload matches the strict codec field-for-field, P1 resource adaptation (dynamic neutral chains, neutral .25 default, backward-compatible migration), P2 default-on, neutral-equal-weight two-layer routing (explicit `ranking.routing.enabled=false` returns byte-for-byte legacy, 8 presets; tier selection explains every relax with the missing tag, each candidate's real tags, a copy-pasteable positionOverrides snippet in either documented shape, and never blocks the request), and cold-start health hydration that replays cost.jsonl / probe-cache.jsonl into the same L1/L2 registries (read-only, bounded to a 4 MiB / 5000-line tail window, tolerant of missing, corrupt and half-written rows, never overwriting newer live evidence, and now distinguishing declared zero prices from the no-price-table placeholder so an estimated 0 never turns into a free claim), so a reload no longer erases proven health. The test gate auto-discovers every test/*.test.mjs (no registration) and fails when a file under test/ would never run (318 full-suite / 260 pure-logic assertions across 24 / 17 suites, measured 2026-11-26, exit 0; 1 expected FX3-5 version-consistency failure in each before the CHANGELOG heading landed, green after the doc fix), and a settings-page "account health / cooldown" panel that renders the live runtime registry over `@Remote` `smartProvider.accountHealth()` (zero samples read "no data yet" in a neutral colour — never "unavailable", never a fabricated green; a disabled health layer says so instead of pretending; cooling and degraded states use the warning colour, never red; refresh is a snapshot timestamp plus a manual button, deliberately not a setInterval). Account-level ranking also defines `costModel` (`metered` / `subscription` / `free`, default `metered`; subscription uses quota cost instead of price) and `quotaCost` (a number in 0–1, shown only when `costModel` is `subscription`). See `docs/DETAIL.md` for the plugin detail page and the design docs under `docs/` for the full design rationale.

---

## 支持本项目

如果这个插件帮你省了心、省了钱，或者单纯觉得它做得还行，欢迎给仓库点个 star ⭐ —— 2.5.0 起设置页总览的版本号行也直接提供了 GitHub star 链接，点一下就能直达仓库；你的一个星是对我们最大的鼓励，也让更多人能发现它。感谢！
