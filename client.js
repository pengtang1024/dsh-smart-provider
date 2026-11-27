/**
 * dsh-smart-provider — Web Client settings section.
 *
 * Registers a `settings.section` ("Smart 智能路由") with three tabs:
 * overview / routing (chains + accounts+ranking as two cards) / cost+health.
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
    const { useState, useEffect, useCallback, useRef, useReducer } = React

    const NS = 'settings.smart-provider'
    const ENTRY = 'smart-provider'
    // 与 package.json 的 version 保持同步（浏览器模块无法 require package.json，
    // 故按本项目 STATIC_* 惯例内联）。改版本时两处都要更新。
    const PLUGIN_VERSION = '2.7.0'

    // Generated custom-route candidate lists must live inside the factory:
    // HMR re-evaluates the module, so top-level consts here would throw
    // "Identifier 'CUSTOM_PROVIDERS' has already been declared" and take the
    // whole settings/pill namespace down. The marker-delimited block below is
    // the generator's canonical slot (see scripts/gen-custom-routes.mjs).
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

    // ---- NF3: free-signal weak-signal contract (inline mirror of lib/free-policy.js) --------
    // Browser modules cannot import lib/, so this mirror must stay in lockstep with
    // the Host policy. Rule version is shared verbatim; free-verify (task-26)
    // compares FREE_POLICY_VECTORS + this function against the Host copy.
    const FREE_SIGNAL_RULE_VERSION = 'free-signal-v1'
    // Vectors mirror lib/free-policy.js FREE_POLICY_VECTORS verbatim; free-verify
    // (task-26) compares the two exports. Only {name,input,expected:{free,level}}
    // is checked — evidence/source wording may differ between Host and client.
    const FREE_POLICY_VECTORS = Object.freeze([
      { name: 'name-free', input: { provider: 'x-opencode-free', model: 'hy4-flash-free' }, expected: { free: true, level: 'weak' } },
      { name: 'multiplier-zero', input: { model: 'm', multiplier: 0 }, expected: { free: true, level: 'declared' } },
      { name: 'price-multiplier-zero-alias', input: { model: 'm', priceMultiplier: 0 }, expected: { free: true, level: 'declared' } },
      { name: 'multiplier-string-zero', input: { model: 'm', multiplier: '0' }, expected: { free: false, level: 'none' } },
      { name: 'multiplier-null', input: { model: 'm', multiplier: null }, expected: { free: false, level: 'none' } },
      { name: 'multiplier-missing', input: { model: 'm' }, expected: { free: false, level: 'none' } },
      { name: 'multiplier-negative', input: { model: 'm', multiplier: -1 }, expected: { free: false, level: 'none' } },
      { name: 'cost-model-free', input: { model: 'm', costModel: 'free' }, expected: { free: true, level: 'declared' } },
      { name: 'probe-free', input: { model: 'm', probeVerdict: 'free' }, expected: { free: true, level: 'measured' } },
      { name: 'probe-metered', input: { model: 'm', probeVerdict: 'metered', name: 'free-model', multiplier: 0 }, expected: { free: false, level: 'none' } },
      { name: 'probe-unknown-name-free', input: { model: 'hy4flash-free', probeVerdict: 'unknown' }, expected: { free: true, level: 'weak' } },
      { name: 'probe-unknown-multiplier-zero', input: { model: 'm', probeVerdict: 'unknown', multiplier: 0 }, expected: { free: true, level: 'declared' } },
      { name: 'real-zero-price', input: { model: 'm', price: { known: true, estimated: false, input: 0, output: 0 } }, expected: { free: true, level: 'measured' } },
      { name: 'real-positive-price', input: { model: 'free-model', price: { known: true, estimated: false, input: 1e-6, output: 2e-6 } }, expected: { free: false, level: 'none' } },
      { name: 'estimated-zero-price-not-free', input: { model: 'm', price: { known: false, estimated: true, input: 0, output: 0, priceTier: 'free' } }, expected: { free: false, level: 'none' } },
      { name: 'ledger-positive-cost', input: { model: 'free-model', billing: { costUsd: 0.01 } }, expected: { free: false, level: 'none' } },
      { name: 'ledger-paid-source', input: { model: 'free-model', billing: { billingSource: 'subscription-credit' } }, expected: { free: false, level: 'none' } },
      { name: 'ledger-free-source', input: { model: 'm', billing: { billingSource: 'free-allowance' } }, expected: { free: true, level: 'measured' } },
      { name: 'no-price-weak-signal', input: { model: 'm', name: 'free-tier' }, expected: { free: true, level: 'weak' } },
      { name: 'flash-not-free', input: { model: 'deepseek-v4-flash', provider: 'opencode-go' }, expected: { free: false, level: 'none' } },
      { name: 'price-tier-free-weak', input: { model: 'm', priceTier: 'free' }, expected: { free: true, level: 'weak' } },
      { name: 'uppercase-free', input: { provider: 'OPENCODE-GO', model: 'Beam-FREE' }, expected: { free: true, level: 'weak' } },
      { name: 'group-free', input: { model: 'm', group: 'Free-Tier' }, expected: { free: true, level: 'weak' } },
      { name: 'empty-input', input: {}, expected: { free: false, level: 'none' } },
    ])
    // Pure classifier — identical decision tree to lib/free-policy.js.
    // Tier ladder: measured > declared > weak > none. An unknown/absent probe
    // never blocks weak signals; hard paid evidence always wins.
    const freeSignal = input => {
      const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
      const verdict = typeof i.probeVerdict === 'string' ? i.probeVerdict : ''
      const b = obj(i.billing)
      const price = obj(i.price)
      const rawMultiplier = i.multiplier === undefined ? i.priceMultiplier : i.multiplier
      const multiplierZero = typeof rawMultiplier === 'number'
        && Number.isFinite(rawMultiplier) && rawMultiplier === 0
      const costModelFree = typeof i.costModel === 'string' && i.costModel.toLowerCase() === 'free'
      const realPrice = price.known === true && price.estimated !== true
      const inputPrice = Number(price.input ?? 0)
      const outputPrice = Number(price.output ?? 0)
      const positive = realPrice && ((Number.isFinite(inputPrice) && inputPrice > 0)
        || (Number.isFinite(outputPrice) && outputPrice > 0))
      const zero = realPrice && Number.isFinite(inputPrice) && Number.isFinite(outputPrice)
        && inputPrice === 0 && outputPrice === 0
      const bs = str(b.billingSource)
      const paidBilling = (Number.isFinite(b.cost) && b.cost > 0)
        || (Number.isFinite(b.costUsd) && b.costUsd > 0)
        || (Number.isFinite(b.estimatedCostUsd) && b.estimatedCostUsd > 0)
        || (Number.isFinite(b.meteredSamples) && b.meteredSamples > 0)
        || (Number.isFinite(b.paidCalls) && b.paidCalls > 0)
        || /paid|meter|subscription|credit|go-plus/i.test(bs)
      // 1. Hard paid evidence beats everything (even a measured free verdict).
      if (verdict === 'metered' || paidBilling || positive) {
        return { free: false, level: 'none',
          source: verdict === 'metered' ? 'probe' : positive ? 'price' : 'billing' }
      }
      // 2. Measured free: probe verdict or a real (non-estimated) zero price.
      if (verdict === 'free' || zero) {
        return { free: true, level: 'measured', source: verdict === 'free' ? 'probe' : 'price' }
      }
      // 2b. Upstream free billing source is real but softer than probe/zero price.
      if (/free|trial|bonus|allowance/i.test(bs)) {
        return { free: true, level: 'measured', source: 'billing' }
      }
      // 3. User-declared defaults (NOT measured): multiplier=0 / costModel=free.
      if (multiplierZero || costModelFree) return { free: true, level: 'declared', source: 'declared' }
      // 4. Weak name / tier signals. 'unknown' probe never blocks these.
      if ([i.provider, i.model, i.name, i.group]
        .some(v => typeof v === 'string' && v.toLowerCase().includes('free'))) {
        return { free: true, level: 'weak', source: 'name' }
      }
      if (typeof i.priceTier === 'string' && i.priceTier.toLowerCase() === 'free') {
        return { free: true, level: 'weak', source: 'tier' }
      }
      // 5. Nothing — never claim free.
      return { free: false, level: 'none', source: 'none' }
    }
    // Host projection row may carry a freeSignal tag; strict codec declares it
    // as a nullable three-field object. A missing tag means "no free evidence".
    const freeTagOf = row => {
      const v = row?.freeSignal
      return v && typeof v === 'object' && typeof v.free === 'boolean'
        ? { free: v.free, level: str(v.level), source: str(v.source) }
        : null
    }
    // HB2: availabilityStatus stays keyed by bare modelId (health display), but
    // each row also carries `providers: { [provider]: freeSignal|null }` with one
    // exact (provider, model) tag per provider. This adapts a projection row to
    // the legacy freeTagOf(row) shape by promoting that provider's exact tag to
    // the top-level key. A PUBLISHED map is authoritative: a missing tuple means
    // "no evidence for this provider", never a fallback to row.freeSignal (the
    // strongest tag across ALL providers). Old Profiles without a map keep using
    // the top-level tag unchanged.
    const tupleScope = (projection, id, provider) => {
      const rows = obj(projection)
      const row = rows[id]
      const map = row?.providers
      if (!provider || !map || typeof map !== 'object' || Array.isArray(map)) return rows
      const key = str(provider)
      if (!key) return rows
      // No entry for this tuple → null, so local weak-signal classification runs
      // instead of leaking another provider's measured tag through the aggregate.
      const exact = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
      return { ...rows, [id]: { ...row, freeSignal: exact && typeof exact === 'object' ? exact : null } }
    }

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
    // CF-2: statsSince() returns the SAME summary as cost() plus a canonical
    // `since` instant (ISO string or null when no start marker). Every field
    // the Host returns must be declared here or strict zod strips it on the
    // wire. Missing fields in the degraded catch path still satisfy the codec
    // because they are optional/nullable, matching lib/remote.js verbatim.
    const STATS_SINCE_SCHEMA = (() => {
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
        since: z.string().nullable(),
      })
    })()
    // CF-2: clearStats() writes only the companion stats-state.json; the
    // ledger is never truncated. `ok` says whether the marker was persisted.
    const CLEAR_STATS_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      return z.object({
        ok: z.boolean(),
        since: z.string().nullable(),
      })
    })()
    // statsSince({since?}) accepts an ISO string, epoch ms, or null/absent
    // (absent = read the state marker). Strict codec needed at mount time.
    const STATS_OPTIONS_SCHEMA = (() => {
      let zod
      try { zod = require('zod') } catch { return null }
      if (!zod?.object) return null
      const z = zod.z ?? zod
      return z.object({ since: z.union([z.string(), z.number()]).nullable().optional() })
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
      const freeSignalCodec = z.object({
        free: z.boolean(), level: z.string(), source: z.string(),
      }).nullable()
      return z.record(z.string(), z.object({
        health: z.string(), tier: z.string(), confidence: z.number(),
        // NF3: Host adds a free-signal tag to each projection row. MUST be a
        // required nullable field — strict zod strips undeclared keys, which
        // would silently erase the whole availability projection on the wire.
        freeSignal: freeSignalCodec,
        // HB2: per-(provider,model) tags. Strict codec would strip this map
        // unless declared; optional keeps old Profiles (no map) parseable.
        providers: z.record(z.string(), freeSignalCodec).optional(),
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
    // CF-3: config keys/defaults mirror schema.js (volatile, off by default).
    const COST_PILL_ENABLED_KEY = 'costPillEnabled'
    const COST_PILL_POSITION_KEY = 'costPillPosition'
    const COST_PILL_REFRESH_KEY = 'costPillRefreshMs'
    const COST_PILL_DEFAULT_POSITION = 'conversation.input.right'
    const COST_PILL_REFRESH_DEFAULT_MS = 60000
    const COST_PILL_SLOTS = ['conversation.input.right', 'conversation.session.header.utilities', 'conversation.input.dock']
    const costPillPositionOf = value => {
      const pos = str(value)
      return COST_PILL_SLOTS.includes(pos) ? pos : COST_PILL_DEFAULT_POSITION
    }
    // 0 is an explicit opt-out of auto-refresh; other invalid values fall back
    // to the default. The settings card help text promises this contract.
    const costPillRefreshMsOf = value => {
      const ms = Number(value)
      if (ms === 0) return 0
      return Number.isFinite(ms) && ms >= 1000 ? ms : COST_PILL_REFRESH_DEFAULT_MS
    }
    // Volatile config may be absent before the first describe; only an explicit
    // true enables the pill. An absent/0 refresh interval means no monitoring.
    const costPillEnabledOf = config => obj(config)[COST_PILL_ENABLED_KEY] === true
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
      }, {
        // CF-2: statistics total from an explicit start or the persisted
        // marker. Same strict-codec 三件套 rule as every other descriptor:
        // without mode/typeSymbol/create the WHOLE namespace fails to mount.
        id: '@local/dsh-smart-provider#smartProvider/statsSince',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'statsSince',
        description: 'Read cost summary since a start instant or the saved marker',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'opts', wire: 'opts', description: 'optional {since} (ISO string or epoch ms)', source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@local/dsh-smart-provider/types#StatsSinceOptions',
            create: () => STATS_OPTIONS_SCHEMA ?? { parse: v => v },
          },
        }],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#StatsSinceSummary',
          create: () => STATS_SINCE_SCHEMA ?? { parse: v => v },
          description: 'cost summary plus canonical since instant',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          const opts = input && (input.opts ?? input)
          return receiver.statsSince(opts, signal)
        },
      }, {
        // CF-2: set the statistics start to now. Never deletes cost.jsonl;
        // the Host writes stats-state.json and returns the instant.
        id: '@local/dsh-smart-provider#smartProvider/clearStats',
        service: 'smartProvider',
        namespace: 'smartProvider',
        method: 'clearStats',
        description: 'Start a new statistics window without deleting the ledger',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: '@local/dsh-smart-provider/types#ClearStatsResult',
          create: () => CLEAR_STATS_SCHEMA ?? { parse: v => v },
          description: 'clear acknowledgement with canonical since instant',
        },
        input() { return { create: () => ({ parse: v => v }) } },
        invoke(remote, input, signal) {
          const receiver = remote.smartProvider
          return receiver.clearStats(signal)
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
    // Combined virtual tier ids (smart/<tier>/<effort>) are display-only: the
    // adapter's listModels.name is the authoritative free-text label (Chinese
    // names live there, NOT in t()/locale). This fallback covers early snapshots
    // where only the raw id reached the client, without adding any i18n key.
    const TIER_LABELS = { auto: '智能档', cost: '省钱档', balanced: '平衡档' }
    const EFFORT_LABELS = { off: '关闭', medium: '均衡', high: '高' }
    const tierIdLabel = id => {
      const parts = str(id).split('/')
      if (parts.length !== 2 || !TIER_LABELS[parts[0]] || !EFFORT_LABELS[parts[1]]) return null
      return 'Smart ' + TIER_LABELS[parts[0]] + ' · ' + EFFORT_LABELS[parts[1]] + '强度'
    }
    const modelLabel = id => MODEL_LABELS[str(id)] || tierIdLabel(id) || str(id)

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
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 0, flexWrap: 'wrap' },
      tab: active => ({
        cursor: 'pointer', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
        padding: '8px 14px 10px', marginBottom: -1, fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        boxShadow: active ? 'inset 0 -2px 0 var(--dsw-alias-brand-primary-new-colorprimary-new-color)' : 'none',
      }),
      card: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        padding: 14, background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 1px 2px var(--dsw-alias-bg-mask-2)',
      },
      sectionTitle: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px' },
      summary: { cursor: 'pointer', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', padding: '2px 0', lineHeight: '20px' },
      row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 120 },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: 96 },
      input: {
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        padding: '5px 9px', fontFamily: 'inherit', fontSize: 13, minWidth: 80,
        outlineColor: 'var(--dsw-alias-border-selected)',
      },
      select: { fontFamily: 'inherit', fontSize: 13 },
      btn: {
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        padding: '5px 11px', outlineColor: 'var(--dsw-alias-border-selected)',
      },
      primary: {
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
        color: 'var(--dsw-alias-bg-layer-1)',
        background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)',
        border: '1px solid var(--dsw-alias-border-selected)', borderRadius: 'var(--dsw-radius-sm)', padding: '5px 14px',
        outlineColor: 'var(--dsw-alias-border-selected)',
      },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' },
      code: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, overflowWrap: 'anywhere' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 },
      empty: {
        color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px', textAlign: 'center',
        padding: '10px 12px', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
      },
      unsaved: {
        display: 'inline-block', fontSize: 11, lineHeight: '16px', padding: '1px 8px',
        color: 'var(--dsw-alias-state-warn-label)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: 'var(--dsw-radius-sm)',
      },
      badge: color => ({
        display: 'inline-flex', alignItems: 'center', fontSize: 12, lineHeight: '18px',
        padding: '1px 8px', color, background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        whiteSpace: 'nowrap',
      }),
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '8px', color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', fontWeight: 500 },
      td: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '8px', verticalAlign: 'top' },
      pill: extra => ({
        display: 'inline-block', borderRadius: 'var(--dsw-radius-sm)', padding: '2px 8px', fontSize: 11,
        // UNKNOWN / unreviewed is not an error: neutral badge, never red.
        color: extra ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        background: extra ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid ' + (extra ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'),
      }),
      // CF-3: conversation cost pill — colors are --dsw-alias-* only.
      costPill: {
        bar: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
        dock: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)', padding: '6px 10px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
        label: { color: 'var(--dsw-alias-label-secondary)' },
        amount: { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--ds-font-family-code, monospace)', color: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)', fontWeight: 600 },
        muted: { color: 'var(--dsw-alias-label-tertiary)' },
        err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 },
        btn: (active, danger) => ({
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
          color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
          background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)', padding: '2px 7px',
        }),
      },
      hero: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        padding: '18px 20px', background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: '0 2px 8px var(--dsw-alias-bg-mask-2)',
        display: 'flex', flexDirection: 'column', gap: 8,
      },
      heroTitle: { fontSize: 17, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: '25px' },
      heroText: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '22px' },
      // 静态 star 引导链接：只用既有主题 token，不引入新颜色 / 硬编码颜色。
      starLink: { color: 'var(--dsw-alias-label-tertiary)', textDecoration: 'underline', borderRadius: 'var(--dsw-radius-sm)', marginLeft: 6 },
      choiceBtn: active => ({
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
        padding: '11px 14px', borderRadius: 'var(--dsw-radius-md)', textAlign: 'left',
        border: '1px solid ' + (active ? 'var(--dsw-alias-border-selected)' : 'var(--dsw-alias-border-l2)'),
        color: 'var(--dsw-alias-label-primary)',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-1)',
        boxShadow: active ? 'inset 0 0 0 1px var(--dsw-alias-border-selected)' : 'none',
        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 130,
      }),
      choiceTitle: { fontWeight: 600 },
      choiceSub: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '17px' },
      step: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 13, lineHeight: '20px' },
      stepNum: {
        flex: 'none', width: 22, height: 22, borderRadius: '50%',
        background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l2)',
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
    // Account declarations are a client-side overlay only: the Host owns the
    // real billing evidence, so a declared multiplier/costModel can add a
    // 'declared' free signal but never override probe/ledger hard evidence.
    // Multiple accounts may list the same model id — any one declaring free
    // (multiplier===0 / costModel==='free') wins. Read both the nested ranking
    // field (canonical, lib/ranking.js) and the legacy flat alias.
    const accountDeclaredOf = config => {
      const out = {}
      for (const a of arr(config?.accounts)) {
        const mul = obj(a).ranking?.priceMultiplier ?? a?.priceMultiplier
        const costModel = str(obj(a).costModel ?? a?.costModel)
        for (const model of arr(a?.models)) {
          const id = str(model)
          if (!id) continue
          const prev = obj(out[id])
          out[id] = {
            priceMultiplier: Number.isFinite(mul) ? mul : prev.priceMultiplier,
            costModel: costModel || prev.costModel,
          }
        }
      }
      return out
    }
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
      // 账号声明覆盖层：用户填的 priceMultiplier=0 / costModel=free 必须进入
      // 免费判据；declared 只是弱证据，probe metered / 正成本仍由契约函数否决。
      const declared = accountDeclaredOf(cfg)
      // task-106 "可能免费"宽松判据 —— 宁可多列不可漏，任一弱信号命中即入选。
      // 证据：真实免费模型（账本/registry）名字/id 全含 free（hy4-flash-free /
      // hy4flash-free / web-search-free / cat-jam-free / longcat-2.5-preview-free /
      // step-5-preview-free），付费模型（deepseek-v4.1-flash / glm-5.3-flash）不含。
      // 因此 id/name/group 含 free 为主判据，配合 seed + tier=free 投影。
      // 不会塞满 176：付费模型三项都不含 free、不在 seed、tier 非 free → 不命中。
      const isPossiblyFree = m => {
        const id = str(m?.id ?? m), provider = str(m?.group)
        // NF3: one contract for all three free checks. Host freeSignal tag
        // (measured/declared/weak) wins; otherwise classify locally from the
        // probe verdict + available weak signals. Unknown never blocks weak.
        // Host tuple tag first; legacy top-level tag is the fallback.
        const tagged = freeTagOf(obj(tupleScope(availProjection, id, provider))[id])
        if (tagged && tagged.level !== 'none') return tagged.free
        return freeSignal({
          provider, model: id, name: str(m?.name), group: provider,
          probeVerdict: str(obj(probeVerdicts)[`${provider}/${id}`]),
          priceTier: str(obj(availProjection)[id]?.tier),
          priceMultiplier: obj(declared[id]).priceMultiplier,
          costModel: str(obj(declared[id]).costModel),
        }).free
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
          h('div', { style: { ...S.muted, marginTop: 2 } },
            `v${PLUGIN_VERSION} · `,
            h('a', {
              href: 'https://github.com/pengtang1024/dsh-smart-provider',
              target: '_blank', rel: 'noopener noreferrer',
              style: { ...S.muted, textDecoration: 'none' },
            }, '⭐ ' + t('star.link')),
          ),
          // 事实与健康摘要并入同一张 hero：一行配置事实 + 一行可点击健康摘要，
          // 不再让 KV 卡与提示行卡各占一屏。数字仍只来自 configForms/真实快照。
          h('div', { style: { ...S.heroText, marginTop: 2 } },
            fmt(t, 'overview.factLine', { chains: Object.keys(chains).length, accounts, strategy: rankingOn ? strategyName : t('status.builtinDefault') }),
          ),
          h('button', {
            type: 'button', onClick: () => onOpenCost?.(),
            style: { ...S.muted, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', padding: 0, border: 'none', background: 'none' },
          }, `${healthText} ›`),
        ),
        // ② 首屏主操作：先让用户"选择怎么选"，紧贴状态条，不再被模型大卡挡在下面。
        h('div', { style: S.card },
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('preset.pick')),
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
        // 已识别模型：计数摘要 + 展开。首屏只有数量与可见的探测按钮，
        //    pill 墙、长说明与诊断都收进 details（信息不丢，但不占首屏）。
        h('details', { style: S.card },
          h('summary', { style: S.summary },
            piLoaded
              ? fmt(t, 'pi.availableN', { models: modelCount, providers: providerCount })
              : t('pi.available'),
            fmt(t, 'pi.freeCount', { n: maybeFreeModels.length }),
            probeEnabled && maybeFreeModels.length > 0
              ? h('button', {
                type: 'button', style: { ...S.btn },
                onClick: e => { e.preventDefault(); onProbe?.(maybeFreeModels, true) },
              }, t('pi.probeBtn'))
              : null,
          ),
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
                  h('details', { style: { marginTop: 6 } },
                    h('summary', { style: { cursor: 'pointer', fontSize: 12 } }, t('pi.maybeFree')),
                    h('div', { style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 } },
                      maybeFreeModels.length > 0
                        ? maybeFreeModels.map(m => {
                          const id = str(m?.id ?? m)
                          const st = statusOf(id)
                          const tagged = freeTagOf(obj(tupleScope(availProjection, id, str(m?.group)))[id])
                          const probe = str(obj(probeVerdicts)[`${str(m?.group)}/${id}`])
                          // NF3 wording: only measured evidence (Host tag or probe
                          // verdict) says "已确认免费"; weak/declaration stays
                          // "可能免费（未实测）". Zero samples still "暂无数据",
                          // never "不可用".
                          const confirmed = tagged?.level === 'measured' || probe === 'free'
                          const label = confirmed ? t('pi.freeConfirmedTag') : t('pi.freePossibleTag')
                          const samples = st.samples ?? 0
                          const dataLabel = st.key === 'healthy' ? t('pi.availableTag')
                            : samples > 0 ? t('pi.unknownTag') : t('health.stateUnknown')
                          return h('span', { key: id, style: S.pill(st.key === 'healthy') },
                            `${str(m?.name) || id} · ${label} · ${dataLabel}`)
                        })
                        : h('div', { style: S.muted }, t('pi.noMaybeFree')),
                    ),
                    h('div', { style: { ...S.muted, marginTop: 4, fontSize: 11 } }, t('pi.freeModelsHint')),
                    // 其余已登记模型：折叠，不丢（"能发现"仍成立）。
                    otherModels.length > 0
                      ? h('details', { style: { marginTop: 6 } },
                        h('summary', { style: { ...S.summary, fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } },
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

    // ---- cost-pill settings card (BX2) ------------------------------------
    // The pill config existed in schema.js but no control ever wrote it, so a
    // beginner could not turn it on. This card lives on the FIRST overview
    // screen (never inside Advanced) and writes each field through form.mutate
    // immediately. Internal values are the Host's real conversation slot names.
    function CostPillSettingsCard({ t, config, revision, mutate }) {
      const enabled = config?.[COST_PILL_ENABLED_KEY] === true
      const position = costPillPositionOf(config?.[COST_PILL_POSITION_KEY])
      const refreshMs = costPillRefreshMsOf(config?.[COST_PILL_REFRESH_KEY])
      const [draftMs, setDraftMs] = useState(String(refreshMs))
      const [notice, setNotice] = useState(null)
      useEffect(() => { setDraftMs(String(costPillRefreshMsOf(config?.[COST_PILL_REFRESH_KEY]))) }, [config?.[COST_PILL_REFRESH_KEY]])
      const save = useCallback(async (path, value) => {
        setNotice(null)
        const res = await mutate([{ op: 'set', path, value }], revision)
        setNotice(res?.ok === true
          ? { ok: true, msg: t('action.saved') }
          : { ok: false, msg: `${t('error.saveFailed')}${res?.detail ? '（' + res.detail + '）' : ''}` })
      }, [mutate, revision, t])
      const parsedMs = Number(draftMs)
      const validMs = parsedMs === 0 || (Number.isFinite(parsedMs) && parsedMs >= 1000)
      const refreshLabel = refreshMs === 0 ? t('costPill.autoRefresh') + ': off' : `${refreshMs} ms`
      return h('details', { style: S.card },
        h('summary', { style: { cursor: 'pointer', fontWeight: 500 } },
          `${t('costPill.cardTitle')} · ${enabled ? t('status.yes') : t('status.no')} · ${t('costPill.position')}: ${t('costPill.pos.' + position)} · ${refreshLabel}`,
        ),
        h('div', { style: { marginTop: 8 } },
        h('div', { style: { ...S.muted, marginBottom: 8 } }, t('costPill.cardHelp')),
        h(Field, { label: t('costPill.enabled'), help: t('costPill.enabledHelp') },
          h('input', {
            type: 'checkbox', checked: enabled,
            'aria-label': t('costPill.enabled'),
            onChange: e => { void save([COST_PILL_ENABLED_KEY], e.target.checked) },
          }),
        ),
        h(Field, { label: t('costPill.position'), help: t('costPill.positionHelp') },
          select(COST_PILL_SLOTS.map(v => ({ v, l: t('costPill.pos.' + v) })), position,
            value => { void save([COST_PILL_POSITION_KEY], value) }, t('costPill.position')),
        ),
        h(Field, { label: t('costPill.refreshMs'), help: t('costPill.refreshMsHelp') },
          h('input', {
            type: 'number', min: 1000, step: 1000,
            value: draftMs, 'aria-label': t('costPill.refreshMs'),
            onChange: e => setDraftMs(e.target.value),
            onBlur: () => { if (validMs) void save([COST_PILL_REFRESH_KEY], parsedMs) },
            onKeyDown: e => { if (e.key === 'Enter' && validMs) void save([COST_PILL_REFRESH_KEY], parsedMs) },
            style: S.input,
          }),
        ),
        !validMs ? h('div', { style: { ...S.err, marginLeft: 96 } }, t('costPill.refreshInvalid')) : null,
        notice ? h('div', { style: { ...(notice.ok ? S.ok : S.err), marginTop: 6 } }, notice.msg) : null,
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
      // 恢复默认：Host 契约（lib/chains.js normalizeChains:70-86）—— chains 传
      // undefined / null / {} 都会归一到 DEFAULT_CHAINS（{auto: []}）并走自动发现。
      // 所以这里写 {} （不需要、也不去赌 set undefined 的语义），成功才提示已清空。
      const clearCustom = async () => {
        setConfirmKey(null)
        const r = await mutate([{ op: 'set', path: ['chains'], value: {} }], revision)
        const ok = r?.ok === true
        setMsg({ ok, msg: ok ? t('chains.cleared') : t('error.saveFailed'), detail: ok ? '' : str(r?.detail) })
        if (ok) setGroups([])
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.hero },
          h('div', { style: S.heroTitle }, t('chains.plainTitle')),
          h('div', { style: S.heroText }, t('chains.plainExplain')),
        ),
        // 卡片头：保存入口 + 未保存标记。不展开任何 <details> 也能看到。
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: S.sectionTitle }, t('chains.cardTitle')),
            dirty ? h('span', { style: S.unsaved }, t('card.unsaved')) : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            msg ? h('span', { style: msg.ok ? S.ok : S.err }, msg.msg) : null,
            // 恢复自动发现：二次确认，只有确认后才真写（写 {} 而不是 undefined）。
            confirmKey === 'chains-clear'
              ? h('button', {
                type: 'button', style: { ...S.btn, color: 'var(--dsw-alias-state-error-primary)' },
                onClick: clearCustom,
              }, t('chains.clearConfirm'))
              : h('button', { type: 'button', style: S.btn, onClick: () => arm('chains-clear') }, t('chains.clearCustom')),
            h('button', { type: 'button', style: S.primary, onClick: save }, t('action.save')),
          ),
        ),
        // 清空提示与空态合并成一行短句；折叠只改 DOM，不碰 groups/dirty/stableSig。
        h('div', { style: { ...S.muted, fontSize: 11 } }, usingDefault ? t('chains.hintShort') : t('chains.clearHint')),
        msg && msg.detail ? h(DiagDetails, { t, lines: [`save: ${msg.detail}`], failed: true }) : null,
        // 默认只展开第一组，其余收进「其他链路（N）」；groups 状态与顺序完全不变。
        ...groups.slice(0, 1).map((g, gi) => h('div', { key: gi, style: S.card },
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
          ...g.hops.map((hop, hi) => h('div', { key: hi, style: { ...S.step, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
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
        groups.length > 1
          ? h('details', { style: S.card },
            h('summary', { style: { cursor: 'pointer', fontWeight: 500 } },
              fmt(t, 'chains.otherGroups', { n: groups.length - 1 })),
            h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
              groups.slice(1).map((g, offset) => {
                const gi = offset + 1
                return h('div', { key: gi, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 8 } },
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
                  ...g.hops.map((hop, hi) => h('div', { key: hi, style: S.step },
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
                )
              }),
            ),
          )
          : null,
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
        // task-107: 探测开关，默认开启（与执行路径 probeSetting !== false 一致）；
        // 只有显式保存 false 才取消勾选。开启后首屏出现"检测未确认模型"按钮。
        h(Field, { label: t('ranking.probeEnabled'), help: t('ranking.probeEnabledHelp') },
          h('input', {
            type: 'checkbox', checked: c.probeEnabled !== false,
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

    function AccountsTab({ t, config, revision, mutate, applyPreset, working, pi, costService, onDirty, availProjection, probeVerdicts }) {
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
      const blankAccount = () => ({
        id: '', provider: provOpts[0]?.v, credentialRef: '', models: [modelOpts[0]?.v],
        tier: 'standard', speedTier: 'normal', priceTier: 'mid', costModel: 'metered', quotaCost: '', priority: 0,
        priceMultiplier: undefined,
      })
      // 初始化 / config 同步 / dirty 基线共用同一归一化，避免"没动过"被判成脏。
      // 关键：展开原对象再覆盖 UI 编辑的键 —— 账号里未展示的字段
      // （priceMultiplier / weight / priceOverrides / quotaCost 的历史值…）
      // 必须原样保留，否则一次保存就把它们静默删掉。
      const rowsFromConfig = cfgAccounts => arr(cfgAccounts).map(a => {
        const raw = obj(a)
        const quota = raw.quotaCost === undefined || raw.quotaCost === null || raw.quotaCost === ''
          ? ''
          : (Number.isFinite(Number(raw.quotaCost)) ? Number(raw.quotaCost) : '')
        return {
          ...raw,
          id: str(raw.id),
          provider: str(raw.provider) || provOpts[0]?.v,
          credentialRef: str(raw.credentialRef),
          models: arr(raw.models).length ? arr(raw.models) : [modelOpts[0]?.v],
          tier: str(raw.tier) || 'standard',
          speedTier: str(raw.speedTier) || 'normal',
          priceTier: str(raw.priceTier) || 'mid',
          costModel: str(raw.costModel) || 'metered',
          quotaCost: quota,
          priority: Number.isFinite(Number(raw.priority)) ? Math.trunc(Number(raw.priority)) : 0,
          // NF3: priceMultiplier lives INSIDE ranking (lib/account-pool.js:67-80).
          // Keep the whole ranking block spread so weight/priceOverrides survive.
          priceMultiplier: Number.isFinite(raw.ranking?.priceMultiplier)
            ? raw.ranking.priceMultiplier : undefined,
        }
      })
      // 模型多选的搜索 / 只看免费状态（按账号行索引；不进 config）。
      const [modelQuery, setModelQuery] = useState({})
      const [freeOnly, setFreeOnly] = useState({})
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
      // 模型多选可用性：搜索 / 只看免费 / 已选始终可见 / 默认最多渲染 60 个。
      const MODEL_RENDER_CAP = 60
      // Account declarations feed the same contract: a config account that
      // lists this model with multiplier 0 / costModel free becomes 'declared'.
      const declared = accountDeclaredOf(config)
      // NF3: "只看免费" uses the same weak-signal contract as the overview and
      // auto-probe: Host tag first, then probe verdict + name/tier/multiplier.
      // A metered verdict or paid billing excludes the model; unknown does not.
      const modelFreeSignal = (id, label) => {
        const group = (arr(pi?.models).find(m => str(m?.id ?? m) === id)?.group) ?? ''
        // Host tuple tag first; legacy top-level tag is the fallback.
        const tagged = freeTagOf(obj(tupleScope(availProjection, id, group))[id])
        if (tagged && tagged.level !== 'none') return tagged
        return freeSignal({
          provider: str(group), model: id, name: str(label), group: str(group),
          probeVerdict: str(obj(probeVerdicts)[`${str(group)}/${id}`]),
          priceTier: str(obj(availProjection)[id]?.tier),
          priceMultiplier: obj(declared[id]).priceMultiplier,
          costModel: str(obj(declared[id]).costModel),
        })
      }
      const pickerState = i => {
        const selected = new Set(arr(rows[i]?.models).map(str))
        const q = str(modelQuery[i]).trim().toLowerCase()
        const wantsFree = freeOnly[i] === true
        const match = o => {
          const id = str(o.v)
          const hay = `${id} ${str(o.l)}`.toLowerCase()
          if (q && !hay.includes(q)) return false
          if (wantsFree && !modelFreeSignal(id, o.l).free) return false
          return true
        }
        const pinned = modelOpts.filter(o => selected.has(str(o.v)))
        const rest = modelOpts.filter(o => !selected.has(str(o.v)) && match(o))
        const room = Math.max(0, MODEL_RENDER_CAP - pinned.length)
        return {
          shown: [...pinned, ...rest.slice(0, room)],
          matched: [...pinned, ...rest],
          hidden: Math.max(0, rest.length - room),
        }
      }
      // 全选 = 选中当前筛选出来的全部模型（不受 60 个渲染上限影响）。
      const selectAllModels = i => {
        const { matched } = pickerState(i)
        update(i, r => ({ ...r, models: [...new Set([...r.models, ...matched.map(o => str(o.v))])] }))
      }
      const clearModels = i => update(i, r => ({ ...r, models: [] }))
      // 写 ranking 时必须把默认值为「开」的开关物化：块一旦存在，
      // Host 读的是 enabled === true（lib/ranking.js:163）、
      // adapter 读的是 routing.enabled === true（lib/adapter.js:232）。
      // task-65 边缘：勾选框的 checked 是 c.probeEnabled !== false，保存时
      // 把同一个判据物化进 ranking.probeEnabled，读写走同一路径。若 config
      // 有遗留顶层 probeEnabled（schema 无此键），一律以 ranking 为准，
      // 不把顶层值复制进 ranking（否则顶层 false 会悄悄把勾选框变成关闭）。
      const withOnDefaults = draft => {
        const d = obj(draft)
        const routing = obj(d.routing)
        return {
          ...d,
          enabled: d.enabled !== false,
          routing: { ...routing, enabled: routing.enabled !== false },
          probeEnabled: d.probeEnabled !== false,
        }
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
          // 只在用户真的填了引用名时才写 credentialRef（留空 = 用 DSH 已登录账号）。
          const row = { ...obj(r), id, provider, models: r.models, tier: r.tier }
          if (r.credentialRef) row.credentialRef = r.credentialRef
          else delete row.credentialRef
          // 计费与等级细节：都是 Host 已支持的字段（lib/ranking.js
          // ACCOUNT_RANKING_FIELDS），按 Host 的默认值补全。
          row.speedTier = str(r.speedTier) || 'normal'
          row.priceTier = str(r.priceTier) || 'mid'
          row.costModel = str(r.costModel) || 'metered'
          // NF3: priceMultiplier is a NESTED ranking field. Merge into the
          // existing ranking sub-object so weight/priceOverrides/other keys
          // are never overwritten. Blank = default 1; only finite numbers >=0
          // are accepted (0 is legal); '0'/negative/NaN fall back to 1 AND
          // surface a visible per-row warning (never a silent reset).
          const ranking = obj(row.ranking)
          const rawMul = r.priceMultiplier
          const parsedMul = rawMul === '' || rawMul === undefined || rawMul === null
            ? 1 : Number(rawMul)
          const validMul = Number.isFinite(parsedMul) && parsedMul >= 0
          const priceMultiplier = validMul ? parsedMul : 1
          row.ranking = { ...ranking, priceMultiplier }
          if (!validMul && rawMul !== '' && rawMul !== undefined && rawMul !== null) {
            problems[i] = (problems[i] ? problems[i] + ' ' : '')
              + fmt(t, 'account.priceMultiplierInvalid', { value: str(rawMul) })
          }
          // 额度消耗代价只对订阅制有意义；不订阅就不写这个键。
          if (row.costModel === 'subscription' && r.quotaCost !== '' && Number.isFinite(Number(r.quotaCost))) {
            row.quotaCost = Math.min(1, Math.max(0, Number(r.quotaCost)))
          } else {
            delete row.quotaCost
          }
          row.priority = Number.isFinite(Number(r.priority)) ? Math.trunc(Number(r.priority)) : 0
          out.push(row)
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

      // 预设按钮只在总览保留一份；这里不再重复 t('preset.pick')。
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
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('preset.pick')),
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
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: S.sectionTitle }, t('accounts.cardTitle')),
            dirty ? h('span', { style: S.unsaved }, t('card.unsaved')) : null,
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
              h('span', { style: S.grow },
                // 可输入 + datalist 候选（只存引用名，Host 不碰密钥）。
                h('input', {
                  type: 'text', list: `cred-refs-${i}`, value: r.credentialRef,
                  placeholder: t('field.credentialPh'),
                  onChange: e => update(i, x => ({ ...x, credentialRef: e.target.value })),
                  style: S.input, 'aria-label': t('field.credential'),
                }),
                h('datalist', { id: `cred-refs-${i}` },
                  credentialChoices.filter(Boolean).map(c => h('option', { key: c, value: c }))),
              ),
            ),
            h('div', { style: { ...S.row, alignItems: 'flex-start' } },
              h('span', { style: S.label }, t('field.models')),
              h('div', { style: { ...S.grow, display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  h('input', {
                    type: 'search', value: str(modelQuery[i]), placeholder: t('account.modelSearch'),
                    onChange: e => setModelQuery(q => ({ ...q, [i]: e.target.value })),
                    style: { ...S.input, maxWidth: 200 }, 'aria-label': t('account.modelSearch'),
                  }),
                  h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
                    h('input', {
                      type: 'checkbox', checked: freeOnly[i] === true,
                      onChange: e => setFreeOnly(f => ({ ...f, [i]: e.target.checked })),
                    }),
                    t('account.freeOnly'),
                  ),
                  h('span', { style: S.muted }, fmt(t, 'account.selectedCount', { n: r.models.length })),
                  h('button', { type: 'button', style: S.btn, onClick: () => selectAllModels(i) }, t('account.selectAll')),
                  h('button', { type: 'button', style: S.btn, onClick: () => clearModels(i) }, t('account.clear')),
                ),
                h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto' } },
                  pickerState(i).shown.map(o => h('label', { key: str(o.v), style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
                    h('input', {
                      type: 'checkbox', checked: r.models.includes(str(o.v)),
                      onChange: () => toggleModel(i, str(o.v)),
                    }),
                    str(o.l),
                  )),
                ),
                pickerState(i).hidden > 0
                  ? h('div', { style: { ...S.muted, fontSize: 11 } }, fmt(t, 'account.moreModels', { n: pickerState(i).hidden }))
                  : null,
              ),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, t('field.tier')),
              select(
                [{ v: 'premium', l: t('tier.premium') }, { v: 'standard', l: t('tier.standard') }, { v: 'backup', l: t('tier.backup') }],
                r.tier, v => update(i, x => ({ ...x, tier: v })), t('field.tier'),
              ),
            ),
            // 价格倍率（0 = 免费）放在账号卡顶层：路由设置第一屏可见，
            // 不再藏在「详细设置 + 计费与等级细节」两层折叠里。
            h(Field, { label: t('account.priceMultiplier'), help: t('account.priceMultiplierHelp') },
              h('input', {
                type: 'number', min: 0, step: 'any',
                value: r.priceMultiplier === undefined || r.priceMultiplier === null
                  ? '' : String(r.priceMultiplier),
                placeholder: t('account.priceMultiplierPh'),
                onChange: e => update(i, x => ({ ...x, priceMultiplier: e.target.value })),
                style: S.input, 'aria-label': t('account.priceMultiplier'),
              })),
            // 计费与等级细节：默认折叠，字段语义见 lib/ranking.js
            // ACCOUNT_RANKING_FIELDS；文案用大白话，不暴露原始字段名。
            h('details', { style: { marginTop: 6 } },
              h('summary', { style: { ...S.summary, fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } },
                t('account.detailsTitle')),
              h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 } },
                h(Field, { label: t('account.speedTier'), help: t('account.speedTierHelp') },
                  select(
                    [{ v: 'fast', l: t('account.speedFast') }, { v: 'normal', l: t('account.speedNormal') }, { v: 'slow', l: t('account.speedSlow') }],
                    r.speedTier, v => update(i, x => ({ ...x, speedTier: v })), t('account.speedTier'),
                  )),
                h(Field, { label: t('account.priceTier'), help: t('account.priceTierHelp') },
                  select(
                    [{ v: 'free', l: t('account.priceFree') }, { v: 'low', l: t('account.priceLow') }, { v: 'mid', l: t('account.priceMid') }, { v: 'high', l: t('account.priceHigh') }],
                    r.priceTier, v => update(i, x => ({ ...x, priceTier: v })), t('account.priceTier'),
                  )),
                h(Field, { label: t('account.costModel'), help: t('account.costModelHelp') },
                  select(
                    [{ v: 'metered', l: t('account.costMetered') }, { v: 'subscription', l: t('account.costSubscription') }, { v: 'free', l: t('account.costFree') }],
                    r.costModel, v => update(i, x => ({ ...x, costModel: v })), t('account.costModel'),
                  )),
                r.costModel === 'subscription'
                  ? h(Field, { label: t('account.quotaCost'), help: t('account.quotaCostHelp') },
                    h('input', {
                      type: 'number', min: 0, max: 1, step: 0.05,
                      value: r.quotaCost === '' ? '' : String(r.quotaCost),
                      onChange: e => update(i, x => ({ ...x, quotaCost: e.target.value === '' ? '' : Number(e.target.value) })),
                      style: S.input, 'aria-label': t('account.quotaCost'),
                    }))
                  : null,
                h(Field, { label: t('account.priority'), help: t('account.priorityHelp') },
                  h('input', {
                    type: 'number', step: 1,
                    value: String(r.priority ?? 0),
                    onChange: e => update(i, x => ({ ...x, priority: e.target.value === '' ? '' : Number(e.target.value) })),
                    style: S.input, 'aria-label': t('account.priority'),
                  })),
              ),
            ),
            rowErrors[i] ? h('div', { style: S.err }, rowErrors[i]) : null,
          )),
          h('button', { type: 'button', style: S.btn, onClick: () => setRows(p => [...p, blankAccount()]) }, t('action.addAccount')),
          h('div', { style: S.card },
            h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('ranking.title')),
            h('div', { style: { ...S.muted, marginBottom: 8 } }, t('ranking.priorityHelp')),
            h(RankingForm, {
              t,
              // task-65 边缘：遗留顶层 probeEnabled 在 schema 里不存在；
              // 只作展示兜底，保存走 withOnDefaults 的 ranking 判据。
              cfg: rankingDraft.probeEnabled === undefined && config?.probeEnabled !== undefined
                ? { ...rankingDraft, probeEnabled: config.probeEnabled }
                : rankingDraft,
              onChange: setRankingDraft,
            }),
          ),
          h('div', { style: S.card },
            h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('routing.title')),
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
      // 老账本行没有延迟字段：两列全缺时整组不渲染（远端 v2.6.2 HIG 交互）。
      const hasLatency = rows.some(r => r?.ttftMs != null || r?.tokensPerSecond != null)
      const columns = ['time', 'model', 'tokens', ...(hasLatency ? ['ttft', 'tps'] : []), 'cost', 'status']
      const renderRows = list => h('div', { style: { overflowX: 'auto' } },
        h('table', { style: { ...S.table, minWidth: hasLatency ? 720 : 540 } },
          h('thead', null, h('tr', null, columns.map(k =>
            h('th', { key: k, style: S.th }, t(`cost.col.${k}`))))),
          h('tbody', null, list.map((r, i) => h('tr', { key: `${str(r?.requestId)}-${i}` },
            [str(r?.timestamp).replace('T', ' ').slice(0, 19),
             `${str(r?.provider)}/${str(r?.model)}`,
             `${Number(r?.inputTokens || 0)}+${Number(r?.outputTokens || 0)}`,
             ...(hasLatency ? [numOrDash(r?.ttftMs), numOrDash(r?.tokensPerSecond, 1)] : []),
             `$${Number(r?.costUsd || 0).toFixed(6)}`,
             r?.failed ? t('cost.failed') : t('cost.ok'),
            ].map((v, j) => h('td', { key: j, style: S.td }, v)))),
          ),
        ),
      )
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        // ① 逐笔明细
        h('div', { style: S.card },
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, fmt(t, 'cost.detailTitle', { n: Number(detail.total || 0) })),
          // 逐笔明细首屏只放 Top 10；其余行与分页收进二级 details（远端 v2.6.2 HIG）。
          rows.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : h('div', null,
              renderRows(rows.slice(0, 10)),
              (rows.length > 10 || pages > 1)
                ? h('details', { style: { marginTop: 8 } },
                  h('summary', { style: { ...S.muted, cursor: 'pointer' } },
                    fmt(t, 'cost.expandAll', { n: Math.max(0, rows.length - 10) || rows.length })),
                  rows.length > 10 ? h('div', { style: { marginTop: 8 } }, renderRows(rows.slice(10))) : null,
                  h('div', { style: { ...S.row, marginTop: 8 } },
                    h('button', { type: 'button', style: S.btn, disabled: page <= 0, onClick: () => setPage(p => Math.max(0, p - 1)) }, t('cost.prevPage')),
                    h('span', { style: S.muted }, ` ${page + 1} / ${pages} `),
                    h('button', { type: 'button', style: S.btn, disabled: page + 1 >= pages, onClick: () => setPage(p => p + 1) }, t('cost.nextPage')),
                  ),
                )
                : h('div', { style: { ...S.row, marginTop: 8 } },
                  h('button', { type: 'button', style: S.btn, disabled: page <= 0, onClick: () => setPage(p => Math.max(0, p - 1)) }, t('cost.prevPage')),
                  h('span', { style: S.muted }, ` ${page + 1} / ${pages} `),
                  h('button', { type: 'button', style: S.btn, disabled: page + 1 >= pages, onClick: () => setPage(p => p + 1) }, t('cost.nextPage')),
                ),
            ),
        ),
        // ② 时间趋势（纯 CSS 柱状图）
        h('div', { style: S.card },
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('cost.timelineTitle')),
          timeline.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, minHeight: 48 } },
              timeline.map(b => h('div', { key: str(b?.day), style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 } },
                h('div', { style: { ...S.muted, fontSize: 11 } }, String(Number(b?.calls) || 0)),
                h('div', { style: { width: '100%', height: `${Math.max(4, Math.round((Number(b?.calls) || 0) / maxCalls * 36))}px`, background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)', borderRadius: 'var(--dsw-radius-sm)' } }),
                h('div', { style: { ...S.muted, fontSize: 11 } }, str(b?.day).slice(5)),
              )),
            ),
        ),
        // ③ 按模型/提供商分组
        h('div', { style: S.card },
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('cost.byModelTitle')),
          byModel.length === 0
            ? h('div', { style: S.muted }, t('cost.detailNone'))
            : byModel.map(g => h('div', { key: `${str(g?.provider)}/${str(g?.model)}`, style: { padding: '3px 0' } },
              h(KV, { k: `${str(g?.provider)}/${str(g?.model)}`, v: fmt(t, 'cost.byModelValue', { calls: Number(g?.calls) || 0, cost: Number(g?.costUsd || 0).toFixed(6) }) })),
            ),
        ),
        // ④ 节省账本（诚实标注，绝不编数字）
        h('div', { style: S.card },
          h('div', { style: { ...S.sectionTitle, marginBottom: 8 } }, t('cost.savingsTitle')),
          h('div', { style: { ...S.muted, marginBottom: 8, color: 'var(--dsw-alias-state-warn-label)' } }, t('cost.savingsNotice')),
          savingModels.length === 0
            ? h('div', { style: S.muted }, t('cost.noComparable'))
            : savingModels.map(m => h('div', { key: str(m?.model), style: { padding: '3px 0' } },
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
    // 免费标签白话文案：只认 freeSignal.level，不按模型名/档位猜。
    // none 或没有标签一律「暂无数据」，弱信号绝不写成「已确认免费」。
    // measured 再按证据来源加短后缀：价格表声明（不是调用实测）/ 探测 / 账单。
    // 未知来源退回基础文案；weak / declared / none 三档文案保持不变。
    const FREE_MEASURED_SOURCE_KEY = {
      price: 'health.freeMeasuredPrice',
      probe: 'health.freeMeasuredProbe',
      billing: 'health.freeMeasuredBilling',
    }
    const freeTagText = (t, tag) => {
      if (!tag || tag.free !== true) return t('health.freeNone')
      if (str(tag.level) === 'measured') {
        return t(FREE_MEASURED_SOURCE_KEY[str(tag.source)] || 'health.freeMeasured')
      }
      if (str(tag.level) === 'declared') return t('health.freeDeclared')
      if (str(tag.level) === 'weak') return t('health.freeWeak')
      return t('health.freeNone')
    }
    // 投影按 modelId 索引；同一账号可对应多个模型，取证据最强的一档展示。
    // HB2 residual: a lookup is STRICTLY (provider, modelId). Passing a bare
    // modelId made tupleScope see an empty provider and read row.freeSignal —
    // the strongest tag across ALL providers — whose measured rank outranked
    // this tuple's own weak tag (workbuddy/hy4flash-free showed 已确认免费
    // from an x-opencode-free zero-price row). Old Profiles without a `providers`
    // map still read the legacy top-level tag through tupleScope's no-map branch.
    const FREE_LEVEL_RANK = { measured: 3, declared: 2, weak: 1 }
    const strongestFreeTag = (projection, tuples) => {
      let best = null
      for (const tuple of tuples) {
        if (!tuple) continue
        const provider = str(tuple.provider)
        const modelId = str(tuple.modelId)
        if (!modelId) continue
        const tag = freeTagOf(obj(tupleScope(projection, modelId, provider))[modelId])
        if (!tag || tag.free !== true) continue
        if (!best || (FREE_LEVEL_RANK[str(tag.level)] ?? 0) > (FREE_LEVEL_RANK[str(best.level)] ?? 0)) best = tag
      }
      return best
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

    function AccountHealthPanel({ t, snapshot, diag, loading, onRefresh, availProjection }) {
      const snap = obj(snapshot)
      const accounts = arr(snap.accounts)
      const routes = arr(snap.routes)
      const snapAt = Number(snap.generatedAt)
      // 资费证据来自 availProjection（Host freeSignal + 账本合并后的投影），
      // 健康快照本身只带健康/冷却，不带任何资费字段。
      // Account rows own one provider + several models: rank the exact tag of
      // each (account.provider, model) tuple, never the bare model aggregate.
      const freeForAccount = row => {
        const provider = str(row?.provider)
        return strongestFreeTag(availProjection, arr(row?.models).map(modelId => ({ provider, modelId: str(modelId) })))
      }
      // Route rows own one (provider, modelId) tuple. Passing the bare modelId
      // here was the residual bug: tupleScope saw an empty provider and read the
      // strongest tag across all providers (x-opencode-free measured → workbuddy).
      const freeForRoute = row => strongestFreeTag(availProjection, [{
        provider: str(row?.provider), modelId: str(row?.modelId),
      }])
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
        body = h('div', { style: S.empty }, t('health.empty'))
      } else {
        // 常显只留摘要行；明细表整体折叠。冷却 / 降级时默认展开（远端 v2.6.2 HIG）。
        const coolingCount = accounts.filter(a => ['COOLING', 'HALF_OPEN'].includes(str(a?.state).toUpperCase())).length
        const degradedCount = routes.filter(r => ['DEGRADED', 'DEPRECATED'].includes(str(r?.health).toUpperCase())).length
        const abnormal = coolingCount > 0 || degradedCount > 0
        const summaryStyle = { color: abnormal ? HEALTH_WARN_COLOR : HEALTH_NEUTRAL_COLOR, fontSize: 12 }
        const tableBlock = { marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l2)' }
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { ...S.muted, marginBottom: 6 } }, t('health.billingHint')),
          h('details', { style: S.card, open: abnormal },
            h('summary', { style: { cursor: 'pointer', fontWeight: 500, color: coolingCount > 0 ? HEALTH_WARN_COLOR : undefined } },
              fmt(t, 'health.accountSummary', { n: accounts.length, k: coolingCount })),
            accounts.length === 0
              ? h('div', { style: { ...S.empty, marginTop: 8 } }, t('health.empty'))
              : h('div', { style: tableBlock, overflowX: 'auto' },
                h('table', { style: { ...S.table, minWidth: 560 } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th, scope: 'col' }, t('health.id')),
                  h('th', { style: S.th, scope: 'col' }, t('health.state')),
                  h('th', { style: S.th, scope: 'col' }, t('health.billing')),
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
                  const detail = [
                    t('health.provider') + ': ' + (str(row.provider) || '—'),
                    models.length ? fmt(t, 'health.accountModels', { models: models.join(' · ') }) : null,
                    cooling && remain > 0 ? fmt(t, 'health.accountRemain', { remain: fmtDuration(t, remain) }) : null,
                    reason ? `${t('health.coolReason')}: ${reason}` : null,
                    `${t('health.streak')}: ${Number(row.streak) || 0}`,
                    `${t('health.usage')}: ${Number(row.usage) || 0}`,
                    fmt(t, 'health.lastSeen', {
                      ok: row.lastSuccessAt === null || row.lastSuccessAt === undefined ? t('health.never') : fmtClock(row.lastSuccessAt),
                      fail: row.lastFailureAt === null || row.lastFailureAt === undefined ? t('health.never') : fmtClock(row.lastFailureAt),
                    }),
                  ].filter(Boolean).join(' · ')
                  return h('tr', { key: `a:${fullId || i}`, title: detail },
                    h('td', { style: idCell },
                      h('div', { title: fullId || undefined },
                        displayId(fullId) || '—',
                        row.implicit === true ? h('span', { style: implicitBadge }, t('health.implicit')) : null,
                      ),
                      h('div', { style: S.muted }, str(row.provider) || '—'),
                    ),
                    h('td', { style: S.td },
                      h('div', null,
                        h('span', { style: S.badge(accountStateColor(row.state)) }, accountStateText(t, row.state)),
                        cooling && remain > 0 ? h('span', { style: { ...summaryStyle, marginLeft: 6 } }, fmtDuration(t, remain)) : null,
                      ),
                    ),
                    h('td', { style: S.td }, freeTagText(t, freeForAccount(row))),
                    h('td', { style: S.td }, samplesText(t, row.samples)),
                  )
                })),
                ),
              ),
          ),
          h('details', { style: S.card, open: abnormal },
            h('summary', { style: { cursor: 'pointer', fontWeight: 500, color: degradedCount > 0 ? HEALTH_WARN_COLOR : undefined } },
              fmt(t, 'health.routeSummary', { m: routes.length, j: degradedCount })),
            routes.length === 0
              ? h('div', { style: { ...S.empty, marginTop: 8 } }, t('health.empty'))
              : h('div', { style: tableBlock, overflowX: 'auto' },
                h('table', { style: { ...S.table, minWidth: 480 } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th, scope: 'col' }, t('health.provider')),
                  h('th', { style: S.th, scope: 'col' }, t('health.model')),
                  h('th', { style: S.th, scope: 'col' }, t('health.health')),
                  h('th', { style: S.th, scope: 'col' }, t('health.billing')),
                )),
                h('tbody', null, routes.map((r, i) => {
                  const row = obj(r)
                  const conf = Number(row.confidence)
                  const detail = [
                    t('health.tier') + ': ' + tierText(t, row.tier),
                    `${t('health.confidence')}: ${confText(t, conf)}${Number.isFinite(conf) ? ' (' + conf.toFixed(2) + ')' : ''}`,
                    `${t('health.samples')}: ${samplesText(t, row.samples)}`,
                  ].join(' · ')
                  return h('tr', { key: `r:${str(row.provider)}::${str(row.modelId)}:${i}`, title: detail },
                    h('td', { style: S.td }, str(row.provider) || '—'),
                    h('td', { style: S.td }, str(row.modelId) || '—'),
                    h('td', { style: S.td },
                      h('span', { style: S.badge(routeHealthColor(row.health)) }, routeHealthText(t, row.health)),
                    ),
                    h('td', { style: S.td }, freeTagText(t, freeForRoute(row))),
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

    function CostHealthTab({ t, localConfig, remote, costService, costDiag, availProjection }) {
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
            h('span', { style: S.sectionTitle }, t('cost.overviewTitle')),
            h('button', { type: 'button', style: S.btn, onClick: refresh }, t('action.refresh')),
          ),
        ),
        // 逐笔明细 / 趋势 / 按模型 / 节省账本 全部收进「详细数据」折叠；
        // 失败时默认展开，让错误当场可见。
        h('details', { style: S.card, open: failed },
          h('summary', { style: S.summary },
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
          availProjection,
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

    // ---- CF-3: conversation cost pill ---------------------------------------
    // Contribution into the three conversation slots. The service never enters
    // module inject: it is soft-probed per inject() call like other settings
    // components. t comes from the slot's locale seat (NS dictionaries below).
    function CostPill({ t, form, smartProvider, costService: propCostService }) {
      const costService = smartProvider ?? propCostService
      const readConfig = useCallback(() => {
        let config = {}
        try { config = obj(obj(form?.getSnapshot?.()).value) } catch { config = {} }
        return {
          enabled: costPillEnabledOf(config),
          position: costPillPositionOf(config[COST_PILL_POSITION_KEY]),
          refreshMs: costPillRefreshMsOf(config[COST_PILL_REFRESH_KEY]),
        }
      }, [form])
      const initial = readConfig()
      const [cfg, setCfg] = useState(initial)
      const [summary, setSummary] = useState(null)
      const [state, setState] = useState('idle') // idle | loading | ok | error
      const [notice, setNotice] = useState(null)
      // Two-step clear confirmation with a 3 s undo window (client.js:989-997).
      const [confirmClear, setConfirmClear] = useState(false)
      const confirmTimer = useRef(null)
      const armClear = useCallback(() => {
        setConfirmClear(true)
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000)
      }, [])
      useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])
      // The Host service is installed by async $mount. Retry a few short
      // probes, then re-render when it appears (client.js:2601-2616 pattern).
      const [mountTick, setMountTick] = useState(0)
      useEffect(() => {
        if (costService) return
        let alive = true
        const timers = [50, 250, 800, 2000].map(ms => setTimeout(() => {
          if (!alive) return
          let svc
          try { svc = smartProvider ?? form?.remote?.smartProvider } catch { svc = undefined }
          if (svc) setMountTick(v => v + 1)
        }, ms))
        return () => { alive = false; timers.forEach(clearTimeout) }
      }, [costService, smartProvider, mountTick, form])
      // Config changes (enable / position / interval) land without remount.
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setCfg(readConfig()) }
        sync()
        let off
        try { off = form?.subscribe?.(sync) } catch { off = undefined }
        return () => { alive = false; try { off?.() } catch {} }
      }, [form, readConfig])
      const refresh = useCallback(async signal => {
        if (!costService?.statsSince) return
        setState('loading')
        try {
          // Host reads the stats-state.json marker when since is absent.
          const res = await costService.statsSince({}, signal)
          if (signal?.aborted) return
          if (res && res.ok) { setSummary(obj(res.value)); setState('ok') }
          else { setSummary(null); setState('error') }
        } catch (error) {
          if (!signal?.aborted) { setSummary(null); setState('error') }
        }
      }, [costService])
      // Single setTimeout recursion + visibilitychange pause + AbortController:
      // stale in-flight responses are ignored; unmount and config changes do a
      // triple cleanup (alive flag, clearTimeout, listener removal).
      const refreshRef = useRef(refresh)
      refreshRef.current = refresh
      useEffect(() => {
        if (!cfg.enabled || !costService?.statsSince || cfg.refreshMs <= 0) return
        let alive = true
        let timer = null
        let controller = null
        const schedule = () => {
          if (!alive || (typeof document !== 'undefined' && document.hidden)) return
          timer = setTimeout(async () => {
            timer = null
            if (!alive) return
            controller?.abort()
            controller = new AbortController()
            await refreshRef.current(controller.signal)
            if (alive) schedule()
          }, cfg.refreshMs)
        }
        const onVis = () => {
          if (!alive || typeof document === 'undefined') return
          if (document.hidden) {
            if (timer) { clearTimeout(timer); timer = null }
            if (controller) { controller.abort(); controller = null }
          } else if (!timer) schedule()
        }
        schedule()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          if (controller) controller.abort()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
        }
      }, [cfg.enabled, cfg.refreshMs, costService])
      useEffect(() => {
        if (!cfg.enabled || !costService?.statsSince) return
        let alive = true
        const controller = new AbortController()
        void (async () => {
          await refresh(controller.signal)
          if (!alive) controller.abort()
        })()
        return () => { alive = false; controller.abort() }
      }, [cfg.enabled, costService, refresh])
      const doClear = useCallback(async () => {
        setConfirmClear(false)
        if (confirmTimer.current) { clearTimeout(confirmTimer.current); confirmTimer.current = null }
        if (!costService?.clearStats) { setNotice(t('costPill.error')); return }
        const controller = new AbortController()
        try {
          const res = await costService.clearStats(controller.signal)
          if (controller.signal.aborted) return
          const cleared = res && res.ok === true && obj(res.value).ok === true
          setNotice(cleared ? fmt(t, 'costPill.cleared', { since: str(obj(res.value).since) || '—' }) : t('costPill.error'))
          if (cleared) await refresh(controller.signal)
        } catch {
          if (!controller.signal.aborted) setNotice(t('costPill.error'))
        }
      }, [costService, refresh, t])
      // t may be the raw-key fallback when the slot locale seat is absent;
      // fmt() already degrades to the key so no component throws.
      const wide = cfg.position === 'input.dock'
      const amount = Number(summary?.estimatedCostUsd)
      const amountText = Number.isFinite(amount) ? amount.toFixed(2) : '—'
      const sinceText = str(summary?.since)
        ? fmt(t, 'costPill.since', { since: str(summary.since) })
        : t('costPill.noSince')
      const noticeTimer = useRef(null)
      useEffect(() => {
        if (!notice) return
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 3000)
        return () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }
      }, [notice])
      return h(wide ? S.costPill.dock : S.costPill.bar, { 'data-slot': 'smart-provider.cost-pill' },
        h('span', { style: S.costPill.label }, t('costPill.monitor')),
        h('span', { style: S.costPill.amount, title: sinceText },
          state === 'loading' ? '…' : amountText, ' USD'),
        h('span', { style: S.costPill.muted }, sinceText),
        h('button', { type: 'button', style: S.costPill.btn(false, false), onClick: () => { void refresh() } }, t('costPill.refreshNow')),
        h('button', {
          type: 'button', style: S.costPill.btn(confirmClear, true), title: t('costPill.clearNote'),
          onClick: () => { if (confirmClear) void doClear(); else armClear() },
        }, confirmClear ? t('costPill.clearConfirm') : t('costPill.clear')),
        confirmClear ? h('span', { style: S.costPill.err }, t('costPill.clearNote')) : null,
        state === 'error' ? h('span', { style: S.costPill.err }, t('costPill.error')) : null,
        notice ? h('span', { style: S.costPill.muted }, notice) : null,
      )
    }

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
      // task-65 P1：父组件自己订阅 form —— 只靠 CostPill slot 内部的订阅
      // 更新 pill，父组件不重渲染，勾选后这里的 config/summary/checked
      // 永远是旧快照。force tick 让 readSnapshot() 在每次 mutate 后重新取值。
      const [configTick, bumpConfigTick] = useReducer(n => n + 1, 0)
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) bumpConfigTick() }
        let off
        try { off = form?.subscribe?.(sync) } catch { off = undefined }
        return () => { alive = false; try { off?.() } catch {} }
      }, [form])
      const readSnapshot = useCallback(() => {
        try { return obj(form?.getSnapshot?.()) } catch { return {} }
      }, [form])
      // configTick 只是重渲染触发器；读值始终走 form 当前快照（包括 revision）。
      void configTick
      const snap = readSnapshot()
      const config = obj(snap.value)
      // task-65 P2：不要用父渲染时冻结的 revision 做后续 mutate fence ——
      // 连续两笔写入时第一笔已把 form revision 推高，旧 fence 会触发
      // settings-conflict。mutate() 内部现读 revision；这里保留 0 仅供
      // 渲染展示/兼容调用点。
      const revision = Number.isFinite(snap.revision) ? snap.revision : 0
      // task-65 边缘：ranking.probeEnabled 是唯一读写路径。遗留顶层
      // probeEnabled（schema 无此键）只在 ranking 未设置该键时兜底，
      // 与 RankingForm 勾选 / 执行路径的 `!== false` 判定保持一致。
      // 具体物化发生在 AccountsTab.withOnDefaults（保存时写 ranking）与
      // RankingForm 展示兜底（只读顶层，不复制进 ranking）。
      const probeSetting = obj(config?.ranking).probeEnabled !== undefined
        ? obj(config?.ranking).probeEnabled
        : config?.probeEnabled
      const probeEnabled = probeSetting !== false
      // Account declarations for the auto-probe path (same overlay as UI checks).
      const declared = accountDeclaredOf(config)

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
      // task-107: 探测 verdict（Map "provider/model" -> verdict）。默认自动探测，
      // 只有显式关闭（probeEnabled=false）时才跳过最小探测。
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
          // NF3: Host projection rows carry a strict {free,level,source}|null tag.
          // addSample used to write only {samples,tier}, so every downstream
          // freeTagOf(obj(availProjection)[id]) saw null even when Host had real
          // measured/declared evidence. Keep the tag here; the ledger source has
          // no tag and must never erase a Host one (Host wins, max samples still
          // applies to both evidence sources).
          const addSample = (id, samples, tier, hostRow) => {
            if (!id) return
            const prev = merged[id] ?? { samples: 0 }
            merged[id] = {
              samples: Math.max(Number(prev.samples ?? 0), Number(samples) || 0),
              // task-106: 保留 tier 供"可能免费"判据使用（不参与状态判定）。
              tier: str(tier) || str(prev.tier) || undefined,
              // freeSignal: Host tag first; ledger rows only carry samples.
              freeSignal: freeTagOf(hostRow) ?? freeTagOf(prev),
              // HB2: keep the exact (provider,model) tags. Consumers prefer
              // these over the legacy top-level tag; the ledger source has no
              // map and must never erase the Host one.
              providers: (hostRow && typeof hostRow.providers === 'object'
                && !Array.isArray(hostRow.providers) ? hostRow.providers : null)
                ?? (prev && typeof prev.providers === 'object'
                  && !Array.isArray(prev.providers) ? prev.providers : undefined),
            }
          }
          // 源 1：live registry 投影 {modelId:{health,tier,confidence,freeSignal}}（含会话信号）。
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
                addSample(id, verified ? AVAIL_HIGH_SAMPLES : 0, row?.tier, row)
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

      // task-107: 手动/可选触发的最小探测。默认自动探测，
      // 对"弱信号命中但零样本"的少数候选探测（Host 单次上限3）；显式关闭时跳过。
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
          // NF3: same weak-signal contract — name free / multiplier 0 /
          // costModel free / tier free. Unknown verdict never blocks a probe.
          // Host tuple tag first; legacy top-level tag is the fallback.
          const tagged = freeTagOf(obj(tupleScope(availProjection, id, provider))[id])
          const sig = tagged && tagged.level !== 'none' ? tagged : freeSignal({
            provider, model: id, name: str(m?.name), group: provider,
            probeVerdict: str(obj(probeVerdicts)[`${provider}/${id}`]),
            priceTier: str(obj(availProjection)[id]?.tier),
            priceMultiplier: obj(declared[id]).priceMultiplier,
            costModel: str(obj(declared[id]).costModel),
          })
          if (!sig.free) continue
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
      // task-65 P2：调用方传入的 revision 是父渲染时冻结的旧值。每次 mutate
      // 调用前现读 form.getSnapshot().revision 作为 fence，避免连续两笔
      // 写入时第二笔撞 settings-conflict。仍保留 0 → undefined 的内部补偿
      // 语义（Host form.mutate 无 revision 时自动读当前快照）。
      const mutate = useCallback(async (ops, expectedRevision) => {
        const current = (() => { try { return obj(form?.getSnapshot?.()) } catch { return {} } })()
        const fstat = `${current.status ?? '?'}/w=${current.writable}`
        const fresh = Number.isFinite(current.revision) ? current.revision : expectedRevision
        try {
          if (typeof form?.mutate === 'function') {
            const fence = Number.isFinite(fresh) && fresh > 0 ? fresh : undefined
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
          const res = await settings?.mutate?.(ENTRY, ops, Number.isFinite(fresh) && fresh > 0 ? fresh : undefined)
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

      return h('div', { className: 'dsh-smart-wrap', style: S.wrap },
        h('style', { 'data-dsh-smart-ui': 'true' }, `
          .dsh-smart-wrap button { transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease; }
          .dsh-smart-wrap button:where(:not(:disabled)):hover { border-color: var(--dsw-alias-border-selected); }
          .dsh-smart-wrap button:where(:not(:disabled)):active { box-shadow: inset 0 1px 2px var(--dsw-alias-bg-mask-2); }
          .dsh-smart-wrap button:focus-visible,
          .dsh-smart-wrap input:focus-visible,
          .dsh-smart-wrap select:focus-visible,
          .dsh-smart-wrap summary:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 2px; }
          .dsh-smart-wrap summary:hover { color: var(--dsw-alias-label-primary); }
        `),
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
        // BX2: cost-pill controls on the overview FIRST screen, never in Advanced.
        tab === 'overview' ? h(CostPillSettingsCard, { t, config, revision, mutate }) : null,
        // 路由设置 = 先链路卡、后账号/择优卡，两张卡各自的保存按钮与语义不变。
        // 两张卡都上报 dirty，供切 Tab 前的确认条使用。
        tab === 'routing' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h(ChainsTab, { t, form, revision, mutate, config, pi, onDirty: v => reportDirty('chains', v) }),
          h(AccountsTab, { t, config, revision, mutate, applyPreset, working, pi, costService: activeCostService, onDirty: v => reportDirty('accounts', v), availProjection, probeVerdicts }),
        ) : null,
        tab === 'cost' ? h(CostHealthTab, { t, localConfig: config, remote, costService: activeCostService, costDiag: `mountRetries=${costReady ? 'ready' : 'pending'} mount=${mountDiag ?? '?'}`, availProjection }) : null,
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
      'action.save': '保存', 'action.saved': '已保存，立即生效（无需重启）',
      'action.refresh': '刷新', 'action.retry': '重试', 'action.confirmDelete': '确认删除？',
      'card.unsaved': '● 未保存',
      'diag.title': '诊断信息（默认折叠，出错时才展开）',
      'tab.unsavedGuard': '有未保存的修改，仍要切换？',
      'tab.switchAnyway': '切换（丢弃修改）',
      'tab.stayHere': '留在本页', 'status.yes': '是', 'status.no': '否',
      'advanced.title': '⚙ 详细设置（想调得更细再点开，都是下拉和按钮，不用写代码）',
      'action.delete': '删除', 'action.addHop': '＋ 添加备用项', 'action.addChain': '＋ 添加一组模型', 'action.addAccount': '＋ 添加一个账号',
      'chains.modelLabel': '这个模型：',
      'field.accountName': '名字：', 'field.accountNamePh': '给它起个名字，如 主账号',
      'field.provider': '服务商：', 'field.credential': '使用哪个 Key：',
      'field.credentialPh': '留空 = 用 DSH 已登录的账号；也可以填一个新的引用名',
      'field.models': '可用模型：', 'field.tier': '重要程度：',
      'field.model': '模型：',
      'cost.estimated': '预估成本', 'cost.records': '记录数', 'cost.savings': '节省',
      'tier.premium': '主要（优先用）', 'tier.standard': '普通', 'tier.backup': '备用（最后用）',
      'account.detailsTitle': '计费与等级细节（不填也能用）',
      'account.speedTier': '响应速度', 'account.speedTierHelp': '快 = 同样条件下优先挑它；只影响排序，不影响可用性。',
      'account.speedFast': '快', 'account.speedNormal': '普通', 'account.speedSlow': '慢',
      'account.priceTier': '价格档（兜底）', 'account.priceTierHelp': '只有定价表里查不到这个渠道、也没填单价时才用它估算。',
      'account.priceFree': '免费', 'account.priceLow': '便宜', 'account.priceMid': '中等', 'account.priceHigh': '贵',
      'account.costModel': '怎么计费', 'account.costModelHelp': '按量 = 按 token 计费；订阅 = 用额度折算；免费 = 成本按 0 算。',
      'account.costMetered': '按量付费', 'account.costSubscription': '订阅制（额度）', 'account.costFree': '免费',
      'account.quotaCost': '额度消耗代价', 'account.quotaCostHelp': '0~1：一次订阅额度消耗相当于多少份按量成本，越小越优先。',
      'account.priceMultiplier': '价格倍率（0 = 免费）',
      'account.priceMultiplierHelp': '留空 = 默认 1；0 表示这个账号免费；0.8 表示八折。只接受 ≥0 的数字，填错会自动按 1 并提示。',
      'account.priceMultiplierPh': '默认 1',
      'account.priceMultiplierInvalid': '价格倍率「{value}」无效，已按 1 保存（只接受 ≥0 的数字）。',
      'account.priority': '优先级', 'account.priorityHelp': '数字越小越优先（0 最高）；只影响同等级内部的先后。',
      'account.modelSearch': '搜索模型…', 'account.freeOnly': '只看免费',
      'account.selectedCount': '已选 {n} 个', 'account.selectAll': '全选', 'account.clear': '清空',
      'account.moreModels': '还有 {n} 个没显示，用上面的搜索找',
      'ranking.tierHigh': '优先用高级账号', 'ranking.tierLow': '先消耗备用账号',
      'ranking.priorityHard': '严格按顺序（先高级别）', 'ranking.prioritySoft': '只作为同分时参考',
      'hero.configured': '智能路由正在按你的设置选模型',
      'hero.configuredExplain': '已按「{strategy}」方式择优，不行就自动换下一个。',
      'hero.defaultTitle': '智能路由正在使用内置均衡策略',
      'hero.defaultExplain': '你还没选过策略，当前按内置的均衡方式运行：按任务挑候选模型、再在候选里均衡选择。想更省钱或更快，点下面的按钮切换即可。',
      'pi.available': '你在 DSH 里已经配好的模型',
      'pi.availableN': '已识别的模型（{models} 个模型 / {providers} 个提供商）',
      'pi.diagnostics': '诊断信息（自检与探测反馈）',
      'overview.healthLoading': '正在读取账号健康…',
      'overview.healthNoChannel': '读不到账号健康（没有数据通道）—— 点这里去「花费与健康」看诊断',
      'overview.healthLine': '账号 {accounts} 个 · 冷却中 {cooling} 个 —— 点这里查看账号健康',
      'overview.factLine': '链路 {chains} · 账号 {accounts} · {strategy}',
      'status.builtinDefault': '内置均衡默认',
      'star.link': 'Star on GitHub',
      'pi.loading': '正在读取你已配置的模型…',
      'pi.empty': '暂时没读到已配置的模型，可在「设置 → 模型」页添加。',
      'pi.providers': '提供商数', 'pi.models': '可用模型数',
      'pi.providerNames': '已识别：{names}',
      'pi.smartTag': 'Smart Gateway（智能路由，非独立模型提供商）',
      'pi.maybeFree': '可能免费的模型（宽松收录，宁可多列不漏）：',
      'pi.freeCount': '可能免费 {n} 个',
      'pi.probeBtn': '手动重探这些模型（已自动探过一次，强制刷新结果）',
      'pi.noMaybeFree': '当前未发现可能免费的模型',
      'pi.otherModels': '其他已登记模型 {n} 个（点开查看）',
      'pi.availableTag': '可用（已复核）', 'pi.unknownTag': '资费未确认',
      'pi.freeConfirmedTag': '已确认免费', 'pi.freePossibleTag': '可能免费（未实测）',
      'pi.freeModelsHint': '状态来自真实使用记录：有足够成功样本才显示"可用"，其余显示"资费未确认"（不是"不可用"）。无论状态如何都保留在列表里。',
      'pi.otherProvidersHint': 'Trae / Qoder / WorkBuddy 等插件的免费模型与可用性由各自插件管理，这里不标注。',
      'preset.pick': '你想让它怎么选？点一下就好（随时可改）',
      'preset.balanced': '⚖ 平衡（推荐）', 'preset.balancedSub': '省心又省钱，大多数人选这个',
      'preset.cost': '💰 更省钱', 'preset.costSub': '尽量用便宜的模型',
      'preset.speed': '⚡ 更快', 'preset.speedSub': '优先用响应快的模型',
      'preset.applying': '正在保存你的选择…',
      'preset.applied': '已切换为「{name}」，立即生效',
      'chains.cardTitle': '链路（模型的备用顺序）',
      'chains.plainTitle': '模型的备用顺序',
      'chains.plainExplain': '智能路由会按下面的顺序尝试：从上到下，不行就自动换下一个。这些都是你已经在 DSH 里配置好的模型，不用另外设置。',
      'accounts.cardTitle': '账号池 + 择优',
      'accounts.countError': '读取账号数失败：{reason}',
      'accounts.addGuide': '点下面的「＋ 添加一个账号」手动加一个。',
      'accounts.plainTitle': '账号（一般不用管）',
      'accounts.plainExplain': '会自动使用你已经在 DSH 里配置好的 API Key（比如 OpenCode Go、小米等），你不用在这里填任何密钥。',
      'accounts.plainCount': '当前有 {n} 个账号（DSH 已配置的路由 + 路由链自动派生）。',
      'accounts.countLoading': '正在读取账号池…',
      'accounts.countEmpty': '尚未在 DSH 中配置任何 API Key，请先在 DSH 设置里添加。',
      'chains.errNoModel': '第 {n} 组还没选模型，保存已取消。',
      'chains.errNoHop': '第 {n} 组还没有任何一步（服务商 / 模型），保存已取消。',
      'chains.errEmptyHop': '第 {n} 组第 {step} 步还没选全服务商 / 模型，保存已取消。',
      'chains.errBlocked': '有 {n} 组链路没填完整（见下方红字），这次没有保存；补齐后再点保存。',
      'chains.clearCustom': '清空自定义（恢复自动发现）',
      'chains.clearConfirm': '确认清空？',
      'chains.clearHint': '清空后由系统自动发现可用模型，不再使用你手写的顺序。',
      'chains.hintShort': '未配置链路时使用内置默认顺序；清空后恢复自动发现。',
      'chains.otherGroups': '其他链路（{n}）',
      'chains.cleared': '已清空自定义链路，改回自动发现（无需重启）',
      'accounts.errNoProvider': '账号「{name}」还没选服务商，保存已取消。',
      'accounts.errNoName': '第 {n} 个账号还没填名字，保存已取消（不想加就点删除）。',
      'accounts.errBlocked': '有 {n} 个账号没填完整（见下方红字），这次没有保存；补齐后再点保存。',
      'ranking.title': '分级择优（详细）', 'ranking.enabled': '启用智能选择',
      'ranking.enabledHelp': '不勾选 = 关闭；从未设置时默认开启（勾选态即 Host 的默认值）。关闭后完全保持旧行为：route 优先 + 最少使用。',
      'ranking.strategy': '策略预设',
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
      'cost.plainExplain': '花费来自后台真实记账，这里只显示真实数字。',
      'cost.detailLoading': '正在读取明细…',
      'cost.expandAll': '展开全部 {n} 笔',
      'cost.overviewLine': '{total} · {n} 笔 · 节省 {savings}',
      'cost.loading': '正在读取花费…', 'cost.loadFailed': '读取花费失败：{reason}',
      'cost.detailBlock': '详细数据（共 {n} 条记录）',
      'cost.detailNone': '还没有调用记录',
      'cost.detailFailed': '读取明细失败：{reason}',
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
      'health.accountSummary': '账号池 {n} · 冷却 {k}', 'health.routeSummary': '路由 {m} · 降级 {j}',
      'health.accountModels': '模型：{models}', 'health.accountRemain': '剩余冷却 {remain}',
      'health.health': '健康', 'health.coolReason': '冷却原因', 'health.usage': '尝试次数', 'health.empty': '暂无数据。',
      'health.plainExplain': '数据来自后台实时注册表；无样本显示「暂无数据」，不假装健康。',
      'health.loading': '正在读取账号健康…',
      'health.noChannel': '当前设置页还没拿到账号健康数据通道，暂时无法显示真实状态（后台可能已有记录）。下面的诊断信息可帮助定位。',
      'health.disabledExplain': '健康层当前是关闭的：配置里 health:false、health.enabled:false 或 ranking.health.enabled:false 任意一处关掉都会停用。关闭期间不做健康判断，这里如实说明，不会假装一切正常。',
      'health.state': '状态', 'health.stateUnknown': '暂无数据', 'health.stateActive': '健康',
      'health.stateCooling': '冷却中', 'health.stateHalfOpen': '半开待验证', 'health.streak': '连续失败', 'health.samples': '成功 / 失败',
      'health.implicit': '（自动派生）', 'health.model': '模型', 'health.tier': '计费档',
      'health.billing': '资费', 'health.billingHint': '免费标签分实测 / 声明 / 未实测；零样本显示「暂无数据」，不会把弱信号说成已确认。',
      'health.freeDeclared': '声明免费（倍率 0）',
      'health.freeWeak': '可能免费（未实测）', 'health.freeNone': '暂无数据',
      'health.confidence': '可信度',
      'health.snapshotAt': '快照时间 {time}', 'health.refresh': '重新读取',
      'health.refreshing': '读取中…', 'health.noSamples': '暂无样本',
      'health.confHigh': '高', 'health.confMedium': '中', 'health.confLow': '低', 'health.confUnknown': '未知',
      'health.lastSeen': '最近成功 {ok} · 最近失败 {fail}', 'health.never': '无',
      'health.soon': '即将到期',
      'health.durationHour': '{h} 小时 {m} 分', 'health.durationMinute': '{m} 分 {s} 秒',
      'health.durationSecond': '{s} 秒',
      'health.tierFree': '免费', 'health.tierMetered': '计费', 'health.tierUnknown': '未知',
      'health.healthHealthy': '健康', 'health.healthDegraded': '降级',
      'health.healthDeprecated': '已弃用', 'health.healthUnknown': '暂无数据',
      'error.saveFailed': '保存失败，请重试。',
      // CF-2/BX2: conversation cost-pill config labels + first-screen settings card.
      'costPill.cardTitle': '对话页消耗显示', 'costPill.cardHelp': '开启后回对话页看输入框旁的预估金额；清理统计只重置起点，历史账本保留。无需重启。',
      'costPill.enabled': '显示预估总额', 'costPill.enabledHelp': '默认关闭；勾选后回对话页看输入框旁的累计估算成本（位置见下方）。',
      'costPill.position': '显示位置', 'costPill.positionHelp': '选择对话页挂载点；默认输入框右侧紧凑位。',
      'costPill.pos.conversation.input.right': '输入框右侧（紧凑）', 'costPill.pos.conversation.session.header.utilities': '会话标题栏工具区', 'costPill.pos.conversation.input.dock': '输入框上方条目',
      'costPill.refreshMs': '自动刷新间隔（毫秒）', 'costPill.refreshMsHelp': '默认 60000 毫秒；填 0 表示不自动刷新，手动刷新按钮常驻。有效最小 1000 毫秒。', 'costPill.refreshInvalid': '请填 0 或不小于 1000 的毫秒数。',
      'costPill.monitor': '监控', 'costPill.autoRefresh': '定时刷新', 'costPill.refreshNow': '立即刷新',
      'costPill.since': '统计起点：{since}', 'costPill.noSince': '统计起点：全部历史',
      'costPill.clear': '从现在重新统计', 'costPill.clearConfirm': '只设置新统计起点，不删除成本账本。确定继续？',
      'costPill.cleared': '新的统计起点：{since}',
      'costPill.clearNote': '只重置显示起点，历史账本保留，健康证据不受影响。',
      'costPill.error': '暂无法读取或更新统计数据，请稍后重试。',
      'tab.overview': '概览',
      'tab.routing': '路由',
      'tab.cost': '花费',
      'ranking.w.cost': '成本',
      'ranking.w.speed': '速度',
      'ranking.w.tier': '等级',
      'ranking.w.load': '负载',
      'cost.col.time': '时间',
      'cost.col.model': '模型',
      'cost.col.tokens': '令牌',
      'cost.col.ttft': '首令牌延迟',
      'cost.col.tps': '每秒令牌',
      'cost.col.cost': '成本',
      'cost.col.status': '状态',
      'health.freeMeasured': '实测免费',
      'health.freeMeasuredPrice': '实测免费（价格表）',
      'health.freeMeasuredProbe': '实测免费（探测）',
      'health.freeMeasuredBilling': '实测免费（账单）',
    }
const en = {
      nav: 'Smart provider',
      'action.save': 'Save', 'action.saved': 'Saved — live without restart',
      'action.refresh': 'Refresh', 'action.retry': 'Retry', 'action.confirmDelete': 'Confirm delete?',
      'card.unsaved': '● Unsaved',
      'diag.title': 'Diagnostics (collapsed unless something failed)',
      'tab.unsavedGuard': 'You have unsaved changes — switch anyway?',
      'tab.switchAnyway': 'Switch (discard changes)',
      'tab.stayHere': 'Stay on this page', 'status.yes': 'Yes', 'status.no': 'No',
      'advanced.title': '⚙ Details (fine-tune here — all dropdowns and buttons, no code)',
      'action.delete': 'Remove', 'action.addHop': '+ Add fallback', 'action.addChain': '+ Add a model group', 'action.addAccount': '+ Add an account',
      'chains.modelLabel': 'This model:',
      'field.accountName': 'Name:', 'field.accountNamePh': 'Give it a name, e.g. Main',
      'field.provider': 'Provider:', 'field.credential': 'Which key to use:',
      'field.credentialPh': 'Empty = use your signed-in DSH account; or type a new reference name',
      'field.models': 'Available models:', 'field.tier': 'Importance:',
      'field.model': 'Model:',
      'cost.estimated': 'Estimated cost', 'cost.records': 'Records', 'cost.savings': 'Savings',
      'tier.premium': 'Primary (use first)', 'tier.standard': 'Standard', 'tier.backup': 'Backup (use last)',
      'account.detailsTitle': 'Billing and tier details (optional)',
      'account.speedTier': 'Response speed', 'account.speedTierHelp': 'Fast = preferred when scores tie. Ranking only — never a capability claim.',
      'account.speedFast': 'Fast', 'account.speedNormal': 'Normal', 'account.speedSlow': 'Slow',
      'account.priceTier': 'Price tier (fallback)', 'account.priceTierHelp': 'Used only when the price table has no entry for this route and no unit price is set.',
      'account.priceFree': 'Free', 'account.priceLow': 'Cheap', 'account.priceMid': 'Medium', 'account.priceHigh': 'Expensive',
      'account.costModel': 'How it bills', 'account.costModelHelp': 'Metered = per token; Subscription = quota-based cost; Free = cost counted as 0.',
      'account.costMetered': 'Metered', 'account.costSubscription': 'Subscription (quota)', 'account.costFree': 'Free',
      'account.quotaCost': 'Quota cost', 'account.quotaCostHelp': '0–1: how much one quota unit costs relative to metered pricing. Lower ranks first.',
      'account.priceMultiplier': 'Price multiplier (0 = free)',
      'account.priceMultiplierHelp': 'Blank = default 1; 0 = free account; 0.8 = 20% off. Only numbers ≥0 are accepted; invalid values fall back to 1.',
      'account.priceMultiplierPh': 'default 1',
      'account.priceMultiplierInvalid': 'Price multiplier "{value}" is invalid — saved as 1 (numbers ≥0 only).',
      'account.priority': 'Priority', 'account.priorityHelp': 'Lower number wins (0 highest); only orders accounts inside the same tier.',
      'account.modelSearch': 'Search models…', 'account.freeOnly': 'Free only',
      'account.selectedCount': '{n} selected', 'account.selectAll': 'Select all', 'account.clear': 'Clear',
      'account.moreModels': '{n} more hidden — use the search above',
      'ranking.tierHigh': 'Prefer higher-tier accounts', 'ranking.tierLow': 'Burn backups first',
      'ranking.priorityHard': 'Strict order (higher tier first)', 'ranking.prioritySoft': 'Only as a tie-breaker',
      'hero.configured': 'Smart routing is using your saved setting',
      'hero.configuredExplain': 'Picking with the "{strategy}" style — switching automatically if a model fails.',
      'hero.defaultTitle': 'Smart routing uses the built-in balanced default',
      'hero.defaultExplain': 'You have not chosen a strategy yet, so the built-in balanced default applies: pick candidate models by task, then balance within them. Tap a button to switch.',
      'pi.available': 'Models you already configured in DSH',
      'pi.availableN': 'Models recognised ({models} models / {providers} providers)',
      'pi.diagnostics': 'Diagnostics (self-check and probe feedback)',
      'overview.healthLoading': 'Reading account health…',
      'overview.healthNoChannel': 'Account health unavailable (no data channel) — open Cost & health for diagnostics',
      'overview.healthLine': '{accounts} accounts · {cooling} cooling down — open account health',
      'overview.factLine': '{chains} chains · {accounts} accounts · {strategy}',
      'status.builtinDefault': 'built-in balanced default',
      'star.link': 'Star on GitHub',
      'pi.loading': 'Reading your configured models…',
      'pi.empty': 'No configured models found yet — add one on Settings → Models.',
      'pi.providers': 'Providers', 'pi.models': 'Available models',
      'pi.providerNames': 'Found: {names}',
      'pi.smartTag': 'Smart Gateway (smart routing, not a standalone model provider)',
      'pi.maybeFree': 'Possibly free models (broad match — better to over-list than miss):',
      'pi.freeCount': '{n} possibly free',
      'pi.probeBtn': 'Re-probe these models (auto-checked once; force refresh)',
      'pi.noMaybeFree': 'No possibly-free models found',
      'pi.otherModels': 'Other registered models ({n}) — expand to view',
      'pi.availableTag': 'available (verified)', 'pi.unknownTag': 'billing unconfirmed',
      'pi.freeConfirmedTag': 'confirmed free', 'pi.freePossibleTag': 'possibly free (unverified)',
      'pi.freeModelsHint': 'Status comes from real usage: "available" only with enough success samples; otherwise "billing unconfirmed" (not "unavailable"). All entries stay listed regardless.',
      'pi.otherProvidersHint': 'Free models and availability from Trae / Qoder / WorkBuddy and other plugins are managed by those plugins, not marked here.',
      'preset.pick': 'How should it choose? Tap one (change anytime)',
      'preset.balanced': '⚖ Balanced (recommended)', 'preset.balancedSub': 'Reliable and thrifty — good for most people',
      'preset.cost': '💰 Save money', 'preset.costSub': 'Prefer the cheapest models',
      'preset.speed': '⚡ Be fast', 'preset.speedSub': 'Prefer the quickest models',
      'preset.applying': 'Saving your choice…',
      'preset.applied': 'Switched to "{name}" — live now',
      'chains.cardTitle': 'Chains (model fallback order)',
      'chains.plainTitle': 'Model fallback order',
      'chains.plainExplain': 'Smart routing tries these in order: top to bottom, switching automatically if one fails. These are models you already configured in DSH — nothing extra to set.',
      'accounts.cardTitle': 'Accounts + ranking',
      'accounts.countError': 'Could not read the account count: {reason}',
      'accounts.addGuide': 'Use “+ Add an account” below to add one manually.',
      'accounts.plainTitle': 'Accounts (usually nothing to do)',
      'accounts.plainExplain': 'It automatically uses the API keys you already configured in DSH (e.g. OpenCode Go, Xiaomi). You don\'t need to enter any key here.',
      'accounts.plainCount': '{n} account(s) in the live pool (DSH-configured routes + chain-derived accounts).',
      'accounts.countLoading': 'Reading the account pool…',
      'accounts.countEmpty': 'No API keys configured in DSH yet — add one in DSH settings first.',
      'chains.errNoModel': 'Model #{n} has no model selected — save cancelled.',
      'chains.errNoHop': 'Model #{n} has no step (provider / model) yet — save cancelled.',
      'chains.errEmptyHop': 'Model #{n} step {step} is missing a provider or model — save cancelled.',
      'chains.errBlocked': '{n} chain(s) are incomplete (see the red notes) — nothing was saved. Fix them and save again.',
      'chains.clearCustom': 'Clear custom chains (back to auto-discovery)',
      'chains.clearConfirm': 'Clear for sure?',
      'chains.clearHint': 'Clearing hands routing back to automatic discovery of your configured models.',
      'chains.hintShort': 'No chains configured — built-in default order is used; clearing restores auto-discovery.',
      'chains.otherGroups': 'Other chains ({n})',
      'chains.cleared': 'Custom chains cleared — automatic discovery is active again (no restart)',
      'accounts.errNoProvider': 'Account "{name}" has no provider selected — save cancelled.',
      'accounts.errNoName': 'Account #{n} has no name — save cancelled (delete the row if you do not want it).',
      'accounts.errBlocked': '{n} account(s) are incomplete (see the red notes) — nothing was saved. Fix them and save again.',
      'ranking.title': 'Ranking', 'ranking.enabled': 'Enable ranking',
      'ranking.enabledHelp': 'Unchecked = off; when never set it is ON by default (the checked state mirrors the Host default). Off keeps legacy behavior: route-first then least-used.',
      'ranking.strategy': 'Strategy',
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
      'cost.plainExplain': 'Spend comes from the real Host ledger — no invented numbers.',
      'cost.detailLoading': 'Loading detail…',
      'cost.expandAll': 'Show all {n} calls',
      'cost.overviewLine': '{total} · {n} calls · saved {savings}',
      'cost.loading': 'Reading spend…', 'cost.loadFailed': 'Could not read spend: {reason}',
      'cost.detailBlock': 'Detailed data ({n} records)',
      'cost.detailNone': 'No calls recorded yet',
      'cost.detailFailed': 'Could not read detail rows: {reason}',
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
      'health.accountSummary': 'Accounts {n} · cooling {k}', 'health.routeSummary': 'Routes {m} · degraded {j}',
      'health.accountModels': 'Models: {models}', 'health.accountRemain': 'Cooldown left {remain}',
      'health.health': 'Health', 'health.coolReason': 'Cool reason', 'health.usage': 'Attempts', 'health.empty': 'No data yet.',
      'health.plainExplain': 'From the live registry; zero samples read "No data yet" — never a fake green.',
      'health.loading': 'Reading account health…',
      'health.noChannel': 'The settings page has no account-health channel yet, so real state cannot be shown (the Host may already have records). Diagnostics below help locate it.',
      'health.disabledExplain': 'The health layer is switched off: any one of health:false, health.enabled:false or ranking.health.enabled:false disables it. While off, no health judgement is made — stated plainly here instead of pretending everything is fine.',
      'health.state': 'State', 'health.stateUnknown': 'No data yet', 'health.stateActive': 'Healthy',
      'health.stateCooling': 'Cooling down', 'health.stateHalfOpen': 'Half-open, awaiting check', 'health.streak': 'Fail streak', 'health.samples': 'Success / failure',
      'health.implicit': '(auto-derived)', 'health.model': 'Model', 'health.tier': 'Billing tier',
      'health.billing': 'Pricing', 'health.billingHint': 'Free labels are measured / declared / untested; zero samples read \"No data yet\" and weak signals are never called confirmed.',
      'health.freeDeclared': 'Declared free (multiplier 0)',
      'health.freeWeak': 'Possibly free (untested)', 'health.freeNone': 'No data yet',
      'health.confidence': 'Confidence',
      'health.snapshotAt': 'Snapshot {time}', 'health.refresh': 'Read again',
      'health.refreshing': 'Reading…', 'health.noSamples': 'No samples yet',
      'health.confHigh': 'High', 'health.confMedium': 'Medium', 'health.confLow': 'Low', 'health.confUnknown': 'Unknown',
      'health.lastSeen': 'Last success {ok} · last failure {fail}', 'health.never': 'none',
      'health.soon': 'expiring soon',
      'health.durationHour': '{h} h {m} min', 'health.durationMinute': '{m} min {s} s',
      'health.durationSecond': '{s} s',
      'health.tierFree': 'Free', 'health.tierMetered': 'Metered', 'health.tierUnknown': 'Unknown',
      'health.healthHealthy': 'Healthy', 'health.healthDegraded': 'Degraded',
      'health.healthDeprecated': 'Deprecated', 'health.healthUnknown': 'No data yet',
      'error.saveFailed': 'Save failed, please retry.',
      // CF-2/BX2: conversation cost-pill config labels + first-screen settings card.
      'costPill.cardTitle': 'Conversation cost display', 'costPill.cardHelp': 'Turn it on, then look beside the input box in the conversation for the estimate. Clearing statistics only resets the start marker; the full ledger is kept. No restart needed.',
      'costPill.enabled': 'Show estimated total', 'costPill.enabledHelp': 'Off by default; once checked, look beside the conversation input for the accumulated estimate (position below).',
      'costPill.position': 'Display position', 'costPill.positionHelp': 'Conversation slot for the pill; compact input-right by default.',
      'costPill.pos.conversation.input.right': 'Input right (compact)', 'costPill.pos.conversation.session.header.utilities': 'Session header utilities', 'costPill.pos.conversation.input.dock': 'Input dock',
      'costPill.refreshMs': 'Auto-refresh interval (ms)', 'costPill.refreshMsHelp': 'Default 60000 ms; enter 0 to disable auto-refresh. Manual refresh stays available. Valid minimum 1000 ms.', 'costPill.refreshInvalid': 'Enter 0 or at least 1000 ms.',
      'costPill.monitor': 'Monitor', 'costPill.autoRefresh': 'Auto-refresh', 'costPill.refreshNow': 'Refresh now',
      'costPill.since': 'Statistics start: {since}', 'costPill.noSince': 'Statistics start: all history',
      'costPill.clear': 'Restart statistics from now', 'costPill.clearConfirm': 'This only sets a new start marker; the cost ledger is never deleted. Continue?',
      'costPill.cleared': 'New statistics start: {since}',
      'costPill.clearNote': 'This only resets the display start marker. The full ledger is kept and health evidence is unaffected.',
      'costPill.error': 'Statistics could not be read or updated. Please retry shortly.',
      'tab.overview': 'Overview',
      'tab.routing': 'Routing',
      'tab.cost': 'Cost',
      'ranking.w.cost': 'Cost',
      'ranking.w.speed': 'Speed',
      'ranking.w.tier': 'Tier',
      'ranking.w.load': 'Load',
      'cost.col.time': 'Time',
      'cost.col.model': 'Model',
      'cost.col.tokens': 'Tokens',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Cost',
      'cost.col.status': 'Status',
      'health.freeMeasured': 'Measured free',
      'health.freeMeasuredPrice': 'Measured free (price list)',
      'health.freeMeasuredProbe': 'Measured free (probe)',
      'health.freeMeasuredBilling': 'Measured free (billing)',
    }
const de = {
      nav: 'Smart-Provider',
      'action.save': 'Speichern',
      'action.saved': 'Gespeichert – sofort aktiv, kein Neustart nötig',
      'action.refresh': 'Aktualisieren',
      'action.retry': 'Erneut versuchen',
      'action.confirmDelete': 'Wirklich löschen?',
      'card.unsaved': '● Ungespeichert',
      'diag.title': 'Diagnoseinformationen (standardmäßig eingeklappt, nur bei Fehlern aufgeklappt)',
      'tab.unsavedGuard': 'Sie haben ungespeicherte Änderungen – trotzdem wechseln?',
      'tab.switchAnyway': 'Wechseln (Änderungen verwerfen)',
      'tab.stayHere': 'Auf dieser Seite bleiben',
      'status.yes': 'Ja',
      'status.no': 'Nein',
      'advanced.title': '⚙ Detaileinstellungen (hier feinjustieren – alles Dropdowns und Schaltflächen, kein Code)',
      'action.delete': 'Entfernen',
      'action.addHop': '+ Fallback hinzufügen',
      'action.addChain': '+ Modellgruppe hinzufügen',
      'action.addAccount': '+ Konto hinzufügen',
      'chains.modelLabel': 'Dieses Modell:',
      'field.accountName': 'Name:',
      'field.accountNamePh': 'Geben Sie einen Namen ein, z. B. Hauptkonto',
      'field.provider': 'Anbieter:',
      'field.credential': 'Welchen Key verwenden:',
      'field.credentialPh': 'Leer = angemeldetes DSH-Konto verwenden; oder einen neuen Referenznamen eingeben',
      'field.models': 'Verfügbare Modelle:',
      'field.tier': 'Wichtigkeit:',
      'field.model': 'Modell:',
      'cost.estimated': 'Geschätzte Kosten',
      'cost.records': 'Einträge',
      'cost.savings': 'Einsparungen',
      'tier.premium': 'Primär (zuerst verwenden)',
      'tier.standard': 'Standard',
      'tier.backup': 'Backup (zuletzt verwenden)',
      'account.detailsTitle': 'Abrechnungs- und Stufendetails (optional)',
      'account.speedTier': 'Antwortgeschwindigkeit',
      'account.speedTierHelp': 'Schnell = bei gleicher Bewertung bevorzugt. Beeinflusst nur die Rangfolge, keine Verfügbarkeitsaussage.',
      'account.speedFast': 'Schnell',
      'account.speedNormal': 'Normal',
      'account.speedSlow': 'Langsam',
      'account.priceTier': 'Preisstufe (Ersatz)',
      'account.priceTierHelp': 'Wird nur verwendet, wenn die Preistabelle keinen Eintrag für diese Route enthält und kein Einzelpreis gesetzt ist.',
      'account.priceFree': 'Kostenlos',
      'account.priceLow': 'Günstig',
      'account.priceMid': 'Mittel',
      'account.priceHigh': 'Teuer',
      'account.costModel': 'Abrechnungsart',
      'account.costModelHelp': 'Verbrauchsabhängig = pro Token; Abonnement = kontingentbasiert; Kostenlos = Kosten werden als 0 gewertet.',
      'account.costMetered': 'Verbrauchsabhängig',
      'account.costSubscription': 'Abonnement (Kontingent)',
      'account.costFree': 'Kostenlos',
      'account.quotaCost': 'Kontingentkosten',
      'account.quotaCostHelp': '0–1: Kosten einer Kontingenteinheit im Vergleich zum Verbrauchspreis. Niedrigere Werte werden zuerst gewählt.',
      'account.priceMultiplier': 'Preisfaktor (0 = kostenlos)',
      'account.priceMultiplierHelp': 'Leer = Standard 1; 0 = kostenloses Konto; 0,8 = 20 % Rabatt. Nur Zahlen ≥ 0 sind zulässig; ungültige Werte fallen auf 1 zurück.',
      'account.priceMultiplierPh': 'Standard 1',
      'account.priceMultiplierInvalid': 'Preisfaktor „{value}“ ist ungültig – als 1 gespeichert (nur Zahlen ≥ 0).',
      'account.priority': 'Priorität',
      'account.priorityHelp': 'Niedrigere Zahl gewinnt (0 am höchsten); wirkt nur innerhalb derselben Stufe.',
      'account.modelSearch': 'Modelle suchen…',
      'account.freeOnly': 'Nur kostenlose',
      'account.selectedCount': '{n} ausgewählt',
      'account.selectAll': 'Alle auswählen',
      'account.clear': 'Leeren',
      'account.moreModels': '{n} weitere ausgeblendet – nutzen Sie die Suche oben',
      'ranking.tierHigh': 'Höherwertige Konten bevorzugen',
      'ranking.tierLow': 'Backups zuerst verbrauchen',
      'ranking.priorityHard': 'Strenge Reihenfolge (höhere Stufe zuerst)',
      'ranking.prioritySoft': 'Nur als Entscheidungshilfe bei Gleichstand',
      'hero.configured': 'Smart-Routing verwendet Ihre gespeicherte Einstellung',
      'hero.configuredExplain': 'Auswahl nach dem Stil „{strategy}“ – bei Ausfall eines Modells wird automatisch gewechselt.',
      'hero.defaultTitle': 'Smart-Routing verwendet den integrierten Standard (ausgewogen)',
      'hero.defaultExplain': 'Sie haben noch keine Strategie gewählt, daher gilt der integrierte Ausgleichsstandard: Kandidatenmodelle werden nach Aufgabe gewählt und dann untereinander ausgeglichen. Mit einem Button wechseln Sie die Strategie.',
      'pi.available': 'Modelle, die Sie bereits in DSH konfiguriert haben',
      'pi.availableN': 'Erkannte Modelle ({models} Modelle / {providers} Anbieter)',
      'pi.diagnostics': 'Diagnose (Selbstprüfung und Proben-Feedback)',
      'overview.healthLoading': 'Kontozustand wird gelesen…',
      'overview.healthNoChannel': 'Kontozustand nicht verfügbar (kein Datenkanal) – öffnen Sie „Kosten & Zustand“ für Diagnose',
      'overview.healthLine': '{accounts} Konten · {cooling} in Abkühlung – Kontozustand öffnen',
      'overview.factLine': '{chains} Ketten · {accounts} Konten · {strategy}',
      'status.builtinDefault': 'integrierter Ausgleichsstandard',
      'star.link': 'GitHub-Stern vergeben',
      'pi.loading': 'Ihre konfigurierten Modelle werden gelesen…',
      'pi.empty': 'Noch keine konfigurierten Modelle gefunden – fügen Sie eines unter Einstellungen → Modelle hinzu.',
      'pi.providers': 'Anbieter',
      'pi.models': 'Verfügbare Modelle',
      'pi.providerNames': 'Gefunden: {names}',
      'pi.smartTag': 'Smart Gateway (Smart-Routing, kein eigenständiger Modell-Anbieter)',
      'pi.maybeFree': 'Möglicherweise kostenlose Modelle (breite Suche – lieber zu viele als zu wenige):',
      'pi.freeCount': '{n} möglicherweise kostenlos',
      'pi.probeBtn': 'Diese Modelle erneut prüfen (einmal automatisch geprüft; aktualisieren)',
      'pi.noMaybeFree': 'Keine möglicherweise kostenlosen Modelle gefunden',
      'pi.otherModels': 'Weitere registrierte Modelle ({n}) – aufklappen zum Ansehen',
      'pi.availableTag': 'verfügbar (geprüft)',
      'pi.unknownTag': 'Abrechnung unbestätigt',
      'pi.freeConfirmedTag': 'nachweislich kostenlos',
      'pi.freePossibleTag': 'möglicherweise kostenlos (ungeprüft)',
      'pi.freeModelsHint': 'Der Status stammt aus echten Nutzungsdaten: „verfügbar“ nur bei ausreichend erfolgreichen Versuchen, sonst „Abrechnung unbestätigt“ (nicht „nicht verfügbar“). Alle Einträge bleiben unabhängig vom Status gelistet.',
      'pi.otherProvidersHint': 'Kostenlose Modelle und Verfügbarkeit von Trae / Qoder / WorkBuddy und anderen Plugins werden von diesen Plugins verwaltet und hier nicht markiert.',
      'preset.pick': 'Wie soll ausgewählt werden? Einfach antippen (jederzeit änderbar)',
      'preset.balanced': '⚖ Ausgewogen (empfohlen)',
      'preset.balancedSub': 'Zuverlässig und sparsam – für die meisten geeignet',
      'preset.cost': '💰 Geld sparen',
      'preset.costSub': 'Günstigste Modelle bevorzugen',
      'preset.speed': '⚡ Schnell sein',
      'preset.speedSub': 'Schnellste Modelle bevorzugen',
      'preset.applying': 'Ihre Auswahl wird gespeichert…',
      'preset.applied': 'Auf „{name}“ umgestellt – sofort aktiv',
      'chains.cardTitle': 'Ketten (Reihenfolge der Modell-Fallbacks)',
      'chains.plainTitle': 'Reihenfolge der Modell-Fallbacks',
      'chains.plainExplain': 'Smart-Routing probt diese Modelle in der Reihenfolge von oben nach unten und wechselt bei Ausfall automatisch. Es handelt sich um Modelle, die Sie bereits in DSH konfiguriert haben – nichts weiter einzustellen.',
      'accounts.cardTitle': 'Kontopool + Rangfolge',
      'accounts.countError': 'Anzahl der Konten konnte nicht gelesen werden: {reason}',
      'accounts.addGuide': 'Nutzen Sie unten „+ Konto hinzufügen“, um eines manuell anzulegen.',
      'accounts.plainTitle': 'Konten (meist nichts zu tun)',
      'accounts.plainExplain': 'Es werden automatisch die API-Keys verwendet, die Sie bereits in DSH konfiguriert haben (z. B. OpenCode Go, Xiaomi). Sie müssen hier keinen Key eingeben.',
      'accounts.plainCount': '{n} Konto(s) im aktiven Pool (in DSH konfigurierte Routen + aus Ketten abgeleitete Konten).',
      'accounts.countLoading': 'Kontopool wird gelesen…',
      'accounts.countEmpty': 'Noch keine API-Keys in DSH konfiguriert – fügen Sie zuerst einen in den DSH-Einstellungen hinzu.',
      'chains.errNoModel': 'Modell #{n} hat kein Modell ausgewählt – Speichern abgebrochen.',
      'chains.errNoHop': 'Modell #{n} hat noch keinen Schritt (Anbieter / Modell) – Speichern abgebrochen.',
      'chains.errEmptyHop': 'Schritt {step} von Modell #{n} fehlen Anbieter oder Modell – Speichern abgebrochen.',
      'chains.errBlocked': '{n} Kette(n) sind unvollständig (siehe rote Hinweise) – nichts wurde gespeichert. Beheben Sie das und speichern Sie erneut.',
      'chains.clearCustom': 'Eigene Ketten löschen (zurück zur automatischen Erkennung)',
      'chains.clearConfirm': 'Wirklich löschen?',
      'chains.clearHint': 'Nach dem Löschen erkennt das Routing Ihre konfigurierten Modelle wieder automatisch.',
      'chains.hintShort': 'Keine Ketten konfiguriert – integrierte Standardreihenfolge wird verwendet; Löschen stellt die automatische Erkennung wieder her.',
      'chains.otherGroups': 'Weitere Ketten ({n})',
      'chains.cleared': 'Eigene Ketten gelöscht – automatische Erkennung ist wieder aktiv (kein Neustart)',
      'accounts.errNoProvider': 'Konto „{name}“ hat keinen Anbieter ausgewählt – Speichern abgebrochen.',
      'accounts.errNoName': 'Konto #{n} hat keinen Namen – Speichern abgebrochen (löschen Sie die Zeile, wenn Sie es nicht möchten).',
      'accounts.errBlocked': '{n} Konto/Konten sind unvollständig (siehe rote Hinweise) – nichts wurde gespeichert. Beheben Sie das und speichern Sie erneut.',
      'ranking.title': 'Rangfolge',
      'ranking.enabled': 'Rangfolge aktivieren',
      'ranking.enabledHelp': 'Nicht angehakt = aus; wenn nie gesetzt, standardmäßig AN (der Haken spiegelt den Host-Standard). Aus behält das alte Verhalten: Route zuerst, dann am wenigsten genutzt.',
      'ranking.strategy': 'Strategie',
      'ranking.tierDirection': 'Stufenrichtung',
      'ranking.tierDirectionHelp': 'high = höherwertige zuerst; low = Backups zuerst verbrauchen.',
      'ranking.respectHopRoute': 'Hop-Route bevorzugen',
      'ranking.priorityMode': 'Prioritätsmodus',
      'ranking.priorityHelp': 'Hinweis: niedrigere Prioritätszahl gewinnt – umgekehrt zur Stufe (dort gewinnt die höhere).',
      'ranking.probeEnabled': 'Neue Modelle automatisch prüfen (standardmäßig an)',
      'ranking.probeEnabledHelp': 'Standardmäßig an: neue Modelle erhalten eine kleine Anfrage, um Kostenlosigkeit zu prüfen (kostenlos = 0 Kosten, kostenpflichtig ≤ 1 Token, 7 Tage zwischengespeichert). Zum Abmelden ausschalten.',
      'routing.title': 'Zweischichtige Smart-Route',
      'routing.intro': 'Dies sind Ihre gespeicherten Routing-Einstellungen. Speichern übernimmt sie sofort – kein Neustart.',
      'routing.enabled': 'Zweischichtige Route aktivieren',
      'routing.enabledHelp': 'Nicht angehakt = aus; wenn nie gesetzt, standardmäßig AN (der Haken spiegelt den Host-Standard). Strategien sind neutral und gleich gewichtet – keine Bevorzugung von Kosten oder Geschwindigkeit.',
      'routing.strategy': 'Routing-Stil',
      'routing.position': 'Modellposition',
      'routing.positionHelp': 'Nur Lesetext, keine bearbeitbare Tabelle.',
      'routing.positionExplain': 'Jede Modellposition ergibt sich aus den eigenen Fähigkeiten (Denken, Bildverarbeitung, langer Kontext); manche können manuell festgelegt werden. Diese Seite liest keine abgeleiteten Ergebnisse pro Modell.',
      'routing.rulesTitle': 'Wie Aufgaben erkannt werden (nur lesen)',
      'cost.title': 'Kosten & Zustand',
      'cost.plainExplain': 'Die Ausgaben stammen aus dem echten Host-Ledger – keine erfundenen Zahlen.',
      'cost.detailLoading': 'Details werden geladen…',
      'cost.expandAll': 'Alle {n} Aufrufe anzeigen',
      'cost.overviewLine': '{total} · {n} Aufrufe · gespart {savings}',
      'cost.loading': 'Ausgaben werden gelesen…',
      'cost.loadFailed': 'Ausgaben konnten nicht gelesen werden: {reason}',
      'cost.detailBlock': 'Detaillierte Daten ({n} Einträge)',
      'cost.detailNone': 'Noch keine Aufrufe aufgezeichnet',
      'cost.detailFailed': 'Detailzeilen konnten nicht gelesen werden: {reason}',
      'cost.ok': 'OK',
      'cost.failed': 'Fehlgeschlagen',
      'cost.prevPage': 'Zurück',
      'cost.nextPage': 'Weiter',
      'cost.timelineTitle': 'Zeitverlauf (pro Tag, Balkenhöhe = Aufrufe)',
      'cost.byModelTitle': 'Nach Modell (Aufrufe + kumulierte Kosten)',
      'cost.byModelValue': '{calls} Aufrufe · ${cost}',
      'cost.savingsTitle': 'Einsparungen (Schätzung)',
      'cost.savingsNotice': 'Nur eine Schätzung – abgeleitet aus vergleichbaren öffentlichen Preisen oder kostenpflichtigen Zeilen, keine Rechnung. Wenn kein vergleichbarer Preis vorliegt, steht dort „kein vergleichbarer Preis“ statt einer erfundenen 0.',
      'cost.savingsModel': '{model} – kostenlose Aufrufe zum regulären Preis',
      'cost.savingsValue': '~{usd} (geschätzt)',
      'cost.noComparable': 'Kein vergleichbarer Preis',
      'health.title': 'Kontozustand / Abkühlung',
      'health.id': 'Konto',
      'health.provider': 'Route',
      'health.accountSummary': 'Konten {n} · in Abkühlung {k}',
      'health.routeSummary': 'Routen {m} · herabgestuft {j}',
      'health.accountModels': 'Modelle: {models}',
      'health.accountRemain': 'Abkühlung noch {remain}',
      'health.health': 'Zustand',
      'health.coolReason': 'Grund der Abkühlung',
      'health.usage': 'Versuche',
      'health.empty': 'Noch keine Daten.',
      'health.plainExplain': 'Aus der aktuellen Registry; keine Stichproben bedeuten „Noch keine Daten“ – niemals ein falsches Grün.',
      'health.loading': 'Kontozustand wird gelesen…',
      'health.noChannel': 'Der Einstellungsseite fehlt noch der Datenkanal für den Kontozustand, daher kann der echte Zustand nicht angezeigt werden (der Host hat möglicherweise bereits Einträge). Die Diagnose unten hilft bei der Fehlersuche.',
      'health.disabledExplain': 'Die Zustandsebene ist ausgeschaltet: health:false, health.enabled:false oder ranking.health.enabled:false genügt jeweils. Währenddessen wird keine Zustandsbewertung vorgenommen – das wird hier ausdrücklich gesagt, statt so zu tun, als sei alles in Ordnung.',
      'health.state': 'Zustand',
      'health.stateUnknown': 'Noch keine Daten',
      'health.stateActive': 'Gesund',
      'health.stateCooling': 'In Abkühlung',
      'health.stateHalfOpen': 'Halboffen, Prüfung ausstehend',
      'health.streak': 'Fehlerserie',
      'health.samples': 'Erfolg / Fehler',
      'health.implicit': '(automatisch abgeleitet)',
      'health.model': 'Modell',
      'health.tier': 'Abrechnungsstufe',
      'health.billing': 'Preisgestaltung',
      'health.billingHint': 'Kostenlos-Kennzeichnungen sind gemessen / deklariert / ungeprüft; keine Stichproben bedeuten „Noch keine Daten“, und schwache Hinweise werden nie als bestätigt ausgegeben.',
      'health.freeDeclared': 'Deklariert kostenlos (Faktor 0)',
      'health.freeWeak': 'Möglicherweise kostenlos (ungeprüft)',
      'health.freeNone': 'Noch keine Daten',
      'health.confidence': 'Konfidenz',
      'health.snapshotAt': 'Momentaufnahme {time}',
      'health.refresh': 'Erneut lesen',
      'health.refreshing': 'Wird gelesen…',
      'health.noSamples': 'Noch keine Stichproben',
      'health.confHigh': 'Hoch',
      'health.confMedium': 'Mittel',
      'health.confLow': 'Niedrig',
      'health.confUnknown': 'Unbekannt',
      'health.lastSeen': 'Letzter Erfolg {ok} · letzter Fehler {fail}',
      'health.never': 'keine',
      'health.soon': 'läuft bald ab',
      'health.durationHour': '{h} Std. {m} Min.',
      'health.durationMinute': '{m} Min. {s} Sek.',
      'health.durationSecond': '{s} Sek.',
      'health.tierFree': 'Kostenlos',
      'health.tierMetered': 'Verbrauchsabhängig',
      'health.tierUnknown': 'Unbekannt',
      'health.healthHealthy': 'Gesund',
      'health.healthDegraded': 'Herabgestuft',
      'health.healthDeprecated': 'Veraltet',
      'health.healthUnknown': 'Noch keine Daten',
      'error.saveFailed': 'Speichern fehlgeschlagen, bitte erneut versuchen.',
      'costPill.cardTitle': 'Kostenanzeige im Gespräch',
      'costPill.cardHelp': 'Aktivieren Sie die Anzeige und sehen Sie die Schätzung neben dem Eingabefeld im Gespräch. Das Zurücksetzen der Statistik setzt nur den Startmarkierer zurück; das vollständige Ledger bleibt erhalten. Kein Neustart nötig.',
      'costPill.enabled': 'Geschätzte Gesamtsumme anzeigen',
      'costPill.enabledHelp': 'Standardmäßig aus; nach dem Aktivieren sehen Sie die aufgelaufene Schätzung neben der Eingabe (Position unten wählbar).',
      'costPill.position': 'Anzeigeposition',
      'costPill.positionHelp': 'Gesprächs-Slot für die Anzeige; standardmäßig kompakt rechts neben der Eingabe.',
      'costPill.pos.conversation.input.right': 'Rechts der Eingabe (kompakt)',
      'costPill.pos.conversation.session.header.utilities': 'Symbole in der Sitzungskopfzeile',
      'costPill.pos.conversation.input.dock': 'Eingabe-Dock (vollbreit)',
      'costPill.refreshMs': 'Intervall der automatischen Aktualisierung (ms)',
      'costPill.refreshMsHelp': 'Standard 60000 ms; 0 eingeben, um die automatische Aktualisierung zu deaktivieren. Manuelles Aktualisieren bleibt möglich. Mindestens 1000 ms gültig.',
      'costPill.refreshInvalid': '0 oder mindestens 1000 ms eingeben.',
      'costPill.monitor': 'Überwachung',
      'costPill.autoRefresh': 'Automatisch aktualisieren',
      'costPill.refreshNow': 'Jetzt aktualisieren',
      'costPill.since': 'Statistikbeginn: {since}',
      'costPill.noSince': 'Statistikbeginn: gesamter Verlauf',
      'costPill.clear': 'Statistik ab jetzt neu starten',
      'costPill.clearConfirm': 'Damit wird nur ein neuer Startmarkierer gesetzt; das Kosten-Ledger wird nie gelöscht. Fortfahren?',
      'costPill.cleared': 'Neuer Statistikbeginn: {since}',
      'costPill.clearNote': 'Damit wird nur der Anzeige-Startmarkierer zurückgesetzt. Das vollständige Ledger bleibt erhalten und die Zustandsbeweise sind nicht betroffen.',
      'costPill.error': 'Statistik konnte nicht gelesen oder aktualisiert werden. Bitte in Kürze erneut versuchen.',
      'tab.overview': 'Übersicht',
      'tab.routing': 'Routing',
      'tab.cost': 'Kosten',
      'ranking.w.cost': 'Kosten',
      'ranking.w.speed': 'Geschwindigkeit',
      'ranking.w.tier': 'Stufe',
      'ranking.w.load': 'Last',
      'cost.col.time': 'Zeit',
      'cost.col.model': 'Modell',
      'cost.col.tokens': 'Tokens',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Kosten',
      'cost.col.status': 'Status',
      'health.freeMeasured': 'Gemessen kostenlos',
      'health.freeMeasuredPrice': 'Gemessen kostenlos (Preisliste)',
      'health.freeMeasuredProbe': 'Gemessen kostenlos (Sonde)',
      'health.freeMeasuredBilling': 'Gemessen kostenlos (Abrechnung)',
    }
const es = {
      nav: 'Proveedor inteligente',
      'action.save': 'Guardar',
      'action.saved': 'Guardado: activo al instante, sin reiniciar',
      'action.refresh': 'Actualizar',
      'action.retry': 'Reintentar',
      'action.confirmDelete': '¿Eliminar de verdad?',
      'card.unsaved': '● Sin guardar',
      'diag.title': 'Diagnóstico (plegado por defecto; se abre solo si hay errores)',
      'tab.unsavedGuard': 'Tienes cambios sin guardar. ¿Cambiar de página de todos modos?',
      'tab.switchAnyway': 'Cambiar (descartar cambios)',
      'tab.stayHere': 'Quedarse aquí',
      'status.yes': 'Sí',
      'status.no': 'No',
      'advanced.title': '⚙ Ajustes detallados (ajusta aquí: todo son menús y botones, sin código)',
      'action.delete': 'Eliminar',
      'action.addHop': '+ Añadir alternativa',
      'action.addChain': '+ Añadir grupo de modelos',
      'action.addAccount': '+ Añadir cuenta',
      'chains.modelLabel': 'Este modelo:',
      'field.accountName': 'Nombre:',
      'field.accountNamePh': 'Ponle un nombre, p. ej. Principal',
      'field.provider': 'Proveedor:',
      'field.credential': 'Qué clave usar:',
      'field.credentialPh': 'Vacío = usar tu cuenta iniciada en DSH; o escribe un nuevo nombre de referencia',
      'field.models': 'Modelos disponibles:',
      'field.tier': 'Importancia:',
      'field.model': 'Modelo:',
      'cost.estimated': 'Coste estimado',
      'cost.records': 'Registros',
      'cost.savings': 'Ahorro',
      'tier.premium': 'Principal (usar primero)',
      'tier.standard': 'Estándar',
      'tier.backup': 'Respaldo (usar al final)',
      'account.detailsTitle': 'Detalles de facturación y nivel (opcional)',
      'account.speedTier': 'Velocidad de respuesta',
      'account.speedTierHelp': 'Rápida = preferida si hay empate. Solo afecta al orden; no implica disponibilidad.',
      'account.speedFast': 'Rápida',
      'account.speedNormal': 'Normal',
      'account.speedSlow': 'Lenta',
      'account.priceTier': 'Nivel de precio (alternativa)',
      'account.priceTierHelp': 'Se usa solo cuando la tabla de precios no tiene entrada para esta ruta y no hay precio unitario definido.',
      'account.priceFree': 'Gratis',
      'account.priceLow': 'Barato',
      'account.priceMid': 'Medio',
      'account.priceHigh': 'Caro',
      'account.costModel': 'Cómo factura',
      'account.costModelHelp': 'Por consumo = por token; Suscripción = coste por cuota; Gratis = coste contado como 0.',
      'account.costMetered': 'Por consumo',
      'account.costSubscription': 'Suscripción (cuota)',
      'account.costFree': 'Gratis',
      'account.quotaCost': 'Coste de cuota',
      'account.quotaCostHelp': '0–1: cuánto cuesta una unidad de cuota frente al precio por consumo. Los más bajos van primero.',
      'account.priceMultiplier': 'Multiplicador de precio (0 = gratis)',
      'account.priceMultiplierHelp': 'Vacío = 1 por defecto; 0 = cuenta gratuita; 0,8 = 20 % de descuento. Solo se aceptan números ≥ 0; los valores no válidos vuelven a 1.',
      'account.priceMultiplierPh': '1 por defecto',
      'account.priceMultiplierInvalid': 'El multiplicador «{value}» no es válido: se guardó como 1 (solo números ≥ 0).',
      'account.priority': 'Prioridad',
      'account.priorityHelp': 'Gana el número más bajo (0 es el más alto); solo ordena cuentas dentro del mismo nivel.',
      'account.modelSearch': 'Buscar modelos…',
      'account.freeOnly': 'Solo gratis',
      'account.selectedCount': '{n} seleccionados',
      'account.selectAll': 'Seleccionar todo',
      'account.clear': 'Vaciar',
      'account.moreModels': '{n} más ocultos: usa la búsqueda de arriba',
      'ranking.tierHigh': 'Preferir cuentas de nivel superior',
      'ranking.tierLow': 'Consumir primero los respaldos',
      'ranking.priorityHard': 'Orden estricto (primero el nivel superior)',
      'ranking.prioritySoft': 'Solo como desempate',
      'hero.configured': 'El enrutamiento inteligente usa tu ajuste guardado',
      'hero.configuredExplain': 'Elige con el estilo «{strategy}»: si un modelo falla, cambia automáticamente.',
      'hero.defaultTitle': 'El enrutamiento inteligente usa el equilibrado integrado',
      'hero.defaultExplain': 'Aún no has elegido una estrategia, así que se aplica el equilibrado integrado: selecciona candidatos según la tarea y equilíbralos. Pulsa un botón para cambiar.',
      'pi.available': 'Modelos que ya configuraste en DSH',
      'pi.availableN': 'Modelos reconocidos ({models} modelos / {providers} proveedores)',
      'pi.diagnostics': 'Diagnóstico (autocomprobación y resultados de sondeo)',
      'overview.healthLoading': 'Leyendo el estado de las cuentas…',
      'overview.healthNoChannel': 'Estado de cuentas no disponible (sin canal de datos): abre «Coste y estado» para diagnosticar',
      'overview.healthLine': '{accounts} cuentas · {cooling} en enfriamiento: abrir estado de cuentas',
      'overview.factLine': '{chains} cadenas · {accounts} cuentas · {strategy}',
      'status.builtinDefault': 'equilibrado integrado',
      'star.link': 'Dar una estrella en GitHub',
      'pi.loading': 'Leyendo tus modelos configurados…',
      'pi.empty': 'Aún no hay modelos configurados: añade uno en Ajustes → Modelos.',
      'pi.providers': 'Proveedores',
      'pi.models': 'Modelos disponibles',
      'pi.providerNames': 'Encontrados: {names}',
      'pi.smartTag': 'Smart Gateway (enrutamiento inteligente, no un proveedor de modelos independiente)',
      'pi.maybeFree': 'Modelos posiblemente gratuitos (búsqueda amplia: mejor incluir de más que olvidar):',
      'pi.freeCount': '{n} posiblemente gratis',
      'pi.probeBtn': 'Volver a sondear estos modelos (ya se comprobaron una vez; forzar actualización)',
      'pi.noMaybeFree': 'No se encontraron modelos posiblemente gratuitos',
      'pi.otherModels': 'Otros modelos registrados ({n}): despliega para verlos',
      'pi.availableTag': 'disponible (verificado)',
      'pi.unknownTag': 'facturación sin confirmar',
      'pi.freeConfirmedTag': 'gratis confirmado',
      'pi.freePossibleTag': 'posiblemente gratis (sin verificar)',
      'pi.freeModelsHint': 'El estado procede del uso real: «disponible» solo con suficientes muestras correctas; si no, «facturación sin confirmar» (no «no disponible»). Todas las entradas se mantienen en la lista.',
      'pi.otherProvidersHint': 'Los modelos gratuitos y su disponibilidad de Trae / Qoder / WorkBuddy y otros plugins los gestionan esos plugins; no se marcan aquí.',
      'preset.pick': '¿Cómo quieres que elija? Pulsa uno (puedes cambiarlo cuando quieras)',
      'preset.balanced': '⚖ Equilibrado (recomendado)',
      'preset.balancedSub': 'Fiable y económico: va bien para la mayoría',
      'preset.cost': '💰 Ahorrar',
      'preset.costSub': 'Preferir los modelos más baratos',
      'preset.speed': '⚡ Ir rápido',
      'preset.speedSub': 'Preferir los modelos más rápidos',
      'preset.applying': 'Guardando tu elección…',
      'preset.applied': 'Cambiado a «{name}»: activo ahora',
      'chains.cardTitle': 'Cadenas (orden de respaldo de modelos)',
      'chains.plainTitle': 'Orden de respaldo de modelos',
      'chains.plainExplain': 'El enrutamiento inteligente prueba estos modelos de arriba abajo y cambia automáticamente si uno falla. Son modelos que ya configuraste en DSH: no hay nada más que ajustar.',
      'accounts.cardTitle': 'Grupo de cuentas + orden',
      'accounts.countError': 'No se pudo leer el número de cuentas: {reason}',
      'accounts.addGuide': 'Usa «+ Añadir cuenta» abajo para crear una manualmente.',
      'accounts.plainTitle': 'Cuentas (normalmente no hay que hacer nada)',
      'accounts.plainExplain': 'Usa automáticamente las claves API que ya configuraste en DSH (p. ej. OpenCode Go, Xiaomi). No tienes que introducir ninguna clave aquí.',
      'accounts.plainCount': '{n} cuenta(s) en el grupo activo (rutas configuradas en DSH + cuentas derivadas de cadenas).',
      'accounts.countLoading': 'Leyendo el grupo de cuentas…',
      'accounts.countEmpty': 'Aún no hay claves API en DSH: añade una primero en los ajustes de DSH.',
      'chains.errNoModel': 'El modelo n.º {n} no tiene modelo seleccionado: no se guardó.',
      'chains.errNoHop': 'El modelo n.º {n} aún no tiene ningún paso (proveedor / modelo): no se guardó.',
      'chains.errEmptyHop': 'Al modelo n.º {n} le falta proveedor o modelo en el paso {step}: no se guardó.',
      'chains.errBlocked': '{n} cadena(s) están incompletas (ver las notas rojas): no se guardó nada. Corrígelas y guarda de nuevo.',
      'chains.clearCustom': 'Borrar cadenas personalizadas (volver al descubrimiento automático)',
      'chains.clearConfirm': '¿Borrar de verdad?',
      'chains.clearHint': 'Al borrar, el enrutamiento vuelve a descubrir automáticamente tus modelos configurados.',
      'chains.hintShort': 'Sin cadenas configuradas: se usa el orden integrado; borrar restaura el descubrimiento automático.',
      'chains.otherGroups': 'Otras cadenas ({n})',
      'chains.cleared': 'Cadenas personalizadas borradas: el descubrimiento automático está activo de nuevo (sin reinicio)',
      'accounts.errNoProvider': 'La cuenta «{name}» no tiene proveedor seleccionado: no se guardó.',
      'accounts.errNoName': 'La cuenta n.º {n} no tiene nombre: no se guardó (borra la fila si no la quieres).',
      'accounts.errBlocked': '{n} cuenta(s) están incompletas (ver las notas rojas): no se guardó nada. Corrígelas y guarda de nuevo.',
      'ranking.title': 'Orden de preferencia',
      'ranking.enabled': 'Activar el orden',
      'ranking.enabledHelp': 'Sin marcar = desactivado; si nunca se configuró, está ACTIVADO por defecto (la casilla refleja el valor del Host). Desactivado mantiene el comportamiento anterior: primero la ruta, luego el menos usado.',
      'ranking.strategy': 'Estrategia',
      'ranking.tierDirection': 'Dirección del nivel',
      'ranking.tierDirectionHelp': 'high = primero los superiores; low = consumir primero los respaldos.',
      'ranking.respectHopRoute': 'Preferir la ruta del paso',
      'ranking.priorityMode': 'Modo de prioridad',
      'ranking.priorityHelp': 'Nota: gana el número de prioridad más bajo, al contrario que el nivel (donde gana el más alto).',
      'ranking.probeEnabled': 'Sondear modelos nuevos automáticamente (activado por defecto)',
      'ranking.probeEnabledHelp': 'Activado por defecto: los modelos nuevos reciben una petición mínima para detectar si son gratis (gratis = coste 0, de pago ≤ 1 token, en caché 7 días). Desactívalo para no participar.',
      'routing.title': 'Enrutamiento inteligente de dos capas',
      'routing.intro': 'Estos son tus ajustes de enrutamiento guardados. Al guardar se aplican al instante: sin reinicio.',
      'routing.enabled': 'Activar enrutamiento de dos capas',
      'routing.enabledHelp': 'Sin marcar = desactivado; si nunca se configuró, está ACTIVADO por defecto (la casilla refleja el valor del Host). Las estrategias son neutras y de peso igual: no favorecen el coste ni la velocidad.',
      'routing.strategy': 'Estilo de enrutamiento',
      'routing.position': 'Posición del modelo',
      'routing.positionHelp': 'Texto informativo, no una tabla editable.',
      'routing.positionExplain': 'La posición de cada modelo se deriva de sus capacidades (razonamiento, visión, contexto largo); algunas pueden declararse manualmente. Esta página no lee los resultados derivados por modelo.',
      'routing.rulesTitle': 'Cómo se reconocen las tareas (solo lectura)',
      'cost.title': 'Coste y estado',
      'cost.plainExplain': 'El gasto viene del registro real del Host: no hay cifras inventadas.',
      'cost.detailLoading': 'Cargando detalles…',
      'cost.expandAll': 'Mostrar las {n} llamadas',
      'cost.overviewLine': '{total} · {n} llamadas · ahorrado {savings}',
      'cost.loading': 'Leyendo el gasto…',
      'cost.loadFailed': 'No se pudo leer el gasto: {reason}',
      'cost.detailBlock': 'Datos detallados ({n} registros)',
      'cost.detailNone': 'Aún no hay llamadas registradas',
      'cost.detailFailed': 'No se pudieron leer las filas de detalle: {reason}',
      'cost.ok': 'Correcto',
      'cost.failed': 'Fallido',
      'cost.prevPage': 'Anterior',
      'cost.nextPage': 'Siguiente',
      'cost.timelineTitle': 'Línea temporal (por día; altura de barra = llamadas)',
      'cost.byModelTitle': 'Por modelo (llamadas + coste acumulado)',
      'cost.byModelValue': '{calls} llamadas · ${cost}',
      'cost.savingsTitle': 'Registro de ahorro (estimado)',
      'cost.savingsNotice': 'Solo una estimación: se calcula a partir de precios públicos comparables o filas de pago, no es una factura. Si no hay precio comparable, dice «sin precio comparable» en lugar de inventar un 0.',
      'cost.savingsModel': '{model}: llamadas gratis a precio de pago',
      'cost.savingsValue': '~{usd} (estimado)',
      'cost.noComparable': 'Sin precio comparable',
      'health.title': 'Estado de cuentas / enfriamiento',
      'health.id': 'Cuenta',
      'health.provider': 'Ruta',
      'health.accountSummary': 'Cuentas {n} · en enfriamiento {k}',
      'health.routeSummary': 'Rutas {m} · degradadas {j}',
      'health.accountModels': 'Modelos: {models}',
      'health.accountRemain': 'Enfriamiento restante {remain}',
      'health.health': 'Estado',
      'health.coolReason': 'Motivo de enfriamiento',
      'health.usage': 'Intentos',
      'health.empty': 'Aún no hay datos.',
      'health.plainExplain': 'Del registro activo: sin muestras significa «Aún no hay datos», nunca un verde falso.',
      'health.loading': 'Leyendo el estado de las cuentas…',
      'health.noChannel': 'La página de ajustes aún no tiene canal de estado de cuentas, así que no se puede mostrar el estado real (el Host puede tener registros). El diagnóstico de abajo ayuda a localizarlo.',
      'health.disabledExplain': 'La capa de estado está desactivada: basta health:false, health.enabled:false o ranking.health.enabled:false. Mientras esté off no se emite ningún juicio de estado; se dice claramente aquí en lugar de fingir que todo va bien.',
      'health.state': 'Estado',
      'health.stateUnknown': 'Aún no hay datos',
      'health.stateActive': 'Saludable',
      'health.stateCooling': 'En enfriamiento',
      'health.stateHalfOpen': 'Semicerrado, a la espera de comprobación',
      'health.streak': 'Racha de fallos',
      'health.samples': 'Aciertos / fallos',
      'health.implicit': '(derivado automáticamente)',
      'health.model': 'Modelo',
      'health.tier': 'Nivel de facturación',
      'health.billing': 'Precios',
      'health.billingHint': 'Las etiquetas de gratuidad son medidas / declaradas / sin probar; sin muestras se lee «Aún no hay datos» y nunca se llama confirmado a una señal débil.',
      'health.freeDeclared': 'Declarado gratis (multiplicador 0)',
      'health.freeWeak': 'Posiblemente gratis (sin probar)',
      'health.freeNone': 'Aún no hay datos',
      'health.confidence': 'Confianza',
      'health.snapshotAt': 'Instantánea {time}',
      'health.refresh': 'Leer de nuevo',
      'health.refreshing': 'Leyendo…',
      'health.noSamples': 'Aún no hay muestras',
      'health.confHigh': 'Alta',
      'health.confMedium': 'Media',
      'health.confLow': 'Baja',
      'health.confUnknown': 'Desconocida',
      'health.lastSeen': 'Último acierto {ok} · último fallo {fail}',
      'health.never': 'ninguno',
      'health.soon': 'caduca pronto',
      'health.durationHour': '{h} h {m} min',
      'health.durationMinute': '{m} min {s} s',
      'health.durationSecond': '{s} s',
      'health.tierFree': 'Gratis',
      'health.tierMetered': 'Por consumo',
      'health.tierUnknown': 'Desconocido',
      'health.healthHealthy': 'Saludable',
      'health.healthDegraded': 'Degradado',
      'health.healthDeprecated': 'Obsoleto',
      'health.healthUnknown': 'Aún no hay datos',
      'error.saveFailed': 'No se pudo guardar; inténtalo de nuevo.',
      'costPill.cardTitle': 'Visualización de coste en la conversación',
      'costPill.cardHelp': 'Actívala y mira junto al cuadro de entrada de la conversación para ver la estimación. Reiniciar las estadísticas solo restablece el marcador de inicio; el registro completo se conserva. Sin reinicio.',
      'costPill.enabled': 'Mostrar total estimado',
      'costPill.enabledHelp': 'Desactivado por defecto; al activarlo verás el total acumulado junto a la entrada (posición más abajo).',
      'costPill.position': 'Posición de visualización',
      'costPill.positionHelp': 'Espacio de la conversación donde se muestra; por defecto compacto a la derecha de la entrada.',
      'costPill.pos.conversation.input.right': 'Derecha de la entrada (compacto)',
      'costPill.pos.conversation.session.header.utilities': 'Utilidades de la cabecera de sesión',
      'costPill.pos.conversation.input.dock': 'Dock de entrada (ancho completo)',
      'costPill.refreshMs': 'Intervalo de actualización automática (ms)',
      'costPill.refreshMsHelp': 'Por defecto 60000 ms; introduce 0 para desactivar la actualización automática. La actualización manual sigue disponible. Mínimo válido: 1000 ms.',
      'costPill.refreshInvalid': 'Introduce 0 o al menos 1000 ms.',
      'costPill.monitor': 'Supervisión',
      'costPill.autoRefresh': 'Actualización automática',
      'costPill.refreshNow': 'Actualizar ahora',
      'costPill.since': 'Inicio de estadísticas: {since}',
      'costPill.noSince': 'Inicio de estadísticas: todo el historial',
      'costPill.clear': 'Reiniciar estadísticas desde ahora',
      'costPill.clearConfirm': 'Esto solo establece un nuevo marcador de inicio; el registro de costes nunca se borra. ¿Continuar?',
      'costPill.cleared': 'Nuevo inicio de estadísticas: {since}',
      'costPill.clearNote': 'Esto solo restablece el marcador de inicio de la visualización. El registro completo se conserva y las pruebas de estado no se ven afectadas.',
      'costPill.error': 'No se pudieron leer o actualizar las estadísticas. Inténtalo de nuevo en breve.',
      'tab.overview': 'Resumen',
      'tab.routing': 'Enrutamiento',
      'tab.cost': 'Costo',
      'ranking.w.cost': 'Costo',
      'ranking.w.speed': 'Velocidad',
      'ranking.w.tier': 'Nivel',
      'ranking.w.load': 'Carga',
      'cost.col.time': 'Hora',
      'cost.col.model': 'Modelo',
      'cost.col.tokens': 'Tokens',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Costo',
      'cost.col.status': 'Estado',
      'health.freeMeasured': 'Gratis medido',
      'health.freeMeasuredPrice': 'Gratis medido (lista de precios)',
      'health.freeMeasuredProbe': 'Gratis medido (sonda)',
      'health.freeMeasuredBilling': 'Gratis medido (facturación)',
    }
    const fr = {
      nav: 'Fournisseur intelligent',
      'action.save': 'Enregistrer', 'action.saved': 'Enregistré — actif immédiatement, sans redémarrage',
      'action.refresh': 'Actualiser', 'action.retry': 'Réessayer', 'action.confirmDelete': 'Confirmer la suppression ?',
      'card.unsaved': '● Non enregistré',
      'diag.title': 'Diagnostics (repliés par défaut, dépliés uniquement en cas d’erreur)',
      'tab.unsavedGuard': 'Vous avez des modifications non enregistrées — changer quand même ?',
      'tab.switchAnyway': 'Changer (abandonner les modifications)',
      'tab.stayHere': 'Rester sur cette page', 'status.yes': 'Oui', 'status.no': 'Non',
      'advanced.title': '⚙ Paramètres détaillés (affinez ici — uniquement des listes déroulantes et des boutons, aucun code)',
      'action.delete': 'Supprimer', 'action.addHop': '+ Ajouter un repli', 'action.addChain': '+ Ajouter un groupe de modèles', 'action.addAccount': '+ Ajouter un compte',
      'chains.modelLabel': 'Ce modèle :',
      'field.accountName': 'Nom :', 'field.accountNamePh': 'Donnez-lui un nom, p. ex. Compte principal',
      'field.provider': 'Fournisseur :', 'field.credential': 'Quelle clé utiliser :',
      'field.credentialPh': 'Vide = utiliser votre compte DSH connecté ; ou saisir un nouveau nom de référence',
      'field.models': 'Modèles disponibles :', 'field.tier': 'Importance :',
      'field.model': 'Modèle :',
      'cost.estimated': 'Coût estimé', 'cost.records': 'Enregistrements', 'cost.savings': 'Économies',
      'tier.premium': 'Principal (à utiliser en premier)', 'tier.standard': 'Standard', 'tier.backup': 'Secours (à utiliser en dernier)',
      'account.detailsTitle': 'Détails de facturation et de niveau (facultatif)',
      'account.speedTier': 'Vitesse de réponse', 'account.speedTierHelp': 'Rapide = privilégié à score égal. Influence uniquement le classement, jamais une garantie de disponibilité.',
      'account.speedFast': 'Rapide', 'account.speedNormal': 'Normal', 'account.speedSlow': 'Lent',
      'account.priceTier': 'Palette de prix (solution de repli)', 'account.priceTierHelp': 'Utilisée uniquement lorsque le tableau de prix ne contient pas cette route et qu’aucun prix unitaire n’est renseigné.',
      'account.priceFree': 'Gratuit', 'account.priceLow': 'Bon marché', 'account.priceMid': 'Moyen', 'account.priceHigh': 'Cher',
      'account.costModel': 'Mode de facturation', 'account.costModelHelp': 'À l’usage = au token ; Abonnement = coût basé sur le quota ; Gratuit = coût compté comme 0.',
      'account.costMetered': 'À l’usage', 'account.costSubscription': 'Abonnement (quota)', 'account.costFree': 'Gratuit',
      'account.quotaCost': 'Coût du quota', 'account.quotaCostHelp': '0–1 : coût d’une unité de quota par rapport à la facturation à l’usage. Les valeurs les plus basses sont privilégiées.',
      'account.priceMultiplier': 'Multiplicateur de prix (0 = gratuit)',
      'account.priceMultiplierHelp': 'Vide = 1 par défaut ; 0 = compte gratuit ; 0,8 = 20 % de réduction. Seuls les nombres ≥ 0 sont acceptés ; une valeur invalide est remplacée par 1.',
      'account.priceMultiplierPh': '1 par défaut',
      'account.priceMultiplierInvalid': 'Le multiplicateur de prix « {value} » est invalide — enregistré comme 1 (nombres ≥ 0 uniquement).',
      'account.priority': 'Priorité', 'account.priorityHelp': 'Le nombre le plus bas l’emporte (0 = plus haute priorité) ; ne classe que les comptes d’un même niveau.',
      'account.modelSearch': 'Rechercher des modèles…', 'account.freeOnly': 'Gratuits uniquement',
      'account.selectedCount': '{n} sélectionné(s)', 'account.selectAll': 'Tout sélectionner', 'account.clear': 'Effacer',
      'account.moreModels': '{n} autres masqués — utilisez la recherche ci-dessus',
      'ranking.tierHigh': 'Privilégier les comptes de niveau supérieur', 'ranking.tierLow': 'Consommer d’abord les comptes de secours',
      'ranking.priorityHard': 'Ordre strict (niveau supérieur d’abord)', 'ranking.prioritySoft': 'Uniquement comme critère de départage',
      'hero.configured': 'Le routage intelligent utilise votre enregistrement',
      'hero.configuredExplain': 'Sélection selon le style « {strategy} » — bascule automatiquement si un modèle échoue.',
      'hero.defaultTitle': 'Le routage intelligent utilise l’option équilibrée intégrée',
      'hero.defaultExplain': 'Vous n’avez pas encore choisi de stratégie : l’option équilibrée intégrée s’applique — les modèles candidats sont choisis selon la tâche, puis équilibrés entre eux. Cliquez sur un bouton pour changer.',
      'pi.available': 'Modèles déjà configurés dans DSH',
      'pi.availableN': 'Modèles reconnus ({models} modèles / {providers} fournisseurs)',
      'pi.diagnostics': 'Diagnostics (auto-vérification et retours des sondes)',
      'overview.healthLoading': 'Lecture de l’état des comptes…',
      'overview.healthNoChannel': 'État des comptes indisponible (aucun canal de données) — ouvrez « Coûts et santé » pour le diagnostic',
      'overview.healthLine': '{accounts} comptes · {cooling} en refroidissement — ouvrir l’état des comptes',
      'overview.factLine': '{chains} chaînes · {accounts} comptes · {strategy}',
      'status.builtinDefault': 'option équilibrée intégrée',
      'star.link': 'Star sur GitHub',
      'pi.loading': 'Lecture de vos modèles configurés…',
      'pi.empty': 'Aucun modèle configuré pour le moment — ajoutez-en un dans Paramètres → Modèles.',
      'pi.providers': 'Fournisseurs', 'pi.models': 'Modèles disponibles',
      'pi.providerNames': 'Trouvés : {names}',
      'pi.smartTag': 'Smart Gateway (routage intelligent, pas un fournisseur de modèles indépendant)',
      'pi.maybeFree': 'Modèles potentiellement gratuits (critères larges — mieux vaut trop en lister que d’en manquer) :',
      'pi.freeCount': '{n} potentiellement gratuits',
      'pi.probeBtn': 'Relancer la détection de ces modèles (déjà sondés une fois ; forcer l’actualisation)',
      'pi.noMaybeFree': 'Aucun modèle potentiellement gratuit trouvé',
      'pi.otherModels': 'Autres modèles enregistrés ({n}) — déplier pour consulter',
      'pi.availableTag': 'disponible (vérifié)', 'pi.unknownTag': 'facturation non confirmée',
      'pi.freeConfirmedTag': 'gratuit confirmé', 'pi.freePossibleTag': 'potentiellement gratuit (non vérifié)',
      'pi.freeModelsHint': 'Le statut provient d’utilisations réelles : « disponible » uniquement avec suffisamment de réussites, sinon « facturation non confirmée » (et non « indisponible »). Toutes les entrées restent listées quel que soit le statut.',
      'pi.otherProvidersHint': 'Les modèles gratuits et la disponibilité de Trae / Qoder / WorkBuddy et autres plugins sont gérés par ces plugins et ne sont pas indiqués ici.',
      'preset.pick': 'Comment doit-il choisir ? Cliquez sur une option (modifiable à tout moment)',
      'preset.balanced': '⚖ Équilibré (recommandé)', 'preset.balancedSub': 'Fiable et économique — convient à la plupart des utilisateurs',
      'preset.cost': '💰 Économiser', 'preset.costSub': 'Privilégier les modèles les moins chers',
      'preset.speed': '⚡ Aller vite', 'preset.speedSub': 'Privilégier les modèles les plus rapides',
      'preset.applying': 'Enregistrement de votre choix…',
      'preset.applied': 'Passé à « {name} » — actif immédiatement',
      'chains.cardTitle': 'Chaînes (ordre de repli des modèles)',
      'chains.plainTitle': 'Ordre de repli des modèles',
      'chains.plainExplain': 'Le routage intelligent essaie ces modèles de haut en bas et bascule automatiquement en cas d’échec. Ce sont des modèles déjà configurés dans DSH — rien de plus à régler.',
      'accounts.cardTitle': 'Comptes et classement',
      'accounts.countError': 'Impossible de lire le nombre de comptes : {reason}',
      'accounts.addGuide': 'Utilisez « + Ajouter un compte » ci-dessous pour en créer un manuellement.',
      'accounts.plainTitle': 'Comptes (généralement rien à faire)',
      'accounts.plainExplain': 'Les clés API déjà configurées dans DSH sont utilisées automatiquement (p. ex. OpenCode Go, Xiaomi). Vous n’avez aucune clé à saisir ici.',
      'accounts.plainCount': '{n} compte(s) dans le pool actif (routes configurées dans DSH + comptes dérivés des chaînes).',
      'accounts.countLoading': 'Lecture du pool de comptes…',
      'accounts.countEmpty': 'Aucune clé API configurée dans DSH — ajoutez-en d’abord une dans les paramètres DSH.',
      'chains.errNoModel': 'Le modèle n°{n} n’a pas de modèle sélectionné — enregistrement annulé.',
      'chains.errNoHop': 'Le modèle n°{n} n’a pas encore d’étape (fournisseur / modèle) — enregistrement annulé.',
      'chains.errEmptyHop': 'L’étape {step} du modèle n°{n} est incomplète (fournisseur ou modèle manquant) — enregistrement annulé.',
      'chains.errBlocked': '{n} chaîne(s) sont incomplètes (voir les notes rouges) — rien n’a été enregistré. Corrigez-les puis enregistrez à nouveau.',
      'chains.clearCustom': 'Effacer les chaînes personnalisées (retour à la détection automatique)',
      'chains.clearConfirm': 'Effacer vraiment ?',
      'chains.clearHint': 'L’effacement redonne au routage la détection automatique de vos modèles configurés.',
      'chains.hintShort': 'Aucune chaîne configurée — l’ordre par défaut intégré est utilisé ; l’effacement rétablit la détection automatique.',
      'chains.otherGroups': 'Autres chaînes ({n})',
      'chains.cleared': 'Chaînes personnalisées effacées — la détection automatique est de nouveau active (sans redémarrage)',
      'accounts.errNoProvider': 'Le compte « {name} » n’a pas de fournisseur sélectionné — enregistrement annulé.',
      'accounts.errNoName': 'Le compte n°{n} n’a pas de nom — enregistrement annulé (supprimez la ligne si vous ne la souhaitez pas).',
      'accounts.errBlocked': '{n} compte(s) sont incomplets (voir les notes rouges) — rien n’a été enregistré. Corrigez-les puis enregistrez à nouveau.',
      'ranking.title': 'Classement', 'ranking.enabled': 'Activer le classement',
      'ranking.enabledHelp': 'Non coché = désactivé ; jamais défini = activé par défaut (la case reflète la valeur par défaut de l’hôte). Désactivé conserve l’ancien comportement : route d’abord, puis modèle le moins utilisé.',
      'ranking.strategy': 'Stratégie',
      'ranking.tierDirection': 'Sens des niveaux', 'ranking.tierDirectionHelp': 'high = niveaux supérieurs d’abord ; low = consommer d’abord les comptes de secours.',
      'ranking.respectHopRoute': 'Privilégier la route par étape', 'ranking.priorityMode': 'Mode de priorité',
      'ranking.priorityHelp': 'Remarque : un numéro de priorité plus bas l’emporte — contrairement au niveau (où le plus haut l’emporte).',
      'ranking.probeEnabled': 'Sonder automatiquement les nouveaux modèles (activé par défaut)', 'ranking.probeEnabledHelp': 'Activé par défaut : chaque nouveau modèle reçoit une toute petite requête pour détecter s’il est gratuit (gratuit = coût 0, payant ≤ 1 token, résultat mis en cache 7 jours). Désactivez pour refuser.',
      'routing.title': 'Routage intelligent à deux niveaux', 'routing.intro': 'Voici vos paramètres de routage enregistrés. L’enregistrement les applique immédiatement — sans redémarrage.',
      'routing.enabled': 'Activer le routage à deux niveaux', 'routing.enabledHelp': 'Non coché = désactivé ; jamais défini = activé par défaut (la case reflète la valeur par défaut de l’hôte). Les stratégies sont neutres et de poids égal — aucune préférence pour le coût ou la vitesse.',
      'routing.strategy': 'Style de routage',
      'routing.position': 'Position du modèle', 'routing.positionHelp': 'Explication en lecture seule, tableau non modifiable.',
      'routing.positionExplain': 'Chaque position d’un modèle découle de ses propres capacités (raisonnement, vision, contexte long) ; certaines peuvent être déclarées manuellement. Cette page ne lit pas les résultats calculés par modèle.',
      'routing.rulesTitle': 'Comment les tâches sont reconnues (lecture seule)',
      'cost.title': 'Coûts et santé',
      'cost.plainExplain': 'Les dépenses proviennent du registre réel de l’hôte — aucun chiffre inventé.',
      'cost.detailLoading': 'Chargement du détail…',
      'cost.expandAll': 'Afficher les {n} appels',
      'cost.overviewLine': '{total} · {n} appels · {savings} économisés',
      'cost.loading': 'Lecture des dépenses…', 'cost.loadFailed': 'Impossible de lire les dépenses : {reason}',
      'cost.detailBlock': 'Données détaillées ({n} enregistrements)',
      'cost.detailNone': 'Aucun appel enregistré pour le moment',
      'cost.detailFailed': 'Impossible de lire les lignes de détail : {reason}',
      'cost.ok': 'OK', 'cost.failed': 'Échec',
      'cost.prevPage': 'Précédent', 'cost.nextPage': 'Suivant',
      'cost.timelineTitle': 'Chronologie (par jour, hauteur des barres = appels)',
      'cost.byModelTitle': 'Par modèle (appels + coût cumulé)',
      'cost.byModelValue': '{calls} appels · ${cost}',
      'cost.savingsTitle': 'Registre des économies (estimation)',
      'cost.savingsNotice': 'Estimation uniquement — calculée à partir de prix publics comparables ou de lignes payantes, ce n’est pas une facture. Lorsqu’aucun prix comparable n’existe, l’indication est « aucun prix comparable » plutôt qu’un 0 inventé.',
      'cost.savingsModel': '{model} — appels gratuits au prix payant',
      'cost.savingsValue': '~{usd} (estimé)',
      'cost.noComparable': 'Aucun prix comparable',
      'health.title': 'État des comptes / refroidissement', 'health.id': 'Compte', 'health.provider': 'Route',
      'health.accountSummary': 'Comptes {n} · en refroidissement {k}', 'health.routeSummary': 'Routes {m} · dégradées {j}',
      'health.accountModels': 'Modèles : {models}', 'health.accountRemain': 'Refroidissement restant {remain}',
      'health.health': 'État', 'health.coolReason': 'Motif de refroidissement', 'health.usage': 'Tentatives', 'health.empty': 'Aucune donnée pour le moment.',
      'health.plainExplain': 'Données du registre en direct ; zéro échantillon affiche « Aucune donnée pour le moment » — jamais un faux vert.',
      'health.loading': 'Lecture de l’état des comptes…',
      'health.noChannel': 'La page de paramètres ne dispose pas encore d’un canal pour l’état des comptes ; l’état réel ne peut donc pas être affiché (l’hôte peut déjà avoir des données). Le diagnostic ci-dessous aide à le localiser.',
      'health.disabledExplain': 'La couche d’état est désactivée : health:false, health.enabled:false ou ranking.health.enabled:false suffit. Tant qu’elle est inactive, aucune évaluation n’est faite — c’est indiqué ici clairement plutôt que de prétendre que tout va bien.',
      'health.state': 'État', 'health.stateUnknown': 'Aucune donnée pour le moment', 'health.stateActive': 'Sain',
      'health.stateCooling': 'En refroidissement', 'health.stateHalfOpen': 'À moitié ouvert, vérification en attente', 'health.streak': 'Série d’échecs', 'health.samples': 'Réussites / échecs',
      'health.implicit': '(dérivé automatiquement)', 'health.model': 'Modèle', 'health.tier': 'Niveau de facturation',
      'health.billing': 'Tarification', 'health.billingHint': 'Les mentions gratuites sont mesurées / déclarées / non testées ; zéro échantillon affiche « Aucune donnée pour le moment » et les signaux faibles ne sont jamais présentés comme confirmés.',
      'health.freeDeclared': 'Déclaré gratuit (multiplicateur 0)',
      'health.freeWeak': 'Potentiellement gratuit (non testé)', 'health.freeNone': 'Aucune donnée pour le moment',
      'health.confidence': 'Confiance',
      'health.snapshotAt': 'Instantané {time}', 'health.refresh': 'Relire',
      'health.refreshing': 'Lecture…', 'health.noSamples': 'Aucun échantillon pour le moment',
      'health.confHigh': 'Élevée', 'health.confMedium': 'Moyenne', 'health.confLow': 'Faible', 'health.confUnknown': 'Inconnue',
      'health.lastSeen': 'Dernière réussite {ok} · dernier échec {fail}', 'health.never': 'aucune',
      'health.soon': 'expire bientôt',
      'health.durationHour': '{h} h {m} min', 'health.durationMinute': '{m} min {s} s',
      'health.durationSecond': '{s} s',
      'health.tierFree': 'Gratuit', 'health.tierMetered': 'À l’usage', 'health.tierUnknown': 'Inconnu',
      'health.healthHealthy': 'Sain', 'health.healthDegraded': 'Dégradé',
      'health.healthDeprecated': 'Obsolète', 'health.healthUnknown': 'Aucune donnée pour le moment',
      'error.saveFailed': 'Échec de l’enregistrement, veuillez réessayer.',
      // CF-2/BX2: conversation cost-pill config labels + first-screen settings card.
      'costPill.cardTitle': 'Affichage des coûts dans la conversation', 'costPill.cardHelp': 'Activez l’affichage, puis consultez l’estimation à côté du champ de saisie dans la conversation. Réinitialiser les statistiques ne fait que replacer le repère de début ; le registre complet est conservé. Aucun redémarrage nécessaire.',
      'costPill.enabled': 'Afficher le total estimé', 'costPill.enabledHelp': 'Désactivé par défaut ; une fois activé, l’estimation cumulée apparaît à côté du champ de saisie (position configurable ci-dessous).',
      'costPill.position': 'Position d’affichage', 'costPill.positionHelp': 'Emplacement dans la conversation ; compact à droite de la saisie par défaut.',
      'costPill.pos.conversation.input.right': 'À droite de la saisie (compact)', 'costPill.pos.conversation.session.header.utilities': 'Outils de l’en-tête de session', 'costPill.pos.conversation.input.dock': 'Zone de saisie (pleine largeur)',
      'costPill.refreshMs': 'Intervalle d’actualisation automatique (ms)', 'costPill.refreshMsHelp': '60000 ms par défaut ; saisissez 0 pour désactiver l’actualisation automatique. L’actualisation manuelle reste disponible. Minimum valide : 1000 ms.', 'costPill.refreshInvalid': 'Saisissez 0 ou au moins 1000 ms.',
      'costPill.monitor': 'Surveillance', 'costPill.autoRefresh': 'Actualisation automatique', 'costPill.refreshNow': 'Actualiser maintenant',
      'costPill.since': 'Début des statistiques : {since}', 'costPill.noSince': 'Début des statistiques : historique complet',
      'costPill.clear': 'Redémarrer les statistiques maintenant', 'costPill.clearConfirm': 'Cela ne définit qu’un nouveau repère de début ; le registre des coûts n’est jamais supprimé. Continuer ?',
      'costPill.cleared': 'Nouveau début des statistiques : {since}',
      'costPill.clearNote': 'Cela ne réinitialise que le repère de début de l’affichage. Le registre complet est conservé et les preuves de santé ne sont pas affectées.',
      'costPill.error': 'Les statistiques n’ont pas pu être lues ou mises à jour. Veuillez réessayer dans un instant.',
      'tab.overview': 'Aperçu',
      'tab.routing': 'Routage',
      'tab.cost': 'Coût',
      'ranking.w.cost': 'Coût',
      'ranking.w.speed': 'Rapidité',
      'ranking.w.tier': 'Niveau',
      'ranking.w.load': 'Charge',
      'cost.col.time': 'Heure',
      'cost.col.model': 'Modèle',
      'cost.col.tokens': 'Jetons',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Coût',
      'cost.col.status': 'Statut',
      'health.freeMeasured': 'Gratuit mesuré',
      'health.freeMeasuredPrice': 'Gratuit mesuré (tarif)',
      'health.freeMeasuredProbe': 'Gratuit mesuré (sonde)',
      'health.freeMeasuredBilling': 'Gratuit mesuré (facturation)',
    }
    const pt = {
      nav: 'Provedor inteligente',
      'action.save': 'Salvar', 'action.saved': 'Salvo — ativo imediatamente, sem reinício',
      'action.refresh': 'Atualizar', 'action.retry': 'Tentar novamente', 'action.confirmDelete': 'Confirmar exclusão?',
      'card.unsaved': '● Não salvo',
      'diag.title': 'Diagnóstico (recolhido por padrão, expandido apenas em caso de erro)',
      'tab.unsavedGuard': 'Você tem alterações não salvas — trocar mesmo assim?',
      'tab.switchAnyway': 'Trocar (descartar alterações)',
      'tab.stayHere': 'Permanecer nesta página', 'status.yes': 'Sim', 'status.no': 'Não',
      'advanced.title': '⚙ Configurações avançadas (ajuste aqui — apenas listas suspensas e botões, sem código)',
      'action.delete': 'Remover', 'action.addHop': '+ Adicionar alternativa', 'action.addChain': '+ Adicionar grupo de modelos', 'action.addAccount': '+ Adicionar conta',
      'chains.modelLabel': 'Este modelo:',
      'field.accountName': 'Nome:', 'field.accountNamePh': 'Dê um nome, p. ex. Conta principal',
      'field.provider': 'Provedor:', 'field.credential': 'Qual chave usar:',
      'field.credentialPh': 'Vazio = usar sua conta DSH conectada; ou informe um novo nome de referência',
      'field.models': 'Modelos disponíveis:', 'field.tier': 'Importância:',
      'field.model': 'Modelo:',
      'cost.estimated': 'Custo estimado', 'cost.records': 'Registros', 'cost.savings': 'Economias',
      'tier.premium': 'Principal (usar primeiro)', 'tier.standard': 'Padrão', 'tier.backup': 'Reserva (usar por último)',
      'account.detailsTitle': 'Detalhes de cobrança e nível (opcional)',
      'account.speedTier': 'Velocidade de resposta', 'account.speedTierHelp': 'Rápido = preferido em caso de empate. Afeta apenas a classificação, nunca uma garantia de disponibilidade.',
      'account.speedFast': 'Rápido', 'account.speedNormal': 'Normal', 'account.speedSlow': 'Lento',
      'account.priceTier': 'Faixa de preço (alternativa)', 'account.priceTierHelp': 'Usada apenas quando a tabela de preços não contém esta rota e nenhum preço unitário foi informado.',
      'account.priceFree': 'Gratuito', 'account.priceLow': 'Barato', 'account.priceMid': 'Médio', 'account.priceHigh': 'Caro',
      'account.costModel': 'Como é cobrado', 'account.costModelHelp': 'Por uso = por token; Assinatura = custo baseado em cota; Gratuito = custo contado como 0.',
      'account.costMetered': 'Por uso', 'account.costSubscription': 'Assinatura (cota)', 'account.costFree': 'Gratuito',
      'account.quotaCost': 'Custo da cota', 'account.quotaCostHelp': '0–1: quanto uma unidade de cota custa em relação à cobrança por uso. Valores menores são preferidos.',
      'account.priceMultiplier': 'Multiplicador de preço (0 = gratuito)',
      'account.priceMultiplierHelp': 'Em branco = 1 por padrão; 0 = conta gratuita; 0,8 = 20% de desconto. Somente números ≥ 0 são aceitos; valores inválidos voltam a 1.',
      'account.priceMultiplierPh': 'padrão 1',
      'account.priceMultiplierInvalid': 'Multiplicador de preço "{value}" é inválido — salvo como 1 (apenas números ≥ 0).',
      'account.priority': 'Prioridade', 'account.priorityHelp': 'Menor número vence (0 = mais alto); ordena apenas contas do mesmo nível.',
      'account.modelSearch': 'Pesquisar modelos…', 'account.freeOnly': 'Apenas gratuitos',
      'account.selectedCount': '{n} selecionado(s)', 'account.selectAll': 'Selecionar todos', 'account.clear': 'Limpar',
      'account.moreModels': '{n} ocultos — use a busca acima',
      'ranking.tierHigh': 'Preferir contas de nível superior', 'ranking.tierLow': 'Consumir reservas primeiro',
      'ranking.priorityHard': 'Ordem rigorosa (nível superior primeiro)', 'ranking.prioritySoft': 'Apenas como critério de desempate',
      'hero.configured': 'O roteamento inteligente está usando sua configuração salva',
      'hero.configuredExplain': 'Seleção segundo o estilo "{strategy}" — troca automaticamente se um modelo falhar.',
      'hero.defaultTitle': 'O roteamento inteligente usa o padrão equilibrado integrado',
      'hero.defaultExplain': 'Você ainda não escolheu uma estratégia: o padrão equilibrado integrado é aplicado — modelos candidatos são escolhidos pela tarefa e então equilibrados entre si. Clique em um botão para trocar.',
      'pi.available': 'Modelos que você já configurou no DSH',
      'pi.availableN': 'Modelos reconhecidos ({models} modelos / {providers} provedores)',
      'pi.diagnostics': 'Diagnóstico (autoverificação e retornos das sondas)',
      'overview.healthLoading': 'Lendo o estado das contas…',
      'overview.healthNoChannel': 'Estado das contas indisponível (sem canal de dados) — abra Custos e saúde para diagnosticar',
      'overview.healthLine': '{accounts} contas · {cooling} em resfriamento — abrir estado das contas',
      'overview.factLine': '{chains} cadeias · {accounts} contas · {strategy}',
      'status.builtinDefault': 'padrão equilibrado integrado',
      'star.link': 'Star no GitHub',
      'pi.loading': 'Lendo seus modelos configurados…',
      'pi.empty': 'Nenhum modelo configurado encontrado — adicione um em Configurações → Modelos.',
      'pi.providers': 'Provedores', 'pi.models': 'Modelos disponíveis',
      'pi.providerNames': 'Encontrados: {names}',
      'pi.smartTag': 'Smart Gateway (roteamento inteligente, não é um provedor de modelos independente)',
      'pi.maybeFree': 'Modelos possivelmente gratuitos (critérios amplos — antes listar demais do que deixar passar):',
      'pi.freeCount': '{n} possivelmente gratuitos',
      'pi.probeBtn': 'Sondar novamente estes modelos (já sondados uma vez; forçar atualização)',
      'pi.noMaybeFree': 'Nenhum modelo possivelmente gratuito encontrado',
      'pi.otherModels': 'Outros modelos registrados ({n}) — expandir para ver',
      'pi.availableTag': 'disponível (verificado)', 'pi.unknownTag': 'cobrança não confirmada',
      'pi.freeConfirmedTag': 'gratuito confirmado', 'pi.freePossibleTag': 'possivelmente gratuito (não verificado)',
      'pi.freeModelsHint': 'O status vem de uso real: "disponível" apenas com sucessos suficientes; caso contrário, "cobrança não confirmada" (não "indisponível"). Todas as entradas permanecem listadas, independentemente do status.',
      'pi.otherProvidersHint': 'Modelos gratuitos e disponibilidade de Trae / Qoder / WorkBuddy e outros plugins são gerenciados por esses plugins e não são marcados aqui.',
      'preset.pick': 'Como ele deve escolher? Clique em uma opção (alterável a qualquer momento)',
      'preset.balanced': '⚖ Equilibrado (recomendado)', 'preset.balancedSub': 'Confiável e econômico — adequado para a maioria',
      'preset.cost': '💰 Economizar', 'preset.costSub': 'Preferir os modelos mais baratos',
      'preset.speed': '⚡ Ser rápido', 'preset.speedSub': 'Preferir os modelos mais rápidos',
      'preset.applying': 'Salvando sua escolha…',
      'preset.applied': 'Alterado para "{name}" — ativo imediatamente',
      'chains.cardTitle': 'Cadeias (ordem de alternância dos modelos)',
      'chains.plainTitle': 'Ordem de alternância dos modelos',
      'chains.plainExplain': 'O roteamento inteligente tenta estes modelos de cima para baixo e troca automaticamente se um falhar. São modelos que você já configurou no DSH — nada mais a ajustar.',
      'accounts.cardTitle': 'Contas e classificação',
      'accounts.countError': 'Não foi possível ler o número de contas: {reason}',
      'accounts.addGuide': 'Use "+ Adicionar conta" abaixo para criar uma manualmente.',
      'accounts.plainTitle': 'Contas (geralmente nada a fazer)',
      'accounts.plainExplain': 'As chaves de API já configuradas no DSH são usadas automaticamente (p. ex. OpenCode Go, Xiaomi). Você não precisa informar nenhuma chave aqui.',
      'accounts.plainCount': '{n} conta(s) no pool ativo (rotas configuradas no DSH + contas derivadas das cadeias).',
      'accounts.countLoading': 'Lendo o pool de contas…',
      'accounts.countEmpty': 'Nenhuma chave de API configurada no DSH — adicione uma primeiro nas configurações do DSH.',
      'chains.errNoModel': 'Modelo #{n} não tem modelo selecionado — salvamento cancelado.',
      'chains.errNoHop': 'Modelo #{n} ainda não tem etapa (provedor / modelo) — salvamento cancelado.',
      'chains.errEmptyHop': 'Etapa {step} do modelo #{n} está incompleta (falta provedor ou modelo) — salvamento cancelado.',
      'chains.errBlocked': '{n} cadeia(s) estão incompletas (veja os avisos vermelhos) — nada foi salvo. Corrija e salve novamente.',
      'chains.clearCustom': 'Limpar cadeias personalizadas (voltar à descoberta automática)',
      'chains.clearConfirm': 'Tem certeza?',
      'chains.clearHint': 'Limpar devolve ao roteamento a descoberta automática dos seus modelos configurados.',
      'chains.hintShort': 'Nenhuma cadeia configurada — a ordem padrão integrada é usada; limpar restaura a descoberta automática.',
      'chains.otherGroups': 'Outras cadeias ({n})',
      'chains.cleared': 'Cadeias personalizadas limpas — a descoberta automática está ativa novamente (sem reinício)',
      'accounts.errNoProvider': 'Conta "{name}" não tem provedor selecionado — salvamento cancelado.',
      'accounts.errNoName': 'Conta #{n} não tem nome — salvamento cancelado (exclua a linha se não a desejar).',
      'accounts.errBlocked': '{n} conta(s) estão incompletas (veja os avisos vermelhos) — nada foi salvo. Corrija e salve novamente.',
      'ranking.title': 'Classificação', 'ranking.enabled': 'Ativar classificação',
      'ranking.enabledHelp': 'Desmarcado = desativado; nunca definido = ativado por padrão (a marcação reflete o padrão do Host). Desativado mantém o comportamento antigo: rota primeiro, depois menos usado.',
      'ranking.strategy': 'Estratégia',
      'ranking.tierDirection': 'Direção dos níveis', 'ranking.tierDirectionHelp': 'high = níveis superiores primeiro; low = consumir reservas primeiro.',
      'ranking.respectHopRoute': 'Preferir rota por etapa', 'ranking.priorityMode': 'Modo de prioridade',
      'ranking.priorityHelp': 'Atenção: menor número de prioridade vence — ao contrário do nível (em que o maior vence).',
      'ranking.probeEnabled': 'Sondar novos modelos automaticamente (ativado por padrão)', 'ranking.probeEnabledHelp': 'Ativado por padrão: novos modelos recebem uma requisição mínima para detectar se são gratuitos (gratuito = custo 0, pago ≤ 1 token, cache de 7 dias). Desative para não participar.',
      'routing.title': 'Roteamento inteligente em duas camadas', 'routing.intro': 'Estas são suas configurações de roteamento salvas. Salvar aplica imediatamente — sem reinício.',
      'routing.enabled': 'Ativar roteamento em duas camadas', 'routing.enabledHelp': 'Desmarcado = desativado; nunca definido = ativado por padrão (a marcação reflete o padrão do Host). As estratégias são neutras e de peso igual — sem viés para custo ou velocidade.',
      'routing.strategy': 'Estilo de roteamento',
      'routing.position': 'Posição do modelo', 'routing.positionHelp': 'Explicação somente leitura, não é uma tabela editável.',
      'routing.positionExplain': 'Cada posição do modelo deriva de suas próprias capacidades (raciocínio, visão, contexto longo); algumas podem ser declaradas manualmente. Esta página não lê resultados derivados por modelo.',
      'routing.rulesTitle': 'Como as tarefas são reconhecidas (somente leitura)',
      'cost.title': 'Custos e saúde',
      'cost.plainExplain': 'Os gastos vêm do registro real do Host — nenhum número inventado.',
      'cost.detailLoading': 'Carregando detalhes…',
      'cost.expandAll': 'Mostrar todas as {n} chamadas',
      'cost.overviewLine': '{total} · {n} chamadas · economizados {savings}',
      'cost.loading': 'Lendo gastos…', 'cost.loadFailed': 'Não foi possível ler os gastos: {reason}',
      'cost.detailBlock': 'Dados detalhados ({n} registros)',
      'cost.detailNone': 'Nenhuma chamada registrada ainda',
      'cost.detailFailed': 'Não foi possível ler as linhas de detalhe: {reason}',
      'cost.ok': 'OK', 'cost.failed': 'Falhou',
      'cost.prevPage': 'Anterior', 'cost.nextPage': 'Próxima',
      'cost.timelineTitle': 'Linha do tempo (por dia, altura da barra = chamadas)',
      'cost.byModelTitle': 'Por modelo (chamadas + custo acumulado)',
      'cost.byModelValue': '{calls} chamadas · ' + String.fromCharCode(36) + '{cost}',
      'cost.savingsTitle': 'Registro de economias (estimativa)',
      'cost.savingsNotice': 'Apenas uma estimativa — derivada de preços públicos comparáveis ou de linhas pagas, não é uma fatura. Quando não há preço comparável, a indicação é "sem preço comparável", em vez de inventar 0.',
      'cost.savingsModel': '{model} — chamadas gratuitas ao preço pago',
      'cost.savingsValue': '~{usd} (estimado)',
      'cost.noComparable': 'Sem preço comparável',
      'health.title': 'Saúde das contas / resfriamento', 'health.id': 'Conta', 'health.provider': 'Rota',
      'health.accountSummary': 'Contas {n} · em resfriamento {k}', 'health.routeSummary': 'Rotas {m} · degradadas {j}',
      'health.accountModels': 'Modelos: {models}', 'health.accountRemain': 'Resfriamento restante {remain}',
      'health.health': 'Saúde', 'health.coolReason': 'Motivo do resfriamento', 'health.usage': 'Tentativas', 'health.empty': 'Ainda sem dados.',
      'health.plainExplain': 'Dados do registro em tempo real; zero amostras exibem "Ainda sem dados" — nunca um falso verde.',
      'health.loading': 'Lendo o estado das contas…',
      'health.noChannel': 'A página de configurações ainda não tem um canal para o estado das contas; por isso o estado real não pode ser exibido (o Host pode já ter registros). O diagnóstico abaixo ajuda a localizá-lo.',
      'health.disabledExplain': 'A camada de saúde está desativada: health:false, health.enabled:false ou ranking.health.enabled:false é suficiente. Enquanto desativada, nenhuma avaliação é feita — isso é dito explicitamente aqui, em vez de fingir que tudo está bem.',
      'health.state': 'Estado', 'health.stateUnknown': 'Ainda sem dados', 'health.stateActive': 'Saudável',
      'health.stateCooling': 'Em resfriamento', 'health.stateHalfOpen': 'Meio aberto, aguardando verificação', 'health.streak': 'Sequência de falhas', 'health.samples': 'Sucessos / falhas',
      'health.implicit': '(derivado automaticamente)', 'health.model': 'Modelo', 'health.tier': 'Nível de cobrança',
      'health.billing': 'Preços', 'health.billingHint': 'Os rótulos de gratuito são medidos / declarados / não testados; zero amostras exibem "Ainda sem dados" e sinais fracos nunca são apresentados como confirmados.',
      'health.freeDeclared': 'Declarado gratuito (multiplicador 0)',
      'health.freeWeak': 'Possivelmente gratuito (não testado)', 'health.freeNone': 'Ainda sem dados',
      'health.confidence': 'Confiança',
      'health.snapshotAt': 'Instantâneo {time}', 'health.refresh': 'Ler novamente',
      'health.refreshing': 'Lendo…', 'health.noSamples': 'Ainda sem amostras',
      'health.confHigh': 'Alta', 'health.confMedium': 'Média', 'health.confLow': 'Baixa', 'health.confUnknown': 'Desconhecida',
      'health.lastSeen': 'Último sucesso {ok} · última falha {fail}', 'health.never': 'nenhuma',
      'health.soon': 'expirando em breve',
      'health.durationHour': '{h} h {m} min', 'health.durationMinute': '{m} min {s} s',
      'health.durationSecond': '{s} s',
      'health.tierFree': 'Gratuito', 'health.tierMetered': 'Por uso', 'health.tierUnknown': 'Desconhecido',
      'health.healthHealthy': 'Saudável', 'health.healthDegraded': 'Degradado',
      'health.healthDeprecated': 'Obsoleto', 'health.healthUnknown': 'Ainda sem dados',
      'error.saveFailed': 'Falha ao salvar, tente novamente.',
      // CF-2/BX2: conversation cost-pill config labels + first-screen settings card.
      'costPill.cardTitle': 'Exibição de custos na conversa', 'costPill.cardHelp': 'Ative a exibição e veja a estimativa ao lado do campo de entrada na conversa. Limpar as estatísticas apenas redefine o marcador de início; o registro completo é mantido. Sem reinício.',
      'costPill.enabled': 'Mostrar total estimado', 'costPill.enabledHelp': 'Desativado por padrão; após ativar, veja o total acumulado ao lado da entrada (posição configurável abaixo).',
      'costPill.position': 'Posição de exibição', 'costPill.positionHelp': 'Slot da conversa para o indicador; compacto à direita da entrada por padrão.',
      'costPill.pos.conversation.input.right': 'À direita da entrada (compacto)', 'costPill.pos.conversation.session.header.utilities': 'Utilitários do cabeçalho da sessão', 'costPill.pos.conversation.input.dock': 'Área de entrada (largura total)',
      'costPill.refreshMs': 'Intervalo de atualização automática (ms)', 'costPill.refreshMsHelp': 'Padrão 60000 ms; informe 0 para desativar a atualização automática. A atualização manual continua disponível. Mínimo válido: 1000 ms.', 'costPill.refreshInvalid': 'Informe 0 ou pelo menos 1000 ms.',
      'costPill.monitor': 'Monitoramento', 'costPill.autoRefresh': 'Atualização automática', 'costPill.refreshNow': 'Atualizar agora',
      'costPill.since': 'Início das estatísticas: {since}', 'costPill.noSince': 'Início das estatísticas: histórico completo',
      'costPill.clear': 'Reiniciar estatísticas agora', 'costPill.clearConfirm': 'Isso apenas define um novo marcador de início; o registro de custos nunca é apagado. Continuar?',
      'costPill.cleared': 'Novo início das estatísticas: {since}',
      'costPill.clearNote': 'Isso apenas redefine o marcador de início da exibição. O registro completo é mantido e as evidências de saúde não são afetadas.',
      'costPill.error': 'Não foi possível ler ou atualizar as estatísticas. Tente novamente em instantes.',
      'tab.overview': 'Visão geral',
      'tab.routing': 'Roteamento',
      'tab.cost': 'Custo',
      'ranking.w.cost': 'Custo',
      'ranking.w.speed': 'Velocidade',
      'ranking.w.tier': 'Nível',
      'ranking.w.load': 'Carga',
      'cost.col.time': 'Horário',
      'cost.col.model': 'Modelo',
      'cost.col.tokens': 'Tokens',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Custo',
      'cost.col.status': 'Status',
      'health.freeMeasured': 'Gratuito medido',
      'health.freeMeasuredPrice': 'Gratuito medido (tabela de preços)',
      'health.freeMeasuredProbe': 'Gratuito medido (sonda)',
      'health.freeMeasuredBilling': 'Gratuito medido (faturamento)',
    }
const ru = {
      nav: 'Умный провайдер',
      'action.save': 'Сохранить',
      'action.saved': 'Сохранено — применяется сразу, без перезапуска',
      'action.refresh': 'Обновить',
      'action.retry': 'Повторить',
      'action.confirmDelete': 'Подтвердить удаление?',
      'card.unsaved': '● Не сохранено',
      'diag.title': 'Диагностика (свёрнута по умолчанию, раскрывается только при ошибках)',
      'tab.unsavedGuard': 'У вас есть несохранённые изменения — всё равно переключить?',
      'tab.switchAnyway': 'Переключить (отменить изменения)',
      'tab.stayHere': 'Остаться на этой странице',
      'status.yes': 'Да',
      'status.no': 'Нет',
      'advanced.title': '⚙ Подробные настройки (настраивайте здесь — только списки и кнопки, без кода)',
      'action.delete': 'Удалить',
      'action.addHop': '+ Добавить резерв',
      'action.addChain': '+ Добавить группу моделей',
      'action.addAccount': '+ Добавить аккаунт',
      'chains.modelLabel': 'Эта модель:',
      'field.accountName': 'Название:',
      'field.accountNamePh': 'Дайте название, например Основной',
      'field.provider': 'Провайдер:',
      'field.credential': 'Какой ключ использовать:',
      'field.credentialPh': 'Пусто = использовать ваш вошедший аккаунт DSH; или введите новое имя ссылки',
      'field.models': 'Доступные модели:',
      'field.tier': 'Важность:',
      'field.model': 'Модель:',
      'cost.estimated': 'Оценочная стоимость',
      'cost.records': 'Записи',
      'cost.savings': 'Экономия',
      'tier.premium': 'Основной (использовать первым)',
      'tier.standard': 'Стандартный',
      'tier.backup': 'Резервный (использовать последним)',
      'account.detailsTitle': 'Детали тарификации и уровня (необязательно)',
      'account.speedTier': 'Скорость ответа',
      'account.speedTierHelp': 'Быстрый = предпочтительнее при равных оценках. Влияет только на ранжирование — не является утверждением о возможностях.',
      'account.speedFast': 'Быстрый',
      'account.speedNormal': 'Обычный',
      'account.speedSlow': 'Медленный',
      'account.priceTier': 'Ценовой уровень (резервный вариант)',
      'account.priceTierHelp': 'Используется только когда в таблице цен нет записи для этого маршрута и не задана цена за единицу.',
      'account.priceFree': 'Бесплатно',
      'account.priceLow': 'Дешёвый',
      'account.priceMid': 'Средний',
      'account.priceHigh': 'Дорогой',
      'account.costModel': 'Способ тарификации',
      'account.costModelHelp': 'По токенам = плата за токен; Подписка = стоимость по квоте; Бесплатно = стоимость считается равной 0.',
      'account.costMetered': 'По токенам',
      'account.costSubscription': 'Подписка (квота)',
      'account.costFree': 'Бесплатно',
      'account.quotaCost': 'Стоимость квоты',
      'account.quotaCostHelp': '0–1: насколько одна единица квоты дороже цены по токенам. Меньшие значения идут первыми.',
      'account.priceMultiplier': 'Множитель цены (0 = бесплатно)',
      'account.priceMultiplierHelp': 'Пусто = 1 по умолчанию; 0 = бесплатный аккаунт; 0,8 = скидка 20 %. Принимаются только числа ≥ 0; некорректные значения заменяются на 1.',
      'account.priceMultiplierPh': 'по умолчанию 1',
      'account.priceMultiplierInvalid': 'Множитель цены «{value}» некорректен — сохранено как 1 (только числа ≥ 0).',
      'account.priority': 'Приоритет',
      'account.priorityHelp': 'Меньшее число важнее (0 — наивысший); влияет только на порядок аккаунтов внутри одного уровня.',
      'account.modelSearch': 'Поиск моделей…',
      'account.freeOnly': 'Только бесплатные',
      'account.selectedCount': 'Выбрано: {n}',
      'account.selectAll': 'Выбрать все',
      'account.clear': 'Очистить',
      'account.moreModels': 'Ещё {n} скрыто — используйте поиск выше',
      'ranking.tierHigh': 'Предпочитать аккаунты более высокого уровня',
      'ranking.tierLow': 'Сначала расходовать резервные аккаунты',
      'ranking.priorityHard': 'Строгий порядок (сначала высокий уровень)',
      'ranking.prioritySoft': 'Только как дополнительный критерий',
      'hero.configured': 'Умная маршрутизация использует вашу сохранённую настройку',
      'hero.configuredExplain': 'Выбор в стиле «{strategy}» — автоматическое переключение при отказе модели.',
      'hero.defaultTitle': 'Умная маршрутизация использует встроенный сбалансированный режим по умолчанию',
      'hero.defaultExplain': 'Вы ещё не выбрали стратегию, поэтому действует встроенный сбалансированный режим: кандидаты выбираются по задаче, затем балансируются между собой. Нажмите кнопку, чтобы переключиться.',
      'pi.available': 'Модели, уже настроенные вами в DSH',
      'pi.availableN': 'Распознано моделей ({models} моделей / {providers} провайдеров)',
      'pi.diagnostics': 'Диагностика (самопроверка и результаты зондирования)',
      'overview.healthLoading': 'Чтение состояния аккаунтов…',
      'overview.healthNoChannel': 'Состояние аккаунтов недоступно (нет канала данных) — откройте «Расходы и состояние» для диагностики',
      'overview.healthLine': '{accounts} аккаунтов · {cooling} на охлаждении — открыть состояние аккаунтов',
      'overview.factLine': '{chains} цепочек · {accounts} аккаунтов · {strategy}',
      'status.builtinDefault': 'встроенный сбалансированный режим',
      'star.link': 'Поставить звезду на GitHub',
      'pi.loading': 'Чтение ваших настроенных моделей…',
      'pi.empty': 'Настроенные модели пока не найдены — добавьте одну в «Настройки → Модели».',
      'pi.providers': 'Провайдеры',
      'pi.models': 'Доступные модели',
      'pi.providerNames': 'Найдено: {names}',
      'pi.smartTag': 'Smart Gateway (умная маршрутизация, не отдельный провайдер моделей)',
      'pi.maybeFree': 'Возможно бесплатные модели (широкий поиск — лучше включить лишнее, чем упустить):',
      'pi.freeCount': '{n} возможно бесплатных',
      'pi.probeBtn': 'Повторно проверить эти модели (автопроверка уже выполнялась; принудительное обновление)',
      'pi.noMaybeFree': 'Возможно бесплатные модели не найдены',
      'pi.otherModels': 'Другие зарегистрированные модели ({n}) — разверните для просмотра',
      'pi.availableTag': 'доступна (проверено)',
      'pi.unknownTag': 'тарификация не подтверждена',
      'pi.freeConfirmedTag': 'бесплатно подтверждено',
      'pi.freePossibleTag': 'возможно бесплатно (не проверено)',
      'pi.freeModelsHint': 'Статус основан на реальном использовании: «доступна» только при sufficient числе успешных вызовов, иначе «тарификация не подтверждена» (не «недоступна»). Все записи остаются в списке независимо от статуса.',
      'pi.otherProvidersHint': 'Бесплатные модели и доступность от Trae / Qoder / WorkBuddy и других плагинов управляются этими плагинами, здесь они не отмечаются.',
      'preset.pick': 'Как выбирать? Нажмите один вариант (можно изменить в любой момент)',
      'preset.balanced': '⚖ Сбалансированный (рекомендуется)',
      'preset.balancedSub': 'Надёжно и экономно — подходит большинству пользователей',
      'preset.cost': '💰 Экономить',
      'preset.costSub': 'Предпочитать самые дешёвые модели',
      'preset.speed': '⚡ Быстрее',
      'preset.speedSub': 'Предпочитать самые быстрые модели',
      'preset.applying': 'Сохранение вашего выбора…',
      'preset.applied': 'Переключено на «{name}» — применяется сразу',
      'chains.cardTitle': 'Цепочки (порядок резервирования моделей)',
      'chains.plainTitle': 'Порядок резервирования моделей',
      'chains.plainExplain': 'Умная маршрутизация пробует их по порядку: сверху вниз, автоматически переключаясь при отказе. Это модели, уже настроенные вами в DSH — ничего дополнительно настраивать не нужно.',
      'accounts.cardTitle': 'Аккаунты и ранжирование',
      'accounts.countError': 'Не удалось прочитать число аккаунтов: {reason}',
      'accounts.addGuide': 'Используйте «+ Добавить аккаунт» ниже, чтобы добавить аккаунт вручную.',
      'accounts.plainTitle': 'Аккаунты (обычно ничего делать не нужно)',
      'accounts.plainExplain': 'Автоматически используются API-ключи, уже настроенные вами в DSH (например, OpenCode Go, Xiaomi). Здесь не нужно вводить ключи.',
      'accounts.plainCount': '{n} аккаунтов в активном пуле (маршруты из DSH + аккаунты, производные от цепочек).',
      'accounts.countLoading': 'Чтение пула аккаунтов…',
      'accounts.countEmpty': 'В DSH ещё не настроены API-ключи — сначала добавьте один в настройках DSH.',
      'chains.errNoModel': 'У модели №{n} не выбрана модель — сохранение отменено.',
      'chains.errNoHop': 'У модели №{n} нет ни одного шага (провайдер / модель) — сохранение отменено.',
      'chains.errEmptyHop': 'У модели №{n} шаг {step} не имеет провайдера или модели — сохранение отменено.',
      'chains.errBlocked': '{n} цепочек неполные (см. красные примечания) — ничего не сохранено. Исправьте их и сохраните снова.',
      'chains.clearCustom': 'Очистить пользовательские цепочки (вернуться к автообнаружению)',
      'chains.clearConfirm': 'Действительно очистить?',
      'chains.clearHint': 'Очистка возвращает маршрутизацию к автоматическому обнаружению ваших настроенных моделей.',
      'chains.hintShort': 'Цепочки не настроены — используется встроенный порядок по умолчанию; очистка восстанавливает автообнаружение.',
      'chains.otherGroups': 'Другие цепочки ({n})',
      'chains.cleared': 'Пользовательские цепочки очищены — автообнаружение снова активно (без перезапуска)',
      'accounts.errNoProvider': 'У аккаунта «{name}» не выбран провайдер — сохранение отменено.',
      'accounts.errNoName': 'У аккаунта №{n} нет названия — сохранение отменено (удалите строку, если она не нужна).',
      'accounts.errBlocked': '{n} аккаунтов неполные (см. красные примечания) — ничего не сохранено. Исправьте их и сохраните снова.',
      'ranking.title': 'Ранжирование',
      'ranking.enabled': 'Включить ранжирование',
      'ranking.enabledHelp': 'Снято = выключено; если значение никогда не задавалось, включено по умолчанию (состояние флажка отражает значение по умолчанию Host). Выключение сохраняет прежнее поведение: сначала маршрут, затем наименее используемый.',
      'ranking.strategy': 'Стратегия',
      'ranking.tierDirection': 'Направление уровней',
      'ranking.tierDirectionHelp': 'high = сначала привилегированные; low = сначала расходовать резервные аккаунты.',
      'ranking.respectHopRoute': 'Предпочитать маршрут шага',
      'ranking.priorityMode': 'Режим приоритета',
      'ranking.priorityHelp': 'Примечание: меньший номер приоритета важнее — в отличие от уровня (где важнее больший).',
      'ranking.probeEnabled': 'Автопроверка новых моделей (включено по умолчанию)',
      'ranking.probeEnabledHelp': 'Включено по умолчанию: каждая новая модель получает один минимальный запрос для определения бесплатности (бесплатно = стоимость 0, платно ≤ 1 токен, кэш 7 дней). Отключите, чтобы отказаться.',
      'routing.title': 'Двухуровневая умная маршрутизация',
      'routing.intro': 'Это ваши сохранённые настройки маршрутизации. Сохранение применяется сразу — без перезапуска.',
      'routing.enabled': 'Включить двухуровневую маршрутизацию',
      'routing.enabledHelp': 'Снято = выключено; если значение никогда не задавалось, включено по умолчанию (состояние флажка отражает значение по умолчанию Host). Стратегии нейтральны и равнозначны — без смещения в сторону стоимости или скорости.',
      'routing.strategy': 'Стиль маршрутизации',
      'routing.position': 'Позиция модели',
      'routing.positionHelp': 'Описание только для чтения, не редактируемая таблица.',
      'routing.positionExplain': 'Позиция каждой модели определяется её возможностями (рассуждение, зрение, длинный контекст); часть можно задать вручную. Эта страница не читает вычисленные для каждой модели результаты.',
      'routing.rulesTitle': 'Как распознаются задачи (только для чтения)',
      'cost.title': 'Расходы и состояние',
      'cost.plainExplain': 'Расходы берутся из реального журнала Host — без выдуманных чисел.',
      'cost.detailLoading': 'Загрузка деталей…',
      'cost.expandAll': 'Показать все вызовы ({n})',
      'cost.overviewLine': '{total} · {n} вызовов · экономия {savings}',
      'cost.loading': 'Чтение расходов…',
      'cost.loadFailed': 'Не удалось прочитать расходы: {reason}',
      'cost.detailBlock': 'Подробные данные ({n} записей)',
      'cost.detailNone': 'Вызовы пока не записаны',
      'cost.detailFailed': 'Не удалось прочитать подробные записи: {reason}',
      'cost.ok': 'OK',
      'cost.failed': 'Ошибка',
      'cost.prevPage': 'Назад',
      'cost.nextPage': 'Вперёд',
      'cost.timelineTitle': 'Хронология (по дням, высота столбца = число вызовов)',
      'cost.byModelTitle': 'По моделям (вызовы + накопленная стоимость)',
      'cost.byModelValue': '{calls} вызовов · ${cost}',
      'cost.savingsTitle': 'Журнал экономии (оценка)',
      'cost.savingsNotice': 'Только оценка — на основе сопоставимых публичных цен или платных записей, а не счёт. Если сопоставимой цены нет, указывается «нет сопоставимой цены», а не выдуманный 0.',
      'cost.savingsModel': '{model} бесплатные вызовы по платной цене',
      'cost.savingsValue': '~{usd} (оценка)',
      'cost.noComparable': 'Нет сопоставимой цены',
      'health.title': 'Состояние аккаунтов / охлаждение',
      'health.id': 'Аккаунт',
      'health.provider': 'Маршрут',
      'health.accountSummary': 'Аккаунтов {n} · на охлаждении {k}',
      'health.routeSummary': 'Маршрутов {m} · деградировало {j}',
      'health.accountModels': 'Модели: {models}',
      'health.accountRemain': 'Охлаждение осталось {remain}',
      'health.health': 'Состояние',
      'health.coolReason': 'Причина охлаждения',
      'health.usage': 'Попытки',
      'health.empty': 'Данных пока нет.',
      'health.plainExplain': 'Из активного реестра; ноль образцов читается как «Данных пока нет» — никогда не поддельный зелёный.',
      'health.loading': 'Чтение состояния аккаунтов…',
      'health.noChannel': 'На странице настроек пока нет канала состояния аккаунтов, поэтому реальное состояние не может быть показано (у Host могут быть записи). Диагностика ниже помогает его найти.',
      'health.disabledExplain': 'Слой состояния отключён: достаточно health:false, health.enabled:false или ranking.health.enabled:false. Пока он выключен, оценка состояния не производится — это прямо указано здесь, а не притворяется, что всё хорошо.',
      'health.state': 'Состояние',
      'health.stateUnknown': 'Данных пока нет',
      'health.stateActive': 'В норме',
      'health.stateCooling': 'Охлаждается',
      'health.stateHalfOpen': 'Полуоткрыто, ожидает проверки',
      'health.streak': 'Серия неудач',
      'health.samples': 'Успехи / неудачи',
      'health.implicit': '(определено автоматически)',
      'health.model': 'Модель',
      'health.tier': 'Уровень тарификации',
      'health.billing': 'Ценообразование',
      'health.billingHint': 'Метки «бесплатно» бывают измеренные / заявленные / непроверенные; ноль образцов читается как «Данных пока нет», а слабые сигналы никогда не называются подтверждёнными.',
      'health.freeDeclared': 'Заявлено бесплатным (множитель 0)',
      'health.freeWeak': 'Возможно бесплатно (не проверено)',
      'health.freeNone': 'Данных пока нет',
      'health.confidence': 'Уверенность',
      'health.snapshotAt': 'Снимок {time}',
      'health.refresh': 'Прочитать снова',
      'health.refreshing': 'Чтение…',
      'health.noSamples': 'Образцов пока нет',
      'health.confHigh': 'Высокая',
      'health.confMedium': 'Средняя',
      'health.confLow': 'Низкая',
      'health.confUnknown': 'Неизвестная',
      'health.lastSeen': 'Последний успех {ok} · последняя неудача {fail}',
      'health.never': 'нет',
      'health.soon': 'истекает скоро',
      'health.durationHour': '{h} ч {m} мин',
      'health.durationMinute': '{m} мин {s} с',
      'health.durationSecond': '{s} с',
      'health.tierFree': 'Бесплатно',
      'health.tierMetered': 'По токенам',
      'health.tierUnknown': 'Неизвестно',
      'health.healthHealthy': 'В норме',
      'health.healthDegraded': 'Деградировано',
      'health.healthDeprecated': 'Устарело',
      'health.healthUnknown': 'Данных пока нет',
      'error.saveFailed': 'Не удалось сохранить, попробуйте снова.',
      'costPill.cardTitle': 'Отображение расходов в чате',
      'costPill.cardHelp': 'Включите его, затем смотрите оценку рядом с полем ввода в чате. Очистка статистики только сбрасывает отметку начала; полный журнал сохраняется. Перезапуск не требуется.',
      'costPill.enabled': 'Показывать оценочную сумму',
      'costPill.enabledHelp': 'По умолчанию выключено; после включения накопленная оценка отображается рядом с полем ввода в чате (положение ниже).',
      'costPill.position': 'Положение отображения',
      'costPill.positionHelp': 'Место в чате для индикатора; по умолчанию компактно справа от поля ввода.',
      'costPill.pos.conversation.input.right': 'Справа от поля ввода (компактно)',
      'costPill.pos.conversation.session.header.utilities': 'Утилиты в заголовке сессии',
      'costPill.pos.conversation.input.dock': 'Область ввода',
      'costPill.refreshMs': 'Интервал автообновления (мс)',
      'costPill.refreshMsHelp': 'По умолчанию 60000 мс; введите 0, чтобы отключить автообновление. Ручное обновление остаётся доступным. Минимальное допустимое значение — 1000 мс.',
      'costPill.refreshInvalid': 'Введите 0 или не менее 1000 мс.',
      'costPill.monitor': 'Мониторинг',
      'costPill.autoRefresh': 'Автообновление',
      'costPill.refreshNow': 'Обновить сейчас',
      'costPill.since': 'Начало статистики: {since}',
      'costPill.noSince': 'Начало статистики: вся история',
      'costPill.clear': 'Начать статистику сейчас',
      'costPill.clearConfirm': 'Это только задаёт новую отметку начала; журнал расходов не удаляется. Продолжить?',
      'costPill.cleared': 'Новое начало статистики: {since}',
      'costPill.clearNote': 'Это только сбрасывает отметку начала отображения. Полный журнал сохраняется, данные о состоянии не затрагиваются.',
      'costPill.error': 'Не удалось прочитать или обновить статистику. Повторите попытку позже.',
      'tab.overview': 'Обзор',
      'tab.routing': 'Маршрутизация',
      'tab.cost': 'Расходы',
      'ranking.w.cost': 'Стоимость',
      'ranking.w.speed': 'Скорость',
      'ranking.w.tier': 'Уровень',
      'ranking.w.load': 'Нагрузка',
      'cost.col.time': 'Время',
      'cost.col.model': 'Модель',
      'cost.col.tokens': 'Токены',
      'cost.col.ttft': 'TTFT',
      'cost.col.tps': 'TPS',
      'cost.col.cost': 'Стоимость',
      'cost.col.status': 'Статус',
      'health.freeMeasured': 'Бесплатно (проверено)',
      'health.freeMeasuredPrice': 'Бесплатно (по прайс-листу)',
      'health.freeMeasuredProbe': 'Бесплатно (по зонду)',
      'health.freeMeasuredBilling': 'Бесплатно (по счёту)',
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
        ctx.effect(() => ctx.locale.register(NS, { zh, en, de, es, fr, pt, ru }), 'smart-provider: client locale')

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

        // CF-3: register the pill into exactly one configured conversation slot.
        // The callback re-runs on slot declaration changes; a form subscription
        // tears down the old registration when enabled/position/monitor changes.
        for (const slotName of COST_PILL_SLOTS) {
          ctx.slots.inject(slotName, () => {
            const form = (() => { try { return ctx.configForms.get(ENTRY) } catch { return undefined } })()
            const readCfg = () => {
              let config = {}
              try { config = obj(obj(form?.getSnapshot?.()).value) } catch { config = {} }
              return {
                enabled: costPillEnabledOf(config),
                position: costPillPositionOf(config[COST_PILL_POSITION_KEY]),
                refreshMs: costPillRefreshMsOf(config[COST_PILL_REFRESH_KEY]),
              }
            }
            let off = undefined // disposer returned by slots.register()
            let previous = readCfg()
            const apply = () => {
              const next = readCfg()
              const wanted = next.enabled ? next.position : null
              const current = previous.enabled ? previous.position : null
              if (wanted === current && next.refreshMs === previous.refreshMs) return
              try { off?.() } catch {}
              off = undefined
              if (wanted === slotName) {
                off = ctx.slots.register({
                  name: slotName, id: 'smart-provider.cost-pill', order: 100, locale: NS, inject: injected,
                }, CostPill)
              }
              previous = next
            }
            apply()
            let unsubscribe
            try { unsubscribe = form?.subscribe?.(apply) } catch { unsubscribe = undefined }
            return () => {
              try { unsubscribe?.() } catch {}
              try { off?.() } catch {}
            }
          })
        }
      },
    }
  },
})

