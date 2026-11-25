#!/usr/bin/env node
/**
 * Query ~/.dsh/smart-provider/cost.jsonl and answer "how much did a model
 * cost, what share of total spend was it, and how fast/reliable was it?".
 *
 * Usage:
 *   node scripts/query-cost.mjs                       # total + per actual_model breakdown
 *   node scripts/query-cost.mjs --model kimi-k3       # one actual_model, with share %
 *   node scripts/query-cost.mjs --outer auto          # filter by outer_model
 *   node scripts/query-cost.mjs --provider opencode-go
 *   node scripts/query-cost.mjs --since 2026-11-23    # ISO date / timestamp lower bound
 *   node scripts/query-cost.mjs --file /path/to/cost.jsonl
 *
 * Estimates only — the offline price table is published list price, not a
 * billing record. Rows with price_known=false price at $0 and are counted
 * separately so under-counting is visible.
 *
 * P2 (task-8): the spend summary and the spend table are byte-for-byte what
 * they always were; latency and reliability are APPENDED as two extra
 * sections. Ledger rows written before 1.1.0 carry no ttft_ms /
 * tokens_per_second keys at all, and those rows are excluded from every
 * latency aggregate instead of being read as 0ms (a 0 would silently drag
 * each average down and report a delay that was never observed). Sample
 * counts are printed next to each average because a mean of one row is not a
 * trend.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BOOL_FLAGS = new Set(['--help', '-h', '--by-account'])

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (BOOL_FLAGS.has(key)) {
      args[key.replace(/^--?/, '')] = true
    } else if (key.startsWith('--')) {
      args[key.slice(2)] = argv[++i] ?? true
    }
  }
  return args
}

function load(file) {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A truncated last line from an interrupted append is not fatal.
    }
  }
  return rows
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Strict finite read: null, undefined, booleans, blank strings, 'abc', NaN
 * and Infinity all collapse to null. Nothing downstream can print
 * NaN/Infinity because nothing downstream ever receives a non-finite number.
 */
function finite(value) {
  if (value == null || typeof value === 'boolean') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * TTFT for one ledger row, in ms, or null when the row carries no usable
 * sample. 1.1.0 writers omit the key entirely when the timeline was
 * incomplete, so "key absent" and "0ms" are different facts: only a real
 * number >= 0 counts as a sample.
 */
function ttftOf(row) {
  const n = finite(row?.ttft_ms)
  return n == null || n < 0 ? null : n
}

/** Output throughput for one row; 0 tok/s means "no output tokens", not a speed. */
function tpsOf(row) {
  const n = finite(row?.tokens_per_second)
  return n == null || n <= 0 ? null : n
}

/**
 * Did this row record a failure? A null / undefined / blank failure_code
 * means "no code" (the attempt is not counted as failed); any real code does.
 */
function failed(row) {
  const code = row?.failure_code
  return code != null && String(code).trim() !== ''
}

/** Mean of a sample list, or null for an empty/poisoned list — never NaN. */
function mean(values) {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  const m = sum / values.length
  return Number.isFinite(m) ? m : null
}

/**
 * Nearest-rank p50. Deliberately NOT the interpolated median: for an even
 * sample the interpolated value is a number no request ever produced, and
 * this report only prints measured values.
 */
function p50(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length / 2) - 1))
  const v = sorted[rank]
  return Number.isFinite(v) ? v : null
}

/**
 * Right-aligned metric cell. null -> '-' (no sample for this metric), so an
 * absent measurement is never rendered as 0 and never as NaN.
 */
function cell(value, digits, width) {
  if (value == null) return '-'.padStart(width)
  const text = digits === 0 ? String(Math.round(value)) : value.toFixed(digits)
  return text.padStart(width)
}

/**
 * Reliability + latency aggregates per group, built from the same filtered
 * rows as the spend table. Legacy rows (no latency keys) still count toward
 * calls/failed but contribute ZERO latency samples.
 */
function aggregate(rows, keyOf) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    let g = groups.get(key)
    if (!g) {
      g = { calls: 0, failed: 0, ttft: [], tps: [] }
      groups.set(key, g)
    }
    g.calls += 1
    if (failed(row)) g.failed += 1
    const ttft = ttftOf(row)
    if (ttft != null) g.ttft.push(ttft)
    const tps = tpsOf(row)
    if (tps != null) g.tps.push(tps)
  }
  return groups
}

/** Group key: one expression for every section, so all tables line up. */
function keyFor(args) {
  return args['by-account']
    ? r => String(r.account_id ?? '?')
    : r => `${r.actual_provider ?? '?'}/${r.actual_model ?? '?'}`
}

function printHelp() {
  console.log(`cost query — offline spend estimate from smart-provider cost.jsonl

Usage:
  node scripts/query-cost.mjs [options]

Options:
  --model <name>       filter by actual_model (substring, case-insensitive)
  --outer <name>       filter by outer_model (substring, case-insensitive)
  --provider <name>    filter by actual_provider (substring, case-insensitive)
  --account <id>       filter by account_id (substring, case-insensitive)
  --by-account         break down spend by account_id instead of route
  --since <iso>        only records at/after this ISO date or timestamp
  --file <path>        cost.jsonl path (default ~/.dsh/smart-provider/cost.jsonl)
  -h, --help           show this help

Output sections (the first two are unchanged from earlier versions):
  1. spend summary + per-group spend table (calls / tokens / cost / share)
  2. "failure rate" per group — failed rows / all rows in that group
  3. "latency" per group      — ttft mean, p50 (nearest-rank), ttft sample
                                count, tokens/s mean, tps sample count

Latency samples come only from rows that actually carry ttft_ms /
tokens_per_second (1.1.0+). Rows from older ledgers have no such keys and are
excluded from latency statistics entirely — never counted as 0ms. A group with
no sample prints "-", and a selection with no samples prints
"no latency samples". A "*" after a sample count marks fewer than 3 samples:
a mean of one or two rows is not a trend.
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return printHelp()
  const file = args.file ?? join(homedir(), '.dsh', 'smart-provider', 'cost.jsonl')
  const allRows = load(file)
  const globalTotal = allRows.reduce((sum, r) => sum + num(r.estimated_cost_usd), 0)
  let rows = allRows

  if (args.model) {
    const needle = String(args.model).toLowerCase()
    rows = rows.filter(r => String(r.actual_model ?? '').toLowerCase().includes(needle))
  }
  if (args.outer) {
    const needle = String(args.outer).toLowerCase()
    rows = rows.filter(r => String(r.outer_model ?? '').toLowerCase().includes(needle))
  }
  if (args.provider) {
    const needle = String(args.provider).toLowerCase()
    rows = rows.filter(r => String(r.actual_provider ?? '').toLowerCase().includes(needle))
  }
  if (args.account) {
    const needle = String(args.account).toLowerCase()
    rows = rows.filter(r => String(r.account_id ?? '').toLowerCase().includes(needle))
  }
  if (args.since) {
    const since = new Date(args.since).getTime()
    if (Number.isFinite(since)) rows = rows.filter(r => new Date(r.timestamp).getTime() >= since)
  }

  const total = rows.reduce((sum, r) => sum + num(r.estimated_cost_usd), 0)
  const unknown = rows.filter(r => r.price_known === false)
  const incomplete = rows.filter(r => r.usage_complete === false)

  console.log(`file: ${file}`)
  console.log(`records: ${rows.length}`)
  console.log(`estimated total: $${total.toFixed(6)} USD`)
  console.log(`  price-unknown rows (counted as $0): ${unknown.length}`)
  console.log(`  usage-incomplete rows (no usage chunk): ${incomplete.length}`)
  console.log('')

  const keyOf = keyFor(args)

  // Per actual_model breakdown with share of total spend.
  const byModel = new Map()
  for (const r of rows) {
    const key = keyOf(r)
    const bucket = byModel.get(key) ?? { cost: 0, calls: 0, input: 0, output: 0 }
    bucket.cost += num(r.estimated_cost_usd)
    bucket.calls += 1
    bucket.input += num(r.input_tokens)
    bucket.output += num(r.output_tokens)
    byModel.set(key, bucket)
  }
  const sorted = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)

  const breakdownLabel = args['by-account'] ? 'account_id' : 'route'
  console.log(`by ${breakdownLabel} (share of estimated spend):`)
  console.log('  ' + breakdownLabel.padEnd(46) + 'calls'.padStart(7) + 'in tok'.padStart(10)
    + 'out tok'.padStart(10) + 'cost USD'.padStart(13) + 'share'.padStart(9))
  for (const [key, v] of sorted) {
    const share = total > 0 ? (v.cost / total) * 100 : 0
    console.log('  ' + key.slice(0, 45).padEnd(46)
      + String(v.calls).padStart(7)
      + String(v.input).padStart(10)
      + String(v.output).padStart(10)
      + v.cost.toFixed(6).padStart(13)
      + `${share.toFixed(1)}%`.padStart(9))
  }

  // ---- appended section 1: reliability -----------------------------------
  // Independent of latency: an all-legacy ledger still reports failure rates.
  const groupKeys = sorted.map(([key]) => key)
  const agg = aggregate(rows, keyOf)
  console.log('')
  console.log(`failure rate (per ${breakdownLabel}):`)
  if (rows.length === 0) {
    console.log('  no records in this selection')
  } else {
    console.log('  ' + breakdownLabel.padEnd(46) + 'calls'.padStart(7)
      + 'failed'.padStart(8) + 'fail%'.padStart(8))
    for (const key of groupKeys) {
      const g = agg.get(key)
      const rate = g.calls > 0 ? (g.failed / g.calls) * 100 : 0
      console.log('  ' + key.slice(0, 45).padEnd(46)
        + String(g.calls).padStart(7)
        + String(g.failed).padStart(8)
        + `${rate.toFixed(1)}%`.padStart(8))
    }
  }

  // ---- appended section 2: latency ---------------------------------------
  console.log('')
  console.log(`latency (per ${breakdownLabel}):`)
  let ttftSamples = 0
  let tpsSamples = 0
  for (const key of groupKeys) {
    const g = agg.get(key)
    ttftSamples += g.ttft.length
    tpsSamples += g.tps.length
  }
  if (ttftSamples === 0 && tpsSamples === 0) {
    // Honest empty state — never "0ms", never NaN.
    console.log(`  no latency samples in this selection (${rows.length} records, `
      + '0 carry ttft_ms / tokens_per_second)')
    if (rows.length > 0) {
      console.log('  rows from pre-1.1.0 ledgers have no latency keys and are excluded, not counted as 0ms')
    }
  } else {
    console.log('  ' + breakdownLabel.padEnd(46) + 'ttft ms'.padStart(9)
      + 'p50 ms'.padStart(8) + 'ttft n'.padStart(8)
      + 'tok/s'.padStart(9) + 'tps n'.padStart(7))
    let thin = false
    let dashed = false
    for (const key of groupKeys) {
      const g = agg.get(key)
      const ttftAvg = mean(g.ttft)
      const ttftP50 = p50(g.ttft)
      const tpsAvg = mean(g.tps)
      let sampleCell = String(g.ttft.length)
      if (g.ttft.length > 0 && g.ttft.length < 3) {
        sampleCell += '*'
        thin = true
      }
      if (ttftAvg == null || tpsAvg == null) dashed = true
      console.log('  ' + key.slice(0, 45).padEnd(46)
        + cell(ttftAvg, 0, 9)
        + cell(ttftP50, 0, 8)
        + sampleCell.padStart(8)
        + cell(tpsAvg, 1, 9)
        + String(g.tps.length).padStart(7))
    }
    if (dashed) {
      console.log("  '-' = no sample for that metric (rows without the key are skipped, not counted as 0)")
    }
    if (thin) {
      console.log('  * = fewer than 3 samples: a mean of one or two rows is not a trend')
    }
  }

  if (args.model && rows.length > 0) {
    const share = globalTotal > 0 ? (total / globalTotal) * 100 : 0
    console.log('')
    console.log(`"${args.model}": $${total.toFixed(6)} of $${globalTotal.toFixed(6)} total = ${share.toFixed(1)}% of all recorded spend.`)
  }
}

main()
