/**
 * Single source of truth for health failure taxonomy (E0A1).
 *
 * THIS IS THE CANONICAL DEFINITION. Consumers should DERIVE their constants
 * from the records below instead of copying literal tables: adding a failure
 * kind must require one edit here, never a sweep across four modules.
 * The parity guard in test/health-taxonomy.test.mjs pins every derived value
 * to the legacy constants so a missed alias fails CI loudly.
 *
 * Pure module: no I/O, no @deepseek-ai/* imports, no argument mutation,
 * never throws. All exported records are frozen.
 */

/** Canonically ordered account health states (mirrors legacy ACCOUNT_STATES). */
export const ACCOUNT_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  ACTIVE: 'ACTIVE',
  COOLING: 'COOLING',
  HALF_OPEN: 'HALF_OPEN',
})

/**
 * Ranking multiplier per state. COOLING never enters the sort.
 * Order of keys here matches the legacy object; values are single-sourced.
 */
export const STATE_WEIGHTS = Object.freeze({
  ACTIVE: 1,
  UNKNOWN: 0.8,
  HALF_OPEN: 0.5,
  COOLING: 0,
})

/**
 * Failure taxonomy. One record per canonical kind. The aliases array contains
 * every raw code that normalizes to that kind; note that bare numeric HTTP
 * codes are normalized separately by normalizeKind() when absent from aliases.
 *
 * layer: 'account'   -> decided by the credential/account layer
 *        'model'     -> handled by RouteHealthRegistry (model health)
 *        'request'   -> request construction, penalizes neither layer
 *        'none'      -> no penalty / no cooldown
 * baseCooldownMs: null when the kind has no account cooldown.
 * affectsModelHealth / retryable: derived semantics used by the consumers.
 */
export const FAILURE_TAXONOMY = Object.freeze({
  QUOTA: Object.freeze({
    aliases: Object.freeze(['QUOTA', 'ACCOUNT_QUOTA', 'CODE_402']),
    layer: 'account', baseCooldownMs: 30 * 60 * 1000,
    affectsModelHealth: false, retryable: true,
  }),
  ACCOUNT_QUOTA: Object.freeze({
    aliases: Object.freeze(['ACCOUNT_QUOTA']),
    layer: 'account', baseCooldownMs: 30 * 60 * 1000,
    affectsModelHealth: false, retryable: true,
  }),
  AUTH: Object.freeze({
    aliases: Object.freeze(['AUTH', 'CODE_401']),
    layer: 'account', baseCooldownMs: 24 * 60 * 60 * 1000,
    affectsModelHealth: false, retryable: false,
  }),
  INVALID_CREDENTIAL: Object.freeze({
    aliases: Object.freeze(['INVALID_CREDENTIAL']),
    layer: 'account', baseCooldownMs: 24 * 60 * 60 * 1000,
    affectsModelHealth: false, retryable: false,
  }),
  RATE_LIMIT: Object.freeze({
    aliases: Object.freeze(['RATE_LIMIT', 'RATELIMIT', 'CODE_429']),
    layer: 'account', baseCooldownMs: 60 * 1000,
    affectsModelHealth: false, retryable: true,
  }),
  SERVER_JITTER: Object.freeze({
    aliases: Object.freeze([
      'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'SERVER_JITTER',
    ]),
    layer: 'account', baseCooldownMs: 5 * 1000,
    affectsModelHealth: true, retryable: true,
  }),
  SESSION_HEADER: Object.freeze({
    aliases: Object.freeze(['SESSION_HEADER']),
    layer: 'request', baseCooldownMs: null,
    affectsModelHealth: false, retryable: true,
  }),
  PARAM_COMPAT: Object.freeze({
    aliases: Object.freeze(['PARAM_COMPAT', 'UNSUPPORTED_REASONING_EFFORT']),
    layer: 'request', baseCooldownMs: null,
    affectsModelHealth: false, retryable: true,
  }),
  RENAMED: Object.freeze({
    aliases: Object.freeze(['RENAMED', 'UNKNOWN_MODEL', 'MODEL_UNSUPPORTED']),
    layer: 'model', baseCooldownMs: null,
    affectsModelHealth: true, retryable: false,
  }),
  OFFLINE: Object.freeze({
    aliases: Object.freeze(['OFFLINE']),
    layer: 'model', baseCooldownMs: null,
    affectsModelHealth: true, retryable: false,
  }),
  VIRTUAL: Object.freeze({
    aliases: Object.freeze(['VIRTUAL']),
    layer: 'model', baseCooldownMs: null,
    affectsModelHealth: false, retryable: false,
  }),
  UNKNOWN: Object.freeze({
    aliases: Object.freeze(['UNKNOWN', 'EMPTY_RESPONSE', 'ABORTED']),
    layer: 'none', baseCooldownMs: null,
    affectsModelHealth: false, retryable: false,
  }),
})

/** Canonical failure kinds (legacy FAILURE_KIND, derived from taxonomy keys). */
export const FAILURE_KINDS = Object.freeze({
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

/**
 * Alias -> canonical kind, derived from FAILURE_TAXONOMY.
 * Code numbers are prefixed as CODE_xxx in the alias table to keep the format
 * uniform with symbolic codes; bare numeric HTTP status codes are handled by
 * normalizeKind() (matching the legacy kindFromLedgerCode behavior).
 */
export const KIND_ALIASES = Object.freeze((() => {
  const out = {}
  for (const [kind, record] of Object.entries(FAILURE_TAXONOMY)) {
    for (const alias of record.aliases) out[alias] = kind
  }
  return out
})())

/** Account cooldown table, derived from taxonomy records having a cooldown. */
export const BASE_COOLDOWN_MS = Object.freeze((() => {
  const out = {}
  for (const [kind, record] of Object.entries(FAILURE_TAXONOMY)) {
    if (record.baseCooldownMs !== null) out[kind] = record.baseCooldownMs
  }
  return out
})())

/** Codes that decide at the account (credential) layer, derived from layer. */
export const ACCOUNT_KINDS = Object.freeze(
  Object.keys(FAILURE_TAXONOMY).filter(kind => FAILURE_TAXONOMY[kind].layer === 'account'),
)
/** Request-construction kinds: penalize neither layer. */
export const NO_PENALTY_KINDS = Object.freeze(
  Object.keys(FAILURE_TAXONOMY).filter(kind => FAILURE_TAXONOMY[kind].layer === 'request'),
)
/** Model/endpoint kinds, derived from layer. */
export const MODEL_LAYER_KINDS = Object.freeze(
  Object.keys(FAILURE_TAXONOMY).filter(kind => FAILURE_TAXONOMY[kind].layer === 'model'),
)

/** Cooldown presets, derived from taxonomy cooldowns (adapter.js COOLDOWN_MS). */
export const COOLDOWN_MS = Object.freeze({
  quotaDefault: FAILURE_TAXONOMY.QUOTA.baseCooldownMs,
  rateLimitDefault: FAILURE_TAXONOMY.RATE_LIMIT.baseCooldownMs,
  authInvalid: FAILURE_TAXONOMY.AUTH.baseCooldownMs,
  upstreamJitter: FAILURE_TAXONOMY.SERVER_JITTER.baseCooldownMs,
})

/**
 * Normalize a code to its canonical FailureKind, aligning with the legacy
 * KIND_ALIASES + kindFromLedgerCode semantics. Null/empty -> null; unknown
 * codes -> 'UNKNOWN'; bare HTTP codes map 402/429/401/403/404/5xx.
 * Never throws, never mutates.
 * @param {unknown} code
 * @returns {string|null}
 */
export function normalizeKind(code) {
  if (code == null || code === '') return null
  let key
  try { key = String(code).toUpperCase() } catch { return 'UNKNOWN' }
  const aliased = KIND_ALIASES[key]
  if (aliased) return aliased
  if (/^\d{3}$/.test(key)) {
    if (key === '402') return 'QUOTA'
    if (key === '429') return 'RATE_LIMIT'
    if (key === '401' || key === '403') return 'AUTH'
    if (key === '404') return 'RENAMED'
    if (key.startsWith('5')) return 'SERVER_JITTER'
  }
  return 'UNKNOWN'
}
