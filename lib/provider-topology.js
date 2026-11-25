/**
 * lib/provider-topology.js — Provider pool topology classification (pure).
 *
 * Source of truth: 账号池自动管理深化设计.md §1.0-1.4, §6 (contract), §7 (tests).
 *
 * WHY this layer exists (§1.0):
 *   Some providers are AGGREGATORS — a third-party plugin exposes ONE route but
 *   internally pools many accounts (it rotates/cools them itself). Wrapping our
 *   own account-pool around such a route makes two pools fight each other. A
 *   DIRECT provider (one key, one route) does need our account layer. This
 *   module decides "should we build an account layer at all"; it is the gate in
 *   front of account-health / account-pool — no DSH dependency, no I/O, no side
 *   effects.
 *
 * HARD RULE (§1.0.1): NO provider-name allow/deny list. Nothing here inspects
 *   the provider string to decide. New plugins and aliases must be recognised
 *   from STRUCTURED EVIDENCE only:
 *     P0  declared flag      provider.aggregatesAccounts === true|false
 *     P1  runtime observation >1 distinct account_id for the same provider+model
 *     P1  capability shape   config declares accounts / regions / pool
 *     P2  unknown            no evidence → 'UNKNOWN' (conservative: treat as
 *                            DIRECT, but mark topology unconfirmed)
 *   `provider` stays in the signatures only to honour the §6 contract and to
 *   attach evidence/warnings; it is never used as a classification key.
 */

/** Verdict constants (§1.0.1 three tiers). */
export const AGGREGATOR = true
export const DIRECT = false
export const UNKNOWN = 'UNKNOWN'

/**
 * Normalise an account-id input into a Set of non-empty strings.
 * Accepts a Set, an array of ids, an array of ledger rows ({accountId|account_id}),
 * or a single id. Anything else yields an empty Set (→ UNKNOWN, never a crash).
 * @param {unknown} value
 * @returns {Set<string>}
 */
function normalizeIdSet(value) {
  const out = new Set()
  if (value === undefined || value === null) return out
  if (value instanceof Set) {
    for (const v of value) if (typeof v === 'string' && v) out.add(v)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v) out.add(v)
      else if (v && typeof v === 'object') {
        const id = v.accountId ?? v.account_id
        if (typeof id === 'string' && id) out.add(id)
      }
    }
    return out
  }
  if (typeof value === 'string' && value) out.add(value)
  return out
}

/**
 * P1 (observed account cardinality): distinct account ids for one provider,
 * optionally scoped to one model ("same provider + same model" per §1.0.1).
 * Observations are plain ledger/session rows: { provider, modelId?, accountId }.
 * @param {unknown} observations array of observation rows
 * @param {string} provider
 * @param {string} [modelId] when given, only rows for this model are counted
 * @returns {Set<string>}
 */
export function observedAccountIdsFor(observations, provider, modelId) {
  const out = new Set()
  if (!Array.isArray(observations)) return out
  for (const row of observations) {
    if (!row || typeof row !== 'object') continue
    if (row.provider !== provider) continue
    if (modelId !== undefined && row.modelId !== modelId && row.model !== modelId) continue
    const id = row.accountId ?? row.account_id
    if (typeof id === 'string' && id) out.add(id)
  }
  return out
}

/**
 * P1 (capability shape): does a provider declaration advertise an internal
 * pool? Checks the declaration itself and its common nested capability shells.
 * A non-empty accounts/regions array or a pool flag means the plugin manages
 * accounts internally — no name needed.
 * @param {unknown} declaration
 * @returns {boolean}
 */
export function hasPoolCapability(declaration) {
  if (!declaration || typeof declaration !== 'object') return false
  const sources = [declaration, declaration.capabilities, declaration.config, declaration.declared]
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    if (Array.isArray(src.accounts) && src.accounts.length >= 1) return true
    if (Array.isArray(src.regions) && src.regions.length >= 1) return true
    if (src.aggregatesAccounts === true) return true
    if (src.pool === true || (src.pool && typeof src.pool === 'object')) return true
  }
  return false
}

/**
 * Core §6 contract:
 *   isAggregator(provider, declaredFlag?, observedAccountIds) → boolean|'UNKNOWN'
 *
 * Priority: declaredFlag (P0) > observed cardinality > 1 (P1) > UNKNOWN (P2).
 * `provider` is intentionally NOT consulted — classification is structural.
 *
 * @param {string} provider route id (evidence/telemetry only, never a key)
 * @param {boolean|undefined} declaredFlag provider.aggregatesAccounts
 * @param {Set<string>|Array<string>|Array<object>|string|undefined} observedAccountIds
 * @returns {true|false|'UNKNOWN'}
 */
export function isAggregator(provider, declaredFlag, observedAccountIds) {
  void provider // contract slot; no name-based decision, ever (§1.0.1)
  if (declaredFlag === true) return AGGREGATOR
  if (declaredFlag === false) return DIRECT
  const ids = normalizeIdSet(observedAccountIds)
  if (ids.size > 1) return AGGREGATOR
  return UNKNOWN
}

/**
 * §1.0.2 / §7: an UNKNOWN topology auto-upgrades to AGGREGATOR once a
 * multi-account observation arrives; an already-AGGREGATOR verdict never
 * downgrades (evidence is monotonic). An explicit DIRECT declaration (P0
 * false) is a deliberate choice and is not overridden by observation.
 * Pure reducer: returns the new verdict, mutates nothing.
 *
 * @param {true|false|'UNKNOWN'} current
 * @param {string} provider
 * @param {unknown} sample a fresh observation (account id set/rows)
 * @param {boolean|undefined} [declaredFlag]
 * @returns {true|false|'UNKNOWN'}
 */
export function observeTopology(current, provider, sample, declaredFlag) {
  if (current === AGGREGATOR || current === true) return AGGREGATOR
  if (declaredFlag === false) return DIRECT
  return isAggregator(provider, declaredFlag, sample)
}

/**
 * §1.4 two-layer coexistence verdict.
 *
 * When the topology says AGGREGATOR, we never build our own account layer —
 * even if the user explicitly configured accounts for that provider: the
 * plugin still picks accounts internally, so our entries would be no-ops and
 * would only create a false "I configured it, it works" state. We do NOT drop
 * them silently: `warnings` carries an AGGREGATOR_ACCOUNTS_IGNORED record for
 * the loader / first screen to surface.
 *
 * Explicit, informed, reversible exception: an account entry with
 * `forceAccountLayer: true` overrides the transparent path (forceAccountLayer
 * is a per-account flag; any such entry keeps the whole account layer for that
 * provider). It is never a product default.
 *
 * @param {string} provider
 * @param {Array<object>} [accounts] local account entries for this provider
 * @param {object} [opts]
 * @param {boolean} [opts.declaredFlag] P0 provider.aggregatesAccounts
 * @param {unknown} [opts.observedAccountIds] P1 account-id evidence
 * @param {unknown} [opts.declaration] P1 capability-shape declaration
 * @param {boolean} [opts.poolCapability] explicit P1 capability verdict
 * @returns {{provider:string, topology:'aggregator'|'direct'|'unknown',
 *   aggregator:boolean, transparent:boolean, accounts:Array<object>,
 *   ignoredAccounts:number, forceAccountLayer:boolean, warnings:Array<object>}}
 */
export function resolveTopology(provider, accounts, opts = {}) {
  const list = Array.isArray(accounts) ? accounts : []
  const declaredFlag = opts.declaredFlag
  const forced = list.some(a => a && typeof a === 'object' && a.forceAccountLayer === true)
  const poolCapability = opts.poolCapability === true || hasPoolCapability(opts.declaration)

  let topology
  if (poolCapability) {
    topology = 'aggregator'
  } else {
    const verdict = isAggregator(provider, declaredFlag, opts.observedAccountIds)
    topology = verdict === true ? 'aggregator' : verdict === false ? 'direct' : 'unknown'
  }

  // Transparent = aggregator by topology AND no informed override.
  const transparent = topology === 'aggregator' && !forced
  const warnings = []
  if (transparent && list.length > 0) {
    warnings.push({
      code: 'AGGREGATOR_ACCOUNTS_IGNORED',
      provider,
      count: list.length,
      message: `provider "${provider}" 自带账号池，已忽略 ${list.length} 条本地 account 配置（forceAccountLayer:true 可覆盖）`,
    })
  }
  if (topology === 'aggregator' && forced) {
    warnings.push({
      code: 'FORCE_ACCOUNT_LAYER',
      provider,
      message: `provider "${provider}" 被识别为自带池，但 forceAccountLayer=true 显式强制建账号层`,
    })
  }

  return {
    provider,
    topology,
    aggregator: topology === 'aggregator',
    transparent,
    accounts: transparent ? [] : list.slice(),
    ignoredAccounts: transparent ? list.length : 0,
    forceAccountLayer: forced,
    warnings,
  }
}
