/**
 * Minimal free/metered probe (task-107) — replaces "guess by model name".
 *
 * Design contract (from the task and the horizontal ruling with
 * config-channel-fix):
 *  - The CLIENT cannot issue LLM probes: LlmRuntime exposes only
 *    listProviders / listConfigurableProviders / remoteDiscoverModels as
 *    @Remote; stream / prepareCall / resolveModelInfo are Host-only (asar
 *    LlmRuntime decorator enumeration). So probing lives on the Host here;
 *    `SmartProviderRemote.probeModels` (owned by config-channel-fix) is the
 *    read-only bridge to the client.
 *  - ONE tiny request per (provider, model) (max_tokens≈1): free models cost
 *    nothing; a paid model spends one token at most. Results are cached with
 *    a TTL so opening the settings page never re-probes.
 *  - Verdicts: 'free' (usage cost=0 / free billing source, HTTP 200),
 *    'metered' (usage cost>0 / credit deducted), 'unknown' (no conclusion —
 *    error, timeout, no usage). 'unknown' NEVER blocks: the client keeps its
 *    name-based weak-signal inclusion ("不能挡" rule).
 *  - Every verdict is written into the L1 availability registry via
 *    updateHealth() with the proper billing confidence (§7): free/metered
 *    from real usage is high-confidence; unknown adds no free claim.
 *
 * No provider or model id is hardcoded. `smart` is never probed (it is the
 * meta-provider this plugin registers, not a real endpoint).
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { updateHealth, registryKey } from './availability.js'

/** Tiny, bounded probe request. One token is enough to observe cost/billing. */
const PROBE_MESSAGES = Object.freeze([{ role: 'user', content: '1' }])
const PROBE_MAX_TOKENS = 1
/** Default cache TTL: 7 days (lead's long-period re-probe condition). */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Hard cap on probes per call — never batch-probe hundreds of models. */
const DEFAULT_MAX_PER_CALL = 3
/**
 * Default cache path, in the plugin's own data dir (never in user config).
 * Derived from the current user's home — the same convention cost-meter.js and
 * cost-stats.js use. A literal home directory here would be another user's
 * path and would make persist() fail with EACCES on every probe.
 */
const DEFAULT_CACHE_FILE = join(homedir(), '.dsh', 'smart-provider', 'probe-cache.jsonl')

/** Load the persistent probe cache. Latest record per (provider,model) wins. */
async function loadCache(file, warn) {
  const out = new Map()
  if (!file) return out
  try {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        const key = registryKey({ provider: row.provider, modelId: row.model })
        if (key) out.set(key, row) // ledger order: last wins
      } catch { /* skip malformed lines — partial cache must not block */ }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn?.(`smart probe: cache read failed: ${String(error?.message ?? error)}`)
  }
  return out
}

/** Append one verdict record to the persistent cache (fire-and-forget safe). */
async function persist(file, row, warn) {
  if (!file) return
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(row) + '\n', 'utf8')
  } catch (error) {
    warn?.(`smart probe: cache write failed: ${String(error?.message ?? error)}`)
  }
}

function verdictOf(usage, failure) {
  if (failure) return { verdict: 'unknown', evidence: `probe error: ${String(failure.code ?? failure.message ?? 'failed')}` }
  if (!usage || typeof usage !== 'object') {
    return { verdict: 'unknown', evidence: 'no usage signal' }
  }
  const cost = Number(usage.cost ?? usage.estimatedCostUsd ?? 0)
  const source = typeof usage.billingSource === 'string' ? usage.billingSource.toLowerCase() : ''
  if (Number.isFinite(cost) && cost <= 0 && /free|trial|bonus|allowance/.test(source)) {
    return { verdict: 'free', evidence: 'upstream usage cost=0 + free billing source' }
  }
  if (cost > 0 || /paid|meter|subscription|credit|go-plus/.test(source)) {
    return { verdict: 'metered', evidence: `upstream cost=${cost} source=${source || 'n/a'}` }
  }
  // cost=0 but no billing-source evidence: honest unknown, never claim free.
  return { verdict: 'unknown', evidence: 'cost=0 without billing-source confirmation' }
}

/**
 * Create a probe runner bound to a SmartAdapter's llm runtime and health
 * registry. Safe to construct even when the runtime lacks stream(); every
 * probe then returns 'unknown' and nothing is blocked.
 *
 * @param {object} opts
 * @param {object} opts.runtime ctx.llm (must expose stream())
 * @param {object} opts.availabilityRegistry L1 registry (same object the UI reads)
 * @param {number} [opts.ttlMs] cache TTL
 * @param {(message:string)=>void} [opts.warn] diagnostic sink
 */
export function createProbe({
  runtime, availabilityRegistry, ttlMs = DEFAULT_TTL_MS, warn,
  cacheFile = DEFAULT_CACHE_FILE, maxPerCall = DEFAULT_MAX_PER_CALL,
} = {}) {
  // In-memory mirror; hydrated from the persistent JSONL on first use so a
  // plugin reload never re-probes a model it already measured (lead auth 2).
  let cache = new Map()
  let loaded = false
  async function ensureLoaded() {
    if (loaded) return
    loaded = true
    cache = await loadCache(cacheFile, warn)
  }
  const inflight = new Map() // key -> Promise (dedupe concurrent probes)

  /** Single freshness contract shared by probeOne / probeModels / peek. */
  function isFresh(hit, now) {
    return !!(hit && Number.isFinite(hit.probedAt)
      && hit.probedAt + ttlMs > now && hit.verdict !== 'unknown')
  }

  async function probeOne(provider, model) {
    await ensureLoaded()
    const key = registryKey({ provider, modelId: model })
    if (!key || provider === 'smart') return { provider, model, verdict: 'unknown', evidence: 'not probeable', ok: false, cost: 0 }
    const now = Date.now()
    const hit = cache.get(key)
    if (isFresh(hit, now)) {
      return { provider, model, verdict: hit.verdict, evidence: `cached: ${hit.evidence}`, ok: true, cost: hit.cost ?? 0 }
    }
    if (inflight.has(key)) {
      const result = await inflight.get(key)
      return { provider, model, ...result }
    }
    const task = (async () => {
      let usage, failure
      try {
        if (typeof runtime?.stream !== 'function') throw new Error('llm.stream unavailable')
        const stream = runtime.stream({
          provider, model, messages: PROBE_MESSAGES, maxTokens: PROBE_MAX_TOKENS,
          purpose: 'smart-probe',
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'usage') usage = chunk.usage
          if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop'
              && chunk.reason?.kind !== 'tool-calls' && chunk.reason?.kind !== 'max-tokens') {
            failure = chunk.reason?.failure ?? { code: chunk.reason?.kind ?? 'ERROR' }
          }
        }
      } catch (error) {
        failure = { code: 'TRANSPORT', message: String(error?.message ?? error) }
      }
      const { verdict, evidence } = verdictOf(usage, failure)
      const probeCost = Number(usage?.cost ?? usage?.estimatedCostUsd ?? 0)
      const result = {
        verdict, evidence, ok: verdict !== 'unknown', probedAt: Date.now(),
        cost: Number.isFinite(probeCost) ? probeCost : 0,
      }
      // Persist to the plugin's own cache file (includes cost + timestamp).
      await persist(cacheFile, { provider, model, ...result }, warn)
      // Write into L1 with proper billing confidence (§7). Unknown adds no claim.
      try {
        if (availabilityRegistry && typeof availabilityRegistry === 'object') {
          const attempt = {
            provider, modelId: model,
            success: verdict !== 'unknown',
            failure: failure ?? undefined,
            cost: usage?.cost ?? usage?.estimatedCostUsd,
            billingSource: usage?.billingSource,
            timestamp: result.probedAt,
          }
          if (verdict === 'unknown') {
            // A failed probe is an honest sample; it never asserts free/metered.
            attempt.failure = attempt.failure ?? { code: 'UNKNOWN', message: evidence }
          }
          const rec = updateHealth(availabilityRegistry, attempt)
          if (rec) availabilityRegistry[key] = rec
        }
      } catch (error) {
        warn?.(`smart probe: registry update failed: ${String(error?.message ?? error)}`)
      }
      if (verdict !== 'unknown') cache.set(key, { provider, model, ...result })
      return result
    })()
    inflight.set(key, task)
    try { return await task } finally { inflight.delete(key) }
  }

  return {
    /** Probe a batch; order preserved; failure of one never blocks the rest.
     *  Hard cap: at most maxPerCall REAL probes per call; cache hits are free
     *  and do not consume the quota. Never batch-probe all models. */
    async probeModels(candidates) {
      await ensureLoaded()
      const list = Array.isArray(candidates) ? candidates : []
      const results = []
      let spent = 0
      for (const c of list) {
        const provider = typeof c?.provider === 'string' ? c.provider : ''
        const model = typeof c?.model === 'string' ? c.model : ''
        if (!provider || !model) continue
        const key = registryKey({ provider, modelId: model })
        const hit = cache.get(key)
        const isCached = isFresh(hit, Date.now())
        if (!isCached && spent >= maxPerCall) {
          // Over cap: return an honest unknown with identity; the client's
          // weak-signal fallback keeps it — "不能挡" holds.
          results.push({ provider, model, verdict: 'unknown', evidence: 'probe deferred: per-call cap reached', ok: false, cost: 0 })
          continue
        }
        if (!isCached) spent++
        const outcome = await probeOne(provider, model)
        // Identity is added here for every path (including thrown/aborted
        // probes) so the "不能挡" fallback always has the tuple to work with.
        results.push({ provider, model, ...outcome })
      }
      return { results, probedAt: Date.now() }
    },
    /** Clear cache globally, or one (provider,model) for manual re-probe. */
    invalidate(provider, model) {
      if (provider && model) {
        cache.delete(registryKey({ provider, modelId: model }))
        return
      }
      cache.clear()
    },
    /** Read a cached verdict without probing (used by the UI projection if needed). */
    peek(provider, model) {
      const hit = cache.get(registryKey({ provider, modelId: model }))
      return isFresh(hit, Date.now()) ? { verdict: hit.verdict, evidence: hit.evidence } : undefined
    },
  }
}

export { DEFAULT_TTL_MS, PROBE_MAX_TOKENS, DEFAULT_MAX_PER_CALL, DEFAULT_CACHE_FILE }
