# 智能模型路由（Smart Provider）

一个注册为 `smart` 路由的元提供商。它本身不调用任何大模型 API —— 而是在你**已配置的 DSH 供应商路由**之间按序尝试，选取第一个能响应的路由。它是**通用智能路由**，不是省钱工具：四个目标是省钱 / 高性能 / 高能力 / 复合（智能），代码默认中立（均衡权重 .25），省钱优先是用户自己的 config 选择。

**当前状态：插件已安装并启用，已设为默认模型，插件状态 ACTIVE。** 智能路由默认生效；省钱链路、配置页真读写、P1（资源自适应 / 中立默认 / 动态链）、P2（两层智能路由，默认关闭）、三层健康自动管理（默认开启）均已落地并独立验收。路由顺序随你的实时注册表与配置决定，本文档不写死具体数字。

## 功能特性

- **默认生效的智能路由。** `smart/auto` 是默认模型，已在真实会话中验证选路与回退。内置链表刻意为空，未配置时由 `discoverAutoChain()` 从实时 DSH 注册表生成中立 `auto` 链（按 provider / model 名排序，不内置任何具体用户的模型）。
- **省钱链路（用户可选，不是默认）。** 免费路由 `x-opencode-free`（`hy4-flash-free`）由 `registry/custom-routes.user.yaml` 的 `tier: free` 自动排在链首，真实账本中该路由每笔 `estimated_cost_usd=0`（已核对 213+ 笔）；遇到 402/配额错误回退到付费路由。
- **账号池（多账号 = 池化）。** 模型与账号是两个独立维度。每一跳的模型映射到一个账号池（`{id, provider(路由), credentialRef, models[]}`）；优先选择本跳路由上的健康账号，再按最少使用排序；转向下一个模型前会尝试该模型的每一个健康账号。DSH 每条路由只绑定一个 key，因此第二个账号 = 第二条 provider 路由。可选 `accounts` 数组；不配置时行为与旧版逐字节一致。
- **账号级冷却。** 冷却以 `accountId` 为键，而非 `provider/model`。某个账号遇到 402 或配额错误只冻结该账号，同模型的其他账号继续服务。
- **三层健康自动管理（默认开启）。** 模型层（`lib/availability.js`）、账号层（`lib/account-health.js`）、拓扑层（`lib/provider-topology.js`）分开记账，共享同一份注册表；参数不兼容或缺少 session 头的 4xx 不连累模型健康；账号冷却到期只进入 `HALF_OPEN`，需要一次真实请求成功才恢复 `ACTIVE`（没有证据就没有恢复）；自带账号池的路由不会被再套一层账号池（凭结构化证据判定，无 provider 名字白名单）。用 1 token 的真实探测替代“按模型名猜免费/付费”，结论 `unknown` 永不阻断选路。关闭方式：`health: false`、`health.enabled: false` 或 `ranking.health.enabled: false`，关闭后逐字节回 legacy。
- **仅在建立前回退。** 一旦发出任意文本、推理或工具调用块，响应即提交 —— 不会回退你已经看到的 token；`ABORTED` 永不回退。
- **逐次尝试的会话记录。** 每次尝试写成一条可忽略的插件记录 `plugin:dsh-smart-provider/hop-selected`，载荷为
  `{event:'smart/hop-selected', hopIndex, provider, model, accountId, failureCode, at}`。
  这是 `smart/hop-selected` 的安全仓库外扩展方式：直接发未知事件类型会让会话持久化拒绝恢复日志。
- **账号择优 ranking（P1，默认关闭）。** 成本 / 速度 / 等级 / 负载四因子评分；`balanced` 中立默认（.25），`cost-first` 等是显式选项；关闭时保持旧行为（路线优先 + 最少使用）。
- **两层智能路由 routing（P2，默认关闭）。** `lib/routing.js` 四个纯函数：请求分类、模型位置标签推导、候选层选择、预设解析。只有 `ranking.routing.enabled=true` 才激活；未配置时逐字节走 legacy。8 种策略预设：`balanced` / `cost-first` / `speed-first` / `reasoning-first` / `longctx-first` / `vision-first` / `legacy` / `custom`。位置标签从模型 catalog 自动推导（reasoning / contextWindow≥200000 / 输入含 image / tool!==false / 通用），可用 `positionOverrides` 手填纠正；配置错误只会 WARN 并回退 legacy，不会崩溃。
- **成本 / 健康 Tab 真账。** 成本页通过 `@Remote` 服务 `smartProvider.cost()`（`lib/remote.js`）读取 `lib/cost-stats.js` 对真实 `cost.jsonl` 的聚合（总花费 / 免费 / 付费 / 失败 / 按 provider），不是估算占位；设置页同时展示来自 pi-ai 的真实 provider / model 与凭据名。

## 配置方式

`chains`、`accounts`、`ranking`、`ranking.routing`、`health` / `ranking.health` 均为 volatile 配置，设置页改完即时生效，无需重启。健康层可调 `health.accountHealth`（半开许可数 / 退避倍数 / 冷却上限）与 `health.topologyOpts`（拓扑证据），`health.virtualProviders` 追加虚拟路由（`smart` 永远在内）。routing 配置嵌在 `ranking.routing` 下（schema.js:62-67），字段：`enabled` / `strategy` / `tierPolicy` / `weights` / `positionOverrides` / `tierLimit` / `longContextTokens` / `dynamicAuto`。未配置时代码路径完全不运行；显式 `chains` 键与 `*` 始终优先于 `dynamicAuto`，老配置不会被动。账号池 `accounts` 每项形如 `{id, provider, credentialRef, models[]}`，省略时按旧 per-hop 模式运行。自建路由只在 `registry/custom-routes.user.yaml` 声明（`credentialRef` 只放引用名，绝不放明文 key）。

详细设计依据父工作区的文档：`meta-provider-设计方案.md`、`多账号池设计方案.md`、`方案盲点审查.md`、`可用性自动管理设计.md`、`账号池自动管理深化设计.md`、`落地规格.md`。验证入口见包根目录 `npm test`（`scripts/run-tests.mjs`）。

---

## English summary (secondary)

A meta-provider registered as the `smart` route, currently **installed and enabled** as the default model. It is a general intelligent router (cost / speed / capability / composite), neutral by default in code; saving-first is an opt-in user config. Verified: `smart/auto` in real sessions, `x-opencode-free` free first hop (cost=0, 213+ real ledger rows) with 402→paid fallback, a settings page with real pi-ai resources and an `@Remote` real-ledger cost tab, P1 resource adaptation, P2 opt-in two-layer routing (`ranking.routing.enabled=true`, 8 presets, byte-for-byte legacy when off), and default-on three-layer health auto-management (model / account / topology layers with half-open recovery, structural aggregator detection, and a 1-token free-vs-metered probe; explicit opt-out returns byte-for-byte legacy). See the package README for the full configuration and verification commands.
