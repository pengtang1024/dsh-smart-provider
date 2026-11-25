/**
 * Read and aggregate the real cost.jsonl ledger. Pure Node, no DSH/protocol
 * dependency, so it is directly testable. Same channel and口径 as CostMeter's
 * writer and the historical smart-cost host command.
 *
 * Aggregations are Host-side so the browser never receives the full 1.4MB
 * ledger: costDetail() returns one page of rows plus bounded timeline/byModel/
 * savings summaries. No model/provider id is hardcoded — everything is derived
 * from the ledger itself (P1: never bake a user's mix into product defaults).
 *
 * P2 (task-1): rows written before the latency metrics existed (no
 * started_at/first_token_at/finished_at/ttft_ms/... keys) aggregate exactly
 * as before — every latency read is optional and defaults to null.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { priceFor, pricingSource } from './pricing.js'

const DEFAULT_DIR = join(homedir(), '.dsh', 'smart-provider')

function loadRows(dir) {
  const source = dir || DEFAULT_DIR
  let rows = []
  try {
    const text = readFileSync(join(source, 'cost.jsonl'), 'utf8')
    rows = text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { /* no ledger yet -> real zero stats */ }
  return { rows, source }
}

/** @param {string|undefined} dir override directory; defaults to ~/.dsh/smart-provider */
export function readCostStats(dir) {
  const { rows, source } = loadRows(dir)
  let total = 0, free = 0, paid = 0
  const byProvider = {}
  for (const r of rows) {
    const cost = Number(r?.estimated_cost_usd ?? 0)
    total += cost
    const provider = String(r?.actual_provider ?? 'unknown')
    byProvider[provider] = (byProvider[provider] ?? 0) + cost
    if (r?.failure_code == null) {
      if (cost > 0) paid += 1
      else free += 1
    }
  }
  return {
    records: rows.length,
    estimatedCostUsd: Number(total.toFixed(12)),
    freeCount: free,
    paidCount: paid,
    failedCount: rows.length - free - paid,
    byProvider,
    source,
  }
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const str = v => (typeof v === 'string' ? v : '')

/**
 * Day-bucketed timeline. Buckets only span days present in the ledger (the
 * data covers ~2 days; no 30-day empty tail).
 */
function buildTimeline(rows) {
  const buckets = new Map()
  for (const r of rows) {
    const ts = str(r?.timestamp)
    const day = ts.length >= 10 ? ts.slice(0, 10) : 'unknown'
    let b = buckets.get(day)
    if (!b) { b = { day, calls: 0, costUsd: 0, failures: 0 }; buckets.set(day, b) }
    b.calls += 1
    b.costUsd += num(r?.estimated_cost_usd)
    if (r?.failure_code != null) b.failures += 1
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).map(b => ({
    ...b, costUsd: Number(b.costUsd.toFixed(12)),
  }))
}

/** Group by actual_provider + actual_model: calls, cost, free/paid split. */
function buildByModel(rows) {
  const groups = new Map()
  for (const r of rows) {
    const provider = str(r?.actual_provider) || 'unknown'
    const model = str(r?.actual_model) || 'unknown'
    const key = `${provider}/${model}`
    let g = groups.get(key)
    if (!g) {
      g = { provider, model, calls: 0, costUsd: 0, freeCalls: 0, paidCalls: 0, failedCalls: 0 }
      groups.set(key, g)
    }
    g.calls += 1
    g.costUsd += num(r?.estimated_cost_usd)
    if (r?.failure_code != null) g.failedCalls += 1
    else if (num(r?.estimated_cost_usd) > 0) g.paidCalls += 1
    else g.freeCalls += 1
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls)
    .map(g => ({ ...g, costUsd: Number(g.costUsd.toFixed(12)) }))
}

/**
 * Honest "savings" estimate for free calls — never a fabricated number.
 * Resolution order per free model:
 *   1) a PAID row of the SAME model in this ledger  -> per-call cost from real data
 *   2) a PAID row of the SAME provider             -> that row's unit price (referenceModel recorded)
 *   3) pricing table priceFor(provider, model)      -> public price (referenceModel recorded)
 *   4) no comparable price                          -> known:false, amount omitted (never 0)
 * Every amount is marked estimated:true with source and referenceModel.
 */
function buildSavings(rows) {
  const priceSource = pricingSource()
  // Same-model paid unit cost from the ledger (most honest reference).
  const sameModelPaid = new Map()   // model -> total cost / paid calls
  const sameProviderPaid = new Map() // provider -> total cost / paid calls
  for (const r of rows) {
    if (r?.failure_code != null) continue
    const cost = num(r?.estimated_cost_usd)
    if (cost <= 0) continue
    const model = str(r?.actual_model), provider = str(r?.actual_provider)
    if (model) {
      const e = sameModelPaid.get(model) ?? { cost: 0, calls: 0 }
      e.cost += cost; e.calls += 1; sameModelPaid.set(model, e)
    }
    if (provider) {
      const e = sameProviderPaid.get(provider) ?? { cost: 0, calls: 0 }
      e.cost += cost; e.calls += 1; sameProviderPaid.set(provider, e)
    }
  }
  const byFreeModel = new Map()
  for (const r of rows) {
    if (r?.failure_code != null || num(r?.estimated_cost_usd) > 0) continue
    const model = str(r?.actual_model) || 'unknown'
    const provider = str(r?.actual_provider) || 'unknown'
    let e = byFreeModel.get(model)
    if (!e) { e = { model, provider, freeCalls: 0, inputTokens: 0, outputTokens: 0 }; byFreeModel.set(model, e) }
    e.freeCalls += 1
    e.inputTokens += num(r?.input_tokens)
    e.outputTokens += num(r?.output_tokens)
  }
  const models = [...byFreeModel.values()].map(e => {
    const base = {
      model: e.model, provider: e.provider, freeCalls: e.freeCalls,
      inputTokens: e.inputTokens, outputTokens: e.outputTokens,
      estimated: true, known: false, source: '', referenceModel: '', estimatedUsd: null,
    }
    // 1) same model paid unit cost from ledger
    const sm = sameModelPaid.get(e.model)
    if (sm && sm.calls > 0) {
      const unit = (sm.cost / sm.calls)
      return { ...base, known: true, source: 'ledger-same-model', referenceModel: e.model,
        estimatedUsd: Number((unit * e.freeCalls).toFixed(6)) }
    }
    // 2) same provider paid unit cost from ledger (reference model = first paid model of provider)
    const sp = sameProviderPaid.get(e.provider)
    if (sp && sp.calls > 0 && sp.cost > 0) {
      const refModel = [...sameModelPaid.keys()].find(m => m === e.model) // rarely same
        || [...rows].find(r => str(r?.actual_provider) === e.provider && num(r?.estimated_cost_usd) > 0)?.actual_model
        || e.model
      return { ...base, known: true, source: 'ledger-same-provider', referenceModel: str(refModel),
        estimatedUsd: Number(((sp.cost / sp.calls) * e.freeCalls).toFixed(6)) }
    }
    // 3) pricing table public price for this model (may be example data)
    const price = priceFor(e.provider, e.model)
    // A 0-priced entry is NOT a comparable paid price — it is the free model
    // itself. Never present 0 as a "savings" number; mark no-comparable instead.
    if (price.known && (price.input > 0 || price.output > 0)) {
      const usd = num(e.inputTokens) * price.input + num(e.outputTokens) * price.output
      if (usd > 0) return { ...base, known: true, source: `pricing-${priceSource}`, referenceModel: e.model,
        estimatedUsd: Number(usd.toFixed(6)) }
    }
    // 4) no comparable price -> known:false, no amount (never fabricate 0)
    return base
  })
  return {
    estimated: true,
    priceSource,
    note: 'estimate-only',
    models: models.sort((a, b) => b.freeCalls - a.freeCalls),
  }
}

/**
 * Bounded cost detail for the settings page. Returns one page of recent rows
 * plus small aggregations; never the full ledger.
 * @param {string|undefined} dir
 * @param {{offset?:number, limit?:number}} opts
 */
export function readCostDetail(dir, opts = {}) {
  const { rows } = loadRows(dir)
  const offset = Math.max(0, Math.floor(num(opts.offset)))
  const limit = Math.min(200, Math.max(1, Math.floor(num(opts.limit) || 50)))
  // Newest first; only the requested page is serialized. No key/account id in rows.
  const ordered = rows.slice().reverse()
  const page = ordered.slice(offset, offset + limit).map(r => ({
    timestamp: str(r?.timestamp),
    provider: str(r?.actual_provider),
    model: str(r?.actual_model),
    inputTokens: num(r?.input_tokens),
    outputTokens: num(r?.output_tokens),
    costUsd: num(r?.estimated_cost_usd),
    failed: r?.failure_code != null,
    requestId: str(r?.request_id),
    // P2 (task-1): optional latency metrics. Old ledger rows simply lack
    // these keys -> null; present values pass through unchanged (never 0-faked).
    ttftMs: r?.ttft_ms == null ? null : num(r?.ttft_ms),
    durationMs: r?.duration_ms == null ? null : num(r?.duration_ms),
    tokensPerSecond: r?.tokens_per_second == null ? null : num(r?.tokens_per_second),
    startedAt: str(r?.started_at) || null,
    firstTokenAt: str(r?.first_token_at) || null,
    finishedAt: str(r?.finished_at) || null,
  }))
  return {
    total: rows.length,
    offset,
    limit,
    rows: page,
    timeline: buildTimeline(rows),
    byModel: buildByModel(rows),
    savings: buildSavings(rows),
  }
}
