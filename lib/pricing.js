/**
 * Offline token pricing lookup.
 *
 * C3 ruling (落地规格): the pricing table is USER DATA and is never shipped as
 * a product default. The product default lib/pricing.json contains ONLY
 * zero-price (free-tier) declarations written by scripts/gen-custom-routes.mjs.
 * The historical author export is demoted to lib/pricing.example.json and is
 * NEVER loaded by this module.
 *
 * Resolution order:
 *   1. DSH_SMART_PRICING_FILE env (explicit user table path)
 *   2. registry/pricing.user.json next to the plugin (imported user table)
 *   3. the product default table (zero-price declarations only)
 * A malformed user table degrades to the product default — never throws.
 * Any model without a real (non-zero) table row resolves to a coarse tier
 * estimate (estimated:true, priceTier free/low/mid/high, known:false) so the
 * UI stays honest about uncertainty without breaking requests.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function userTablePath() {
  if (process.env.DSH_SMART_PRICING_FILE) return process.env.DSH_SMART_PRICING_FILE
  return join(HERE, '..', 'registry', 'pricing.user.json')
}

/** @type {Map<string, object>} key `${provider}/${model}` (lowercased) */
let INDEX
/** @type {'user'|'default'} which source populated INDEX (diagnostics) */
let SOURCE = 'default'

function buildIndex(doc) {
  const map = new Map()
  for (const entry of doc?.entries ?? []) {
    const key = `${entry.provider}/${entry.model}`.toLowerCase()
    map.set(key, entry)
  }
  return map
}

function tryLoad(path, source) {
  try {
    INDEX = buildIndex(JSON.parse(readFileSync(path, 'utf8')))
    SOURCE = source
    return true
  } catch { /* malformed or unreadable table -> keep trying, never break requests */ }
  return false
}

function loadIndex() {
  if (INDEX) return INDEX
  // 1. explicit env table  2. imported user table  3. product default.
  // The example export (pricing.example.json) is intentionally NOT on this
  // path: an example must never answer a real price query.
  if (!tryLoad(userTablePath(), 'user')) {
    // The product default ships with the plugin and must parse; if even that
    // fails, INDEX stays an empty map and every query resolves to estimates.
    tryLoad(join(HERE, 'pricing.json'), 'default')
  }
  if (!INDEX) INDEX = new Map()
  return INDEX
}

/** Which pricing source is active: 'user' (imported table) or 'default' (zero-price declarations only). */
export function pricingSource() {
  loadIndex()
  return SOURCE
}

/** Whether the active table carries any real (non-zero) vendor price. */
export function pricingHasRealPrices() {
  for (const entry of loadIndex().values()) {
    if ((Number(entry.input) || 0) > 0 || (Number(entry.output) || 0) > 0) return true
  }
  return false
}

/**
 * Coarse tier guess for an unknown price, from the model id alone. Matches
 * nothing on purpose — this is a shape hint, not data. Free-suffixed ids and
 * embedded opencode-style gateway ids (opencode-*, x-opencode-) resolve to
 * 'free'; everything else is 'mid' unless the id marks a big/ultra variant.
 */
function tierGuess(provider, model) {
  const id = `${provider}/${model}`.toLowerCase()
  if (id.includes('free') || id.includes('trial')) return 'free'
  if (/(ultra|max|heavy|opus|pro-max)/.test(id)) return 'high'
  if (/(mini|nano|lite|flash|small|fast)/.test(id)) return 'low'
  return 'mid'
}

/**
 * Coarse per-token estimate when no real price exists. All numbers are
 * placeholders; callers must surface estimated/known:false instead of money.
 */
function tierEstimate(provider, model) {
  const tier = tierGuess(provider, model)
  // Amounts are ZERO on purpose: an estimate is not data, so every consumer
  // that distinguishes "real price" from "no price" (ranking.js cost factor,
  // cost-stats savings) keeps its pre-C3 behavior and falls through to its
  // own user-tier proxy. The tier name is the coarse estimate signal.
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    known: false,
    estimated: true,
    priceTier: tier,
  }
}

function fromEntry(entry) {
  const input = Number(entry.input ?? 0)
  const output = Number(entry.output ?? 0)
  return {
    input,
    output,
    cacheRead: entry.cacheRead == null ? input : Number(entry.cacheRead),
    cacheWrite: entry.cacheWrite == null ? input : Number(entry.cacheWrite),
    // A zero-priced row is a real declaration (free tier), not missing data.
    known: true,
  }
}

/**
 * Resolve the per-token prices for one exact provider/model route.
 * Falls back to a bare-model match when a provider-qualified entry is absent,
 * preferring the cheapest entry so the estimate is conservative. Unknown
 * models get a coarse tier estimate (never the author's historical prices,
 * which live only in pricing.example.json and are never auto-loaded).
 *
 * @param {string} provider provider route id
 * @param {string} model model id
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number,
 *            known:boolean, estimated?:boolean, priceTier?:string}}
 */
export function priceFor(provider, model) {
  const index = loadIndex()
  const bare = String(model ?? '').toLowerCase()
  const exact = index.get(`${provider}/${bare}`.toLowerCase())
  if (exact) {
    const price = fromEntry(exact)
    if (price.input > 0 || price.output > 0) return price
    // A zero-priced row means the table declares this route free — honour it.
    return { ...price, estimated: false, priceTier: 'free' }
  }
  // Provider-qualified fallback: match on model id alone, choose the lowest
  // combined input+output price so we never overstate spend.
  let best
  for (const [key, entry] of index) {
    if (key.slice(key.indexOf('/') + 1) !== bare) continue
    if (!best || (entry.input ?? 0) + (entry.output ?? 0) < (best.input ?? 0) + (best.output ?? 0)) {
      best = entry
    }
  }
  if (best) {
    const price = fromEntry(best)
    if (price.input > 0 || price.output > 0) return price
    return { ...price, estimated: false, priceTier: 'free' }
  }
  // No table row anywhere -> coarse tier estimate. Never an historical price.
  return tierEstimate(provider, model)
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
 * @returns {{estimatedCostUsd:number, known:boolean, estimated?:boolean, priceTier?:string}}
 */
export function estimateCost(usage, provider, model) {
  const price = priceFor(provider, model)
  const input = Math.max(0, Number(usage?.inputTokens ?? 0)) * price.input
  const output = Math.max(0, Number(usage?.outputTokens ?? 0)) * price.output
  const cacheRead = Math.max(0, Number(usage?.cacheReadTokens ?? 0))
    * (price.cacheRead || price.input)
  const cacheWrite = Math.max(0, Number(usage?.cacheWriteTokens ?? 0))
    * (price.cacheWrite || price.input)
  return {
    estimatedCostUsd: input + output + cacheRead + cacheWrite,
    known: price.known,
    ...(price.estimated ? { estimated: true, priceTier: price.priceTier } : {}),
  }
}

/** Number of price entries loaded (for diagnostics/tests). */
export function priceCount() {
  return loadIndex().size
}
