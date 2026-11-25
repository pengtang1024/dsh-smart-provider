# P0 恢复指南：no adapter registered for provider "x-opencode-free"

## 症状与根因（已核实）

- 运行期报错：`no adapter registered for provider "x-opencode-free"`（host 日志 `agent.failed`, code `NO_ADAPTER`）。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 中 `x-opencode-free` 只出现在 smart-provider 的 `chains` 里（6 处），**没有** `llm-pi-ai.providers` 注册、`providers:` 锚点或 `custom-routes:providers` marker。
- `scripts/gen-custom-routes.mjs` 原逻辑在锚点缺失时只 `warn + skip`，于是每次重组后自建路由都没有 adapter。chains 声明了路由但 patch 没注册 = 假绿 + 真实故障。

## 生成器修复（本提交）

- `gen-custom-routes.mjs`：锚点缺失时不再静默跳过，改为给**唯一的 llm-pi-ai 条目**写入 `config.providers`（marker `custom-routes:providers-insert`）。绝不创建第二实例（见下方「撞车机制」）。不声明 `smart`（DUPLICATE_ADAPTER 硬拒绝）。
- marker：`# >>> custom-routes:providers-insert >>>` / `# <<< custom-routes:providers-insert <<<`，幂等（两次 `--write` byte-identical）。
- `validate-custom-routes.mjs`：第 8 组检查——registry 里声明的 route 必须在 live patch 中有 adapter 注册；缺失即 **FAIL (exit 1)**，并给出可执行修复命令；同时检测双重注册（DUPLICATE_ADAPTER 风险）以及遗留的第二实例（`llm-pi-ai-custom-routes`）硬拒绝。
- `test/custom-routes.test.mjs`：6 条回归（假绿 FAIL、锚点缺失单实例注册、遗留第二实例硬拒绝、幂等、锚点存在原行为不变、smart 双重声明硬拒绝）。

## 应用命令（可复制、可回滚）

> 以下步骤由用户执行；生成器不会自行改动 live 用户数据。

### 1. 备份 live patch 到工作区备份目录（可回滚）

```bash
REPO="/Users/catbox/Documents/deepseek-harness/default-workspace/dsh-smart-provider/dsh-smart-provider"
BK="$REPO/docs/backups"
mkdir -p "$BK"
STAMP=$(date +%Y%m%d-%H%M%S)
cp -p ~/.dsh/profiles/desktop/cordis.patch.yml "$BK/cordis.patch.yml.bak-$STAMP"
echo "BACKUP=$BK/cordis.patch.yml.bak-$STAMP"
md5 -q "$BK/cordis.patch.yml.bak-$STAMP"   # 记录原文件校验和
```

### 2. 校验（应用前应当 FAIL，证明故障真实存在）

```bash
cd "$REPO"
node scripts/validate-custom-routes.mjs; echo "EXIT:$?"
# 预期：EXIT=1，ERR route "x-opencode-free" is declared ... has NO adapter registration
```

### 3. 生成正确 patch 并应用

```bash
cd "$REPO"
node scripts/gen-custom-routes.mjs --write; echo "GEN_EXIT:$?"
# 预期输出包含：
#   WARN providers: ... registered x-* routes in the single llm-pi-ai entry config
#   guard: N top-level entry ids unchanged
#   WROTE 3 files / 4 artifacts.
grep -nE 'custom-routes:providers-insert|x-opencode-free:' ~/.dsh/profiles/desktop/cordis.patch.yml | head
node scripts/validate-custom-routes.mjs; echo "VALIDATE_EXIT:$?"
# 预期：VALIDATE_EXIT=0，PASS: all 8 check groups OK
node scripts/gen-custom-routes.mjs --write >/dev/null 2>&1; md5 -q ~/.dsh/profiles/desktop/cordis.patch.yml
# 再跑一次，md5 应与上一次完全相同（幂等）
```

### 4. 触发宿主重组合（重启 DSH Host / Desktop）

生成器写盘后需要宿主重新加载 cordis 树才能注册 adapter。请完全退出并重启 DSH Desktop（或在插件管理里重载 smart-provider 与 llm-pi-ai）。

### 5. 应用后应看到的证据

- `~/.dsh/logs/desktop-next.log` 不再出现 `no adapter registered for provider "x-opencode-free"`（新的 `agent.failed NO_ADAPTER` 计数为 0）。
- patch 里存在 marker `# >>> custom-routes:providers-insert >>>` 且 `- id: llm-pi-ai` / `x-opencode-free:` 可见；不得出现 `llm-pi-ai-custom-routes`。
- `node scripts/validate-custom-routes.mjs` 退出 0，`PASS: all 8 check groups OK`。

### 6. 回滚（如果需要）

```bash
BK="$REPO/docs/backups"
cp -p "$BK/cordis.patch.yml.bak-$STAMP" ~/.dsh/profiles/desktop/cordis.patch.yml
# 然后重启 DSH Desktop，让宿主用原 patch 重新组合
```

## 生成的 patch 片段（示例，来自隔离 profile 实测）

```yaml
# >>> custom-routes:providers-insert >>>
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      x-opencode-free:
        displayName: OpenCode Free
        apiKeyEnv: OPENCODE_GO_API_KEY
        api: openai-completions
        baseURL: https://opencode.ai/inference/go/v1
        compat:
          supportsStore: false
          supportsDeveloperRole: false
          supportsStrictMode: true
          maxTokensField: max_tokens
        # ... models 由 registry 生成，完整内容以 gen --write 输出为准
# <<< custom-routes:providers-insert <<<
```

## 撞车机制（已核实，为什么不能有第二个实例）

读 `@deepseek-ai/dsh-llm-pi-ai`（asar 内 `src/index.ts` / `lib/index.js`）确认：

- `apply()` 在每次挂载时**无条件**做三件全局注册：`registerConfigurableProviders(directoryEntries(...))`（src/index.ts:169,280；包含全部 `catalogProviderIds()`）、`registerModelDiscovery(settingsNs, ...)`（:305）、以及 `ctx.inject(['authorization'], registerPiAiFlows)`（:264，为每个 catalog provider 注册授权流）。
- `Config` 只有 `providers` 一个字段（config.ts:383），**没有** `registerBuiltins:false` / `providersOnly` 之类开关；第二个实例无法只声明 x-* 而不碰 catalog。
- `dsh-llm/lib/index.js:2041` 对已声明的 provider 抛 `DUPLICATE_DIRECTORY`；第二个实例启动时第一项 `amazon-bedrock` 就撞车，同时授权流 `llm-pi-ai/amazon-bedrock` 也 `already registered`，导致 `1 entry did not activate`。

cordis patch 的 `- id: ...` 覆盖确实是**整块替换 config**（schema 原文：`config is replaced wholesale, not deep-merged`）。但 app-managed 形态下 `llm-pi-ai` 条目在 patch 层并没有任何 `providers`（这正是锚点缺失的含义），因此写 `config.providers` 不会抹掉任何已配置的 provider；pi-ai 自己会从 catalog 注入默认 provider 元数据，无需在 patch 中重列。唯一实例方案在隔离 profile E2E 中证实：请求穿过 `x-opencode-free` 到达上游网关（返回 401 Invalid credential），没有 `NO_ADAPTER` / `DUPLICATE_DIRECTORY` / `already declared`。
