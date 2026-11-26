# 变更记录

本文档记录 `dsh-smart-provider` 的发布变更。版本号采用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 2.4.0

本轮为 RC1 收口版本，由 `2.3.1` 升级到 `2.4.0`（含新功能，按语义化版本 minor 递增）：一部分是 2.3.x 免费判据遗留的三处串标 / 假免费修复，另一部分是新增的对话页可配置预估总额 pill。未实现的能力（例如让 probe 在所有路由上都能给出确定结论）不在本版承诺内。

### 修复（免费标签链路）

- **跨 provider 串标：`workbuddy/hy4flash-free` 显示 `已确认免费`**：`availabilityStatus()` 曾按裸 modelId 取「全 provider 最强」的免费标签，于是 `x-opencode-free/hy4-flash-free` 那条真实零价声明被安到了 workbuddy 的同名模型上。现在 Host 侧逐 `(provider, modelId)` 元组投影，顶层仍保留全 provider 最强标签供老客户端读取；客户端 `strongestFreeTag()` 按元组查 `providers[provider]`，只在当前元组内取最强档，老 Profile 没有 providers 映射时仍走顶层标签的兼容分支。弱信号不会被别人的实测证据抬成「已确认免费」。
- **`unavailable` 声明模型的零价行进入免费证据**：注册表中标为 `status: unavailable` 的条目（促销 badge id `hy4-flash-free-trial-202611`、顶层搜索插件 `web-search-free` 等，不是可调用的模型）此前会被生成成零价声明行，让判据误报 `measured` 免费。现在默认价格表 `lib/pricing.json` 只保留确有可用调用的声明免费模型（`hy4-flash-free` / `hy4flash-free`），生成侧与回归测试共同拦截 `unavailable` 重新入库；这些名字仍可保留「可能免费（未实测）」的弱信号，但不算价格表实测声明。
- **「已确认免费」不说明证据来源**：实测档标签现在按 `freeSignal.source` 加一句短后缀 —— 价格表声明 `已确认免费·价格表`、探测 `已确认免费·探测`、账本 `已确认免费·账单`；未知来源回落到基础文案 `已确认免费`。`weak` / `declared` / `none` 三档文案不变，不把价格表声明伪装成调用实测。

### 新增（对话页预估总额 pill）

- **可配置挂载点**：`costPillEnabled: false`（默认关闭，只有显式 `true` 才显示）、`costPillPosition: 'input.right'`（默认；另可选 `conversation.session.header.utilities` 会话标题栏工具区、`conversation.input.dock` 输入框上方条目；非法值回落默认档）、`costPillRefreshMs: 60000`（默认 60 秒，最小 1000 毫秒）。三个键都是 volatile，设置页改完即时生效、无需重启。pill 读 `@Remote` 的 `statsSince()` 真账汇总，显示两位小数美元金额与当前统计起点；`clearStats()` 用于「从现在重新统计」。
- **手动刷新常驻，定时监控默认关**：「立即刷新」按钮一直在；定时刷新只在显式配置了刷新间隔后运行，页面不可见时暂停（`visibilitychange` 清掉定时器并中止在途请求，回到前台再续），卸载时清理，避免后台空转与定时器泄漏。读取失败显示错误行，不拿估算占位冒充真账。
- **清理只写统计起点，不删账本**：「从现在重新统计」先二次确认，确认后 `clearStats()` 只在 `stats-state.json` 写新的 `since` / `clearedAt`，`cost.jsonl` 逐字节不变；随之显示的累计金额从新起点重新计数，历史账本与健康证据不受影响。这不是「清空账本」，也没有回滚或删除能力。

### 验证（2026-11-26 实测，含文档收口前的一次预期红）

写本段之前两套门禁各有一条 **预期失败**：`FX3-5` 校验版本号三处一致，而本文档尚无 `## 2.4.0` 标题（`package.json` / `client.js` 已是 2.4.0）。文档补齐后复跑已全绿：

- `env -u DSH_NODE_EXECUTABLE node scripts/run-tests.mjs --unit`：**17 个测试文件 / 260 条，pass 260 / fail 0，退出码 0**（补文档前 259/1，唯一 fail 是 FX3-5）。
- `DSH_NODE_EXECUTABLE='/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT' node scripts/run-tests.mjs`：**24 个测试文件 / 318 条，pass 318 / fail 0，退出码 0**（补文档前 317/1，同一条 FX3-5）。
- 版本号三处一致：`package.json` / `client.js` 的 `PLUGIN_VERSION` / 本文档均为 `2.4.0`。

## 2.3.1

修复版本（`2.3.0` → `2.3.1`）。用户反馈「重启没变化 / UI 没改完」：2.3.0 已承诺的免费链路只接了一半 —— Host 的实测/声明免费标签在 UI 合并时被丢掉、账号倍率没进入三处判据、健康面板没有资费列、价格倍率输入框埋在两层折叠里。本版把这些已承诺但未接通的链路补完，不是新能力、没有新增配置字段；健康面板「资费」列只是接通既有声明，属修复非 feat。

### 修复

- **免费标签在双源合并处丢失**：`availProjection` 合并现在透传 Host 行的 `freeSignal` 标签（账本源无标签，不能覆盖 Host 证据），实测 / 声明信号才能到达下游判据与面板。
- **账号倍率 / costModel 未进判据**：概览候选、账号「只看免费」筛选、自动探测三处统一使用同一份账号声明与 Host 标签；倍率输入框移到账号卡顶层可见处，仍是单一输入点（写回 ranking 嵌套字段）。
- **健康面板接通资费列与端到端门禁**：账号 / 路由两张表都展示来自 `availProjection` 的 `freeSignal` 最强档；新增 `test/free-ui-chain.test.mjs`，从源码断言合并透传、三处调用实参、表头与倍率输入位置，并纳入 `--unit` 白名单。
- **文档口径补齐**：README / `docs/DETAIL.md` / `docs/DETAIL.en.md` 明确免费标签分实测 / 声明 / 未实测三档、账号倍率 0 属声明级且可被实测付费证据推翻；probe 71/71 `unknown` 仍是【待验证】根因，不宣称探测已能下结论。

### 验证（2026-11-26 实测）

- `env -u DSH_NODE_EXECUTABLE node scripts/run-tests.mjs --unit`：两轮均退出码 0、fail 0（轮次与断言数以实测输出为准）。
- `DSH_NODE_EXECUTABLE='/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT' node scripts/run-tests.mjs`：两轮均退出码 0、fail 0（轮次与断言数以实测输出为准）。
- 版本号三处一致：`package.json` / `client.js` 的 `PLUGIN_VERSION` / 本文档均为 `2.3.1`。

## 2.3.0

本轮为免费判据统一版本，由 `2.2.0` 升级到 `2.3.0`（新增设置页价格倍率编辑与 Host/浏览器一致性门禁，按语义化版本 minor 递增）。用户口径「名字带 free 或者倍率为 0 的可以默认认为免费」被裁决为弱信号 / 用户声明默认值，不是硬证据。

### 修复

- **免费判据两份实现会漂移**：Host `lib/free-policy.js` 与 `client.js` 内联镜像共用规则版本 `free-signal-v1` 与 24 条固定向量，但此前没有自动比对。现在 `test/free-policy.test.mjs` 在纯 Node 下抽取浏览器内联 `freeSignal` 与向量表，逐例比对 free + level（evidence / source 文案允许不同），并额外覆盖 NaN / Infinity / 字符串零 / unknown probe / 正价推翻等对抗输入；该套件已加入 `--unit` 白名单。
- **`probeReader` 是惰性闭包却按实例调用**：`lib/remote.js` 的 `projectFreeSignal` 曾把 `() => adapter?.probe` 当 probe 实例，对闭包直接 `.peek?.()`，导致实测 verdict 永远进不了 `availabilityStatus.freeSignal`。现在先解包 `probeReader?.()?.peek?.()`；行为级门禁从源码抽取该函数、注入惰性闭包验证 free / metered / 无 probe 三种结论（由 free-host 修复并验证）。
- **client strict codec 与 Host 投影可能静默脱钩**：新增逐字段门禁，确认 `AVAIL_STATUS_SCHEMA` 行只声明 `health/tier/confidence/freeSignal`，`freeSignalCodec` 恰好是 `{free,level,source}.nullable()` 且为必填键；Host `projectFreeSignal` 仅返回三字段，`evidence` 不上线。

### 新增

- **设置页价格倍率可直接编辑**：账号行的「价格倍率」可填 `0`（声明免费）、`0.8`（八折）等，留空 / 非法值回落到 1；中英文文案与 README 已同步说明「默认免费（未实测）」口径。
- **免费/资费文档口径同步**：README / `docs/DETAIL.md` / `docs/DETAIL.en.md` 写明名字含 free 或倍率 0 只是弱信号（可被真实付费证据推翻），`unknown` 不阻断弱信号、估算零价不算证据；probe 现状只说「根因待验证」，不下定论。

### 迁移与注意

- **弱信号不写 L1 billingTier=FREE**：`weak` / `declared` 只用于候选收录、筛选、排序代理与显示「可能免费（未实测）」；probe `metered`、正成本账本、付费 `billingSource`、真实正价都会推翻它。
- **`priceMultiplier=0` 只认有限数值 0**：字符串 `'0'` / `null` / 负数 / `NaN` / `Infinity` 都不是零价声明。

### 验证（2026-11-26 实测）

- `env -u DSH_NODE_EXECUTABLE node --test test/free-policy.test.mjs`：**37 条 / pass 37 / fail 0，退出码 0**（含镜像一致性 3 条新增用例）。
- `env -u DSH_NODE_EXECUTABLE node scripts/run-tests.mjs --unit`：**15 个测试文件 / 244 条，pass 244 / fail 0，退出码 0**。
- `DSH_NODE_EXECUTABLE='/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT' node scripts/run-tests.mjs`：**20 个测试文件 / 291 条，pass 291 / fail 0，退出码 0**。
- 版本号三处一致：`package.json` / `client.js` 的 `PLUGIN_VERSION` / 本文档均为 `2.3.0`。

## 2.2.0

本轮为设置页重构 + Host 韧性修复版本，由 `2.1.0` 升级到 `2.2.0`（含新增功能，按语义化版本 minor 递增）。九个提交覆盖三个方向：设置页从四 Tab 合并到三 Tab 并修复一批「看起来保存成功了其实没有」的问题，Host 侧自动链路发现 / 热更新 / 自建路由生成的韧性修复，以及探测缓存与成本趋势口径的修正。

### 修复

- **保存账号会静默把 `ranking.enabled` 写成 `false`（连带关掉择优）**：账号卡保存时无条件构造整块 `ranking` 并写回，块一旦出现，Host 读的是 `enabled === true` —— 用户只是加个账号，择优就被关掉且界面不说。现在只有用户真的改过 `ranking` / `routing` 才写该键（指纹比对），且写之前把默认值为「开」的开关物化（`withOnDefaults`：`enabled`、`routing.enabled` 未显式关就写 `true`）。「加个账号」不再顺手改择优配置。
- **开关默认值显示与 Host 相反**：界面把缺省当作「关」，Host 把缺省当作「开」，同一份配置两边读法相反。现在界面与 Host 同口径读缺省。
- **一键预设不写 `routing.strategy`**：点预设只改了权重，策略字段仍为空，Host 回落到默认值，界面显示的策略与真正生效的策略不是同一个。现在预设同时写 `strategy` 并立即回显该预设权重；`balanced` 的权重与 Host 的 `BALANCED_WEIGHTS`（四因子 .25）对齐，不再各写一套。
- **英文界面保存失败显示绿色**：失败态用了成功色常量，英文文案路径下尤其明显。现在失败一律走错误色，与中文一致。
- **保存静默丢弃不完整行**：账号行缺 `provider`（只有名字）或缺 `id`（只有 provider）时，旧实现把它 `filter` 掉、仍提示「已保存」，用户输入凭空消失。现在这种行被标红并拦住整次保存，提示缺什么；确实不想填的空行需要用户自己删。
- **`costDetail` 降级形状违反 strict codec，成本面板永久加载**：`lib/remote.js` 的 catch 路径手写了一个降级对象，缺 `savings.priceSource` / `savings.note`，客户端 strict schema 解析失败 → 整个成本区块停在 loading。现在降级形状抽成冻结常量 `EMPTY_COST_DETAIL`（`total` / `offset` / `limit` / `rows` / `timeline` / `byModel` / `savings{estimated,priceSource,note,models}`），由测试按 schema 逐字段守。
- **成本行 6 个延迟字段被客户端 codec 丢弃**：strict codec 没列 `started_at` / `first_token_at` / `finished_at` / `ttft_ms` / `duration_ms` / `tokens_per_second`，Host 明明返回了、过线即被剥掉，成本明细的 ttft / tok/s 两列永远是空的。现在 6 个字段都在 schema 里。
- **探针 `unknown` 永不缓存，每次开设置页都真打上游**：未命中缓存的 unknown 结论写不进缓存，设置页每挂载一次就发一轮 1 token 探测。现在 unknown 走短 TTL（`DEFAULT_UNKNOWN_TTL_MS` = 10 分钟，与 free/metered 的长 TTL 分开），TTL 内不再重复打上游。
- **自动链路发现被单个无适配器 provider 整轮中止**（日志实证）：`listModels` 对 `trae-enterprise` / `qoder-global` / `workbuddy-global` / `trae-global` 抛 `no adapter registered for provider X`，旧实现一个 provider 抛错就整轮中止，`auto` 链直接空。现在逐 provider 容错（抽成可导出的纯函数 `collectProviderRoutes()`：失败即跳过并计数、`continue`），循环外无条件写 `adapter.routes` 并 reconfigure，收尾打一条汇总（成功 N / 跳过 M，跳过清单截断 8 个），只有**全部**失败才 warn。
- **自建路由生成器在已有同名 provider 时 `DUPLICATE_KEY` 崩溃且写前不校验**：现在生成是幂等的（同名 provider 复用而不是再插一条），写入前先校验目标文件可解析、结构合法，失败则不落盘。
- **成本趋势按 UTC 日切桶**：时间线用 `ts.slice(0,10)` 按 UTC 切日，东八区用户在 00:00–08:00 的花费被算到前一天。现在 `localDayOf()` 按**本地自然日**分桶（offset 可注入；逐时刻取 offset，DST 行不会错位）。
- **水合同毫秒竞态**：`lib/health-persistence.js` 的账号层用 `>` 比较时间戳、路由层与探测层用 `>=`，同一毫秒内重放会覆盖实时证据。现在统一抽出 `liveWins()`：平局判给实时证据。
- **`gen-custom-routes` 替换 `chains` 时丢 `ranking` 兄弟键**：写入 `chains` 时整体重建配置对象，把同级的 `ranking` 一起冲掉。现在只替换自己负责的键，兄弟键原样保留。

### 新增

- **设置页四 Tab → 三 Tab**：原「切换链」与「账号池 + 择优」合并进**路由设置**（两张卡各自保留自己的保存按钮与语义），与**总览**、**花费与健康**一起构成 `总览 / 路由设置 / 花费与健康`。`locale` 的 zh / en 文案同步；三 Tab 的 id 为 `overview` / `routing` / `cost`。
- **首屏主操作上移**：「看完状态 → 选一个策略」在总览首屏即可完成，不必先滚到账号卡；总览上的花费入口一键跳到「花费与健康」。
- **保存按钮常驻可见 + 未保存标记 + 切 Tab 保护**：两张卡都在卡片头放保存入口（不展开任何折叠区也看得见），草稿与打开时快照有差异时显示「未保存」，切 Tab 前二次确认（「切换（丢弃修改）」/「留在本页」），不静默丢改动。
- **删除二次确认**：删除链路组 / 单个跳次 / 账号，第一次点变成确认按钮，3 秒不确认自动回退，不再单击即删。
- **加载 / 空 / 错三态分家**：加载中、真的没有数据、通道出错三种状态各有各的文案与颜色，不再用空表冒充「没有数据」。
- **诊断折叠**：`form` / `state` / 代码这类内部串收进默认折叠的「诊断」，只在失败时默认展开，正常界面不再被内部细节淹没。
- **成本概览 + ttft / tok-s 两列**：「花费与健康」先给概览（总花费 / 笔数 / 免费·付费·失败 / 按 provider），再给逐笔明细，明细列为 时间 / 模型 / tokens / ttft / tok/s / 花费 / 状态；缺值显示 `—`，不当 0。
- **账号计费与等级字段可编辑，且保留未知字段**：`speedTier` / `priceTier` / `costModel` / `quotaCost` / `priority` 在账号行内直接可改（取值来自 `lib/ranking.js` 的 `ACCOUNT_RANKING_FIELDS`，与 Host 同源）；保存时按 Host 默认值补全，`quotaCost` 只在 `costModel=subscription` 时才写；整行以展开方式重建，**用户手写的、模版里没有的字段不会被丢掉**。
- **`credentialRef` 可输入**：账号行里能填凭据引用名（只写引用，不写明文 key）；留空则不写该键，表示用 DSH 已登录的账号。
- **模型选择器支持搜索 / 只选免费 / 全选**：每个账号的模型列表可按关键字过滤、只看免费档、一键全选/全不选，不必在长列表里翻。
- **清空自定义链路**：路由设置提供「清空自定义链路」，二次确认后写 `chains: {}`（**不是** `undefined`——不赌 `set` 对 undefined 的语义；Host 侧 `{}` 会归一到默认空 `auto` 链并走自动发现），只有写入成功才提示已清空。
- **实测 ttft 接入账号择优**：`lib/account-pool.js` / `lib/adapter.js` 把账本里按 `account_id` 归集的实测延迟（`ttft_ms` / `tokens_per_second`）作为速度证据 `speedEvidence` 传给评分，取值顺序为「实测 → `speedTier` → 中性 0.5」；没有证据时评分与旧版逐字节一致。
- **热更新覆盖面补全**：volatile 热更新键从 `chains` / `accounts` / `ranking` 扩到 `health`、顶层 `routing` 与 `costEnabled` / `costDir` / `costBatchSize` / `costFlushIntervalMs`。`health` 变更保留既有 registry 引用、只换选项（opt-out 仍由 `buildHealthDeps` 唯一解析）；`cost*` 重建 `CostMeter` 并把 adapter / reader / remote 重指到新实例（旧 meter 关闭）。
- **`positionOverrides` 缺省回退随包模板**：用户文件优先，缺失或为空时回退到随包 `registry/position-overrides.yaml`（与 `registry-lib.mjs` 的 custom-routes 口径一致），两者都空才是 `{}`。

### 迁移与注意

- **老账本不迁移**：成本趋势改为按本地自然日分桶后，历史行仍按**读时的本地时区**重新分桶，不做数据迁移、不重写 `cost.jsonl`。
- **未知 verdict 缓存 10 分钟**：`probe-cache` 里 `unknown` 结论的 TTL 是 10 分钟（`DEFAULT_UNKNOWN_TTL_MS`），到期后才会重新探测；期间上游恢复也不会立刻反映到「可能免费」分区。
- **清空链路写的是 `{}`**：若你手工把 `chains` 写成 `null` / `undefined`，Host 同样归一到默认空链；两者等价，但界面产生的是 `{}`。
- **未配置 `health` / `routing` / `cost*` 时行为与日志逐字不变**：热更新扩面只影响「改了这些键」的路径。

### 验证（2026-11-26 实测）

- 全量门禁 `DSH_NODE_EXECUTABLE="/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT" node scripts/run-tests.mjs`：**19 个测试文件 / 254 条测试，pass 254 / fail 0，退出码 0**。
- 纯逻辑子集 `env -u DSH_NODE_EXECUTABLE node scripts/run-tests.mjs --unit`：**14 个测试文件 / 207 条测试，pass 207 / fail 0，退出码 0**。
- `node --check client.js`：退出码 0。
- 相对 2.1.0 记录的 233 / 197 条，两套门禁分别增加 21 / 10 条断言（新增覆盖：`costDetail` strict schema 形状与 catch 路径、本地日分桶、水合同毫秒平局、探针 unknown 短 TTL、自建路由生成幂等与写前校验、实测 ttft 择优）。
- `test/probe.test.mjs` 的 TTL 用例改为**注入时钟**推进过期（原写法用 5ms 真实 TTL 卡「刚写完还算新鲜」，与 `appendFile` 落盘排队竞速，并发负载下 25 次跑出现过 2 次假红）。断言一条没删、语义未放宽，过期靠推进 `Date.now` 而不是睡眠。稳定性证明：`--unit` **连跑 10 次全部 exit 0**（每次 207/207）、全量 **连跑 3 次全部 exit 0**（每次 254/254）。
- 版本号三处一致：`package.json` / `client.js` 的 `PLUGIN_VERSION` / 本文档均为 `2.2.0`。

## 2.1.0

本轮为合并基线版本，由 `2.0.0` 升级到 `2.1.0`（含新增功能，按语义化版本 minor 递增）：合并远端 1.x 健康管理等提交（任务单记 12 个，`fetch` 后实测为 28 个，远端 `master` 由 `4e0f79d` 前进到 `bcad446`）+ 工程标准补齐完整基线。两侧内容逐文件合并保留，未丢弃任何一方：

- **远端 1.x 工作（1.1.0 / 1.2.0 / 1.2.1 / 1.3.0 及后续健康 converge 提交）**：延迟度量六字段与实测速度因子、冷启动健康水合、tier 诊断可行动化、query-cost 报表两段、`positionOverrides` 双形态、健康单一分类法与 parity guard、冷却权限收敛、`@Remote` 账号健康面板、真实账号数显示等全部功能 / 文档 / 测试；新增 `lib/health-persistence.js`、`lib/health-snapshot.js`、`lib/health-taxonomy.js`、`lib/pricing.example.json`、`scripts/run-tests.mjs` 与 18 个测试套件。
- **本地 v2.0.0 工程标准**：签名 tag、Wiki 文档、安全配置（SECURITY / dependabot / CODEOWNERS）、Git Flow 分支模型、7 语言本地化（`zh` / `en` / `es` / `fr` / `de` / `ru` / `pt`，无 `ja`）、star 提示、CHANGELOG 2.0.0 段、多语详情页与 README 七语切换行。
- **冲突修复**：`test/health.test.mjs` 中远端测试对 `/home/pt` 用户目录的硬编码假设改为按 `homedir()` 动态校验（原始断言在用户为 `pt` 的机器上必然失败，已在 `origin/master` 原始 worktree 上独立复现）。

**版本变更**：`2.0.0 → 2.1.0`。验证：全量 `node --check` 45/45、7 语 locale 解析与键一一对应、全量测试 233/233 通过（退出码 0）。

## 2.0.0

本轮为工程标准补齐版本，由 `1.0.0` 升级到 `2.0.0`。一次性补齐以下六项工程标准：

1. **签名 tag**：配置 SSH 签名（`gpg.format=ssh`、`user.signingkey` 指向 `id_ed25519_github_docker_panel.pub`、`tag.gpgSign=true`、`.git/allowed_signers`），发布 tag 全部带签名并可本地验签。
2. **Wiki 文档**：补齐 GitHub Wiki 页面，集中说明安装、配置、路由与健康管理等主题。
3. **安全配置**：补齐仓库安全配置与依赖/凭据检查，明确敏感信息不入库、日志脱敏等口径。
4. **Git Flow 分支模型**：落地以 `master` 为发布分支、`develop` 为本地集成分支的分支模型；`feature/*` / `fix/*` 从 `develop` 开合回 `develop`，`release/*` / `hotfix/*` 双向合流（`master --no-ff`、`develop` fast-forward 保持 divergence 0/0）。
5. **7 语言本地化**：`locale/` 覆盖 `zh`、`en`、`es`、`fr`、`de`、`ru`、`pt` 共 7 种语言。
6. **star 提示**：在文档中补充对仓库 star 的提示，方便用户支持项目。

**版本变更**：`1.0.0 → 2.0.0`。

### 语义化版本口径

- `feat`（新功能）→ minor 递增（如 `1.0.0 → 1.1.0`）
- `fix` / `docs`（修复、文档）→ patch 递增（如 `1.0.0 → 1.0.1`）
- major 递增（如本轮 `1.0.0 → 2.0.0`）**由用户明确确认**，不由提交类型自动推导。

## [1.3.0] - 2026-11-25

### Added

- **设置页「账号健康 / 冷却」面板读取真实运行时数据**：此前该区块只有一段占位说明。现在 `lib/remote.js` 新增第 5 个 `@Remote` 方法 `smartProvider.accountHealth()`（`invocation: direct`、零参数；任何异常都降级成显式的「未启用 / 一无所知」快照而不是抛出 —— 线上契约没有错误通道，抛出去只会让设置页永久空白且不给原因），`client.js` 新增对应的 strict codec 描述符（`@local/dsh-smart-provider#smartProvider/accountHealth`，`mode:'strict'` + 非空 `typeSymbol` + `create()`，三者缺一整个命名空间挂不上）与 `AccountHealthPanel` 渲染。`index.js` 注入的是**惰性** `healthReader`：适配器在下方才构造，提前求值会捕获 `undefined` 并让面板整场会话冻结在空快照上。
- **README 补充 ranking 字段说明**：补记 `costModel`（`metered` / `subscription` / `free`，默认 `metered`；订阅制以额度消耗代价代替价格）与 `quotaCost`（0–1，仅 `costModel=subscription` 时显示）两项账号级计费 / 额度字段，源自 `f386493`。
- **`lib/health-snapshot.js` 纯函数快照构建器**：`buildHealthSnapshot(input)` 无 I/O、不 import DSH、不改入参、永不抛错，`now` 由调用方注入以便测试确定性。读路径**不写注册表**：`COOLING` 且 `until` 已过期时纯推导为 `HALF_OPEN`（这正是 `account-health` 的 `stateOf()` 规则，但 `stateOf()` 会把状态写回容器，读路径不能用它）；有效冷却取 `max(账号记录 until, adapter.cooldowns until)` 两层取大 —— 两层都能阻断派单，UI 必须与派单一致；虚拟副本（`isVirtual === true`）永不作为真实路由出现在列表里。畸形或缺失的输入降级为空数组 + `enabled:false`，不抛错。

### Changed

- **设置页不再显示占位说明文案**：改为「账号池状态」表（账号 / 路由 / 状态 / 剩余冷却 / 连续失败 / 尝试次数 / 成功·失败样本；链路派生的隐式账号带「自动派生」标记）与「各模型路由健康」表（路由 / 模型 / 健康 / 计费档 / 可信度 / 样本），并显示快照时间与手动「重新读取」按钮 —— **刻意不用 `setInterval` 倒计时**，避免定时器泄漏。
- 版本号 `1.2.1 → 1.3.0`（本次为 feat 级，minor）；`client.js` 的 `PLUGIN_VERSION` 常量同步到 `1.3.0`。
- 文档同步实测数字（2026-11-25，退出码 0）：全量门禁 **14 个 suite / 188 条断言全过**，纯逻辑子集 **9 个 suite / 152 条断言全过**；新增 `test/health-snapshot.test.mjs`（13 条）与 `test/remote-surface.test.mjs`（7 条），两者都已注册进 `--unit` 白名单。

**诚实性契约（本次一并保留，新面板必须遵守）：**

- **零样本显示「暂无数据」，绝不显示「不可用」**：状态为 `UNKNOWN`、字段缺失或值畸形时一律中性色 +「暂无数据」；只有 `ACTIVE` / `HEALTHY` 用绿色，冷却与降级用警告色（**不用 error 红**），未知值退中性灰。
- **健康层关闭时明说关闭**：`health: false` / `health.enabled: false` / `ranking.health.enabled: false` 时面板显示「健康层当前是关闭的」，不假装正常、不拿空表冒充健康。
- **通道不可用时显示诊断行**：失败原因不隐藏，也不静默留白。

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

## 1.0.0

首个发布版本：智能模型路由元提供商，支持额度自动切换、多账号池、账号择优与离线成本统计，提供三层健康自动管理能力。
