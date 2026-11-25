/**
 * Account-level evidence-driven health state machine.
 *
 * Source of truth: 账号池自动管理深化设计.md §2 (four states), §3 (failure
 * layering), §1.2/§1.5 (isDispatchable + one-way dependency), §6 (contract).
 *
 * No DSH imports, no I/O, no requests. The record objects are immutable:
 * every transition creates a new record. `registry` is the explicit state
 * container; the note and reserve functions are the only writers to it.
 *
 * Why this exists: the old adapter used `isHealthy = !cool || cool.until <= now`
 * (adapter.js:176-177) and deleted the cooldown on success (adapter.js:428).
 * But a cooling account was hard-filtered before it could ever receive the
 * request that would produce that success, so recovery was 100% time-based.
 * Here a cooling account becomes HALF_OPEN on expiry and may receive ONE real
 * user request; only its real result restores it to ACTIVE. No probe requests.
 */

/** @typedef {'UNKNOWN'|'ACTIVE'|'COOLING'|'HALF_OPEN'} AccountState */

export const ACCOUNT_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  ACTIVE: 'ACTIVE',
  COOLING: 'COOLING',
  HALF_OPEN: 'HALF_OPEN',
})

/** Ranking multiplier from design §4 (COOLING never enters the sort). */
export const STATE_WEIGHTS = Object.freeze({
  ACTIVE: 1,
  UNKNOWN: 0.8,
  HALF_OPEN: 0.5,
  COOLING: 0,
})

/** FailureKind values that are decided by the account (credential) layer. */
const ACCOUNT_KINDS = new Set([
  'QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL',
  'RATE_LIMIT', 'SERVER_JITTER',
])

/** Request-construction failures: penalize neither layer (design §3). */
const NO_PENALTY_KINDS = new Set(['SESSION_HEADER', 'PARAM_COMPAT'])

/** Model/endpoint failures: handled by RouteHealthRegistry, not here. */
const MODEL_LAYER_KINDS = new Set(['RENAMED', 'OFFLINE', 'VIRTUAL'])

/** Base cooldown per kind (design §3; adapter.js:35-39 for the legacy values). */
const BASE_COOLDOWN_MS = Object.freeze({
  QUOTA: 30 * 60 * 1000,
  ACCOUNT_QUOTA: 30 * 60 * 1000,
  AUTH: 24 * 60 * 60 * 1000,
  INVALID_CREDENTIAL: 24 * 60 * 60 * 1000,
  RATE_LIMIT: 60 * 1000,
  SERVER_JITTER: 5 * 1000,
})

export const DEFAULT_HEALTH_CONFIG = Object.freeze({
  halfOpenPermits: 1,
  backoffFactor: 2,
  maxCooldownMs: 24 * 60 * 60 * 1000,
  defaultCooldownMs: 5 * 1000,
})

/** Alias normalization: raw adapter codes and classifyFailure kinds both work. */
const KIND_ALIASES = Object.freeze({
  QUOTA: 'QUOTA', ACCOUNT_QUOTA: 'ACCOUNT_QUOTA', CODE_402: 'QUOTA',
  AUTH: 'AUTH', INVALID_CREDENTIAL: 'INVALID_CREDENTIAL', CODE_401: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT', RATELIMIT: 'RATE_LIMIT', CODE_429: 'RATE_LIMIT',
  SERVER: 'SERVER_JITTER', TIMEOUT: 'SERVER_JITTER', TRANSPORT: 'SERVER_JITTER',
  STREAM_CLOSED: 'SERVER_JITTER', SERVER_JITTER: 'SERVER_JITTER',
  SESSION_HEADER: 'SESSION_HEADER', PARAM_COMPAT: 'PARAM_COMPAT',
  RENAMED: 'RENAMED', OFFLINE: 'OFFLINE', VIRTUAL: 'VIRTUAL', UNKNOWN_MODEL: 'RENAMED',
  MODEL_UNSUPPORTED: 'RENAMED', UNSUPPORTED_REASONING_EFFORT: 'PARAM_COMPAT',
  UNKNOWN: 'UNKNOWN', EMPTY_RESPONSE: 'UNKNOWN', ABORTED: 'UNKNOWN',
})

/**
 * Ledger failure_code -> FailureKind (used by rebuildFromLedger).
 *
 * The adapter writes SYMBOLIC codes (QUOTA / AUTH / SERVER / UNKNOWN_MODEL ...),
 * and those are the primary path. Older or third-party ledgers may instead have
 * recorded the bare HTTP status; the §4 table maps those unambiguously, so cold
 * rebuild stays faithful instead of degrading a known failure to UNKNOWN.
 */
export function kindFromLedgerCode(code) {
  if (code == null || code === '') return null
  const key = String(code).toUpperCase()
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

/**
 * Create an empty registry. `config.isCandidate` and `config.isAggregator` are
 * OPTIONAL read-only hooks supplied by the caller (L1 availability / L2a
 * topology). This module never imports or writes those layers — one-way
 * dependency per design §1.1.
 */
export function createAccountHealthRegistry(config = {}) {
  return {
    records: new Map(),
    config: { ...DEFAULT_HEALTH_CONFIG, ...config },
  }
}

function recordsOf(registry) {
  if (!registry || typeof registry !== 'object') return null
  if (registry.records instanceof Map) return registry.records
  if (registry instanceof Map) return registry
  return null
}

function configOf(registry) {
  return (registry && registry.config) || DEFAULT_HEALTH_CONFIG
}

function cloneRecord(record) {
  return { ...record, samples: { ...(record.samples ?? { success: 0, failure: 0 }) } }
}

function makeRecord(accountId, now, config) {
  return {
    accountId: String(accountId),
    state: ACCOUNT_STATES.UNKNOWN,
    streak: 0,
    samples: { success: 0, failure: 0 },
    halfOpenPermits: config.halfOpenPermits,
    updatedAt: now,
  }
}

function normalizeKind(kind) {
  if (kind && typeof kind === 'object') {
    const raw = kind.kind ?? kind.code ?? 'UNKNOWN'
    return { kind: KIND_ALIASES[String(raw).toUpperCase()] ?? 'UNKNOWN', raw }
  }
  const raw = kind == null ? 'UNKNOWN' : String(kind).toUpperCase()
  return { kind: KIND_ALIASES[raw] ?? 'UNKNOWN', raw }
}

function hookProvider(kind, record) {
  if (kind && typeof kind === 'object') {
    return kind.provider ?? kind.routeKey?.provider ?? kind.actualProvider ?? undefined
  }
  return undefined
}

/** True when the provider is declared/observed as an account-aggregating route. */
function isAggregatorAccount(registry, accountId, kind) {
  const config = configOf(registry)
  if (kind && typeof kind === 'object' && kind.aggregator === true) return true
  const record = recordsOf(registry)?.get(accountId)
  const provider = hookProvider(kind, record) ?? record?.provider
  if (!provider) return false
  if (typeof config.isAggregator === 'function') {
    if (config.isAggregator(provider) === true) return true
  }
  const declared = config.aggregators
  if (declared instanceof Set) return declared.has(provider)
  if (Array.isArray(declared)) return declared.includes(provider)
  return false
}

/** Read-only model-layer gate. Missing hook = no model layer = allow. */
function routeIsCandidate(registry, routeKey) {
  const config = configOf(registry)
  if (typeof config.isCandidate === 'function') return config.isCandidate(routeKey) !== false
  const reader = registry?.availability ?? registry?.routes
  if (reader && typeof reader.isCandidate === 'function') {
    return reader.isCandidate(routeKey) !== false
  }
  return true
}

/**
 * Effective state of one account at `now`.
 *
 * COOLING whose `until` has elapsed lazily becomes HALF_OPEN — never ACTIVE.
 * HALF_OPEN persists without real traffic (design §8: no evidence, no recovery).
 * This write-through transition is what makes the half-open permit available.
 *
 * @returns {AccountState}
 */
export function stateOf(registry, accountId, now = Date.now()) {
  const records = recordsOf(registry)
  const record = records?.get(accountId)
  if (!record) return ACCOUNT_STATES.UNKNOWN
  if (record.state === ACCOUNT_STATES.COOLING
      && (!Number.isFinite(record.until) || record.until <= now)) {
    const next = {
      ...cloneRecord(record),
      state: ACCOUNT_STATES.HALF_OPEN,
      halfOpenPermits: configOf(registry).halfOpenPermits,
      updatedAt: now,
    }
    if (records) records.set(accountId, next)
    return ACCOUNT_STATES.HALF_OPEN
  }
  return record.state
}

/** Ranking multiplier for a state (unknown inputs get no boost). */
export function weightOf(state) {
  return STATE_WEIGHTS[state] ?? 0
}

/** Read-only snapshot; never creates a record. */
export function getRecord(registry, accountId) {
  const record = recordsOf(registry)?.get(accountId)
  return record ? cloneRecord(record) : undefined
}

/**
 * Record a real successful attempt. This is the evidence that restores a
 * HALF_OPEN (or any) account to ACTIVE and clears its failure streak.
 */
export function noteSuccess(registry, accountId, now = Date.now(), kind) {
  const config = configOf(registry)
  const records = recordsOf(registry)
  const previous = records?.get(accountId)
  const base = previous ? cloneRecord(previous) : makeRecord(accountId, now, config)
  const { until, reason, ...clean } = base
  const provider = hookProvider(kind, base)
  const next = {
    ...clean,
    ...(provider ? { provider } : {}),
    state: ACCOUNT_STATES.ACTIVE,
    streak: 0,
    samples: { ...clean.samples, success: clean.samples.success + 1 },
    halfOpenPermits: config.halfOpenPermits,
    lastSuccessAt: now,
    updatedAt: now,
  }
  if (records) records.set(accountId, next)
  return next
}

/**
 * Record a real failed attempt and apply failure layering (design §3):
 *  - compat/header and model-layer failures do NOT touch the account record;
 *  - UNKNOWN only adds a sample;
 *  - credential/account failures cool the account with streak backoff;
 *  - aggregator providers never enter this layer at all (§1.5).
 *
 * `kind` may be a FailureKind string, a classifyFailure() result object, or a
 * raw adapter code — all are normalized. Returns a record snapshot.
 */
export function noteFailure(registry, accountId, kind, now = Date.now()) {
  const config = configOf(registry)
  const records = recordsOf(registry)
  const previous = records?.get(accountId)
  const base = previous ? cloneRecord(previous) : makeRecord(accountId, now, config)
  const normalized = normalizeKind(kind)

  // Topological exception: an aggregator's credential failure is not ours.
  if (isAggregatorAccount(registry, accountId, kind)) return base
  // Request-construction / model-endpoint failures: penalize nobody here.
  if (NO_PENALTY_KINDS.has(normalized.kind) || MODEL_LAYER_KINDS.has(normalized.kind)) return base

  const provider = hookProvider(kind, base)

  if (normalized.kind === 'UNKNOWN') {
    const next = {
      ...base,
      ...(provider ? { provider } : {}),
      samples: { ...base.samples, failure: base.samples.failure + 1 },
      lastFailureAt: now,
      updatedAt: now,
    }
    if (records) records.set(accountId, next)
    return next
  }

  if (!ACCOUNT_KINDS.has(normalized.kind)) {
    // Unrecognized kinds are honest UNKNOWN samples, never a penalty.
    const next = {
      ...base,
      samples: { ...base.samples, failure: base.samples.failure + 1 },
      updatedAt: now,
    }
    if (records) records.set(accountId, next)
    return next
  }

  const streak = (previous?.streak ?? 0) + 1
  // Design §2.2 writes backoffFactor^streak; streak starts at 1 and §3 says
  // "30min 起", so exponent streak-1 keeps the FIRST failure at the base value.
  const exponent = Math.max(0, streak - 1)
  const baseMs = BASE_COOLDOWN_MS[normalized.kind] ?? config.defaultCooldownMs
  const delay = Math.min(config.maxCooldownMs, Math.round(baseMs * Math.pow(config.backoffFactor, exponent)))
  const { until, reason, ...clean } = base
  const next = {
    ...clean,
    ...(provider ? { provider } : {}),
    state: ACCOUNT_STATES.COOLING,
    until: now + delay,
    reason: normalized.kind,
    streak,
    samples: { ...clean.samples, failure: clean.samples.failure + 1 },
    halfOpenPermits: config.halfOpenPermits,
    lastFailureAt: now,
    updatedAt: now,
  }
  if (records) records.set(accountId, next)
  return next
}

/**
 * Consume half-open quota. Returns false unless the account is HALF_OPEN and
 * still has permits. Call stateOf(registry, id, now) first so an elapsed
 * COOLING has transitioned. One real user request = one permit.
 */
export function reserveHalfOpen(registry, accountId, amount = 1) {
  const records = recordsOf(registry)
  const record = records?.get(accountId)
  if (!record || record.state !== ACCOUNT_STATES.HALF_OPEN) return false
  const count = Number.isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1
  const remaining = Number(record.halfOpenPermits ?? 0)
  if (remaining <= 0) return false
  const now = Date.now()
  records.set(accountId, {
    ...cloneRecord(record),
    halfOpenPermits: Math.max(0, remaining - count),
    updatedAt: now,
  })
  return true
}

/**
 * Final dispatch decision (design §1.2): model-layer permission ∩ account
 * state, with aggregator routes bypassing the account layer entirely.
 *
 * One-way dependency: only READS `config.isCandidate` / `registry.availability`;
 * never writes or imports the availability layer.
 */
export function isDispatchable(registry, accountId, routeKey, now = Date.now()) {
  if (!routeIsCandidate(registry, routeKey)) return false
  const provider = routeKey?.provider ?? recordsOf(registry)?.get(accountId)?.provider
  if (provider && isAggregatorAccount(registry, accountId, { provider })) return true
  return stateOf(registry, accountId, now) !== ACCOUNT_STATES.COOLING
}

/**
 * Rebuild a registry from cost.jsonl (or an array of already-parsed rows).
 * Rows are replayed in ledger order; `failure_code == null` means success.
 * Malformed lines are skipped — a partial ledger must not block cold start.
 */
export function rebuildFromLedger(costJsonl, config = {}) {
  const registry = createAccountHealthRegistry(config)
  const lines = typeof costJsonl === 'string'
    ? costJsonl.split(/\r?\n/)
    : Array.isArray(costJsonl) ? costJsonl : []
  for (const line of lines) {
    let row = line
    if (typeof line === 'string') {
      if (!line.trim()) continue
      try { row = JSON.parse(line) } catch { continue }
    }
    if (!row || typeof row !== 'object') continue
    const accountId = row.account_id
    if (accountId == null || accountId === '') continue
    const parsed = Date.parse(row.timestamp)
    const now = Number.isFinite(parsed) ? parsed : Date.now()
    const code = row.failure_code
    const routeKey = {
      provider: row.actual_provider ?? row.provider,
      modelId: row.actual_model ?? row.model,
    }
    if (code == null || code === '') {
      noteSuccess(registry, accountId, now, routeKey)
    } else {
      noteFailure(registry, accountId, { kind: kindFromLedgerCode(code), ...routeKey }, now)
    }
  }
  return registry
}

export default {
  ACCOUNT_STATES,
  STATE_WEIGHTS,
  DEFAULT_HEALTH_CONFIG,
  kindFromLedgerCode,
  createAccountHealthRegistry,
  stateOf,
  weightOf,
  getRecord,
  noteSuccess,
  noteFailure,
  reserveHalfOpen,
  isDispatchable,
  rebuildFromLedger,
}
