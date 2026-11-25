/**
 * Two-layer intelligent routing — pure functions (P2).
 *
 * Layer 1 (discrete): classify the request's task kind and select candidate
 * model POSITION tiers (thrifty/swift/reasoning/longctx/vision/tool/general)
 * with hard capability filtering.
 * Layer 2 (continuous): the existing ranking.js scores accounts WITHIN the
 * selected tiers. capability/reliability are NOT added to the score — they
 * are consumed by layer 1 / cooldown respectively (落地规格 C2).
 *
 * All functions are pure: they read their inputs, never mutate them.
 * Nothing here runs unless the caller supplies an explicit routing config;
 * the default (undefined / enabled:false) path stays byte-for-byte legacy.
 *
 * Evidence (design §5): dsh-llm/src/types.ts:564 GenerateOptions fields,
 * pi-ai/dist/types.d.ts:653/667/675 model capabilities.
 */

import { resolveWeights } from './ranking.js'

/** Position tags (product definition; not one user's model list). */
export const POSITION_TAGS = Object.freeze([
  'thrifty', 'swift', 'reasoning', 'longctx', 'vision', 'tool', 'general',
])

/** Default thresholds — conservative, can be overridden by config. */
const DEFAULT_LONGCTX_TOKENS = 200000
const DEFAULT_TIER_LIMIT = 2

function asArray(value) { return Array.isArray(value) ? value : [] }

/** Cheap token estimate: chars/4. Used ONLY for the longctx threshold, never
 *  for billing. Honest approximation (design marks precision unverified). */
function estimateTokens(messages) {
  let chars = 0
  for (const message of asArray(messages)) {
    const content = message && typeof message === 'object' ? message.content : message
    if (typeof content === 'string') chars += content.length
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          if (typeof block.text === 'string') chars += block.text.length
          else if (typeof block.content === 'string') chars += block.content.length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

function hasImage(messages) {
  for (const message of asArray(messages)) {
    const content = message && typeof message === 'object' ? message.content : message
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'image') return true
      }
    }
  }
  return false
}

/**
 * Layer-1 input: classify one request into a task kind.
 * P0 explicit > P1 image > P2 tools > P3 reasoning effort > P4 long context
 * > P5 auxiliary purpose > P6 general. All reads only; options untouched.
 *
 * @param {object} options GenerateOptions-shaped request
 * @param {object} [config] optional { longContextTokens }
 * @returns {{kind:string, secondary:string[], signals:string[]}}
 */
export function classifyTask(options, config = {}) {
  const src = options && typeof options === 'object' ? options : {}
  const signals = []
  const secondary = []
  const add = kind => { if (!secondary.includes(kind)) secondary.push(kind) }

  // P0 explicit declaration wins over every automatic signal.
  const model = typeof src.model === 'string' ? src.model : ''
  const plus = model.indexOf('+')
  if (plus !== -1) {
    const declared = model.slice(plus + 1)
    if (POSITION_TAGS.includes(declared)) {
      return { kind: declared, secondary, signals: [`explicit:+${declared}`] }
    }
  }
  if (Array.isArray(src.requiredCapabilities)) {
    for (const tag of src.requiredCapabilities) {
      if (POSITION_TAGS.includes(tag) && tag !== 'general') { signals.push(`explicit:${tag}`); add(tag) }
    }
    if (secondary.length) {
      const primary = secondary[0]
      return { kind: primary, secondary: secondary.slice(1), signals }
    }
  }

  // P1 image content (pi-ai types.d.ts:490).
  if (hasImage(src.messages)) { signals.push('image'); add('vision') }
  // P2 tool declarations (GenerateOptions.tools).
  if (asArray(src.tools).length > 0) { signals.push('tools'); add('tool') }
  // P3 reasoning effort.
  if (src.reasoningEffort !== undefined && src.reasoningEffort !== null && src.reasoningEffort !== 'none') {
    signals.push('reasoningEffort'); add('reasoning')
  }
  // P4 long context estimate.
  const threshold = Number.isFinite(config.longContextTokens)
    ? config.longContextTokens : DEFAULT_LONGCTX_TOKENS
  if (estimateTokens(src.messages) > threshold) { signals.push('longctx'); add('longctx') }
  // P5 auxiliary purpose (lightweight helper calls).
  if (typeof src.purpose === 'string' && /title|compaction|summary|classif/i.test(src.purpose)) {
    signals.push('purpose'); add('thrifty')
  }

  if (secondary.length === 0) return { kind: 'general', secondary: [], signals: ['default:general'] }
  const kind = secondary[0]
  return { kind, secondary: secondary.slice(1), signals }
}

/**
 * Derive a model's position tags from catalog metadata, overridden by a
 * user declaration when present. Missing metadata is conservative, never
 * fatal: tools default 'yes' for chat models, vision/structured default 'no'.
 *
 * @param {object} model ModelInfo {id, reasoning, contextWindow, input, maxTokens}
 * @param {object} [userDeclared] partial {tags, reasoning, vision, tool, ...}
 * @returns {{tags:string[], source:'auto'|'user'|'mixed'}}
 */
export function derivePosition(model, userDeclared) {
  const src = model && typeof model === 'object' ? model : {}
  const declared = userDeclared && typeof userDeclared === 'object' ? userDeclared : {}
  const auto = []
  if (src.reasoning === true) auto.push('reasoning')
  if (Number.isFinite(src.contextWindow) && src.contextWindow >= DEFAULT_LONGCTX_TOKENS) auto.push('longctx')
  if (asArray(src.input).includes('image')) auto.push('vision')
  // chat models default tool-capable; conservative but avoids false kills.
  if (src.tool !== false) auto.push('tool')
  auto.push('general')

  const explicitTags = asArray(declared.tags).filter(t => POSITION_TAGS.includes(t))
  // P2 fix (capability stage 2): user/override tags must MERGE with catalog-
  // derived capabilities, not replace them. Replacing dropped `vision` when a
  // free model was tagged `thrifty`, silently breaking capability filtering.
  const tags = [...new Set([...auto, ...explicitTags])]
  if (!tags.includes('general')) tags.push('general')
  const source = explicitTags.length ? (auto.length > 1 ? 'mixed' : 'user') : 'auto'
  return { tags, source }
}

/**
 * Layer 1 selection: task kind -> ordered candidate position tiers, with
 * hard capability filtering and an availability-first fallback (relax + WARN).
 *
 * @param {{kind:string, secondary:string[]}} task classifyTask result
 * @param {Map<string, object>} positions routeId -> Position ({tags})
 * @param {string[]} routes available route ids
 * @param {object} [policy] { tierPolicy, warnings?, tierLimit? }
 * @returns {Array<{position:string, routes:string[]}>}
 */
export function selectTiers(task, positions, routes, policy = {}) {
  const wanted = [task?.kind, ...asArray(task?.secondary)].filter(Boolean)
  const warn = typeof policy.warn === 'function' ? policy.warn : () => {}
  const tierLimit = Number.isFinite(policy.tierLimit) ? policy.tierLimit : DEFAULT_TIER_LIMIT

  let candidates = []
  for (const position of wanted) {
    const matched = asArray(routes).filter(route => {
      const pos = positions instanceof Map ? positions.get(route) : positions?.[route]
      return pos && asArray(pos.tags).includes(position)
    })
    if (matched.length) candidates.push({ position, routes: matched })
  }

  // Hard filter fallback: if nothing matched, relax to the nearest available
  // tier(s) and WARN instead of hard-failing the request.
  if (candidates.length === 0) {
    const available = asArray(routes)
    if (available.length === 0) return []
    warn(`smart routing: no tier matches task "${task?.kind ?? 'unknown'}"; relaxing to all available routes`)
    candidates = [{ position: 'general', routes: available }]
  }
  return candidates.slice(0, tierLimit)
}

/**
 * Resolve a routing preset into {tierPolicy, weights, positionOverrides}.
 * Reuses ranking.js resolveWeights so the second layer is unchanged.
 * Built-in balanced is NEUTRAL (.25 each); cost-first .7 is opt-in only.
 *
 * @param {object} config ranking-shaped config
 * @returns {{tierPolicy:string, weights:object, positionOverrides:object}}
 */
export function resolveRoutingPolicy(config = {}) {
  const src = config && typeof config === 'object' ? config : {}
  // Accept BOTH shapes so there is a single contract with no nesting trap:
  //   ranking-shaped: {routing:{strategy:'cost-first', ...}}
  //   routing-shaped: {strategy:'cost-first', ...}  (what the adapter holds)
  // ranking.routing.strategy from schema.js:62-67 now resolves correctly.
  const routing = src.routing && typeof src.routing === 'object' ? src.routing : src
  const pick = key => routing[key] !== undefined ? routing[key] : src.routing?.[key]
  const strategy = typeof pick('strategy') === 'string' ? pick('strategy') : 'balanced'
  const tierPolicy = typeof pick('tierPolicy') === 'string' ? pick('tierPolicy') : 'auto'

  // Presets: tierPolicy (layer 1) + weights (layer 2). Balanced is neutral.
  const PRESETS = {
    balanced: { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 },
    'cost-first': { cost: 0.7, speed: 0.05, tier: 0.1, load: 0.15 },
    'speed-first': { cost: 0.1, speed: 0.65, tier: 0.1, load: 0.15 },
  }
  const FORCE = {
    'reasoning-first': 'reasoning',
    'longctx-first': 'longctx',
    'vision-first': 'vision',
  }
  let weights = resolveWeights(strategy, routing.weights)
  if (PRESETS[strategy]) weights = { ...weights, ...PRESETS[strategy] }
  const effectiveTierPolicy = FORCE[strategy] ?? tierPolicy
  return {
    tierPolicy: effectiveTierPolicy,
    weights,
    positionOverrides: routing.positionOverrides && typeof routing.positionOverrides === 'object'
      ? routing.positionOverrides : {},
  }
}
