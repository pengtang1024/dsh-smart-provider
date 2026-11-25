# 安全策略

## 支持版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| `2.x`（当前维护线，从 `2.0.0` 起） | 是 |
| `1.x` 及更早 | 否，请先升级到受支持的最新版本 |

当前只维护 `2.x` 版本线。旧版本的问题如果在新版仍然存在，会在新版修复；不单独为旧版本发补丁。

## 私密报告

**不要为安全漏洞开公开 issue、PR 或 discussion**，也不要在公开渠道贴出可利用细节。请任选一种私密方式：

1. GitHub Security Advisories（首选）：<https://github.com/pengtang1024/dsh-smart-provider/security/advisories/new>
2. 邮件：<pengtang1024@qq.com>，主题建议加 `[SECURITY]` 前缀。

报告里尽量写清：

- 受影响的 `2.x` 具体版本；
- 复现步骤或最小 PoC；
- 实际影响（例如能否读取成本账本、篡改配置或影响选路）；
- 如果方便，附上修复建议。

## 响应时限

- **3 个工作日内**确认收到报告，并给出初步判断。
- 确认是有效问题后，会说明修复计划；修复发布后，在 GitHub Security Advisory 中记录影响版本与修复版本。
- 如果判断不属于本仓库范围，会说明原因并指向对应的上游渠道。

## 范围

本仓库负责**插件自身**的安全问题：

- `lib/adapter.js` 注册的 `smart` 元适配器，以及 `lib/chains.js`、`lib/routing.js`、`lib/ranking.js` 的选路、回退与账号择优逻辑；
- `lib/account-pool.js`、`lib/account-health.js`、`lib/availability.js` 的账号池、冷却与可用性状态；
- `registry/custom-routes.user.yaml` 声明的自建路由及 `scripts/gen-custom-routes.mjs`、`scripts/validate-custom-routes.mjs` 的读写与校验；
- `lib/cost-meter.js` 写入、`lib/cost-stats.js` 聚合的成本 JSONL 账本，以及 `scripts/query-cost.mjs` 查询脚本；
- `client.js` 通过 `window.__ModuleLoader__.load` 注入的 `settings.section` / `settings.section.icon` 设置页，和 `lib/remote.js` 暴露的 `smartProvider` `@Remote` 服务；
- `index.js` 插件入口、`schema.js` 配置 schema 与随插件发布的 bundle 描述文件。

**不属于本仓库范围**：DSH 宿主本身（含 `llm-pi-ai` 的 provider 路由与凭据存储）、插件加载器、渲染进程沙箱、Web 服务端、宿主内置组件和上游模型服务。这类问题请走 DeepSeek Harness 官方渠道：

- <https://github.com/deepseek-ai/deepseek-harness/security>
- 或该仓库 / 官网公布的其它安全报告入口。

本包 `package.json` 没有声明 npm 依赖清单；Dependabot 的 npm 条目目前是空操作，github-actions 条目按周检查Actions 更新。设置页 `client.js` 只 `require` 宿主提供的 `react`、`zod` 与 `@deepseek-ai/dsh-client-ui-primitives`；Host 侧使用宿主环境中的 `@deepseek-ai/dsh-typert-protocol` 与 Cordis 服务框架。`scripts/` 下的脚本只在开发时运行，使用 Node 内置模块读写仓库与本地数据文件，不随插件在浏览器中运行。

## 安全设计说明

- **真实密钥不进本仓库配置。** 真实 API key 始终保存在 DSH 凭据中；本插件的配置、`registry/custom-routes.user.yaml` 与设置页里只有 `credentialRef` 这样的**凭据引用名**，没有明文 key。`scripts/validate-custom-routes.mjs` 只读取凭据文件的键名做存在性核对，不读取也不输出键值。
- **设置页不直连模型服务。** `client.js` 不包含 `fetch`、`XMLHttpRequest`、`WebSocket`、`eval`、`new Function`、`innerHTML` 或 `dangerouslySetInnerHTML`；UI 由 `React.createElement` 构建。模型探测只能由 Host 侧 `lib/probe.js` 触发，单次 `max_tokens≈1`，有 TTL 缓存与每次调用上限，需用户主动操作，且不会探测 `smart` 自身。
- **成本账本本地写入。** 每个完成的跳次异步批量追加一行到 `cost.jsonl`（默认在 `~/.dsh/smart-provider/`，目录可配置），记录 token、估算费用、provider/model、`accountId` 与失败码；不等待 LLM 流，磁盘错误只记 WARN。写入前的 `sanitizeFailureMessage()` 会遮盖 Bearer / api-key / token 形状的片段并截断到 300 字符，避免上游错误体把秘密或大段 payload 带进账本。价格来自仓库内只读导出的 `lib/pricing.json`，是公开标价的离线估算，不是账单。
- **配置即时生效但不越权。** `chains`、`accounts`、`ranking.routing` 是 volatile 配置，设置页改完即时生效；`summary` / 成本 / 健康信息经 `@Remote` 服务读取真实账本与注册表。插件只通过 DSH 提供的插槽与服务工作，不绕过宿主的权限与审批机制。

## 已知边界

- `cost.jsonl` 是本地明文 JSONL：里面有 token 用量、估算费用、账号引用名与脱敏后的诊断文本，**不含真实 key，但仍应作为敏感数据保护**，不要公开发布原始账本。
- `registry/custom-routes.user.yaml` 是自建路由的唯一人工编辑点。填写时只能写 `credentialRef` 引用名；**不要把明文 key 粘进 YAML、issue 或对话**。
- 插件以本地目录 bundle 安装，安装会加载 `client.js` 与 Host 入口。请只从本仓库或你信任的来源安装，不要安装来路不明的改包。
- 成本与可用性的结论依赖你的真实配置、运行时注册表和账本；文档中的示例路由与模型名只是示例，不代表本仓库内置任何特定账号或端点。
