# dsh-smart-provider（DSH 智能模型路由）

`smart` 是一个 DSH 元提供商：它本身不调用任何大模型 API，而是在你**已配置的供应商路由**之间按序故障转移，并提供离线成本统计。它是**通用智能路由**，不是某一个账号的「省钱脚本」——四个目标是省钱 / 高性能 / 高能力 / 复合（智能），由每个用户按自己的需要选；**代码默认是中立的**（均衡权重 .25，不偏向任何单一目标），「省钱优先」是用户自己的 config 值（`cost-first` 策略），不是出厂默认。

简体中文 → [docs/DETAIL.md](docs/DETAIL.md)
English → [docs/DETAIL.en.md](docs/DETAIL.en.md)
Español → [docs/DETAIL.es.md](docs/DETAIL.es.md)
Français → [docs/DETAIL.fr.md](docs/DETAIL.fr.md)
Deutsch → [docs/DETAIL.de.md](docs/DETAIL.de.md)
Русский → [docs/DETAIL.ru.md](docs/DETAIL.ru.md)
Português → [docs/DETAIL.pt.md](docs/DETAIL.pt.md)

实现依据父工作区的三份设计文档：

- `meta-provider-设计方案.md` —— 核心骨架、错误分类、仅在响应建立前回退
- `多账号池设计方案.md` —— 跨账号即跨路由、跳级（hop 级）冷却
- `方案盲点审查.md` —— 三处 P0 修复，以及性能审查的后续项

**当前状态：插件已安装并启用，已设为默认模型，插件状态 ACTIVE。** 智能路由默认生效，省钱链路、配置页真读写、P1（资源自适应 / 中立默认 / 动态链）、P2（两层智能路由）均已落地并独立验收。详见下文与 `docs/DETAIL.md`。

---

## 一、已落地能力（有验收证据）

- **智能路由默认生效。** `smart/auto` 是默认模型，已在真实会话中验证选路、回退、成本记录与会话记录。
- **省钱真落地（用户可选，不是默认）。** 自建免费路由 `x-opencode-free`（`hy4-flash-free`）排在 `auto` 链首，真实账本里该路由的每一笔 `estimated_cost_usd` 都是 `0`（已核对 213+ 笔，最近一次全量统计 487 笔 cost=0）；遇到 402/配额错误自动 fallback 到付费路由（`opencode-go`）。免费档由 `registry/custom-routes.user.yaml` 的 `tier: free` 自动排首，不需要改代码。
- **配置页真读写。** 设置页展示来自 pi-ai 的真实资源（当前约 49 provider / 58 model，数量随你的 DSH 实时注册表变化）、真实凭据名与账号健康，并可写回插件配置；成本/健康 Tab 走 `@Remote` 真账通道（`lib/cost-stats.js` 读真实 `cost.jsonl` + `lib/remote.js` 暴露 `smartProvider.cost()`），不再依赖硬编码或空壳状态。
- **P1（资源自适应）。** `chains` 动态生成（`discoverAutoChain()` 从实时注册表按 provider/model 名排序建中立 `auto` 链，不内置任何具体用户的模型 id）；内置默认链刻意为空 `DEFAULT_CHAINS={auto:[]}`，没配时使用用户当前真实拥有的路由；老配置（`chains` / `accounts` / `custom-routes.user.yaml`）原样保留、不覆盖；定价表缺失字段有降级 example（reasoning / cacheOutput 回退到 output，cacheRead / cacheWrite 回退到 input）；策略默认中立 `.25`（`balanced`）。
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
│   ├── ranking.js            账号择优评分（默认关闭，中立 .25 默认）
│   ├── routing.js            P2 两层智能路由四个纯函数（默认关闭）
│   ├── cost-meter.js         非阻塞批量 JSONL 写入（含 account_id 字段）
│   ├── cost-stats.js         读取真实 cost.jsonl 并聚合（供成本 Tab / @Remote）
│   ├── remote.js             @Remote 服务 smartProvider.cost()
│   ├── pricing.js            离线价格查询 + 美元估算（含字段降级）
│   └── pricing.json          从 Bifrost config.db 只读导出的价格行
├── registry/
│   ├── custom-routes.user.yaml  自建路由唯一人工编辑点（x-opencode-free 在此）
│   ├── custom-routes.yaml    生成后的自定义路由配置
│   └── registry-lib.mjs      注册表读取工具库
├── scripts/
│   ├── query-cost.mjs        “模型 X 花了多少钱 / 占比多少” 命令行工具
│   ├── gen-custom-routes.mjs 由 user.yaml 生成自定义路由配置
│   └── validate-custom-routes.mjs 自定义路由配置校验
├── test/
│   ├── account-pool.test.mjs 账号池回归测试（用 DSH asar-aware node 运行）
│   └── ranking.test.mjs      路由排序回归测试
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

---

## 六、两层智能路由 routing（P2，默认关闭）

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

## 七、成本统计设计

DSH 自身没有货币级计量（`dsh-token-meter` 明确说 “not a billing record”），因此本包自行计量：

1. **token 来源** —— 适配器在终止 `finish` 块之前捕获 `{type:'usage'}` 块（携带 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`）。正常、出错、中止的流都会保留 usage，因此 token 计数可靠。
2. **价格来源** —— `lib/pricing.json`，从 Bifrost 的 `governance_model_pricing` 表只读导出，限定为实际在用 provider 路由。记录的是公开标价/token，**不是账单** —— 未建模订阅与折扣；缺字段按降级表回退。
3. **JSONL 行** —— 每个完成的 hop 追加一行到 `~/.dsh/smart-provider/cost.jsonl`，字段包括：`timestamp`、`outer_model`、`actual_provider`、`actual_model`、`input_tokens`、`output_tokens`、`estimated_cost_usd`、`hop_index`、`failure_code`，以及 `account_id`（服务该尝试的池账号；未配置池时为 `hop:provider/model`）和诊断字段：`cache_read_tokens`、`cache_write_tokens`、`usage_complete`、`price_known`、`request_id`、`seq`。
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

## 八、配置说明

默认链在 `lib/chains.js`，内置表刻意为空；未配置时由 `discoverAutoChain()` 从实时 DSH 注册表生成中立 `auto` 链。插件配置的 `chains` / `accounts` / `ranking.routing` 都是 volatile（配置页改完即时生效，无需重启）。

自建路由（如 `x-opencode-free`）只在 `registry/custom-routes.user.yaml` 声明（唯一人工编辑点），改完跑 `node scripts/validate-custom-routes.mjs` 与 `node scripts/gen-custom-routes.mjs --write`；`credentialRef` 只放凭据引用名，绝不放明文 key。

要新增同厂商的第二个账号，在 `llm-pi-ai.providers` 里用独立的 `apiKeyEnv` 注册第二条路由（例如 `opencode-go-alt`）。然后要么加一条指向它的 hop（旧的扁平写法），要么——推荐——在 `accounts` 池数组里同时声明两条路由，使账号级冷却生效。两种方式都不需要改 DSH 生产代码。

**切勿**在 `llm-pi-ai.providers` 里添加 `smart:` 块 —— 该路由由 `registerAdapter` 注册，两边都做会触发 `DUPLICATE_ADAPTER`。

---

## 九、构建时已执行的验证

以下命令均在本包目录执行。`node` 为 v24.21.0；DSH 运行时探针使用 `ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE"`。

```bash
# 1) 语法检查 —— 全部 JS/MJS 文件
node --check index.js
node --check schema.js
node --check lib/dsh.js
node --check lib/adapter.js
node --check lib/chains.js
node --check lib/routing.js
node --check lib/account-pool.js
node --check lib/cost-meter.js
node --check lib/cost-stats.js
node --check lib/remote.js
node --check lib/ranking.js
node --check lib/pricing.js
node --check scripts/query-cost.mjs
# 汇总退出码：0（每个单文件均退出 0）

# 2) JSON 完整性
node -e 'const p=require("./lib/pricing.json"); if(p._rows!==p.entries.length)throw Error("mismatch")'
# 退出码：0

# 3) 回归测试（账号池 + ranking + routing）
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/account-pool.test.mjs test/ranking.test.mjs
# P1/P2 独立验收全绿（由实现任务贴出命令与退出码）

# 4) 真实 DSH 运行时冒烟（P0-1/P0-2/P0-3、回退、成本、会话记录）
#    退出码：0 —— 完整冒烟 PASS
```

运行时冒烟验证了：`LlmRuntime.prototype.resolveModel` 不存在而 `resolveModelInfo` 存在（task-25 的 bug）；零重试策略；`listModels` 中的 `smart/auto`；仅在建立前回退（AUTH 切跳、发出内容后的错误不切、ABORTED 永不切）；带 `usage_complete` 的 JSONL 行写入；真实会话中出现的 `plugin:dsh-smart-provider/hop-selected` 记录；以及该记录在会话恢复时被保留。

注意：schemastery 的 schema 是可调用的（`Config({})`），不是 zod 风格（`Config.parse()`）；在加载器之外，volatile 字段返回的是标记对象，`apply()` 会做防御性强制转换。

## 十、尚未验证 / 注意事项

- 成本估算是离线标价，未与 provider 真实账单对账；订阅与折扣未建模。
- P2 两层路由默认关闭；开启后 8 预设在真实多账号场景下的效果，依赖用户自己的配置与资源，本文档不承诺具体收益数字。
- 自动测速属于 future（账本无起止时间）；`speedTier` 需手填。
- 配置页显示的 provider / model 数量随用户 DSH 实时注册表变化，文档不写死。

---

## English summary (secondary)

`smart` is a DSH meta-provider that fails over across your already-configured provider routes with an offline cost meter. It is a **general intelligent router** (goals: cost / speed / capability / composite), neutral by default in code — saving-first is an opt-in user config. It is **installed and enabled** as the default model. Verified capabilities include: `smart/auto` in real sessions, the `x-opencode-free` free first hop (cost=0, 213+ real ledger rows) with 402→paid fallback, a settings page with real pi-ai resources and `@Remote` real-ledger cost tab, P1 resource adaptation (dynamic neutral chains, neutral .25 default, backward-compatible migration), and P2 opt-in two-layer routing (`ranking.routing.enabled=true`, 8 presets, byte-for-byte legacy when off). See `docs/DETAIL.md` for the plugin detail page and the three design docs in the parent workspace for the full design rationale.

---

## 支持本项目

如果这个插件帮你省了心、省了钱，或者单纯觉得它做得还行，欢迎给仓库点个 star ⭐ —— 你的一个星是对我们最大的鼓励，也让更多人能发现它。感谢！
