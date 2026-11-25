/**
 * Host-side @Remote service exposing the real cost ledger to the settings client.
 *
 * Uses @deepseek-ai/dsh-typert-protocol (installed in the profile / plugin deps).
 * The service is a plain Cordis Service carrying the same prototype marker that
 * `@Remote` would emit after TS compilation, so the DSH Gateway's source-mode
 * discovery finds it and routes `smartProvider/cost` to cost().
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readCostStats, readCostDetail } from './cost-stats.js'
import { projectStatus } from './availability.js'

const MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export { readCostStats, readCostDetail }

/** Cordis service: `ctx.smartProvider.cost()` over the wire. */
export class SmartProviderRemote extends TypertRemoteService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {() => object} statsReader @param {string|undefined} costDir @param {() => object|undefined} registryReader @param {() => object|undefined} probeReader */
  constructor(ctx, statsReader, costDir, registryReader, probeReader) {
    super(ctx, 'smartProvider')
    this.statsReader = statsReader
    this.costDir = costDir
    this.registryReader = registryReader
    this.probeReader = probeReader
  }

  /** @Remote cost() — the marker below is the runtime equivalent of the decorator. */
  cost() {
    return this.statsReader()
  }

  /** @Remote costDetail({offset,limit}) — paged detail + bounded aggregations. */
  // Bare identifier parameter only (see probeModels comment about gateway SRC
  // signature parsing — no defaults allowed).
  costDetail(opts) {
    try {
      return readCostDetail(this.costDir, {
        offset: Number(opts?.offset) || 0,
        limit: Number(opts?.limit) || 50,
      })
    } catch { return { total: 0, offset: 0, limit: 50, rows: [], timeline: [], byModel: [], savings: { estimated: true, known: false, models: [] } } }
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
    ]),
  }),
})
