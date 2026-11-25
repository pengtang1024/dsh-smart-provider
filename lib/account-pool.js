/**
 * Account pool — the orthogonal "which credential" dimension.
 *
 * DSH / pi-ai binds one API key to one provider route (verified 2026-11-23:
 * PiAiProviderProfile has a single `apiKeyEnv`). A second account of the same
 * vendor is therefore a second route. An Account wraps one such route plus
 * the models it can serve:
 *
 *   Account = { id, provider, credentialRef, models }
 *   Pool    = Map<model, Account[]>   (+ id index + usage counters)
 *
 * Selection happens in two independent layers:
 *   1. `resolveChain(outerModel, chains)` picks an ordered list of hops
 *      ({provider, model}) — the MODEL / vendor fallback order.
 *   2. The pool expands each hop into one or more ACCOUNT attempts, skipping
 *      cooled-down accounts. Account failover happens before model failover:
 *      try every healthy account for a model, then move to the next model.
 *
 * Backward compatibility: when no `accounts` config exists, implicit accounts
 * are derived 1:1 from chain hops and each hop expands to exactly one attempt
 * on its own route — byte-for-byte the legacy behaviour. Configuring accounts
 * is the only thing that changes request fan-out.
 */

import { rankAccountsForHop, normalizeAccountRanking } from './ranking.js'
import { resolveTopology } from './provider-topology.js'
import {
  stateOf as healthStateOf,
  isDispatchable,
  reserveHalfOpen,
  ACCOUNT_STATES,
} from './account-health.js'

/** Deterministic implicit account id for a legacy chain hop. */
export function implicitAccountId(provider, model) {
  return `hop:${provider}/${model}`
}

/**
 * P1 (task-9): effective sample window of the in-process speed evidence table.
 * The EWMA learning rate is 1/samples, so the first five real measurements
 * average out (a single outlier cannot pin an account) and later ones move the
 * estimate by at most 20% each.
 */
const SPEED_EVIDENCE_MAX_SAMPLES = 5

/**
 * Validate + normalize an `accounts` config array into Account descriptors.
 *
 * @param {unknown} value configured accounts (array of plain objects)
 * @returns {Array<{id:string, provider:string, credentialRef:string|undefined, models:string[]}>}
 */
export function normalizeAccounts(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('smart provider config `accounts` must be an array')
  }
  const seen = new Set()
  const accounts = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const { id, provider, credentialRef, models } = raw
    // P2 fix: preserve the user's per-account ranking properties (tier /
    // speedTier / priceTier ...). They live under `ranking` (schema.js) and
    // are read by ranking.js rankingOf(). Dropping them made layer-2 weights
    // inert for real user configs. Accounts without it stay byte-identical.
    const normalizedRanking = raw.ranking && typeof raw.ranking === 'object' && !Array.isArray(raw.ranking)
      ? normalizeAccountRanking(raw.ranking) : undefined
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    if (typeof provider !== 'string' || !provider) continue
    if (!Array.isArray(models) || models.length === 0) continue
    const cleanModels = models.filter(m => typeof m === 'string' && m !== '')
    if (cleanModels.length === 0) continue
    seen.add(id)
    accounts.push({
      id,
      provider,
      credentialRef: typeof credentialRef === 'string' ? credentialRef : undefined,
      models: [...new Set(cleanModels)],
      ...(normalizedRanking ? { ranking: normalizedRanking } : {}),
    })
  }
  return accounts
}

/**
 * In-memory account pool. Cooldown/health state lives in the adapter's
 * cooldown map; the pool consults it through the `isHealthy` predicate.
 */
export class AccountPool {
  /**
   * @param {object} [opts]
   * @param {Array<object>} [opts.accounts] normalized explicit accounts
   * @param {object} [opts.chains] chain table (used to derive implicit accounts)
   * @param {object} [opts.ranking] ranking config (off by default)
   * @param {(accountId:string, now:number) => boolean} [opts.isHealthy]
   *        cooldown predicate; defaults to "always healthy"
   * @param {Set<string>|Array<string>} [opts.allowedProviders] P2: when set,
   *        plan() only attempts hops whose provider is in this set (layer-1
   *        selected tiers). Absent = legacy behavior, byte-for-byte.
   * @param {object} [opts.topologyOpts] L2a resolveTopology options (declaredFlag,
   *        observedAccountIds, declaration). Only consumed when a topology
   *        resolver is available; absent = legacy behavior.
   * @param {object} [opts.accountHealth] L2b AccountHealthRegistry. When given,
   *        plan() gates every account through isDispatchable() and reserves
   *        HALF_OPEN permits. Absent = legacy isHealthy-only behavior.
   * @param {object} [opts.availabilityRegistry] L1 RouteHealthRegistry, passed
   *        to account-health as a read-only isCandidate hook. Never imported.
   * @param {Set<string>|Array<string>} [opts.virtualProviders] Provider ids whose
   *        routes are virtual smart copies (group==='smart'). Absent = none.
   * @param {Map<string, object>} [opts.speedEvidence] P1 (task-9) in-process
   *        measured-speed table, passed back in when the adapter rebuilds the
   *        pool so evidence survives a hot config reload. Absent = new table.
   */
  constructor({
    accounts = [], chains = {}, ranking, isHealthy, allowedProviders,
    topologyOpts, accountHealth, availabilityRegistry, virtualProviders,
    singleCooldown, speedEvidence,
  } = {}) {
    /** @type {object} ranking config; absent/disabled keeps legacy behavior */
    this.ranking = ranking
    /** @type {Set<string>|undefined} P2 layer-1 filter; undefined = legacy */
    this.allowedProviders = allowedProviders instanceof Set
      ? allowedProviders
      : (Array.isArray(allowedProviders) ? new Set(allowedProviders) : undefined)
    /** @type {Map<string, object>} */
    this.byId = new Map()
    /** @type {Map<string, object[]>} model -> accounts serving it, config order */
    this.byModel = new Map()
    /** @type {(accountId:string, now:number) => boolean} */
    this.isHealthy = typeof isHealthy === 'function' ? isHealthy : () => true
    /** @type {Map<string, number>} accountId -> completed attempts (round-robin cursor) */
    this.usage = new Map()
    /** @type {object|undefined} L2b account health registry (opt-in) */
    this.accountHealth = accountHealth
    /** @type {object|undefined} L1 model-layer registry (read-only hook source) */
    this.availabilityRegistry = availabilityRegistry
    /** @type {Set<string>|undefined} virtual smart routes (group==='smart') */
    this.virtualProviders = virtualProviders instanceof Set ? virtualProviders
      : (Array.isArray(virtualProviders) ? new Set(virtualProviders) : undefined)
    /** @type {Map<string, object>} provider -> resolved topology verdict */
    this.topologyByProvider = new Map()
    /** @type {object} L2a resolveTopology options */
    this.topologyOpts = topologyOpts && typeof topologyOpts === 'object' ? topologyOpts : {}
    /** @type {boolean} E2A: L2-only cooldown gate; default off = dual gate. */
    this.singleCooldown = singleCooldown === true
    /**
     * P1 (task-9) measured speed evidence: accountId -> EWMA of REAL
     * successful calls ({ttftMs, tokensPerSecond, samples}). In-process only;
     * never persisted and never written into the account records.
     * @type {Map<string, {ttftMs:number, tokensPerSecond?:number, samples:number}>}
     */
    this.speedEvidence = speedEvidence instanceof Map ? speedEvidence : new Map()

    const normalized = normalizeAccounts(accounts)
    this.configured = normalized.length > 0
    for (const account of normalized) this.#add(account)

    // Derive implicit accounts for chain hops that have no configured account
    // serving their model. In no-pool mode this is a 1:1 hop -> account map
    // (exact legacy keys); in partial-pool mode it keeps unconfigured models
    // usable as fallback.
    for (const hops of Object.values(chains)) {
      if (!Array.isArray(hops)) continue
      for (const hop of hops) {
        if (!hop || typeof hop.provider !== 'string' || typeof hop.model !== 'string') continue
        if (this.configured && this.byModel.has(hop.model)) continue
        const id = implicitAccountId(hop.provider, hop.model)
        if (this.byId.has(id)) continue
        this.#add({ id, provider: hop.provider, models: [hop.model], implicit: true })
      }
    }
  }

  #add(account) {
    this.byId.set(account.id, account)
    for (const model of account.models) {
      const list = this.byModel.get(model) ?? []
      list.push(account)
      this.byModel.set(model, list)
    }
  }

  /** @returns {object[]} accounts serving a model (may be empty) */
  accountsFor(model) {
    return this.byModel.get(model) ?? []
  }

  /** @returns {object|undefined} account by id */
  get(id) {
    return this.byId.get(id)
  }

  /** Record that an account was actually attempted (round-robin accounting). */
  noteAttempt(id) {
    this.usage.set(id, (this.usage.get(id) ?? 0) + 1)
  }

  /**
   * P1 (task-9): record ONE real successful call's measured latency.
   *
   * Only a real measurement is evidence: a missing / 0 / NaN / negative ttft is
   * ignored, so a failed or content-less attempt can never reshape selection
   * (the manual speedTier keeps deciding in that case). Samples fold into an
   * EWMA whose learning rate is 1/samples, with samples capped at
   * SPEED_EVIDENCE_MAX_SAMPLES — one outlier cannot pin an account.
   *
   * Purely in-process: nothing is persisted and no account record is mutated.
   *
   * @param {string} accountId
   * @param {{ttftMs?:number, tokensPerSecond?:number}} sample
   * @returns {boolean} true when the sample was accepted
   */
  recordLatency(accountId, sample) {
    if (typeof accountId !== 'string' || accountId === '') return false
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return false
    const ttftMs = Number(sample.ttftMs)
    if (!Number.isFinite(ttftMs) || ttftMs <= 0) return false
    const tpsRaw = Number(sample.tokensPerSecond)
    const tokensPerSecond = Number.isFinite(tpsRaw) && tpsRaw > 0 ? tpsRaw : undefined
    const prev = this.speedEvidence.get(accountId)
    if (!prev) {
      this.speedEvidence.set(accountId, {
        ttftMs,
        samples: 1,
        ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
      })
      return true
    }
    const samples = Math.min(prev.samples + 1, SPEED_EVIDENCE_MAX_SAMPLES)
    const alpha = 1 / samples
    const next = { ttftMs: prev.ttftMs + (ttftMs - prev.ttftMs) * alpha, samples }
    if (tokensPerSecond !== undefined) {
      next.tokensPerSecond = prev.tokensPerSecond === undefined
        ? tokensPerSecond
        : prev.tokensPerSecond + (tokensPerSecond - prev.tokensPerSecond) * alpha
    } else if (prev.tokensPerSecond !== undefined) {
      next.tokensPerSecond = prev.tokensPerSecond
    }
    this.speedEvidence.set(accountId, next)
    return true
  }

  /**
   * Snapshot of the measured-speed table in the shape ranking.js consumes:
   * accountId -> {ttftMs, tokensPerSecond?}. Accounts with no real measurement
   * are absent; every call returns a fresh plain object so callers
   * (scoreAccounts / a settings panel) can never corrupt the internal table.
   *
   * @returns {Record<string, {ttftMs:number, tokensPerSecond?:number}>}
   */
  readSpeedEvidence() {
    const out = {}
    for (const [id, sample] of this.speedEvidence) {
      out[id] = this.#evidenceEntry(sample)
    }
    return out
  }

  /** Project one internal EWMA row into the public evidence shape. */
  #evidenceEntry(sample) {
    const entry = { ttftMs: Math.round(sample.ttftMs) }
    if (sample.tokensPerSecond !== undefined) {
      entry.tokensPerSecond = Number(sample.tokensPerSecond.toFixed(3))
    }
    return entry
  }

  /**
   * Evidence for the accounts of ONE hop only, or undefined when none of them
   * was ever measured. Filtering here keeps plan() at O(accounts) lookups and
   * keeps ctx.speedEvidence completely absent on the unevidenced path, so a
   * user with no measurements gets byte-identical ordering.
   * @param {object[]} domain accounts serving the hop's model
   * @returns {Record<string, {ttftMs:number, tokensPerSecond?:number}>|undefined}
   */
  #evidenceFor(domain) {
    if (this.speedEvidence.size === 0) return undefined
    let out
    for (const account of domain) {
      const sample = this.speedEvidence.get(account.id)
      if (!sample) continue
      if (!out) out = {}
      out[account.id] = this.#evidenceEntry(sample)
    }
    return out
  }

  /**
   * Resolve (and memoize) the L2a topology verdict for one provider.
   *
   * A provider with no configured accounts is still resolved so aggregator
   * routes get their implicit single-account / no-account-cooldown treatment.
   * Pure: resolveTopology never mutates its inputs.
   */
  #topologyFor(provider) {
    if (this.topologyByProvider.has(provider)) return this.topologyByProvider.get(provider)
    const localAccounts = this.accountsForProvider(provider)
    const verdict = resolveTopology(provider, localAccounts, this.topologyOpts)
    this.topologyByProvider.set(provider, verdict)
    return verdict
  }

  /** @returns {object[]} configured (non-implicit) accounts of a provider */
  accountsForProvider(provider) {
    const out = []
    for (const account of this.byId.values()) {
      if (account.implicit) continue
      if (account.provider === provider) out.push(account)
    }
    return out
  }

  /**
   * Build the routeKey consumed by account-health → availability.isCandidate.
   *
   * CONTRACT (横向对齐写死): `{provider, modelId, isVirtual}`. `isVirtual` is
   * true when the provider is a virtual smart copy (group==='smart'), supplied
   * via `virtualProviders`. It MUST be present — availability.isCandidate only
   * rejects `key.isVirtual === true`; omitting it lets a virtual copy slip past
   * §6.2 hard isolation. Explicit `false` for normal routes (still non-virtual).
   */
  #routeKey(provider, modelId) {
    return {
      provider,
      modelId,
      isVirtual: this.virtualProviders?.has(provider) === true,
    }
  }

  /**
   * L2b dispatch gate for one account. Returns true when the account may be
   * attempted. No health registry = legacy isHealthy only (byte-identical).
   */
  #dispatchable(account, hop, now) {
    // Virtual smart copies never enter attempts (§6.2), regardless of health.
    if (this.virtualProviders?.has(account.provider) === true) return false
    // Legacy predicate still applies when present (adapter's cooldown map).
    // E2A on: L2 is the sole authority, so the legacy gate is skipped.
    if (!this.singleCooldown && !this.isHealthy(account.id, now)) return false
    if (!this.accountHealth) return true
    const routeKey = this.#routeKey(account.provider, hop.model)
    // L1 zero-sample allow: unknown normal keys remain dispatchable.
    return isDispatchable(this.accountHealth, account.id, routeKey, now)
  }

  /**
   * Build the ordered attempt list for one request.
   *
   * Implicit mode: one attempt per chain hop, exact legacy behavior.
   * Explicit mode: dedupe hops by model (first occurrence wins, preserving
   * chain priority); for each model order its accounts least-used first,
   * preferring accounts on the hop's route, then skip cooled-down ones.
   *
   * @param {Array<{provider:string, model:string}>} chain
   * @param {number} [now]
   * @returns {Array<{hopIndex:number, hop:{provider:string, model:string}, account:object}>}
   */
  /**
   * @param {Array<{provider:string,model:string}>} chain
   * @param {number} [now]
   * @param {Set<string>|Array<string>} [tierProviders] P2 per-request
   *        layer-1 filter; overrides the constructor-level filter when given.
   */
  plan(chain, now = Date.now(), tierProviders, rankingOverride) {
    const attempts = []
    const chosen = tierProviders !== undefined ? tierProviders : this.allowedProviders
    const allowed = chosen instanceof Set ? chosen
      : (Array.isArray(chosen) ? new Set(chosen) : undefined)
    // P2 fix: when routing is active, the second layer must actually consume
    // routingPolicy.weights. Override ranking only for this call; undefined
    // keeps the exact legacy path (省钱链路).
    const rankingCfg = rankingOverride && typeof rankingOverride === 'object'
      ? rankingOverride : this.ranking
    if (!this.configured) {
      chain.forEach((hop, hopIndex) => {
        // P2: layer-1 tier filter. No allowedProviders -> no change at all.
        if (allowed && !allowed.has(hop.provider)) return
        // §6.2: virtual smart copies never become hops.
        if (this.virtualProviders?.has(hop.provider) === true) return
        // L2a: transparent aggregator routes get exactly one implicit account
        // and never receive our account-level cooling. Route health stays at
        // model layer via the isDispatchable hook (account state is bypassed
        // inside account-health for aggregator providers).
        const topology = this.#topologyFor(hop.provider)
        if (topology.transparent) {
          const account = this.byId.get(implicitAccountId(hop.provider, hop.model))
          if (!account) return
          const routeKey = this.#routeKey(hop.provider, hop.model)
          if (this.accountHealth && !isDispatchable(this.accountHealth, account.id, routeKey, now)) return
          attempts.push({ hopIndex, hop, account })
          return
        }
        const account = this.byId.get(implicitAccountId(hop.provider, hop.model))
        if (!account || !this.#dispatchable(account, hop, now)) return
        if (this.accountHealth) {
          const state = healthStateOf(this.accountHealth, account.id, now)
          if (state === ACCOUNT_STATES.HALF_OPEN
              && !reserveHalfOpen(this.accountHealth, account.id)) return
        }
        attempts.push({ hopIndex, hop, account })
      })
      return attempts
    }

    const seenModels = new Set()
    chain.forEach((hop, hopIndex) => {
      // P2: layer-1 tier filter (same guard as the implicit branch above).
      if (allowed && !allowed.has(hop.provider)) return
      if (seenModels.has(hop.model)) return
      // §6.2: virtual smart copies never become hops.
      if (this.virtualProviders?.has(hop.provider) === true) return
      seenModels.add(hop.model)
      // L2a §1.4: a transparent aggregator ignores our local account entries;
      // it gets a single implicit account (the whole route) with no account
      // layer. Normal direct providers keep the existing multi-account domain.
      const topology = this.#topologyFor(hop.provider)
      let domain = this.accountsFor(hop.model)
      if (topology.transparent) {
        // A transparent aggregator ignores our local account entries; the
        // whole route IS one account. Ensure the implicit route account exists
        // even when configured accounts claimed this model in the constructor.
        const implicitId = implicitAccountId(hop.provider, hop.model)
        let implicit = this.byId.get(implicitId)
        if (!implicit) {
          implicit = { id: implicitId, provider: hop.provider, models: [hop.model], implicit: true }
          this.#add(implicit)
        }
        domain = [implicit]
      }
      const healthy = domain.filter(a => this.#dispatchable(a, hop, now))
      let accounts
      if (rankingCfg?.enabled === true && rankingCfg?.strategy !== 'legacy') {
        // Ranking on: layered scoring over the FULL domain (incl. cooled
        // accounts) for stable normalization, then sort only healthy ones.
        // P1 (task-9): real measured ttft finally reaches the scorer. The key
        // is omitted entirely when nothing was measured, so the unevidenced
        // path stays byte-identical to pre-task-9 behavior.
        const speedEvidence = this.#evidenceFor(domain)
        accounts = rankAccountsForHop(domain, healthy, hop.model, hop, rankingCfg, {
          usage: this.usage,
          now,
          ...(speedEvidence ? { speedEvidence } : {}),
        })
      } else {
        // Legacy comparator — byte-for-byte identical to pre-ranking behavior.
        accounts = healthy.sort((a, b) => {
          const aPreferred = a.provider === hop.provider ? 0 : 1
          const bPreferred = b.provider === hop.provider ? 0 : 1
          if (aPreferred !== bPreferred) return aPreferred - bPreferred
          const aUsed = this.usage.get(a.id) ?? 0
          const bUsed = this.usage.get(b.id) ?? 0
          return aUsed - bUsed
        })
      }
      for (const account of accounts) {
        // L2b §2.2: a HALF_OPEN account may receive at most one real user
        // request per plan(). Consume the permit here; no probe requests are
        // sent — this attempt IS the real request that proves recovery.
        if (this.accountHealth && !topology.transparent) {
          const state = healthStateOf(this.accountHealth, account.id, now)
          if (state === ACCOUNT_STATES.HALF_OPEN
              && !reserveHalfOpen(this.accountHealth, account.id)) continue
        }
        attempts.push({
          hopIndex,
          // The account's provider is authoritative: one route = one key.
          hop: { provider: account.provider, model: hop.model },
          account,
        })
      }
    })
    return attempts
  }
}

export default AccountPool
