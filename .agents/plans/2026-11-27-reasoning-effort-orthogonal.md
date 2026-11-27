# 补充设计探讨：思考强度作为「与模型选择正交的维度」如何暴露与传递

> 本文是 `.agents/plans/2026-11-27-virtual-model-tiers.md` 与 `.agents/plans/2026-11-27-reasoning-tier-deep-dive.md` 的**正交性补充与纠偏**，不是它们的复述。
> 触发：用户纠正——「不是第四大（档），而是提供商。虚拟提供商解决的是模型选择，强度选择怎么办？」
> 本文只做设计探讨，**不写实现代码，不改任何 `.js` / locale / 测试 / 前两份设计简报**。
> 事实底座：v2.7.0 工作区（HEAD `2a8af3f`）+ DSH asar 只读声明（2026-11-27 复核）。

---

## 0. 一句话结论（先行）

**思考强度这个正交维度不需要本插件新造 UI、新造虚拟模型或新配置 key：它是宿主原生的 `GenerateOptions.reasoningEffort`，与模型选择正交地随同一请求走；本插件的虚拟提供商只负责「选哪个真实模型」，`reasoningEffort` 由 `lib/adapter.js:691-695` 的 `...options` 原样透传给底层 provider，真正改变 thinking budget——宿主的输入框/选择菜单已经是它的暴露入口，我们要做的是「不弄丢它 + 如实标注能力边界」。**

必须同时讲清两条决定性事实：

1. **透传是真的**：`reasoningEffort` 不是只被路由层当分类信号消费后丢弃，它到了底层模型 provider 的请求体（证据 §1.3）。
2. **但我们有条件**：宿主把「思考强度」菜单挂在**确切模型的 reasoning 能力声明**上；虚拟提供商的 `resolveModel()` 只在有首跳且能解析到元数据时，才把这份声明带出去（`lib/adapter.js:373-390`）。首跳缺失或元数据里没有 reasoning 时，宿主不会显示强度菜单——这不是 bug，而是「诚实：我们不知道这个虚拟档会落到哪个真实模型」。

因此走「复用宿主原生 effort」路线（方案① / 推荐），而不是「插件自建第四档」或「插件自建全局强度开关」。

---

## 1. 只读调研：reasoningEffort 的完整数据链路（文件:行号证据）

### 1.1 入口：GenerateOptions 的定义、取值、默认值、谁设置

| 问 | 答案 | 证据 |
|---|---|---|
| 定义来源 | DSH 原生包 `@deepseek-ai/dsh-llm`，打包在 `app.asar` 里；接口字段 `reasoningEffort?: ReasoningEffortId`，注释为「Adapter-owned reasoning effort selected for this exact model」 | asar `1920031-1936`；同一声明的 d.ts 字符串 `1912394`；品牌类型 `export type ReasoningEffortId = Branded<'ReasoningEffortId'>` `357305-306` |
| 取值 | **没有全局固定枚举**。类型是不透明品牌字符串，具体档位由**确切模型的能力声明**给出：pi-ai 的档位全集 `off, minimal, low, medium, high, xhigh, max` `1900150-159`；DeepSeek Messages 接受 `off, low, high, max` `1894126-4132`；Gemini 仅 `minimal, low, medium, high`（宿主文档 `705949`）。另有线级 sentinel `none`（`2516341`）。**取值随底层模型而变，这正说明它是模型正交维度、不能写死进插件的虚拟模型 id。** | 同上 |
| 默认值 | 模型/adapter 所有，不是插件所有。宿主选择框从 `resolveModelInfo(...).reasoning?.efforts` 生成候选（`61211-61220`），`resolveCallConfig` 校验并物化 `reasoning.defaultEffort`（`1911798`、`1918596`）；DeepSeek adapter 兜底为 `options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (thinking disabled ? 'off' : 'high')`（`1894126`）。 | 同上 |
| 谁设置 | **宿主/调用方**：agent 的 `ModelSelection = {provider, model, reasoningEffort?}`（asar `357266`、`366003-012`），session 模型选择 id 把 effort 作为三元组的第三项（`60200-205`），composer 的模型菜单与 reasoning-effort 菜单并列展示（`603190`、`603219`）。本插件**从不设置它**：`schema.js:28-71` 的 12 个配置 key 无 effort 字段；`lib/adapter.js` 全文无对该字段的赋值；工作区里它只出现在「读」与测试中。 | `schema.js:28-71`；`lib/adapter.js` grep；`docs/两层智能路由设计.md:73,92` |

### 1.2 路由层消费：只用「有无」，不用「多强」

- `lib/routing.js:126-170` `classifyTask` 的优先级是 P0 显式 > P1 图 > P2 工具 > P3 effort > P4 长文 > P5 purpose > P6 general（注释 `:119-120`）。
- **P3 只取「非 none 即 reasoning」**：`lib/routing.js:155-158` —— `reasoningEffort !== undefined && !== null && !== 'none'` 就 `signals.push('reasoningEffort'); add('reasoning')`。`minimal` 与 `xhigh` 在这里**等价**。
- `lib/adapter.js:581-620` 仅在 `routing.enabled === true` 时调用 `classifyTask(options, this.routing)`（`583`），把结果喂给 `selectTiers` 选候选 provider；`routing` 未开启时（`#applyRouting`，`231-239`）这段完全不跑。
- `lib/ranking.js` 的 `reasoning` 只是推理输出的**计费字段**（回退 output 单价），与本维度无关（前一份简报 `§1.3` 已核实）。
- 边界注意：P3 用 `'none'` 做「关」的哨兵，而 DSH 的规范 off 值是 `'off'`（`1900152`、`1894128`）。所以 `reasoningEffort:'off'` 在本插件里**会被误判为 reasoning**。这是暴露方案①时要在文档/测试里如实标注的语义缝隙（见 §6）。

### 1.3 关键事实：是否透传给底层模型 provider——**是，原样透传且真正生效**

证据链（三段，缺一不可）：

1. **插件侧不丢字段**：`lib/adapter.js:691-695`：
   ```js
   const inner = this.runtime.stream({
     ...options,                 // ← reasoningEffort 随整个 options 原样带走
     provider: hop.provider,
     model: hop.model,
   })
   ```
   只覆盖 `provider/model`，没有解构剔除、没有 clamp、没有改写。`prepareCall` 也把 `stream: options => this.stream(options)` 交给宿主（`393-398`），同样保留字段。
2. **宿主侧按确切模型校验**：`LlmRuntime.resolveCallConfig` → `resolveCallFor` → `resolveModelInfoFor`（asar `1918635-8646`、`1918505-8511`）调用 adapter 的 `resolveModel`，再用 `reasoning.efforts` 校验请求值；不支持的值在**网络 I/O 之前**以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（`1911795-1800`、`1918625-8630` 注释）。
3. **底层 adapter 真的写进请求体**：pi-ai `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`（`1901945`），wire 映射成 `reasoning = { effort, summary }`（`2511782-1788`、`2516340-6350`）；DeepSeek 直接算 `effort` 并映射到 `output_config.effort`（`1892020`、`1894126-4132`）；Codex 线程用 `model_reasoning_effort`（`1718130`）。

**结论：`reasoningEffort` 是端到端生效的采样参数，不是路由层的一次性分类标签。** 上一轮「方案①（复用宿主原生 effort）」的隐含前提——「若已透传」——已经成立；因此**不存在「强度选择目前根本不生效」的问题**，也就不存在「因为没透传所以方案①不可行」的约束。真正的问题只剩「宿主的选择入口在虚拟提供商下是否可见/是否可信」（§1.4）。

### 1.4 宿主 / 本插件的 UI 现状

- **宿主已有正交 UI**：composer 菜单同时列出 model 名与 reasoning-effort 名（asar `603190`、`603219`），选择框候选来自确切模型的 `reasoning.efforts`（`61211-61220`）。Settings → Models 页**明确没有 provider 级 effort 控件**，官方理由是「effort 是 per-model 能力，provider 级控件只能设成某些模型拒绝的值」（`705781`、`706289-293`）。这条设计哲学与本文推荐完全一致。
- **本插件的虚拟提供商怎么呈现**：`client.js:1162` `VIRTUAL_PROVIDERS = new Set(['smart'])`；`933-946`、`1166-1190` 把 `group==='smart'` 的镜像从免费模型列表/ provider 选择里过滤，Smart Gateway 自己以 tag 可见。**虚拟档位（auto/cost/balanced…）是通过 chain 的 outer model id 列在插件自己的设置页，由 `SmartAdapter.listModels` 暴露**（`lib/adapter.js:318-331`），走宿主统一的模型下拉。
- **能力声明的 Pass-through 条件**：`SmartAdapter.resolveModel` 有首跳时返回 `{...info, provider, id: model, context}`（`382-389`），`info` 含 `reasoning`（asar `1918580-8622`），宿主即可渲染 effort 菜单；无首跳或 `runtime.resolveModelInfo` 不可用时返回裸 `{provider,id,name,context}`（`380`），**没有 reasoning** → 宿主不显示强度菜单。这是诚实的降级，不应伪造。

### 1.5 `+reasoning` 后缀与 `requiredCapabilities` 是什么信号

| 信号 | 代码 | 性质 | 是否携带强度 |
|---|---|---|---|
| `model:'smart/auto+reasoning'` | `lib/routing.js:133-140`（P0 显式声明） | **能力/意图标签**：「请挑一个能推理的路由」 | ❌ 只有位置标签，无 magnitude |
| `requiredCapabilities:['reasoning',…]` | `lib/routing.js:141-149`（P0 显式声明） | 同上，数组形式的能力声明 | ❌ 同上 |
| `reasoningEffort:'high'` | `lib/routing.js:155-158`（P3）+ `lib/adapter.js:691-695`（透传） | **强度参数**：「按这个强度思考」 | ✅ 到达底层请求体 |

**结论：前两者是「能力信号」，只影响选哪个 provider/model；第三者才是「强度信号」。** 把强度编码进 `+` 后缀（即方案④）等于把两个正交维度压进同一个字符串，用户已明确否定；而且 `POSITION_TAGS` 白名单（`lib/routing.js:22`）会拒绝 `reasoning-high` 这类合成标签，除非改路由契约——那正是要避免的事。

---

## 2. 正交模型图（文字版）

```
                     思考强度轴（宿主原生 GenerateOptions.reasoningEffort）
                     由确切模型的 reasoning.efforts 决定候选
                ┌──────────────────────────────────────────────────────────┐
                │  off / none   minimal   low   medium   high   xhigh  max │
   模型选择轴   ├──────────────────────────────────────────────────────────┤
   （虚拟提供商  │                                                          │
    决定 chain  │  每个格子 = 一次请求的完整配置：                        │
    的第一跳）   │    provider = 'smart'                                    │
                │    model    = <虚拟档位>                                 │
                │    reasoningEffort = <该格强度>                          │
                │                                                          │
   smart/auto   │  auto+off      auto+low        auto+high  …              │
   smart/cost   │  cost+off      cost+low        cost+high  ← 例：省钱模型  │
   smart/balanced│ balanced+off  balanced+low    balanced+high             │
   smart/<其它> │  …                                                        │
                └──────────────────────────────────────────────────────────┘
        ↑ 模型轴：虚拟提供商已解决（chain 首跳 + 健康度 failover）
        ↑ 强度轴：一个正交的请求参数，不新增虚拟模型，不进 chains 配置
```

**组合如何工作（以 `smart/cost + effort=high` 为例）**：

1. 宿主在 composer 里让用户分别选：模型菜单选 `smart/cost`，强度菜单选 `high`（宿主已有这两个菜单；强度候选由 `SmartAdapter.resolveModel` 透传的首跳能力决定）。
2. 会话选择被记录为 `{provider:'smart', model:'cost', reasoningEffort:'high'}`（asar `366003-012`、`60200-205`）；它在后续步骤/续聊中保持，直到用户改选。
3. `classifyTask` 把 `high` 读成「需要 reasoning 类路由」的**二元信号**（`:155-158`），`selectTiers` 因此偏向带 `reasoning` 标签的真实 provider——这是**选模型**的辅助，不改变强度本身。
4. `adapter.stream` 用 chain 选出真实 hop，然后 `runtime.stream({...options, provider:hop.provider, model:hop.model})`（`:691-695`）——`high` **原样到达**真实模型；真实 adapter 校验并将它写进 `reasoning.effort` / `output_config.effort`。
5. 如果 failover 换到的下游模型不支持 `high`，真实 adapter 在 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 拒绝；本插件按既有失败分类处理并尝试下一跳（`:712-764`）。**这是诚实降级，不是静默把 high 改成 low**。

**反例说明正交性**：`smart/cost + effort=high` 与 `smart/balanced + effort=high` 的区别只在模型轴；`smart/cost + effort=high` 与 `smart/cost + effort=off` 的区别只在强度轴。两者互不编码、互不覆盖。

---

## 3. 逐方案评估表

| # | 方案 | 思路 | 是否真正正交 | 实现成本 | 与现有契约冲突 | 结论 |
|---|---|---|---|---|---|---|
| ① | **复用宿主原生 `reasoningEffort`（推荐）** | 不加 UI、不加配置：宿主已有并列的模型/强度菜单（asar `603190`、`603219`）；虚拟档通过 `resolveModel` 的首跳能力声明让强度菜单可见；请求里 effort 随 `...options` 透传（`lib/adapter.js:691-695`）。文档与测试只需把「off 哨兵」「首跳缺失不显示菜单」讲清。 | ✅ 完全正交：强度是请求字段，模型是 chain 选择，互不编码 | **0 行生产代码**；1 份文档 + 可选 1 条边界测试 | 零：不动 12-key schema（`schema.js:28-71`）、不动 6 策略/8 预设顺序（`test/ranking.test.mjs:52-54`、`lib/routing.js:349-362`）、不动 hint-not-fix 测试（`test/routing-tier.test.mjs:179-185,248-249`）、不动七语字典（`client.js:3139+`）。仅需在文档里补「`off` 会被 P3 误判为 reasoning」的已知缝隙（§6）。 | **推荐，且立即成立**（透传事实已确凿） |
| ② | 虚拟提供商设置页加「全局默认思考强度」，写入 ranking 配置并注入请求 | 在 `client.js` 设置页加下拉，新配置 key（如 `ranking.effortDefault`），`#applyRouting` 后注入 `options.reasoningEffort`。 | ⚠️ 表面正交，实质**制造第二个强度权威**：宿主 session 选择与插件全局默认谁赢？注入值还会被 `classifyTask` 当分类信号，混在一起。 | 高：UI + 七语字典 + schema 第 13 key + 注入点 + 优先级规则 + 测试 | **多处冲突**：破 12-key schema（`schema.js:28-71`）；破七语字典（7 份翻译）；宿主明确规定 effort 是 per-model 能力、不做 provider 级控件（asar `705781`），插件做了就要自己承担「某些模型拒绝该值」的责任；且与 `resolveCallConfig` 的 model-owned default 语义（`1911798`）打架。 | 不推荐；与「管理所有提供商但不动宿主契约」的定位相悖 |
| ③ | 把强度做成请求级参数（会话/每次请求覆盖全局默认） | 在插件里再造一层 effort 状态与覆盖通道。 | ✅ 概念正交 | 高 | 与宿主**已经实现**的会话级选择重复：`agent.model.select({provider,model,reasoningEffort?})`（asar `366003-012`）、`session/set_config_option` 的 `reasoning_effort`（`301550`、`301562`）、ACP 也支持（`301737`）。再造一套会产生两套状态源。 | 不做：宿主已提供，方案①天然包含它（见 §2 步骤 2）。若用户要「单次请求临时覆盖」，应走宿主 `model.select()` 而非插件配置 |
| ④ | 组合式虚拟模型（`smart/cost/reasoning-high` 等）——**反方案** | 把强度编进虚拟模型 id / `+` 后缀，靠 chain 匹配。 | ❌ **维度混淆**：把正交二维压成一维字符串；`high` 与 `xhigh` 要各造一个档，组合数爆炸；用户已明确否定 | 高（新 chain 配置、`POSITION_TAGS` 白名单 `lib/routing.js:22`、`listModels` `318-331`、快照/测试） | 破 `POSITION_TAGS` 白名单与 P0 解析契约（`:133-149`）；破 hint-not-fix（`test/routing-tier.test.mjs:179-185`）；破七语字典（新 label）；与「虚拟提供商解决模型选择」的前提自相矛盾 | **明确否决**；列为反方案仅供对照 |

> 方案①的前提是「已透传」，该前提已由 §1.3 三段证据证实；因此本轮**不存在因未透传而否定方案①**的情形。若将来 DSH 改成不透传，①立即失效，届时才需要评估②/③的自建注入。

---

## 4. 推荐方案（明确一个）与理由

**推荐方案①：复用宿主原生 `reasoningEffort`，插件不新增任何 effort UI/配置/虚拟模型。**

理由：

1. **定位吻合**：本插件是「管理所有提供商」的 meta-provider，不是第二个模型选择器，更不是第二个推理参数面板。模型选择交给虚拟提供商（用户已确认的前提），强度选择交给宿主的 per-model effort 菜单——两个维度各归其主。
2. **纯函数 / 不阻断契约**：`classifyTask` 继续只读、只把 effort 当二元提示；`adapter.stream` 继续 `...options` 透传。不新增 I/O、不改 6 策略/8 预设顺序、不加第 13 个 schema key、不给七语字典添负担。前两份简报守住的 hint-not-fix 边界原样保留。
3. **透传事实已确凿**：§1.3 证明 effort 真的影响底层 thinking budget，所以「复用原生」不是权宜之计而是最省事且正确的路径。
4. **诚实的自动化上限**：宿主只在确切模型声明 reasoning 时才给强度菜单。虚拟档的首跳若在 `resolveModel` 里没有 reasoning 元数据（`lib/adapter.js:380`），菜单就不显示——我们**不伪造强度能力**，这与前两份简报的 hint-not-fix 精神一致。

**自动化与透传的上限（必须诚实指出）**：

- 插件**不会**替用户判断「这个问题值不值得思考」。`classifyTask` P3 只在调用方已经声明 effort 时把它转成路由提示；没有复杂度信号（前一份简报 `§1.1`）。自动化上限 = 0。
- 插件**不保证**用户选的 effort 在 failover 的每一跳都可用。下游模型拒绝 `UNSUPPORTED_REASONING_EFFORT` 时按失败处理（`lib/adapter.js:712-764`），不静默降级成低强度。
- 插件**不控制**宿主是否显示强度菜单：取决于 `resolveModel` 返回的首跳能力；首跳缺失就不显示。
- `reasoningEffort:'off'` 与 P3 的 `'none'` 哨兵不一致（§1.2），当前会被误判成 reasoning。方案①不改代码，因此这条缝隙本期如实文档化；是否修属于另一个任务（§6）。

---

## 5. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 用户以为选了虚拟档就「一定按所选强度思考」 | 中 | 中 | 文案明确 hint-not-fix：强度由宿主 per-model 菜单决定，插件只透传；下游拒绝时按失败处理，不伪造 |
| `'off'` 被 P3 误判为 reasoning（`lib/routing.js:156` 比 `'none'`） | 中 | 低 | 文档列为已知缝隙；不擅自改路由契约；交用户决定是否单开「off 兼容」任务并补测试 |
| 首跳无 reasoning 元数据 → 宿主不显示强度菜单，用户以为插件不支持正交强度 | 中 | 中 | 设置页静态说明写明「强度菜单由宿主按确切模型能力显示；虚拟档首跳没有能力声明时不显示」；不伪造能力 |
| failover 到不支持所选 effort 的模型导致整条链失败 | 中 | 中 | 如实记录失败原因（`UNSUPPORTED_REASONING_EFFORT` 进入失败分类与日志），不静默 clamp；用户可在宿主改选更低强度 |
| 未来有人据本文又提「第四档 / 全局强度开关」 | 中 | 中 | 方案②/③/④ 的否决理由写进本文 §3；引用「不做什么」清单 |
| 前两份简报的「第四档 reasoning 虚拟模型」推荐与本文冲突 | 高 | 中 | 本文只做补充与纠偏、**不直接改前两份简报**；把「第四档 ≠ 强度维度」的区分列为需用户拍板的修订建议（§6-3） |

---

## 6. 需要用户拍板的事项

1. **确认结论**：接受「正交强度走宿主原生 `reasoningEffort`，方案①，插件零新增 UI/配置」？若不接受，请指定要自建哪一层（那将推翻 12-key schema 与七语字典的冻结边界）。
2. **是否修 `off` 缝隙**：`lib/routing.js:156` 用 `'none'` 判关，而 DSH 规范 off 为 `'off'`。本期建议只文档化；若要求修，需单开任务并改 P3 判定 + 补测试（属于改 `.js`/测试，超出本文范围）。
3. **前两份简报的修订**：是否把「第四档 reasoning 虚拟模型」的推荐降级为「仅表达『偏好推理型路由』的能力档」，并明确它**不代表强度**？本文未直接改那两份文档。
4. **UI 文案口径**：是否在插件设置页加一句静态说明（不新增控件、不新增 i18n key，复用现有说明位）告知「模型选择由虚拟提供商解决，思考强度用宿主模型菜单旁的强度选项」？若要求多语，则需走七语字典。
5. **失败可见性**：是否要求把 `UNSUPPORTED_REASONING_EFFORT` 的 failover 原因呈现在设置页诊断区？本期建议只留在 DSH 日志与 hop 记录（`lib/adapter.js:411-430`），避免新增 UI 数据通道。

---

## 7. 本轮边界声明

- 未写任何实现代码（本文只有伪代码与文字图）；未改任何 `.js` / locale json / 测试 / 前两份设计简报。
- 新增且仅新增本文档：`.agents/plans/2026-11-27-reasoning-effort-orthogonal.md`。
- 所有代码事实来自 v2.7.0 工作区与 DSH asar 的只读复核；asar 行号指 `/opt/DSH NEXT/resources/app.asar` 的行地址。
