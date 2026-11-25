#!/usr/bin/env node
/**
 * Query ~/.dsh/smart-provider/cost.jsonl and answer "how much did a model
 * cost, and what share of total spend was it?".
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

  // Per actual_model breakdown with share of total spend.
  const byModel = new Map()
  for (const r of rows) {
    const key = args['by-account']
      ? String(r.account_id ?? '?')
      : `${r.actual_provider ?? '?'}/${r.actual_model ?? '?'}`
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

  if (args.model && rows.length > 0) {
    const share = globalTotal > 0 ? (total / globalTotal) * 100 : 0
    console.log('')
    console.log(`"${args.model}": $${total.toFixed(6)} of $${globalTotal.toFixed(6)} total = ${share.toFixed(1)}% of all recorded spend.`)
  }
}

main()
