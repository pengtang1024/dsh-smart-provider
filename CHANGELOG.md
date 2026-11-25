# 变更记录

本文档记录 `dsh-smart-provider` 的发布变更。版本号采用语义化版本（SemVer）。

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

## 1.0.0

首个发布版本：智能模型路由元提供商，支持额度自动切换、多账号池、账号择优与离线成本统计，提供三层健康自动管理能力。
