# 可行性设计：组合式虚拟档位 id（模型档 + 思考强度）

- 日期：2026-11-27
- 目标版本：dsh-smart-provider v2.7.0（只读调研基线，file:line 以当前工作区为准；asar 行号指 `/opt/DSH NEXT/resources/app.asar`)
- 性质：**设计文档，不含实现代码**。只定契约、边界、映射规则与影响面；伪代码用于表达意图，不是可落地补丁。
- 边界：本轮只新增本文档；不改任何 `.js` / locale json / 测试 / 前三份文档。前三份均为只读收敛对象。
- 调研依据：前三轮只读调研（工作区 + DSH asar）+ 本轮对关键 file:line 的逐条回读。

---

## 0. 一句话结论（先行）

**可行，且推荐形态是：把思考强度编进虚拟模型 id，用两级路径段 `smart/<模型档>/<强度档>`（规范化解析，单段，不复用 `+` 后缀）——例如 `smart/cost/high`；对外只暴露受限组合（默认 catalog 固定 6 个 id = 3 基础档 + 3 个 high 变体，不做全笛卡尔积），组合 id 在插件内解析为「外层档位 key + 一个确切 effort 值」，链路由外层档位 key 承载，effort 在 `adapter.stream` 入口注入 `options.reasoningEffort` 后随 `...options` 原样透传，同时 `resolveModel` 仍按解析后的首跳返回真实模型能力声明供宿主校验与 UI 使用。** 不新增第 4 个模型维度、不新增注册、不改 schema 12 key、不新增策略 id。最大风险是「按确切模型校验 effort」与「虚拟档首跳不确定 / 会 failover」的张力，必须用「受支持集过滤 + 不支持即显式失败不伪造」的规则化解（§2.2 / §2.4）。

---

## 1. 用户决策与问题重述

### 1.1 本轮已确认的最终决策（不可推翻、不再论证）

1. **强度放哪一层**：用户明确选「档位直接组合强度，如 `smart/cost/high`」——思考强度编进虚拟模型/档位 id，一个 id 就是「模型档 + 强度」的完整组合，用户在模型选择位一次选完。
2. **否定「完全交给宿主原生」的理由（用户明确选）**：(a) 插件定位是统一管理所有提供商，强度也该在插件体系内；(b) 宿主强度菜单和选虚拟档位是两个割裂的入口。
3. **明确否掉「第四个独立虚拟档 reasoning」**：那是把正交维度做成第四个模型的维度混淆。

因此，本轮**不再把「交给宿主原生」或「纯手动第四档」列为推荐**，正面设计组合式 id 方案；这两条只作为「被本轮推翻的历史结论」出现在 §1.2 与 §4。

### 1.2 本轮推翻了前三份文档的哪个结论、为什么

| 文档 | 被推翻的结论 | 推翻理由（本轮用户决策） |
|---|---|---|
| `2026-11-27-virtual-model-tiers.md` §2.5 / §4.1 | 推荐「第四个固定虚拟模型 `reasoning`（深度思考档）」作为思考能力的唯一暴露形态 | 用户明确指出这是把「强度」这个正交维度做成第 4 个模型的维度混淆；正确做法是把强度编进每个模型档的 id 里 |
| `2026-11-27-reasoning-tier-deep-dive.md` §0 / §5.1 | 「维持第四档 reasoning 手动档 + A′ `+reasoning` 后缀」为最优；否定一切自动/组合方案 | 同上；该文档 §4 的方案④把「组合式虚拟模型」列为反方案，本轮被用户决策直接反转——组合式成为目标方案，但必须避开它当时列出的维度混淆陷阱（见 §2.1 对 `+` 后缀的裁决） |
| `2026-11-27-reasoning-effort-orthogonal.md` §0 / §3 方案① / §4 | 「思考强度交给宿主原生 `reasoningEffort`，插件零 UI / 零配置 / 零虚拟模型，0 行代码」为推荐 | 用户明确指出两个入口割裂（模型档在插件虚拟模型位、强度在宿主强度菜单），且插件定位是统一管理所有提供商；强度必须在插件内与模型档合成一个选择位。其 §3 方案④「组合式虚拟模型」被否决的理由中，只有「维度混淆 / `+` 后缀破 P0 白名单」部分仍然成立并被本设计继承，「组合数爆炸」部分由 §2.5 的受限组合化解 |

> **仍然成立、必须继承的事实与边界**（前三份调研没有错，错的是结论落点）：
> - effort 端到端透传确凿：`lib/adapter.js:691-695` 的 `{...options, provider, model}` 原样带走 `reasoningEffort`；宿主按确切模型 `reasoning.efforts` 校验（asar `1911795-1800, 1918625-8630`），底层 pi-ai / DeepSeek / Codex 各自写进请求体（asar `1901945, 1894126-4132, 1718130`）。
> - 取值**没有全局枚举**，由确切模型能力声明决定（pi-ai 全集 `off/minimal/low/medium/high/xhigh/max`，DeepSeek `off/low/high/max`，Gemini `minimal/low/medium/high`，线级 sentinel `none`）。这是 §2.2 映射规则的根本约束。
> - 宿主把强度菜单挂在确切模型的能力声明上（asar `603190, 603219, 61211-61220`）；虚拟提供商 `resolveModel` 首跳缺失或无 reasoning 元数据时宿主不显示强度菜单（`lib/adapter.js:373-390`）——这正是用户要插件自己接住强度的现实原因，也说明组合 id 下 `resolveModel` 必须继续返回确切首跳元数据（§2.4）。
> - 插件当前从不设置 effort：`schema.js:28-71` 12 key 无 effort 字段，`lib/adapter.js` 全文无对 `reasoningEffort` 赋值。
> - 路由层 P3 只把 effort 当「非 none 即 reasoning」二元信号（`lib/routing.js:155-158`）；用 `'none'` 判关而 DSH 规范 off 值是 `'off'`，`'off'` 会被误判成 reasoning（已记录缝隙，本设计不擅自修）。
> - hint-not-fix 硬边界：`test/routing-tier.test.mjs:179-185`（无标签不伪造档）、`:248-249`（none→general、high→reasoning）。
> - `+tag` 是 P0 显式能力信号，白名单 `POSITION_TAGS = [thrifty, swift, reasoning, longctx, vision, tool, general]`（`lib/routing.js:22-24, 133-140`），`POSITION_TAGS.includes('high')` 为 false，`+high` 不进 P0 分支。

### 1.3 问题重述

目标：在**不碰注册面 / schema / 远程方法 / 6 策略顺序 / 版本与七语字典冻结项**的前提下，让用户在模型选择位一次选完「模型档 + 强度」，且选出的 effort 真正作用到请求、仍通过宿主对确切模型的校验、不伪造能力、不炸出十几个模型。核心难点见 §2 五项。

---

## 2. 五个技术难点逐项解答

### 2.1 难点 1：id 组合语法与解析

**推荐语法：`smart/<模型档>/<强度档>`（两级路径段，例如 `smart/cost/high`），不用 `smart/<模型档>+<强度>`（`smart/cost+high`）。**

理由（逐条对应约束）：

1. **避免与 `+tag` 显式能力信号冲突**：`classifyTask` 的 P0 用 `model.indexOf('+')` 截取后缀，只有后缀**精确包含在 `POSITION_TAGS`**（`lib/routing.js:22-24, 133-140`）才 return 为显式档。`+high` / `+medium` 都不在白名单里，严格说**不会**被误当 tag；但它会停在 P0 分支外、继续走 P1~P6，语义上「像 tag 又不是 tag」——调试者极易误读。更关键的是，`<档>/<强度>` 这种写法未来若要与 `+reasoning` 能力标签叠加，会变成 `smart/cost/high+reasoning`，`+` 仍是干净的能力后缀通道，两级路径段与能力标签**各占一个语法位**；而 `cost+high+reasoning` 会让 `indexOf('+')` 截取到 `high+reasoning`，直接失配白名单。**路径段语法保留了 `+` 的语义纯度。**
2. **与宿主 model id 的解析兼容**：虚拟 provider 是 `smart`，宿主把 `{provider:'smart', model:'cost/high'}` 传给 `SmartAdapter.resolveModel` / `stream`（`options.model` 不含 provider 前缀，前缀在 `options.provider`）。`/` 是 id 内的普通字符：`resolveChain` 对未知外层 id 用 `indexOf('/')` 拆成 `{provider: 'cost', model: 'high'}`（`lib/chains.js:110-115`）——这是**必须堵住的陷阱**（见难点 3 / §2.3：组合 id 必须有显式 chain key，不能落到这条 vendor/model 兜底）。相对地，`+` 已被 P0 消费为特殊语法位（虽然对 `high` 不命中），占用它会让 id 语法与路由语法耦合。
3. **UI 展示可控**：`listModels` 的 `name` 字段是自由文本（`lib/adapter.js:328` 当前是 `Smart / <id>`），可渲染成 `Smart 省钱档 · 高强度`（`smart/cost/high`），用户在一个下拉里看到完整语义；不需要第二套强度控件。id 本身保持 ASCII、小写、稳定，避免七语字典按 id 生成 key（id 不进 `t()`，文案进 `name`，由缓存/探测镜像透出）。
4. **解析规则要单一权威**：集中在一个纯函数 `parseTierId(model)`，供 `listModels` / `resolveModel` / `stream` / `#virtualContextWindow` 共同调用；不允许各处 `split` 出不同口径。

高层伪代码（仅示意契约）：

```
// 解析：model 是 options.model，形如 "cost/high" 或 "auto"
parseTierId(model):
  parts = model.split('/')
  if parts.length === 1:  return { tier: parts[0], effort: undefined }   // 兼容无强度旧 id
  if parts.length === 2 && 两段都在允许集合: return { tier: parts[0], effort: parts[1] }
  return null   // 非法组合：不猜测、不回退到 auto，交给 UNKNOWN_MODEL 明确失败

// 生成：listModels 枚举时
composeTierId(tier, effort) = effort ? tier + '/' + effort : tier
```

**语法裁决结论**：选 `smart/<档>/<强度>`。`+` 后缀继续专用于 `+reasoning` 能力标签（A′ 通道，保留给高级调用方），两者互不侵占。

### 2.2 难点 2（最难）：强度档命名 → ReasoningEffortId 的映射

**核心事实**：effort 取值**没有全局枚举**（asar `357305-306` 品牌类型 + `1900150-159 / 1894126-4132 / 705949` 各模型集合不同），且宿主按**确切模型**校验，不支持的值在 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（asar `1911795-1800, 1918625-8630`）。所以插件**不能**写死一套枚举然后到处塞——必须「按档位首跳的实际支持集」做映射与过滤。

**推荐规则：插件对外只暴露 3 个语义强度档 `off / medium / high`**，每个档是一个「首选 effort 值 + 有序回退列表」，映射时对照首跳能力声明取第一个受支持值；**不暴露 `minimal / xhigh / max`**（它们是模型特定细粒度档，暴露就要为每种模型做 N×M 组合，违背 §2.5 的规模约束）。中文 UI 文案用「关 / 中 / 高」，与 id 的 `off/medium/high` 一一对应，**不使用**与 DSH sentinel `'none'` 混淆的命名。

映射表（伪数据契约，非实现）：

| 插件强度档 | 首选 effort | 有序回退（该模型不支持首选时依次尝试） | 语义 |
|---|---|---|---|
| `off` | `off` | `none`（仅作线级 sentinel 兼容） | 关闭思考 |
| `medium` | `medium` | `low`（DeepSeek / Gemini 都有） | 中等强度 |
| `high` | `high` | `max`（DeepSeek 有）→ 仍不支持则放弃该档 | 高强度 |

- pi-ai 全集 `off/minimal/low/medium/high/xhigh/max`：三档首选全部命中，无需回退。
- DeepSeek `off/low/high/max`：`medium` → 回退 `low`；`high` → 命中。
- Gemini `minimal/low/medium/high`：三档首选全部命中。
- `'none'` 只在 `off` 档作为最后回退（它是线级 sentinel，不是标准 effort id）；**不**把 `'none'` 作为对外档名。

能力来源（同一份 `resolveModel` 首跳元数据）：`info.reasoning?.efforts`（asar `1911795-1800, 61211-61220`）。`listModels` 是同步、无 I/O 的（`lib/adapter.js:333-337` 注释），**不能**在那里 await 能力查询；因此支持集来自 `refreshDiscoveredChains()` 已缓存的路由模型元数据（`lib/adapter.js:341-354` 的 `this.routes`），与 contextWindow 同源——这是唯一不破坏「listModels 零 I/O」的来源。

**映射失败（首跳/路由缓存里查不到 reasoning.efforts，或三档没有一个受支持值）怎么办？明确规则，三选一，这里给出裁决：**

1. **不在 `listModels` 里伪造一个「看起来支持」的 id / 能力声明**（坚持 hint-not-fix 与「诚实降级」精神）。
2. **catalog 层**：某模型档首跳元数据未知时，该档**只暴露无强度后缀的基础 id**（`smart/cost`），不生成 `cost/off|medium|high`；UI 文案注明「该档当前无法确认思考强度支持，未列出强度变体」。换言之：**按需收缩，不按空集捏造**。
3. **请求层**：用户仍可能通过历史配置/脚本直接调用一个未列出的组合 id → `adapter.stream` 解析出 effort 后，若该 hop 的确切模型声明不支持它，**不静默 clamp**（不把 high 偷偷改 low），按既有失败分类 `UNSUPPORTED_REASONING_EFFORT`（`lib/chains.js:56-61` 把它列为 switchable code）走 failover / 明确失败，并把原因写进 hop 记录与 DSH 日志（`lib/adapter.js:611-614, 712-764`）。这与第三份文档 §5「不静默降级」结论一致。

伪代码：

```
mapEffort(tierEffort, supportedSet):
  candidates = EFFORT_FALLBACK[tierEffort]     // 表中首选 + 回退列表
  for e in candidates:
    if supportedSet.has(e): return e           // 取第一个受支持值
  return UNSUPPORTED                            // 不伪造、不 clamp

EFFORT_FALLBACK = { off:['off','none'], medium:['medium','low'], high:['high','max'] }
```

> 注意：这张映射表是**插件对外档名 → effort 值**的语义层，**不是**新策略 id、不是新 schema key；它可实现为 `lib/` 里的纯数据常量（实施阶段决定文件归属），冻结边界不受影响。`'off'` 被 P3 误判为 reasoning 的已知缝隙（`lib/routing.js:156` 判 `'none'`）在本设计下**仍需如实保留**：可在实施时评估「在注入点同时规范 P3 判定」，但本轮不改路由契约、只登记为风险（§3 / §6）。

### 2.3 难点 3：强度如何作用到请求——注入点与透传边界

**注入点裁决：在 `adapter.stream` 入口（`lib/adapter.js:576` 之后、`classifyTask` 之前）解析组合 id 并把 effort 物化到 `options.reasoningEffort`；然后保持 `lib/adapter.js:691-695` 的 `{...options, provider, model}` 原样透传不变。**

为什么不选 `resolveModel`：`resolveModel` 的职责是返回模型元数据（context / reasoning 能力声明），是宿主 UI 与校验的输入（`lib/adapter.js:373-390, 393-398`），不是请求参数的构造点；在它里面改 `options` 无处可放（签名没有 options）。也不选「改底层 provider 请求体」——那会侵入宿主/pi-ai。

高层伪代码（注入逻辑，注意顺序）：

```
// adapter.stream(options) 起始处，routing 块之前
const parsed = parseTierId(options.model)          // {tier, effort} | null
if (!parsed) -> 走既有 UNKNOWN_MODEL 失败路径（不猜测）
const outerModel = parsed.tier                      // 用于解析 chain / contextWindow
let injected = options
if (parsed.effort):
  const supported = supportedEffortsFor(outerModel) // 来自 routes 缓存的 reasoning.efforts
  const effort = mapEffort(parsed.effort, supported)
  if (effort === UNSUPPORTED) -> 明确失败/交给 failover，不 clamp
  injected = { ...options, reasoningEffort: effort } // ① 物化 effort

// ② 分类：classifyTask(injected, routing) —— P3 会把注入的 effort 当二元信号（既有行为，可接受）
// ③ chain：resolveChain(outerModel, this.chains) —— 必须用 outerModel，不是组合 id！
// ④ 透传：runtime.stream({ ...injected, provider: hop.provider, model: hop.model })
```

**两个必须守住的关键点：**

1. **chain 必须按 `outerModel` 解析，不按组合 id 原串**。当前 `resolveChain` 对未知外层 id 且含 `/` 时会拆成 `{provider: 'cost', model: 'high'}`（`lib/chains.js:110-115`）——组合 id `cost/high` 会被误当「provider=cost, model=high」，必然 UNKNOWN_MODEL。**解决方案：在 `this.chains` 构造阶段为每个暴露的组合 id 派生一条 chain key，指向基础档的 hops**（`this.chains = normalizeChains(chains)` 位于 `lib/adapter.js:179, 277`，派生发生在 normalize 之后、构造结束前；chains 配置本身与 schema 12 key 不动，派生是内存态）。这样 `resolveChain('cost/high', this.chains)` 走 `Object.hasOwn(chains, outerModel)`（`lib/chains.js:106`）命中，返回与 `cost` 相同的真实 hops。`#virtualContextWindow` 同样传 `outerModel`（或对派生 key 解析），继续走 `lib/adapter.js:338-355` 的首跳 + 128000 floor，不虚构容量。`imageRequestPricing`（`358-362`）也要用 `outerModel` 解析首跳。
2. **不破坏 `...options` 透传与 hint-not-fix 分类边界**：注入只覆盖 `reasoningEffort` 一个字段，其余 `options` 原样；`classifyTask` 仍是纯函数、仍只把 effort 当「有/无」二元信号（`lib/routing.js:155-158`，minimal 与 high 等价用于选候选档，**不影响强度本身**）。组合 id 不再靠 `+tag` 触发 P0（我们不生成 `+high` 这种 id），hint-not-fix 测试（`test/routing-tier.test.mjs:179-185, 248-249`）保持绿。注入的 effort 只作用于采样参数，不伪造 `reasoning` 能力标签、不改变 `selectTiers` 的 relax 语义。

**失败可见性**：下游模型拒绝 effort 时，错误码 `UNSUPPORTED_REASONING_EFFORT` 本就在 switchable 列表（`lib/chains.js:59`），失败分类/日志/hop 记录链路现成（`lib/adapter.js:611-614, 712-764`），本设计复用，不新增 UI 数据通道。

### 2.4 难点 4：组合 id 下的 contextWindow / resolveModel——让宿主仍拿到确切首跳能力

**原则：组合 id 只改变「外层档位 key 与 effort」，不改变「首跳解析目标」。** 所有元数据查询都按 `outerModel`（基础档）解析首跳，再向宿主返回真实模型的能力声明。

- `resolveModel(provider, model, signal)`（`lib/adapter.js:373-390`）：入口先把 `model` 经 `parseTierId` 拆成 `outerModel`；用 `resolveChain(outerModel, this.chains)[0]` 找首跳（`374` 改为按 `outerModel`），再 `runtime.resolveModelInfo(first.provider, first.model, signal)`（`382`）。返回的 `info` **原样展开**（`389` 的 `{...info, provider, id: model, context}`），因此 `info.reasoning.efforts`（asar `1918580-8622`）完整到达宿主——宿主可用它校验请求 effort、并在需要时渲染能力相关 UI。`id` 保留用户选的完整组合 id（宿主会话里记录的就是它），`provider` 仍是 `smart`。
- 首跳缺失 / `runtime.resolveModelInfo` 不可用（`375-380`）：返回带 `context.contextWindow = #virtualContextWindow(outerModel)` 的裸对象（`380`），**没有 reasoning 声明**——这是诚实的降级（宿主因此不显示强度菜单），与第三份文档 §1.4 一致；不伪造能力。
- `listModels(`smart`)`（`318-331`）：改为枚举「基础档 × 受支持强度档」的受限集合（§2.5），每个条目的 `contextWindow` 走 `#virtualContextWindow(outerModel)`（`338-355`，正整数否则 128000 floor `56`），与基础档同值。
- `prepareCall`（`393-398`）委托 `resolveModel` 与 `stream`，无需单独改；`imageRequestPricing`（`358-362`）按 `outerModel` 解析首跳。
- **verify**：宿主 `resolveCallConfig` 用 `reasoning.efforts` 校验 `options.reasoningEffort`（asar `1918635-8646, 1918505-8511, 1911795-1800`）；因为我们在 `stream` 注入的 effort 来自同一首跳声明（§2.2），校验一致；failover 到不支持模型时由真实 adapter 拒绝并按 switchable code 处理（`lib/chains.js:59`），不静默降级。

### 2.5 难点 5：档位集合规模——受限组合，不做笛卡尔积

**推荐：3 个模型档 × 2~3 个强度档 = 6~9 个虚拟模型（上限 9，典型 6），只暴露「有意义/受支持」的组合。**

模型档沿用前三份已收敛的三档（`2026-11-27-virtual-model-tiers.md` §2.1）：

| 模型档（外层 key） | 档位名 | 两层 preset（写入语义，复用现有 id，不新增策略） |
|---|---|---|
| `auto` | 智能档 | `balanced` + `balanced`（默认自动选档） |
| `cost` | 省钱档 | `cost-first` + `cost-first` |
| `balanced` | 平衡档 | `balanced` + `balanced` |

强度档：`off` / `medium` / `high`（§2.2）。

**暴露规则（受限组合，两条剪枝）：**

1. **基础 id 保留**：每个模型档始终保留无强度后缀的 `<档>`（如 `smart/cost`），语义 = 不注入 effort（等价「让宿主/调用方决定」，兼容历史调用与 A′ `+reasoning` 通道）。这保证「用户要几个档位」的朴素心智仍在：列表里首先看到 `auto / cost / balanced` 三个基础档。
2. **强度变体按需生成**：只为「首跳能力声明里能映射出该强度档值」的模型档生成 `<档>/<强度>`（`off/medium/high`）。查不到 `reasoning.efforts` 的模型档**不生成任何变体**（§2.2 规则 2），UI 注明原因。典型结果 = 3 基础 + 3×3 变体 = 12？**否**——为守住「别炸成十几个」，进一步裁决如下：

> **规模裁决（明确一个数字）**：对外 catalog **固定 6 个主推 id** = 3 基础档 + 3 个「高强度」变体（`auto/high, cost/high, balanced/high`）；`off` / `medium` 变体**不进默认 catalog**，作为「能力可用但按需启用」的次要组合，仅在用户显式配置/高阶入口时按 §2.2 规则生成（不新增 schema key——借用既有 `chains` 外层 key 的派生规则表达，或作为文档级高级通道，实施阶段定）。这样默认下拉 = 6 个 id，符合「几个档位」的诉求；高强度是唯一高频需要显式强度的场景， off/medium 不在默认下拉（基础档保持不注入 effort 以兼容既有调用方，高阶按需通道见 §2.2；默认下拉里一次选完的显式强度入口是 high 变体）。

**理由**：全笛卡尔积（3×4~7 = 12~21）会重演「目录里一串模型」的老问题（第一份文档 §1.1 的痛点）；而只暴露有意义的组合，既满足用户「一次选完」的决心，又让 catalog 数量稳定可测。健康/虚拟副本隔离（`test/health.test.mjs:554-576`）、`VIRTUAL_PROVIDERS` 过滤（`client.js:1162`）按 id 前缀/集合工作，6 个固定 id 不会破坏其去重语义。

---

## 3. 与冻结边界的冲突清单

### 3.1 会红、必须同步的测试（可回读证据）

| 测试 | 红的原因 | 同步方式（实施阶段，本轮不改） |
|---|---|---|
| `test/compaction.test.mjs:56-68` | fixture chains 含 `fast` 别名（:58），断言 `byId.get('fast').contextWindow===200000`（:64）与全部 provider=smart（:65-67）；档位收敛后 `fast` 不再枚举 | 改 fixture/断言为「固定档位集合（含组合 id）+ 无 `Smart / xxx`」；继续断言每档 contextWindow 是正整数且来自首跳缓存或 128000 floor（:71+ 的 floor 回退保持绿） |
| `test/free-ui-chain.test.mjs:172-265`（I18N-2/3/4） | 若客户端为组合 id 新增档位 label 的 `t()`/`fmt()` key 而未同步 7 份字典，静态 key 子集 / key 集合一致 / 占位符一致三项全红 | 优先把组合 id 的展示放进 `listModels.name`（自由文本，不进 `t()`），从源头避免新 key；确需新增则一次同步 zh/en/de/es/fr/pt/ru，占位符一致 |
| `test/routing-tier.test.mjs:248-249`（条件性） | 若实施时顺手修 `'off'` 哨兵缝隙（P3 判 `'none'`），`classifyTask({reasoningEffort:'off'})` 结果会变，可能影响现有断言 | 本轮**不修**该缝隙、保持现状以守绿；如单开任务修，须同步更新该测试的期望值 |

### 3.2 必须保持绿（碰到即视为越界）

| 测试 / 约束 | 锁死内容 | 守住方式 |
|---|---|---|
| `test/loading.test.mjs:24-28` | inject 恰好 `['llm']` | 不新增 inject；组合解析是 adapter 内部纯逻辑 |
| `test/loading.test.mjs:34-37` | config 恰好 12 key（`schema.js:28-71` 已回读） | **不新增 effort 配置 key**；强度编码在 id 里，映射表是纯数据常量 |
| `test/loading.test.mjs:47-56` | remote 恰好 7 方法 | 不加远程方法 |
| `test/ranking.test.mjs:52-54` | 6 策略 id 顺序 | 档位复用 `balanced / cost-first / reasoning-first` 等现有 id，不新增第 7 个 |
| `test/free-ui-chain.test.mjs:158-165` | 版本三处一致（2.7.0） | 不 bump 版本 |
| `test/health.test.mjs:554-576` | virtualProviders 含 smart + 追加去重 | 组合 id 仍 provider=smart，虚拟副本隔离保留 |
| `test/custom-routes.test.mjs:148-170` + `cordis.patch.yml:3-6` | patch 不声明 smart（DUPLICATE_ADAPTER） | 不动注册面；`index.js:310` 仍只注册 1 个 smart adapter，`index.js:407-412` 仍只声明 1 条 configurable provider |
| `test/routing-tier.test.mjs:179-185` | reasoning-first 是 hint 非 fix，无标签不伪造档 | 组合 id 不用 `+tag`，不改 `selectTiers` 回退语义；effort 注入只作用于采样参数 |
| `test/compaction.test.mjs:71+` | floor 回退 | `#virtualContextWindow`（`lib/adapter.js:338-355`）与 floor 常量（:56）不动 |

### 3.3 会被触碰的实现点（均非冻结项，列出以免遗漏）

- `lib/adapter.js`：`listModels`（318-331）、`#virtualContextWindow`（338-355）、`imageRequestPricing`（358-362）、`resolveModel`（373-390）、`stream` 入口（576 前）与 `runtime.stream` 调用（691-695 保持透传形态）、`this.chains` 派生（179 / 277 之后）。
- `lib/chains.js` 的 `resolveChain`（95-118）：不改函数契约，靠「派生 chain key」让组合 id 命中 `Object.hasOwn`（106），避免落入 `vendor/model` 兜底（110-115）。
- `lib/routing.js`：不改；组合 id 不含 `+`，P0（133-140）不误触发；P3（155-158）仍只读二元信号。
- 客户端 `client.js`：`session.modelCatalog()` 的 smart 镜像（约 2952-2963）与 `VIRTUAL_PROVIDERS`（1162）按 catalog 自动呈现组合 id；尽量只靠 `name` 文案，不新增 `t()` key。
- `schema.js`：不动（12 key 冻结）。

---

## 4. 对前三份文档的收敛修订建议（只建议，不直接改）

> 共同的总纲：三份的**事实底座正确、结论落点被本轮用户决策推翻**；修订时保留事实与边界，替换「推荐形态」，并互相交叉引用本设计，避免四份文档互相打架。

### 4.1 `.agents/plans/2026-11-27-virtual-model-tiers.md`

- **§1.3 成功标准 1**：从「基础三档 + 第四档 = 4 个」改为「三模型档 + 受支持强度变体，默认 catalog 6 个固定 id（3 基础 + 3 high 变体），不随 chains 增长」，引用本设计 §2.5。
- **§2.5 专节**：结论从「推荐方案①（第四档 reasoning 虚拟模型）」改为「**否决独立第四档**（维度混淆，用户 2026-11-27 最终决策）；思考强度改为编入档位 id，见本设计 §2.1/§2.2」；保留该节对「自动化信号为零 / hint 非 fix / 不做什么」的事实段（本设计继承）。
- **§4.1 推荐方案表**：删去 `reasoning` 一行；新增 `<档>/high` 等组合 id 行；写明「智能/平衡同构」说明继续有效。
- **附录 A-3**：第四档结论替换为组合 id 映射（基础档 → preset 不变；强度档 → effort 映射见本设计 §2.2）。

### 4.2 `.agents/plans/2026-11-27-reasoning-tier-deep-dive.md`

- **§0 / §5.1 的推荐**：从「维持第四档手动 + A′」改为「维持『不自动判断、只走显式通道』的**事实结论**，但显式通道的推荐形态更新为组合式 id（用户最终决策）；A′ `+reasoning` 降级为不占用 `+` 语法位的高级兼容通道」。
- **§4 方案表**：把方案④「组合式虚拟模型」从「明确否决」改为「本轮采纳，但只采纳路径段语法 `/`、不采纳 `+` 后缀；组合数由 §2.5 受限集合约束」；B/C/E/G 的否定结论保留。
- **§5.2 关系表**：新增一行「本轮反转：正交维度不新建第 4 个模型，而是与模型档组合成 id（本设计）」。
- **§8 拍板项 1**：标记为「已拍板：推翻 A，改组合式 id」；其余拍板项保留但注明归属本设计 §6。

### 4.3 `.agents/plans/2026-11-27-reasoning-effort-orthogonal.md`

- **§0 / §3 方案① / §4**：从「交给宿主原生、插件 0 行代码」改为「**用户推翻两个入口割裂的方案**：强度需在插件体系内与模型档合成一个选择位；本文关于『透传确凿 / effort 无全局枚举 / 宿主按确切模型校验 / 首跳缺失不显示菜单 / off 哨兵缝隙』的事实段全部保留，作为本设计 §2.2/§2.4 的依据」。
- **§2 正交模型图**：把文字图更新为「二维正交被投影为一维组合 id」的新图（`smart/<档>/<强度>`），保留「off/minimal/... 全集属确切模型」的注记。
- **§3 方案④**：从「反方案」改为「目标方案（本设计），但避开其历史否决理由中的 `+` 后缀与组合爆炸两个陷阱」。
- **§6 拍板项 1/3**：标记为「已拍板：否掉宿主原生与第四档，选组合式 id；前两份简报按本设计 §4.1/§4.2 收敛」。

---

## 5. 实施计划大纲 + 里程碑 + 风险缓解表

### 5.1 高层步骤（不含代码）

1. **冻结契约**：确认组合 id 语法（§2.1）、强度档 → effort 映射表（§2.2）、注入点（§2.3）、首跳能力透传（§2.4）、默认 6 个 id 的暴露规则（§2.5）；产出本设计评审结论。
2. **纯函数层**：实现 `parseTierId` / `composeTierId` / `mapEffort` 与能力集读取（来自 routes 缓存），单测覆盖合法/非法组合、三模型不同支持集、映射失败。
3. **adapter 接线**：`this.chains` 派生组合 key；`listModels` 枚举受限集合；`resolveModel` / `#virtualContextWindow` / `imageRequestPricing` 改按 `outerModel` 解析首跳；`stream` 入口注入 effort，保持 `691-695` 透传形态。
4. **UI/镜像同步**：组合 id 的 `name` 文案（不新增 `t()` key 为首选）；设置页 smart 镜像、虚拟副本过滤、标签照旧；旧 `Smart / xxx` 与 `+reasoning` 的迁移/兼容口径写进文档。
5. **测试同步**：按 §3.1 改写必红项；按 §3.2 复核所有冻结项；新增组合 id 的解析/映射/透传单测。
6. **门禁与回归**：lint/build/test/i18n 全绿；回归 cost/free/health/discovery 四链路与「effort 真到请求体」的端到端证据；精确 commit，不 push；确认无临时文件残留。

### 5.2 里程碑

- **M1 — 契约冻结**：语法 / 映射 / 注入点 / 暴露规则评审通过；§6 拍板项关闭；无代码改动。
- **M2 — 纯函数 + adapter 接线**：解析/映射单测绿；组合 id 可解析到基础 chain、effort 注入后透传、`resolveModel` 返回确切首跳能力；必红测试同步。
- **M3 — 全量门禁与收尾**：lint/build/test/i18n 全绿；冻结项复核；文档收敛建议（§4）获用户确认后由各文档 owner 分别修订；精确提交，不 push。

### 5.3 风险缓解表

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 组合 id 落入 `resolveChain` 的 `vendor/model` 兜底（`lib/chains.js:110-115`） | 高（若不派生 chain key） | 高（请求 UNKNOWN_MODEL） | 构造期派生组合 chain key 指向基础档 hops，走 `Object.hasOwn`（:106）；单测断言 `resolveChain('cost/high')` 与 `resolveChain('cost')` 等价 |
| effort 注入后宿主 / 下游拒绝（支持集不一致） | 中 | 中 | §2.2 映射按首跳 `reasoning.efforts` 过滤；不静默 clamp；`UNSUPPORTED_REASONING_EFFORT` 走 switchable failover（`lib/chains.js:59`）+ 日志/hop 记录（`adapter.js:712-764`） |
| catalog 炸成十几个 id，重演老问题 | 中 | 中 | §2.5 默认只 6 个（3 基础 + 3 high），能力未知不生成变体，off/medium 走高阶通道 |
| `listModels` 被改成异步查能力，破坏零 I/O | 中 | 中 | 能力集只从 `this.routes` 缓存读（`adapter.js:341-354`），与 contextWindow 同源；`listModels` 保持同步返回 Promise.resolve |
| `'off'` 被 P3 误判为 reasoning 的旧缝隙被放大 | 中 | 低 | 本轮不修路由契约，文档化；如单开任务修，同步 `test/routing-tier.test.mjs:248-249` 期望（§3.1） |
| 新增 label key 触动七语字典门禁 | 中 | 中 | 优先用 `listModels.name` 自由文本承载组合语义，不进 `t()`；确需新增则一次同步 7 语（`test/free-ui-chain.test.mjs:172-265`） |
| 前三份文档与本设计并存造成读者混淆 | 高 | 中 | §4 给出逐份收敛建议；三份事实段保留、推荐段标注「已被本轮决策取代，见本文档」；收尾由各 owner 分别改（本轮不改） |
| 虚拟副本隔离 / 版本 / schema / 6 策略等冻结项被误伤 | 低 | 高 | §3.2 逐条锁死；不新增 schema key / 策略 id / 远程方法 / 注册；不 bump 版本 |

---

## 6. 需要用户拍板的事项

1. **id 语法确认**：接受 `smart/<模型档>/<强度档>`（两级路径段，如 `smart/cost/high`），并保留 `+` 专用于 `+reasoning` 能力标签？（本文推荐：是；§2.1）
2. **强度档命名与集合**：接受对外三档 `off / medium / high`（中文「关 / 中 / 高」），不暴露 `minimal / xhigh / max`？（本文推荐：是；§2.2）
3. **映射失败策略**：接受「支持集里查不到就收缩目录 + 请求层显式失败、不静默 clamp / 不伪造能力」？（本文推荐：是；§2.2 规则 2/3、§2.4）
4. **默认 catalog 规模**：接受默认只暴露 6 个 id（3 基础 + 3 `high` 变体），`off / medium` 变体走高阶按需通道而非默认下拉？（本文推荐：是；§2.5。**这是「几个档位」体验的关键取舍，请明确拍板**。）
5. **注入点**：接受在 `adapter.stream` 入口注入 `options.reasoningEffort`、`resolveModel` 仍只负责能力声明透传？（本文推荐：是；§2.3/§2.4）
6. **`off` 哨兵缝隙**：本期只文档化（`lib/routing.js:156` 用 `'none'` 判关），还是单开任务修 P3 判定并同步 `test/routing-tier.test.mjs:248-249`？（本文推荐：本期只文档化，不扩大冲击面。）
7. **前三份文档的收敛执行**：是否授权在后续任务中按本文 §4 逐份修订（本轮只建议、未改）？由谁执笔？
8. **UI 文案载体**：是否接受组合 id 的中文展示只放进 `listModels.name`（不新增 `t()` key），从而不触动七语字典？（本文推荐：是；若要求多语化 label，则需同步 7 份字典，属另一任务。）

---

## 7. 本轮边界声明

- 未写任何实现代码（本文只有高层伪代码与文字规则）；未改任何 `.js` / locale json / 测试 / 前三份文档。
- 新增且仅新增本文档：`.agents/plans/2026-11-27-combined-tier-ids.md`。
- 所有代码事实来自 v2.7.0 工作区与 DSH asar 的只读复核；asar 行号指 `/opt/DSH NEXT/resources/app.asar` 的行地址。
