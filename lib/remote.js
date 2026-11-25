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
import { readCostStats, readCostDetail } from './cost-stats.js'
import { projectStatus } from './availability.js'

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

/** Cordis service: `ctx.smartProvider.cost()` over the wire. */
export class SmartProviderRemote extends TypertRemoteService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {() => object} statsReader @param {string|undefined} costDir @param {() => object|undefined} registryReader @param {() => object|undefined} probeReader @param {() => object} healthReader */
  constructor(ctx, statsReader, costDir, registryReader, probeReader, healthReader) {
    super(ctx, 'smartProvider')
    this.statsReader = statsReader
    this.costDir = costDir
    this.registryReader = registryReader
    this.probeReader = probeReader
    this.healthReader = healthReader
  }

  /** @Remote cost() — the marker below is the runtime equivalent of the decorator. */
  cost() {
    return this.statsReader()
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
   */
  availabilityStatus() {
    try {
      const registry = this.registryReader?.()
      return projectStatus(registry) ?? {}
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
    ]),
  }),
})
