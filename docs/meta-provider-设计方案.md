# meta-provider 设计方案（智能提供商调度 DSH 现有 provider）

> 结论：**可行，已运行时验证。** 自定义 provider adapter 内部调用 `ctx.llm.stream()` 调度其他已注册 provider 成立。
> 多协议不用自己写 —— pi-ai 已支持，meta-provider 只加「智能调度」一层。

---

## 1. 结论与验证证据

**一句话**：能。`LlmAdapter.stream()` 是唯一必需方法，内部可自由调用 `ctx.llm.stream()`；
`DUPLICATE_ADAPTER` 只在**同名 provider 重复注册**时抛，不同 provider 无冲突；deep-frozen 请求用 spread 生成新对象即可转发。

### 运行时验证（Node 24 + 真实 `@deepseek-ai/dsh-llm`）

| # | 测试 | 结果 |
|---|---|---|
| 1 | 同名 provider 重复注册 | `DUPLICATE_ADAPTER` 拦截 —— 只有同名才冲突 |
| 2 | 注册 `smart` + 内部 `runtime.stream({...o, provider:'backend-a'})` | **OK**，`text=hello-from-B`，A=1 B=1，无异常 |
| 3 | deep-frozen 请求直接转发（`{...o, provider, model}`） | **OK**，冻结对象只读不阻转发 |
| 4 | 首模型吐一半再失败 | 部分内容已 yield，**无法回退**（c2 调用数 = 0） |
| 5 | `prepareCall()` + `resolveModel` 委派（agent loop 真实路径） | **OK**，modelInfo 正确透传 |
| 6 | `llm/stream` listener 就地改 `options.provider` | **抛 TypeError**（只读），但 listener 返回 `next()` 仍可短路 |
| 7 | contextWindow 是否预检 | 不预检，**advisory**；meta-provider 的声明即权威 |

### 源码级依据

- `LlmAdapter` 抽象类：唯一必需方法 `abstract stream(options): AsyncIterable<StreamChunk>`；
  `prepareCall()` 默认实现即 `stream: options => this.stream(options)`。
- `registerAdapter(providers, adapter)`：`prepareRoutes()` 仅对同 provider 抛 `DUPLICATE_ADAPTER`。
- `stream()` → `streamWithRegistration()` → `ctx.waterfall(this,'llm/stream',options, () => adapterStream(...))`，**无重入锁、无 in-flight 计数**。
- 官方文档 `docs/subsystems/llm-streaming.md` 第 871 行：
  > "Adapter lookup happens at the terminal continuation of the `llm/stream` waterfall, so a listener may short-circuit the call or route a mutable one-shot request before lookup."
- `forAdapter()` 已实现跨 adapter 的 replayState 剥离 + 重新 freeze —— **跨 adapter 转发是既有受支持路径**。

### 流式陷阱（决定 fallback 边界）

已 yield 的 chunk 收不回 → **fallback 只能在 establishment 阶段**（第一个内容 chunk 之前）。
实测 Bifrost 156 次 fallback 绝大多数正是 establishment 错误
（`upstream_credentials_exhausted` 502 ×81、`permission_error` 403 ×52、`FreeUsageLimitError` 429 ×34）。
**结论：establishment-only fallback 覆盖了 95%+ 的真实场景，够用。**

---

## 2. 错误分类：DSH 原生 `failure.code` 够不够

`LlmFailure = { message, code, status?, providerRetryAfterMs?, requestId? }`

**够用，但有两个坑必须知道：**

### 坑 1：默认可重试码不含额度类

```js
DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

`QUOTA` / `ACCOUNT_QUOTA` / `AUTH` / `MODEL_UNSUPPORTED` / `UNKNOWN_MODEL` **不在默认列表**。
即 DSH 原生 `dsh-llm-retry` **不会重试额度耗尽** —— 这恰好是 meta-provider 必须自己接管的部分。

### 坑 2：pi-ai 从不填 `failure.status`

`dsh-llm-pi-ai` 里 35 处 `new LlmError(...)` 无一传 `status`。
分类只能靠 `code` + message 文本（pi-ai 的 message 常以 `"429 ..."` 开头，可正则取状态码）。

### 分类 → 动作表

| code | 含义 | 动作 |
|---|---|---|
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | key 失效 | **换 provider**（同 provider 换 key 需另一层） |
| `QUOTA` / `ACCOUNT_QUOTA` | 额度/余额耗尽 | **换模型**，记额度恢复倒计时 |
| `RATE_LIMIT` | 限流 | 读 `providerRetryAfterMs`，短则等，长则换 |
| `MODEL_UNSUPPORTED` / `UNKNOWN_MODEL` | 模型下线/不支持 | **剔除该模型**，换下一个 |
| `SERVER` / `TIMEOUT` / `TRANSPORT` / `STREAM_CLOSED` | 上游抖动 | 同模型重试 1 次，再换 |
| `UNSUPPORTED_REASONING_EFFORT` | 该模型不支持此档推理 | **换模型**（已实测会以此 code 返回） |
| `CONTEXT_WINDOW_EXCEEDED` | 超上下文 | 不换模型，交给 compaction |
| `ABORTED` | 用户取消 | **立即终止，绝不 fallback** |

---

## 3. 最小代码骨架（调度层核心）

```ts
// src/adapter.ts
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'

/** 可切换的失败码：命中即换下一个模型 */
const SWITCHABLE = new Set([
  'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'QUOTA', 'ACCOUNT_QUOTA',
  'MODEL_UNSUPPORTED', 'UNKNOWN_MODEL', 'UNSUPPORTED_REASONING_EFFORT',
  'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'RATE_LIMIT',
])

export class SmartAdapter extends LlmAdapter {
  constructor(
    private readonly runtime: any,          // ctx.llm
    private readonly resolveChain: (model: string) => { provider: string; model: string }[],
  ) { super() }

  providerInfo(provider: string) {
    return { id: provider, name: 'Smart Gateway' }
  }

  // 关键：把 modelInfo 委派给真实后端，否则 contextWindow 是错的
  async resolveModel(provider: string, model: string) {
    const first = this.resolveChain(model)[0]
    const info = await this.runtime.resolveModelInfo(first.provider, first.model)
    return { ...info, provider, id: model }
  }

  // agent loop 走 prepareCall，必须一并委派
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chain = this.resolveChain(options.model)
    let lastFailure: any

    for (const hop of chain) {
      let emitted = false                       // 是否已吐过内容 → 决定能否回退
      try {
        const inner = this.runtime.stream({
          ...options,                            // spread 生成新对象，绕开 deep-frozen
          provider: hop.provider,
          model: hop.model,
        })
        for await (const chunk of inner) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            lastFailure = chunk.reason.failure
            if (emitted) { yield chunk; return }  // 已吐内容：无法回退，如实上报
            break                                 // establishment 失败：可换
          }
          if (chunk.type !== 'finish') emitted = true
          yield chunk
        }
        if (emitted) return
      } catch (error: any) {
        lastFailure = error
        if (emitted) throw error                  // 同上，不能吞
      }
    }

    yield {
      type: 'finish',
      reason: { kind: 'error', failure: lastFailure ?? { code: 'SERVER', message: 'all hops failed' } },
    }
  }
}
```

> 注意：运行时方法名是 `resolveModelInfo()`（adapter 级方法才叫 `resolveModel`），见性能审查 §8。

### 注册（cordis 插件入口）

```ts
export function apply(ctx: Context) {
  const adapter = new SmartAdapter(ctx.llm, buildChain)
  ctx.llm.registerAdapter(['smart'], adapter)   // 与 opencode-go/xiaomi 并列，无冲突
}
```

### 切换链怎么来（省钱优先）

```ts
// 免费/便宜 → 贵；坏模型剔除
const CHAIN: Record<string, string[]> = {
  'auto': [
    'opencode-go/deepseek-v4.1-flash',      // 便宜、稳
    'opencode-go/glm-5.3-flash',
    'xiaomi-token-plan-cn/mimo-v2.6-flash',
    'opencode-go/minimax-m3.1-flash-free',  // 免费兜底
  ],
  // 用户显式指定则不切换
  'opencode-go/kimi-k3': ['opencode-go/kimi-k3'],
}
```

---

## 3.5 多协议：不用自己写，pi-ai 已覆盖

meta-provider 调度的是 **DSH 已注册的 provider**，每个 provider 的协议由 pi-ai 适配，
所以「支持几种协议」= 「pi-ai 支持几种」+「已在 cordis 里配了哪几个 route」。

pi-ai 的 `api` 取值（`dist/api/` 目录实证）：

| `api` 值 | 协议 | 对接 |
|---|---|---|
| `openai-completions` | OpenAI `/v1/chat/completions` | opencode-go、opencode-zen、xiaomi |
| `openai-responses` | OpenAI Responses API | 部分新端点 |
| `anthropic-messages` | Anthropic `/v1/messages` | minimax-cn、claude 系 |
| `google-generative-ai` | Google Generative AI | gemini 系 |
| `google-vertex` | Vertex AI | GCP |
| `bedrock-converse-stream` | AWS Bedrock Converse | AWS |
| `azure-openai-responses` | Azure OpenAI | Azure |

**结论：接入新厂家 = 在 `cordis.patch.yml` 加一个 provider 块（填 `api` + `baseURL` + `apiKeyEnv` + models），
meta-provider 的切换链里加一行。零 wire code。**

---

## 4. 改动清单（对 DSH 侵入极小）

| 改动 | 位置 | 量 |
|---|---|---|
| 新增插件包 | `default-workspace/dsh-smart-provider/` | 新目录，~200 行 |
| 加一条 provider route | `cordis.patch.yml` 的 `llm-pi-ai.providers` 下 | **+1 个 key**（`smart:`，`api: openai-completions` 或直接由 adapter 声明） |
| 默认模型指向 | `agent-default-model` 的 `provider: smart` | 改 1 行 |
| 注册插件 | `cordis.patch.yml` 插件列表 | +1 条 |

**不需要**：新 key、新 endpoint、改现有 provider 块、Docker、HTTP 端口。

---

## 5. 迁移步骤

1. **建包**：`dsh-smart-provider`，`link:` 进 profile `package.json`。
2. **先不切默认**：注册 `smart` route，手动在会话里选 `smart/auto` 验证 3-5 轮。
3. **验证点**：正常对话 / 故意用坏模型触发切换 / 确认 `failure` 分类正确 / 看 session 日志里 provider 变更。
4. **切默认**：`agent-default-model` → `provider: smart, model: auto`。
5. **保留回滚**：`opencode-go` 等原 route 全部不动，随时可切回。
6. **停 Bifrost**（可选，最后一步）：`docker compose down`；确认无 session 引用后再删目录。

---

## 6. 重要发现：现有 `bifrost` route 其实是坏的

`cordis.patch.yml` 第 1958 行：

```yaml
bifrost:
  baseURL: http://127.0.0.1:18080/v1
  api: anthropic-messages      # ← Anthropic SDK 会拼 /v1/messages
```

pi-ai 用 Anthropic SDK，`baseURL` 直接透传、**无归一化**；SDK 的 `buildURL` 拼 `baseURL + '/v1/messages'`
→ 实际请求 `http://127.0.0.1:18080/v1/v1/messages`。

实测：

```
POST /v1/v1/messages            -> 405 Method Not Allowed
POST /v1/messages               -> 405
POST /anthropic/v1/messages     -> 200   ← 正确路径
POST /v1/chat/completions       -> 200   ← OpenAI 协议正常
```

**所以「端口接管 18080 + DSH 零改动」不成立** —— 那条 route 现在就是 405，
这与「921 个 session 里 provider=bifrost 的会话数 = 0」完全吻合：用户从没通过它跑通过一次真实会话。

### 附带发现：DSH 侧有 3 个僵尸模型

网关 `/v1/models` = 110，DSH 侧 = 113，差 3 个（task-21 剔除后未同步）：

```
minimax-cn-coding-plan/MiniMax-M2
minimax-cn-coding-plan/MiniMax-M2.1
minimax-cn-coding-plan/MiniMax-M2.1-highspeed
```

无论走哪条路线，这 3 条都该删。

若将来仍想用独立进程网关，`baseURL` 必须写 `http://127.0.0.1:18080/anthropic`（配 `anthropic-messages`），
或改用 `api: openai-completions` + `/v1`。
