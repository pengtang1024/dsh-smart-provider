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
/** Candidate routes rendered in the relax diagnostic before it truncates. */
const MAX_DIAGNOSED_ROUTES = 8

function asArray(value) { return Array.isArray(value) ? value : [] }

/** Position metadata for one route id, from a Map or a plain object. */
function positionFor(positions, route) {
  if (positions instanceof Map) return positions.get(route)
  return positions && typeof positions === 'object' ? positions[route] : undefined
}

/** Deduplicated task kinds in priority order (primary first). */
function wantedPositions(task) {
  const wanted = []
  for (const candidate of [task?.kind, ...asArray(task?.secondary)]) {
    if (typeof candidate === 'string' && candidate && !wanted.includes(candidate)) wanted.push(candidate)
  }
  return wanted
}

/**
 * tierLimit normalizer. A non-positive limit used to fall straight into
 * slice(0, tierLimit), which for -1 silently drops the last tier and for 0
 * returns NO tier at all even when routes matched — both contradict the layer-1
 * contract (pick the best tier, never block), so invalid values fall back to
 * the documented default instead of disabling routing by accident.
 */
function normalizeTierLimit(value) {
  if (!Number.isFinite(value)) return DEFAULT_TIER_LIMIT
  const floored = Math.floor(value)
  return floored >= 1 ? floored : DEFAULT_TIER_LIMIT
}

/**
 * Where a position tag normally comes from. One sentence per missing tag,
 * used by the relax diagnostic so the log says WHY, not just WHAT.
 */
const POSITION_ORIGIN_HINTS = Object.freeze({
  reasoning: 'auto-derived only when the model catalog reports reasoning:true',
  longctx: 'auto-derived only when contextWindow >= ' + DEFAULT_LONGCTX_TOKENS
    + '; raising ranking.routing.longContextTokens makes fewer requests land in longctx',
  vision: "auto-derived only when the model catalog lists input:['image']",
  tool: 'auto-derived for chat models (catalog tool !== false); absent only when the catalog says tool:false',
  thrifty: 'never auto-derived — only positionOverrides can declare it (free/cheap models belong here)',
  swift: 'never auto-derived — only positionOverrides can declare it (fast models belong here)',
  general: 'every derived position carries it; a route with no tags at all has no position metadata',
})

function originHintFor(position) {
  return POSITION_ORIGIN_HINTS[position] ?? 'no auto-derivation rule exists for this tag'
}

/** Render a tag list as "a", "b" for diagnostics. */
function quoteList(list) {
  return list.map(item => '"' + item + '"').join(', ')
}

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
  // P3 reasoning effort. Both the DSH canonical off value ('off') and the
  // wire-level sentinel ('none') mean reasoning is OFF — neither invents a tier.
  if (src.reasoningEffort !== undefined && src.reasoningEffort !== null
      && src.reasoningEffort !== 'off' && src.reasoningEffort !== 'none') {
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
 * User-declared position tags, accepting BOTH shapes that exist in the wild:
 *   array form  — { "vendor/model": ["reasoning", "longctx"] }  (README)
 *   object form — { "vendor/model": { tags: ["reasoning"] } }   (registry yaml)
 * Reading only `.tags` silently ignored the documented array form, so a user
 * who configured positionOverrides exactly as documented still got
 * "no tier matches ... relaxing". Tags are trimmed/lowercased and filtered
 * against the whitelist; order is preserved, duplicates dropped.
 */
function declaredTagList(declared) {
  const raw = Array.isArray(declared) ? declared : asArray(declared?.tags)
  const tags = []
  for (const tag of raw) {
    if (typeof tag !== 'string') continue
    const normalized = tag.trim().toLowerCase()
    if (!POSITION_TAGS.includes(normalized) || tags.includes(normalized)) continue
    tags.push(normalized)
  }
  return tags
}

/**
 * Project a REAL Host model record into the shape derivePosition() reads.
 *
 * Host data (`LlmModelInfo` / `LlmResolvedModelInfo`) uses
 * `reasoning:{efforts}`, `inputModalities` and `context.contextWindow`, while
 * derivePosition() was written against the older catalog shape
 * (`reasoning:true`, `input`, top-level `contextWindow`). Mapping here — rather
 * than rewriting derivePosition() — keeps routing's existing semantics and the
 * user overrides intact for every other caller.
 *
 * `toolUpdate` is a tool-SCHEMA update policy, NOT a capability boolean, so it
 * is deliberately ignored: only an explicit legacy `tool:false` opts out, and
 * otherwise derivePosition()'s conservative "chat model" default applies.
 * Pure: reads `model`, returns a fresh plain object, never mutates anything.
 *
 * @param {object} model real Host model record (legacy catalog shape accepted too)
 * @returns {{id:string, reasoning:boolean, contextWindow:(number|undefined),
 *   input:string[], tool:boolean}}
 */
export function projectModelForPosition(model) {
  const src = model && typeof model === 'object' ? model : {}
  const efforts = src.reasoning && typeof src.reasoning === 'object'
    && Array.isArray(src.reasoning.efforts) ? src.reasoning.efforts : []
  const reasoning = src.reasoning === true || efforts.length > 0
  const nestedWindow = src.context && typeof src.context === 'object' ? src.context.contextWindow : undefined
  const contextWindow = Number.isFinite(nestedWindow) ? nestedWindow
    : (Number.isFinite(src.contextWindow) ? src.contextWindow : undefined)
  const modalities = Array.isArray(src.inputModalities) ? src.inputModalities
    : (Array.isArray(src.input) ? src.input : [])
  const input = modalities.includes('image') ? ['image'] : []
  return {
    id: typeof src.id === 'string' ? src.id : '',
    reasoning,
    contextWindow,
    input,
    // Never synthesize tool support from toolUpdate; preserve explicit opt-out.
    tool: src.tool !== false,
  }
}

/**
 * Derive a model's position tags from catalog metadata, overridden by a
 * user declaration when present. Missing metadata is conservative, never
 * fatal: tools default 'yes' for chat models, vision/structured default 'no'.
 *
 * @param {object} model ModelInfo {id, reasoning, contextWindow, input, maxTokens}
 * @param {object|string[]} [userDeclared] {tags:[...]} or a bare tag array
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

  const explicitTags = declaredTagList(declared)
  // P2 fix (capability stage 2): user/override tags must MERGE with catalog-
  // derived capabilities, not replace them. Replacing dropped `vision` when a
  // free model was tagged `thrifty`, silently breaking capability filtering.
  const tags = [...new Set([...auto, ...explicitTags])]
  if (!tags.includes('general')) tags.push('general')
  const source = explicitTags.length ? (auto.length > 1 ? 'mixed' : 'user') : 'auto'
  return { tags, source }
}

/**
 * Explain one failed layer-1 selection in terms a user can act on: what the
 * request needed, what each candidate route actually carries, why the wanted
 * tags are absent, and a copy-pasteable positionOverrides snippet. Pure: reads
 * its inputs, never mutates, never decides anything, never throws.
 *
 * @param {object} task classifyTask result ({kind, secondary, signals})
 * @param {Map<string, object>|object} positions routeId -> {tags}
 * @param {string[]} routes candidate route ids
 * @returns {{wanted:string[], missing:string[],
 *   candidates:Array<{route:string, tags:string[]}>, suggestion:object, message:string}}
 */
export function explainTierMiss(task, positions, routes) {
  const kind = typeof task?.kind === 'string' && task.kind ? task.kind : 'unknown'
  const secondary = asArray(task?.secondary).filter(k => typeof k === 'string' && k)
  const signals = asArray(task?.signals).filter(s => typeof s === 'string' && s)
  const wanted = wantedPositions(task)
  const available = asArray(routes).filter(route => typeof route === 'string' && route)
  const candidates = available.map(route => ({
    route,
    tags: asArray(positionFor(positions, route)?.tags).filter(tag => typeof tag === 'string'),
  }))
  const missing = wanted.filter(position => !candidates.some(c => c.tags.includes(position)))
  // A task with no kind information cannot name a "missing" tag; fall back to
  // the kind placeholder so the line still reads correctly.
  const missingEffective = missing.length ? missing : [kind]

  const lines = []
  lines.push('  task: kind="' + kind + '"'
    + (secondary.length ? ' secondary=[' + secondary.join(', ') + ']' : '')
    + (signals.length ? ' signals=[' + signals.join(', ') + ']' : ''))
  lines.push('  needed position tag(s): ' + quoteList(wanted.length ? wanted : [kind])
    + ' — no candidate route carries ' + quoteList(missingEffective))
  lines.push('  candidate routes (' + candidates.length + ') and the position tags they do carry:')
  const shown = candidates.slice(0, MAX_DIAGNOSED_ROUTES)
  for (const candidate of shown) {
    lines.push('    - ' + candidate.route + ': '
      + (candidate.tags.length ? candidate.tags.join(', ') : '(none — route has no position metadata)'))
  }
  if (candidates.length > shown.length) {
    lines.push('    … and ' + (candidates.length - shown.length) + ' more route(s)')
  }
  for (const position of missingEffective) {
    lines.push('  why "' + position + '" is missing everywhere: ' + originHintFor(position))
  }

  // The most useful snippet declares the tag on a route the user actually has.
  const anchor = candidates[0]?.route ?? '<route>'
  const overrideKey = anchor + '/<model-id>'
  const suggestion = {
    positionOverrides: { [overrideKey]: missingEffective.slice() },
    equivalentRegistryForm: { overrides: { [overrideKey]: { tags: missingEffective.slice() } } },
    keyForm: '"<route>/<model-id>" or a bare model id',
  }
  lines.push('  fix — declare the tag for a model you actually have (both shapes below work, copy either one):')
  lines.push('    "ranking": ' + JSON.stringify({ routing: { positionOverrides: suggestion.positionOverrides } }))
  lines.push('    registry form: ' + JSON.stringify(suggestion.equivalentRegistryForm))
  lines.push('    key = "' + overrideKey + '" (replace <model-id> with a model served by route "' + anchor + '"); a bare model id also works')
  lines.push('  note: tierPolicy only reorders which tier is tried first; it cannot invent a tag that no route carries')
  lines.push('  relax outcome: all ' + candidates.length + ' route(s) stay available; the request is NOT blocked')
  return { wanted, missing, candidates, suggestion, message: lines.join('\n') }
}

/**
 * Layer 1 selection: task kind -> ordered candidate position tiers, with
 * hard capability filtering and an availability-first fallback (relax + WARN).
 *
 * The relax fallback is deliberate and UNCHANGED: a task whose position tag no
 * route carries still gets every available route, because tiering is an
 * optimisation and must never block a request. What changed is the warning — it
 * now carries the full diagnosis (needed tags, each candidate's tags, why the
 * tags are absent, a copy-pasteable positionOverrides snippet) instead of
 * naming only the task kind.
 *
 * @param {{kind:string, secondary:string[], signals?:string[]}} task classifyTask result
 * @param {Map<string, object>|object} positions routeId -> Position ({tags})
 * @param {string[]} routes available route ids
 * @param {object} [policy] { warn?, tierLimit? } — invalid tierLimit (0/negative/
 *   non-numeric) falls back to the documented default instead of selecting no tier
 * @returns {Array<{position:string, routes:string[]}>}
 */
export function selectTiers(task, positions, routes, policy = {}) {
  const warn = typeof policy.warn === 'function' ? policy.warn : () => {}
  const tierLimit = normalizeTierLimit(policy.tierLimit)
  const wanted = wantedPositions(task)
  const available = asArray(routes)

  const candidates = []
  for (const position of wanted) {
    const matched = available.filter(route => asArray(positionFor(positions, route)?.tags).includes(position))
    if (matched.length) candidates.push({ position, routes: matched })
  }

  if (candidates.length === 0) {
    if (available.length === 0) {
      // Nothing to route to at all: keep returning [] so the caller stays on its
      // legacy chain, but leave one actionable line instead of failing silently.
      warn('smart routing: no routes available for task "' + (task?.kind ?? 'unknown')
        + '"; tier selection skipped and the request is NOT blocked')
      return []
    }
    const diagnosis = explainTierMiss(task, positions, available)
    warn('smart routing: no tier matches task "' + (task?.kind ?? 'unknown')
      + '"; relaxing to all available routes\n' + diagnosis.message)
    return [{ position: 'general', routes: available }]
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
