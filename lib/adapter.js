/**
 * SmartAdapter — the meta-provider implementation.
 *
 * Design sources (all read-only, 2026-11-23):
 *   - meta-provider-设计方案.md        (core skeleton, error classification)
 *   - 多账号池设计方案.md               (cross-route = cross-account, cooldown)
 *   - 方案盲点审查.md                   (3 P0 fixes, #1 retry, #4 discovery, #7 visibility)
 *
 * The three P0 fixes are marked [P0-1], [P0-2], [P0-3] below.
 * Account pooling is layered on top: the chain chooses a MODEL, the pool
 * chooses a healthy ACCOUNT for that model. Cooldowns are keyed by accountId
 * (with an optional model-scoped suffix for model-specific failures), so one
 * account hitting 402 no longer freezes every account serving that model.
 */

import { llmLib, sessionLib } from './dsh.js'
import { normalizeChains, resolveChain, SWITCHABLE_CODES } from './chains.js'
import { AccountPool } from './account-pool.js'
import { sharedMeter } from './cost-meter.js'
import { classifyTask, derivePosition, selectTiers, resolveRoutingPolicy } from './routing.js'
// L3 opt-in wiring (task-95). These are all pure function modules with no DSH
// dependency and no import cycle back into the adapter. When `deps.health` is
// absent, none of these are called and the legacy path is byte-for-byte intact.
import {
  classifyFailure, updateHealth, isCandidate as availabilityIsCandidate,
  registryKey as availabilityRegistryKey,
} from './availability.js'
import {
  createAccountHealthRegistry, stateOf as healthStateOf, noteSuccess, noteFailure,
  getRecord as healthGetRecord, releaseHalfOpen, ACCOUNT_STATES,
} from './account-health.js'
import { resolveTopology } from './provider-topology.js'

/** [P0-1] Non-empty retryableCodes is required by the normal-policy schema (.min(1)). */
const SMART_RETRY_CONFIG = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: ['SERVER'],
})

/** Chunk types that are irreversible once emitted (establishment boundary). */
const CONTENT_CHUNK_TYPES = new Set([
  'block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end',
])

/**
 * task-5: conservative contextWindow floor for virtual models whose first hop
 * has no cached capacity yet (no discovered route, or the provider's own
 * catalog omits contextWindow). 128000 tokens is the de-facto lower bound of
 * the current frontier models served through smart routes (128k DeepSeek/GPT
 * class); a smaller real window only makes compaction kick in earlier, so an
 * honest floor never fakes capacity the hop does not have. refreshDiscoveredChains()
 * refreshes the routes cache on every llm/adapters-updated / llm/models-updated
 * event, so a provider that later declares its real window replaces this floor.
 */
const VIRTUAL_CONTEXT_WINDOW_FLOOR = 128000

/** Cooldown durations in milliseconds — named so no magic numbers hide in logic. */
const COOLDOWN_MS = Object.freeze({
  quotaDefault: 30 * 60 * 1000,   // 30 min when no upstream hint is available
  rateLimitDefault: 60 * 1000,    // 1 min
  authInvalid: 24 * 60 * 60 * 1000, // key is invalid until reconfigured / reloaded
  upstreamJitter: 5 * 1000,       // SERVER / TIMEOUT / TRANSPORT / STREAM_CLOSED
})

const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
const RATE_CODES = new Set(['RATE_LIMIT'])
const JITTER_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED'])

/**
 * Extract a stable failure code from either an LlmFailure or a thrown error.
 * pi-ai never fills `failure.status`, so a leading HTTP status in the message
 * is the only extra signal we get (see 设计方案 §2 坑 2).
 * @param {unknown} failure
 * @returns {{code:string, message:string, providerRetryAfterMs?:number}}
 */
function normalizeFailure(failure) {
  if (failure && typeof failure === 'object') {
    const code = typeof failure.code === 'string' && failure.code
      ? failure.code
      : inferCodeFromMessage(String(failure.message ?? ''))
    const result = { code, message: String(failure.message ?? '') }
    if (Number.isFinite(failure.providerRetryAfterMs)) {
      result.providerRetryAfterMs = failure.providerRetryAfterMs
    }
    return result
  }
  const message = failure instanceof Error ? failure.message : String(failure ?? '')
  return { code: inferCodeFromMessage(message), message }
}

/** Infer a code from message text when the adapter did not supply one. */
function inferCodeFromMessage(message) {
  if (/\babort(ed)?\b/i.test(message)) return 'ABORTED'
  if (/\b402\b|quota|insufficient|余额|额度/i.test(message)) return 'QUOTA'
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/i.test(message)) return 'AUTH'
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return 'RATE_LIMIT'
  if (/\b404\b|unknown model|model not found|not supported/i.test(message)) return 'UNKNOWN_MODEL'
  if (/\b5\d\d\b|timeout|transport|stream closed/i.test(message)) return 'SERVER'
  return 'SERVER'
}

/**
 * Diagnostic-only: sanitize an upstream failure message before it is written
 * to cost.jsonl. Masks bearer/api-key/token-shaped substrings and truncates to
 * 300 chars so a base64 payload cannot bloat the ledger (task-50). Never used
 * for routing decisions — only for observability of the real 400 body.
 */
export function sanitizeFailureMessage(message) {
  if (typeof message !== 'string' || message.length === 0) return null
  const masked = message
    // Longest/prefix-specific patterns first so `oc_sk_` is not partially
    // eaten by the generic `sk-` rule.
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/(oc_sk_[A-Za-z0-9_-]{4,})/g, 'oc_sk_***')
    .replace(/(?<![A-Za-z0-9_])(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)["']?[^\s"',}]{6,}/gi, '$1***')
  return masked.length > 300 ? masked.slice(0, 300) + '…[truncated]' : masked
}

/** E2A: an EXPLICIT upstream Retry-After hint (ms), or undefined. Unlike
 * cooldownFor() this never falls back to a per-code constant — the L2 owner
 * keeps its own streak backoff when no real hint exists, so convergence does
 * not shorten a cooling account. */
function retryAfterMs(failure) {
  const hinted = Number(failure?.providerRetryAfterMs)
  if (Number.isFinite(hinted) && hinted > 0 && hinted <= 24 * 60 * 60 * 1000) return hinted
  const message = failure?.message ?? ''
  const seconds = message.match(/retry[- ]after\s*:?\s*(\d{1,7})/i)
  if (!seconds) return undefined
  const ms = Math.min(24 * 60 * 60 * 1000, Math.max(0, Number(seconds[1]) * 1000))
  return ms > 0 ? ms : undefined
}

/** Extract a cooldown duration from an upstream failure. */
function cooldownFor(failure, now) {
  const hinted = Number(failure.providerRetryAfterMs)
  if (Number.isFinite(hinted) && hinted > 0 && hinted <= 24 * 60 * 60 * 1000) return now + hinted

  const message = failure.message ?? ''
  // Common forms: "reset in 3600s", "Retry-After: 120", "resets at <unix seconds>"
  const seconds = message.match(/reset(?:s)?\s+(?:in|at)?\s*(\d{1,7})\s*s(?:ec)?/i)
    ?? message.match(/retry[- ]after\s*:?\s*(\d{1,7})/i)
  if (seconds) {
    const ms = Math.min(24 * 60 * 60 * 1000, Math.max(0, Number(seconds[1]) * 1000))
    if (ms > 0) return now + ms
  }

  if (QUOTA_CODES.has(failure.code)) return now + COOLDOWN_MS.quotaDefault
  if (AUTH_CODES.has(failure.code)) return now + COOLDOWN_MS.authInvalid
  if (RATE_CODES.has(failure.code)) return now + COOLDOWN_MS.rateLimitDefault
  if (JITTER_CODES.has(failure.code)) return now + COOLDOWN_MS.upstreamJitter
  return 0
}

export class SmartAdapter {
  /**
   * @param {object} deps
   * @param {object} deps.runtime ctx.llm
   * @param {object} deps.chains validated chain table
   * @param {Array<object>} [deps.accounts] validated account pool config
   * @param {object} [deps.ranking] account ranking config (off by default)
   * @param {object} [deps.sessions] ctx.sessions (for [P0-3])
   * @param {object} [deps.meter] CostMeter instance
   * @param {object} [deps.logger] ctx.logger
   * @param {object} [deps.health] L3 opt-in: {enabled, availabilityRegistry,
   *        virtualProviders, topologyOpts}. Absent = legacy, byte-for-byte.
   */
  constructor({ runtime, chains, accounts, ranking, sessions, meter, logger, routes, health }) {
    const { LlmAdapter } = llmLib()
    if (typeof LlmAdapter === 'function') {
      // Extend the real base class when available so `instanceof LlmAdapter`
      // checks elsewhere in the harness keep working. The methods below
      // override every base method we rely on, so no base state is needed.
      Object.setPrototypeOf(SmartAdapter.prototype, LlmAdapter.prototype)
    }
    this.runtime = runtime
    this.chains = normalizeChains(chains)
    this.ranking = ranking
    this.sessions = sessions
    this.meter = meter ?? sharedMeter()
    this.logger = logger ?? {
      warn: () => {},
      error: () => {},
    }
    this.routes = Array.isArray(routes) ? routes : []
    this.#applyRouting(ranking?.routing)
    /** @type {Map<string, {until:number, reason:string}>} key = accountId (account-level cooldown) */
    this.cooldowns = new Map()
    // L3: offline caches are created ONLY when the health mechanism is opted
    // in. Absent config keeps every downstream field undefined so no new call
    // can touch the legacy request path.
    this.health = health && health.enabled === true ? health : undefined
    // E2A: L2-only cooldown authority. Default OFF. A health-disabled adapter
    // never consults this field, so the legacy path stays byte-for-byte.
    this.healthSingleCooldown = this.health?.healthSingleCooldown === true
    this.availabilityRegistry = this.health ? (this.health.availabilityRegistry ?? {}) : undefined
    this.accountHealth = this.health
      ? (this.health.accountHealth && typeof this.health.accountHealth === 'object'
          ? this.health.accountHealth  // caller-injected registry (L4/L5 share it)
          : createAccountHealthRegistry({
              // Two-level read-only hooks (L2b ↔ L1), no import cycle.
              ...(this.availabilityRegistry ? {
                isCandidate: key => availabilityIsCandidate(this.availabilityRegistry, key),
              } : {}),
              isAggregator: provider => this.#topologyOf(provider).aggregator === true,
            }))
      : undefined
    this.virtualProviders = this.health && Array.isArray(this.health.virtualProviders)
      ? new Set(this.health.virtualProviders) : undefined
    this.configuredAccounts = Array.isArray(accounts) ? accounts : []
    this.accountPool = this.#buildPool(accounts)
  }

  /** L2a topology verdict, memoized per provider (recomputed on reconfigure). */
  #topologyOf(provider) {
    if (!this.topologyByProvider) this.topologyByProvider = new Map()
    let verdict = this.topologyByProvider.get(provider)
    if (!verdict) {
      const accounts = (this.configuredAccounts ?? []).filter(a => a?.provider === provider)
      verdict = resolveTopology(provider, accounts, this.health?.topologyOpts ?? {})
      this.topologyByProvider.set(provider, verdict)
    }
    return verdict
  }

  /** P2: routing is OPT-IN. Only `enabled:true` activates the two-layer path;
   *  everything else stays byte-for-byte legacy. Bad config -> legacy, never
   *  a crash. Reused by constructor and reconfigure(). */
  #applyRouting(routing) {
    this.routing = routing && typeof routing === 'object' && routing.enabled === true
      ? routing : undefined
    this.routingPolicy = undefined
    if (this.routing) {
      try { this.routingPolicy = resolveRoutingPolicy(this.routing) }
      catch (error) { this.logger.warn('smart: bad routing config, staying legacy: %o', error); this.routing = undefined }
    }
  }

  /** Build a fresh AccountPool while preserving the cooldown predicate. */
  #buildPool(accounts) {
    return new AccountPool({
      accounts,
      chains: this.chains,
      ranking: this.ranking,
      // P1 (task-9): a hot config reload rebuilds the pool; hand the in-process
      // measured-speed table back in so evidence survives reconfigure().
      speedEvidence: this.accountPool?.speedEvidence,
      // Account-level cooldown: keyed by accountId only. A 402 on one account
      // never freezes other accounts serving the same model. (Model-specific
      // failures still only freeze that account, via the same key.)
      isHealthy: (accountId, now) => {
        // E2A on: L2 is the sole authority — the legacy Map never gates.
        if (this.healthSingleCooldown) return true
        const cool = this.cooldowns.get(accountId)
        return !cool || cool.until <= now
      },
      // L3 opt-in: when health is enabled, hand L4/L2b/L1 their registries and
      // the virtual-provider set. Absent = undefined = legacy byte-for-byte.
      ...(this.health ? {
        accountHealth: this.accountHealth,
        availabilityRegistry: this.availabilityRegistry,
        virtualProviders: this.virtualProviders,
        topologyOpts: this.health.topologyOpts,
        singleCooldown: this.healthSingleCooldown,
      } : {}),
    })
  }

  /**
   * Apply a volatile config update in place (no restart). Rebuilds chains and
   * the account pool, but keeps usage counters and cooldown state so an
   * in-flight failover sequence is not disrupted.
   */
  reconfigure({ chains, accounts, ranking } = {}) {
    this.chains = normalizeChains(chains)
    if (ranking !== undefined) {
      this.ranking = ranking
      this.#applyRouting(ranking?.routing)
    }
    const previousUsage = this.accountPool?.usage instanceof Map
      ? this.accountPool.usage : new Map()
    this.configuredAccounts = Array.isArray(accounts) ? accounts : []
    if (this.topologyByProvider) this.topologyByProvider.clear()
    const pool = this.#buildPool(accounts)
    for (const [id, count] of previousUsage) pool.usage.set(id, count)
    this.accountPool = pool
  }

  providerInfo(provider) {
    return { id: provider, name: 'Smart Gateway' }
  }

  /** [P0-1] Override the default 5-retry policy with an explicit zero-retry one. */
  providerRetryPolicy(_provider) {
    const { resolveRetryPolicy } = llmLib()
    return resolveRetryPolicy(SMART_RETRY_CONFIG, 'llm: provider "smart" retryPolicy')
  }

  /**
   * [P0-2] The base class advertises an empty catalog; list the virtual models.
   *
   * task-5: each virtual model must advertise a REAL contextWindow, otherwise
   * the host's compaction preflight (compactPressure) resolves
   * `info.context === undefined` and refuses the model switch with
   * "compaction-basic: no context capacity for smart/<id>". listModels is a
   * pure synchronous catalog snapshot (the registry only awaits it), so the
   * window is read from ALREADY-CACHED data:
   *   1. the first hop of the model's chain (resolveChain), matched against
   *      the routes metadata refreshDiscoveredChains() filled (each route
   *      entry may carry a contextWindow from the provider's own listModels);
   *   2. fall back to a deliberately conservative floor (128000, the de-facto
   *      lower bound of current frontier models) — never a fabricated large
   *      number, and the honest default is also what refreshDiscoveredChains
   *      will refresh after each registry event.
   */
  listModels(_provider) {
    const ids = Object.keys(this.chains).filter(id => id !== '*')
    const models = [{
      provider: 'smart',
      id: 'auto',
      name: 'Smart Auto (智能切换)',
      contextWindow: this.#virtualContextWindow('auto'),
    }]
    for (const id of ids) {
      if (id === 'auto') continue
      models.push({ provider: 'smart', id, name: `Smart / ${id}`, contextWindow: this.#virtualContextWindow(id) })
    }
    return Promise.resolve(models)
  }

  /**
   * task-5: cached contextWindow of one virtual model's first hop. Pure
   * in-memory lookups (no I/O — listModels may be called synchronously by the
   * registry); the routes cache is kept fresh by refreshDiscoveredChains().
   */
  #virtualContextWindow(outerModel) {
    const first = resolveChain(outerModel, this.chains)[0]
    if (!first) return VIRTUAL_CONTEXT_WINDOW_FLOOR
    const route = this.routes.find(r => r?.provider === first.provider)
    for (const entry of route?.models ?? []) {
      const id = typeof entry === 'string' ? entry : entry?.id
      if (id === first.model) {
        const window = typeof entry === 'string' ? undefined : entry?.contextWindow
        // Only trust a positive integer; anything else (absent, malformed,
        // zero) falls back to the conservative floor instead of guessing.
        if (Number.isInteger(window) && window > 0) return window
        return VIRTUAL_CONTEXT_WINDOW_FLOOR
      }
    }
    // First hop not present in the discovered route cache (e.g. chains
    // configured before discovery ran): conservative floor, refreshed later.
    return VIRTUAL_CONTEXT_WINDOW_FLOOR
  }

  /** [P0-2] Delegate image pricing to the first real hop; no I/O allowed here. */
  imageRequestPricing(provider, model) {
    const first = resolveChain(model, this.chains)[0]
    if (!first) return undefined
    return this.runtime.imageRequestPricing?.(first.provider, first.model)
  }

  /**
   * Delegate model metadata to the first real hop so contextWindow is correct.
   *
   * NOTE: the RUNTIME method is `resolveModelInfo()`, not `resolveModel()` —
   * `resolveModel` is an adapter-level method and is undefined on LlmRuntime.
   * Calling the wrong name throws a TypeError that normalizes into a
   * `{code:'UNKNOWN'}` finish chunk, killing the very first hop (found by the
   * performance review, task-25, 2026-11-23).
   */
  async resolveModel(provider, model, signal) {
    const first = resolveChain(model, this.chains)[0]
    if (!first || typeof this.runtime.resolveModelInfo !== 'function') {
      // task-5: no chain or no runtime capability — return the cached-window
      // fallback (same conservative floor listModels uses) so the host's
      // compaction preflight still sees a capacity instead of refusing the
      // switch with "no context capacity for smart/<id>".
      return { provider, id: model, name: model, context: { contextWindow: this.#virtualContextWindow(model) } }
    }
    const info = await this.runtime.resolveModelInfo(first.provider, first.model, signal)
    // task-5: the runtime's resolveModelInfo carries { context: { contextWindow } }
    // from the real first hop; keep it verbatim. If the hop's own catalog
    // omitted it, backfill the cached/floor window so resolveModelInfo never
    // returns context === undefined for a smart route.
    const contextWindow = info?.context?.contextWindow
      ?? this.#virtualContextWindow(model)
    return { ...info, provider, id: model, context: { contextWindow } }
  }

  /** The agent loop goes through prepareCall; delegate it as well. */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * [P0-3] Append a durable per-hop record before attempting each hop.
   *
   * We use `plugin:dsh-smart-provider/hop-selected` rather than a raw
   * `smart/hop-selected` event: the session persistence layer REFUSES to
   * restore a log containing an unknown non-ignorable event type, while a
   * plugin record is the sanctioned out-of-repo extension (ignorable, carried
   * on fork/resume, and readable with `pluginRecordOf`). The payload still
   * carries exactly the requested facts: hopIndex, actual provider/model,
   * the failure.code that triggered the switch, and the accountId used.
   */
  #recordHop(sessionId, hopIndex, hop, failureCode, accountId) {
    if (!sessionId || !this.sessions?.get) return
    const { appendPluginRecord } = sessionLib()
    if (typeof appendPluginRecord !== 'function') return
    try {
      const session = this.sessions.get(sessionId)
      if (!session) return
      appendPluginRecord(session, 'plugin:dsh-smart-provider/hop-selected', {
        event: 'smart/hop-selected',
        hopIndex,
        provider: hop.provider,
        model: hop.model,
        accountId: accountId ?? null,
        failureCode: failureCode ?? null,
        at: Date.now(),
      })
    } catch (error) {
      // Visibility must never break the request.
      this.logger.warn?.('smart: could not append hop-selected record: %o', error)
    }
  }

  /**
   * Record one finished attempt into the non-blocking cost meter.
   * P2 (task-1): `latency` carries this attempt's real stream timeline
   * ({startedAt, firstTokenAt, finishedAt}, ms); the meter derives the ledger
   * fields and omits any that lack data. Never blocks the stream.
   */
  #recordCost(options, hopIndex, hop, usage, failureCode, accountId, failureMessage, latency) {
    try {
      this.meter.record({
        outerModel: options.model,
        actualProvider: hop.provider,
        actualModel: hop.model,
        accountId,
        usage,
        hopIndex,
        failureCode,
        failureMessage,
        latency,
      })
    } catch (error) {
      this.logger.warn?.('smart: cost meter enqueue failed: %o', error)
    }
  }

  /**
   * P1 (task-9): feed ONE real successful attempt into the pool's in-process
   * speed evidence table, so the next plan() can score with a measured ttft
   * instead of a hand-filled speedTier that most users never set.
   *
   * Same timeline as #recordCost (zero extra clock reads, zero I/O): a call
   * that never produced content has no firstTokenAt and records NOTHING, and
   * failures are never evidence. Derivation mirrors cost-meter.js
   * (ttft = firstTokenAt - startedAt, tps = outputTokens / full duration)
   * because that module only exposes the ledger write, not a pure helper.
   * Observation must never break the request path.
   */
  #recordSpeedEvidence(account, usage, latency) {
    try {
      const pool = this.accountPool
      if (!pool || typeof pool.recordLatency !== 'function') return
      const { startedAt, firstTokenAt, finishedAt } = latency ?? {}
      if (!Number.isFinite(startedAt) || !Number.isFinite(firstTokenAt)) return
      if (firstTokenAt < startedAt) return
      const ttftMs = Math.round(firstTokenAt - startedAt)
      const outputTokens = Math.max(0, Number(usage?.outputTokens ?? 0))
      const measurable = Number.isFinite(finishedAt) && finishedAt > startedAt && outputTokens > 0
      pool.recordLatency(account.id, {
        ttftMs,
        ...(measurable
          ? { tokensPerSecond: Number((outputTokens / ((finishedAt - startedAt) / 1000)).toFixed(3)) }
          : {}),
      })
    } catch (error) {
      this.logger.warn?.('smart: speed evidence record failed: %o', error)
    }
  }

  /**
   * L3 (task-95): feed one real attempt result into the opt-in health layers.
   * No-op when health is not enabled — the legacy path never reaches here.
   * Reuses the attempt outcome already computed for #recordCost: zero new
   * requests, zero extra I/O. Ordering: classify once, then apply the layering
   * rules (§3 of the account-health design):
   *   - classifyFailure decides request-shape (P0) vs account (P2) vs model;
   *   - affectsModelHealth=false -> no model penalty, no account penalty for
   *     SESSION_HEADER/PARAM_COMPAT (handled by noteFailure's NO_PENALTY set);
   *   - aggregator/transparent providers are topology-exempt from cooling.
   */
  #noteAttemptOutcome(hop, account, failure, usage, now = Date.now()) {
    if (!this.health) return
    const key = { provider: hop.provider, modelId: hop.model,
      isVirtual: this.virtualProviders?.has(hop.provider) === true }
    if (key.isVirtual) return // §6.2 virtual copies never write health
    const verdict = failure && typeof failure === 'object' && !Array.isArray(failure)
      ? classifyFailure(failure, {
          currentIdList: this.health.currentIdList,
          requestedId: hop.model,
          registry: this.availabilityRegistry,
        })
      : null
    const cost = typeof usage?.cost === 'number' ? usage.cost : undefined
    try {
      const rec = updateHealth(this.availabilityRegistry, {
        provider: hop.provider,
        modelId: hop.model,
        providerFamily: key.provider,
        success: !failure,
        failure: failure ?? undefined,
        relatedId: verdict?.kind === 'RENAMED' ? undefined : undefined,
        currentIdList: this.health.currentIdList,
        cost,
        billingSource: usage?.billingSource,
        timestamp: now,
      })
      if (rec && this.availabilityRegistry && !availabilityRegistryKey(key)) return
      if (rec && this.availabilityRegistry) this.availabilityRegistry[availabilityRegistryKey(key)] = rec
    } catch (error) {
      this.logger.warn?.('smart: availability update failed: %o', error)
    }
    // Aggregator providers have their own account layer; only model-layer
    // evidence is written above (§1.5 topology transparency).
    if (this.#topologyOf(hop.provider).aggregator === true) return
    try {
      if (!failure) {
        noteSuccess(this.accountHealth, account.id, now, {
          provider: hop.provider, routeKey: key, kind: 'SUCCESS',
        })
        this.cooldowns.delete(account.id) // HALF_OPEN -> ACTIVE, real success clears it
      } else {
        // E2A on: the legacy Map is no longer written; hand the parsed
        // cooldown duration to L2 via E1D's delayMs override so L2 becomes
        // the single authority. Off: options stay undefined -> byte-for-byte.
        const options = this.healthSingleCooldown
          && SWITCHABLE_CODES.has(failure.code)
          && failure.code !== 'ABORTED'
          ? (() => {
              const hint = retryAfterMs(failure)
              return hint === undefined ? undefined : { delayMs: hint }
            })()
          : undefined
        noteFailure(this.accountHealth, account.id, {
          ...(verdict ?? { kind: failure.code ?? 'UNKNOWN' }),
          provider: hop.provider,
          routeKey: key,
          aggregator: false,
        }, now, options)
      }
    } catch (error) {
      this.logger.warn?.('smart: account health update failed: %o', error)
    }
  }

  /**
   * Stream one smart call, walking the chain until an attempt succeeds or the
   * plan is exhausted. Two selection layers: the chain picks the model, the
   * account pool supplies healthy accounts for it. Within one model all
   * healthy accounts are tried before moving to the next model.
   * Fallback is establishment-only: once any visible content chunk has been
   * yielded, the response is committed.
   *
   * @param {object} options GenerateOptions
   * @returns {AsyncIterable<object>} StreamChunk sequence
   */
  async *stream(options) {
    // P2 two-layer routing — OPT-IN ONLY. If routing is not explicitly
    // enabled, none of these helpers run and the lines below are the exact
    // legacy code path (verified省钱链路: 免费首跳/402 fallback/cost=0).
    let tierProviders
    if (this.routing) {
      try {
        const task = classifyTask(options, this.routing)
        // P2 fix: tierPolicy is a REAL consumer now. Forced-tier presets
        // (reasoning-first/longctx-first/vision-first) override the primary
        // task kind so selectTiers picks that position bucket first.
        const forced = this.routingPolicy?.tierPolicy
        const effectiveTask = forced && forced !== 'auto'
          ? { kind: forced, secondary: [task.kind, ...(task.secondary ?? [])].filter(k => k !== forced) }
          : task
        const positions = new Map()
        for (const route of this.routes) {
          const provider = route && typeof route.provider === 'string' ? route.provider : ''
          if (!provider || provider === 'smart') continue
          const tags = new Set()
          for (const m of Array.isArray(route.models) ? route.models : []) {
            const id = typeof m === 'string' ? m : m?.id
            if (!id) continue
            const info = m && typeof m === 'object' ? m : { id }
            const pos = derivePosition(info, this.routingPolicy?.positionOverrides?.[`${provider}/${id}`]
              ?? this.routingPolicy?.positionOverrides?.[id])
            for (const tag of pos.tags) tags.add(tag)
          }
          if (tags.size) positions.set(provider, { tags: [...tags], source: 'auto' })
        }
        // Candidate routes for the selected tiers: use discovered routes when
        // available, else the providers already present in the chain.
        const knownRoutes = this.routes.length
          ? this.routes.filter(r => r && r.provider && r.provider !== 'smart').map(r => r.provider)
          : [...new Set((this.chains.auto ?? []).map(h => h.provider))]
        const tiers = selectTiers(effectiveTask, positions, knownRoutes, {
          tierLimit: this.routing.tierLimit,
          warn: message => this.logger.warn(message),
        })
        const selected = new Set(tiers.flatMap(t => t.routes))
        if (selected.size) tierProviders = selected
      } catch (error) {
        this.logger.warn('smart: tier selection failed, staying legacy for this request: %o', error)
        tierProviders = undefined
      }
    }
    let chain = resolveChain(options.model, this.chains)
    // L3 (task-95) §8/§9: when health is opted in, filter non-candidate routes
    // (virtual copies and DEPRECATED entries) BEFORE the pool plans attempts.
    // No health config => this block is skipped => byte-for-byte legacy chain.
    if (this.health && chain.length > 0) {
      chain = chain.filter(hop => {
        if (this.virtualProviders?.has(hop.provider) === true) return false
        return availabilityIsCandidate(this.availabilityRegistry, {
          provider: hop.provider,
          modelId: hop.model,
          isVirtual: false,
        })
      })
    }
    if (chain.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'UNKNOWN_MODEL', message: `smart: no chain for model "${options.model}"` },
        },
      }
      return
    }

    const now = Date.now()
    // Model selection (chain) first, then per-model healthy account selection.
    // P2 fix: when routing is active, feed routingPolicy.weights into the
    // second layer so the 8 presets actually change account ordering.
    const routingRanking = this.routing && this.routingPolicy?.weights
      ? { ...this.ranking, enabled: true, strategy: 'custom', weights: this.routingPolicy.weights }
      : undefined
    const attempts = this.accountPool.plan(chain, now, tierProviders, routingRanking)

    let lastFailure
    let lastFailureCode = null

    if (attempts.length === 0) {
      const failure = {
        code: 'RATE_LIMIT',
        message: 'smart: every account in the chain is cooling down',
      }
      // Keep the most relevant cooldown reason if we have one.
      const firstHop = chain[0]
      const firstAccount = this.accountPool.accountsFor(firstHop.model)[0]
      if (firstAccount) {
        const cool = this.cooldowns.get(firstAccount.id)
        if (cool) failure.message = `smart: all accounts cooling down (${cool.reason})`
      }
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }

    for (const { hopIndex, hop, account } of attempts) {
      let emitted = false
      let usage
      try {
        // [P0-3] Announce the attempt BEFORE calling it, with accountId.
        this.#recordHop(options.sessionId, hopIndex, hop, lastFailureCode, account.id)
        this.accountPool.noteAttempt(account.id)

        // P2 (task-1) latency timeline for THIS attempt. Pure Date.now()
        // reads: no I/O, no awaits, nothing that could block or reorder the
        // stream. firstTokenAt is stamped on the first CONTENT chunk below —
        // the same point where `emitted` flips, so the establishment boundary
        // semantics are untouched (fallback-before-first-chunk stays as-is).
        const startedAt = Date.now()
        let firstTokenAt

        const inner = this.runtime.stream({
          ...options,
          provider: hop.provider,
          model: hop.model,
        })

        for await (const chunk of inner) {
          if (chunk?.type === 'usage') usage = chunk.usage

          if (chunk?.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') {
              const latency = { startedAt, firstTokenAt, finishedAt: Date.now() }
              this.#recordCost(options, hopIndex, hop, usage, null, account.id, null, latency)
              this.#noteAttemptOutcome(hop, account, null, usage, now)
              // P1 (task-9): real successful call -> measured speed evidence.
              this.#recordSpeedEvidence(account, usage, latency)
              this.cooldowns.delete(account.id)
              yield chunk
              return
            }
            // error / aborted (or an unknown future kind): treat as failure.
            const failure = normalizeFailure(chunk.reason?.failure)
            if (failure.code === 'ABORTED' || kind === 'aborted') {
              // Never fall back on user cancellation.
              this.#recordCost(options, hopIndex, hop, usage, failure.code, account.id, sanitizeFailureMessage(failure.message), { startedAt, firstTokenAt, finishedAt: Date.now() })
              // A cancellation is not evidence: hand back the HALF_OPEN permit
              // reserved by plan() so the account stays selectable (P0 permit
              // leak). Observation must never break the request path.
              if (this.accountHealth) {
                try {
                  releaseHalfOpen(this.accountHealth, account.id)
                } catch (error) {
                  this.logger.warn?.('smart: release half-open permit failed: %o', error)
                }
              }
              yield chunk
              return
            }
            if (emitted) {
              // Content already left the process; the response cannot be rewound.
              this.#recordCost(options, hopIndex, hop, usage, failure.code, account.id, sanitizeFailureMessage(failure.message), { startedAt, firstTokenAt, finishedAt: Date.now() })
              yield chunk
              return
            }
            lastFailure = chunk.reason?.failure ?? failure
            lastFailureCode = failure.code
            this.#recordCost(options, hopIndex, hop, usage, failure.code, account.id, sanitizeFailureMessage(failure.message), { startedAt, firstTokenAt, finishedAt: Date.now() })
            this.#noteAttemptOutcome(hop, account, failure, usage, now)
            if (SWITCHABLE_CODES.has(failure.code) || !emitted) {
              this.#setCooldown(account, failure, { provider: hop.provider, modelId: hop.model })
            }
            break
          }

          if (CONTENT_CHUNK_TYPES.has(chunk?.type)) {
            if (!emitted) firstTokenAt = Date.now()
            emitted = true
          }
          yield chunk
        }
        // A stream that ends without a terminal finish is treated as an
        // establishment failure only when nothing was emitted.
        if (emitted) return
        if (!lastFailure) {
          lastFailure = { code: 'EMPTY_RESPONSE', message: 'smart: hop stream ended without finish' }
          lastFailureCode = 'EMPTY_RESPONSE'
        }
      } catch (error) {
        const failure = normalizeFailure(error)
        if (emitted) throw error
        lastFailure = error
        lastFailureCode = failure.code
        this.#recordCost(options, hopIndex, hop, usage, failure.code, account.id, sanitizeFailureMessage(failure.message), { startedAt, firstTokenAt, finishedAt: Date.now() })
        this.#noteAttemptOutcome(hop, account, failure, usage, now)
        this.#setCooldown(account, failure, { provider: hop.provider, modelId: hop.model })
      }
    }

    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: lastFailure ?? { code: 'SERVER', message: 'smart: all hops failed' },
      },
    }
  }

  /**
   * Set an account-level cooldown for a failure. Keyed ONLY by accountId: an
   * account that 402s is frozen, but other accounts of the same model remain
   * selectable. This is the core of the pool refactor (was provider/model).
   */
  #setCooldown(account, failure, routeKey) {
    if (failure.code === 'ABORTED') return
    // L3 opt-in: request-shape failures (P0) and aggregator routes never cool
    // the account. Legacy (no health) path is unchanged.
    if (this.health && routeKey) {
      const verdict = classifyFailure(failure, {
        currentIdList: this.health.currentIdList,
        requestedId: routeKey.modelId,
        registry: this.availabilityRegistry,
      })
      if (verdict.kind === 'SESSION_HEADER' || verdict.kind === 'PARAM_COMPAT') return
      if (this.#topologyOf(routeKey.provider).aggregator === true) return
    }
    if (!SWITCHABLE_CODES.has(failure.code)) return
    // E2A on: L2 already received this duration via noteFailure's delayMs;
    // the legacy Map stays untouched. Off: write below stays byte-for-byte.
    if (this.healthSingleCooldown) return
    const until = cooldownFor(failure, Date.now())
    if (until <= Date.now()) return
    this.cooldowns.set(account.id, { until, reason: failure.code })
  }

  /** Drain pending cost records. Used by the plugin's dispose effect. */
  async close() {
    if (this.meter?.close) await this.meter.close()
  }
}
