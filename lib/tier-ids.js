/**
 * Virtual model / effort ids — pure data contract (2026-11-27 spec reversal).
 *
 * Contract (SPEC-2026-11-27-smart-provider.md):
 *   4 virtual models: balanced / cost / speed / smart  (smart = default).
 *   6 efforts: auto (default) + off / low / medium / high / max.
 *   Composite id grammar: <model>/<effort>, e.g. "smart/auto".
 *   '+' stays reserved for the +<position> capability tag, never for effort.
 *   Model/effort DISPLAY NAMES are locale keys, not hardcoded free text:
 *     virtualModel.<model> / virtualEffort.<effort>
 *   zh/en are built in here as the guaranteed baseline; de/es/fr/pt/ru are
 *   supplied downstream via locale/*.json + t(). See the SPEC for the key
 *   names and the fallback chain.
 *   auto effort is a BIAS, not a model->effort dead mapping: task
 *   classification (lib/routing.js classifyTask) and the chain's actually
 *   supported efforts always participate in the final decision. A manually
 *   chosen effort always overrides auto.
 * No I/O, no DSH imports: usable from the adapter and from plain-Node tests.
 */

/** Virtual model ids, in the user's enumeration order (均衡/省钱/效率/智能). */
export const MODEL_TIERS = Object.freeze(['balanced', 'cost', 'speed', 'smart'])
/** Product-term alias for MODEL_TIERS. */
export const MODEL_IDS = MODEL_TIERS
/** i18n key per model id (locale/*.json + client.js embedded dictionaries). */
export const TIER_NAME_KEYS = Object.freeze({
  balanced: 'virtualModel.balanced',
  cost: 'virtualModel.cost',
  speed: 'virtualModel.speed',
  smart: 'virtualModel.smart',
})

/** Effort ids: auto first (default), then the 5 manual levels, weakest to
 *  strongest. Manual ids are canonical host ReasoningEffortId values. */
export const EFFORT_IDS = Object.freeze(['auto', 'off', 'low', 'medium', 'high', 'max'])
/** Manual (user-selectable) effort ids, weakest to strongest. */
export const MANUAL_EFFORT_IDS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])
/** The auto effort id — a soft preference, never a fixed model->effort binding. */
export const AUTO_EFFORT_ID = 'auto'
/** i18n key per effort id. */
export const EFFORT_NAME_KEYS = Object.freeze({
  auto: 'virtualEffort.auto',
  off: 'virtualEffort.off',
  low: 'virtualEffort.low',
  medium: 'virtualEffort.medium',
  high: 'virtualEffort.high',
  max: 'virtualEffort.max',
})

/** Guaranteed zh/en name tables: locale -> id -> display text. These are NOT
 *  free text used in every language; they are the built-in fallback baseline
 *  for the locale keys above. Runtime locale JSON is the source of truth. */
export const TIER_NAMES = Object.freeze({
  zh: Object.freeze({ balanced: '均衡', cost: '省钱', speed: '效率', smart: '智能' }),
  en: Object.freeze({ balanced: 'Balanced', cost: 'Economy', speed: 'Efficient', smart: 'Smart' }),
})
export const EFFORT_NAMES = Object.freeze({
  zh: Object.freeze({ auto: '自动', off: '关闭', low: '低', medium: '中', high: '高', max: '极高' }),
  en: Object.freeze({ auto: 'Auto', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }),
})

/**
 * Native composer effort declaration (DSH's ModelSelect Effort row). The Host
 * drives that row from `reasoning.efforts` / `reasoning.defaultEffort` on the
 * exact model info; the smart virtual model declares the full 6-choice set so
 * the row appears in the native place (never a self-drawn chip). The `auto`
 * choice is the default row: it is a soft bias resolved per task/chain in
 * resolveEffort(), and auto on a chain with no reasoning support resolves to
 * `off` — itself a real effort level, not a missing parameter. Manual ids are
 * canonical host ReasoningEffortId values, so a session can persist them
 * unchanged. Names must be PLAIN STRINGS: dsh-api-remotes' modelCatalog codec
 * types effort.name as z.string() (unlike badge.text, it accepts no
 * LocalizedText map). Only an explicit zh locale yields Chinese labels;
 * every other locale (including the default) uses English, so a non-zh
 * interface can never show Chinese. The 7-language virtualEffort.* keys in
 * client.js continue to localize the settings page.
 * @param {string} [locale] active UI locale id
 * @returns {{efforts: Array<{id:string,name:string}>, defaultEffort:string}}
 */
export function virtualReasoningDeclaration(locale) {
  const zh = typeof locale === 'string' && locale.toLowerCase().startsWith('zh')
  const table = zh ? EFFORT_NAMES.zh : EFFORT_NAMES.en
  return {
    efforts: EFFORT_IDS.map(id => ({ id, name: table[id] ?? EFFORT_NAMES.en[id] ?? id })),
    defaultEffort: AUTO_EFFORT_ID,
  }
}

/** Locale fallback: requested locale -> 'en' -> raw id. */
export const DEFAULT_LOCALE = 'zh'
export const DEFAULT_MODEL_TIER = 'smart'
export const DEFAULT_EFFORT = AUTO_EFFORT_ID
/** Default composite id: 'smart/auto'. */
export const DEFAULT_TIER_ID = DEFAULT_MODEL_TIER + '/' + DEFAULT_EFFORT

/** Full cartesian product of model x effort, stable order (4 x 6 = 24 ids). */
export const TIER_IDS = Object.freeze(
  MODEL_TIERS.flatMap(tier => EFFORT_IDS.map(effort => tier + '/' + effort)),
)

/** Ordered candidate host effort values per manual effort (first supported
 *  wins). Auto is deliberately absent: it is resolved, never mapped here. */
export const EFFORT_FALLBACK = Object.freeze({
  off: Object.freeze(['off', 'none']),
  low: Object.freeze(['low', 'medium']),
  medium: Object.freeze(['medium', 'low']),
  high: Object.freeze(['high', 'max']),
  max: Object.freeze(['max', 'high']),
})

/** Legacy model-id aliases: the old default "auto" (智能档) became "smart".
 *  cost/balanced keep their ids; their old effort suffix (off/medium/high)
 *  is still a valid id in the new effort set. */
export const LEGACY_MODEL_ALIAS = Object.freeze({ auto: 'smart' })

const TIER_SET = new Set(MODEL_TIERS)
const EFFORT_SET = new Set(EFFORT_IDS)

/**
 * Soft per-model effort bias: score DELTAS over manual efforts, NOT a chosen
 * effort and NOT a model->effort map. They only tilt a decision that is always
 * re-derived from the task and the chain's supported efforts.
 */
export const AUTO_EFFORT_BIAS = Object.freeze({
  smart: Object.freeze({ off: -2, low: -1, medium: 0, high: 2, max: 1 }),
  balanced: Object.freeze({ off: -1, low: 0, medium: 2, high: 0, max: -1 }),
  cost: Object.freeze({ off: 2, low: 1, medium: 0, high: -1, max: -2 }),
  speed: Object.freeze({ off: 1, low: 2, medium: 0, high: -1, max: -2 }),
})
const NEUTRAL_BIAS = Object.freeze({ off: 0, low: 0, medium: 0, high: 0, max: 0 })

/** Dynamic task signals keyed by classifyTask().kind. These are the project's
 *  existing task-content intelligence; they are summed with the model bias so
 *  the same model picks different efforts for different tasks. */
export const TASK_EFFORT_SIGNAL = Object.freeze({
  reasoning: Object.freeze({ off: -3, low: -1, medium: 1, high: 3, max: 2 }),
  thrifty: Object.freeze({ off: 3, low: 1, medium: -1, high: -3, max: -3 }),
  swift: Object.freeze({ off: 1, low: 2, medium: 0, high: -1, max: -2 }),
  longctx: Object.freeze({ off: 0, low: 1, medium: 1, high: 0, max: -1 }),
  vision: Object.freeze({ off: -1, low: 0, medium: 1, high: 1, max: 0 }),
  tool: Object.freeze({ off: -1, low: 0, medium: 0, high: 1, max: 0 }),
  general: Object.freeze({ off: 0, low: 0, medium: 0, high: 0, max: 0 }),
})

/**
 * Normalize a persisted legacy id into the new model namespace. Only the
 * legacy model segment "auto" is renamed to "smart"; an unknown segment is
 * left untouched so parseTierId can reject it honestly.
 * @param {unknown} model
 * @returns {unknown}
 */
export function migrateTierId(model) {
  if (typeof model !== 'string' || !model) return model
  const parts = model.split('/')
  const head = LEGACY_MODEL_ALIAS[parts[0]] ?? parts[0]
  return parts.length === 1 ? head : head + '/' + parts.slice(1).join('/')
}

/**
 * Parse one virtual model id. Single-segment ids parse with no effort (there
 * is no default baked into parsing; composition/resolution supplies it).
 * Legacy "auto" model segments are normalized to "smart". Anything else is
 * invalid: null, never guessed.
 * @param {unknown} model options.model, e.g. "smart/auto" or "cost" or legacy "auto/high"
 * @returns {{tier:string, effort:string|undefined}|null}
 */
export function parseTierId(model) {
  if (typeof model !== 'string' || !model) return null
  const parts = migrateTierId(model).split('/')
  if (parts.length === 1) {
    return TIER_SET.has(parts[0]) ? { tier: parts[0], effort: undefined } : null
  }
  if (parts.length === 2 && TIER_SET.has(parts[0]) && EFFORT_SET.has(parts[1])) {
    return { tier: parts[0], effort: parts[1] }
  }
  return null
}

/** Compose an id from a model and an effort (default effort = auto). */
export function composeTierId(tier, effort = DEFAULT_EFFORT) {
  return effort ? tier + '/' + effort : tier
}

/** Locale-aware model name. Fallback: requested locale -> en -> raw id. */
export function tierName(tier, locale = DEFAULT_LOCALE) {
  const table = TIER_NAMES[locale] ?? TIER_NAMES.en
  return table[tier] ?? TIER_NAMES.en[tier] ?? tier
}

/** Locale-aware effort name. Fallback: requested locale -> en -> raw id. */
export function effortName(effort, locale = DEFAULT_LOCALE) {
  const table = EFFORT_NAMES[locale] ?? EFFORT_NAMES.en
  return table[effort] ?? EFFORT_NAMES.en[effort] ?? effort
}

/** Locale-aware composite display name, e.g. "智能 · 自动" / "Smart · Auto". */
export function tierDisplayName(tier, effort, locale = DEFAULT_LOCALE) {
  const name = tierName(tier, locale)
  if (!effort) return name
  return name + ' · ' + effortName(effort, locale)
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

/** Map ONE manual tier effort to the first supported concrete effort value.
 *  Never clamps or fabricates; auto is not accepted here (use resolveAutoEffort). */
export function mapEffort(tierEffort, supported) {
  const candidates = EFFORT_FALLBACK[tierEffort] ?? []
  const set = supported instanceof Set ? supported : new Set(Array.isArray(supported) ? supported : [])
  for (const candidate of candidates) if (set.has(candidate)) return candidate
  return undefined
}

/** Combined scores for auto effort: model bias + classifyTask() task signal.
 *  Pure; returns a fresh frozen-ish plain object. The model bias alone can
 *  never pick a winner — task content and supported efforts still apply. */
export function autoEffortScores({ tier, task } = {}) {
  const bias = AUTO_EFFORT_BIAS[tier] ?? NEUTRAL_BIAS
  const kind = task && typeof task.kind === 'string' && task.kind ? task.kind : 'general'
  const signal = TASK_EFFORT_SIGNAL[kind] ?? TASK_EFFORT_SIGNAL.general
  const scores = {}
  for (const effort of MANUAL_EFFORT_IDS) scores[effort] = (bias[effort] ?? 0) + (signal[effort] ?? 0)
  return scores
}

/** Manual efforts ordered by preference (highest score first, canonical order
 *  breaks ties). This is a RANKING, not a model->effort map. */
export function rankAutoEfforts(opts = {}) {
  const scores = autoEffortScores(opts)
  return [...MANUAL_EFFORT_IDS].sort((a, b) =>
    scores[b] - scores[a] || MANUAL_EFFORT_IDS.indexOf(a) - MANUAL_EFFORT_IDS.indexOf(b))
}

/**
 * Resolve the auto effort from model bias + task classification + the chain's
 * actually supported efforts. No supported effort => undefined (no fabrication).
 * @param {{tier?:string, task?:object, supported?:Set<string>|string[]}} opts
 * @returns {string|undefined} a concrete host effort value
 */
export function resolveAutoEffort(opts = {}) {
  for (const effort of rankAutoEfforts(opts)) {
    const concrete = mapEffort(effort, opts.supported)
    if (concrete !== undefined) return concrete
  }
  return undefined
}

/**
 * Single effort decision entry point for the adapter. A manual effort always
 * overrides auto (including its task signal and bias). Missing/auto effort
 * takes the auto path, preserving classifyTask's dynamic decision.
 * @param {{tier?:string, effort?:string, task?:object,
 *   supported?:Set<string>|string[]}} opts
 * @returns {string|undefined}
 */
export function resolveEffort(opts = {}) {
  if (opts.effort && opts.effort !== AUTO_EFFORT_ID) return mapEffort(opts.effort, opts.supported)
  return resolveAutoEffort(opts)
}
