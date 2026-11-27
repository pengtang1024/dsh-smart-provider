# 诊断报告：dsh-smart-provider「虚拟提供商 / 虚拟思考强度显示不符」

> 只读调研。未修改任何源码、未 git commit、未安装/卸载插件、未运行会改变系统状态的命令。
> 唯一写入：本报告 `diagnosis.md`（任务指定）。
> 采样时间：2026-11-27 18:34+08:00。工作目录：`/Users/catbox/Documents/deepseek-harness/default-workspace/dsh-smart-provider`。

---

## 0. 结论先行

1. **用户新规格与仓库现存的定稿设计直接冲突，不是简单的代码 bug。** 仓库在 2026-11-27 已按用户当时的决策定稿为「3 模型档 × 3 思考强度 = 9 个组合虚拟 id」，并明确**否掉**了「第四个独立虚拟档」与「auto 强度」；当前代码正是该定稿的实现。现在要求「4 个虚拟模型（均衡/省钱/效率/智能）+ 5 个思考强度（auto + 4 手动）」属于**规格反转**，必须改数据契约、显示与文案，而不是修一个错键。
2. **当前实际对外只显示 3 个虚拟模型**：`Smart 智能档 · 关闭强度`、`Smart 智能档 · 均衡强度`、`Smart 智能档 · 高强度`（均为**中文硬编码自由文本**，非 locale）。原因：已安装配置的 `chains` 只有 `auto` 与 4 个具体模型 key，没有 `cost`/`balanced` key，`withTierChains()` 只为存在的 key 派生组合 id，`listModels()` 又会跳过没有 chain key 的档位。
3. **当前没有 `auto` 思考强度，没有「按模型自动决定强度」的联动**；只有 3 个手动强度 `off/medium/high`（关闭/均衡/高），且 `medium` 的中文名「均衡」与用户期望的虚拟模型名「均衡」发生命名冲突。
4. **不是 locale 缺键、不是构建产物过期、不是安装版本与源码不一致、不是过滤逻辑错**。i18n 的问题在于「虚拟模型/强度名称根本没走 locale，且设计文档明确规定不走 locale」；这是修复时必须补的层，但不是当前不一致的成因。
5. 术语纠正（按 lead 转达的用户口径）：用户说的 4 个是**虚拟模型**；「虚拟提供商」在代码里只有一个 `smart` provider（`providerInfo().name = 'Smart Gateway'`）。
6. **默认选中项：插件侧默认模型 id 是 `auto`（即「智能档」），语义上勉强对得上用户要求的「默认智能」，但形态不对**（显示成 3 个强度变体，而不是一个「智能」选项；强度默认也不是 `auto`）。更关键的是：**已安装 profile 的宿主级默认模型根本不是任何虚拟模型，而是 `x-opencode-free/hy4-flash-free`**（`~/.dsh/profiles/desktop/cordis.patch.yml:5-10`），与 README 宣称的「已设为默认模型」不符。详见 §1.5。【后续已落盘 smart/smart：provider: smart、model: smart（单段 catalog id），强度走 defaultEffort 默认 auto；smart/auto 只是内部组合 id，不是 profile 里填的值。见本轮文档。】

---

## 1. 现状清单

### 1.1 项目结构与技术栈
| 项 | 事实 | 证据 |
|---|---|---|
| 包 | `@local/dsh-smart-provider` v2.8.1，`type: module`，Node ≥20，DSH ≥0.2.0-rc.2 <0.4.0-0 | `package.json:2-14` |
| 入口 | Host 插件 `index.js`（`apply(ctx, config)`，`inject=['llm']`）；Web 客户端 `client.js`（React + Client Slot）；配置 `schema.js`（12 个 key） | `package.json:40-46`；`index.js:43,99`；`schema.js:28-71` |
| 补丁 | `cordis.patch.yml` 只插一行 `smart-provider`，故意不声明 `smart:` provider（避免 DUPLICATE_ADAPTER）；运行时 `ctx.llm.registerAdapter(['smart'], adapter)` | `cordis.patch.yml:3-15`；`index.js:323` |
| 虚拟模型/强度核心 | `lib/tier-ids.js`（纯函数数据契约）；`lib/adapter.js`（`listModels` / `withTierChains` / `stream` 注入）；`lib/chains.js`（链解析）；`lib/routing.js`（位置标签、任务分类） | 见下 |
| i18n 两层 | ① `locale/{zh,en,de,es,fr,pt,ru}.json`：只含 `meta.*` / `nav` / `setting.*` / `costPill.*`；② `client.js` 内嵌 7 语字典 `zh/en/de/es/fr/pt/ru`，经 `ctx.locale.register(NS,…)` + `t()` 使用 | `locale/zh.json:1-38`；`locale/en.json:1-38`；`client.js:3252,3448,4888,4910-4913` |
| 安装方式 | desktop profile 以 `link:` 指向本工作区（非拷贝），无构建产物 | `~/.dsh/profiles/desktop/package.json:7`；`pnpm-lock.yaml:17-19` |
| 运行版本 | 当前 host run 始于 2026-11-27 17:52+08（09:52Z），晚于 a578abc(13:27) 与 v2.8.1(17:25)，日志显示 `registered smart adapter with 8 chain keys` → 已加载 9-id 代码 | `~/.dsh/logs/desktop-next-2026-11-27.0.jsonl:473-474`；`git log` |

### 1.2 Git 状态与最近提交
- `## master...origin/master`，**存在大量未提交改动**：`client.js`、`index.js`、`lib/remote.js`、`lib/routing.js`、README/CHANGELOG、7 份 `docs/DETAIL*.md`、多个 test；未跟踪 `lib/position-snapshot.js`、`marketplace/`、5 份调研报告、`RELEASE.md`。
- `locale/*.json` **无改动**（`git diff -- locale` 为空）；`lib/tier-ids.js`、`lib/adapter.js`、`lib/chains.js` **均无未提交改动**。
- 关键提交：`a578abc` feat(router): 组合式虚拟档位 id（模型档 × 思考强度）→ `9f50b71` v2.8.0 → `d5f9196` 设置页修复 → `20d46cf` v2.8.1。**虚拟模型/强度的数据契约自 a578abc 起未再改动**。

### 1.3 虚拟模型的定义、枚举与显示链路
| 环节 | 代码 | 值 |
|---|---|---|
| 模型档枚举 | `lib/tier-ids.js:13` `MODEL_TIERS` | `['auto','cost','balanced']`（3 个，无效率/速度档） |
| 档位显示名 | `lib/tier-ids.js:15` `TIER_NAMES` | `{auto:'智能档', cost:'省钱档', balanced:'平衡档'}`（中文硬编码；注释明确 "NOT locale keys"） |
| 强度枚举 | `lib/tier-ids.js:17` `EFFORT_IDS` | `['off','medium','high']`（3 个，**无 auto**） |
| 强度显示名 | `lib/tier-ids.js:19` `EFFORT_NAMES` | `{off:'关闭', medium:'均衡', high:'高'}`（中文硬编码） |
| 组合 id | `lib/tier-ids.js:21-24` `TIER_IDS` | 3×3=9：`auto/off`…`balanced/high` |
| 显示名拼装 | `lib/tier-ids.js:62-66` `tierDisplayName` | `Smart 智能档 · 均衡强度` 等（`Smart ` 前缀 + 档名 + ` · ` + 强度名 + `强度`） |
| 解析 | `lib/tier-ids.js:44-54` `parseTierId` | 只接受 `MODEL_TIERS` × `EFFORT_IDS`；`auto/auto`、`speed/…` 均返回 `null` |
| 强度→真实 effort | `lib/tier-ids.js:27-31,93-98` | `off→[off,none]`、`medium→[medium,low]`、`high→[high,max]`，取首个受支持值；不支持返回 `undefined`，**不 clamp、不伪造** |
| chain key 派生 | `lib/adapter.js:76-84` `withTierChains` | 仅当基础档 key 存在且非空时，才派生 `<tier>/<effort>` key |
| catalog 出口 | `lib/adapter.js:338-355` `listModels` | 遍历 `TIER_IDS`，`if (!Object.hasOwn(this.chains, id)) continue`（`:346`）→ 只列出有 chain key 的组合 id；`name` 取 `tierDisplayName` |
| 请求注入 | `lib/adapter.js:608-642` `stream` | `parseTierId(options.model)` → `supportedEfforts` → `mapEffort` → `{...options, reasoningEffort: effort}`（`:641`）；失败返回 `UNSUPPORTED_REASONING_EFFORT`（`:634`） |
| 任务分类消费 | `lib/routing.js:155-160` `classifyTask` P3 | 非 `off`/`none` 的 effort 只作为二元 `reasoning` 信号，**不决定强度** |
| 设置页镜像 | `client.js:660-679` | `MODEL_LABELS`；`TIER_LABELS={auto:'智能档',cost:'省钱档',balanced:'平衡档'}`；`EFFORT_LABELS={off:'关闭',medium:'均衡',high:'高'}`；`tierIdLabel` 拼 `Smart X档 · Y强度`（`:674-678`）；`modelLabel`（`:679`）用于 `modelOptions`（`:1222-1229`） |
| 过滤 | `client.js:1214` `VIRTUAL_PROVIDERS = new Set(['smart'])` | `smart` 从 provider 下拉（`:1218`）、hop 模型下拉（`:1226`）、免费列表（`:995-996`）中排除；设置页仅以 `pi.smartTag` 标签可见（`:3306` zh / `:3502` en） |
| Provider 身份 | `index.js:323`；`lib/adapter.js:311-313` | 只注册**一个** provider `smart`，`providerInfo().name='Smart Gateway'`；日志 `declared smart configurable provider (Smart Gateway)` |

**当前实际会显示什么（按已安装配置推算，非截图）**
- 已安装 config（`~/.dsh/profiles/desktop/cordis.patch.yml:1609-1630`）的 chains key：`auto`、`hy4-flash-free`、`hy4flash-free`、`hy4-flash-free-trial-202611`、`web-search-free`；`ranking.strategy=cost-first`、`routing.strategy=cost-first`。
- `withTierChains` 只为 `auto` 派生 `auto/off|medium|high` → 加上 5 个基础 key = 8 个 chain key，**与日志 `with 8 chain keys` 完全吻合**。
- `listModels()` 只遍历组合 id，因此对外目录恰好 **3 个虚拟模型**：`auto/off`、`auto/medium`、`auto/high`，显示名：
  1. `Smart 智能档 · 关闭强度`
  2. `Smart 智能档 · 均衡强度`
  3. `Smart 智能档 · 高强度`
- 显示入口：DSH 宿主统一的模型选择器（`/model`、`session.modelCatalog()` 中 `group==='smart'` 的条目，由 `SmartAdapter.listModels()` 提供）。插件自己的设置页**不列出**这些条目（被 `VIRTUAL_PROVIDERS` 过滤），只在总览显示 `Smart Gateway` 标签（`client.js:3306/3502`）。
- 三种语言下这三个名字都是中文（硬编码），en 界面同样显示中文。

### 1.4 虚拟思考强度现状
- 数量：**3**（`off/medium/high`），不是 5；没有 `auto` 选项（`lib/tier-ids.js:17`）。
- 默认值：**没有强度默认值**。强度只能作为组合 id 的后缀显式选择；单段 id（如 `auto`）表示「无强度」（`parseTierId` `:47-49`），`stream` 中 `parsed.effort` 为假时不注入任何 `reasoningEffort`（`adapter.js:625`），即保持调用方/宿主原值。
- `auto` 的现有含义是**模型档** `auto`（智能档），与强度无关；把 `auto` 当强度段会解析失败（`parseTierId('auto/auto')===null` → `UNKNOWN_MODEL`）。
- 联动：`auto → 具体强度` 的映射**不存在**。现有 `mapEffort()` 只是「手动强度档 → 受支持 effort 值」的映射；`classifyTask` 的 P3 只把 effort 当路由分类信号。设计文档明确记录「智能档内自动判断」未实现、自动化上限为 0（`.agents/plans/2026-11-27-virtual-model-tiers.md:152,175`；`2026-11-27-reasoning-tier-deep-dive.md:158,168`）。

### 1.5 默认选中项（用户补充规格：默认虚拟模型 = 「智能」）
| 层 | 当前默认值 | 配置/代码位置 | 与期望「智能」是否一致 |
|---|---|---|---|
| 插件数据契约默认链 key | `auto`（智能档） | `lib/chains.js:22` `DEFAULT_CHAINS={auto:[]}`；`index.js:381-387`（无用户 chains 时把发现结果写进 `chains.auto`） | 语义一致（`auto`=智能档），但**不是单一「智能」模型**，而是 `auto/off|medium|high` 三个变体 |
| 客户端静态默认链 | `auto` 排在首位 | `client.js:635-645` `STATIC_DEFAULT_CHAINS` | 同上；且强度无默认 |
| 文档口径 | `smart/auto` 是默认模型 | `README.md:45,24`；`docs/DETAIL.md:9,5`；`docs/两交付物补救方案.md:52,157` | 文档写的是**旧单段 id** `smart/auto`，当前 catalog 已无该单段 id（只有组合 id），文档漂移 |
| 设置页首屏默认策略按钮 | `balanced`（均衡）排第一 | `client.js:1000-1004` `choices`；`t('preset.balanced')` 在 `:3317` | 这是策略预设按钮，不是虚拟模型默认选中；与「默认智能」口径不一致 |
| 已安装用户配置（真实生效） | `ranking.strategy=cost-first`、`routing.strategy=cost-first`（省钱优先） | `~/.dsh/profiles/desktop/cordis.patch.yml:1631-1640` | 与「默认智能」不一致（用户个人配置偏向省钱；代码默认本身是中立 balanced） |
| **宿主级默认模型（实际会话默认值）** | `provider: x-opencode-free, model: hy4-flash-free` | `~/.dsh/profiles/desktop/cordis.patch.yml:5-10`（`agent-default-model` 插件行） | **不一致：默认压根没有选中任何虚拟模型**，直接落到真实免费路由。README「已设为默认模型」的说法已过期。【后续已落盘 smart/smart：provider: smart、model: smart（单段 catalog id），强度走 defaultEffort 默认 auto；smart/auto 只是内部组合 id，不是 profile 里填的值。见本轮文档。】 |
| 强度默认值 | 无 | `lib/tier-ids.js:17,44-54`；`lib/adapter.js:625`（`parsed.effort` 为空则不注入） | 期望默认 `auto`，当前无强度默认值概念 |

> 说明：host 启动日志与链 key 数（8）证明 9-id 代码已加载（`~/.dsh/logs/desktop-next-2026-11-27.0.jsonl:474`），但「默认模型」属于 `agent-default-model` 插件的配置，不在本包 `schema.js` 的 12 个 key 内，所以修本包源码不会自动改变会话默认模型。

---

## 2. 期望 vs 实际对照表

### 2.1 第一组：虚拟模型（期望 4 个）
| # | 用户期望 | 建议内部 id | 当前实现 | 当前显示名（zh，硬编码） | 当前是否实际出现 | 差异 |
|---|---|---|---|---|---|---|
| 1 | 均衡 | `balanced` | `balanced` 档存在 | `Smart 平衡档 · {关闭/均衡/高}强度` | **否**（已安装 config 无 `balanced` chain key，`adapter.js:346` 跳过） | 名称「平衡」≠「均衡」；被拆成 3 个强度变体；且英文无译名 |
| 2 | 省钱 | `cost` | `cost` 档存在 | `Smart 省钱档 · {关闭/均衡/高}强度` | **否**（无 `cost` chain key） | 名称多 `Smart ` 前缀、`档` 与 `强度` 后缀；数量 3≠1 |
| 3 | 效率 | `speed` / `swift` | **不存在** | — | 否 | 完全缺失。`swift` 仅是路由位置标签（`lib/routing.js:23,73`，且「never auto-derived」）；`speed-first` 只是策略预设（`client.js:620` / `lib/ranking.js:53`），不是虚拟模型 |
| 4 | 智能 | `auto` | `auto` 档存在 | `Smart 智能档 · {关闭/均衡/高}强度` | **是**（唯一实际出现的档，3 条） | 名称不符；3 个变体≠1 个模型；强度「均衡」与期望的模型名「均衡」撞名 |
| 5 | **默认选中「智能」** | `auto` 作为默认链 key | `auto` 档存在，无单选默认值 | `Smart 智能档 · …强度`（3 个变体） | 插件侧「自动发现」默认落 `auto`；**宿主级默认却是 `x-opencode-free/hy4-flash-free`，未选虚拟模型** | 语义部分一致，形态与宿主配置不符；设置页首屏第一按钮是 `balanced` 而非「智能」。【后续已落盘 smart/smart：provider: smart、model: smart（单段 catalog id），强度走 defaultEffort 默认 auto；smart/auto 只是内部组合 id，不是 profile 里填的值。见本轮文档。】 |
| — | 合计 | 4（含默认项） | 3 档 × 3 强度 = 上限 9，实际 3 | 中文自由文本，无 i18n | 3 | 数量、语义、命名、文案、默认值形态全不符 |

### 2.2 第二组：虚拟思考强度（期望 5 个 = auto + 4 手动）
| 期望项 | 期望语义 | 当前实现 | 证据 | 差异 |
|---|---|---|---|---|
| `auto`（默认） | 根据所选虚拟模型自动决定强度 | **不存在**。单段 id 仅表示「不注入强度」；`auto` 被占用为模型档 id | `lib/tier-ids.js:17,44-54`；`lib/adapter.js:625` | 缺 1 项；无默认强度概念；`auto/auto` 会报 `UNKNOWN_MODEL` |
| 手动档 ×4 | 用户手动固定 4 档 | 仅 3 档：`off/medium/high`（关闭/均衡/高） | `lib/tier-ids.js:17-19` | 少 1 档；名称「均衡」与虚拟模型期望名冲突 |
| `auto` → 具体强度的联动 | 由所选虚拟模型推导（例如智能档→高强度、省钱/效率→关闭等，具体映射待用户确认） | **无此逻辑**。只有 `mapEffort`（手动档→真实 effort，首选+回退）与 `classifyTask` P3 二元信号 | `lib/tier-ids.js:27-31,93-98`；`lib/adapter.js:626-641`；`lib/routing.js:155-160` | 语义完全不同：当前没有「按模型决定强度」的路径 |
| 默认强度 = `auto` | 新建会话默认选 auto | 无默认强度；单段模型 id 表示不注入（`parsed.effort` 为空），调用方/宿主原值保留 | `lib/tier-ids.js:17,47-49`；`lib/adapter.js:625` | 缺默认值；且不存在 auto 枚举值 |

### 2.3 中英文文案对照（i18n 专项）
| 位置 | zh 当前 | en 当前 | 应有（需用户确认最终译名） | 问题 |
|---|---|---|---|---|
| 虚拟模型 `auto` | `Smart 智能档 · …强度`（`lib/tier-ids.js:15,62-66`；`client.js:672-677`） | **同为中文** | zh `智能` / en `Smart`（若无 en 值须回退英文） | 硬编码自由文本，未走 locale；`locale/*.json` 与 `client.js` 7 语字典都无对应 key |
| 虚拟模型 `cost` | `Smart 省钱档 · …强度` | 同为中文 | zh `省钱` / en `Economy` 或 `Cost-saving` | 同上 |
| 虚拟模型 `balanced` | `Smart 平衡档 · …强度` | 同为中文 | zh `均衡` / en `Balanced` | 同上，且「平衡→均衡」需改名 |
| 虚拟模型 `speed` | — | — | zh `效率` / en `Efficient` 或 `Fast` | 缺失，需新增 zh/en + 其余 5 语 |
| 强度 `off/medium/high` | `关闭/均衡/高`（`lib/tier-ids.js:19`） | 同为中文 | zh 4 手动档 + en 4 手动档（待定） | 硬编码；`medium` 的「均衡」与新模型名冲突 |
| 强度 `auto` | — | — | zh `自动` / en `Auto` | 缺失，需新增 7 语 |
| `locale/*.json` | 仅 `meta/nav/setting/costPill`（`locale/zh.json:1-38`） | 同结构（`locale/en.json:1-38`） | 需新增虚拟模型/强度文案键 | 两级 i18n 中，「设置页文案」走 `client.js` 内嵌字典，插件元数据走 locale JSON；名称两者都不覆盖 |
| 代码注释口径 | `lib/tier-ids.js:8,14,18` 明写 "never in t()/locale" / "free text only" | — | 规格反转后此约定必须撤销 | 设计层明确排斥 i18n，是修复时必须一并改掉的约束 |

---

## 3. 根因判断（逐一排除，带证据）

| 候选根因 | 判定 | 证据 |
|---|---|---|
| A. 数据定义错（枚举/配置） | **是（相对新规格）**。当前 3 档 ×3 强度是旧定稿；缺效率档、缺 auto 强度、少一个手动强度；显示名带「Smart/档/强度」 | `lib/tier-ids.js:13-24`；`.agents/plans/2026-11-27-combined-tier-ids.md:15,26-27,88,175-194` |
| B. 规格反转 / 设计文档冲突 | **是（根本）**。仓库定稿明确「不新增第 4 个模型维度」「全笛卡尔积 9 个 id」「不设 auto 强度」「中文只放 listModels.name、不进 t()/locale」；用户新规格全部相反 | `.agents/plans/2026-11-27-combined-tier-ids.md:15,23-27,36-38,65,105-109,298`；`.agents/plans/2026-11-27-virtual-model-tiers.md:149,225-229` |
| C. 硬编码 | **是**。名称在 `lib/tier-ids.js:15,19,62-66` 与 `client.js:672-677`，未走任何 locale/t() | 同上；`client.js:4888,4910-4913` 显示 t() 通道存在但未被这些名称使用 |
| D. locale 缺键/错键 | **不是成因，是修复缺口**。`locale/*.json` 没有虚拟模型/强度键；`client.js` 7 语字典也没有；这是 B 的直接后果 | `locale/zh.json:1-38`；`locale/en.json:1-38`；`client.js:3252-3447` 全文无 tier 相关 key |
| E. 过滤/映射逻辑错 | **不是**。过滤是刻意设计「smart 可见≠可选」（`VIRTUAL_PROVIDERS`），与显示不符无关；`mapEffort` 行为符合自身契约 | `client.js:1214,1218,1226,995-996`；`lib/tier-ids.js:93-98`；`lib/adapter.js:626-641` |
| F. 缓存 / 构建产物过期 | **排除**。插件是 `link:` 安装，无打包产物；host 启动晚于 a578abc；日志 8 chain keys 与当前源码推导结果一致 | `~/.dsh/profiles/desktop/package.json:7`；日志 `:473-474`；`git log` 时间 |
| G. 已安装版本与源码不一致 | **排除**。link 指向本工作区；profile patch 的 `smart-provider` 行与 `cordis.patch.yml` 一致 | `~/.dsh/profiles/desktop/cordis.patch.yml:1609`；`cordis.patch.yml:12-15` |
| H. 配置污染（chains key 缺失导致档位不出现） | **是（放大因素）**。即使代码有 3 档，已安装配置只给 `auto` 派生成功，所以用户只看到 3 条「智能档」；`cost`/`balanced` 档完全没有条目 | `lib/adapter.js:76-84,346`；`lib/chains.js:22,70-87`；`~/.dsh/profiles/desktop/cordis.patch.yml:1611-1626` |
| I. 文档漂移 | **是（次要）**。README/DETAIL 仍写 `smart/auto`、`Smart Auto (智能切换)`，与 9-id 中文名不一致 | `README.md:45,132`；`docs/DETAIL.md:9`；`docs/两交付物补救方案.md:52` |
| J. 默认选中项 | **是（部分一致 + 宿主层不一致）**。插件默认链 key 是 `auto`（智能档，语义对但形态错）；强度无默认值；宿主级默认模型是 `x-opencode-free/hy4-flash-free`，完全没有选中虚拟模型，与 README 宣称矛盾。【后续已落盘 smart/smart：provider: smart、model: smart（单段 catalog id），强度走 defaultEffort 默认 auto；smart/auto 只是内部组合 id，不是 profile 里填的值。见本轮文档。】 | `lib/chains.js:22`；`index.js:381-387`；`client.js:635-645,1000-1004`；`~/.dsh/profiles/desktop/cordis.patch.yml:5-10,1631-1640` |

**根因链**：用户新规格（4 虚拟模型 + 5 强度含 auto）→ 与仓库 2026-11-27 定稿设计（3 档×3 强度、拒绝第 4 档与 auto 强度、名称只放自由文本）冲突 → 数据契约 `MODEL_TIERS`/`EFFORT_IDS`/`TIER_NAMES`/`EFFORT_NAMES` 从源头就是旧规格 → 叠加已安装 chains 只有 `auto` key，仅 3 个「智能档」变体被列出 → 名称硬编码且 never-i18n 的旧约定使 en/zh 都显示中文 → 用户看到「完全不符」。

---

## 4. 修复文件清单（只列清单与理由，未动手改）

> 前置：先由用户确认 4 个虚拟模型的**内部 id/顺序**、4 个手动强度的**具体档位与中文/英译名**、`auto` 强度到 4 个模型的**映射表**，以及是否保留 9-id 兼容通道。之后按下列顺序改。

1. **`lib/tier-ids.js`** — 数据契约源头：把 `MODEL_TIERS` 改为 4 个均衡/省钱/效率/智能对应 id；把 `EFFORT_IDS` 改为 `auto` + 4 手动档，给 `auto` 默认值与「按虚拟模型决定强度」的纯映射函数；重写 `TIER_NAMES`/`EFFORT_NAMES`/`TIER_IDS`/`parseTierId`/`composeTierId`/`tierDisplayName`/`mapEffort`，撤销「中文只放自由文本、不进 locale」的约定（`:8,14,18`）。
2. **`lib/adapter.js`** — `withTierChains`(`:76-84`)、`listModels`(`:338-355`) 的枚举与 `Object.hasOwn` 门槛要跟新 id 对齐；`stream`(`:608-642`) 的 `auto` 强度解析/注入路径需新增（当前 `parsed.effort` 为空即不注入）；`imageRequestPricing`/`resolveModel` 的 `parseTierId` 消费点同步。
3. **`lib/chains.js` / `index.js`** — 若新增 `balanced`/`speed` 等模型档，需要默认链 key 或自动派生（目前 `DEFAULT_CHAINS={auto:[]}`、`discoverAutoChain` 只产 `auto`），否则 `listModels` 会静默跳过新档；`index.js:165-166,354-395` 的 chains 规范化/发现路径同步。
4. **`lib/routing.js`** — 若「效率」档要对应真实路由语义，需把 `speed`/`swift` 从「永不自动推导的位置标签」（`:23,73`）提升为可解析的模型档；`classifyTask` P3（`:155-160`）若 `auto` 强度要影响选路，需明确它不再只是二元信号。
5. **`client.js`** — 改 `TIER_LABELS`/`EFFORT_LABELS`/`tierIdLabel`/`modelLabel`(`:660-679`)；改 STATIC_STRATEGIES/ROUTING_PRESETS/首屏三按钮(`:603-626,1000-1004,3317-3319`) 与「均衡」术语冲突；在 7 语内嵌字典 `zh/en/de/es/fr/pt/ru`(`:3252,3448,…`) 新增虚拟模型名与强度名 key，并用 `t()` 渲染（`:4888,4910-4913`）。注意宿主模型下拉读的是 `listModels.name`，需决定名称的本地化载体。
6. **`locale/zh.json`、`locale/en.json`（及其余 de/es/fr/pt/ru）** — 新增虚拟模型与强度文案键，例如 `virtualModel.balanced/economy/efficiency/smart`、`virtualEffort.auto/off/low/medium/high`（实际键名按确认后的档位定）。zh/en 至少给出：`智能/省钱/均衡/效率`、`自动/关闭/…`；en：`Smart/Economy/Balanced/Efficient`、`Auto/Off/…`。`locale/*.json` 目前只服务插件元数据，若要让设置页也显示这些文案，必须同步写进 `client.js` 内嵌字典（第 5 项），两边都要改。
7. **`schema.js`** — 若 `auto` 强度需要用户可配置的默认映射，需新增配置 key（当前 12 key 无 effort 字段）；若 `auto` 完全由代码映射则可不改，但需同步测试里的「12 key」断言。
8. **测试** — `test/tier-ids.test.mjs`(`:20-38,46-56`)、`test/compaction.test.mjs`(`:65,202-232`)、`test/routing-tier.test.mjs`(`:249-251`)、`test/ranking.test.mjs` 等相关断言，从 9-id/3-effort 改为 4 模型/5 强度。
9. **文档** — `README.md`、`CHANGELOG.md`、`docs/DETAIL*.md`（7 语）、`.agents/plans/*.md`（尤其 `combined-tier-ids.md` 与 `virtual-model-tiers.md` 的「定稿」结论要标记为被新规格取代）；`marketplace/pengtang1024__dsh-smart-provider.yml` 的 zh/en 描述如提及档位也需同步。
10. **迁移口径** — 旧 `smart/auto/off|medium|high` 等 id 的历史会话/脚本兼容策略需文档化（当前 `parseTierId` 对单段 id 兼容，组合 id 改名后会失效）。
11. **默认选中项（含配置与文案）** — ① `lib/chains.js:22`、`index.js:381-387`、`client.js:635-645` 的默认链 key 与新「智能」模型 id 对齐，并把它设为唯一默认选中项；② `lib/tier-ids.js` 给强度加 `auto` 默认值与「按虚拟模型决定强度」的纯函数；③ `client.js:1000-1004` 首屏默认/第一按钮与 `preset.*` 文案（`:3317-3319`）对齐「智能」，并在 7 语字典 + `locale/*.json` 增补「默认：智能」/「Default: Smart」等文案；④ **宿主级默认模型配置** `~/.dsh/profiles/desktop/cordis.patch.yml:5-10`（`agent-default-model`）需从 `x-opencode-free/hy4-flash-free` 改为新的「智能」虚拟模型 id（这是 profile 配置改动，需用户授权，本调研未改）；⑤ `README.md:24,45`、`docs/DETAIL.md:5,9` 的过期默认模型声明同步更正。【后续已落盘 smart/smart：`provider: smart` / `model: smart`（单段 catalog id），强度走 `defaultEffort` 默认 `auto`；`smart/auto` 只是内部组合 id，不是 profile 里填的值。见本轮文档。】

---

## 5. 未确认项 / 限制

1. **用户未给出 4 个手动强度的具体档位与译名**，也未给出 `auto` 强度到 4 个虚拟模型的映射规则（例如「智能→高、效率→中、均衡→中、省钱→关闭」只是猜测，代码与文档均无依据）。这是修复前必须确认的第一阻塞项。
2. **用户新规格的来源文档不在仓库内**：仓库 `.agents/plans/` 四份设计稿的定稿结论与新规格相反；无法判断是用户后来改主意，还是另有一份未入库的规格。需向用户/lead 确认以哪份为准。
3. **未做 GUI 视觉验证**：`plugin_manager list_plugins` 为只读调用但仍被权限策略拒绝（自动拒绝升级），无法用它核对插件状态；本报告的实际显示项由 installed config、`withTierChains`/`listModels` 源码推导，并与 host 日志 `8 chain keys` 交叉验证，但**未在截图上直接看到下拉内容**。
4. **浏览器端 client.js 有未提交改动**（18:29），host 启动于 17:52；设置页文案是否已热载最新 client 未验证（按 dsh-doc `host-plugin.md:75`，替换已安装 package 需重启；link 安装的 client 热载还依赖 `pnpm run dev:web` watcher）。虚拟模型目录由 host 侧 `lib/adapter.js`（无未提交改动）决定，不受此影响。
5. `health.virtualProviders`（README:319）只是健康拓扑的附加虚拟路由，**不是**虚拟模型目录的配置来源；已排除其影响。
6. 若要求 en/zh 显示的虚拟模型名完全不同（而非仅中英对照），需决定是改 `listModels.name` 为按 locale 动态取值，还是由宿主模型选择器做本地化——当前插件没有从 locale 反向注入 host catalog 的通道。
7. 默认模型存在两层：`agent-default-model` 的 profile 配置（当前指向真实路由）与插件自身的默认链 key（`auto`）。用户说「默认选中智能」到底指哪一层（新建会话的默认模型，还是设置页首屏的默认高亮）尚未确认；两层都要改的可能性最大，但 profile 改动超出本插件源码范围，需单独授权。

