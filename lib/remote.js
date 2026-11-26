/**
 * Host-side @Remote service exposing the real cost ledger to the settings client.
 *
 * Uses @deepseek-ai/dsh-typert-protocol (installed in the profile / plugin deps).
 * The service is a plain Cordis Service carrying the same prototype marker that
 * `@Remote` would emit after TS compilation, so the DSH Gateway's source-mode
 * discovery finds it and routes `smartProvider/cost` to cost().
 *
 * accountHealth() is the channel behind the settings page's "account health /
 * cooldown" view: it hands the client REAL runtime state (L2b account records,
 * the adapter's legacy cooldown map, the pool's usage counters, L1 route
 * evidence) instead of a client-side guess. The shape is frozen in
 * lib/health-snapshot.js — this class only forwards whatever the injected
 * healthReader returns, so the honesty rules (zero samples => UNKNOWN, a read
 * path never writes the registry) live in exactly one place.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { anchors } from './dsh.js'
import { readCostStats, readCostDetail, sinceIso } from './cost-stats.js'
import { projectStatus } from './availability.js'
import { freeSignal } from './free-policy.js'
import { priceForExact } from './pricing.js'

const MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Load the Typert remote base class without assuming THIS profile happens to
 * carry the package as a direct dependency.
 *
 * A bare `import` only resolves when DSH's loader maps the specifier for this
 * bundle — true for a profile that already pulled the package in for another
 * plugin, false for a freshly linked bundle in a profile that did not (the
 * E2E headless profile failed exactly this way: failed to import ⇒ no smart
 * adapter ⇒ NO_ADAPTER). The bare import stays first because it is the normal
 * path; the manifest anchors are the fallback, and they reach the copy the
 * installation itself ships.
 *
 * @returns {Promise<Function>} the TypertRemoteService base class
 */
async function loadTypertRemoteService() {
  const failures = []
  try {
    const bare = await import('@deepseek-ai/dsh-typert-protocol')
    if (typeof bare?.TypertRemoteService === 'function') return bare.TypertRemoteService
    failures.push('bare import: no TypertRemoteService export')
  } catch (error) {
    failures.push(`bare import: ${error?.code ?? error?.message ?? 'failed'}`)
  }
  for (const anchor of anchors()) {
    try {
      // resolve() works for ESM packages; require() would throw ERR_REQUIRE_ESM.
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-typert-protocol')
      const mod = await import(pathToFileURL(resolved).href)
      const service = mod?.TypertRemoteService ?? mod?.default?.TypertRemoteService
      if (typeof service === 'function') return service
      failures.push(`${anchor}: resolved without TypertRemoteService`)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? 'failed'}`)
    }
  }
  throw new Error(
    `dsh-smart-provider could not load @deepseek-ai/dsh-typert-protocol. Tried: ${failures.join('; ')}`,
  )
}

const TypertRemoteService = await loadTypertRemoteService()

/**
 * Degraded cost-detail payload: the shape the settings page must still be able
 * to parse when reading the ledger throws.
 *
 * Field-for-field copy of the client's strict COST_DETAIL_SCHEMA
 * (client.js COST_DETAIL_SCHEMA). Every field here is REQUIRED there, including
 * the two savings strings the old hand-rolled fallback omitted — a missing
 * priceSource/note makes zod reject the WHOLE payload, so the cost section
 * would sit on "正在读取" forever instead of showing an honest empty ledger.
 * Kept frozen and shared so the degraded path cannot drift from the schema
 * again without the tests noticing.
 */
const EMPTY_COST_DETAIL = Object.freeze({
  total: 0,
  offset: 0,
  limit: 50,
  rows: Object.freeze([]),
  timeline: Object.freeze([]),
  byModel: Object.freeze([]),
  savings: Object.freeze({
    estimated: true,
    priceSource: '',
    note: '',
    models: Object.freeze([]),
  }),
})

/**
 * Fresh mutable payload built from EMPTY_COST_DETAIL, echoing the requested
 * page so the client's pager matches what it asked for. Clamping mirrors
 * readCostDetail() (offset >= 0, 1 <= limit <= 200).
 */
function emptyCostDetail(offset, limit) {
  return {
    ...EMPTY_COST_DETAIL,
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : EMPTY_COST_DETAIL.offset,
    limit: Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : EMPTY_COST_DETAIL.limit,
    rows: [],
    timeline: [],
    byModel: [],
    savings: { ...EMPTY_COST_DETAIL.savings, models: [] },
  }
}

export { readCostStats, readCostDetail, EMPTY_COST_DETAIL }

/**
 * NF2/task-24 + HB1/task-36: attach a per-(provider, modelId) free signal to
 * the availabilityStatus projection WITHOUT changing the @Remote signature,
 * marker, or adding a method. The caller passes the explicit provider; no
 * cross-provider winner is chosen by bare modelId. The client strict codec
 * accepts exactly {free, level, source} or null — the evidence field stays
 * Host-side for tests/debugging and never crosses the wire.
 *
 * Only evidence the Host actually owns is fed into freeSignal here: the L1
 * registry record for THIS tuple (health/billing counters), a measured
 * (non-unknown) probe verdict via peek(), and the active pricing table via
 * priceForExact() (exact rows only — no bare-model cross-provider fallback).
 * The pricing module's own no-row estimate is
 * known:false/estimated:true, which freeSignal deliberately ignores — an
 * estimate is not a free-price declaration.
 */
function projectFreeSignal(registry, provider, modelId, probeReader) {
  const reg = registry && typeof registry === 'object' ? registry : {}
  // Exact-tuple lookup only. A bare modelId winner would let one route's
  // measured zero-price row leak into every same-named route.
  let record = null
  if (provider) {
    const candidate = reg[`${provider}::${modelId}`]
    if (candidate && candidate.key?.isVirtual !== true
      && candidate.key?.modelId === modelId && candidate.key?.provider === provider) record = candidate
  }
  const billingRaw = record?.billing
  const billing = billingRaw ? {
    meteredSamples: billingRaw.meteredSamples ?? 0,
    freeSamples: billingRaw.freeSamples ?? 0,
    // upstreamMetered/upstreamFree are the L1 signal carriers; map them to the
    // billingSource spelling freeSignal understands. A metered source wins.
    billingSource: billingRaw.upstreamMetered ? 'metered'
      : billingRaw.upstreamFree ? 'free' : undefined,
  } : undefined
  let price
  try { if (provider && modelId) price = priceForExact(provider, modelId) } catch { price = undefined }
  let probeVerdict
  // probeReader is the LAZY closure `() => adapter?.probe` (see index.js), not
  // the probe instance itself — probeModels() unwraps it the same way. Calling
  // .peek() on the closure silently drops every measured verdict.
  try { probeVerdict = probeReader?.()?.peek?.(provider, modelId)?.verdict } catch { probeVerdict = undefined }
  const signal = freeSignal({ provider, model: modelId, probeVerdict, billing, price })
  return { free: signal.free, level: signal.level, source: signal.source }
}
/** Cordis service: `ctx.smartProvider.cost()` over the wire. */
export class SmartProviderRemote extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {() => object} statsReader
   * @param {string|undefined} costDir
   * @param {() => object|undefined} registryReader
   * @param {() => object|undefined} probeReader
   * @param {() => object} healthReader
   * @param {Function} statsStateReader reads the start marker for a ledger dir
   * @param {Function} statsStateWriter writes the start marker for a ledger dir
   */
  constructor(ctx, statsReader, costDir, registryReader, probeReader, healthReader, statsStateReader, statsStateWriter) {
    super(ctx, 'smartProvider')
    this.statsReader = statsReader
    this.costDir = costDir
    this.registryReader = registryReader
    this.probeReader = probeReader
    this.healthReader = healthReader
    this.statsStateReader = statsStateReader
    this.statsStateWriter = statsStateWriter
  }

  /** @Remote cost() — the marker below is the runtime equivalent of the decorator. */
  cost() {
    return this.statsReader()
  }

  /**
   * @Remote statsSince({since?}) — conversation-banner total over the ledger
   * from the given start instant onward. The injected `statsReader` is the
   * single source of the summary shape (same fields as cost()); we only add
   * the canonical `since` so the client can display the active boundary.
   * With no since, the state marker is used — the client never has to persist
   * the start itself (it is not a config field).
   */
  // Bare identifier parameter only — Gateway srcDescriptor() rejects defaults.
  statsSince(opts) {
    try {
      const requested = opts?.since
      const since = requested !== undefined && requested !== null
        ? sinceIso(requested)
        : sinceIso(this.statsStateReader?.(this.costDir)?.since)
      const stats = this.statsReader(since)
      return { ...stats, since }
    } catch { return { records: 0, estimatedCostUsd: 0, freeCount: 0, paidCount: 0, failedCount: 0, byProvider: {}, source: '', since: null } }
  }

  /**
   * @Remote clearStats() — set the statistics start to now. Only the companion
   * state file is written; cost.jsonl is never touched. Returns the instant so
   * the client can refresh immediately without re-reading the marker.
   */
  clearStats() {
    try {
      const next = this.statsStateWriter?.(this.costDir)
      const since = sinceIso(next?.since)
      return { ok: since !== null, since }
    } catch { return { ok: false, since: null } }
  }

  /** @Remote costDetail({offset,limit}) — paged detail + bounded aggregations. */
  // Bare identifier parameter only (see probeModels comment about gateway SRC
  // signature parsing — no defaults allowed).
  costDetail(opts) {
    // Hoisted so the degraded payload can echo the page the client asked for;
    // a hostile opts (Number(Symbol) throws) still degrades to EMPTY_COST_DETAIL
    // defaults instead of propagating a new error onto the wire.
    let offset = 0
    let limit = 50
    try {
      offset = Number(opts?.offset) || 0
      limit = Number(opts?.limit) || 50
      return readCostDetail(this.costDir, { offset, limit })
    } catch { return emptyCostDetail(offset, limit) }
  }

  /**
   * @Remote availabilityStatus() — L1 projectStatus() over the live registry,
   * which merges ledger + #recordHop session signals (design §3.2). Covers
   * routes like workbuddy that never write cost.jsonl. Returns a plain object;
   * zero-sample models are simply absent -> client shows UNKNOWN.
   *
   * NF2: each projected row additionally carries `freeSignal`
   * ({free,level,source}|null) from lib/free-policy.js. No method/signature/
   * marker change; the client strict codec mirrors the exact three fields.
   */
  availabilityStatus() {
    try {
      const registry = this.registryReader?.()
      const status = projectStatus(registry) ?? {}
      for (const modelId of Object.keys(status)) {
        // One free tag per (provider, modelId) tuple — never pick a cross-provider
        // winner by bare modelId (that made workbuddy/hy4flash-free inherit an
        // x-opencode-free measured price row). The top-level tag keeps the
        // highest-evidence tuple so old clients still see a sane value.
        const providers = {}
        const ranks = { measured: 3, declared: 2, weak: 1, none: 0 }
        let best = null
        const reg = registry && typeof registry === 'object' ? registry : {}
        for (const key of Object.keys(reg)) {
          const record = reg[key]
          if (!record || record.key?.isVirtual === true || record.key?.modelId !== modelId) continue
          const provider = record.key?.provider
          if (!provider || provider in providers) continue
          const tag = projectFreeSignal(registry, provider, modelId, this.probeReader)
          providers[provider] = tag
          if (tag && (ranks[tag.level] ?? 0) > (ranks[best?.level] ?? 0)) best = tag
        }
        status[modelId].freeSignal = best
        status[modelId].providers = providers
      }
      return status
    } catch { return {} }
  }

  /**
   * @Remote probeModels({candidates}) — task-107 minimal real probe. Delegates
   * to the Host adapter.probe (lib/probe.js) which writes verdicts into the L1
   * availability registry. No probe is fired here at construction; the client
   * decides when to call (default: not automatic until user opts in).
   */
  // No default parameter value! Gateway srcDescriptor() parses Host method
  // signatures via Function.prototype.toString and rejects any parameter with
  // defaults/destructuring/rest (`gateway/signature-invalid`). Keep a bare
  // identifier parameter name only.
  probeModels(opts) {
    try {
      const candidates = Array.isArray(opts?.candidates) ? opts.candidates : []
      const probe = this.probeReader?.()
      // Manual re-probe: invalidate the cached verdicts first so a real new
      // request is made (Host probe.js exposes invalidate(provider, model)).
      if (opts?.force === true && probe?.invalidate) {
        for (const c of candidates) { try { probe.invalidate(c?.provider, c?.model) } catch {} }
      }
      return probe?.probeModels?.(candidates) ?? { results: [], probedAt: Date.now() }
    } catch { return { results: [], probedAt: Date.now() } }
  }

  /**
   * @Remote accountHealth() — live account state + effective cooldowns + L1
   * route evidence, for the settings page's "账号健康 / 冷却" section.
   *
   * Zero parameters (the client contribution declares no parameter codec and
   * invokes it as a direct call). The derivation lives in lib/health-snapshot.js
   * (pure, no I/O, never writes a registry); this method is a thin forwarder.
   *
   * Any failure degrades to an explicit "disabled, nothing known" snapshot:
   * the wire contract has no error channel, and a thrown method would surface
   * in the settings UI as a permanently empty section with no explanation.
   */
  accountHealth() {
    try {
      return this.healthReader?.()
        ?? { enabled: false, generatedAt: Date.now(), accounts: [], routes: [] }
    } catch { return { enabled: false, generatedAt: Date.now(), accounts: [], routes: [] } }
  }
}

// Mark `cost` as a direct Remote method. Exactly what `@Remote` emits via its
// addInitializer -> mark() path (protocol lib/index.js:449-470): a versioned,
// frozen descriptor on the class prototype, keyed by the stable string that
// `remoteMethods(service)` reads (cross-copy readable by design).
Object.defineProperty(SmartProviderRemote.prototype, MARKER_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'cost', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'costDetail', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'availabilityStatus', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'probeModels', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'accountHealth', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'statsSince', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'clearStats', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})
