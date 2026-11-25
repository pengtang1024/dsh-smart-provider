# 哨鱼（原「主理鱼」/ dsh-session-superagent）自建 Gitea 适配 + 改名补丁

## 为什么要打这个补丁

`/home/pt/.agents` 的唯一远端是自建 Gitea：
`https://gitea.iouf.cn/live-game/agents.git`（Gitea 1.27.3，**不是**码云 Gitee）。

插件 0.10.12 只支持 GitHub 与 gitee.com，具体三处硬编码：

| 位置 | 原值 | 后果 |
|---|---|---|
| `lib/gitee.js:14` | `GITEE_API = 'https://gitee.com/api/v5'` | 请求全打到码云，自建 Gitea 永远 401 |
| `lib/watch.js:1265` | `parseRepoSpec` 只认 github.com / gitee.com | `gitea:` 前缀与 `gitea.iouf.cn` URL 被拒 |
| `lib/index.js:2387` | 令牌只收 32 位十六进制 | Gitea 令牌是 40 位，面板填不进去 |

另外 `watchers.json` 原本是空的 —— 必须在会话里显式 `watch_start` 登记仓库才会轮询，这是「一直没动静」的第一层原因；上面三处是第二层（登记了也读不到）。

## 顺带改名：主理鱼 → 哨鱼

原名「主理鱼」名不副实：它不替你下结论、也不改代码，只干三件事 —— **盯仓库 → 有动静把任务书推给会话 → 处理完打标不再重复叫**。所以换掉「主理」，保留吉祥物「鱼」，取「放哨」的「哨」，定名 **哨鱼**。

品牌名与两个「已处理」标签是**三个独立字段**，必须一起对齐，否则抬头换了、仓库里的标签还是旧名：

| 字段 | 旧值 | 新值 | 位置 |
|---|---|---|---|
| 品牌名（唤醒抬头 / 面板标题 / tab / 会话规则） | 主理鱼 | 哨鱼 | `lib/watch.js` `DEFAULT_BRAND_NAME` + `client.js` 等 6 个运行时文件共 46 处 |
| GitHub 默认 ack | 主理鱼:已处理 | 哨鱼:已处理 | `lib/watch.js` `DEFAULT_ACK_LABEL` |
| Gitea/Gitee 默认 ack | 主理鱼-已处理 | 哨鱼-已处理 | `lib/gitee.js` `DEFAULT_ACK_LABEL_GITEE` |
| 已登记守的 ackLabel | 主理鱼-已处理 | 哨鱼-已处理 | `~/.dsh/state/session-superagent/watchers.json[.bak]` |

`CHANGELOG.md` / `docs/` / `README.md` / `SETUP.md` 是上游历史与说明文档，**不动**；运行时源码里「主理鱼」全是默认值 / 文案 / 注释 / 会话规则抬头，无标识符或键名用法，可安全全局替换（已 grep 核对 `localStorage` / `key` / `note:` / `data-` 均无命中）。

## 改了什么

补丁脚本：[apply-gitea-patch.py](apply-gitea-patch.py)，作用在
`/home/pt/.dsh/profiles/desktop/node_modules/dsh-session-superagent/`：

- **`lib/gitee.js`（9 处）**：API 基址改为 `https://gitea.iouf.cn/api/v1`（可用
  `DSH_SUPERAGENT_GITEA_API` 覆盖）；`per_page→limit`；`/issues` 加 `type=issues`
  去重（否则 PR 被 issues 与 pulls 各返一次）；`/pulls` 不传 `since`；PR 评论与
  最后评论统一走 `/issues/{n}/comments`；打标签 body 由裸数组改成
  `{"labels":[...]}`；`draft` 读布尔字段；`assignees` 支持数组；标签列表分页用 `limit`。
- **`lib/index.js`**：令牌形状校验放宽到 `32 或 40 位十六进制`；一条历史迁移注释泛化。
- **`lib/redact.js`**：脱敏规则同步覆盖 40 位十六进制，避免令牌漏进对话。
- **`lib/watch.js`**：`parseRepoSpec` 新增 `gitea:owner/name` 前缀与
  `gitea.iouf.cn` URL 识别（归一到现有 `gitee` provider 分支，不新增分支）。
- **品牌改名**：`lib/*.js` + `client.js` + `bin/check.mjs` 共 6 个运行时文件里
  「主理鱼」→「哨鱼」；`lib/index.js` 一条讲「0.9.184 之前旧标签」的历史注释泛化，
  不改成假史料。
- **state 对齐**：`watchers.json` 与 `.bak` 里已登记守的 `ackLabel` 改成
  `哨鱼-已处理`（`entry.ackLabel ||` 会短路新默认值，光改代码不够；`.bak` 一起改，
  否则主文件损坏回退时会把旧标签带回来）。

**没有新增 provider**：现有所有 `provider === 'gitee'` 分支原样复用，只是它们现在
指向自建 Gitea。

脚本**幂等**：`EDITS` 每条用 `done` 子串判重、品牌替换用「还有没有旧名」判重、
state 用「ackLabel 是否已是新值」判重；二次运行全部 0 处。写前一律留
`*.orig-gitea` 原始备份。支持 `SUPERAGENT_DIR` / `DSH_SUPERAGENT_STATE` 覆盖路径。

原始文件备份：
- 插件目录内 `*.orig-gitea`（7 个文件，随包）
- 工作区 [.superagent-backup/](.superagent-backup/)（独立副本，重装插件也不会丢）

验证脚本：[verify-gitea.mjs](verify-gitea.mjs)（`node verify-gitea.mjs`，32 项，
真实 Gitea 只读 + 写入形状用 mock fetch 验证，**不会写仓库**；含品牌名 / ack 标签 /
字面量残留断言）。

## 当前状态：已落盘、已验证

- 令牌已写入 `~/.dsh/state/session-superagent/secrets.json`，权限 `0600`，字段
  `giteeToken`（取自 git credential store，全程未回显，40 位十六进制）。
- 守望规则已登记并持久化在 `~/.dsh/state/session-superagent/watchers.json`：
  `gitee:live-game/agents#session-b9b01d69-d175-435c-9829-9a2b3a43aab0`，
  每 60 秒轮询，ack 标签 `哨鱼-已处理`。
- 旧代码（打码云）遗留的 `lastError` / `needsReauth` / `nextAt` 已清理。
- `watch_doctor` → `OK gitee:live-game/agents 可访问`；`watch_status` →
  `lastError: null`、`needsReauth: false`、`ackLabel: 哨鱼-已处理`。
- 验证全绿：7 个 JS 文件 `node --check` OK、补丁二次运行 0 处、运行时源码
  无「主理鱼」残留、`verify-gitea.mjs` 32 项全 PASS。

**加载时序（重要）**：Node ESM 模块与前端 bundle 都在进程启动时缓存，改盘不立刻生效。
Gitea 补丁在 13:21 时宿主已自动重载并生效；但改名（13:47）之后 `/state` 仍回
`brandName: 主理鱼` —— 它是 `apply()` 里算一次的模块级常量（`lib/index.js:1207`
注释也写明「客户端热重载会生效，服务端不会」）。

- 这**只影响唤醒抬头 `【…】` 与面板标题这两个文案**；功能（轮询、ack 标签）不受影响，
  `ackLabel` 已从磁盘正确读到 `哨鱼-已处理`。
- 已确认旧进程不会把新标签覆盖回写：`ackLabel` 不在 `POLL_RESULT_FIELDS` 白名单，
  `persistEntry` / `writeState` 均以磁盘值为底稿。
- **下次 DSH 重载 / 重启后**抬头与面板会变成 `【哨鱼】` / 「哨鱼」，轮询按 `apply()`
  启动时遍历 `state.watchers` 自动恢复，不需要再做任何操作。本次未擅自重启宿主
  （会打断会话，且用户未要求）。

自检命令：

```bash
watch_doctor            # OK gitee:live-game/agents 可访问
watch_status            # lastError 为空、ackLabel = 哨鱼-已处理
node verify-gitea.mjs   # 32 项，全部 PASS
```

## 插件升级 / 重装后

npm 安装会覆盖 `lib/*.js` 与 `client.js`，Gitea 适配与改名都会丢失。重跑一次即可
（幂等，已打过的会跳过）：

```bash
python3 apply-gitea-patch.py
```

然后按上面重启 DSH。

## 回退

```bash
cd /home/pt/.dsh/profiles/desktop/node_modules/dsh-session-superagent
for f in lib/gitee.js lib/index.js lib/redact.js lib/watch.js lib/gh-format.js client.js bin/check.mjs; do
  cp -p "$f.orig-gitea" "$f"
done
```

再把 `watchers.json` / `.bak` 里的 `ackLabel` 改回 `主理鱼-已处理`（或删掉那条守）、
删掉 `secrets.json` 里的 `giteeToken`，重启 DSH 即恢复到原版行为。

## 已知边界

- 只适配了这一个自建实例；换实例需设 `DSH_SUPERAGENT_GITEA_API`，若域名不是
  `gitea.iouf.cn`，`parseRepoSpec` 里的 URL 白名单也要同步加。
- 面板文案仍写「Gitee 令牌」，指的是同一个字段（`giteeToken`），功能正确但字面
  有歧义；改 `client.js` 属于 UI 层，本次未动。
- 目标仓库当前 0 issue / 0 PR / 0 label，所以「唤醒」路径无法用真实条目端到端
  触发；已验证的是读端点 200、字段归一化、去重参数与两个写入端点的请求形状。
- 运行中的宿主在重载前，`/state` 的 `brandName` 仍是 `主理鱼`（见「当前状态」）。
