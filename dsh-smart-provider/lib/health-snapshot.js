/**
 * Health snapshot — the frozen wire shape behind
 * SmartProviderRemote.accountHealth() (see 可用性自动管理设计.md /
 * 账号池自动管理深化设计.md / 两层智能路由设计.md).
 *
 * PURE: no I/O, no DSH import, no mutation of the input, never throws.
 * `now` is injected so the snapshot is deterministic in tests; Date.now() is
 * only the fallback when the caller omits it.
 *
 * ---------------------------------------------------------------------------
 * Derivation rules (frozen; the Host and the client codec depend on them)
 * ---------------------------------------------------------------------------
 * record  = accountHealth?.records?.get(id)      (a bare Map is accepted too)
 * legacy  = cooldowns?.get(id); legacyCooling = legacy.until > now
 *
 * state:
 *   record.state === 'COOLING' && (until not finite || until <= now) -> 'HALF_OPEN'
 *     (this is exactly account-health's stateOf() rule, re-derived READ-ONLY:
 *      stateOf() writes COOLING->HALF_OPEN back into the registry, and a read
 *      path must never mutate the state container)
 *   otherwise -> record.state; no record -> 'UNKNOWN'
 *   legacyCooling -> forced 'COOLING' (dispatch really is blocked by it, so
 *     the UI must agree with dispatch)
 *
 * until:
 *   max(record.until when the derived state is 'COOLING' and it is finite,
 *       legacy.until when legacyCooling); neither -> null
 *   The effective cooldown is the MAX because both layers block a dispatch.
 *
 * reason:
 *   (state === 'COOLING' && record.reason) || legacy.reason || null
 *
 * remainingMs: until ? max(0, until - now) : 0
 * usage:       usage?.get(id) ?? 0
 * streak/samples/lastSuccessAt/lastFailureAt: straight from the record,
 *              missing or non-finite -> 0 / {success:0,failure:0} / null
 *
 * routes: every own value of availabilityRegistry, skipping non-objects,
 *   entries without a usable key, and key.isVirtual === true (§6.2 hard
 *   isolation: a virtual smart copy is never a real route). health/tier/
 *   confidence/samples/last*At come from the L1 record; missing fields are
 *   reported as 'UNKNOWN' / 'unknown' / 0 / zero samples / null — never as a
 *   healthy verdict (zero samples means "no data", not "unavailable").
 *
 * Ordering: accounts by id ascending; routes by `provider::modelId` ascending.
 * Malformed or missing input yields empty arrays and enabled:false — the wire
 * contract has no error channel, so the snapshot degrades honestly instead of
 * throwing.
 */

const ACCOUNT_STATES = new Set(['UNKNOWN', 'ACTIVE', 'COOLING', 'HALF_OPEN'])
const COOLING = 'COOLING'
const HALF_OPEN = 'HALF_OPEN'
const UNKNOWN = 'UNKNOWN'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Finite number or the fallback. NaN/Infinity/strings never leak onto the wire. */
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** Non-empty string or the fallback (the wire contract has no undefined). */
function str(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Finite number or null — the contract's "no data" for timestamps. */
function nullable(value) {
  return Number.isFinite(value) ? value : null
}

function samplesOf(raw) {
  const samples = isObject(raw) ? raw : {}
  return { success: num(samples.success, 0), failure: num(samples.failure, 0) }
}

/** The L2b registry keeps its records in `records`; a bare Map is tolerated. */
function recordsOf(registry) {
  if (!registry || typeof registry !== 'object') return null
  if (registry.records instanceof Map) return registry.records
  if (registry instanceof Map) return registry
  return null
}

/** Map lookup that also tolerates a plain object keyed by account id. */
function lookup(container, id) {
  if (!container || typeof container !== 'object') return undefined
  if (container instanceof Map) return container.get(id)
  return Object.prototype.hasOwnProperty.call(container, id) ? container[id] : undefined
}

/**
 * Normalize the accounts input into an array. A Map (the pool's byId) yields
 * its values, any other iterable is spread, anything else is empty.
 */
function accountList(value) {
  if (value instanceof Map) return [...value.values()]
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    return [...value]
  }
  return []
}

function accountRow(account, records, source, now) {
  const id = account.id
  const record = records ? records.get(id) : undefined
  const legacy = lookup(source.cooldowns, id)
  const legacyUntil = isObject(legacy) ? legacy.until : undefined
  const legacyCooling = Number.isFinite(legacyUntil) && legacyUntil > now
  const recordUntil = isObject(record) ? record.until : undefined

  let state = str(isObject(record) ? record.state : undefined, UNKNOWN)
  if (state === COOLING && (!Number.isFinite(recordUntil) || recordUntil <= now)) {
    state = HALF_OPEN
  }
  if (!ACCOUNT_STATES.has(state)) state = UNKNOWN
  if (legacyCooling) state = COOLING

  const candidates = []
  if (state === COOLING && Number.isFinite(recordUntil)) candidates.push(recordUntil)
  if (legacyCooling) candidates.push(legacyUntil)
  const until = candidates.length > 0 ? Math.max(...candidates) : null

  const recordReason = state === COOLING && isObject(record) ? str(record.reason, null) : null
  const legacyReason = isObject(legacy) ? str(legacy.reason, null) : null
  const reason = recordReason || legacyReason || null

  return {
    id,
    provider: str(account.provider, ''),
    implicit: account.implicit === true,
    models: Array.isArray(account.models)
      ? account.models.filter(model => typeof model === 'string' && model !== '')
      : [],
    state,
    reason,
    until,
    remainingMs: until === null ? 0 : Math.max(0, until - now),
    streak: num(isObject(record) ? record.streak : undefined, 0),
    samples: samplesOf(isObject(record) ? record.samples : undefined),
    usage: num(lookup(source.usage, id), 0),
    lastSuccessAt: nullable(isObject(record) ? record.lastSuccessAt : undefined),
    lastFailureAt: nullable(isObject(record) ? record.lastFailureAt : undefined),
  }
}

function buildAccounts(source, records, now) {
  const rows = []
  for (const account of accountList(source.accounts)) {
    if (!isObject(account)) continue
    const id = str(account.id, '')
    if (!id) continue
    rows.push(accountRow(account, records, source, now))
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function routeRow(record) {
  if (!isObject(record)) return null
  const key = record.key
  if (!isObject(key)) return null
  if (key.isVirtual === true) return null // §6.2: virtual copies never surface
  const provider = str(key.provider, '')
  const modelId = str(key.modelId, '')
  if (!provider || !modelId) return null
  return {
    provider,
    modelId,
    health: str(record.health, UNKNOWN),
    tier: str(record.billingTier, 'unknown'),
    confidence: num(record.confidence, 0),
    samples: samplesOf(record.samples),
    lastSuccessAt: nullable(record.lastSuccessAt),
    lastFailureAt: nullable(record.lastFailureAt),
  }
}

function buildRoutes(registry) {
  if (!registry || typeof registry !== 'object') return []
  const records = registry instanceof Map ? [...registry.values()] : Object.values(registry)
  const rows = []
  for (const record of records) {
    const row = routeRow(record)
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => {
    const left = `${a.provider}::${a.modelId}`
    const right = `${b.provider}::${b.modelId}`
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * Build the accountHealth() wire snapshot.
 *
 * @param {{
 *   enabled?: boolean,
 *   now?: number,
 *   accounts?: Iterable<{id:string, provider:string, models?:string[], implicit?:boolean}>|Map<string, object>,
 *   cooldowns?: Map<string, {until:number, reason?:string}>,
 *   usage?: Map<string, number>,
 *   accountHealth?: {records: Map<string, object>}|Map<string, object>,
 *   availabilityRegistry?: Record<string, object>,
 * }} [input]
 * @returns {{
 *   enabled: boolean,
 *   generatedAt: number,
 *   accounts: Array<object>,
 *   routes: Array<object>,
 * }}
 */
export function buildHealthSnapshot(input) {
  const source = isObject(input) ? input : {}
  const now = num(source.now, Date.now())
  const enabled = source.enabled === true
  try {
    return {
      enabled,
      generatedAt: now,
      accounts: buildAccounts(source, recordsOf(source.accountHealth), now),
      routes: buildRoutes(source.availabilityRegistry),
    }
  } catch {
    // The wire contract has no error channel: degrade to "nothing known".
    return { enabled: false, generatedAt: now, accounts: [], routes: [] }
  }
}

export default { buildHealthSnapshot }
