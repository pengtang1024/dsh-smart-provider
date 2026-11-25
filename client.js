/**
 * dsh-smart-provider — Web Client settings section.
 *
 * Registers a `settings.section` ("Smart 智能路由") with four tabs:
 * overview / chains / accounts+ranking / cost+health.
 *
 * Hard UI rules (dsh-doc practices.md §UI):
 *   - no iframe, no require('@deepseek-ai/dsh-client-ui-primitives')
 *   - only --dsw-alias-* theme tokens for colors
 *   - defensive against missing/empty data (a throwing component blanks the slot)
 *   - never append to document.body
 *
 * Data channels (2026-11-23 direction fix): this client deliberately uses NO
 * command channel. ctx.commands.register() registers SLASH commands (agent-
 * facing, needs an agent), not a remote data API — calling them from the
 * settings page with no agent never worked in a real browser. All data now
 * comes from: (1) STATIC_* constants embedded below, (2) configForms snapshot,
 * (3) runtime status is not queried — the UI states only configured facts.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-smart-provider',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.smart-provider'
    const ENTRY = 'smart-provider'
    // 与 package.json 的 version 保持同步（浏览器模块无法 require package.json，
    // 故按本项目 STATIC_* 惯例内联）。改版本时两处都要更新。
    const PLUGIN_VERSION = '2.1.0'

    // ---- typed @Remote contribution for real cost data ---------------------
    // The Host registers a `smartProvider/cost` @Remote service (see lib/remote.js).
    // Here we build the matching mountable contribution inlined (the browser
    // module table does not expose dsh-typert-protocol/remote-info to third-party
    // clients). This mirrors createTypertRemoteInfo's descriptor shape 1:1 for a
    // zero-argument direct method with a strict zod result codec. No secrets,
    // no client-side ledger parsing — the Host owns the real numbers.
    const COST_RESULT_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      return z.object({
        records: z.number(),
        estimatedCostUsd: z.number(),
        freeCount: z.number(),
        paidCount: z.number(),
        failedCount: z.number().optional(),
        byProvider: z.record(z.string(), z.number()),
        source: z.string().optional(),
      })
    })()
    // Detailed ledger view (costDetail) — separate descriptor so cost() keeps
    // its original light structure for older clients. zod strict here must list
    // EVERY field the Host returns or it gets stripped on the wire.
    const COST_DETAIL_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      // Every Host row field must be declared or the strict codec strips it —
      // the latency columns were invisible because ttftMs / tokensPerSecond were
      // missing here. Host shape: lib/cost-stats.js readCostDetail() (P2 latency
      // metrics; old rows carry null, never a fabricated 0).
      const rowSchema = z.object({
        timestamp: z.string(), provider: z.string(), model: z.string(),
        inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number(),
        failed: z.boolean(), requestId: z.string(),
        ttftMs: z.number().nullable(),
        durationMs: z.number().nullable(),
        tokensPerSecond: z.number().nullable(),
        startedAt: z.string().nullable(),
        firstTokenAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
      })
      const timelineSchema = z.object({ day: z.string(), calls: z.number(), costUsd: z.number(), failures: z.number() })
      const byModelSchema = z.object({
        provider: z.string(), model: z.string(), calls: z.number(), costUsd: z.number(),
        freeCalls: z.number(), paidCalls: z.number(), failedCalls: z.number(),
      })
      const savingSchema = z.object({
        model: z.string(), provider: z.string(), freeCalls: z.number(),
        inputTokens: z.number(), outputTokens: z.number(),
        estimated: z.boolean(), known: z.boolean(),
        source: z.string(), referenceModel: z.string(),
        estimatedUsd: z.number().nullable(),
      })
      return z.object({
        total: z.number(), offset: z.number(), limit: z.number(),
        rows: z.array(rowSchema),
        timeline: z.array(timelineSchema),
        byModel: z.array(byModelSchema),
        savings: z.object({
          estimated: z.boolean(), priceSource: z.string(), note: z.string(),
          models: z.array(savingSchema),
        }),
      })
    })()
    // L5b: Host live registry projection (L1 projectStatus) — ledger + session
    // signals, covers workbuddy routes that never write cost.jsonl. Record<
    // modelId,{health,tier,confidence}>; absent model = zero sample = UNKNOWN.
    const AVAIL_STATUS_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      return z.record(z.string(), z.object({
        health: z.string(), tier: z.string(), confidence: z.number(),
      }))
    })()
    // task-107: minimal probe result/candidates schema. strict codec 三件套
    // (wire/typeSymbol/zod create) mandatory — task-102 proved a non-strict
    // codec kills the WHOLE smartProvider namespace (all methods).
    const PROBE_RESULT_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      const result = z.object({
        provider: z.string(), model: z.string(),
        verdict: z.string(), evidence: z.string(),
        ok: z.boolean(), probedAt: z.number().optional(),
      })
      return z.object({ results: z.array(result), probedAt: z.number() })
    })()
    const PROBE_CANDIDATES_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      return z.object({
        candidates: z.array(z.object({ provider: z.string(), model: z.string() })),
        force: z.boolean().optional(),
      })
    })()
    // T3a: 账号健康 + 冷却快照（accountHealth）。strict codec 三件套同上，
    // 字段与 Host 契约逐字对齐：Host 缺数据时发 null / 0 / []，从不省略字段，
    // 所以可空字段一律 .nullable()，绝不用 .optional()（否则 null 会被 zod 拒掉）。
    const ACCOUNT_HEALTH_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      const samples = z.object({ success: z.number(), failure: z.number() })
      const account = z.object({
        id: z.string(), provider: z.string(), implicit: z.boolean(),
        models: z.array(z.string()), state: z.string(),
        reason: z.string().nullable(), until: z.number().nullable(),
        remainingMs: z.number(), streak: z.number(), samples,
        usage: z.number(),
        lastSuccessAt: z.number().nullable(), lastFailureAt: z.number().nullable(),
      })
      const route = z.object({
        provider: z.string(), modelId: z.string(),
        health: z.string(), tier: z.string(), confidence: z.number(),
        samples,
        lastSuccessAt: z.number().nullable(), lastFailureAt: z.number().nullable(),
      })
      return z.object({
        enabled: z.boolean(), generatedAt: z.number(),
        accounts: z.array(account), routes: z.array(route),
      })
    })()
    // $mount 的真实失败原因会写进这里，随成本页诊断文案一起显示，避免 err=? 静默。
    let mountDiag = 'unmounted'
    const makeCostContribution = () => ({
      package: '@local/dsh-smart-provider',
      descriptors: [{
        id: '@local/dsh-smart-provider#smartProvider/cost',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'cost',
        description: 'Read the real cost ledger',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          // typert validateCodec() 对非 src-json 的 codec 强制要求非空 typeSymbol；
          // 缺这个字段时 validateNonempty() 抛 TypeError（读 undefined.length），
          // $mount 直接 reject，namespace 永远装不上 → 软探测四次全空。
          // 官方 createTypertRemoteInfo 生成的 descriptor 必带 typeSymbol，1:1 对齐。
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#CostSummary',
          create: () => COST_RESULT_SCHEMA ?? { parse: v => v },
          description: 'cost ledger summary',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          return receiver.cost(signal)
        },
      }, {
        id: '@local/dsh-smart-provider#smartProvider/costDetail',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'costDetail',
        description: 'Read paged cost ledger detail with bounded aggregations',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'opts', wire: 'opts', description: 'pagination {offset,limit}', source: 'json',
          // P0 task-102: src-json codec fails requireStrictCodec() at mount time
          // ("field undefined has no strict codec") — the whole namespace fails
          // to mount, killing cost()/costDetail()/availabilityStatus() together.
          // Mirror official generated strict codec: mode + typeSymbol + create.
          codec: {
            mode: 'strict',
            typeSymbol: '@local/dsh-smart-provider/types#CostDetailOptions',
            create: () => (() => {
              let zod; try { zod = require('zod') } catch { return { parse: v => v } }
              const z = zod.z ?? zod
              return z.object({ offset: z.number().optional(), limit: z.number().optional() })
            })(),
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#CostDetail',
          create: () => COST_DETAIL_SCHEMA ?? { parse: v => v },
          description: 'cost detail page',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          const opts = input && (input.opts ?? input) // named input wrapper or raw
          return receiver.costDetail(opts, signal)
        },
      }, {
        id: '@local/dsh-smart-provider#smartProvider/availabilityStatus',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'availabilityStatus',
        description: 'Read live availability projection (ledger + session signals)',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#AvailabilityProjection',
          create: () => AVAIL_STATUS_SCHEMA ?? { parse: v => v },
          description: 'model availability projection',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          return receiver.availabilityStatus(signal)
        },
      }, {
        id: '@local/dsh-smart-provider#smartProvider/probeModels',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'probeModels',
        description: 'Minimal real probe of candidate models (Host only)',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'opts', wire: 'opts', description: 'candidates to probe', source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@local/dsh-smart-provider/types#ProbeCandidates',
            create: () => PROBE_CANDIDATES_SCHEMA ?? { parse: v => v },
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#ProbeResult',
          create: () => PROBE_RESULT_SCHEMA ?? { parse: v => v },
          description: 'probe verdicts',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          const opts = input && (input.opts ?? input)
          return receiver.probeModels(opts, signal)
        },
      }, {
        // T3a: 账号健康 + 冷却快照。零参数 direct 方法；result codec 必须带
        // mode + 非空 typeSymbol + create，漏一项整个 smartProvider 命名空间挂不上。
        id: '@local/dsh-smart-provider#smartProvider/accountHealth',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'accountHealth',
        description: 'Read live account health + cooldown snapshot',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#AccountHealthSnapshot',
          create: () => ACCOUNT_HEALTH_SCHEMA ?? { parse: v => v },
          description: 'account health snapshot',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          return receiver.accountHealth(signal)
        },
      }],
    })

    // ---- static fallback data ---------------------------------------------
    // Mirrored from lib/ranking.js + lib/chains.js. The client factory(require)
    // can only resolve browser module-table entries, NOT local ESM files, so
    // these constants are inlined on purpose: presets and default chains must
    // render even when Host commands are unreachable. Host command results
    // (below) override these when available.
    const STATIC_STRATEGIES = [
      { id: 'legacy', label: '兼容模式', description: '完全保持旧行为：route 优先 + 最少使用', weights: null },
      { id: 'balanced', label: '均衡（推荐）', description: '各项均衡，不偏向省钱或速度', weights: { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 } },
      { id: 'cost-first', label: '成本优先', description: '长任务、批量、后台跑', weights: { cost: 0.7, speed: 0.05, tier: 0.1, load: 0.15 } },
      { id: 'speed-first', label: '速度优先', description: '交互、低延迟需求', weights: { cost: 0.1, speed: 0.65, tier: 0.1, load: 0.15 } },
      { id: 'tier-first', label: '等级优先', description: '先用高等级；配 low 方向先耗备份', weights: { cost: 0.1, speed: 0.1, tier: 0.65, load: 0.15 } },
      { id: 'custom', label: '自定义', description: '自定义权重', weights: null },
    ]
    // Must mirror lib/ranking.js BALANCED_WEIGHTS exactly: balanced is neutral
    // (0.25 × 4), never cost-biased. A drifted client copy would silently
    // rewrite a user's weights the moment they click a preset.
    const DEFAULT_WEIGHTS = { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 }
    // P2 两层路由的 8 个预设：大白话中文名 + 一句说明，不暴露 tierPolicy 原始字段。
    // id 与 lib/routing.js resolveRoutingPolicy 的预设一一对应。
    const ROUTING_PRESETS = [
      { id: 'balanced', label: '均衡（推荐）', desc: '按任务自动挑合适的模型档位' },
      { id: 'cost-first', label: '更省钱', desc: '优先便宜模型，适合长任务/批量' },
      { id: 'speed-first', label: '更快', desc: '优先响应快的模型，适合日常对话' },
      { id: 'reasoning-first', label: '深度思考优先', desc: '推理类任务优先用擅长思考的模型' },
      { id: 'longctx-first', label: '长文本优先', desc: '超长内容优先用大窗口模型' },
      { id: 'vision-first', label: '看图优先', desc: '带图片的任务优先用多模态模型' },
      { id: 'legacy', label: '兼容旧行为', desc: '完全按旧方式：route 优先 + 最少使用' },
      { id: 'custom', label: '自定义', desc: '自己设定档位规则（高级）' },
    ]
    // 任务识别规则（只读说明，来自 P2 classifyTask 的语义，不含原始字段名）
    const TASK_RULES = [
      ['带图片', '多模态档'],
      ['要用工具', '工具型档'],
      ['要推理', '深度思考档'],
      ['内容超长', '长文本档'],
    ]
    const STATIC_DEFAULT_CHAINS = {
      auto: [
        { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        { provider: 'opencode-go', model: 'glm-5.3-flash' },
        { provider: 'opencode-go', model: 'mimo-v2.6-flash' },
        { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash' },
      ],
      'deepseek-v4.1-flash': [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
      'glm-5.3-flash': [{ provider: 'opencode-go', model: 'glm-5.3-flash' }],
      'mimo-v2.6-flash': [{ provider: 'opencode-go', model: 'mimo-v2.6-flash' }],
    }

    // Locale interpolation helper. Uses literal replacement so it works even
    // if a locale binding returns the raw key or ignores the vars argument.
    const fmt = (t, key, vars) => {
      const raw = t(key)
      let out = typeof raw === 'string' ? raw : key
      if (vars) for (const [k, v] of Object.entries(vars)) {
        out = out.split('{' + k + '}').join(String(v))
      }
      return out
    }

    // Human-friendly model names for the beginner view. Unknown models fall
    // back to their raw id, so nothing breaks when new models are added.
    const MODEL_LABELS = {
      'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash（快、便宜）',
      'deepseek-v4-flash': 'DeepSeek V4 Flash（快）',
      'deepseek-v4-pro': 'DeepSeek V4 Pro（更强）',
      'glm-5.3-flash': 'GLM 5.3 Flash（便宜）',
      'glm-5.3': 'GLM 5.3',
      'mimo-v2.6-flash': '小米 MiMo V2.6 Flash（便宜）',
    }
    const modelLabel = id => MODEL_LABELS[str(id)] || str(id)

    // ---- tiny helpers -----------------------------------------------------
    const arr = v => (Array.isArray(v) ? v : [])
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
    const str = v => (typeof v === 'string' ? v : '')
    const jsonParse = (text, fallback) => {
      try { return JSON.parse(text) } catch { return fallback }
    }
    const clone = v => {
      try { return JSON.parse(JSON.stringify(v ?? null)) } catch { return v }
    }
    // 顺序无关的 JSON 指纹：用来区分「用户真的动过这个表单」和「表单只是把
    // Host 默认值渲染出来」。裸 JSON.stringify 在配置往返后键序可能不同，
    // 会产生"幽灵写入"——账号保存过去正是这样把 ranking 整块覆盖掉的。
    const stableSig = v => {
      if (Array.isArray(v)) return '[' + v.map(stableSig).join(',') + ']'
      if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableSig(v[k])).join(',') + '}'
      }
      return JSON.stringify(v) ?? 'null'
    }

    // ---- styles: only --dsw-alias-* tokens --------------------------------
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 24px', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      tabs: { display: 'flex', gap: 6, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 8, flexWrap: 'wrap' },
      tab: extra => ({
        cursor: 'pointer', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
        padding: '6px 12px', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
        background: extra ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      }),
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', padding: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 120 },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: 96 },
      input: {
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        padding: '4px 8px', fontFamily: 'inherit', fontSize: 13, minWidth: 80,
      },
      select: { fontFamily: 'inherit', fontSize: 13 },
      btn: {
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        padding: '4px 10px',
      },
      primary: {
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-bg-layer-1)',
        background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)',
        border: 'none', borderRadius: 'var(--dsw-radius-sm)', padding: '5px 14px',
      },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' },
      code: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, overflowWrap: 'anywhere' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)' },
      td: { borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '6px 8px', verticalAlign: 'top' },
      pill: extra => ({
        display: 'inline-block', borderRadius: 'var(--dsw-radius-sm)', padding: '1px 6px', fontSize: 11,
        color: extra ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      }),
      hero: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        padding: '16px', background: 'var(--dsw-alias-bg-layer-1)',
        display: 'flex', flexDirection: 'column', gap: 8,
      },
      heroTitle: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: '24px' },
      heroText: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '22px' },
      choiceBtn: active => ({
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
        padding: '10px 14px', borderRadius: 'var(--dsw-radius-md)', textAlign: 'left',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-2)',
        display: 'flex', flexDirection: 'column', gap: 2, minWidth: 130,
      }),
      choiceTitle: { fontWeight: 600 },
      choiceSub: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      step: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', fontSize: 13, lineHeight: '20px' },
      stepNum: {
        flex: 'none', width: 22, height: 22, borderRadius: '50%',
        background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
      },
      arrow: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, paddingLeft: 4 },
    }

    function Field({ label, children, help }) {
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: S.label }, label),
          h('span', { style: S.grow }, children),
        ),
        help ? h('div', { style: { ...S.muted, marginLeft: 96 } }, help) : null,
      )
    }

    function KV({ k, v }) {
      return h('div', { style: S.row },
        h('span', { style: S.label }, k),
        h('span', { style: S.code }, v === undefined || v === null ? '—' : String(v)),
      )
    }

    // Advanced options live in a native <details> that is CLOSED by default:
    // beginners never see JSON/weights/switches unless they deliberately opt in.
    // No state needed — the browser owns the open/closed state.
    function Advanced({ t, children }) {
      return h('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 } },
        h('summary', {
          style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '20px' },
        }, t('advanced.title')),
        h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 } }, children),
      )
    }

    // 诊断行统一收纳：默认折叠，只有失败时才默认展开。mount/state/code/message
    // 这类内部串一律进这里，不占首屏。
    function DiagDetails({ t, lines, failed, title }) {
      const text = arr(lines).filter(Boolean)
      if (!text.length) return null
      return h('details', { style: { marginTop: 8 }, open: failed === true },
        h('summary', {
          style: {
            cursor: 'pointer', fontSize: 11,
            color: failed === true ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        }, title || t('diag.title')),
        ...text.map((line, i) => h('div', {
          key: i,
          style: { ...S.muted, marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11, overflowWrap: 'anywhere' },
        }, str(line))),
      )
    }

    // ---- overview ---------------------------------------------------------
    // Honest, runtime-free status: this page reads ONLY the configForms
    // snapshot (always reachable) plus static defaults. It never claims a
    // runtime "on/off" state it cannot prove, and it never shows a permanent
    // "checking…" spinner. It states what is CONFIGURED in plain language.
    function Overview({ t, localConfig, pi, availProjection, probeVerdicts, probeEnabled, probeDiag, onProbe, applyPreset, working, presetNotice, costService, onOpenCost }) {
      const cfg = obj(localConfig)
      const configuredChains = obj(cfg.chains)
      const chains = Object.keys(configuredChains).length ? configuredChains : STATIC_DEFAULT_CHAINS
      const accounts = arr(cfg.accounts).length
      // 真值只认用户实际写入的 ranking 配置；缺省即"内置均衡默认"，
      // 绝不把代码默认值 balanced 冒充成用户的选择（那是上一版的假状态）。
      const rankingCfg = obj(cfg.ranking)
      const hasRanking = Object.keys(rankingCfg).length > 0
      const rankingOn = hasRanking && rankingCfg.enabled === true
      const strategy = hasRanking ? (str(rankingCfg.strategy) || 'balanced') : ''
      const strategyName = ({ balanced: '均衡', 'cost-first': '省钱优先', 'speed-first': '速度优先', 'tier-first': '高等级优先', legacy: '兼容', custom: '自定义' })[strategy] || strategy
      // pi-ai 真实资源（只读，防空）。
      const providerCount = arr(pi?.providers).length
      const modelCount = arr(pi?.models).length
      const piLoaded = pi?.loaded === true
      // 首屏一行健康提示：只报真实快照里的数字。三态 —— null=正在读、
      // false=读不到通道（明说读不到，不渲染成"0 个账号一切正常"）、对象=真实快照。
      const [health, setHealth] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          let next = false
          try {
            const res = await costService?.accountHealth?.()
            if (res && res.ok) next = res.value ?? false
          } catch { next = false }
          if (alive) setHealth(next)
        }
        void load()
        return () => { alive = false }
      }, [costService])
      const healthAccounts = health && health !== false ? arr(health.accounts) : []
      const coolingCount = healthAccounts.filter(a => {
        const state = str(a?.state).toUpperCase()
        return state === 'COOLING' || state === 'HALF_OPEN'
      }).length
      const healthText = health === null
        ? t('overview.healthLoading')
        : health === false
          ? t('overview.healthNoChannel')
          : fmt(t, 'overview.healthLine', { accounts: healthAccounts.length, cooling: coolingCount })
      // 历史登记 seed（task-105 起已不参与准入过滤、也不参与状态判定）。
      // 真值 100% 来自运行时 pi.models + 双源投影 availProjection；零样本条目
      // 一律 UNKNOWN/资费未确认 —— 静态表绝不冒充"不可用"或"可用"。
      // 保留本表仅为历史记录/兼容（未来删表不影响展示）。
      const FREE_MODEL_STATUS = {
        'hy4-flash-free': 'available',      // seed: 历史账本 x-opencode-free 成功
        'hy4flash-free': 'available',       // seed: 历史日志 workbuddy 成功
        'hy4-flash-free-trial-202611': 'unavailable', // seed: 未复核
        'web-search-free': 'unavailable',   // seed: 未复核
        'cat-jam-free': 'unavailable',      // seed: 未复核
        'longcat-2.5-preview-free': 'unavailable', // seed: 未复核
        'step-5-preview-free': 'unavailable',      // seed: 未复核
      }
      // 真值判定：有足够真实成功样本 -> HEALTHY(显示可用)；否则 UNKNOWN。
      // 静态 unavailable 永不作为最终结论 —— "双源零成功"已被证伪。
      const statusOf = id => {
        const observed = obj(availProjection)[id]
        const samples = Number(observed?.samples ?? 0)
        if (samples >= AVAIL_HIGH_SAMPLES) return { key: 'healthy', ok: true, reviewed: true, samples }
        if (samples > 0) return { key: 'unknown', ok: false, reviewed: false, samples }
        return { key: 'unknown', ok: false, reviewed: false, samples: 0 }
      }
      // task-106 "可能免费"宽松判据 —— 宁可多列不可漏，任一弱信号命中即入选。
      // 证据：真实免费模型（账本/registry）名字/id 全含 free（hy4-flash-free /
      // hy4flash-free / web-search-free / cat-jam-free / longcat-2.5-preview-free /
      // step-5-preview-free），付费模型（deepseek-v4.1-flash / glm-5.3-flash）不含。
      // 因此 id/name/group 含 free 为主判据，配合 seed + tier=free 投影。
      // 不会塞满 176：付费模型三项都不含 free、不在 seed、tier 非 free → 不命中。
      const isPossiblyFree = m => {
        const id = str(m?.id ?? m), name = str(m?.name), group = str(m?.group)
        const provider = str(m?.group)
        // task-107: 探测证据优先（自定义名字的免费模型也能被识别）。
        const pv = str(obj(probeVerdicts)[`${provider}/${id}`])
        if (pv === 'free') return true       // 真实探测：免费
        if (pv === 'metered') return false   // 真实探测：明确付费（不进免费区）
        // 弱信号兜底（unknown/失败/未做探测仍收录，不能挡）。
        if (`${id} ${name} ${group}`.toLowerCase().includes('free')) return true
        if (FREE_MODEL_STATUS[id] !== undefined) return true
        if (str(obj(availProjection)[id]?.tier) === 'free') return true
        return false
      }
      // Exclude virtual smart副本: the same free model id appears twice in
      // modelCatalog — a real group entry (keep) and a group==='smart' mirror
      // (drop). Reuse VIRTUAL_PROVIDERS (defined below at module scope; this is
      // a function body so it runs after all module consts are initialized).
      // Smart Gateway itself stays visible above via pi.smartTag — visible ≠ listed.
      // task-105: 去掉静态白名单过滤门槛。旧实现用 FREE_MODEL_STATUS（硬编码
      // 7 条 seed）当准入，用户在 DSH 新加的 provider/model 不在表里就被永久
      // 滤掉——与"能发现"产品定调冲突。改为运行时数据驱动：pi.models 里所有
      // 非虚拟模型都列出（虚拟 smart 副本仍过滤），可用性由双源投影如实标注。
      // 无样本的新模型显示"资费未确认（未复核）"，不声称它免费/不可用。
      const nonVirtualModels = arr(pi?.models)
        .filter(m => !VIRTUAL_PROVIDERS.has(str(m?.group)))
      // task-106 二次分区：宽松判据把"可能免费"的挑出来单独区，其余折叠。
      const maybeFreeModels = nonVirtualModels.filter(isPossiblyFree)
      const otherModels = nonVirtualModels.filter(m => !isPossiblyFree(m))
      const choices = [
        { id: 'balanced', title: t('preset.balanced'), sub: t('preset.balancedSub') },
        { id: 'cost-first', title: t('preset.cost'), sub: t('preset.costSub') },
        { id: 'speed-first', title: t('preset.speed'), sub: t('preset.speedSub') },
      ]
      // Hero 只陈述 configForms 里真实写入的配置：
      //   ranking 配了且开启 -> 显示真实策略；没配 -> 明说内置默认，不冒充均衡。
      //   首屏只陈述配置事实，不声称无法证明的运行状态（用户已多次指出）。
      const heroTitle = rankingOn ? t('hero.configured') : t('hero.defaultTitle')
      const heroExplain = rankingOn
        ? fmt(t, 'hero.configuredExplain', { strategy: strategyName })
        : t('hero.defaultExplain')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        // ① 状态条：只陈述 configForms 里真实写入的事实，不假装运行状态。
        h('div', { style: S.hero },
          h('div', { style: S.heroTitle }, heroTitle),
          h('div', { style: S.heroText }, heroExplain),
          h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-tertiary)' } }, t('hero.configuredHint')),
          h('div', { style: { ...S.muted, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } }, `v${PLUGIN_VERSION}`),
        ),
        // ② 首屏主操作：先让用户"选择怎么选"，紧贴状态条，不再被模型大卡挡在下面。
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('preset.pick')),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            choices.map(c => h('button', {
              key: c.id, type: 'button', disabled: !!working,
              style: S.choiceBtn(rankingOn && strategy === c.id),
              onClick: () => applyPreset?.(c.id),
            },
              h('span', { style: S.choiceTitle }, c.title),
              h('span', { style: S.choiceSub }, c.sub),
            )),
          ),
          working ? h('div', { style: { ...S.muted, marginTop: 8 } }, t('preset.applying')) : null,
          // ③ 点击反馈就近可见：{ok,msg} 结构化状态，成功绿、失败红（不靠文案猜颜色）。
          presetNotice ? h('div', { style: { ...(presetNotice.ok ? S.ok : S.err), marginTop: 8 } }, presetNotice.msg) : null,
        ),
        // ④ 一屏事实卡：链路数 / 账号数 / 择优是否用户自定义。
        h('div', { style: S.card },
          h(KV, { k: t('status.chains'), v: Object.keys(chains).length }),
          h(KV, { k: t('status.accounts'), v: accounts }),
          h(KV, { k: t('status.strategyEnabled'), v: rankingOn ? t('status.yes') : t('status.no') }),
        ),
        // ⑤ 一行健康提示：有真实快照才报数字，读不到就明说读不到；点击去「花费与健康」。
        h('button', {
          type: 'button', onClick: () => onOpenCost?.(),
          style: {
            ...S.card, cursor: 'pointer', width: '100%', textAlign: 'left',
            fontFamily: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
          },
        }, healthText),
        // ⑥ 已识别模型：整卡默认折叠，标题带数量；pill 列表、探测按钮与长说明都留在里面，
        //    首屏不再出现长 pill 列表和一大段模型说明。
        h('details', { style: S.card },
          h('summary', { style: { cursor: 'pointer', fontWeight: 500 } },
            piLoaded
              ? fmt(t, 'pi.availableN', { models: modelCount, providers: providerCount })
              : t('pi.available')),
          h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
            !piLoaded
              ? h('div', { style: S.muted }, t('pi.loading'))
              : (providerCount === 0 && modelCount === 0)
                ? h('div', { style: S.muted }, t('pi.empty'))
                : h('div', null,
                  h(KV, { k: t('pi.providers'), v: providerCount }),
                  h(KV, { k: t('pi.models'), v: modelCount }),
                  providerCount > 0
                    ? h('div', { style: { ...S.muted, marginTop: 4 } },
                      fmt(t, 'pi.providerNames', {
                        // 不截断：旧版 .slice(0,6) 把排在目录后面的 Smart Gateway
                        // 切掉，导致"插件自己提供的没放进去"。全部列出，并对
                        // 元 provider（智能路由，非独立模型提供商）显式标注类型。
                        names: arr(pi.providers).map(p => {
                          const id = str(p?.id)
                          const name = str(p?.name) || id
                          return id === 'smart' ? t('pi.smartTag') : name
                        }).join('、'),
                      }))
                    : null,
                  // task-106 二次分区：① "可能免费"区（宽松判据，零样本也进，
                  // 标资费未确认）；② 其余已登记模型折叠区。不挡任何模型。
                  h('div', { style: { ...S.muted, marginTop: 6 } },
                    h('div', { style: { marginBottom: 4 } }, t('pi.maybeFree')),
                    maybeFreeModels.length > 0
                      ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                        maybeFreeModels.map(m => {
                          const id = str(m?.id ?? m)
                          const st = statusOf(id)
                          const label = st.key === 'healthy' ? t('pi.availableTag') : t('pi.unknownTag')
                          return h('span', { key: id, style: S.pill(st.key === 'healthy') },
                            `${str(m?.name) || id} · ${label}${st.reviewed ? '' : `（${t('pi.unreviewed')}）`}`)
                        })
                      )
                      : h('div', { style: S.muted }, t('pi.noMaybeFree')),
                    // task-107: 手动重探入口（自动探测默认已开，此为强制重探 force）。
                    probeEnabled && maybeFreeModels.length > 0
                      ? h('button', {
                        type: 'button', style: { ...S.btn, marginTop: 6 },
                        onClick: () => onProbe?.(maybeFreeModels, true),
                      }, t('pi.probeBtn'))
                      : null,
                    h('div', { style: { ...S.muted, marginTop: 4, fontSize: 11 } }, t('pi.freeModelsHint')),
                    // 其余已登记模型：折叠，不丢（"能发现"仍成立）。
                    otherModels.length > 0
                      ? h('details', { style: { marginTop: 6 } },
                        h('summary', { style: { cursor: 'pointer', fontSize: 11 } },
                          fmt(t, 'pi.otherModels', { n: otherModels.length })),
                        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
                          otherModels.map(m => {
                            const id = str(m?.id ?? m)
                            return h('span', { key: id, style: S.pill(false) }, str(m?.name) || id)
                          })),
                      )
                      : null,
                    h('div', { style: { ...S.muted, marginTop: 2, fontSize: 11 } }, t('pi.otherProvidersHint')),
                  ),
                ),
            // ⑦ 诊断行收进折叠的「诊断」details（pi 自检 + 探测反馈 + 开关状态）；
            //    只有真失败时才默认展开，成功时收起来不占首屏。
            h(DiagDetails, {
              t,
              title: t('pi.diagnostics'),
              failed: /ok=false|异常|未挂载|失败|err=/.test(str(probeDiag)),
              lines: [
                `pi: ${str(pi?.detail) || '—'}`,
                probeDiag ? `probe: ${probeDiag}` : '',
                `probeEnabled=${probeEnabled === true} verdicts=${Object.keys(obj(probeVerdicts)).length} samples=${Object.keys(obj(availProjection)).length}`,
              ],
            }),
          ),
        ),
      )
    }

    // ---- chains -----------------------------------------------------------
    // Fallback lists are used ONLY when the pi snapshot is empty/not loaded —
    // never the source of truth. The real lists come from the runtime pi snapshot
    // so a user can pick EVERY provider/model DSH actually has (product rule:
    // "may not auto-discover, but must be discoverable because it is selectable").
    const FALLBACK_PROVIDERS = ['opencode-go', 'xiaomi-token-plan-cn', 'xiaomi', 'trae', 'workbuddy', 'opencode-zen', 'qoder']
    const FALLBACK_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3-flash', 'glm-5.3', 'mimo-v2.6-flash']
    // pi.providers = [{id,name}], pi.models = [{id,name,group}]
    // Virtual routing must never be selectable as a hop — that would make the
    // scheduler route to itself (Host already excludes provider==='smart' in
    // chains.js:44 / index.js:161). deepseek-account is excluded at the pi
    // producer (:997). Here we exclude the smart meta-provider specifically;
    // the overview still SHOWS Smart Gateway (pi.smartTag) — visible ≠ selectable.
    const VIRTUAL_PROVIDERS = new Set(['smart'])
    const providerOptions = pi => {
      const list = arr(pi?.providers)
        .map(p => ({ id: str(p?.id), name: str(p?.name) || str(p?.id) }))
        .filter(p => p.id && !VIRTUAL_PROVIDERS.has(p.id))
        .map(p => ({ v: p.id, l: p.name }))
      return list.length ? list : FALLBACK_PROVIDERS.map(v => ({ v, l: v }))
    }
    const modelOptions = pi => {
      // Exclude models whose catalog group is a virtual provider (smart-only
      // models). Real providers' models remain fully selectable (task-81).
      const list = arr(pi?.models)
        .filter(m => !VIRTUAL_PROVIDERS.has(str(m?.group)))
        .map(m => ({ v: str(m?.id ?? m), l: str(m?.name) || modelLabel(str(m?.id ?? m)) }))
        .filter(o => o.v)
      return list.length ? list : FALLBACK_MODELS.map(m => ({ v: m, l: modelLabel(m) }))
    }
    // ≥N real success samples = high enough confidence to show an explicit
    // status (design §7 FREE_LEDGER_SAMPLES). Below that = UNKNOWN/unreviewed.
    const AVAIL_HIGH_SAMPLES = 20
    // Derive a display projection from the Host's real ledger aggregation
    // (costDetail().byModel) — no new @Remote method, no inject, no requests.
    // Shape mirrors design §9 projectStatus: {modelId:{samples,failed}}; the
    // client decides confidence/health honestly from real success samples.
    const projectFromByModel = byModel => {
      const out = {}
      for (const g of arr(byModel)) {
        const id = str(g?.model)
        if (!id || VIRTUAL_PROVIDERS.has(str(g?.provider))) continue
        const success = (Number(g?.freeCalls) || 0) + (Number(g?.paidCalls) || 0)
        const failed = Number(g?.failedCalls) || 0
        const prev = out[id] ?? { samples: 0, failed: 0 }
        prev.samples += success
        prev.failed += failed
        out[id] = prev
      }
      return out
    }
    const select = (opts, value, onChange, ariaLabel) => h('select', {
      value, onChange: e => onChange(e.target.value), style: { ...S.input, ...S.select }, 'aria-label': ariaLabel,
    }, opts.map(o => h('option', { key: str(o.v ?? o), value: str(o.v ?? o) }, str(o.l ?? o))))

    // Structured chain editor: every hop is a pair of dropdowns, never JSON.
    function ChainsTab({ t, form, revision, mutate, config, pi, onDirty }) {
      const provOpts = providerOptions(pi)
      const modelOpts = modelOptions(pi)
      const configured = obj(config?.chains)
      const usingDefault = Object.keys(configured).length === 0
      const initial = usingDefault ? STATIC_DEFAULT_CHAINS : configured
      // 一处归一化：初值、config 同步与 dirty 基线必须同形状，否则"没动过"
      // 会被判成脏（或改动被判成没动）。
      const normalize = src => Object.entries(obj(src)).map(([model, hops]) => ({
        model, hops: arr(hops).map(x => ({ provider: str(x?.provider), model: str(x?.model) })),
      }))
      const [groups, setGroups] = useState(() => normalize(initial))
      useEffect(() => { setGroups(normalize(Object.keys(obj(config?.chains)).length ? config.chains : STATIC_DEFAULT_CHAINS)) }, [config?.chains])
      // 提示状态是显式 {ok,msg}：早先用正则 /error|失败/i 猜颜色，英文失败
      // 文案（Save failed）匹配不到就显示成绿色"成功"。
      const [msg, setMsg] = useState(null)
      const [rowErrors, setRowErrors] = useState({})
      // dirty = 当前草稿 vs 打开时快照（顺序无关指纹，键序抖动不算脏）。
      const baseline = stableSig(normalize(Object.keys(configured).length ? configured : STATIC_DEFAULT_CHAINS))
      const dirty = stableSig(groups) !== baseline
      useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
      // 删除两步确认：第一次点变成红字「确认删除？」，3 秒后自动还原（不单击即消失）。
      const [confirmKey, setConfirmKey] = useState(null)
      const confirmTimer = useRef(null)
      const arm = useCallback(key => {
        setConfirmKey(key)
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        confirmTimer.current = setTimeout(() => setConfirmKey(null), 3000)
      }, [])
      useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])
      const update = (gi, fn) => setGroups(prev => prev.map((g, i) => i === gi ? fn(g) : g))
      const moveHop = (gi, hi, dir) => update(gi, g => {
        const hops = [...g.hops], j = hi + dir
        if (j < 0 || j >= hops.length) return g
        ;[hops[hi], hops[j]] = [hops[j], hops[hi]]
        return { ...g, hops }
      })
      const deleteGroup = gi => setGroups(p => p.filter((_, i) => i !== gi))
      const deleteHop = (gi, hi) => update(gi, g => ({ ...g, hops: g.hops.filter((_, i) => i !== hi) }))
      // 保存前校验：过去空 hop / 空模型的行被 filter 掉还提示"已保存"，
      // 用户的输入静默消失。现在逐行报出原因并阻止保存。
      const validate = () => {
        const problems = {}
        groups.forEach((g, gi) => {
          const badHop = g.hops.findIndex(h => !str(h.provider) || !str(h.model))
          if (!str(g.model)) problems[gi] = fmt(t, 'chains.errNoModel', { n: gi + 1 })
          else if (!g.hops.length) problems[gi] = fmt(t, 'chains.errNoHop', { n: gi + 1 })
          else if (badHop >= 0) problems[gi] = fmt(t, 'chains.errEmptyHop', { n: gi + 1, step: badHop + 1 })
        })
        return problems
      }
      const save = async () => {
        const problems = validate()
        setRowErrors(problems)
        const bad = Object.keys(problems).length
        if (bad > 0) {
          setMsg({ ok: false, msg: fmt(t, 'chains.errBlocked', { n: bad }) })
          return
        }
        const out = {}
        for (const g of groups) out[g.model] = g.hops.map(h => ({ provider: h.provider, model: h.model }))
        const r = await mutate([{ op: 'set', path: ['chains'], value: out }], revision)
        const ok = r?.ok === true
        // 用户文案短而明确；form/state 这类内部串进折叠诊断（item 5）。
        setMsg({ ok, msg: ok ? t('action.saved') : t('error.saveFailed'), detail: ok ? '' : str(r?.detail) })
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.hero },
          h('div', { style: S.heroTitle }, t('chains.plainTitle')),
          h('div', { style: S.heroText }, t('chains.plainExplain')),
        ),
        // 卡片头：保存入口 + 未保存标记。不展开任何 <details> 也能看到。
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontWeight: 600 } }, t('chains.cardTitle')),
            dirty ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' } }, t('card.unsaved')) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            msg ? h('span', { style: msg.ok ? S.ok : S.err }, msg.msg) : null,
            h('button', { type: 'button', style: S.primary, onClick: save }, t('action.save')),
          ),
        ),
        msg && msg.detail ? h(DiagDetails, { t, lines: [`save: ${msg.detail}`], failed: true }) : null,
        // 诚实空态：没配链路时显示的是内置默认顺序，绝不冒充"你的配置"。
        usingDefault ? h('div', { style: { ...S.muted, lineHeight: '18px' } }, t('chains.emptyHint')) : null,
        ...groups.map((g, gi) => h('div', { key: gi, style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.label }, t('chains.modelLabel')),
            select(modelOpts, g.model,
              v => update(gi, x => ({ ...x, model: v })), t('chains.modelLabel')),
            confirmKey === `g${gi}`
              ? h('button', {
                type: 'button', style: { ...S.btn, color: 'var(--dsw-alias-state-error-primary)' },
                onClick: () => { setConfirmKey(null); deleteGroup(gi) },
              }, t('action.confirmDelete'))
              : h('button', { type: 'button', style: S.btn, onClick: () => arm(`g${gi}`) }, t('action.delete')),
          ),
          ...g.hops.map((hop, hi) => h('div', { key: hi, style: { ...S.step, borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
            h('span', { style: S.stepNum }, String(hi + 1)),
            select(provOpts, hop.provider, v => update(gi, x => ({ ...x, hops: x.hops.map((h, i) => i === hi ? { ...h, provider: v } : h) })), t('field.provider')),
            select(modelOpts, hop.model, v => update(gi, x => ({ ...x, hops: x.hops.map((h, i) => i === hi ? { ...h, model: v } : h) })), t('field.model')),
            h('button', { type: 'button', style: S.btn, onClick: () => moveHop(gi, hi, -1) }, '↑'),
            h('button', { type: 'button', style: S.btn, onClick: () => moveHop(gi, hi, 1) }, '↓'),
            confirmKey === `h${gi}-${hi}`
              ? h('button', {
                type: 'button', style: { ...S.btn, color: 'var(--dsw-alias-state-error-primary)' },
                onClick: () => { setConfirmKey(null); deleteHop(gi, hi) },
              }, t('action.confirmDelete'))
              : h('button', { type: 'button', style: S.btn, onClick: () => arm(`h${gi}-${hi}`) }, '×'),
          )),
          h('button', {
            type: 'button', style: S.btn,
            onClick: () => update(gi, x => ({ ...x, hops: [...x.hops, { provider: provOpts[0]?.v, model: modelOpts[0]?.v }] })),
          }, t('action.addHop')),
          rowErrors[gi] ? h('div', { style: S.err }, rowErrors[gi]) : null,
        )),
        h('div', { style: S.row },
          h('button', {
            type: 'button', style: S.btn,
            onClick: () => setGroups(p => [...p, { model: modelOpts[0]?.v, hops: [{ provider: provOpts[0]?.v, model: modelOpts[1]?.v ?? modelOpts[0]?.v }] }]),
          }, t('action.addChain')),
        ),
      )
    }

    // ---- accounts + ranking -----------------------------------------------
    function RankingForm({ t, cfg, onChange }) {
      const c = obj(cfg)
      // Strategies are static metadata embedded in this client — no command
      // channel, always available, identical across installs.
      const strategies = STATIC_STRATEGIES
      const strategyId = str(c.strategy) || 'balanced'
      const selected = strategies.find(s => str(s?.id) === strategyId)
      // When weights are not configured, mirror the selected preset's weights so
      // the form is never blank on a fresh install.
      const configuredWeights = obj(c.weights)
      const weights = Object.keys(configuredWeights).length > 0
        ? configuredWeights
        : (selected?.weights ? { ...selected.weights } : DEFAULT_WEIGHTS)
      const set = (key, value) => onChange({ ...c, [key]: value })
      const number = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h(Field, { label: t('ranking.enabled'), help: t('ranking.enabledHelp') },
          // Host 语义：ranking 块整体缺省 = enabled true；块内 enabled 缺省才是 false。
          // 所以"没设置"必须显示为已开启，只有用户主动取消勾选才写 false。
          h('input', {
            type: 'checkbox', checked: c.enabled !== false,
            onChange: e => set('enabled', e.target.checked),
          }),
        ),
        h(Field, { label: t('ranking.strategy') },
          h('select', {
            value: strategyId,
            onChange: e => {
              const next = strategies.find(s => str(s?.id) === e.target.value)
              // Selecting a preset fills its weights immediately — visible proof
              // the presets are live, not a decorative empty dropdown.
              onChange({
                ...c,
                strategy: e.target.value,
                weights: next?.weights ? { ...next.weights } : { ...DEFAULT_WEIGHTS },
              })
            },
            style: { ...S.input, ...S.select },
          }, strategies.map(s => h('option', { key: str(s.id), value: str(s.id) }, `${str(s.id)} · ${str(s.label) || ''}`))),
        ),
        h('div', { style: { ...S.muted, marginLeft: 96, minHeight: 18 } },
          selected ? str(selected.description || '') : '',
        ),
        ['cost', 'speed', 'tier', 'load'].map(key =>
          h(Field, { key, label: t(`ranking.w.${key}`) },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05, value: weights[key] ?? 0,
                onChange: e => set('weights', { ...weights, [key]: number(e.target.value, 0) }),
                style: { flex: 1 }, 'aria-label': t(`ranking.w.${key}`),
              }),
              h('span', { style: { ...S.code, minWidth: 32, textAlign: 'right' } }, String(weights[key] ?? 0)),
            ),
          ),
        ),
        h(Field, { label: t('ranking.tierDirection'), help: t('ranking.tierDirectionHelp') },
          h('select', {
            value: str(c.tierDirection) || 'high',
            onChange: e => set('tierDirection', e.target.value),
            style: { ...S.input, ...S.select },
          },
            h('option', { value: 'high' }, t('ranking.tierHigh')),
            h('option', { value: 'low' }, t('ranking.tierLow')),
          ),
        ),
        h(Field, { label: t('ranking.respectHopRoute') },
          h('input', {
            type: 'checkbox', checked: c.respectHopRoute !== false,
            onChange: e => set('respectHopRoute', e.target.checked),
          }),
        ),
        h(Field, { label: t('ranking.priorityMode') },
          h('select', {
            value: str(c.priorityMode) || 'hard',
            onChange: e => set('priorityMode', e.target.value),
            style: { ...S.input, ...S.select },
          },
            h('option', { value: 'hard' }, t('ranking.priorityHard')),
            h('option', { value: 'soft' }, t('ranking.prioritySoft')),
          ),
        ),
        // task-107: 探测开关，默认关闭。开启后首屏出现"检测未确认模型"按钮。
        h(Field, { label: t('ranking.probeEnabled'), help: t('ranking.probeEnabledHelp') },
          h('input', {
            type: 'checkbox', checked: c.probeEnabled === true,
            onChange: e => set('probeEnabled', e.target.checked),
          }),
        ),
      )
    }

    // P2 两层路由设置。只陈述 configForms 里真实保存的配置，不声称运行状态。
    // 开关默认启用均衡；策略用大白话预设；定位/识别规则为只读说明，不造假数据。
    function RoutingForm({ t, cfg, onChange }) {
      const c = obj(cfg)
      // 未设置 = 开启（Host 默认 routing.enabled true）；只有显式 false 才是关。
      const enabled = c.enabled !== false
      const strategy = str(c.strategy) || 'balanced'
      const selected = ROUTING_PRESETS.find(p => p.id === strategy)
      const set = (key, value) => onChange({ ...c, [key]: value })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h(Field, { label: t('routing.enabled'), help: t('routing.enabledHelp') },
          h('input', {
            type: 'checkbox', checked: enabled,
            onChange: e => set('enabled', e.target.checked),
          }),
        ),
        h(Field, { label: t('routing.strategy') },
          h('select', {
            value: strategy,
            onChange: e => set('strategy', e.target.value),
            style: { ...S.input, ...S.select },
          }, ROUTING_PRESETS.map(p => h('option', { key: p.id, value: p.id }, p.label))),
        ),
        h('div', { style: { ...S.muted, marginLeft: 96, minHeight: 18 } },
          selected ? str(selected.desc) : ''),
        // 模型定位预览：当前无可读到每台模型定位的通道，诚实说明来源，不造假表。
        h(Field, { label: t('routing.position'), help: t('routing.positionHelp') },
          h('div', { style: { ...S.muted, lineHeight: '18px' } }, t('routing.positionExplain')),
        ),
        // 任务识别规则：只读说明，一眼能懂，不是可编辑 JSON。
        h('div', { style: { marginLeft: 96, marginTop: 4 } },
          h('div', { style: { fontWeight: 500, marginBottom: 4 } }, t('routing.rulesTitle')),
          ...TASK_RULES.map(([cond, kind]) => h('div', { key: cond, style: { ...S.muted, padding: '2px 0' } },
            `${cond} → ${kind}`)),
        ),
      )
    }

    function AccountsTab({ t, config, revision, mutate, applyPreset, working, pi, costService, onDirty }) {
      // 账号数三态（loading / ok / error）：不能永远停在「正在读取」，也不能
      // 把读失败说成 0 个账号。数据源与成本页健康面板同一个 accountHealth()。
      const [accountState, setAccountState] = useState({ status: 'loading' })
      const aliveRef = useRef(true)
      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])
      const loadAccounts = useCallback(async () => {
        setAccountState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }))
        let next
        try {
          const res = await costService?.accountHealth?.()
          next = res && res.ok
            ? { status: 'ok', count: Array.isArray(res.value?.accounts) ? res.value.accounts.length : 0 }
            : { status: 'error', reason: String(res?.error?.code ?? res?.error?.message ?? 'no-channel') }
        } catch (error) {
          next = { status: 'error', reason: String(error?.message ?? error) }
        }
        if (aliveRef.current) setAccountState(next)
      }, [costService])
      useEffect(() => { void loadAccounts() }, [loadAccounts])
      const provOpts = providerOptions(pi)
      const modelOpts = modelOptions(pi)
      const configuredAccounts = arr(config?.accounts)
      const blankAccount = () => ({ id: '', provider: provOpts[0]?.v, credentialRef: '', models: [modelOpts[0]?.v], tier: 'standard' })
      // 初始化 / config 同步 / dirty 基线共用同一归一化，避免"没动过"被判成脏。
      const rowsFromConfig = cfgAccounts => arr(cfgAccounts).map(a => ({
        id: str(a?.id), provider: str(a?.provider) || provOpts[0]?.v,
        credentialRef: str(a?.credentialRef), models: arr(a?.models).length ? arr(a?.models) : [modelOpts[0]?.v],
        tier: str(a?.tier) || 'standard',
      }))
      const [rows, setRows] = useState(() => rowsFromConfig(configuredAccounts))
      useEffect(() => { setRows(rowsFromConfig(config?.accounts)) }, [config?.accounts])
      // Credential choices come ONLY from the configForms snapshot: the
      // reference names already stored on accounts (never secret values), plus
      // the human "use signed-in account" default. No command channel needed.
      const credentialChoices = (() => {
        const seen = new Set(configuredAccounts.map(a => str(a?.credentialRef)).filter(Boolean))
        return ['', ...[...seen].sort()]
      })()
      const configuredRanking = obj(config?.ranking)
      // 初值只能是「真实已存的 ranking」，绝不合成 enabled:false 的默认块：
      // ranking 整体缺省时 Host 是 enabled=true（lib/ranking.js
      // DEFAULT_RANKING_CONFIG），合成出来的 false 一旦被保存，就成了
      // "只想加个账号，结果把择优全关掉"。
      const rankingBaseline = stableSig(configuredRanking)
      const [rankingDraft, setRankingDraft] = useState(() => clone(configuredRanking) || {})
      const [msg, setMsg] = useState(null)
      const [rowErrors, setRowErrors] = useState({})
      useEffect(() => { setRankingDraft(clone(obj(config?.ranking)) || {}) }, [config?.ranking])
      // dirty = 账号草稿 + 择优/路由草稿 vs 打开时快照。
      const accountsBaseline = stableSig({ rows: rowsFromConfig(config?.accounts), ranking: configuredRanking })
      const dirty = stableSig({ rows, ranking: rankingDraft }) !== accountsBaseline
      useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
      // 删除两步确认：第一次点变红字「确认删除？」，3 秒后自动还原。
      const [confirmKey, setConfirmKey] = useState(null)
      const confirmTimer = useRef(null)
      const arm = useCallback(key => {
        setConfirmKey(key)
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        confirmTimer.current = setTimeout(() => setConfirmKey(null), 3000)
      }, [])
      useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])
      const update = (i, fn) => setRows(prev => prev.map((r, j) => j === i ? fn(r) : r))
      const toggleModel = (i, m) => update(i, r => ({
        ...r, models: r.models.includes(m) ? r.models.filter(x => x !== m) : [...r.models, m],
      }))
      // 写 ranking 时必须把默认值为「开」的开关物化：块一旦存在，
      // Host 读的是 enabled === true（lib/ranking.js:163）、
      // adapter 读的是 routing.enabled === true（lib/adapter.js:232）。
      const withOnDefaults = draft => {
        const d = obj(draft)
        const routing = obj(d.routing)
        return { ...d, enabled: d.enabled !== false, routing: { ...routing, enabled: routing.enabled !== false } }
      }
      const save = async () => {
        const problems = {}
        const out = []
        rows.forEach((r, i) => {
          const id = str(r.id).trim()
          const provider = str(r.provider).trim()
          // 过去这两种行被 filter 掉、还提示"已保存"，输入静默消失。
          if (id && !provider) { problems[i] = fmt(t, 'accounts.errNoProvider', { name: id }); return }
          if (!id && provider) { problems[i] = fmt(t, 'accounts.errNoName', { n: i + 1 }); return }
          if (!id) return
          out.push({
            id, provider,
            credentialRef: r.credentialRef || undefined,
            models: r.models,
            tier: r.tier,
          })
        })
        setRowErrors(problems)
        const bad = Object.keys(problems).length
        if (bad > 0) {
          setMsg({ ok: false, msg: fmt(t, 'accounts.errBlocked', { n: bad }) })
          return
        }
        const ops = [{ op: 'set', path: ['accounts'], value: out }]
        // 只有用户真的改过 ranking / routing 才写 ranking；否则只写 accounts，
        // 「加个账号」不会顺手把择优配置改掉。
        if (stableSig(rankingDraft) !== rankingBaseline) {
          ops.push({ op: 'set', path: ['ranking'], value: withOnDefaults(rankingDraft) })
        }
        const r = await mutate(ops, revision)
        const ok = r?.ok === true
        setMsg({ ok, msg: ok ? t('action.saved') : t('error.saveFailed'), detail: ok ? '' : str(r?.detail) })
      }

      // 只有用户真的写入过 ranking 才高亮某个预设；缺省不高亮，
      // 避免"没配却显示均衡已选中"的假象。复用上面的 configuredRanking。
      const strategy = Object.keys(configuredRanking).length > 0 ? (str(configuredRanking.strategy) || '') : ''
      const choices = [
        { id: 'balanced', title: t('preset.balanced'), sub: t('preset.balancedSub') },
        { id: 'cost-first', title: t('preset.cost'), sub: t('preset.costSub') },
        { id: 'speed-first', title: t('preset.speed'), sub: t('preset.speedSub') },
      ]
      const accountCountLine = accountState.status === 'loading'
        ? h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-tertiary)' } }, t('accounts.countLoading'))
        : accountState.status === 'error'
          ? h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-state-error-primary)' } },
            fmt(t, 'accounts.countError', { reason: accountState.reason }),
            h('button', { type: 'button', style: { ...S.btn, marginLeft: 8 }, onClick: () => { void loadAccounts() } }, t('action.retry')))
          : accountState.count === 0
            ? h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-tertiary)' } },
              t('accounts.countEmpty'), ' ', t('accounts.addGuide'))
            : h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-tertiary)' } },
              fmt(t, 'accounts.plainCount', { n: accountState.count }))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.hero },
          h('div', { style: S.heroTitle }, t('accounts.plainTitle')),
          h('div', { style: S.heroText }, t('accounts.plainExplain')),
          accountCountLine,
        ),
        h('div', null,
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('preset.pick')),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            choices.map(c => h('button', {
              key: c.id, type: 'button', disabled: !!working,
              style: S.choiceBtn(strategy === c.id), onClick: () => applyPreset?.(c.id),
            },
              h('span', { style: S.choiceTitle }, c.title),
              h('span', { style: S.choiceSub }, c.sub),
            )),
          ),
        ),
        // 卡片头：保存入口 + 未保存标记（Advanced 默认折叠也看得见）。
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontWeight: 600 } }, t('accounts.cardTitle')),
            dirty ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' } }, t('card.unsaved')) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            msg ? h('span', { style: msg.ok ? S.ok : S.err }, msg.msg) : null,
            h('button', { type: 'button', style: S.primary, onClick: save }, t('action.save')),
          ),
        ),
        msg && msg.detail ? h(DiagDetails, { t, lines: [`save: ${msg.detail}`], failed: true }) : null,
        h(Advanced, { t },
          ...rows.map((r, i) => h('div', { key: i, style: S.card },
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.accountName')),
              h('input', {
                type: 'text', value: r.id, placeholder: t('field.accountNamePh'),
                onChange: e => update(i, x => ({ ...x, id: e.target.value })), style: S.input,
              }),
              confirmKey === `a${i}`
                ? h('button', {
                  type: 'button', style: { ...S.btn, color: 'var(--dsw-alias-state-error-primary)' },
                  onClick: () => { setConfirmKey(null); setRows(p => p.filter((_, j) => j !== i)) },
                }, t('action.confirmDelete'))
                : h('button', { type: 'button', style: S.btn, onClick: () => arm(`a${i}`) }, t('action.delete')),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.provider')),
              select(provOpts, r.provider, v => update(i, x => ({ ...x, provider: v })), t('field.provider')),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.credential')),
              select(
                [{ v: '', l: t('field.credentialDefault') }, ...credentialChoices.filter(Boolean).map(c => ({ v: c, l: c }))],
                r.credentialRef, v => update(i, x => ({ ...x, credentialRef: v })), t('field.credential'),
              ),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.models')),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                modelOpts.map(o => h('label', { key: str(o.v), style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
                  h('input', {
                    type: 'checkbox', checked: r.models.includes(str(o.v)),
                    onChange: () => toggleModel(i, str(o.v)),
                  }),
                  str(o.l),
                )),
              ),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.tier')),
              select(
                [{ v: 'premium', l: t('tier.premium') }, { v: 'standard', l: t('tier.standard') }, { v: 'backup', l: t('tier.backup') }],
                r.tier, v => update(i, x => ({ ...x, tier: v })), t('field.tier'),
              ),
            ),
            rowErrors[i] ? h('div', { style: S.err }, rowErrors[i]) : null,
          )),
          h('button', { type: 'button', style: S.btn, onClick: () => setRows(p => [...p, blankAccount()]) }, t('action.addAccount')),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('ranking.title')),
            h('div', { style: { ...S.muted, marginBottom: 8 } }, t('ranking.priorityHelp')),
            h(RankingForm, { t, cfg: rankingDraft, onChange: setRankingDraft }),
          ),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('routing.title')),
            h('div', { style: { ...S.muted, marginBottom: 8 } }, t('routing.intro')),
            h(RoutingForm, { t, cfg: obj(rankingDraft?.routing), onChange: v => setRankingDraft(d => ({ ...d, routing: v })) }),
          ),
        ),
      )
    }

    // ---- cost + health ----------------------------------------------------
    // Real ledger data comes from the Host's typed @Remote service
    // `remote.smartProvider.cost()` (lib/remote.js + the inlined contribution
    // above). The Host reads cost.jsonl directly — one口径 with CostMeter;
    // no client-side parsing, no invented numbers, no fake empty state.
    // Four-dimension detail rendering — all values come from the Host's
    // costDetail() aggregation; never invented. Only --dsw-alias-* tokens.
    function CostDetailBlocks({ t, state, page, setPage, onRetry }) {
      const status = str(state?.status) || 'loading'
      if (status === 'loading') return h('div', { style: S.muted }, t('cost.detailLoading'))
      // 明细读失败 ≠ 没有记录：显示真实原因 + 重试，不把错误说成空。
      if (status === 'error') {
        return h('div', null,
          h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-state-error-primary)' } },
            fmt(t, 'cost.detailFailed', { reason: str(state?.reason) || '?' })),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('button', { type: 'button', style: S.btn, onClick: () => onRetry?.() }, t('action.retry')),
          ),
          h(DiagDetails, { t, lines: [`costDetail: ${str(state?.reason) || '?'}`], failed: true }),
        )
      }
      const detail = obj(state?.detail)
      const rows = arr(detail.rows)
      const timeline = arr(detail.timeline)
      const byModel = arr(detail.byModel)
      const savings = obj(detail.savings)
      const savingModels = arr(savings.models)
      const maxCalls = Math.max(1, ...timeline.map(x => Number(x.calls) || 0))
      const pages = Math.max(1, Math.ceil(Number(detail.total || 0) / Math.max(1, Number(detail.limit) || 50)))
      // 缺值显示「—」，绝不把 null / 缺失显示成 0（老账本行本来就没有延迟字段）。
      const numOrDash = (v, digits) => {
        if (v === null || v === undefined || v === '') return '—'
        const n = Number(v)
        if (!Number.isFinite(n)) return '—'
        return digits ? n.toFixed(digits) : String(Math.round(n))
      }
      const columns = ['time', 'model', 'tokens', 'ttft', 'tps', 'cost', 'status']
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        // ① 逐笔明细
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, fmt(t, 'cost.detailTitle', { n: Number(detail.total || 0) })),
          rows.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : h('div', { style: { overflowX: 'auto' } },
              h('table', { style: { ...S.table, minWidth: 720 } },
                h('thead', null, h('tr', null, columns.map(k =>
                  h('th', { key: k, style: S.th }, t(`cost.col.${k}`))))),
                h('tbody', null, rows.map((r, i) => h('tr', { key: `${str(r?.requestId)}-${i}` },
                  [str(r?.timestamp).replace('T', ' ').slice(0, 19),
                   `${str(r?.provider)}/${str(r?.model)}`,
                   `${Number(r?.inputTokens || 0)}+${Number(r?.outputTokens || 0)}`,
                   numOrDash(r?.ttftMs),
                   numOrDash(r?.tokensPerSecond, 1),
                   `$${Number(r?.costUsd || 0).toFixed(6)}`,
                   r?.failed ? t('cost.failed') : t('cost.ok'),
                  ].map((v, j) => h('td', { key: j, style: S.td }, v)))),
                ),
              ),
            ),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('button', { type: 'button', style: S.btn, disabled: page <= 0, onClick: () => setPage(p => Math.max(0, p - 1)) }, t('cost.prevPage')),
            h('span', { style: S.muted }, ` ${page + 1} / ${pages} `),
            h('button', { type: 'button', style: S.btn, disabled: page + 1 >= pages, onClick: () => setPage(p => p + 1) }, t('cost.nextPage')),
          ),
        ),
        // ② 时间趋势（纯 CSS 柱状图）
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('cost.timelineTitle')),
          timeline.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, minHeight: 90 } },
              timeline.map(b => h('div', { key: str(b?.day), style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 } },
                h('div', { style: { ...S.muted, fontSize: 11 } }, String(Number(b?.calls) || 0)),
                h('div', { style: { width: '100%', height: `${Math.max(4, Math.round((Number(b?.calls) || 0) / maxCalls * 60))}px`, background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)', borderRadius: 'var(--dsw-radius-sm)' } }),
                h('div', { style: { ...S.muted, fontSize: 11 } }, str(b?.day).slice(5)),
              )),
            ),
        ),
        // ③ 按模型/提供商分组
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('cost.byModelTitle')),
          byModel.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : byModel.map(g => h('div', { key: `${str(g?.provider)}/${str(g?.model)}`, style: { padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
              h(KV, { k: `${str(g?.provider)}/${str(g?.model)}`, v: fmt(t, 'cost.byModelValue', { calls: Number(g?.calls) || 0, cost: Number(g?.costUsd || 0).toFixed(6) }) })),
            ),
        ),
        // ④ 节省账本（诚实标注，绝不编数字）
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 500, marginBottom: 8 } }, t('cost.savingsTitle')),
          h('div', { style: { ...S.muted, marginBottom: 8, color: 'var(--dsw-alias-state-warn-label)' } }, t('cost.savingsNotice')),
          savingModels.length === 0
            ? h('div', { style: S.muted }, t('cost.noComparable'))
            : savingModels.map(m => h('div', { key: str(m?.model), style: { padding: '4px 0' } },
              h(KV, { k: fmt(t, 'cost.savingsModel', { model: str(m?.model) }), v: m?.known && Number.isFinite(Number(m?.estimatedUsd))
                ? fmt(t, 'cost.savingsValue', { usd: `$${Number(m.estimatedUsd).toFixed(2)}` })
                : t('cost.noComparable') })),
            ),
        ),
      )
    }

    // ---- T3b: 账号健康 / 冷却面板 ------------------------------------------
    // 数据源 = Host 实时注册表 smartProvider/accountHealth（服务对象就是已有的
    // costService，不新建注入通道，也绝不把 smartProvider 写进 inject）。
    // 诚实性纪律（本面板的验收核心）：
    //   · 零样本 / 未知状态一律「暂无数据」+ 中性色，绝不显示「不可用」、绝不伪造绿；
    //   · 健康层被配置关闭时明说关闭，不假装正常；
    //   · 倒计时用组件内单一 setTimeout 每秒现算（不用 setInterval，避免泄漏），
    //     卸载/隐藏时清理；保留快照时间 + 手动「重新读取」。
    const HEALTH_SUCCESS_COLOR = 'var(--dsw-alias-state-success-primary)'
    // 冷却/降级用警告色，**绝不用 error 红**。按卡上写法优先 --dsw-alias-state-warning-primary；
    // 实测本构建（DSH NEXT app.asar）里该名定义数为 0，真正存在的是
    // --dsw-alias-state-warn-primary（4 处定义），故链式兜底：
    // warning-primary → warn-primary → label-secondary。任一级缺失都不会落红，
    // 最差也只是退成中性灰，符合「不存在就用 label-secondary」的纪律。
    const HEALTH_WARN_COLOR = 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)))'
    const HEALTH_NEUTRAL_COLOR = 'var(--dsw-alias-label-tertiary)'

    const fmtClock = ms => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const d = new Date(n)
      const pad = v => String(v).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    // 剩余冷却格式化：<1s「即将到期」；<1h「29 分 12 秒」/「12 秒」；>=1h「1 小时 3 分」。
    const fmtDuration = (t, ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 1000) return t('health.soon')
      const total = Math.ceil(n / 1000)
      const hours = Math.floor(total / 3600)
      const mins = Math.floor((total % 3600) / 60)
      const secs = total % 60
      if (hours > 0) return fmt(t, 'health.durationHour', { h: hours, m: mins })
      if (mins > 0) return fmt(t, 'health.durationMinute', { m: mins, s: secs })
      return fmt(t, 'health.durationSecond', { s: secs })
    }
    // 账号状态文案：UNKNOWN / 缺失 / 畸形 一律「暂无数据」，绝不落到「不可用」。
    const accountStateText = (t, state) => {
      const k = str(state).toUpperCase()
      if (k === 'ACTIVE') return t('health.stateActive')
      if (k === 'COOLING') return t('health.stateCooling')
      if (k === 'HALF_OPEN') return t('health.stateHalfOpen')
      return t('health.stateUnknown')
    }
    // 只有 ACTIVE 用绿；COOLING / HALF_OPEN 用警告；UNKNOWN 及一切未知值用中性。
    const accountStateColor = state => {
      const k = str(state).toUpperCase()
      if (k === 'ACTIVE') return HEALTH_SUCCESS_COLOR
      if (k === 'COOLING' || k === 'HALF_OPEN') return HEALTH_WARN_COLOR
      return HEALTH_NEUTRAL_COLOR
    }
    const routeHealthText = (t, health) => {
      const k = str(health).toUpperCase()
      if (k === 'HEALTHY') return t('health.healthHealthy')
      if (k === 'DEGRADED') return t('health.healthDegraded')
      if (k === 'DEPRECATED') return t('health.healthDeprecated')
      return t('health.healthUnknown')
    }
    // 只有 HEALTHY 用绿；DEGRADED / DEPRECATED 用警告；UNKNOWN 及未知值用中性。
    const routeHealthColor = health => {
      const k = str(health).toUpperCase()
      if (k === 'HEALTHY') return HEALTH_SUCCESS_COLOR
      if (k === 'DEGRADED' || k === 'DEPRECATED') return HEALTH_WARN_COLOR
      return HEALTH_NEUTRAL_COLOR
    }
    const tierText = (t, tier) => {
      const k = str(tier).toLowerCase()
      if (k === 'free') return t('health.tierFree')
      if (k === 'metered') return t('health.tierMetered')
      return t('health.tierUnknown')
    }
    // 零样本 = 暂无数据：字段缺失或 success+failure 全为 0 都算零样本，绝不写「0 / 0」。
    const samplesInfo = samples => {
      const s = obj(samples)
      const ok = Number(s.success) || 0
      const fail = Number(s.failure) || 0
      return { ok, fail, total: ok + fail }
    }
    const samplesText = (t, samples) => {
      const { ok, fail, total } = samplesInfo(samples)
      return total === 0 ? t('health.noSamples') : `${ok} / ${fail}`
    }
    // 可信度阈值与 lib/availability.js CONFIDENCE 对齐：HIGH .95 / MEDIUM .7 / LOW .25。
    const confText = (t, conf) => {
      const n = Number(conf)
      if (!Number.isFinite(n) || n <= 0) return t('health.confUnknown')
      if (n >= 0.95) return t('health.confHigh')
      if (n >= 0.7) return t('health.confMedium')
      if (n >= 0.25) return t('health.confLow')
      return t('health.confUnknown')
    }
    // hop: 前缀只作内部标识，显示层去掉；完整值放 title，长 id 靠 overflowWrap 断行。
    const displayId = raw => {
      const s = str(raw)
      return s.startsWith('hop:') ? s.slice(4) : s
    }
    // 倒计时现算：优先 wire 上的 until - Date.now()；until 缺失退首次生成的 remainingMs 兜底。
    const remainNow = row => {
      const until = Number(row.until)
      if (Number.isFinite(until) && until > 0) return Math.max(0, until - Date.now())
      return Number(row.remainingMs) || 0
    }
    const implicitBadge = { ...S.muted, marginLeft: 6, fontSize: 10, padding: '1px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)' }
    const idCell = { ...S.td, overflowWrap: 'anywhere' }

    function AccountHealthPanel({ t, snapshot, diag, loading, onRefresh }) {
      const snap = obj(snapshot)
      const accounts = arr(snap.accounts)
      const routes = arr(snap.routes)
      const snapAt = Number(snap.generatedAt)
      // 倒计时用组件内单一 setTimeout 每秒 tick 重绘（不用 setInterval）。
      // tab 隐藏时暂停；卸载时 alive=false + clearTimeout + 摘监听，三重清理防泄漏。
      const [, setTick] = useState(0)
      const aliveRef = useRef(true)
      useEffect(() => {
        let alive = true
        aliveRef.current = true
        let timer = null
        const schedule = () => {
          if (!alive || (typeof document !== 'undefined' && document.hidden)) return
          timer = setTimeout(() => {
            if (!alive) return
            setTick(v => v + 1)
            schedule()
          }, 1000)
        }
        const onVis = () => {
          if (typeof document === 'undefined' || !alive) return
          if (document.hidden) {
            if (timer) { clearTimeout(timer); timer = null }
          } else if (!timer) schedule()
        }
        schedule()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          aliveRef.current = false
          if (timer) clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
        }
      }, [])

      // 分支顺序即优先级：loading → 无通道 → 健康层关闭 → 无数据 → 两张表。
      let body
      if (loading) {
        body = h('div', { style: S.muted }, t('health.loading'))
      } else if (!snapshot) {
        body = h('div', null,
          h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-secondary)' } }, t('health.noChannel')),
          // 内部串（accountHealth.callable/ok/err）收进折叠诊断，失败时默认展开。
          h(DiagDetails, { t, lines: [`health: ${str(diag) || '—'}`], failed: true }),
        )
      } else if (snap.enabled === false) {
        // 明说被关闭，不假装正常；中性色，不吓人也不冒充健康。
        body = h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-label-secondary)' } }, t('health.disabledExplain'))
      } else if (accounts.length === 0 && routes.length === 0) {
        // 健康层开着但确实没有数据 —— 绝不写成「不可用」。
        body = h('div', { style: S.muted }, t('health.empty'))
      } else {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', null,
            h('div', { style: { fontWeight: 500, marginBottom: 6 } }, t('health.accountsTitle')),
            accounts.length === 0
              ? h('div', { style: S.muted }, t('health.empty'))
              : h('div', { style: { overflowX: 'auto' } },
                h('table', { style: { ...S.table, minWidth: 640 } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th, scope: 'col' }, t('health.id')),
                  h('th', { style: S.th, scope: 'col' }, t('health.provider')),
                  h('th', { style: S.th, scope: 'col' }, t('health.state')),
                  h('th', { style: S.th, scope: 'col' }, t('health.coolRemain')),
                  h('th', { style: S.th, scope: 'col' }, t('health.streak')),
                  h('th', { style: S.th, scope: 'col' }, t('health.usage')),
                  h('th', { style: S.th, scope: 'col' }, t('health.samples')),
                )),
                h('tbody', null, accounts.map((a, i) => {
                  const row = obj(a)
                  const models = arr(row.models).filter(m => typeof m === 'string' && m)
                  const state = str(row.state).toUpperCase()
                  const reason = row.reason === null || row.reason === undefined ? '' : str(row.reason)
                  const cooling = state === 'COOLING' || state === 'HALF_OPEN'
                  const remain = cooling ? remainNow(row) : 0
                  const fullId = str(row.id)
                  return h('tr', { key: `a:${fullId || i}` },
                    h('td', { style: idCell },
                      h('div', { title: fullId || undefined },
                        displayId(fullId) || '—',
                        row.implicit === true ? h('span', { style: implicitBadge }, t('health.implicit')) : null,
                      ),
                      h('div', { style: S.muted }, fmt(t, 'health.lastSeen', {
                        ok: row.lastSuccessAt === null || row.lastSuccessAt === undefined ? t('health.never') : fmtClock(row.lastSuccessAt),
                        fail: row.lastFailureAt === null || row.lastFailureAt === undefined ? t('health.never') : fmtClock(row.lastFailureAt),
                      })),
                    ),
                    h('td', { style: S.td },
                      h('div', null, str(row.provider) || '—'),
                      models.length ? h('div', { style: S.muted }, models.join(' · ')) : null,
                    ),
                    h('td', { style: S.td },
                      h('span', { style: { color: accountStateColor(row.state), fontWeight: 500 } }, accountStateText(t, row.state)),
                      reason ? h('div', { style: S.muted }, `${t('health.coolReason')}: ${reason}`) : null,
                    ),
                    h('td', { style: S.td }, cooling && remain > 0 ? fmtDuration(t, remain) : '—'),
                    h('td', { style: S.td }, String(Number(row.streak) || 0)),
                    h('td', { style: S.td }, String(Number(row.usage) || 0)),
                    h('td', { style: S.td }, samplesText(t, row.samples)),
                  )
                })),
                ),
              ),
          ),
          h('div', null,
            h('div', { style: { fontWeight: 500, marginBottom: 6 } }, t('health.routesTitle')),
            routes.length === 0
              ? h('div', { style: S.muted }, t('health.empty'))
              : h('div', { style: { overflowX: 'auto' } },
                h('table', { style: { ...S.table, minWidth: 560 } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th, scope: 'col' }, t('health.provider')),
                  h('th', { style: S.th, scope: 'col' }, t('health.model')),
                  h('th', { style: S.th, scope: 'col' }, t('health.health')),
                  h('th', { style: S.th, scope: 'col' }, t('health.tier')),
                  h('th', { style: S.th, scope: 'col' }, t('health.confidence')),
                  h('th', { style: S.th, scope: 'col' }, t('health.samples')),
                )),
                h('tbody', null, routes.map((r, i) => {
                  const row = obj(r)
                  const conf = Number(row.confidence)
                  return h('tr', { key: `r:${str(row.provider)}::${str(row.modelId)}:${i}` },
                    h('td', { style: S.td }, str(row.provider) || '—'),
                    h('td', { style: S.td }, str(row.modelId) || '—'),
                    h('td', { style: S.td },
                      h('span', { style: { color: routeHealthColor(row.health), fontWeight: 500 } }, routeHealthText(t, row.health)),
                    ),
                    h('td', { style: S.td }, tierText(t, row.tier)),
                    h('td', { style: S.td }, confText(t, conf), Number.isFinite(conf) ? h('div', { style: S.muted, title: `${t('health.confidence')}: ${conf.toFixed(2)}` }, conf.toFixed(2)) : null),
                    h('td', { style: S.td }, samplesText(t, row.samples)),
                  )
                })),
                ),
              ),
          ),
        )
      }

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { style: { flex: 1, minWidth: 160 } },
            h('div', { style: { fontWeight: 500 } }, t('health.title')),
            h('div', { style: { ...S.muted, marginTop: 2 } }, t('health.plainExplain')),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: S.muted }, fmt(t, 'health.snapshotAt', { time: snapshot && Number.isFinite(snapAt) && snapAt > 0 ? fmtClock(snapAt) : '—' })),
            h('button', {
              type: 'button',
              style: { ...S.btn, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : undefined },
              disabled: loading,
              'aria-busy': loading ? 'true' : undefined,
              onClick: () => { try { void onRefresh?.(() => aliveRef.current) } catch { /* 刷新失败由 diag 行自曝 */ } },
            }, loading ? t('health.refreshing') : t('health.refresh')),
          ),
        ),
        body,
      )
    }

    function CostHealthTab({ t, localConfig, remote, costService, costDiag }) {
      const cfg = obj(localConfig)
      // 三个数据源各自三态（loading / ok / error）。绝不把"读失败"说成
      // "没有数据通道"，也绝不把 0 条记录说成"读不到"（item 4 状态分家）。
      const [costState, setCostState] = useState({ status: 'loading' })
      const [detailState, setDetailState] = useState({ status: 'loading' })
      const [page, setPage] = useState(0)
      const [reloadKey, setReloadKey] = useState(0)
      // T3b: 账号健康快照三态。loading 初值 true —— 首屏必须先显示「正在读取」，
      // 绝不能在拿到数据前就渲染成空表（那会被误读成「没有账号 / 一切正常」）。
      const [healthSnap, setHealthSnap] = useState(null)
      const [healthDiag, setHealthDiag] = useState('')
      const [healthLoading, setHealthLoading] = useState(true)
      // 重新读取按钮复用同一个 loader；不做 setInterval（避免定时器泄漏）。
      // isAlive 由调用方传入：卸载后不再 setState（避免卸载后写状态）。
      const loadHealth = useCallback(async (isAlive) => {
        const live = typeof isAlive === 'function' ? isAlive : () => true
        if (!live()) return
        setHealthLoading(true)
        let d = `accountHealth.callable=${typeof costService?.accountHealth === 'function'}`
        let next = null
        try {
          const res = await costService?.accountHealth?.()
          d += ` accountHealth.ok=${res?.ok === true}`
          if (res && res.ok) {
            next = res.value ?? null
            d += ` enabled=${res.value?.enabled === true}`
          } else {
            // 拿不到就诚实清空，绝不保留上一次的旧快照冒充当前状态。
            d += ` accountHealth.err=${String(res?.error?.code ?? res?.error?.message ?? '?')}`
          }
        } catch (error) {
          d += ` accountHealth.throw=${String(error?.message ?? error)}`
        }
        if (!live()) return
        setHealthSnap(next)
        setHealthDiag(d)
        setHealthLoading(false)
      }, [costService])
      useEffect(() => {
        let alive = true
        void loadHealth(() => alive)
        return () => { alive = false }
      }, [loadHealth, reloadKey])
      // 总花费 + 节省账本（成本服务）
      useEffect(() => {
        let alive = true
        const load = async () => {
          setCostState({ status: 'loading' })
          try {
            const res = await costService?.cost?.()
            if (!alive) return
            if (res && res.ok) setCostState({ status: 'ok', value: res.value ?? {} })
            else setCostState({ status: 'error', reason: String(res?.error?.code ?? res?.error?.message ?? 'no-channel') })
          } catch (error) {
            if (alive) setCostState({ status: 'error', reason: String(error?.message ?? error) })
          }
        }
        void load()
        return () => { alive = false }
      }, [costService, reloadKey])
      // 逐笔明细（分页）
      useEffect(() => {
        let alive = true
        const load = async () => {
          setDetailState({ status: 'loading' })
          try {
            const res = await costService?.costDetail?.({ offset: page * 50, limit: 50 })
            if (!alive) return
            if (res && res.ok && res.value) setDetailState({ status: 'ok', detail: res.value })
            else setDetailState({ status: 'error', reason: String(res?.error?.code ?? res?.error?.message ?? 'no-channel') })
          } catch (error) {
            if (alive) setDetailState({ status: 'error', reason: String(error?.message ?? error) })
          }
        }
        void load()
        return () => { alive = false }
      }, [costService, page, reloadKey])
      const refresh = () => { setReloadKey(k => k + 1) }
      // Fallback: a snapshot-provided cost (if any) only when the remote failed.
      const snapCost = obj(cfg.cost)
      const hasSnapCost = Object.keys(snapCost).length > 0
      const cost = costState.status === 'ok' ? obj(costState.value) : (hasSnapCost ? snapCost : null)
      const records = Number(cost?.records ?? 0)
      const totalUsd = Number(cost?.estimatedCostUsd ?? 0)
      const savingsModels = arr(obj(detailState.detail?.savings).models)
      const knownSavings = savingsModels.filter(m => m?.known === true && Number.isFinite(Number(m?.estimatedUsd)))
      const savingsValue = knownSavings.length
        ? `$${knownSavings.reduce((sum, m) => sum + Number(m.estimatedUsd), 0).toFixed(2)}`
        : t('cost.noComparable')
      const failed = costState.status === 'error' || detailState.status === 'error'
      const diagLines = [
        `costService mount: ${str(costDiag) || '—'}`,
        costState.status === 'error' ? `cost: ${str(costState.reason)}` : '',
        detailState.status === 'error' ? `costDetail: ${str(detailState.reason)}` : '',
        `healthDiag: ${str(healthDiag) || '—'}`,
      ]
      const overview = costState.status === 'loading' && !hasSnapCost
        ? h('div', { style: S.muted }, t('cost.loading'))
        : costState.status === 'error' && !hasSnapCost
          ? h('div', null,
            h('div', { style: { ...S.heroText, color: 'var(--dsw-alias-state-error-primary)' } },
              fmt(t, 'cost.loadFailed', { reason: str(costState.reason) || '?' })),
            h('div', { style: { ...S.row, marginTop: 8 } },
              h('button', { type: 'button', style: S.btn, onClick: refresh }, t('action.retry')),
            ),
          )
          : h('div', null,
            h(KV, { k: t('cost.estimated'), v: `$${totalUsd.toFixed(2)}` }),
            h(KV, { k: t('cost.records'), v: records }),
            h(KV, { k: t('cost.savings'), v: savingsValue }),
            costState.status === 'error'
              ? h('div', { style: { ...S.muted, marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' } },
                fmt(t, 'cost.loadFailed', { reason: str(costState.reason) || '?' }))
              : null,
            records === 0 ? h('div', { style: { ...S.muted, marginTop: 6 } }, t('cost.detailNone')) : null,
          )
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.hero },
          h('div', { style: S.heroTitle }, t('cost.title')),
          h('div', { style: S.heroText }, t('cost.plainExplain')),
        ),
        // 概览卡：2 位小数总花费 / 调用总数 / 节省金额 + 刷新
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 } },
            h('span', { style: { fontWeight: 600 } }, t('cost.overviewTitle')),
            h('button', { type: 'button', style: S.btn, onClick: refresh }, t('action.refresh')),
          ),
          overview,
        ),
        // 逐笔明细 / 趋势 / 按模型 / 节省账本 全部收进「详细数据」折叠；
        // 失败时默认展开，让错误当场可见。
        h('details', { style: S.card, open: failed },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
            fmt(t, 'cost.detailBlock', { n: records })),
          h('div', { style: { marginTop: 10 } },
            h(CostDetailBlocks, { t, state: detailState, page, setPage, onRetry: refresh }),
          ),
        ),
        h(AccountHealthPanel, {
          t,
          snapshot: healthSnap,
          diag: healthDiag,
          loading: healthLoading,
          onRefresh: () => { void loadHealth(() => true) },
        }),
        // mount / state 这类内部串统一进折叠诊断，失败才默认展开。
        h(DiagDetails, { t, lines: diagLines, failed }),
      )
    }

    // ---- section root -----------------------------------------------------
    // 三个 Tab（原四 Tab 合并）：普通用户 30 秒内只需要「看状态 / 选怎么选 / 看花费」。
    // 原「切换链」与「账号池 + 择优」合并进「路由设置」，两张卡各自保留保存按钮与语义。
    const TABS = [
      { id: 'overview', labelKey: 'tab.overview' },
      { id: 'routing', labelKey: 'tab.routing' },
      { id: 'cost', labelKey: 'tab.cost' },
    ]

    function SmartSettingsSection({ t, form, remote, llm: injectedLlm, session: injectedSession, settings: injectedSettings, smartProvider, costService: propCostService, mountDiag, close }) {
      const [tab, setTab] = useState('overview')
      const [working, setWorking] = useState(false)
      const [presetNotice, setPresetNotice] = useState(null)
      // 路由设置里有未保存草稿时，切 Tab 先确认，绝不静默丢改动。
      const [dirtyParts, setDirtyParts] = useState({ chains: false, accounts: false })
      const [pendingTab, setPendingTab] = useState(null)
      const reportDirty = useCallback((key, value) => {
        setDirtyParts(prev => (prev[key] === value ? prev : { ...prev, [key]: value }))
      }, [])
      const routingDirty = dirtyParts.chains === true || dirtyParts.accounts === true
      const switchTab = useCallback(id => {
        setPendingTab(null)
        setDirtyParts({ chains: false, accounts: false })
        setTab(id)
      }, [])
      const requestTab = useCallback(id => {
        if (id === tab) return
        if (tab === 'routing' && routingDirty) { setPendingTab(id); return }
        switchTab(id)
      }, [tab, routingDirty, switchTab])
      // @Remote 成本服务：由 injected() 软探测（ctx.get，非 inject）透传。
      // 绝不把它加进模块 inject —— 那是本模块 $mount 产出的，会死锁。
      const costService = smartProvider ?? propCostService

      // task-110 TDZ 修复：readSnapshot/snap/config/revision/probeEnabled 必须
      // 提前到所有引用点（runProbe、自动探测 effect）之前定义。原来定义在
      // 组件下方导致 `Cannot access 'probeEnabled' before initialization`
      // → slot 崩溃 → 白屏。configForms 快照是同步可读的，提前无副作用。
      const readSnapshot = useCallback(() => {
        try { return obj(form?.getSnapshot?.()) } catch { return {} }
      }, [form])
      const snap = readSnapshot()
      const config = obj(snap.value)
      const revision = Number.isFinite(snap.revision) ? snap.revision : 0
      const probeSetting = obj(config?.ranking).probeEnabled !== undefined
        ? obj(config?.ranking).probeEnabled
        : config?.probeEnabled
      const probeEnabled = probeSetting !== false

      // pi-ai 真实资源快照（只读）。configForms 快照只有"本插件自己的配置"，
      // 用户在「模型」页配的 provider/model 在 pi-ai 那边，必须单独读。
      // 官方 models 页 store.ts:233-234 同时读 listProviders() + listConfigurableProviders()
      // 再 join —— 左侧那一排 provider 主要在"目录表"里，只读 listProviders 会漏。
      // 全部返回 {ok, value}；任一路拿不到就降级为空数组，绝不用假数据冒充。
      const [pi, setPi] = useState({ providers: [], models: [], loaded: false })
      // L5b: 首屏可用性投影。主源 = Host live registry 的 availabilityStatus()
      // （L1 projectStatus，含账本+#recordHop 会话双信号，覆盖 workbuddy 这种
      // 不写账本的路由）；降级 = 账本 byModel 单源。两者都来自已 $mount 的
      // costService，$mount 软探测（ctx.get），绝不进 inject（死锁教训）。
      const [availProjection, setAvailProjection] = useState(null)
      // task-107: 探测 verdict（Map "provider/model" -> verdict）。默认不自动
      // 探测（lead 要求可配置、等用户拍板）——只有 probeEnabled 时才发最小探测。
      const [probeVerdicts, setProbeVerdicts] = useState({})
      // task-111: 探测诊断自曝（点击有反馈，失败显示具体原因）。
      const [probeDiag, setProbeDiag] = useState('')
      // 自动探测去重：已触发过的 tuple 不再自动探（Host TTL 缓存兜底不重复花钱）。
      const autoProbedRef = useRef({})
      const llm = injectedLlm ?? remote?.llm
      const session = injectedSession ?? remote?.session

      useEffect(() => {
        let alive = true
        const load = async () => {
          // 双源合并（设计 §3.2 账本 + 会话信号）—— 不能主源非空就 return：
          // task-104 根因就是 availabilityStatus 非空但 confidence 偏低时提前
          // 返回，导致账本 10030 样本判可用的路径永远跑不到，全显示未确认。
          // 合并策略：每个 modelId 取两源样本数的 MAX，任一源有足够真实样本
          // 即视为已复核（诚实：两个都是真实使用证据，不是编造）。
          const merged = {}
          const addSample = (id, samples, tier) => {
            if (!id) return
            const prev = merged[id] ?? { samples: 0 }
            merged[id] = {
              samples: Math.max(Number(prev.samples ?? 0), Number(samples) || 0),
              // task-106: 保留 tier 供"可能免费"判据使用（不参与状态判定）。
              tier: str(tier) || str(prev.tier) || undefined,
            }
          }
          // 源 1：live registry 投影 {modelId:{health,tier,confidence}}（含会话信号）。
          try {
            const sr = await costService?.availabilityStatus?.()
            if (sr && sr.ok && sr.value) {
              // projectStatus() 已跳过 isVirtual 条目（availability.js §6.2）。
              for (const [id, row] of Object.entries(sr.value)) {
                // confidence>=0.7 = 高/中置信（设计 §7：20+ 样本）。低置信
                // 不冒充已复核，但也不盖掉账本源——合并时取 max。
                const verified = Number(row?.confidence) >= 0.7
                  && str(row?.health) !== 'UNKNOWN'
                  && str(row?.tier) !== 'unknown'
                addSample(id, verified ? AVAIL_HIGH_SAMPLES : 0, row?.tier)
              }
            }
          } catch { /* live source unavailable -> ledger still applies */ }
          // 源 2：账本 byModel（freeCalls/paidCalls 是真实成功样本数）。
          try {
            const dr = await costService?.costDetail?.({ offset: 0, limit: 1 })
            if (dr && dr.ok && dr.value) {
              for (const [id, row] of Object.entries(projectFromByModel(dr.value.byModel))) {
                addSample(id, row?.samples)
              }
            }
          } catch { /* ledger unavailable -> live source still applies */ }
          if (alive) setAvailProjection(merged)
        }
        void load()
        return () => { alive = false }
      }, [costService])

      // task-107: 手动/可选触发的最小探测。默认不自动发（probeEnabled=false），
      // 只有用户开启后才对"弱信号命中但零样本"的少数候选探测（Host 单次上限3）。
      // 探测失败/unknown 不挡——isPossiblyFree 仍按弱信号收录。
      const runProbe = useCallback(async (candidates, force) => {
        if (!probeEnabled || !Array.isArray(candidates) || candidates.length === 0) {
          setProbeDiag('无可探测候选')
          return
        }
        const list = candidates.slice(0, 3).map(m => ({
          provider: str(m?.group), model: str(m?.id ?? m),
        })).filter(c => c.provider && c.model && c.provider !== 'smart')
        if (list.length === 0) { setProbeDiag('候选无有效 provider/model'); return }
        const callable = typeof costService?.probeModels === 'function'
        setProbeDiag(`调用中… probeModels=${callable} force=${force === true} n=${list.length}`)
        if (!callable) {
          // task-111: 不再静默吞 —— 明确告诉用户服务未挂（通常是 Host 端
          // remote.js 改动后未 reload，$mount 里没有该 descriptor）。
          setProbeDiag('探测服务未挂载：需 reload 插件后重试')
          return
        }
        try {
          const res = await costService.probeModels({ candidates: list, force: force === true })
          const ok = res?.ok === true
          const n = Array.isArray(res?.value?.results) ? res.value.results.length : 0
          setProbeDiag(`结果 ok=${ok} results=${n}${ok ? '' : ` err=${String(res?.error?.code ?? res?.error?.message ?? '?')}`}`)
          if (ok && Array.isArray(res.value.results)) {
            const next = {}
            for (const r of res.value.results) {
              next[`${str(r?.provider)}/${str(r?.model)}`] = str(r?.verdict)
            }
            setProbeVerdicts(prev => ({ ...prev, ...next }))
          }
        } catch (error) {
          setProbeDiag(`调用异常：${String(error?.message ?? error)}`)
        }
      }, [probeEnabled, costService])

      // 用户拍板：新模型发现时自动探一次（无需点按钮）。只探"零样本 + 未探过
      // + 名字弱信号(含free)"的候选，单次≤3（Host cap），用 ref 去重防重复烧。
      // 探测失败/unknown 不挡——isPossiblyFree 仍按弱信号收录。
      useEffect(() => {
        if (!probeEnabled || !pi?.loaded || !costService) return
        const candidates = []
        for (const m of arr(pi.models)) {
          const id = str(m?.id ?? m), provider = str(m?.group)
          if (!id || !provider || provider === 'smart') continue
          const key = `${provider}/${id}`
          if (autoProbedRef.current[key]) continue
          // 只探零样本的（有样本已由双源判定，不必花钱探）
          if (Number(obj(availProjection)[id]?.samples ?? 0) > 0) continue
          // 只探"可能免费"弱信号命中的，避免对全部 176 个批量探测
          if (!`${id} ${str(m?.name)} ${provider}`.toLowerCase().includes('free')) continue
          candidates.push(m)
          if (candidates.length >= 3) break
        }
        if (candidates.length === 0) return
        for (const m of candidates) autoProbedRef.current[`${str(m?.group)}/${str(m?.id ?? m)}`] = true
        void runProbe(candidates)
      }, [probeEnabled, pi, availProjection, costService, runProbe])

      useEffect(() => {
        let alive = true
        const load = async () => {
          const providers = [], models = [], diag = []
          const seen = new Set()
          // 自曝式诊断：把每个源的真实返回结构写进空态文案，真机截图一次定位，
          // 不再靠猜（浏览器 console 不进 DSH 日志，我们无浏览器控制权限）。
          diag.push(`llm=${!!llm} session=${!!session}`)
          // 与官方 models 页一致：两个源都要读，去重后合并。
          const sources = [
            ['listProviders', () => llm?.listProviders?.()],
            ['listConfigurableProviders', () => llm?.listConfigurableProviders?.()],
          ]
          for (const [label, read] of sources) {
            try {
              const res = await read()
              const vtype = Array.isArray(res?.value) ? `array(${res.value.length})` : (res?.value === undefined ? 'undef' : typeof res?.value)
              diag.push(`${label}:ok=${res?.ok === true} v=${vtype}${res?.ok === false ? ` err=${String(res?.error?.code ?? res?.error?.message ?? '?')}` : ''}`)
              if (res && res.ok && Array.isArray(res.value)) {
                for (const p of res.value) {
                  const id = str(p?.id ?? p?.provider)
                  if (id && !seen.has(id)) {
                    seen.add(id)
                    providers.push({ id, name: str(p?.name ?? p?.displayName) || id })
                  }
                }
              }
            } catch (error) {
              diag.push(`${label}:throw=${String(error?.message ?? error)}`)
            }
          }
          // 清掉官方 models 页会排除的虚拟账户路由（不是用户配的 provider）。
          const real = providers.filter(p => p.id !== 'deepseek-account')
          try {
            const cat = await session?.modelCatalog?.()
            const gtype = Array.isArray(cat?.value?.groups) ? `groups(${cat.value.groups.length})` : 'none'
            diag.push(`modelCatalog:ok=${cat?.ok === true} ${gtype}`)
            if (cat && cat.ok && Array.isArray(cat.value?.groups)) {
              for (const g of cat.value.groups) {
                for (const m of arr(g?.models)) {
                  const id = str(m?.id ?? m)
                  if (id) models.push({ id, name: str(m?.name) || id, group: str(g?.id) })
                }
              }
            }
          } catch (error) {
            diag.push(`modelCatalog:throw=${String(error?.message ?? error)}`)
          }
          if (alive) setPi(prev => {
            const detailText = diag.join(' | ')
            // 事件重读后内容未变就不换引用 —— 避免无谓重渲染/闪烁。
            const same = prev?.loaded && prev.providers.length === real.length
              && prev.models.length === models.length
              && real.every((p, i) => p.id === prev.providers[i]?.id)
              && models.every((m, i) => m.id === prev.models[i]?.id)
            return same ? prev : { providers: real, models, loaded: true, detail: detailText }
          })
        }
        void load()
        // 实时性（task-103）：用户在设置-模型页新增/删除 provider/model 时，
        // Host 发 llm/adapters-updated / llm/models-updated（asar 实测两者在
        // API_REMOTE_FORWARDED_EVENTS 里，client 可 $on 订阅）。收到即重读三源，
        // 首屏读数/已识别列表、pi 驱动的下拉、免费模型列表全部自动更新。
        // 不新增 namespace、不进 inject（死锁红线），零轮询。
        const offs = []
        try {
          if (typeof remote?.$on === 'function') {
            offs.push(remote.$on('llm/adapters-updated', () => { void load() }))
            offs.push(remote.$on('llm/models-updated', () => { void load() }))
          }
        } catch { /* 订阅不可达 -> 退化为加载时一次读取，不崩 */ }
        return () => {
          alive = false
          for (const off of offs) { try { off?.() } catch {} }
        }
      }, [llm, session, remote])

      // $mount is async; the @Remote namespace may not exist on first render.
      // Re-read ctx.remote.smartProvider on a short delay and on pi settle to
      // trigger a re-render once the mount has installed it. Never fabricate.
      const [costReady, setCostReady] = useState(!!costService)
      useEffect(() => {
        if (costReady) return
        let alive = true
        const check = () => {
          const svc = smartProvider ?? remote?.smartProvider
          if (svc && alive) { setCostReady(true); return true }
          return false
        }
        if (check()) return () => { alive = false }
        const timers = [50, 250, 800, 2000].map(ms => setTimeout(() => {
          if (!alive) return
          if (check()) timers.forEach(clearTimeout)
        }, ms))
        return () => { alive = false; timers.forEach(clearTimeout) }
      }, [costReady, smartProvider])
      const activeCostService = costService ?? (costReady ? (remote?.smartProvider ?? smartProvider) : undefined)

      // No command channel. Data classes:
      //  1. static metadata  -> STATIC_* constants embedded above
      //  2. config values     -> form.getSnapshot() below
      //  3. user's real models -> pi-ai via remote.llm/session (read-only)
      // Never query runtime "on/off"; the UI states only provable facts.
      const settings = injectedSettings ?? remote?.settings
      // 返回 {ok, detail}：detail 把真机失败原因带进 UI，让用户截图一次就能
      // 定位（浏览器 console 不进 DSH 日志，我们手里没有浏览器控制权限）。
      const mutate = useCallback(async (ops, expectedRevision) => {
        const fstat = (() => { try { return `${form?.getSnapshot?.()?.status ?? '?'}/w=${form?.getSnapshot?.()?.writable}` } catch { return '?' } })()
        try {
          if (typeof form?.mutate === 'function') {
            const fence = Number.isFinite(expectedRevision) && expectedRevision > 0 ? expectedRevision : undefined
            const landed = await form.mutate(ops, fence)
            if (landed === true) return { ok: true }
            if (landed && typeof landed === 'object' && landed.ok === true) return { ok: true }
            return { ok: false, detail: `form=${String(landed)} fence=${fence} state=${fstat}` }
          }
        } catch (error) {
          return { ok: false, detail: `throw=${String(error?.message ?? error)} state=${fstat}` }
        }
        // 兜底：form 没有 mutate 时走显式注入的 remote.settings。
        try {
          const res = await settings?.mutate?.(ENTRY, ops, expectedRevision)
          if (res && res.ok) return { ok: true }
          const e = res?.error
          return { ok: false, detail: `settings=${String(e?.code ?? 'no-code')}:${String(e?.message ?? 'no-msg')} st=${fstat}` }
        } catch (error) {
          return { ok: false, detail: `settings-throw=${String(error?.message ?? error)} st=${fstat}` }
        }
      }, [form, settings])

      // One-click preset: writes strategy + its weights and turns ranking on.
      // A beginner clicks "省钱的"/"更快的" and it just works — no numbers.
      const applyPreset = useCallback(async id => {
        const preset = STATIC_STRATEGIES.find(s => str(s?.id) === id)
        if (!preset) return
        const current = obj(config?.ranking)
        const next = {
          ...current,
          enabled: true,
          strategy: id,
          weights: preset.weights ? { ...preset.weights } : { ...DEFAULT_WEIGHTS },
          // 第一层档位读的是 ranking.routing.strategy（lib/routing.js
          // resolveRoutingPolicy，它按 {routing:{strategy}} 解析）；只写
          // ranking.strategy 等于"点了一键预设但档位没变"。保留用户已有的
          // 其它 routing 字段（tierPolicy / positionOverrides / weights…）。
          routing: { ...obj(current.routing), enabled: true, strategy: id },
        }
        setWorking(true); setPresetNotice(null)
        const r = await mutate([{ op: 'set', path: ['ranking'], value: next }], revision)
        setWorking(false)
        const ok = r?.ok === true
        setPresetNotice({ ok, msg: ok ? fmt(t, 'preset.applied', { name: str(preset.label) || id }) : `${t('error.saveFailed')}${r?.detail ? '（' + r.detail + '）' : ''}` })
      }, [config, revision, mutate, t])

      return h('div', { style: S.wrap },
        h('div', { style: S.tabs },
          TABS.map(item => h('button', {
            key: item.id, type: 'button', style: S.tab(tab === item.id),
            onClick: () => requestTab(item.id),
          }, t(item.labelKey))),
        ),
        // 未保存确认条：只有点「切换」才真走，点「留在本页」草稿原样保留。
        pendingTab ? h('div', { style: { ...S.card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', null, t('tab.unsavedGuard')),
          h('button', { type: 'button', style: S.btn, onClick: () => switchTab(pendingTab) }, t('tab.switchAnyway')),
          h('button', { type: 'button', style: S.primary, onClick: () => setPendingTab(null) }, t('tab.stayHere')),
        ) : null,
        // 总览把预设反馈画在按钮下方（首屏就近可见），其它 Tab 仍走顶部提示行。
        presetNotice && tab !== 'overview' ? h('div', { style: presetNotice.ok ? S.ok : S.err }, presetNotice.msg) : null,
        tab === 'overview' ? h(Overview, {
          t, localConfig: config, pi, availProjection, probeVerdicts, probeEnabled, probeDiag,
          onProbe: runProbe, applyPreset, working, presetNotice, costService: activeCostService,
          onOpenCost: () => requestTab('cost'),
        }) : null,
        // 路由设置 = 先链路卡、后账号/择优卡，两张卡各自的保存按钮与语义不变。
        // 两张卡都上报 dirty，供切 Tab 前的确认条使用。
        tab === 'routing' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h(ChainsTab, { t, form, revision, mutate, config, pi, onDirty: v => reportDirty('chains', v) }),
          h(AccountsTab, { t, config, revision, mutate, applyPreset, working, pi, costService: activeCostService, onDirty: v => reportDirty('accounts', v) }),
        ) : null,
        tab === 'cost' ? h(CostHealthTab, { t, localConfig: config, remote, costService: activeCostService, costDiag: `mountRetries=${costReady ? 'ready' : 'pending'} mount=${mountDiag ?? '?'}` }) : null,
      )
    }

    function SmartSectionIcon({ size, active }) {
      const s = Number.isFinite(size) ? size : 16
      return h('svg', {
        viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)' : 'var(--dsw-alias-label-secondary)' },
      },
        h('path', {
          d: 'M2 5h9M2 5l2.2-2M2 5l2.2 2M14 11H5M14 11l-2.2-2M14 11l-2.2 2',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    const zh = {
      nav: 'Smart 智能路由',
      'tab.overview': '总览', 'tab.routing': '路由设置', 'tab.cost': '花费与健康',
      'action.save': '保存', 'action.saved': '已保存，立即生效（无需重启）', 'action.saveFailed': '保存失败',
      'action.refresh': '刷新', 'action.retry': '重试', 'action.confirmDelete': '确认删除？',
      'card.unsaved': '● 未保存',
      'diag.title': '诊断信息（默认折叠，出错时才展开）',
      'tab.unsavedGuard': '有未保存的修改，仍要切换？',
      'tab.switchAnyway': '切换（丢弃修改）',
      'tab.stayHere': '留在本页',
      'status.registered': '已注册', 'status.yes': '是', 'status.no': '否', 'status.chains': '链路数',
      'status.accounts': '账号数', 'status.cooldowns': '冷却中', 'status.strategyEnabled': '择优配置（用户设置）',
      'status.loading': '正在读取配置…',
      'overview.hint': '设置 → 模型页中的 “Smart Gateway” 即本插件提供的虚拟提供商。',
      'advanced.title': '⚙ 详细设置（想调得更细再点开，都是下拉和按钮，不用写代码）',
      'action.delete': '删除', 'action.addHop': '＋ 添加备用项', 'action.addChain': '＋ 添加一组模型', 'action.addAccount': '＋ 添加一个账号',
      'chains.modelLabel': '这个模型：',
      'field.accountName': '名字：', 'field.accountNamePh': '给它起个名字，如 主账号',
      'field.provider': '服务商：', 'field.credential': '使用哪个 Key：', 'field.credentialDefault': '使用 DSH 已登录的账号（推荐）',
      'field.models': '可用模型：', 'field.tier': '重要程度：',
      'tier.premium': '主要（优先用）', 'tier.standard': '普通', 'tier.backup': '备用（最后用）',
      'ranking.tierHigh': '优先用高级账号', 'ranking.tierLow': '先消耗备用账号',
      'ranking.priorityHard': '严格按顺序（先高级别）', 'ranking.prioritySoft': '只作为同分时参考',
      'hero.configured': '智能路由正在按你的设置选模型',
      'hero.configuredExplain': '已按「{strategy}」方式择优，不行就自动换下一个。',
      'hero.defaultTitle': '智能路由正在使用内置均衡策略',
      'hero.defaultExplain': '你还没选过策略，当前按内置的均衡方式运行：按任务挑候选模型、再在候选里均衡选择。想更省钱或更快，点下面的按钮切换即可。',
      'hero.configuredHint': '这里只显示真实保存的设置；下面的按钮随时可以改。',
      'pi.available': '你在 DSH 里已经配好的模型',
      'pi.availableN': '已识别的模型（{models} 个模型 / {providers} 个提供商）',
      'pi.diagnostics': '诊断信息（自检与探测反馈）',
      'overview.healthLoading': '正在读取账号健康…',
      'overview.healthNoChannel': '读不到账号健康（没有数据通道）—— 点这里去「花费与健康」看诊断',
      'overview.healthLine': '账号 {accounts} 个 · 冷却中 {cooling} 个 —— 点这里查看账号健康',
      'pi.loading': '正在读取你已配置的模型…',
      'pi.empty': '暂时没读到已配置的模型，可在「设置 → 模型」页添加。',
      'pi.providers': '提供商数', 'pi.models': '可用模型数',
      'pi.providerNames': '已识别：{names}',
      'pi.smartTag': 'Smart Gateway（智能路由，非独立模型提供商）',
      'pi.freeModels': '已登记模型（可用性如下，新加的会自动出现）：',
      'pi.maybeFree': '可能免费的模型（宽松收录，宁可多列不漏）：',
      'pi.probeBtn': '手动重探这些模型（已自动探过一次，强制刷新结果）',
      'pi.noMaybeFree': '当前未发现可能免费的模型',
      'pi.otherModels': '其他已登记模型 {n} 个（点开查看）',
      'pi.unavailable': '不可用',
      'pi.availableTag': '可用（已复核）', 'pi.unknownTag': '资费未确认',
      'pi.unreviewed': '未复核',
      'pi.freeModelsHint': '状态来自真实使用记录：有足够成功样本才显示"可用"，其余显示"资费未确认"（不是"不可用"）。无论状态如何都保留在列表里。',
      'pi.otherProvidersHint': 'Trae / Qoder / WorkBuddy 等插件的免费模型与可用性由各自插件管理，这里不标注。',
      'preset.pick': '你想让它怎么选？点一下就好（随时可改）',
      'preset.balanced': '⚖ 平衡（推荐）', 'preset.balancedSub': '省心又省钱，大多数人选这个',
      'preset.cost': '💰 更省钱', 'preset.costSub': '尽量用便宜的模型',
      'preset.speed': '⚡ 更快', 'preset.speedSub': '优先用响应快的模型',
      'preset.applying': '正在保存你的选择…',
      'preset.applied': '已切换为「{name}」，立即生效',
      'chains.cardTitle': '链路（模型的备用顺序）',
      'chains.emptyHint': '还没有配置链路，正在使用自动发现（下面显示的是内置默认顺序，编辑后保存即成为你的配置）。',
      'chains.plainTitle': '模型的备用顺序',
      'chains.plainExplain': '智能路由会按下面的顺序尝试：从上到下，不行就自动换下一个。这些都是你已经在 DSH 里配置好的模型，不用另外设置。',
      'chains.forModel': '当你选择「{model}」时：',
      'chains.step': '{name}',
      'accounts.cardTitle': '账号池 + 择优',
      'accounts.countError': '读取账号数失败：{reason}',
      'accounts.addGuide': '点下面的「＋ 添加一个账号」手动加一个。',
      'accounts.plainTitle': '账号（一般不用管）',
      'accounts.plainExplain': '会自动使用你已经在 DSH 里配置好的 API Key（比如 OpenCode Go、小米等），你不用在这里填任何密钥。',
      'accounts.plainCount': '当前有 {n} 个账号（DSH 已配置的路由 + 路由链自动派生）。',
      'accounts.countLoading': '正在读取账号池…',
      'accounts.countEmpty': '尚未在 DSH 中配置任何 API Key，请先在 DSH 设置里添加。',
      'chains.hint': '每个键是一个外层模型，值是按顺序尝试的 {provider, model} 数组。保存后热更新生效。',
      'chains.defaultHint': '当前显示内置默认链（你还没配置 chains）。编辑后点保存即写入你的配置并生效。',
      'chains.empty': '尚无链路配置（使用内置默认链）。',
      'chains.errNoModel': '第 {n} 组还没选模型，保存已取消。',
      'chains.errNoHop': '第 {n} 组还没有任何一步（服务商 / 模型），保存已取消。',
      'chains.errEmptyHop': '第 {n} 组第 {step} 步还没选全服务商 / 模型，保存已取消。',
      'chains.errBlocked': '有 {n} 组链路没填完整（见下方红字），这次没有保存；补齐后再点保存。',
      'accounts.title': '账号池', 'accounts.hint': '密钥只存引用名（credentialRef），不在此显示明文。',
      'accounts.templateHint': '你还没配置账号池，系统会自动使用你在 DSH 里登录的账号直连。想加账号？点下面的"添加一个账号"，从下拉里选就行。',
      'accounts.empty': '尚无账号配置。', 'accounts.raw': '账号 JSON（高级）',
      'accounts.errNoProvider': '账号「{name}」还没选服务商，保存已取消。',
      'accounts.errNoName': '第 {n} 个账号还没填名字，保存已取消（不想加就点删除）。',
      'accounts.errBlocked': '有 {n} 个账号没填完整（见下方红字），这次没有保存；补齐后再点保存。',
      'ranking.title': '分级择优（详细）', 'ranking.enabled': '启用智能选择',
      'ranking.enabledHelp': '不勾选 = 关闭；从未设置时默认开启（勾选态即 Host 的默认值）。关闭后完全保持旧行为：route 优先 + 最少使用。',
      'ranking.strategy': '策略预设', 'ranking.w.cost': '成本', 'ranking.w.speed': '速度',
      'ranking.w.tier': '等级', 'ranking.w.load': '负载',
      'ranking.tierDirection': '等级方向', 'ranking.tierDirectionHelp': 'high=高等级先用；low=先消耗备份额度。',
      'ranking.respectHopRoute': '优先走链上路由', 'ranking.priorityMode': '硬优先级模式',
      'ranking.priorityHelp': '注意：priority 数字越小越优先，与等级（tier 越高越优先）方向相反。',
      'ranking.probeEnabled': '新模型自动探测（默认开启）', 'ranking.probeEnabledHelp': '默认开启：新模型自动发一次极小请求判断是否免费（免费0成本，付费≤1 token，结果缓存7天不重复花钱）。不需要可关掉。',
      'routing.title': '智能路由（两层）', 'routing.intro': '这里保存你对智能路由的设置。保存后立即生效，无需重启。',
      'routing.enabled': '启用两层智能路由', 'routing.enabledHelp': '不勾选 = 关闭；从未设置时默认开启（勾选态即 Host 的默认值）。各策略中立等权、不偏向省钱或速度。',
      'routing.strategy': '选哪种路由风格',
      'routing.position': '模型定位', 'routing.positionHelp': '这是只读说明，不是可编辑的表格。',
      'routing.positionExplain': '每台模型的定位由自身能力自动推导（如是否支持推理、图片、长上下文）；个别模型可另外手填。当前页面不读取逐台模型的定位结果。',
      'routing.rulesTitle': '任务怎么识别（只读）',
      'cost.title': '花费与健康',
      'cost.plainExplain': '这里显示智能路由的累计花费。花费数据由后台记账，设置页只显示它拿到的真实数字，不会编造。',
      'cost.estimated': '累计估算成本 (USD)', 'cost.records': '成本记录数',
      'cost.freePaid': '成功调用', 'cost.freePaidValue': '免费 {free} 次 · 付费 {paid} 次',
      'cost.noChannel': '当前设置页还没有拿到成本数据通道，暂时无法显示真实花费（后台可能已有记录）。下面诊断信息可帮助定位。',
      'cost.detailLoading': '正在读取明细…',
      'cost.detailTitle': '逐笔调用明细（共 {n} 笔，最近的在前）',
      'cost.detailEmpty': '暂无明细数据',
      'cost.overviewTitle': '概览', 'cost.savings': '节省金额',
      'cost.loading': '正在读取花费…', 'cost.loadFailed': '读取花费失败：{reason}',
      'cost.detailBlock': '详细数据（逐笔明细 / 趋势 / 按模型 / 节省账本，共 {n} 条记录）',
      'cost.detailNone': '还没有调用记录',
      'cost.detailFailed': '读取明细失败：{reason}',
      'cost.col.ttft': '首字(ms)', 'cost.col.tps': '速度(tok/s)',
      'cost.col.time': '时间', 'cost.col.model': '模型', 'cost.col.tokens': '输入+输出',
      'cost.col.cost': '成本', 'cost.col.status': '结果',
      'cost.ok': '成功', 'cost.failed': '失败',
      'cost.prevPage': '上一页', 'cost.nextPage': '下一页',
      'cost.timelineTitle': '时间趋势（按天，柱高=调用次数）',
      'cost.byModelTitle': '按模型分组（调用次数 + 累计成本）',
      'cost.byModelValue': '{calls} 次 · ${cost}',
      'cost.savingsTitle': '节省账本（估算）',
      'cost.savingsNotice': '估算 · 基于同类模型公开价或账单单价推算，非账单；无可比价时如实显示"无可比价"，绝不填 0。',
      'cost.savingsModel': '{model} 免费调用若按付费价',
      'cost.savingsValue': '约 {usd}（估算）',
      'cost.noComparable': '无可比价',
      'health.title': '账号健康 / 冷却', 'health.id': '账号', 'health.provider': '路由',
      'health.health': '健康', 'health.coolReason': '冷却原因', 'health.usage': '尝试次数',
      'health.ok': '健康', 'health.cooling': '冷却中', 'health.empty': '暂无数据。',
      'health.plainExplain': '数据来自后台实时注册表：只用真实发生过的情况说话。没有样本的一律显示「暂无数据」，不会显示成「不可用」，也不会假装它是健康的。',
      'health.loading': '正在读取账号健康…',
      'health.noChannel': '当前设置页还没拿到账号健康数据通道，暂时无法显示真实状态（后台可能已有记录）。下面的诊断信息可帮助定位。',
      'health.disabledExplain': '健康层当前是关闭的：配置里 health:false、health.enabled:false 或 ranking.health.enabled:false 任意一处关掉都会停用。关闭期间不做健康判断，这里如实说明，不会假装一切正常。',
      'health.state': '状态', 'health.stateUnknown': '暂无数据', 'health.stateActive': '健康',
      'health.stateCooling': '冷却中', 'health.stateHalfOpen': '半开待验证',
      'health.coolRemain': '剩余冷却', 'health.streak': '连续失败', 'health.samples': '成功 / 失败',
      'health.implicit': '（自动派生）', 'health.model': '模型', 'health.tier': '计费档',
      'health.confidence': '可信度', 'health.routesTitle': '各模型路由健康',
      'health.accountsTitle': '账号池状态',
      'health.snapshotAt': '快照时间 {time}', 'health.refresh': '重新读取',
      'health.refreshing': '读取中…', 'health.noSamples': '暂无样本',
      'health.confHigh': '高', 'health.confMedium': '中', 'health.confLow': '低', 'health.confUnknown': '未知',
      'health.diag': '诊断：',
      'health.lastSeen': '最近成功 {ok} · 最近失败 {fail}', 'health.never': '无',
      'health.soon': '即将到期',
      'health.durationHour': '{h} 小时 {m} 分', 'health.durationMinute': '{m} 分 {s} 秒',
      'health.durationSecond': '{s} 秒',
      'health.tierFree': '免费', 'health.tierMetered': '计费', 'health.tierUnknown': '未知',
      'health.healthHealthy': '健康', 'health.healthDegraded': '降级',
      'health.healthDeprecated': '已弃用', 'health.healthUnknown': '暂无数据',
      'error.jsonObject': '请输入合法的 JSON 对象。', 'error.jsonArray': '请输入合法的 JSON 数组。',
      'error.saveFailed': '保存失败，请重试。',
    }
    const en = {
      nav: 'Smart provider',
      'tab.overview': 'Overview', 'tab.routing': 'Routing', 'tab.cost': 'Cost & health',
      'action.save': 'Save', 'action.saved': 'Saved — live without restart', 'action.saveFailed': 'Save failed',
      'action.refresh': 'Refresh', 'action.retry': 'Retry', 'action.confirmDelete': 'Confirm delete?',
      'card.unsaved': '● Unsaved',
      'diag.title': 'Diagnostics (collapsed unless something failed)',
      'tab.unsavedGuard': 'You have unsaved changes — switch anyway?',
      'tab.switchAnyway': 'Switch (discard changes)',
      'tab.stayHere': 'Stay on this page',
      'status.registered': 'Registered', 'status.yes': 'Yes', 'status.no': 'No', 'status.chains': 'Chains',
      'status.accounts': 'Accounts', 'status.cooldowns': 'Cooling down', 'status.strategyEnabled': 'Ranking config (user setting)',
      'status.loading': 'Loading configuration…',
      'overview.hint': 'The “Smart Gateway” row on Settings → Models is the virtual provider from this plugin.',
      'advanced.title': '⚙ Details (fine-tune here — all dropdowns and buttons, no code)',
      'action.delete': 'Remove', 'action.addHop': '+ Add fallback', 'action.addChain': '+ Add a model group', 'action.addAccount': '+ Add an account',
      'chains.modelLabel': 'This model:',
      'field.accountName': 'Name:', 'field.accountNamePh': 'Give it a name, e.g. Main',
      'field.provider': 'Provider:', 'field.credential': 'Which key to use:', 'field.credentialDefault': 'Use DSH signed-in account (recommended)',
      'field.models': 'Available models:', 'field.tier': 'Importance:',
      'tier.premium': 'Primary (use first)', 'tier.standard': 'Standard', 'tier.backup': 'Backup (use last)',
      'ranking.tierHigh': 'Prefer higher-tier accounts', 'ranking.tierLow': 'Burn backups first',
      'ranking.priorityHard': 'Strict order (higher tier first)', 'ranking.prioritySoft': 'Only as a tie-breaker',
      'hero.configured': 'Smart routing is using your saved setting',
      'hero.configuredExplain': 'Picking with the "{strategy}" style — switching automatically if a model fails.',
      'hero.defaultTitle': 'Smart routing uses the built-in balanced default',
      'hero.defaultExplain': 'You have not chosen a strategy yet, so the built-in balanced default applies: pick candidate models by task, then balance within them. Tap a button to switch.',
      'hero.configuredHint': 'Only your real saved settings are shown here; the buttons below can change them anytime.',
      'pi.available': 'Models you already configured in DSH',
      'pi.availableN': 'Models recognised ({models} models / {providers} providers)',
      'pi.diagnostics': 'Diagnostics (self-check and probe feedback)',
      'overview.healthLoading': 'Reading account health…',
      'overview.healthNoChannel': 'Account health unavailable (no data channel) — open Cost & health for diagnostics',
      'overview.healthLine': '{accounts} accounts · {cooling} cooling down — open account health',
      'pi.loading': 'Reading your configured models…',
      'pi.empty': 'No configured models found yet — add one on Settings → Models.',
      'pi.providers': 'Providers', 'pi.models': 'Available models',
      'pi.providerNames': 'Found: {names}',
      'pi.smartTag': 'Smart Gateway (smart routing, not a standalone model provider)',
      'pi.freeModels': 'Registered models (availability below; newly added appear automatically):',
      'pi.maybeFree': 'Possibly free models (broad match — better to over-list than miss):',
      'pi.probeBtn': 'Re-probe these models (auto-checked once; force refresh)',
      'pi.noMaybeFree': 'No possibly-free models found',
      'pi.otherModels': 'Other registered models ({n}) — expand to view',
      'pi.unavailable': 'unavailable',
      'pi.availableTag': 'available (verified)', 'pi.unknownTag': 'billing unconfirmed',
      'pi.unreviewed': 'unreviewed',
      'pi.freeModelsHint': 'Status comes from real usage: "available" only with enough success samples; otherwise "billing unconfirmed" (not "unavailable"). All entries stay listed regardless.',
      'pi.otherProvidersHint': 'Free models and availability from Trae / Qoder / WorkBuddy and other plugins are managed by those plugins, not marked here.',
      'preset.pick': 'How should it choose? Tap one (change anytime)',
      'preset.balanced': '⚖ Balanced (recommended)', 'preset.balancedSub': 'Reliable and thrifty — good for most people',
      'preset.cost': '💰 Save money', 'preset.costSub': 'Prefer the cheapest models',
      'preset.speed': '⚡ Be fast', 'preset.speedSub': 'Prefer the quickest models',
      'preset.applying': 'Saving your choice…',
      'preset.applied': 'Switched to "{name}" — live now',
      'chains.cardTitle': 'Chains (model fallback order)',
      'chains.emptyHint': 'No chains configured yet — automatic discovery is in use (what you see below is the built-in default order; edit and save to make it yours).',
      'chains.plainTitle': 'Model fallback order',
      'chains.plainExplain': 'Smart routing tries these in order: top to bottom, switching automatically if one fails. These are models you already configured in DSH — nothing extra to set.',
      'chains.forModel': 'When you pick "{model}":',
      'chains.step': '{name}',
      'accounts.cardTitle': 'Accounts + ranking',
      'accounts.countError': 'Could not read the account count: {reason}',
      'accounts.addGuide': 'Use “+ Add an account” below to add one manually.',
      'accounts.plainTitle': 'Accounts (usually nothing to do)',
      'accounts.plainExplain': 'It automatically uses the API keys you already configured in DSH (e.g. OpenCode Go, Xiaomi). You don\'t need to enter any key here.',
      'accounts.plainCount': '{n} account(s) in the live pool (DSH-configured routes + chain-derived accounts).',
      'accounts.countLoading': 'Reading the account pool…',
      'accounts.countEmpty': 'No API keys configured in DSH yet — add one in DSH settings first.',
      'chains.hint': 'Each key is an outer model; value is an ordered {provider, model} array. Changes apply live.',
      'chains.defaultHint': 'Built-in default chain shown (no chains configured). Edit and save to write your own.',
      'chains.empty': 'No chain config (using built-in defaults).',
      'chains.errNoModel': 'Model #{n} has no model selected — save cancelled.',
      'chains.errNoHop': 'Model #{n} has no step (provider / model) yet — save cancelled.',
      'chains.errEmptyHop': 'Model #{n} step {step} is missing a provider or model — save cancelled.',
      'chains.errBlocked': '{n} chain(s) are incomplete (see the red notes) — nothing was saved. Fix them and save again.',
      'accounts.title': 'Account pool', 'accounts.hint': 'Secrets stay as references (credentialRef); no plaintext is shown.',
      'accounts.templateHint': 'No account pool configured — the system uses your signed-in DSH accounts directly. To add one, tap "Add an account" and choose from the dropdown.',
      'accounts.empty': 'No accounts configured.', 'accounts.raw': 'Accounts JSON (advanced)',
      'accounts.errNoProvider': 'Account "{name}" has no provider selected — save cancelled.',
      'accounts.errNoName': 'Account #{n} has no name — save cancelled (delete the row if you do not want it).',
      'accounts.errBlocked': '{n} account(s) are incomplete (see the red notes) — nothing was saved. Fix them and save again.',
      'ranking.title': 'Ranking', 'ranking.enabled': 'Enable ranking',
      'ranking.enabledHelp': 'Unchecked = off; when never set it is ON by default (the checked state mirrors the Host default). Off keeps legacy behavior: route-first then least-used.',
      'ranking.strategy': 'Strategy', 'ranking.w.cost': 'Cost', 'ranking.w.speed': 'Speed',
      'ranking.w.tier': 'Tier', 'ranking.w.load': 'Load',
      'ranking.tierDirection': 'Tier direction', 'ranking.tierDirectionHelp': 'high = premium first; low = burn backups first.',
      'ranking.respectHopRoute': 'Prefer hop route', 'ranking.priorityMode': 'Priority mode',
      'ranking.priorityHelp': 'Note: lower priority number wins — opposite to tier (higher wins).',
      'ranking.probeEnabled': 'Auto-probe new models (on by default)', 'ranking.probeEnabledHelp': 'On by default: new models get one tiny request to detect if free (free=0 cost, paid ≤1 token, cached 7 days). Turn off to opt out.',
      'routing.title': 'Two-layer smart routing', 'routing.intro': 'These are your saved routing settings. Saving applies them live — no restart.',
      'routing.enabled': 'Enable two-layer routing', 'routing.enabledHelp': 'Unchecked = off; when never set it is ON by default (the checked state mirrors the Host default). Strategies are neutral and equal-weight — no bias toward cost or speed.',
      'routing.strategy': 'Routing style',
      'routing.position': 'Model position', 'routing.positionHelp': 'Read-only explanation, not an editable table.',
      'routing.positionExplain': 'Each model position is derived from its own capabilities (reasoning, vision, long context); some can be declared manually. This page does not read per-model derived results.',
      'routing.rulesTitle': 'How tasks are recognized (read-only)',
      'cost.title': 'Cost & health',
      'cost.plainExplain': 'Accumulated smart-routing cost is shown here. The settings page shows only real numbers from the Host ledger — never invented ones.',
      'cost.estimated': 'Estimated cost (USD)', 'cost.records': 'Cost records',
      'cost.freePaid': 'Successful calls', 'cost.freePaidValue': 'Free {free} · Paid {paid}',
      'cost.noChannel': 'The settings page has no cost-data channel yet, so real spending cannot be shown (the Host may already have records). Diagnostics below help locate it.',
      'cost.detailLoading': 'Loading detail…',
      'cost.detailTitle': 'Per-call detail ({n} records, newest first)',
      'cost.detailEmpty': 'No detail data',
      'cost.overviewTitle': 'Overview', 'cost.savings': 'Savings',
      'cost.loading': 'Reading spend…', 'cost.loadFailed': 'Could not read spend: {reason}',
      'cost.detailBlock': 'Detailed data (per-call rows / trend / by model / savings ledger — {n} records)',
      'cost.detailNone': 'No calls recorded yet',
      'cost.detailFailed': 'Could not read detail rows: {reason}',
      'cost.col.ttft': 'TTFT (ms)', 'cost.col.tps': 'Speed (tok/s)',
      'cost.col.time': 'Time', 'cost.col.model': 'Model', 'cost.col.tokens': 'In+Out',
      'cost.col.cost': 'Cost', 'cost.col.status': 'Result',
      'cost.ok': 'OK', 'cost.failed': 'Failed',
      'cost.prevPage': 'Prev', 'cost.nextPage': 'Next',
      'cost.timelineTitle': 'Timeline (per day, bar height = calls)',
      'cost.byModelTitle': 'By model (calls + cumulative cost)',
      'cost.byModelValue': '{calls} calls · ${cost}',
      'cost.savingsTitle': 'Savings ledger (estimate)',
      'cost.savingsNotice': 'Estimate only — derived from comparable public prices or paid rows, not a bill. When no comparable price exists it says "no comparable price" instead of inventing 0.',
      'cost.savingsModel': '{model} free calls at paid price',
      'cost.savingsValue': '~{usd} (estimated)',
      'cost.noComparable': 'No comparable price',
      'health.title': 'Account health / cooldown', 'health.id': 'Account', 'health.provider': 'Route',
      'health.health': 'Health', 'health.coolReason': 'Cool reason', 'health.usage': 'Attempts',
      'health.ok': 'Healthy', 'health.cooling': 'Cooling', 'health.empty': 'No data yet.',
      'health.plainExplain': 'Data comes from the Host live registry and speaks only from real observations. Anything with zero samples reads "No data yet" — never "unavailable", and never a fake green.',
      'health.loading': 'Reading account health…',
      'health.noChannel': 'The settings page has no account-health channel yet, so real state cannot be shown (the Host may already have records). Diagnostics below help locate it.',
      'health.disabledExplain': 'The health layer is switched off: any one of health:false, health.enabled:false or ranking.health.enabled:false disables it. While off, no health judgement is made — stated plainly here instead of pretending everything is fine.',
      'health.state': 'State', 'health.stateUnknown': 'No data yet', 'health.stateActive': 'Healthy',
      'health.stateCooling': 'Cooling down', 'health.stateHalfOpen': 'Half-open, awaiting check',
      'health.coolRemain': 'Cooldown left', 'health.streak': 'Fail streak', 'health.samples': 'Success / failure',
      'health.implicit': '(auto-derived)', 'health.model': 'Model', 'health.tier': 'Billing tier',
      'health.confidence': 'Confidence', 'health.routesTitle': 'Per-model route health',
      'health.accountsTitle': 'Account pool state',
      'health.snapshotAt': 'Snapshot {time}', 'health.refresh': 'Read again',
      'health.refreshing': 'Reading…', 'health.noSamples': 'No samples yet',
      'health.confHigh': 'High', 'health.confMedium': 'Medium', 'health.confLow': 'Low', 'health.confUnknown': 'Unknown',
      'health.diag': 'Diagnostics:',
      'health.lastSeen': 'Last success {ok} · last failure {fail}', 'health.never': 'none',
      'health.soon': 'expiring soon',
      'health.durationHour': '{h} h {m} min', 'health.durationMinute': '{m} min {s} s',
      'health.durationSecond': '{s} s',
      'health.tierFree': 'Free', 'health.tierMetered': 'Metered', 'health.tierUnknown': 'Unknown',
      'health.healthHealthy': 'Healthy', 'health.healthDegraded': 'Degraded',
      'health.healthDeprecated': 'Deprecated', 'health.healthUnknown': 'No data yet',
      'error.jsonObject': 'Enter a valid JSON object.', 'error.jsonArray': 'Enter a valid JSON array.',
      'error.saveFailed': 'Save failed, please retry.',
    }

    return {
      // 组件级 inject 列出 Host 提供的 remote.<子服务>（llm/session/settings 等）。
      // 关键边界（task-69 死锁教训）：**本模块自己在 apply() 里 $mount() 产出的
      // namespace 绝不能写进 inject**——框架在 apply() 前等 inject 全部就绪，
      // 而该服务只能由被卡住的 apply() 创建 ⇒ 等待死锁 ⇒ 插件 pending、侧栏消失。
      // remote.smartProvider 正是本模块 $mount 产出的，故只能软探测（ctx.get），
      // 不能进 inject。官方 qoder 客户端亦有同样的中文警示。
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.llm', 'remote.session', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'smart-provider: client locale')

        // Mount the typed @Remote contribution so `remote.smartProvider.cost()`
        // becomes callable. Unmount on dispose (cotTranslation pattern).
        ctx.effect(() => {
          let unmount
          let cancelled = false
          if (typeof ctx.remote?.$mount !== 'function') {
            mountDiag = 'no-$mount'
          } else {
            mountDiag = 'mounting'
            Promise.resolve(ctx.remote.$mount(makeCostContribution())).then(off => {
              if (cancelled) { Promise.resolve(off?.()).catch(() => {}) }
              else { unmount = off; mountDiag = 'mounted' }
            }).catch(error => {
              // 把 $mount 的真实 reject 原因带进成本页诊断；不再静默吞掉。
              mountDiag = `mount-fail:${String(error?.message ?? error)}`
            })
          }
          return () => { cancelled = true; Promise.resolve(unmount?.()).catch(() => {}) }
        }, 'smart-provider: remote cost')

        const bound = ctx.locale.bind(NS)
        const t = key => {
          try { return bound(key) } catch { return key }
        }

        const injected = () => {
          let form
          try { form = ctx.configForms.get(ENTRY) } catch { form = undefined }
          // 显式透传子服务：即便 slot 框架只把 inject() 返回值交给组件，
          // llm/session 也一定在手（真机上一版只靠 ctx.remote 传递拿不到）。
          return {
            form,
            remote: ctx.remote,
            llm: ctx.remote?.llm,
            session: ctx.remote?.session,
            settings: ctx.remote?.settings,
            // 软探测本模块 $mount 产出的 namespace：绝不能进 inject（死锁），
            // 只在每次 inject() 调用时同步查找已挂载的服务，拿不到就是 undefined。
            smartProvider: (() => {
              try { return ctx.get?.('remote.smartProvider') ?? ctx.smartProvider ?? ctx.remote?.smartProvider } catch { return undefined }
            })(),
            costService: (() => {
              try { return ctx.get?.('remote.smartProvider') ?? ctx.remote?.smartProvider } catch { return undefined }
            })(),
            mountDiag,
            t,
          }
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'smart-provider', order: 20,
          label: () => t('nav'), locale: NS, inject: injected,
        }, SmartSettingsSection))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'smart-provider', locale: NS,
        }, SmartSectionIcon))
      },
    }
  },
})

// >>> custom-routes:candidates >>>
const CUSTOM_PROVIDERS = ["x-opencode-free"];
const CUSTOM_MODELS = ["hy4-flash-free","hy4flash-free","hy4-flash-free-trial-202611","web-search-free","cat-jam-free","longcat-2.5-preview-free","step-5-preview-free"];
// BEGIN free-model availability (generated — task-77)
// hy4-flash-free: available — upstream /models 200 + chat 200 content=2; E2E 3473 cost=0
// hy4flash-free: available — workbuddy/hy4flash-free: host log request.complete/completed x140 and rising (2026-11-24); ledger does not record workbuddy route; opencode chat 400 was single-context only
// hy4-flash-free-trial-202611: unavailable — promotion badge id (not a model); opencode chat 400 only; no success in ledger or host logs (no other provider found)
// web-search-free: unavailable — top-level dsh-free-search plugin, not an LLM; opencode chat 400 only; no success in ledger or host logs
// cat-jam-free: unavailable — 2026-11-24 opencode chat probe 400 only; no success in ledger or host logs (other providers not observed)
// longcat-2.5-preview-free: unavailable — 2026-11-24 opencode chat probe 400 only (historical deprecated); no success in ledger or host logs (other providers not observed)
// step-5-preview-free: unavailable — 2026-11-24 opencode chat probe 400 only; no success in ledger or host logs (other providers not observed)
// END free-model availability
// <<< custom-routes:candidates <<<
