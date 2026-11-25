# 贡献指南

本文档描述 `dsh-smart-provider` 仓库的真实协作口径。请以本文件为准，不要照搬通用模板里与实际情况不符的表述。

## 1. 分支模型（本仓库实际口径）

- **GitHub 默认分支是 `master`，它是发布分支**；`origin/master` 是唯一远端主干。
- **`develop` 是本地集成分支**，由 `master` 创建，日常开发都基于它进行。
- `feature/*`、`fix/*`：**从 `develop` 开出，合回 `develop`**，不直接进 `master`。
- `release/*`、`hotfix/*`：**双向合流 `master` 与 `develop`**：
  - 合入 `master`（发布侧）必须用 `git merge --no-ff`，保留清晰的发布边界，便于回溯每个发布版本。
  - 回灌 `develop` 用 fast-forward，保持 `develop` 与 `master` 的 `divergence` 为 `0/0`。
- 发布时在 `master` 上打带签名的 tag，版本号遵循第 4 节的语义化口径。

### 与通用模板的差异

很多通用贡献模板写的是「默认分支 `main`」，**本仓库不是这样**：GitHub 上的默认分支叫 `master`。模板里的 `main` 在本仓库一律对应 `master`。

> 本轮工程标准补齐**不修改 GitHub 默认分支**，`master` 仍然是默认分支、`develop` 仍然是本地集成分支。任何改默认分支的动作都需要单独向用户申请并得到明确授权。

## 2. 命名与提交约定

- 分支名、目录名、文件名一律 **kebab-case**（如 `feature/cost-health-meter`、`fix/route-cooldown`）。
- 提交信息格式：`type(scope): 中文描述`，其中 `type` ∈ `feat` / `fix` / `perf` / `refactor` / `chore` / `docs`。
  - 例：`feat(router): 增加账号池择优策略`、`docs(readme): 补充七语言说明`。
- **精确暂存**：使用 `git add <具体文件>`，只暂存自己修改的文件或 hunk。
- **禁止 `git add .`**，避免把无关文件、备份目录或他人未完成改动一起纳入提交。
- **禁止 force push**（尤其是对 `master` / `develop`）。
- **push 必须得到用户明确授权后才执行**；未经授权只做本地提交，不推送远端。

## 3. 签名约定

签名约定必须与本仓库实际 `git config` 一致：

- `gpg.format=ssh`
- `user.signingkey=/home/pt/.ssh/id_ed25519_github_docker_panel.pub`
- `tag.gpgSign=true`（tag 必须带签名）
- `gpg.ssh.allowedSignersFile=/home/pt/Work/DshProjects/dsh-plugin/dsh-smart-provider/.git/allowed_signers`（即本仓库 `.git/allowed_signers`，按参考项目同口径用绝对路径配置），用于本地验证签名

以上均为 `git config --local`（仅本仓库生效）。`.git/allowed_signers` 中的签名者行对应 `pengtang1024@qq.com` 与上述 SSH 公钥，不要随意改动，否则本地验签会失败。

验证签名可用：`git verify-tag <tag>` / `git log --show-signature`。不要改用 GPG 密钥或另一把 SSH 公钥，否则与现有配置及 allowed signers 不匹配。

## 4. 版本与变更记录

- 版本号采用语义化版本：`feat` → minor，`fix` / `docs` → patch。
- major 版本升级（如本轮 `1.0.0 → 2.0.0`）必须由用户明确确认，不能自行决定。
- 每次发布同步更新 `CHANGELOG.md`。

## 5. 提交前检查

提交前至少跑一次项目现有的快验证（语法检查、测试或构建，按项目实际具备的命令选择），确认自洽后再按第 2 节口径精确提交；验证未过、改动不自洽或无法区分他人改动时不要提交，并明确报告阻塞。
