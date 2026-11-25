/**
 * Offline token pricing lookup.
 *
 * The price table is a read-only export of Bifrost's
 * `governance_model_pricing` table, restricted to the provider routes that
 * actually exist in this DSH profile. DSH itself has no currency-level
 * measurement (dsh-token-meter explicitly says "not a billing record"), so
 * this is an ESTIMATE, never a bill. Subscription/gateway discounts are not
 * modelled. Unknown models price at zero and are flagged `known: false` so
 * under-counting is visible instead of silent.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_PATH = join(HERE, 'pricing.json')
// P1 user resource adaptation: a user's OWN pricing table wins. The shipped
// pricing.json is now marked `_example:true` and is only a documented fallback
// (kept so existing users' cost ledgers stay comparable and shipped tests keep
// their fixture). No user's prices are treated as product defaults.
function userTablePath() {
  if (process.env.DSH_SMART_PRICING_FILE) return process.env.DSH_SMART_PRICING_FILE
  return join(HERE, '..', 'registry', 'pricing.user.json')
}

/** @type {Map<string, object>} key `${provider}/${model}` (lowercased) */
let INDEX
/** @type {'user'|'example'} which source populated INDEX (diagnostics) */
let SOURCE = 'example'

function buildIndex(doc) {
  const map = new Map()
  for (const entry of doc?.entries ?? []) {
    const key = `${entry.provider}/${entry.model}`.toLowerCase()
    map.set(key, entry)
  }
  return map
}

function loadIndex() {
  if (INDEX) return INDEX
  const userPath = userTablePath()
  if (existsSync(userPath)) {
    try {
      INDEX = buildIndex(JSON.parse(readFileSync(userPath, 'utf8')))
      SOURCE = 'user'
      return INDEX
    } catch { /* malformed user table -> fall through to example, never break requests */ }
  }
  INDEX = buildIndex(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')))
  SOURCE = 'example'
  return INDEX
}

/** Which pricing source is active: 'user' (imported table) or 'example' (shipped fallback). */
export function pricingSource() {
  loadIndex()
  return SOURCE
}

/**
 * Resolve the per-token prices for one exact provider/model route.
 * Falls back to a bare-model match when a provider-qualified entry is absent,
 * preferring the cheapest entry so the estimate is conservative.
 *
 * @param {string} provider provider route id
 * @param {string} model model id
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, known:boolean}}
 */
export function priceFor(provider, model) {
  const index = loadIndex()
  const exact = index.get(`${provider}/${model}`.toLowerCase())
  if (exact) {
    return {
      input: Number(exact.input ?? 0),
      output: Number(exact.output ?? 0),
      cacheRead: Number(exact.cacheRead ?? 0),
      cacheWrite: Number(exact.cacheWrite ?? 0),
      known: true,
    }
  }
  // Provider-qualified fallback: match on model id alone, choose the lowest
  // combined input+output price so we never overstate spend.
  const bare = String(model ?? '').toLowerCase()
  let best
  for (const [key, entry] of index) {
    if (key.slice(key.indexOf('/') + 1) !== bare) continue
    if (!best || (entry.input ?? 0) + (entry.output ?? 0) < (best.input ?? 0) + (best.output ?? 0)) {
      best = entry
    }
  }
  if (best) {
    return {
      input: Number(best.input ?? 0),
      output: Number(best.output ?? 0),
      cacheRead: Number(best.cacheRead ?? 0),
      cacheWrite: Number(best.cacheWrite ?? 0),
      known: true,
    }
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, known: false }
}

/**
 * Estimate USD cost for one call from its token usage.
 *
 * Cache tokens are priced with the cache-specific rate when the table has
 * one; otherwise they fall back to the ordinary input rate. Counts in
 * dsh-llm's TokenUsage are DISJOINT (inputTokens excludes cached tokens).
 *
 * @param {object} usage TokenUsage-like {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
 * @param {string} provider provider route
 * @param {string} model model id
 * @returns {{estimatedCostUsd:number, known:boolean}}
 */
export function estimateCost(usage, provider, model) {
  const price = priceFor(provider, model)
  const input = Math.max(0, Number(usage?.inputTokens ?? 0)) * price.input
  const output = Math.max(0, Number(usage?.outputTokens ?? 0)) * price.output
  const cacheRead = Math.max(0, Number(usage?.cacheReadTokens ?? 0))
    * (price.cacheRead || price.input)
  const cacheWrite = Math.max(0, Number(usage?.cacheWriteTokens ?? 0))
    * (price.cacheWrite || price.input)
  return { estimatedCostUsd: input + output + cacheRead + cacheWrite, known: price.known }
}

/** Number of price entries loaded (for diagnostics/tests). */
export function priceCount() {
  return loadIndex().size
}
