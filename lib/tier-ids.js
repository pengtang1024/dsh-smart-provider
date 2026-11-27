/**
 * Combined virtual tier ids — pure parsing / composition / effort mapping.
 *
 * Contract (2026-11-27 combined-tier-ids.md, §2.1-2.5):
 *   id grammar: <tier>/<effort> (two path segments, e.g. "cost/high").
 *   '+' stays reserved for the +reasoning capability tag, never for effort.
 *   effort ids are host ReasoningEffortId values: off / medium / high.
 *   Chinese display names live in name free text only — never in t()/locale.
 * No I/O, no DSH imports: usable from the adapter and from plain-Node tests.
 */

/** Model tiers (outer chain keys). */
export const MODEL_TIERS = Object.freeze(['auto', 'cost', 'balanced'])
/** User-facing tier names (free text for listModels.name, NOT locale keys). */
export const TIER_NAMES = Object.freeze({ auto: '智能档', cost: '省钱档', balanced: '平衡档' })
/** Effort ids — host canonical values, in display order. */
export const EFFORT_IDS = Object.freeze(['off', 'medium', 'high'])
/** User-facing effort names (free text only). */
export const EFFORT_NAMES = Object.freeze({ off: '关闭', medium: '均衡', high: '高' })

/** Full cartesian product of tier x effort, stable order (9 ids). */
export const TIER_IDS = Object.freeze(
  MODEL_TIERS.flatMap(tier => EFFORT_IDS.map(effort => tier + '/' + effort)),
)

/** Ordered candidate effort values per tier id (first supported wins). */
export const EFFORT_FALLBACK = Object.freeze({
  off: Object.freeze(['off', 'none']),
  medium: Object.freeze(['medium', 'low']),
  high: Object.freeze(['high', 'max']),
})

const TIER_SET = new Set(MODEL_TIERS)
const EFFORT_SET = new Set(EFFORT_IDS)

/**
 * Parse one virtual model id.
 * Single-segment ids (legacy "auto"/"cost"/"balanced") parse with no effort so
 * old scripts keep working; two-segment ids must have both segments in the
 * allowed sets. Anything else is invalid: null, never guessed.
 * @param {unknown} model options.model, e.g. "cost/high" or "auto"
 * @returns {{tier:string, effort:string|undefined}|null}
 */
export function parseTierId(model) {
  if (typeof model !== 'string' || !model) return null
  const parts = model.split('/')
  if (parts.length === 1) {
    return TIER_SET.has(parts[0]) ? { tier: parts[0], effort: undefined } : null
  }
  if (parts.length === 2 && TIER_SET.has(parts[0]) && EFFORT_SET.has(parts[1])) {
    return { tier: parts[0], effort: parts[1] }
  }
  return null
}

/** Compose an id from a tier and an (optional) effort. */
export function composeTierId(tier, effort) {
  return effort ? tier + '/' + effort : tier
}

/** Free-text display name, e.g. "Smart 省钱档 · 高强度". */
export function tierDisplayName(tier, effort) {
  const base = 'Smart ' + (TIER_NAMES[tier] ?? tier)
  if (!effort) return base
  return base + ' · ' + (EFFORT_NAMES[effort] ?? effort) + '强度'
}

/**
 * Read the set of effort values supported by one chain's first real hop,
 * from the ALREADY-CACHED routes metadata (the same source as contextWindow).
 * Never performs I/O. Unknown / absent reasoning.efforts => empty set.
 * @param {Array<object>} routes
 * @param {Array<{provider:string, model:string}>} hops
 * @returns {Set<string>}
 */
export function supportedEfforts(routes, hops) {
  const first = Array.isArray(hops) ? hops[0] : undefined
  const efforts = new Set()
  if (!first) return efforts
  const route = (Array.isArray(routes) ? routes : []).find(r => r?.provider === first.provider)
  for (const entry of route?.models ?? []) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (id !== first.model) continue
    for (const value of Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : []) {
      if (typeof value === 'string' && value) efforts.add(value)
    }
    break
  }
  return efforts
}

/** Map one tier effort to the first supported concrete effort value. */
export function mapEffort(tierEffort, supported) {
  const candidates = EFFORT_FALLBACK[tierEffort] ?? []
  const set = supported instanceof Set ? supported : new Set(Array.isArray(supported) ? supported : [])
  for (const candidate of candidates) if (set.has(candidate)) return candidate
  return undefined
}
