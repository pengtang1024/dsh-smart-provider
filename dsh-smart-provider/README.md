# dsh-smart-provider（DSH 智能模型路由）

`smart` 是一个 DSH 元提供商：它本身不调用任何大模型 API，而是在你**已配置的供应商路由**之间按序故障转移，并提供离线成本统计。它是**通用智能路由**，不是某一个账号的「省钱脚本」——四个目标是省钱 / 高性能 / 高能力 / 复合（智能），由每个用户按自己的需要选；**代码默认是中立的**（均衡权重 .25，不偏向任何单一目标），「省钱优先」是用户自己的 config 值（`cost-first` 策略），不是出厂默认。

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
- **配置页真读写。** 设置页展示来自 pi-ai 的真实资源（当前约 49 provider / 58 model，数量随你的 DSH 实时注册表变化）、真实凭据名与账号健康，并可写回插件配置；成本/健康 Tab 走 `@Remote` 真账通道（`lib/cost-stats.js` 读真实 `cost.jsonl` + `lib/remote.js` 暴露 `smartProvider.cost()`），不再依赖硬编码或空壳状态。
- **P1（资源自适应）。** `chains` 动态生成（`discoverAutoChain()` 从实时注册表按 provider/model 名排序建中立 `auto` 链，不内置任何具体用户的模型 id）；内置默认链刻意为空 `DEFAULT_CHAINS={auto:[]}`，没配时使用用户当前真实拥有的路由；老配置（`chains` / `accounts` / `custom-routes.user.yaml`）原样保留、不覆盖；定价表缺失字段有降级回退（reasoning / cacheOutput 回退到 output，cacheRead / cacheWrite 回退到 input）；策略默认中立 `.25`（`balanced`）。
- **三层健康自动管理默认开启。** 模型层（L1 `availability.js`）、账号层（L2 `account-health.js`）、拓扑层（L2a `provider-topology.js`）分开记账，注册表与设置页首屏共享同一对象引用。关键纠偏：参数不兼容/缺 header 的 4xx **不再连累模型健康**；冷却到期只变 `HALF_OPEN`，要一次真实请求成功才回到 `ACTIVE`（没有证据就没有恢复）；自带账号池的路由不会被再套一层。默认开启、可显式 opt-out，关闭后逐字节回 legacy。详见 §六。
- **P2（两层智能路由）。** `lib/routing.js` 四个纯函数：`classifyTask`（请求分类）、`derivePosition`（模型位置标签）、`selectTiers`（层一候选层选择）、`resolveRoutingPolicy`（预设解析）。**默认关闭：只有 `ranking.routing.enabled=true` 才激活**；未配置或关闭时，代码路径逐字节等于现状（legacy），不选路、不加评分。支持的策略预设共 8 种：`balanced` / `cost-first` / `speed-first` / `reasoning-first` / `longctx-first` / `vision-first` / `legacy` / `custom`。

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
│   ├── probe.js              极小真实探测（1 token）+ TTL 缓存，替代按名字猜免费
│   ├── ranking.js            账号择优评分（默认关闭，中立 .25 默认）
│   ├── routing.js            P2 两层智能路由四个纯函数（默认关闭）
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
│   └── run-tests.mjs         统一验证入口：语法检查 + 全套测试（自动选 Electron Node）
├── test/
│   ├── account-pool.test.mjs 账号池回归测试（需 DSH runtime 读 app.asar）
│   ├── health.test.mjs       健康层回归测试（纯逻辑，任何 Node 可跑）
│   ├── ranking.test.mjs      路由排序回归测试（纯逻辑）
│   ├── pricing.test.mjs      定价降级与解析顺序回归测试（纯逻辑）
│   ├── latency.test.mjs      延迟度量与速度因子回归测试（需 DSH runtime）
│   ├── loading.test.mjs      加载路径回归测试（需 DSH runtime）
│   └── compaction.test.mjs   虚拟模型 contextWindow / 压缩预检回归测试（task-5，需 DSH runtime）
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

## 五、账号择优 ranking（P1，默认关闭）

`ranking.js` 提供多因子账号评分（成本 / 速度 / 等级 / 负载），**默认关闭**；关闭或 `strategy:'legacy'` 时排序完全保持旧行为（路线优先 + 最少使用）。启用后策略预设：`legacy` / `balanced`（中立 .25）/ `cost-first` / `speed-first` / `tier-first` / `custom`。权重可自定义并在保存时归一化到和 = 1；典型 token 配比仅影响排序、不影响计费；`historical` 账本反哺用最近 N 条真实成本记录校正配比，但**不能反推真实单价**。配置字段清单见 `lib/ranking.js` 的 `RANKING_CONFIG_SCHEMA`。

**速度因子的取值顺序（已落地）**：优先用本次会话账本里的真实延迟证据（`ctx.speedEvidence`，来自 `cost.jsonl` 的 `ttft_ms` / `tokens_per_second`，按 `account_id` 归集）；没有实测数据时回退到手填的 `speedTier`（fast/normal/slow）；两者都没有时取中性值 0.5。未启用 routing 或无任何证据时，评分结果与旧版逐字节一致（有回归测试锁定：`speed factor fallback chain: measured > speedTier > neutral`）。

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

不靠模型名猜。证据强度：上游 `billingSource`/`cost>0`（高，0.95）> 自己的付费样本（高）> 账本里 20 条以上 cost=0 样本（中，0.7）。只有价格标记、没有任何真实样本时结论是 `UNKNOWN`，不是 `free`。**重命名会强制清零计费证据**：旧价格不能顺延给新 id，必须重新确认，否则“省钱”就是假的。

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

### 关闭方式

`health` 与 `ranking.health` 都是 volatile，设置页改完即时生效，无需重启。任一种写法即关闭，且关闭后代码路径逐字节回到 legacy：

```json
{ "health": false }
{ "health": { "enabled": false } }
{ "ranking": { "health": { "enabled": false } } }
```

`health` 里可调 `accountHealth`（`halfOpenPermits` / `backoffFactor` / `maxCooldownMs` / `defaultCooldownMs`）、`topologyOpts`（`declaredFlag` / `observedAccountIds` / `declaration`）、`virtualProviders`（额外虚拟路由；`smart` 永远在内）、`currentIdList`（判定重命名用）。

## 七、两层智能路由 routing（P2，默认关闭）

### 配置方式

routing 配置嵌在 `ranking` 对象下（schema.js:62-67 声明 `routing` 字段为 volatile，配置页可改、无需重启）。`adapter.js` 读取 `ranking.routing`；未配置、`null` 或 `enabled !== true` 时该代码路径完全不运行。字段格式：

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
      "positionOverrides": { "vendor/model": ["reasoning", "longctx"] },
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
- `positionOverrides` —— 手动指定某模型的位置标签（键用 `provider/model` 或 `model`）。
- `tierLimit` —— 最多选几个候选层（默认 2）。
- `longContextTokens` —— 长上下文判定阈值（默认 200000；tokens 用 chars/4 估算，仅用于选路、不用于计费）。
- `dynamicAuto` —— 动态 auto 链；只在用户没有配置该 outer model 与 `*` 时生效，显式配置始终优先（向后兼容）。

### 位置标签：自动推导 vs 手填

`derivePosition()` 从模型 catalog 元数据自动推导：

- `reasoning === true` → `reasoning`
- `contextWindow >= 200000` → `longctx`
- `input` 含 `image` → `vision`
- `tool !== false` → `tool`（聊天模型默认具备，保守策略避免误杀）
- 所有模型都带 `general`

自动结果总是保守、不会因缺元数据而失败；如果用户手填了 `tags`（受支持标签白名单过滤），则以手填为准并与 `general` 合并，来源标记为 `auto` / `user` / `mixed`。手填适合 catalog 元数据缺失或不准确时纠正位置。

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
5. **成本 Tab 真账** —— `lib/cost-stats.js` 读真实 `cost.jsonl` 并聚合（总花费 / 免费笔数 / 付费笔数 / 失败笔数 / 按 provider 拆分），经 `lib/remote.js` 的 `@Remote` 服务 `smartProvider.cost()` 提供给设置页，不依赖估算占位。
6. **查询脚本** —— 命令行回答花费与占比问题：

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

```bash
# 1) 一条命令跑完整验证门槛（语法检查 + 全套测试，自动选运行时）
npm test
# => 语法检查逐文件 ok；tests 109 / pass 109 / fail 0（2026-11-25 实测，退出码 0）

# 2) 只跑纯逻辑套件（health + ranking + pricing，任何 Node 都行，无需 DSH）
npm run test:unit
# => tests 79 / pass 79 / fail 0（退出码 0）

# 3) 不带 npm 时等价写法
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.mjs

# 4) JSON 完整性（默认表当前 4 行零价声明；示例导出 151 行）
node -e 'const p=require("./lib/pricing.json"); if(p._rows!==p.entries.length)throw Error("mismatch")'
# 退出码：0

# 5) 真实 DSH 运行时冒烟（P0-1/P0-2/P0-3、回退、成本、会话记录）
#    退出码：0 —— 完整冒烟 PASS
```

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

注意：schemastery 的 schema 是可调用的（`Config({})`），不是 zod 风格（`Config.parse()`）；在加载器之外，volatile 字段返回的是标记对象，`apply()` 会做防御性强制转换。

## 十一、尚未验证 / 注意事项

- 成本估算是离线标价，未与 provider 真实账单对账；订阅与折扣未建模。
- 健康层的判定逻辑有完整单元回归，但**尚未与真实多账号故障场景对账**：半开恢复、连击退避、拓扑自动升级的收益数字依赖用户自己的资源和流量，本文档不承诺具体收益。真实效果的观察口径是 `cost.jsonl` 里的 `failure_code` 分布与 `smart-health` 命令输出的账号状态。
- P2 两层路由默认关闭；开启后 8 预设在真实多账号场景下的效果，依赖用户自己的配置与资源，本文档不承诺具体收益数字。
- 自动测速已落地：`cost.jsonl` 每行带 `started_at` / `first_token_at` / `ttft_ms` / `duration_ms` / `tokens_per_second`（缺数据不写字段），ranking 的速度因子按「实测优先 → `speedTier` → 中性回退」取值。仍缺的是真实多账号场景下实测证据对选路效果的量化收益——那依赖用户自己的流量，本文档不承诺数字。
- HMR 的监听列表可能为空（日志 `watching []`）：此时**源码改动不会自动重载**，需要触发一次 profile 重组合（改配置 / 重装）或重启，宿主才会跑新代码。安装新组合包本身会立即触发重组合，不需要重启。
- 最小 profile 里没有 `sessions` 服务，因此没有 `hop-selected` 会话记录；该记录依赖 `sessions`，属可选降级（账本中的 `account_id` 仍然完整）。
- 配置页显示的 provider / model 数量随用户 DSH 实时注册表变化，文档不写死。

---

## English summary (secondary)

`smart` is a DSH meta-provider that fails over across your already-configured provider routes with an offline cost meter. It is a **general intelligent router** (goals: cost / speed / capability / composite), neutral by default in code — saving-first is an opt-in user config. It is **installed and enabled** as the default model. Verified capabilities include: `smart/auto` in real sessions, the `x-opencode-free` free first hop (cost=0, 213+ real ledger rows) with 402→paid fallback, a settings page with real pi-ai resources and `@Remote` real-ledger cost tab, P1 resource adaptation (dynamic neutral chains, neutral .25 default, backward-compatible migration), and P2 opt-in two-layer routing (`ranking.routing.enabled=true`, 8 presets, byte-for-byte legacy when off). See `docs/DETAIL.md` for the plugin detail page and the three design docs in the parent workspace for the full design rationale.
