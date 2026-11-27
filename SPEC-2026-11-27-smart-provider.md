# 规格契约：dsh-smart-provider 虚拟模型 / 思考强度（2026-11-27 规格反转）

> 状态：**已锁定，供下游 agent 消费**。本契约取代仓库 `.agents/plans/2026-11-27-*.md` 中
> 「3 模型档 × 3 强度 = 9 id / 否决第 4 档 / 否决 auto 强度 / 中文只放自由文本不进 locale」的旧定稿。
> 用户给出的是新规格（4 虚拟模型 + 6 强度 + i18n 硬约束），不是修一个错键。
> 第一层（本文 + `lib/tier-ids.js` + `test/tier-ids.test.mjs`）已落地并自测通过；其余层按下文分工。

---

## 1. 规格锁定摘要

| 项 | 新规格 |
|---|---|
| 虚拟模型 | **4 个**：均衡、省钱、效率、智能；**默认选中「智能」** |
| 虚拟思考强度 | **6 档**：`auto`（默认）+ 5 手动档：关闭 / 低 / 中 / 高 / 极高 |
| `auto` 语义 | 根据虚拟模型给出一个**强度偏向/倾向**，但**不是模型→固定强度的死映射**；必须保留 `lib/routing.js::classifyTask` 按任务内容动态决策的智能判断；用户手动选档时覆盖 auto |
| 本地化 | 4 模型名 + 6 强度名**必须走 i18n/locale 键**，禁止硬编码中文自由文本；本层给出 zh/en，de/es/fr/pt/ru 由下游补齐 |
| 默认值 | 插件内：默认模型 `smart`、默认强度 `auto`（本层）；宿主会话默认**已落盘 smart/smart**：profile 的 `agent-default-model` 为 `provider: smart` / `model: smart`（单段 catalog id），强度走 `defaultEffort` 默认 `auto`；`smart/auto` 只是内部组合 id，不是 profile 里填的值 |
| 目录形态 | **已锁定（用户拍板）**：host 目录只列 **4 个单段模型**（默认智能）；强度另设配置 key `defaultEffort`（auto + 5 手动档），不作为组合 id 出现在目录里 |

---

## 2. 数据契约：id 表、顺序与命名理由

### 2.1 模型 id（`MODEL_TIERS` / `MODEL_IDS`，顺序即用户枚举顺序）

| 序号 | 中文 | en | 内部 id | locale 键 |
|---|---|---|---|---|
| 1 | 均衡 | Balanced | `balanced` | `virtualModel.balanced` |
| 2 | 省钱 | Economy | `cost` | `virtualModel.cost` |
| 3 | 效率 | Efficient | `speed` | `virtualModel.speed` |
| 4 | 智能 | Smart | `smart` | `virtualModel.smart` |

`MODEL_TIERS = ['balanced', 'cost', 'speed', 'smart']`。顺序保留用户逐字枚举；
「默认智能」由独立的 `DEFAULT_MODEL_TIER = 'smart'` 表达，不靠把它排到第一位暗示。

### 2.2 强度 id（`EFFORT_IDS`，auto 默认在前，手动档从弱到强）

| 序号 | id | 中文 | en | locale 键 | 类别 |
|---|---|---|---|---|---|
| 1 | `auto` | 自动 | Auto | `virtualEffort.auto` | 默认，动态决策 |
| 2 | `off` | 关闭 | Off | `virtualEffort.off` | 手动 |
| 3 | `low` | 低 | Low | `virtualEffort.low` | 手动 |
| 4 | `medium` | 中 | Medium | `virtualEffort.medium` | 手动 |
| 5 | `high` | 高 | High | `virtualEffort.high` | 手动 |
| 6 | `max` | 极高 | Max | `virtualEffort.max` | 手动 |

`EFFORT_IDS = ['auto','off','low','medium','high','max']`；
`MANUAL_EFFORT_IDS = ['off','low','medium','high','max']`（手动子集，从弱到强）。
手动档 id 同时是宿主规范 `ReasoningEffortId` 值，可直接注入 `options.reasoningEffort`。

> 注意：旧实现里 `medium` 的中文是「均衡」，与新模型名「均衡」撞名。新契约中 `medium` = 「中」，
> 「均衡」只指 `balanced` 模型。下游所有文案/注释必须消除这处歧义。

### 2.3 组合 id 与默认值

- 组合语法：`<model>/<effort>`，如 `smart/auto`、`cost/high`；`+` 仍专用于 `+<position>` 能力标签，绝不表示强度。
- `TIER_IDS` = 4 × 6 = **24** 个组合，稳定顺序（按 `MODEL_TIERS` × `EFFORT_IDS` 展平）。
  **仅作内部解析 / 历史兼容能力，非 catalog 条目**：host 目录只列 4 个单段模型（见 §7 / §9）。
- `DEFAULT_MODEL_TIER='smart'`、`DEFAULT_EFFORT='auto'`、`DEFAULT_TIER_ID='smart/auto'`。
- 单段 id（如 `smart`）可解析为 `{tier:'smart', effort:undefined}`，但**不**在解析阶段塞默认值；
  默认值由 `composeTierId(tier)`（缺省 effort=auto）和 `resolveEffort`（缺省 effort 走 auto 路径）提供。

### 2.4 内部 id 命名理由

- 全部英文小写稳定标识：`balanced / cost / speed / smart`（模型）、`auto / off / low / medium / high / max`（强度）。
- **模型用 `smart` 而非 `auto`**：`auto` 已被新强度默认档占用；让模型命名空间与强度命名空间完全不相交，
  避免 `auto/auto` 这类 id 的语义歧义，也让「智能模型」与「自动强度」在代码/日志里可区分。
- `speed` 而不是 `swift`：`swift` 在 `lib/routing.js` 是「永不自动推导」的**位置标签**（position tag），
  属于路由层概念；`speed` 是**虚拟模型** id，两者不可混用（见 §7 语义冲突）。
- 复用旧 id `balanced` / `cost` 以降低迁移成本；旧 `auto` 模型通过别名迁移到 `smart`（见 §5）。

---

## 3. 文案契约：locale 键名表与回退策略（硬约束）

### 3.1 固定键名表（下游必须一字不差地使用）

```
virtualModel.balanced   virtualModel.cost   virtualModel.speed   virtualModel.smart
virtualEffort.auto      virtualEffort.off   virtualEffort.low
virtualEffort.medium    virtualEffort.high  virtualEffort.max
```

- 导出常量：`TIER_NAME_KEYS`（model id → 键名）、`EFFORT_NAME_KEYS`（effort id → 键名），
  位于 `lib/tier-ids.js`，是全仓唯一的键名来源；`locale/*.json` 与 `client.js` 内嵌字典必须与之对齐。
- zh/en 文案由 `TIER_NAMES` / `EFFORT_NAMES`（`{locale: {id: text}}`）给出，值见 §2.1 / §2.2 表格。

### 3.2 回退策略

1. 运行期优先取当前 locale 的键（`locale/<lang>.json` 或 `client.js` 内嵌字典 + `t()`）；
2. 缺键 → 回退 `en`；
3. 仍缺 → 回退**原始 id 字符串**（绝不回退到中文自由文本，避免 en 界面出现中文）。

纯函数侧同名 API：`tierName(id, locale)` / `effortName(id, locale)` / `tierDisplayName(tier, effort, locale)`，
内建 zh/en 两套，`DEFAULT_LOCALE='zh'`；未实现的 locale（de/es/fr/pt/ru）自动走 en 回退。
`locale` 作为 `tierDisplayName` 第三参数，**保持向后兼容**：adapter 现以两参调用，默认 zh；
下游接入真实 locale 时应显式传第三参。

### 3.3 撤销旧约定

旧 `lib/tier-ids.js` 头部注释「Chinese display names live in name free text only — never in t()/locale」
与「free text only, NOT locale keys」**已删除**。新约定：名称是 locale 键，
`listModels.name` 的文案必须由本地化通道产生，不得再写死中文。

---

## 4. `auto` 强度：偏向非硬绑定的语义与实现边界

### 4.1 语义

`auto` =「根据所选虚拟模型得到一个**强度偏向**，再结合任务内容与链路能力动态决定强度」：

- 模型只提供**倾向**（软权重），例如 `smart` 偏高、`cost` 偏低、`speed` 偏低快、`balanced` 偏中；
- `classifyTask(options)` 的任务类型信号（`reasoning` / `thrifty` / `swift` / `longctx` / `vision` / `tool` / `general`）
  与模型偏向**相加**，任务信号可以推翻偏向（例：`cost` 模型 + reasoning 任务 → 仍然选高强度）；
- 链路真实支持的 effort 集合参与最终裁决；不支持则不伪造、不 clamp（沿用旧 `mapEffort` 契约）；
- 用户手动选择任意手动档 → **完全跳过**偏向与任务信号（手动覆盖 auto）。

### 4.2 纯函数 API（本层已实现，位于 `lib/tier-ids.js`）

```js
AUTO_EFFORT_BIAS            // {modelId: {off,low,medium,high,max: scoreDelta}} 软偏向，非映射表
TASK_EFFORT_SIGNAL          // {taskKind: {off,low,medium,high,max: scoreDelta}} 任务信号
autoEffortScores({tier, task})      // => {off,low,medium,high,max: 合计分}；未知模型=中性 0
rankAutoEfforts({tier, task})       // => 手动 effort id 的偏好排序（高分优先，平局按弱→强）
resolveAutoEffort({tier, task, supported})  // => 具体宿主 effort 值 | undefined（无支持则 undefined）
resolveEffort({tier, effort, task, supported}) // => 统一入口：手动覆盖 auto；auto/缺省走动态路径
```

`resolveEffort` 判定规则：
- `effort` 是手动档 → `mapEffort(effort, supported)`（手动优先，含「手动不支持则 undefined」）；
- `effort === 'auto'` 或缺省 → `resolveAutoEffort({tier, task, supported})`。

### 4.3 实现边界（下游必须遵守）

1. **禁止**把 auto 写成 `MODEL→EFFORT` 常量查表后直接注入；那会推翻 `classifyTask` 的智能判断。
2. **禁止**修改 `classifyTask` 的 P0–P6 优先级或 P3（reasoning effort 作为二元信号）语义来迁就本规格；
   auto 只**读取** `classifyTask` 的结果，不改写路由层。
3. 调用顺序要求（adapter）：`classifyTask` 必须在**注入 `reasoningEffort` 之前**对原始 `options` 求值，
   否则 P3 会把刚注入的值二次当成任务信号；后续路由分支复用同一个 `task` 结果。
4. `speed` 模型 ≠ `swift` 位置标签；`swift` 依旧「never auto-derived」，不得因为新增「效率」模型而自动派生。
5. 偏向表是**权重**：同一模型在不同任务下必须得到不同强度，这是验收点（见测试 test 6）。
6. **强度载体**：`resolveEffort` 的 `effort` 入参取自 `schema.defaultEffort` 配置（见 §7），不再由 model id 后缀承载；单段模型 id 解析得 `effort:undefined`。历史组合 id 的后缀仍可解析，`parsed.effort ?? config.defaultEffort` 即可兼顾旧会话与新配置。

---

## 5. 旧 id 兼容 / 迁移策略（契约已实现 `migrateTierId`，下游按此执行）

| 旧 id | 新 id | 处理 |
|---|---|---|
| `auto`（旧默认模型，智能档） | `smart` | `LEGACY_MODEL_ALIAS.auto='smart'`；`migrateTierId`/`parseTierId` 自动归一化 |
| `auto/off`、`auto/medium`、`auto/high` | `smart/off`、`smart/medium`、`smart/high` | 同上，段别名归一 |
| `cost/*`、`balanced/*` | 原样保留 | 模型 id 未变；旧手动后缀 `off/medium/high` 仍在新强度集合内 |
| 旧「无强度」单段 id（如 `auto`） | `smart` + 默认 auto 强度 | 解析得 `{tier:'smart', effort:undefined}`，`resolveEffort` 走 auto 路径 |

- `parseTierId` 内建别名归一，历史脚本/会话 id 无需调用方改造即可解析。
- **持久化 chains 需显式迁移**：`withTierChains` 遍历的是新 `MODEL_TIERS`（不再含 `auto`），
  旧配置里的 `chains.auto` 必须改键为 `chains.smart`，否则新档位不会被派生、`listModels` 会静默跳过。
  该键迁移由下游 `lib/chains.js` / `index.js` 负责（见 §7）。
- 无效 id 一律 `null` / `undefined`，不猜测、不伪造（沿用旧契约）。

---

## 6. 第一层已落地内容（本 agent 完成）

改动文件仅三个：

1. `lib/tier-ids.js`（重写）：§2–§5 的全部常量与函数，含 locale 名称表、默认值、内部 24-id 组合
   （仅解析/兼容，非 catalog 条目）、`migrateTierId`、auto 偏向纯函数族；保持
   `MODEL_TIERS/EFFORT_IDS/TIER_IDS/parseTierId/composeTierId/tierDisplayName/supportedEfforts/mapEffort`
   导出签名兼容（新增可选 locale 第三参）。
2. `test/tier-ids.test.mjs`（重写）：4 模型/6 强度、默认值、auto 偏向（同模型不同任务、同任务不同模型）、
   手动覆盖、zh/en 文案键返回、回退、旧 id 别名、mapEffort 不 clamp/不伪造。共 7 例。
3. 本文件（规格契约）。

验收：`node --test test/tier-ids.test.mjs` → 7 pass / 0 fail，**exit 0**。
目录形态（用户已锁定）：**4 个单段模型目录 + 独立强度设置 `defaultEffort`**，不列 24 组合。
（附带观察：`test/compaction.test.mjs` 在本机失败，原因是 profile 缺少 `@deepseek-ai/dsh-llm`，
发生在 adapter 构造阶段、与本次改动无关，属环境限制。）

---

## 7. 跨文件改造要点（下游各文件）

> 交给下游 worker 时请连同 §8 的冲突规避约束一起转达。

| 文件 | 状态 | 要点 |
|---|---|---|
| `lib/adapter.js` | 干净可改 | ① `withTierChains`(:76-84) **只派生 4 个单段模型 key**（遍历 `MODEL_TIERS`，不再 4×6 派生组合 key）；② `listModels`(:338-355) **只列 4 个单段模型**（遍历 `MODEL_TIERS`，默认 `smart`），**不再遍历 `TIER_IDS` 的 24 组合**；id 用单段值，`tierDisplayName(tier, undefined, locale)` 得模型名；`TIER_IDS` 仅留作内部解析/兼容；③ `stream`(:608-642) 先 `const task = classifyTask(options, this.routing)`（注入前！），强度取 `parsed.effort ?? config.defaultEffort`（见 schema 行），再 `resolveEffort({tier:parsed.tier, effort, task, supported})`；defined 才注入，手动不支持仍报 `UNSUPPORTED_REASONING_EFFORT`；④ 后续路由分支复用该 `task`；⑤ `imageRequestPricing`/`resolveModel` 的 `parseTierId` 消费点因别名归一自动兼容；⑥ 宿主侧 locale 获取通道见 §10 未决项 4 |
| `lib/chains.js` / `index.js` | chains 干净 / index 有既存改动（保留） | `DEFAULT_CHAINS={auto:[]}`→`{smart:[]}`；`discoverAutoChain` 写入键 `auto`→`smart`；持久化 `chains.auto`→`chains.smart` 迁移；`index.js:165-166,354-395` 的 chains 规范化同步。**不要整文件覆盖 index.js**，只做定点编辑 |
| `lib/routing.js` | **有既存改动（保留）** | 仅确认 auto 偏向与 `classifyTask` 共存（§4.3）；不要改 P3 与 `swift` 永不自动推导语义；`speed` 模型不得写成 `swift`。既有 `projectModelForPosition` 等 modelPositions 功能必须原样保留 |
| `client.js` | **有既存改动（保留）** | 改 `TIER_LABELS/EFFORT_LABELS`(~660-679)、`tierIdLabel/modelLabel`、`STATIC_STRATEGIES/ROUTING_PRESETS`(~603-626)、首屏按钮(~1000-1004)、preset 文案(~3317)；新增 7 语 `virtualModel.*`/`virtualEffort.*` 键；**既存 `routing.*` 键必须原样保留**；消除旧「均衡=medium」撞名。详见 §8 第 3 条 |
| `locale/*.json` | 干净，可与 client 分开派 | 7 语各新增 §3.1 的 10 个键；zh/en 值照 §2 表格，de/es/fr/pt/ru 由下游补齐；键名必须与 `client.js` 内嵌字典一致（以 `TIER_NAME_KEYS`/`EFFORT_NAME_KEYS` 为准） |
| `schema.js` | 干净 | **新增配置 key `defaultEffort`**（本层定名）：`type:'string'`，`enum:['auto','off','low','medium','high','max']`，`default:'auto'`；描述「新建会话默认思考强度：auto=按虚拟模型与任务内容动态决定；手动档覆盖自动判断」。设置页 UI 与 `lib/adapter.js::stream` 均从该 key 读取强度，强度**不再靠 model id 后缀承载**（历史组合 id 后缀仅供兼容解析）。**必须把测试里「12 key」断言同步改为 13 key（含 `defaultEffort`）**。若日后开放可配置偏向权重再另加 key |
| `test/*` | 有既存改动（保留） | `compaction.test.mjs`(:65,202-232)、`routing-tier.test.mjs`(:249-251)、`ranking.test.mjs` 中 9-id/3-effort 断言改 24-id/6-effort；既有 modelPositions 相关测试不得覆盖 |
| `README.md` / `CHANGELOG.md` / `docs/DETAIL*.md` / `.agents/plans/*.md` / `marketplace/*.yml` | 有既存改动（保留） | 把「3 档×3 强度 / smart/auto 旧单段 id / 平衡档」等表述改为新契约；旧设计稿的「定稿/否决第 4 档与 auto 强度」结论标注为**被本 SPEC 取代**；既有定位功能文档不得覆盖 |

### 7.1 对话框思考强度显示（2026-11-28 定稿：原生控件显示强度）

用户最终诉求：让**对话框里原本给其他模型选强度的原生位置**（ModelSelect 的 Effort 行 / 触发器「模型名 · 强度」）在选中 smart 时也显示强度；用户明确否定自绘 chip，并纠正「**auto 本来也包含 off**」——免费首跳只支持 off 不能作为「不显示强度」的理由，off 本身就是合法强度档，auto 对不支持高强度的链路解析成 off 是强度在正常工作。

实现（不改链路、不换首跳）：

- `lib/tier-ids.js::virtualReasoningDeclaration()` 声明 6 档 `reasoning.efforts`（auto + off/low/medium/high/max，defaultEffort=auto），名称是**纯字符串**（宿主 `modelCatalog` 的 effort.name codec 是 `z.string()`，不接受 LocalizedText map；中文仅 zh UI 出现，其余语言英文，绝不漏中文）。`virtualEffort.*` 7 语键仍驱动设置页，不改动。
- `lib/adapter.js::resolveModel()` 对单段目录 id（`balanced/cost/speed/smart`，对话框只会解析这些）返回该 `reasoning`，于是宿主 catalog.ts:30-41 把它投影进 `ModelSelect`，原生 Effort 行（ModelSelect.tsx:498-504）与触发器「模型 · 强度」（:470）出现。`listModels()` 也带同一声明作为显式数据条件（宿主 listModels 归一化会丢弃未知字段，纯增量）。历史组合 id 保留首跳原样 reasoning（内部解析用）。
- 当前值：会话 `reasoningEffort`（原生控件写）优先于 `defaultEffort`（设置页偏好），再缺省 `auto`；auto 档显示为「自动/Auto」，由 `resolveEffort` 按模型偏向 + `classifyTask` + 首跳支持集动态裁决，语义不变。
- 点选后不崩：手动档若首跳不支持（如免费首跳只有 off），`stream` **降级注入 `off`**（auto 涵盖的合法档，不是「不发参数」），高档绝不伪造到无能力链上；仅历史组合 id 的显式 suffix 不支持时保留原 `UNSUPPORTED_REASONING_EFFORT` 硬错误（老契约）。auto 无支持值时省略参数（等价 off）。
- 自绘 chip 已移除且未重新引入（`client.js` 无 `EffortPill` / `EFFORT_PILL_SLOT` / `S.effortPill`）。
- 原生控件文案走宿主本地化通道：effort 名是纯字符串（codec 约束），zh UI 中文、其余英文；设置页 7 语 `virtualEffort.*` 不变。

---

## 8. 冲突规避与工作树约束（lead 核实，必须遵守）

1. **既存 18 个 M + 9 个未跟踪文件属于同一个完整功能「逐台真实定位 modelPositions()」**，完整可用，
   **必须保留**：禁止整文件覆盖、禁止 `git checkout/reset/stash/clean`、禁止删除未跟踪报告与
   `lib/position-snapshot.js`。第一层执行前后均已用 `git status --short` 核对，未触碰上述文件。
2. **干净无改动、可放心改**：`locale/*.json`、`lib/tier-ids.js`（本层）、`lib/adapter.js`、
   `lib/chains.js`、`schema.js`。
3. **`client.js` 是交汇点**：新规格改文案/标签/首屏/preset + 新增 7 语键，与既存 `routing.*` 字典同文件。
   **下游只能派一个 worker 统改，不可拆分共写**；`routing.*` 键原样保留。
4. **`lib/routing.js` 语义冲突处理**：按 §4.3，auto 偏向是权重/倾向而非硬映射，读取但不推翻 `classifyTask`；
   `swift` 永不自动推导不变；不得把 `speed` 模型与 `swift` 标签混为一谈。
5. `locale/*.json` 干净，可与 `client.js` 分开派；但键名表以 §3.1 / `TIER_NAME_KEYS`、`EFFORT_NAME_KEYS` 为准，
   两层必须一致。
6. 一次性诊断脚本用完即删，不得留在工作区。

---

## 9. 验收口径

- 第一层：`node --test test/tier-ids.test.mjs` → 7 pass / 0 fail，exit 0（已执行）。
- 回读改动文件确认落地（已执行）。
- **目录粒度（用户已锁定）**：host 目录 = **4 个单段模型**（均衡/省钱/效率/智能，默认智能），
  强度由 `defaultEffort` 设置项独立选择；下游核对 catalog 条目数必须为 4，不应出现 24 个组合 id。
- **GUI 验证口径**：虚拟模型目录由 **host 侧 `lib/adapter.js` 的 `listModels`** 决定；
  `client.js` 属于设置页客户端，其改动需**重启宿主 / recompose** 才能在 GUI 生效
  （诊断记录 10:53Z 有 HMR 警告：改动模块需重启才生效）。不要仅凭热载判断验收失败。
- 下游每层改完必须自跑对应测试并在交付回报里贴「命令 + 退出码」。

---

## 10. 未决事项（第 3 项已由用户锁定；其余交 lead / 下游确认，不阻塞本层）

1. en 译名采用 `Economy`(省钱) / `Efficient`(效率)；若产品侧另有偏好，只改 `TIER_NAMES.en` 值，键名不动。
2. de/es/fr/pt/ru 五语文案由下游补齐；本层只锁键名与回退。
3. ~~目录粒度待定~~ **已锁定（用户拍板）**：host 模型目录**只列 4 个单段模型**（均衡/省钱/效率/智能，
   默认智能）；强度另设配置 key `defaultEffort`（auto + 5 手动档），不作为组合 id 出现在目录里。
   `TIER_IDS` 的 24 组合**仅作内部解析 / 历史兼容能力，非 catalog 条目**。见 §2.3 / §7 / §9。
4. `listModels.name` 的 locale 获取通道：插件侧目前没有从 locale 反向注入 host catalog 的既有通道
   （诊断 §5.6）；需下游确认由 adapter 传 locale 还是由宿主模型选择器本地化。
5. 宿主会话默认模型（`agent-default-model` profile 配置）已落盘 `smart/smart`（`provider: smart` / `model: smart`，单段 catalog id），强度走 `defaultEffort` 默认 `auto`；`smart/auto` 只是内部组合 id，不是 profile 里填的值；本层只负责插件内默认。
6. `test/compaction.test.mjs` 的本地环境缺少 `@deepseek-ai/dsh-llm`，下游验收若在同样环境运行需先解决依赖。
