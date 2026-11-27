# 设计简报：虚拟模型收敛为档位选择（Smart Gateway 统一提供商入口）

> ## ⚠️ 已被新规格取代（2026-11-27 规格反转）
>
> **本稿 2026-11-27 的「3 模型档 × 3 强度 = 9 个组合 id、否决第 4 档、否决 auto 强度、名称只放自由文本不进 locale」结论已被 `SPEC-2026-11-27-smart-provider.md` 取代，不再作为当前契约。** 以下内容作为历史设计数据原样保留，仅供溯源；现行契约以该 SPEC 为准：4 个虚拟模型（均衡 `balanced` / 省钱 `cost` / 效率 `speed` / 智能 `smart`，默认智能）、6 档强度（`auto` + 关闭 `off` / 低 `low` / 中 `medium` / 高 `high` / 极高 `max`，默认 `auto`）、host 目录只列 4 个单段模型 + `defaultEffort` 设置项（24 组合仅作内部解析/历史兼容，非 catalog 条目）、`auto` 为按模型与任务内容的动态偏向而非硬绑定（保留 `classifyTask` 判断、手动档覆盖）、名称走 7 语 i18n 键 `virtualModel.*` / `virtualEffort.*`。
>
定稿状态：2026-11-27 按用户决策收敛（最终形态见 combined-tier-ids.md）

- 日期：2026-11-27
- 目标版本：dsh-smart-provider v2.7.0（只读调研基线，行号以当前工作区为准）
- 性质：**设计文档，不含实现代码**。本文只定契约、约束、取舍与影响面；具体改法由实施阶段另行落地。
- 调研依据：design-researcher 核实的源码事实（见文中 file:line 引用）。

---

## 1. 问题与目标

### 1.1 一句话问题

插件定位是「管理所有提供商」，但现在 `listModels('smart')` 会把每个非 `auto` 的 chain key 生成一个 `Smart / <chain>` 虚拟模型对外暴露（`lib/adapter.js:318-331`，特别是 319 的 `Object.keys(this.chains).filter(id => id !== '*')` 与 326-329 的循环），用户看到的是一串按配置链生成的模型，而不是自己要选的「怎么选模型」的档位。

### 1.2 受众

- **普通用户**：在模型下拉里只想选「省钱 / 平衡 / 智能」这类档位，不想理解 chains、route、tierPolicy。
- **高级用户**：保留自定义链与多提供商配置能力，但不要求这些内部 chain key 出现在对外模型目录里。
- **维护者 / 测试**：注册面、schema、远程方法、多语字典与测试锁死项保持可验证、不漂移。

### 1.3 成功标准

1. 对外 catalog 中的 smart 虚拟模型**数量固定**：3 模型档 × 3 强度档 = **9 个组合 id**（全笛卡尔积，`smart/<模型档>/<强度档>`；强度 id 用宿主规范值 `off / medium / high`，中文展示「关闭 / 均衡 / 高」），不再随 chains 的非 `auto` key 数量增长；最终形态见 combined-tier-ids.md §2.5。
2. 每个虚拟模型 id 与一个档位一一对应；用户选哪个模型，就把对应 preset 写入 `ranking.strategy` 与 `ranking.routing.strategy`（复用现有 preset id，不新增策略 id）。
3. 不出现任何 `Smart / xxx` 形式的 chain 派生模型名。
4. 注册面不变：只有 1 个 smart adapter（`index.js:310`）+ 1 条 configurable provider（`index.js:407-412`）；patch 与测试中不得再声明 smart（`cordis.patch.yml:3-6`、`test/custom-routes.test.mjs:148-170`）。
5. 数据链路不断：cost / free / health / discovery 的虚拟副本隔离逻辑保留且测试仍绿。
6. 测试同步完成：会红的测试被明确改写，锁死项保持绿（附录 A 逐条列出）。

### 1.4 核心约束（用户明确诉求）

> 「这几个虚拟模型应该对应的就是咱们的档位选择。」

即：**虚拟模型 = 档位**，不再暴露按 chain 生成的 `Smart / xxx`；对外只有几个固定档位选择。用户同时指出：思考档目前没有好办法自动判断，那就「开放出来让他选」——见第 2.5 节。

---

## 2. 方案分析

### 2.0 事实底座（设计不可违背的既有事实）

- **虚拟模型源头**：`lib/adapter.js:318-331`。固定 `smart/auto`（320-325）+ 每个非 `auto` chain key 一条 `{id, name: 'Smart / ' + id}`（326-329）；数量 = 1 + 非 auto chain key 数。contextWindow 走 `#virtualContextWindow()`（338-355），只接受正整数，否则回退 `VIRTUAL_CONTEXT_WINDOW_FLOOR = 128000`（56）。
- **消费方**：宿主 registry 调 `listModels('smart')`；设置页 `session.modelCatalog()` 的 `group==='smart'` 是镜像（`client.js:2952-2963`），`client.js:933-944` 过滤虚拟副本，1029-1033 显示 Smart Gateway 标签，`VIRTUAL_PROVIDERS = new Set(['smart'])`（1162）过滤 chains/accounts 下拉与探测候选。`discovery refreshDiscoveredChains()`（`index.js:341-379`）**不消费**虚拟模型，只生产真实 routes 并 reconfigure chains。
- **档位现状：两套预设叠加**。第二层评分 6 策略（`lib/ranking.js:46-56`）：`legacy / balanced / cost-first / speed-first / tier-first / custom`；第一层路由 8 预设（`client.js:577-586`、`lib/routing.js:341-371`）：`balanced / cost-first / speed-first / reasoning-first / longctx-first / vision-first / legacy / custom`。首屏三按钮（`client.js:948-952, 984-999`）通过 `applyPreset`（3057-3077）同时写 `ranking.strategy` 与 `ranking.routing.strategy`：**省钱=cost-first、平衡=balanced**；**智能没有独立 id**——`balanced` 本身就是「按任务自动选档」；`reasoning-first` 是强制思考档。
- **任务分类**：`classifyTask`（`lib/routing.js:126-171`）P0 模型名 `+tag` / `requiredCapabilities`，P1 图片，P2 tools，P3 `reasoningEffort` 非 none，P4 长上下文 > 200000，P5 purpose=title/summary/classify → thrifty，兜底 general。`derivePosition`（203-222）：catalog 的 `model.reasoning===true` → reasoning 标签、`contextWindow>=200000` → longctx、image → vision、`tool!==false` → tool、恒加 general；**thrifty/swift 永不自动推导**。`selectTiers`（305-331）无匹配则 relax 到全部路由并 WARN（不阻断）。
- **思考档自动化程度 = 零**：没有任何基于消息内容判断「该不该思考」的逻辑；只有调用方显式 `reasoningEffort` / `+reasoning` 标签，或用户手选 `reasoning-first`。探测/可用性投影无 reasoning 字段。`test/routing-tier.test.mjs:179-185` 锁死「reasoning-first is a hint, not a fix」（无标签绝不伪造档）。

> **同构提示（必须诚实记录）**：「智能」与「平衡」在现有策略表里共用 `balanced` id。智能 = 默认按任务自动选档入口；平衡 = 中性权重的显式手选入口。二者的底层 preset 相同是刻意选择——**不为了区分而新增策略 id**，因为那会触发 `test/ranking.test.mjs:52-54` 的 6 策略 id 顺序锁死，并连带七语字典同步。UI 语义差异由「默认自动 vs 用户手选」承载；「思考强度」不再独立成第四档，而是作为正交维度编入档位 id（见 2.5 与 combined-tier-ids.md）。

### 2.1 方案 A：固定三档虚拟模型（id 与档位一一对应）

#### 思路

把 `listModels('smart')` 的输出从「1 + 非 auto chain key 数」改为**固定集合**：`auto`（智能）、`cost`（省钱）、`balanced`（平衡）。每个 id 对应一个档位；用户选中某档，就把该档 preset 写入 `ranking.strategy` + `ranking.routing.strategy`（外层 id 到 preset 的映射为纯数据契约，不新增 schema key）。

映射契约（伪代码，非实现）：

| 对外模型 id | 对外档位名 | 写入的两层 preset | 行为语义 |
|---|---|---|---|
| `auto` | 智能档 | `balanced` + `balanced` | 默认入口：按 classifyTask / selectTiers 自动挑档，中性权重 |
| `cost` | 省钱档 | `cost-first` + `cost-first` | 成本优先权重（0.7），适合长任务/批量 |
| `balanced` | 平衡档 | `balanced` + `balanced` | 手选的中性档（四项 .25），不偏向省钱或速度 |

#### 优点

- 直接命中用户诉求：**虚拟模型就是档位**，数量不随 chains 增长，目录稳定可预测。
- id 与 preset 一一对应，配置写入路径复用已有 `applyPreset`（`client.js:3057-3077`），不需要新策略 id、不需要新配置开关（schema 仍 12 key）。
- 设置页镜像（`client.js:2952-2963`）、虚拟副本过滤（933-944, 1162）与 health 虚拟隔离逻辑全部保留，数据链路不重构。

#### 缺点

- 旧的非 `auto` chain key 不再出现在 catalog（这是目标行为，但属于用户可见变化，需要迁移口径）。
- 「智能」与「平衡」底层同构（2.0 同构提示），需要靠文案与默认入口语义区分，不能声称两者行为有本质差异。
- `test/compaction.test.mjs:56-68` 的 `fast` fixture 断言会红，必须同步改 fixture/断言（附录 A）。

#### 适用场景

产品定位就是「少数固定档位 + 一个统一网关」，希望用户零配置就能选对策略，且愿意为稳定性付出「内部链不暴露」的代价。**这是本项目的目标形态。**

---

### 2.2 方案 B：保留 auto + 单档别名，把档位做成下拉而非多个虚拟模型

#### 思路

`listModels` 只保留 `smart/auto` 一个虚拟模型；「省钱 / 平衡 / 智能」做成 Smart Gateway 配置页里的一个 dropdown（写入 `ranking.strategy` / `ranking.routing.strategy`）。模型目录里不再有多个 smart 模型。

#### 优点

- 改动面最小：不动 `listModels` 的多模型结构，只是不在 catalog 里列它们；测试 fixture 冲击小。
- 档位切换集中在配置页一处，概念上「一个网关 + 一个策略选择」。

#### 缺点

- **可能违反用户明确诉求**：用户说的是「这几个虚拟模型应该对应的就是咱们的档位选择」，即档位要以虚拟模型形态出现在模型选择位；本方案把档位挪进 dropdown，虚拟模型与档位不再一一对应。
- 用户在对话/模型选择器里看不到档位，选模型的动作与选策略的动作分离，学习成本反而上升。
- 仍需处理 `Smart / xxx` 的移除，并未省掉核心迁移工作。

#### 适用场景

仅当宿主模型选择器无法承载「档位即模型」的交互、且用户接受「档位在配置页选」时作为退路。**不建议作为本期主方案。**

---

### 2.3 方案 C：混合——固定档位 + 高级自定义链仍可用但不在 catalog 暴露

#### 思路

对外 catalog 只暴露固定档位（同 A）；内部 `chains` 中的非 `auto` key **保留原样**、仍可被显式外层 id 经 `resolveChain` 解析，只是不再经 `listModels` 生成 `Smart / xxx` 条目。即「目录收敛、能力不删」。

#### 优点

- 兼顾 A 的用户体验与高级用户的存量配置：已写好的 chain 不会被破坏，只是从目录里隐身。
- `discovery refreshDiscoveredChains()`（`index.js:341-379`）本来就不消费虚拟模型，改动对真实 routes 生产链路零影响。
- 为未来「高级自定义档位」留口子，而不需要现在暴露一堆模型。

#### 缺点

- 目录里选不到旧 chain id，但旧 id 仍可能在工作区配置里被引用——需要明确的迁移与文档口径，否则用户困惑。
- 两套入口（档位 id / 自定义 chain id）长期并存，维护者要清楚「谁能进 catalog、谁只做解析」。

#### 适用场景

存在存量 chains 配置、不能一刀切删除的老用户场景。**本期推荐吸收 C 的兼容处理作为 A 的迁移规则**（见第 4 章）。

### 2.4 三方案对比

| 维度 | A 固定三档 | B 单模型 + dropdown | C 混合（A + 链保留） |
|---|---|---|---|
| 命中「虚拟模型=档位」诉求 | ✅ 直接命中 | ❌ 档位不在模型位 | ✅ 直接命中 |
| catalog 数量稳定 | ✅ 固定 | ✅ 固定为 1 | ✅ 固定 |
| 存量 chains 兼容 | 需迁移口径 | 需迁移口径 | ✅ 保留解析 |
| 新策略 id / 新 schema key | 都不需要 | 都不需要 | 都不需要 |
| 测试冲击 | compaction fixture | 较小 | 同 A |
| 推荐度 | 高 | 低（退路） | **最高（A 的行为 + C 的兼容）** |

---

### 2.5 专节：思考档怎么处理（必须单独决策）

**事实前提**：思考档自动化程度为零。没有任何基于消息内容判断该不该思考的逻辑；只有调用方显式 `reasoningEffort` / `+reasoning` 标签，或用户手选 `reasoning-first`。探测/可用性投影无 reasoning 字段。`test/routing-tier.test.mjs:179-185` 锁死 `reasoning-first` 只是 hint、不是 fix——无标签绝不伪造 reasoning 档，且无匹配时 `selectTiers`（`lib/routing.js:305-331`）relax 到全部路由并 WARN。用户原话：「没好办法就开放出来让他选」。

#### 方案①（已废弃）：把 reasoning 做成第四个固定虚拟档（深度思考档），用户直接选

- **原思路**：在 A/C 的固定档位集合里增加 `reasoning`（对外「深度思考档」），id 与档位一一对应；选中即写 `reasoning-first` + `reasoning-first`（两个现有 preset id，均无需新增）。
- **用户最终决策（2026-11-27）**：否决独立第四档——那是把「强度」这个正交维度做成第 4 个模型的维度混淆。**强度作为正交维度编入模型档 id，形成 `smart/<模型档>/<强度档>` 组合；不设独立第四档**。完整 9 个组合 id、强度 id 用宿主规范值 `off / medium / high`（中文展示「关闭 / 均衡 / 高」）等最终形态见 combined-tier-ids.md §2.2/§2.5。
- **仍然成立的实事**：自动化信号不存在，强行自动化等于虚构；「开放出来让他选」的显式通道精神保留，只是暴露形态从第四档改为组合 id。

#### 方案②：智能档内自动判断（复用 classifyTask 的 reasoningEffort 信号），无信号不硬塞

- **思路**：不单列虚拟档；智能档内部读取 `reasoningEffort` 非 none（`lib/routing.js:156-158` 的 P3 信号）时自动倾向 reasoning。
- **优点**：用户心智负担最低；与现有 `classifyTask` 信号天然对齐。
- **缺点 / 自动化上限**：**只能复用调用方已显式给出的信号，无法从消息内容推断「该不该思考」**；探测/可用性投影无 reasoning 字段，UI 也无法展示确定性；无信号时与「用户手选组合强度档」的行为不可区分，用户看不到「为什么这次没思考」。
- **适用**：作为后续增强（当真实信号源出现时），**不能作为本期的唯一机制**。

#### 方案③：两者结合（智能档自动判断 + 保留可手动选的深度思考档）

- **思路**：智能档按方案②消费显式信号；同时保留用户手选组合强度档作为手动兜底（原「方案①第四档」已废弃，见上文定稿结论）。
- **优点**：覆盖「有信号自动」和「没信号手选」两种路径。
- **缺点 / 自动化上限**：自动化部分的上限与方案②完全相同（信号不存在就无从判断）；两套路径并存会让用户困惑「到底什么时候自动、什么时候手选」，文档和 UI 说明成本翻倍。
- **适用**：成熟期演进，不是本期必须交付的形态。

#### 定稿结论：**不设独立第四档；强度编入模型档 id，形成组合档位**

按用户最终决策（2026-11-27），思考强度不再做成第四个虚拟模型，而是作为正交维度编进每个模型档的 id：`smart/<模型档>/<强度档>`（强度 id 用宿主规范值 `off / medium / high`，中文展示「关闭 / 均衡 / 高」）。**最终形态见 combined-tier-ids.md**（§2.1 语法、§2.2 映射、§2.5 全笛卡尔积 9 个 id）。理由中仍然成立的实事：

1. **与事实一致**：当前自动化上限为零，方案②③都只能在「调用方已经显式声明 reasoning」时工作，这等于把用户已做的选择再翻译一遍，并非真正的自动判断；把它们当作本期承诺会制造虚假确定性。
2. **与用户原话一致**：用户明确说没好办法就开放出来让他选——组合 id 就是把强度做成一个可预测的显式选择位。
3. **与整体契约一致**：虚拟模型 = 档位，强度是正交维度，组合 id 不破坏 6 策略锁死与 schema 12 key；不新增独立第四档（维度混淆）。
4. **诚实边界**：档位只是 hint，不是 fix（`test/routing-tier.test.mjs:179-185`）；UI 文案必须说明「若当前没有带 reasoning 标签的模型，会回退到可用模型并给出提示」，不得承诺一定深度思考。

> 方案②③的自动化上限在此明确记录：它们最多消费 `reasoningEffort` / `+reasoning` 显式信号；无信号时不能、也不应伪造档位。未来若出现内容侧或投影侧的真实 reasoning 信号，再评估「显式组合强度档 + 智能档消费显式信号」的协同，本期不承诺。

---

## 3. 约束检查表

### 3.1 硬约束

| 约束项 | 检查结果 | 依据 / 守住的方式 |
|---|---|---|
| 只注册 1 个 smart adapter | ✅ 不动 | `index.js:310` `registerAdapter(['smart'], adapter)`；不得新增第二个 adapter |
| 只声明 1 条 configurable provider | ✅ 不动 | `index.js:407-412` Smart Gateway；不得补第二条目录行 |
| patch 禁止声明 smart（DUPLICATE_ADAPTER） | ✅ 不动 | `cordis.patch.yml:3-6`；`test/custom-routes.test.mjs:148-170` 锁死 |
| schema 恰好 12 key | ✅ 不动 | `schema.js:28-71`；**不新增「是否暴露虚拟模型」开关**，档位是固定契约而非可配开关 |
| inject 恰好 `['llm']` | ✅ 不动 | `test/loading.test.mjs:24-28` |
| remote 恰好 7 方法 | ✅ 不动 | `test/loading.test.mjs:47-56`；档位映射是本地行为，不加远程方法 |
| 6 策略 id 顺序锁死 | ✅ 不动 | `test/ranking.test.mjs:52-54`；档位复用 `cost-first / balanced / reasoning-first`，不新增策略 id |
| 版本三处一致 | ✅ 不动 | `test/free-ui-chain.test.mjs:158-165`（package / client / changelog 均 2.7.0）；本设计不 bump 版本 |
| 七语字典 key 集合一致 | ⚠️ 条件约束 | `test/free-ui-chain.test.mjs:172-265`（zh/en/de/es/fr/pt/ru）：**凡新增/删除 `t()`/`fmt()` key，必须同步 7 份字典**，并保持占位符一致 |
| health virtualProviders 含 smart + 追加去重 | ✅ 不动 | `test/health.test.mjs:554-576`；`health.virtualProviders=['smart']` 保留 |
| reasoning-first 只是 hint | ✅ 不动 | `test/routing-tier.test.mjs:179-185`；不伪造 reasoning 标签、不阻断无匹配请求 |
| 文档形态 | ✅ 遵守 | 仅写本文；不改任何 .js / locale json / 测试文件；简体中文；无实现代码（伪代码允许） |

### 3.2 兼容性：用户已有 chains 非 `auto` key 怎么办

- **不删数据**：`chains` 中已有非 `auto` key 保持原样（方案 C 的兼容处理），仍可被显式外层 id 经 `resolveChain` 解析；变的只是它们不再经 `listModels` 生成 `Smart / xxx` 条目（这是目标行为）。
- **默认 chains**：`lib/chains.js:22` `DEFAULT_CHAINS = Object.freeze({ auto: [] })` 不受影响。
- **客户端回退表**：`client.js:594-604` 的 4 个 key（auto + 3 具体模型，仅 UI fallback）不动；它不是 catalog 来源。
- **迁移口径**：若用户过去在模型下拉里选过某个 `Smart / xxx`，该 id 在新 catalog 中消失；文档/UI 需提示改选对应档位（智能档为默认落点），而不是让请求静默失败。
- **不新增开关**：用户不能通过配置恢复旧的 `Smart / xxx` 暴露形态——schema 12 key 锁死；这是刻意的收敛，不是遗漏。

### 3.3 数据链路：cost / free / health / discovery 不能断

| 链路 | 现状事实 | 本设计的影响 |
|---|---|---|
| cost | 计费走真实 hop；虚拟副本不写健康 | 不动；档位只是外层 id，最终仍解析到真实 hop |
| free / 可用性投影 | `client.js:933-944` 过滤 `group==='smart'` 虚拟副本，1029-1033 显示标签；`VIRTUAL_PROVIDERS`（1162）过滤 chains/accounts 下拉与探测候选 | 保留过滤：虚拟副本数量从「1+N」变成固定档位数，过滤规则不变 |
| health 虚拟副本隔离 | `adapter.js:503-505`、`account-pool.js:337,379-380,411-412`、`availability.js:269-270`、`health-snapshot.js:208` | **保留，不当冗余删除**：`smart/auto` 自身仍是虚拟 route，隔离逻辑是必须的 |
| discovery | `index.js:341-379` 不消费虚拟模型，只生产真实 routes 并 reconfigure chains | 零影响；`adapter.routes` 仍喂给 `#virtualContextWindow()`（338-355），档位 contextWindow 仍取首跳正整数或 128000 floor |

---

## 4. 推荐方案与风险缓解

### 4.1 推荐：**方案 A 的行为 + 方案 C 的兼容处理**（强度编入档位 id，不设第四档）

最终对外固定档位集合（**9 个组合 id**，provider=smart；全笛卡尔积，最终形态见 combined-tier-ids.md §2.5）：

| 对外模型 id | 档位名 | 两层 preset | 备注 |
|---|---|---|---|
| `smart/auto/off` · `smart/auto/medium` · `smart/auto/high` | 智能档 × 关闭/均衡/高 | `balanced` + `balanced` | 按任务自动选档；与「平衡档」共用 preset id，差异是默认入口语义 |
| `smart/cost/off` · `smart/cost/medium` · `smart/cost/high` | 省钱档 × 关闭/均衡/高 | `cost-first` + `cost-first` | 成本优先 |
| `smart/balanced/off` · `smart/balanced/medium` · `smart/balanced/high` | 平衡档 × 关闭/均衡/高 | `balanced` + `balanced` | 手选中性档 |

强度 id 用宿主 `ReasoningEffortId` 规范值 `off / medium / high`，中文展示「关闭 / 均衡 / 高」；不设独立第四档（维度混淆，用户 2026-11-27 最终决策）。基础档 → preset 映射不变，强度档 → effort 映射见 combined-tier-ids.md §2.2。

### 4.2 推荐理由

1. **正面命中诉求**：虚拟模型数量固定、语义固定，用户选模型就是选档位；`Smart / xxx` 消失。
2. **改动面可控**：不动注册面、schema、remote、版本与 6 策略 id；不需要新开关、不需要新策略 id、不重构 discovery 与虚拟副本隔离。
3. **兼容存量**：吸收 C 的兼容处理，已有 chains 仍可解析，老用户配置不被破坏。
4. **思考档诚实**：以可预测的显式组合强度档替代「假装自动」，与零自动化事实和用户原话同时对齐；不设独立第四档。

### 4.3 风险与缓解表

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 已有 chains 非 `auto` key 从 catalog 消失，用户困惑 | 高 | 中 | 沿用方案 C：chains 保留、仍可解析；文档/UI 给出「旧 `Smart / xxx` 改选智能档」的迁移口径；不静默失败 |
| `test/compaction.test.mjs:56-68` 的 `fast` fixture 断言失败 | **高（必红）** | 中 | 同步改 fixture/断言：把 `fast` 换成固定档位 id，或保留 `fast` 但改为断言「档位集合固定且无 `Smart / xxx`」；继续校验每档 contextWindow 来自首跳缓存或 128000 floor（附录 A-1） |
| 设置页镜像：`session.modelCatalog()` 的 smart 组条目变化（`client.js:2952-2963`） | 中 | 中 | 镜像只呈现固定档位；`client.js:933-944` 虚拟副本过滤与 1029-1033 标签保留；`VIRTUAL_PROVIDERS`（1162）继续过滤 chains/accounts 下拉与探测候选 |
| 七语字典 / 静态 key 门禁（`test/free-ui-chain.test.mjs:172-265`） | 中 | 中 | 新增档位 label key 必须一次同步 zh/en/de/es/fr/pt/ru 七份字典，占位符一致；优先复用现有 preset key 减少新增；版本三处（158-165）不 bump |
| 「智能」与「平衡」底层同构被误读为产品缺陷 | 中 | 低 | 在 UI 文案与本文显式说明：二者共用 `balanced` preset，差异是「默认自动入口 vs 手选中性档」；不为区分而新增策略 id（守住 `test/ranking.test.mjs:52-54`） |
| 组合强度档被误认为「一定深度思考」 | 中 | 中 | UI 明确 hint 非 fix：无 reasoning 标签的模型时回退到可用路由并 WARN（`test/routing-tier.test.mjs:179-185`）；探测/投影无 reasoning 字段，不伪造标签；不支持的 effort 不 clamp，走 failover（combined-tier-ids.md §2.2） |
| 虚拟副本隔离被当冗余误删 | 低 | 高 | 明确 `smart/auto` 自身是虚拟 route：`adapter.js:503-505` / `account-pool.js:337,379-380,411-412` / `availability.js:269-270` / `health-snapshot.js:208` 全部保留；`test/health.test.mjs:554-576` 保持绿 |
| 档位 contextWindow 取值波动 | 低 | 低 | 沿用 `#virtualContextWindow()`（338-355）：只信正整数，否则 128000 floor；不虚构大数值 |

---

## 5. 实施计划大纲（高层步骤，不涉及具体代码）

1. **冻结档位契约**：确认固定 9 个组合 id（`smart/<auto|cost|balanced>/<off|medium|high>`）、对外档位名与两层 preset 映射（最终形态见 combined-tier-ids.md）；确认「智能/平衡同构」与「强度档 hint 非 fix」的对外文案口径。产出物是本设计简报的评审结论，不新增配置 key。
2. **收敛虚拟模型输出**：把 `listModels('smart')` 的枚举来源从 chains 派生改为固定档位集合；contextWindow 继续走首跳缓存 + floor；`Smart / xxx` 不再生成。chains 配置保留、仍可被显式 id 解析。
3. **同步设置页镜像与交互**：设置页 smart 组只显示固定档位；虚拟副本过滤、Smart Gateway 标签、chains/accounts 下拉过滤照旧；首屏按钮与档位语义对齐（省钱/平衡/智能 × 关闭/均衡/高），避免两套命名打架。
4. **兼容与迁移收口**：为旧 `Smart / xxx` 选择提供明确落点（智能档）；不改 schema 12 key、不新增 remote 方法、不碰 patch 与注册面。
5. **同步测试与字典**：按附录 A 改写必红测试；若引入新 `t()` key，一次同步七语字典与占位符；保持所有锁死项绿。
6. **门禁与回归**：跑项目既有门禁（lint / build / test / i18n gate），并回归 cost / free / health / discovery 四条数据链路；确认无临时文件残留后再提交（commit，不 push）。

### 里程碑

- [ ] **M1 — 契约冻结**：9 个组合 id 集合、id↔preset 映射、强度档正交编入 id（非第四档）、同构说明与迁移口径评审通过（最终形态见 combined-tier-ids.md）；无代码改动。
- [ ] **M2 — 行为落地与测试同步**：虚拟模型输出固定档位、设置页镜像同步；`test/compaction.test.mjs` fixture/断言与七语字典按附录 A 同步；相关单测由红转绿。
- [ ] **M3 — 全量门禁与收尾**：lint/build/test/i18n 全绿；cost/free/health/discovery 回归通过；版本三处一致、schema 12 key、remote 7 方法、6 策略顺序、DUPLICATE_ADAPTER 等锁死项复核；精确提交，不 push。

---

## 附录 A：测试影响与同步清单（可回读证据）

### A-1 会红、必须同步的测试

| 测试 | 红的原因 | 同步方式 |
|---|---|---|
| `test/compaction.test.mjs:56-68` | fixture chains 含 `fast` 别名（58），断言 `byId.get('fast').contextWindow===200000`（64）与所有模型 provider=smart（65-67）；砍掉 `Smart / xxx` 后 `byId.get('fast')` 为 `undefined`，断言抛错 | 改 fixture 的 chain key 为固定档位 id，或保留 `fast` 但把断言改为「固定档位集合 + 不存在 Smart / xxx」；继续断言每档 contextWindow 是正整数且来自首跳缓存/128000 floor |
| `test/free-ui-chain.test.mjs:172-265`（I18N-2/3/4） | 若客户端新增档位 label 的 `t()`/`fmt()` key 而未同步 7 份字典，静态 key 子集、key 集合一致、占位符一致三项全红 | 新增 key 一次同步 zh/en/de/es/fr/pt/ru；尽量复用现有 preset key；校对每个占位符 |

### A-2 必须保持绿（任何改动碰到即视为越界）

| 测试 | 锁死内容 | 守住方式 |
|---|---|---|
| `test/loading.test.mjs:24-28` | inject 恰好 `['llm']` | 不新增 inject |
| `test/loading.test.mjs:34-37` | config 恰好 12 key | 不新增 schema 开关 |
| `test/loading.test.mjs:47-56` | remote 恰好 7 方法 | 不新增远程方法 |
| `test/ranking.test.mjs:52-54` | 6 策略 id 顺序 | 只复用 `cost-first / balanced / reasoning-first`，不加 id |
| `test/free-ui-chain.test.mjs:158-165` | 版本三处一致（2.7.0） | 不 bump 版本 |
| `test/health.test.mjs:554-576` | virtualProviders 含 smart + 追加去重 | 虚拟副本隔离保留 |
| `test/custom-routes.test.mjs:148-170` | patch 不声明 smart（DUPLICATE_ADAPTER） | 不动 `cordis.patch.yml:3-6` |
| `test/routing-tier.test.mjs:179-185` | reasoning-first 是 hint 非 fix，无标签不伪造档 | 组合强度档只写 preset + 注入 effort，不改 `selectTiers` 回退语义 |
| `test/compaction.test.mjs:71+` | `auto` 首跳缺失时回退 floor | 固定档位仍保留 `auto`，contextWindow 逻辑不动 |

### A-3 三档映射结论（供回读）

- `auto` → **智能档** → `balanced` + `balanced`（默认按任务自动选档；与平衡档共用 preset id）
- `cost` → **省钱档** → `cost-first` + `cost-first`
- `balanced` → **平衡档** → `balanced` + `balanced`（手选中性档）
- 强度作为正交维度编入模型档 id：`smart/<模型档>/<off|medium|high>`（共 9 个组合 id），不设独立第四档；强度 id 用宿主规范值、中文展示「关闭/均衡/高」，强度 → effort 映射见 combined-tier-ids.md §2.2（hint 非 fix）
