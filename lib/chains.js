/**
 * Switch chains: the ordered list of {provider, model} hops tried by `smart`.
 *
 * Every hop is an existing DSH provider route. "Change model", "change
 * account" (a second route pointing at the same vendor with a different key)
 * and "change vendor" are deliberately unified — they are all just hops.
 *
 * P1 (user resource adaptation): this plugin is a GENERAL product, not one
 * account's config executable. The built-in table is intentionally EMPTY —
 * no model ids belonging to any specific user are shipped. When a user has
 * not configured chains, the Host discovers the live DSH registry (see
 * discoverAutoChain below / index.js) and builds a neutral auto chain from
 * what THAT user actually has. Existing users' configured chains are used
 * verbatim and never overwritten.
 */

/**
 * Single-segment chain keys from SPEC §2.1 (default virtual model = `smart`).
 * Kept local so the persisted-key migration stays stable and does not depend
 * on the transient state of another file under concurrent edit.
 */
const CHAIN_MODEL_KEYS = new Set(['balanced', 'cost', 'speed', 'smart'])

/**
 * Empty default chains. Key is the outer model id requested with provider
 * `smart` (the default virtual model). Use `'*'` as a catch-all for any
 * unrecognised model id.
 * @type {Record<string, Array<{provider:string, model:string}>>}
 */
export const DEFAULT_CHAINS = Object.freeze({ smart: [] })

/**
 * Normalize persisted/plain configuration keys to single-segment model keys
 * only. The legacy default model key `auto` is renamed to `smart` (SPEC §5):
 * without this, `withTierChains` never derives the default tier and
 * `listModels` silently skips the user's configured chain. Composite keys
 * (`<model>/<effort>`) are dropped — they are parse-time compatibility only,
 * never table entries; `parseTierId` resolves them to the base tier. When both
 * keys exist, the explicit `smart` entry wins over the legacy `auto` entry.
 *
 * @param {unknown} value
 * @returns {Record<string, Array<{provider:string, model:string}>>|undefined}
 */
export function migrateChainKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const hasExplicitSmart = Object.hasOwn(value, 'smart')
  const out = {}
  for (const [key, hops] of Object.entries(value)) {
    if (key === 'auto') {
      if (hasExplicitSmart) continue
      out.smart = hops
      continue
    }
    if (key !== '*' && !CHAIN_MODEL_KEYS.has(key)) continue
    if (Object.hasOwn(out, key)) continue
    out[key] = hops
  }
  return out
}

/**
 * Build a NEUTRAL auto chain from routes discovered at runtime.
 *
 * @param {Array<{provider:string, models:Array<string|{id:string}>}>} routes
 *   live routes from ctx.llm.listProviders() + listModels()
 * @param {number} [limit] max hops (default 4); 0/undefined = no cap
 * @returns {Array<{provider:string, model:string}>}
 *
 * Neutral by construction: sorted by provider then model id (deterministic,
 * no preference for any vendor, price or capability). An empty registry
 * yields an empty chain — the adapter reports UNKNOWN_MODEL honestly rather
 * than fabricating hops.
 */
export function discoverAutoChain(routes, limit = 4) {
  if (!Array.isArray(routes)) return []
  const hops = []
  for (const route of routes) {
    const provider = route && typeof route.provider === 'string' ? route.provider : ''
    // P2 verifier observation: keep self-routing out of the discovered pool
    // here (not only in the caller) so standalone reuse cannot self-reference.
    if (!provider || provider === 'smart') continue
    const models = Array.isArray(route.models) ? route.models : []
    for (const entry of models) {
      const model = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : ''
      if (model) hops.push({ provider, model })
    }
  }
  hops.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  return Number.isFinite(limit) && limit > 0 ? hops.slice(0, limit) : hops
}

/** Failure codes that make a hop switchable (see 方案盲点审查 §1 and 设计方案 §2). */
export const SWITCHABLE_CODES = new Set([
  'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'QUOTA', 'ACCOUNT_QUOTA',
  'MODEL_UNSUPPORTED', 'UNKNOWN_MODEL', 'UNSUPPORTED_REASONING_EFFORT',
  'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'RATE_LIMIT',
])

/**
 * Validate and normalize a chains object from configuration.
 * Invalid chains are dropped rather than silently producing broken requests.
 *
 * @param {unknown} value
 * @returns {Record<string, Array<{provider:string, model:string}>>}
 */
export function normalizeChains(value) {
  if (value === undefined || value === null) return structuredClone(DEFAULT_CHAINS)
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('smart provider config `chains` must be an object')
  }
  // Read through the same key migration index.js applies to config so a
  // persisted `chains.auto` lands on the default `chains.smart` tier.
  const migrated = migrateChainKeys(value)
  const result = {}
  for (const [outerModel, hops] of Object.entries(migrated ?? {})) {
    if (!Array.isArray(hops) || hops.length === 0) continue
    const normalized = []
    for (const hop of hops) {
      if (!hop || typeof hop.provider !== 'string' || typeof hop.model !== 'string') continue
      if (!hop.provider || !hop.model) continue
      normalized.push({ provider: hop.provider, model: hop.model })
    }
    if (normalized.length > 0) result[outerModel] = normalized
  }
  return Object.keys(result).length > 0 ? result : structuredClone(DEFAULT_CHAINS)
}

/**
 * Resolve the hop chain for one outer model id.
 * @param {string} outerModel
 * @param {Record<string, Array<{provider:string, model:string}>>} chains
 * @returns {Array<{provider:string, model:string}>}
 */
export function resolveChain(outerModel, chains, routing) {
  // P2 two-layer routing: optional third arg. When absent (all legacy
  // callers) the body below is byte-for-byte the original logic.
  if (routing && typeof routing === 'object' && Array.isArray(routing.dynamicAuto) && routing.dynamicAuto.length) {
    if (!chains || typeof chains !== 'object') chains = {}
    if (!Object.hasOwn(chains, outerModel) && !Object.hasOwn(chains, '*')) {
      // Only override the auto fallback; explicit user-configured model keys
      // and '*' remain authoritative (backward compatibility).
      if (typeof outerModel !== 'string' || !outerModel.includes('/')) return routing.dynamicAuto
    }
  }
  if (Object.hasOwn(chains, outerModel)) return chains[outerModel]
  if (Object.hasOwn(chains, '*')) return chains['*']
  // Unknown outer model: call it directly on its configured provider when it
  // is a `vendor/model` id; otherwise use the default (smart) chain. The
  // legacy `auto` key is kept as a read fallback for raw, unmigrated callers.
  if (typeof outerModel === 'string' && outerModel.includes('/')) {
    const slash = outerModel.indexOf('/')
    return [{
      provider: outerModel.slice(0, slash),
      model: outerModel.slice(slash + 1),
    }]
  }
  return chains.smart ?? chains.auto ?? []
}
