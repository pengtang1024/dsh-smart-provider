/**
 * RouteHealthRegistry core — pure functions, no DSH dependency.
 *
 * Implements 可用性自动管理设计.md §2 (data model), §3 (dual-source evidence),
 * §4 (classifyFailure P0–P4 + §4.3 rename), §7 (billing confidence), and §9
 * (interface contract). Every signature below is taken verbatim from §9;
 * `healthOf` and `registryKey` are exported because §10/§12/§2.1 refer to them.
 *
 * Hard rules carried over from the design:
 *  - state granularity is the exact (provider, modelId) tuple — never grouped
 *    by providerFamily or bare modelId (§2.1 / §6.1);
 *  - isVirtual entries never enter the registry as candidates (§2.1 / §6.2);
 *  - zero samples from both sources => UNKNOWN with confidence 0, never
 *    "unavailable" (§3.2 / §11);
 *  - the 400 codes of §4 P0 are pulled out of the coarse SERVER bucket and do
 *    NOT lower model health (§4 key correction);
 *  - a rename forces a billing recheck; only high-confidence `free` is a
 *    savings guarantee (§4.3 / §7).
 *
 * No provider or model name is hardcoded. All inputs come from the ledger,
 * session records, or the upstream id list.
 */

/** Health states (§2.2). */
export const HEALTH = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DEPRECATED: 'DEPRECATED',
})

/** Billing tiers (§2.2 / §7). */
export const BILLING_TIER = Object.freeze({
  FREE: 'free',
  METERED: 'metered',
  UNKNOWN: 'unknown',
})

/** Failure kinds (§4 table). */
export const FAILURE_KIND = Object.freeze({
  SESSION_HEADER: 'SESSION_HEADER',
  PARAM_COMPAT: 'PARAM_COMPAT',
  RENAMED: 'RENAMED',
  OFFLINE: 'OFFLINE',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  SERVER_JITTER: 'SERVER_JITTER',
  UNKNOWN: 'UNKNOWN',
})

/** Confidence anchors (§7 high / medium / low). Not fabricated per-case. */
const CONFIDENCE = Object.freeze({ HIGH: 0.95, MEDIUM: 0.7, LOW: 0.25 })

/** Sliding-window size for samples (§2.2 default 200). */
const DEFAULT_WINDOW = 200
/** Consecutive-failure thresholds (§4 P1/P3; design says "连续≥N 次"). */
const OFFLINE_THRESHOLD = 3
const JITTER_THRESHOLD = 3
/** Ledger-only zero-cost samples needed for a medium-confidence free tier (§7 N≥20). */
const FREE_LEDGER_SAMPLES = 20
/** Similarity at/above which an id is "medium similar" and NOT auto-remapped (§4.3). */
const MEDIUM_SIMILARITY = 0.7

/** Failure-code families (§4 table; mirror adapter.js:42-45 but generic). */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', '402'])
const RATE_CODES = new Set(['RATE_LIMIT', '429'])
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', '401', '403'])
const MODEL_ABSENT_CODES = new Set(['404', 'UNKNOWN_MODEL'])

// §4 P0 — request-shape fingerprints. Ordered before any code-based rule so a
// coarse code like SERVER with a max_completion_tokens message classifies as
// PARAM_COMPAT instead of dragging the model down (§4 "关键纠偏").
const SESSION_HEADER_RE = /MissingSessionID|x-opencode-session/i
const PARAM_COMPAT_RE = /max_completion_tokens|developer role|invalid\s+parameter|unsupported\s+parameter/i
const QUOTA_RE = /\b402\b|quota|insufficient|余额|额度/i
const RATE_RE = /\b429\b|rate.?limit|too many requests/i
const AUTH_RE = /\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication/i
const JITTER_RE = /\b5\d\d\b|timeout|transport|stream closed/i

/** §2.1 registryKey(key) = `${provider}::${modelId}`. */
export function registryKey(key) {
  if (!key || typeof key !== 'object') return ''
  const provider = typeof key.provider === 'string' ? key.provider : ''
  const modelId = typeof key.modelId === 'string' ? key.modelId : ''
  if (!provider || !modelId) return ''
  return `${provider}::${modelId}`
}

function emptyRecord(key) {
  return {
    key: {
      provider: key.provider,
      modelId: key.modelId,
      providerFamily: typeof key.providerFamily === 'string' ? key.providerFamily : key.provider,
      isVirtual: key.isVirtual === true,
    },
    health: HEALTH.UNKNOWN,
    billingTier: BILLING_TIER.UNKNOWN,
    confidence: 0,
    samples: { success: 0, failure: 0 },
    failureKinds: {},
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    relatedIds: [],
    updatedAt: 0,
    // §7 signal carrier (implementation detail; public shape is the §9 contract).
    billing: { freeSamples: 0, meteredSamples: 0, upstreamFree: false, upstreamMetered: false },
  }
}

/** Clone a record without touching the input (§9 "纯更新，不改入参"). */
function cloneRecord(r) {
  return {
    ...r,
    key: { ...r.key },
    samples: { ...r.samples },
    failureKinds: { ...r.failureKinds },
    relatedIds: Array.isArray(r.relatedIds) ? [...r.relatedIds] : [],
    billing: { ...(r.billing ?? { freeSamples: 0, meteredSamples: 0, upstreamFree: false, upstreamMetered: false }) },
  }
}

/** §4.3 normalize: strip free/preview suffixes, lowercase, erase separators. */
function normalizeId(id) {
  if (typeof id !== 'string') return ''
  let s = id.toLowerCase()
  for (const suffix of ['-preview-free', '-free', '-preview']) {
    if (s.endsWith(suffix)) { s = s.slice(0, -suffix.length); break }
  }
  return s.replace(/[-_]/g, '')
}

/** Levenshtein ratio for "medium similarity" (§4.3), no external dependency. */
function similarity(a, b) {
  const x = normalizeId(a), y = normalizeId(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  const curr = new Array(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    curr[0] = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= y.length; j++) prev[j] = curr[j]
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length)
}

/**
 * §4.3 resolveModelId(requestedId, currentIdList, registry)
 * → {id, action:'use'|'remap'|'deprecate'}
 * Pure: reads registry but never writes it. The caller records the association
 * through updateHealth() using an attempt carrying `relatedId`.
 */
export function resolveModelId(requestedId, currentIdList, registry) {
  const id = typeof requestedId === 'string' ? requestedId : ''
  const list = Array.isArray(currentIdList) ? currentIdList.filter(x => typeof x === 'string' && x) : []
  if (list.includes(id)) return { id, action: 'use' }

  let best = '', bestScore = 0
  for (const candidate of list) {
    const score = similarity(id, candidate)
    if (score > bestScore) { bestScore = score; best = candidate }
  }
  // Extreme similarity: normalized-equal => automatic remap + forced billing
  // recheck (§4.1). Medium similarity => keep original id, no auto routing
  // change (the record naturally stays UNKNOWN with no samples).
  if (normalizeId(id) && normalizeId(id) === normalizeId(best)) {
    return { id: best, action: 'remap' }
  }
  if (bestScore >= MEDIUM_SIMILARITY) return { id, action: 'use' }
  return { id, action: 'deprecate' }
}

/**
 * §9 classifyFailure(failure, ctx)
 * → {kind, affectsModelHealth, retryable, suggestedAction}
 * `failure` is the normalizeFailure() output {code, message} (adapter.js:54-77).
 * `ctx` may carry {currentIdList, relatedId} for the RENAMED branch.
 */
export function classifyFailure(failure, ctx = {}) {
  const f = failure && typeof failure === 'object' ? failure : { message: String(failure ?? '') }
  const code = String(f.code ?? '')
  const message = typeof f.message === 'string' ? f.message : ''

  // P0 — request-shape problems: never lower model health.
  if (SESSION_HEADER_RE.test(message)) {
    return { kind: FAILURE_KIND.SESSION_HEADER, affectsModelHealth: false, retryable: true,
      suggestedAction: 'supply required session header for this route' }
  }
  if (PARAM_COMPAT_RE.test(message)) {
    return { kind: FAILURE_KIND.PARAM_COMPAT, affectsModelHealth: false, retryable: true,
      suggestedAction: 'switch route compat profile (maxTokensField / developerRole / supportsStore)' }
  }

  // P1 — model-id life cycle (needs the upstream id list from ctx).
  if (MODEL_ABSENT_CODES.has(code) && Array.isArray(ctx.currentIdList)) {
    const decision = resolveModelId(ctx.requestedId ?? '', ctx.currentIdList, ctx.registry)
    if (decision.action === 'remap') {
      return { kind: FAILURE_KIND.RENAMED, affectsModelHealth: true, retryable: false,
        suggestedAction: `remap to ${decision.id} and force billing recheck` }
    }
    return { kind: FAILURE_KIND.OFFLINE, affectsModelHealth: true, retryable: false,
      suggestedAction: 'low-frequency recheck; keep as candidate but lowest priority' }
  }

  // P2 — account-level problems: never lower model health.
  if (QUOTA_CODES.has(code) || QUOTA_RE.test(message)) {
    return { kind: FAILURE_KIND.QUOTA, affectsModelHealth: false, retryable: true,
      suggestedAction: 'account-level cooldown' }
  }
  if (RATE_CODES.has(code) || RATE_RE.test(message)) {
    return { kind: FAILURE_KIND.RATE_LIMIT, affectsModelHealth: false, retryable: true,
      suggestedAction: 'short account cooldown' }
  }
  if (AUTH_CODES.has(code) || AUTH_RE.test(message)) {
    return { kind: FAILURE_KIND.AUTH, affectsModelHealth: false, retryable: false,
      suggestedAction: 'check credential for this account' }
  }

  // P3 — transient upstream jitter: may degrade only past the threshold (§4/§5).
  if (JITTER_RE.test(message) || /^5\d\d$/.test(code)) {
    return { kind: FAILURE_KIND.SERVER_JITTER, affectsModelHealth: true, retryable: true,
      suggestedAction: 'short jitter cooldown; degrade only past threshold' }
  }

  // P4 — a bare 400 with no recognized fingerprint lands here, NOT in SERVER.
  // This is the §4 "400 从 SERVER 粗分剥离" correction.
  return { kind: FAILURE_KIND.UNKNOWN, affectsModelHealth: false, retryable: false,
    suggestedAction: null }
}

/** Confidence from observation count and signal directness (§3.2). Zero => 0. */
function evidenceConfidence(success, failure, direct) {
  const total = success + failure
  if (total === 0) return 0
  const scale = direct === true ? 1 : 0.8
  return Math.min(CONFIDENCE.HIGH, (0.3 + 0.15 * Math.log2(1 + total)) * scale)
}

function cap(n, window) {
  return Math.max(0, Math.min(Number.isFinite(window) ? window : DEFAULT_WINDOW, n))
}

/**
 * §9 updateHealth(registry, attempt) → HealthRecord — pure, input unchanged.
 *
 * attempt (from cost-meter / hop record / id-list event):
 *   {provider, modelId, providerFamily?, isVirtual?, success?, ok?, failure?,
 *    cost?, billingSource?, pricingFree?, relatedId?, timestamp?, window?}
 * A fresh record is created when the tuple is absent. Virtual attempts are
 * ignored (§6.2). RENAMED resets billing evidence (§4.1 forced recheck).
 */
export function updateHealth(registry, attempt) {
  const reg = registry && typeof registry === 'object' ? registry : {}
  const a = attempt && typeof attempt === 'object' ? attempt : {}
  const key = {
    provider: typeof a.provider === 'string' ? a.provider : '',
    modelId: typeof a.modelId === 'string' ? a.modelId : '',
    providerFamily: typeof a.providerFamily === 'string' ? a.providerFamily : undefined,
    isVirtual: a.isVirtual === true,
  }
  const k = registryKey(key)
  if (!k) return null
  const existing = reg[k] ? cloneRecord(reg[k]) : emptyRecord(key)
  // §6.2 / §2.1: virtual copies never write health.
  if (key.isVirtual) return existing

  const now = Number.isFinite(a.timestamp) ? a.timestamp : Date.now()
  const window = cap(DEFAULT_WINDOW, a.window ?? DEFAULT_WINDOW)
  const hasFailure = a.failure != null || a.failureCode != null
  const success = a.success === true || (a.ok === true && !hasFailure) ||
    (a.failed === false && !hasFailure) || (!hasFailure && typeof a.cost === 'number')
  const billing = existing.billing

  if (success) {
    existing.samples.success = cap(existing.samples.success + 1, window)
    existing.health = HEALTH.HEALTHY // §5 any state + new success → HEALTHY
    existing.lastSuccessAt = now
    if (typeof a.cost === 'number' && a.cost <= 0) billing.freeSamples++
    if (typeof a.cost === 'number' && a.cost > 0) billing.meteredSamples++
    if (typeof a.billingSource === 'string' && /free|trial|bonus/i.test(a.billingSource)) billing.upstreamFree = true
    if (typeof a.billingSource === 'string' && /paid|meter|subscription|credit/i.test(a.billingSource)) billing.upstreamMetered = true
  } else {
    const rawFailure = a.failure ?? { code: a.failureCode, message: a.failureMessage ?? '' }
    const verdict = classifyFailure(rawFailure, {
      currentIdList: a.currentIdList,
      requestedId: key.modelId,
      registry: reg,
    })
    existing.samples.failure = cap(existing.samples.failure + 1, window)
    existing.failureKinds[verdict.kind] = (existing.failureKinds[verdict.kind] ?? 0) + 1
    existing.lastFailureAt = now
    if (verdict.kind === FAILURE_KIND.RENAMED) {
      existing.health = HEALTH.DEPRECATED
      if (typeof a.relatedId === 'string' && a.relatedId && !existing.relatedIds.includes(a.relatedId)) {
        existing.relatedIds.push(a.relatedId)
      }
      // §4.1 / §7: rename forces billing recheck — old confidence void.
      billing.freeSamples = 0
      billing.meteredSamples = 0
      billing.upstreamFree = false
      billing.upstreamMetered = false
    } else if (verdict.affectsModelHealth) {
      const streak = existing.failureKinds[verdict.kind] ?? 0
      if (verdict.kind === FAILURE_KIND.OFFLINE && streak >= OFFLINE_THRESHOLD) {
        existing.health = HEALTH.DEPRECATED
      } else if (verdict.kind === FAILURE_KIND.SERVER_JITTER && streak >= JITTER_THRESHOLD) {
        existing.health = HEALTH.DEGRADED
      }
      // P0/P2 with affectsModelHealth=false leave health untouched (§4).
    }
  }

  existing.billing = billing
  existing.confidence = evidenceConfidence(existing.samples.success, existing.samples.failure, true)
  // §7 billing tier + confidence.
  if (billing.upstreamMetered || billing.meteredSamples > 0) {
    existing.billingTier = BILLING_TIER.METERED
  } else if (billing.upstreamFree) {
    existing.billingTier = BILLING_TIER.FREE
  } else if (billing.freeSamples >= FREE_LEDGER_SAMPLES) {
    existing.billingTier = BILLING_TIER.FREE
  } else if (a.pricingFree === true && existing.samples.success + existing.samples.failure === 0) {
    existing.billingTier = BILLING_TIER.UNKNOWN // §7: pricing marker alone is low-confidence unknown
  }
  existing.updatedAt = now
  return existing
}

/**
 * §9 isCandidate(registry, key) → boolean — "虚拟/DEPRECATED 判定".
 * §6.2 hard rule: virtual copies are never candidates. §5 explicitly keeps
 * DEPRECATED / DEGRADED / UNKNOWN entries in the candidate pool (lowest
 * priority, never deleted and not auto-excluded on zero samples), so the
 * boolean only filters virtual identities.
 */
export function isCandidate(registry, key) {
  if (!key || key.isVirtual === true) return false
  const k = registryKey(key)
  return k ? true : false
}

/** §9 billingTierOf(registry, key) → {tier, confidence} (§7 confidence rules). */
export function billingTierOf(registry, key) {
  const k = registryKey(key)
  const r = k && registry && typeof registry === 'object' ? registry[k] : null
  if (!r) return { tier: BILLING_TIER.UNKNOWN, confidence: 0 }
  const b = r.billing ?? {}
  let confidence = 0
  if (b.upstreamFree || b.upstreamMetered) confidence = CONFIDENCE.HIGH
  else if ((b.meteredSamples ?? 0) > 0) confidence = CONFIDENCE.HIGH
  else if ((b.freeSamples ?? 0) >= FREE_LEDGER_SAMPLES) confidence = CONFIDENCE.MEDIUM
  if (r.billingTier === BILLING_TIER.UNKNOWN) confidence = 0
  return { tier: r.billingTier ?? BILLING_TIER.UNKNOWN, confidence }
}

/** §12/§10 healthOf(registry, key) → {health, confidence}; zero sample => UNKNOWN/0. */
export function healthOf(registry, key) {
  const k = registryKey(key)
  const r = k && registry && typeof registry === 'object' ? registry[k] : null
  if (!r) return { health: HEALTH.UNKNOWN, confidence: 0 }
  return { health: r.health ?? HEALTH.UNKNOWN, confidence: r.confidence ?? 0 }
}

/**
 * §9 projectStatus(registry) → Record<modelId, {health, tier, confidence}>
 * Display projection for the first screen (§10). Exact-tuple records with the
 * same bare modelId are merged by highest confidence for display only;
 * machine decisions still use the exact (provider, modelId) tuple (§6.1).
 */
export function projectStatus(registry) {
  const out = {}
  if (!registry || typeof registry !== 'object') return out
  for (const k of Object.keys(registry)) {
    const r = registry[k]
    if (!r || r.key?.isVirtual === true) continue // §6.2 virtual never projected as candidate
    const modelId = r.key?.modelId
    if (!modelId) continue
    const tier = billingTierOf(registry, r.key)
    const row = { health: r.health ?? HEALTH.UNKNOWN, tier: tier.tier, confidence: r.confidence ?? 0 }
    const prev = out[modelId]
    if (!prev || row.confidence > prev.confidence) out[modelId] = row
  }
  return out
}
