/**
 * Tests for scripts/query-cost.mjs — P2 (task-8): latency & reliability
 * sections added on top of the (unchanged) spend report.
 * Run: node --test test/query-cost.test.mjs   (pure Node, no DSH package)
 *
 * The CLI is driven as a child process against a constructed cost.jsonl, so
 * every assertion is about the report a user actually sees — printed headers,
 * sample counts, the honest empty state — not about an internal helper. The
 * bug this task fixes was "the report never showed the new dimensions at all",
 * which only a rendered-output assertion catches.
 *
 * Fixtures are written into os.tmpdir() and removed afterwards; nothing is
 * left in the repo. process.execPath is reused so the suite works both under
 * plain Node and under the DSH gate's Electron-as-Node runtime.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/query-cost.mjs', import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'query-cost-test-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

let seq = 0

/** A 1.1.0+ row: carries the whole latency timeline. */
function newRow(over = {}) {
  return {
    timestamp: '2026-11-20T10:00:00Z',
    outer_model: 'auto',
    actual_provider: 'prov-a',
    actual_model: 'model-a',
    input_tokens: 100,
    output_tokens: 50,
    estimated_cost_usd: 0.001,
    hop_index: 0,
    failure_code: null,
    account_id: 'acct-a',
    started_at: '2026-11-20T10:00:00.000Z',
    first_token_at: '2026-11-20T10:00:00.100Z',
    finished_at: '2026-11-20T10:00:02.000Z',
    ttft_ms: 100,
    duration_ms: 2000,
    tokens_per_second: 25,
    ...over,
  }
}

/** A pre-1.1.0 row: the latency keys do not exist at all on disk. */
function legacyRow(over = {}) {
  return {
    timestamp: '2026-11-19T09:00:00Z',
    outer_model: 'auto',
    actual_provider: 'prov-a',
    actual_model: 'model-a',
    input_tokens: 100,
    output_tokens: 50,
    estimated_cost_usd: 0.001,
    hop_index: 0,
    failure_code: null,
    account_id: 'acct-a',
    ...over,
  }
}

function omit(row, ...keys) {
  const copy = { ...row }
  for (const key of keys) delete copy[key]
  return copy
}

/** Write a ledger and run the CLI against it (rows may be objects or raw lines). */
function runQuery(rows, args = []) {
  seq += 1
  const file = join(DIR, `ledger-${seq}.jsonl`)
  const body = rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')
  writeFileSync(file, body.length > 0 ? body + '\n' : '', 'utf8')
  const res = spawnSync(process.execPath, [SCRIPT, '--file', file, ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, `query-cost exited ${res.status}: ${res.stderr}`)
  assert.equal(res.stderr.trim(), '', 'no stderr noise on a healthy run')
  return res.stdout
}

/** Lines of one output section, between its header and the next blank line. */
function section(stdout, header) {
  const lines = stdout.split('\n')
  const start = lines.findIndex(line => line.trim() === header)
  assert.notEqual(start, -1, `section "${header}" must be printed; got:\n${stdout}`)
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') break
    out.push(lines[i])
  }
  return out
}

/** Whitespace-split cells of the data line belonging to one group. */
function rowCells(lines, key) {
  const line = lines.find(entry => entry.startsWith('  ' + key + ' '))
  assert.ok(line, `no data line for "${key}" in:\n${lines.join('\n')}`)
  return line.trim().split(/\s+/)
}

function assertNoBogusNumbers(stdout) {
  assert.ok(!/NaN/.test(stdout), 'report must never print NaN:\n' + stdout)
  assert.ok(!/Infinity/.test(stdout), 'report must never print Infinity:\n' + stdout)
}

// ---------------------------------------------------------------------------
// 1. mixed new + legacy rows
// ---------------------------------------------------------------------------
test('mixed ledger: legacy rows are excluded from latency stats, not counted as 0ms', () => {
  const rows = [
    newRow({ ttft_ms: 100, tokens_per_second: 25 }),
    newRow({ ttft_ms: 300, tokens_per_second: 25 }),
    newRow({ ttft_ms: 500, tokens_per_second: 25 }),
    legacyRow(),
    legacyRow(),
    legacyRow(),
  ]
  const stdout = runQuery(rows)

  // The spend table still counts every row — compat is not traded away.
  assert.match(stdout, /records: 6/)
  const spend = section(stdout, 'by route (share of estimated spend):')
  assert.deepEqual(rowCells(spend, 'prov-a/model-a').slice(1, 2), ['6'], 'spend table counts all 6 rows')

  // Latency comes from the 3 measured rows only: (100+300+500)/3 = 300.
  const latency = section(stdout, 'latency (per route):')
  const cells = rowCells(latency, 'prov-a/model-a')
  assert.deepEqual(cells, ['prov-a/model-a', '300', '300', '3', '25.0', '3'])
  // If the legacy rows were read as 0ms the mean would be 150 — the whole
  // point of this task is that it must not be.
  assert.notEqual(cells[1], '150')
  assertNoBogusNumbers(stdout)
})

// ---------------------------------------------------------------------------
// 2. all-legacy ledger
// ---------------------------------------------------------------------------
test('all-legacy ledger: honest "no latency samples" empty state, no NaN', () => {
  const stdout = runQuery([legacyRow(), legacyRow({ actual_model: 'model-b' }), legacyRow(), legacyRow()])

  assert.match(stdout, /records: 4/)
  assert.match(stdout, /no latency samples in this selection \(4 records, 0 carry ttft_ms \/ tokens_per_second\)/)
  assert.match(stdout, /rows from pre-1\.1\.0 ledgers have no latency keys and are excluded, not counted as 0ms/)
  // Reliability is still reported for rows that carry no latency data at all.
  const failure = section(stdout, 'failure rate (per route):')
  assert.deepEqual(rowCells(failure, 'prov-a/model-a'), ['prov-a/model-a', '3', '0', '0.0%'])
  assertNoBogusNumbers(stdout)
})

// ---------------------------------------------------------------------------
// 3. no ttft, but throughput is present (partial timeline)
// ---------------------------------------------------------------------------
test('rows with throughput but no ttft: ttft shows no sample while tps is still measured', () => {
  const rows = [
    omit(newRow({ tokens_per_second: 20 }), 'ttft_ms'),
    omit(newRow({ tokens_per_second: 30 }), 'ttft_ms'),
  ]
  const stdout = runQuery(rows)

  const latency = section(stdout, 'latency (per route):')
  assert.deepEqual(rowCells(latency, 'prov-a/model-a'), ['prov-a/model-a', '-', '-', '0', '25.0', '2'])
  // A sample exists for tps, so the whole-selection empty state must NOT fire.
  assert.ok(!/no latency samples in this selection/.test(stdout), 'tps samples exist, so not the empty state')
  assert.match(stdout, /'-' = no sample for that metric/)
  assertNoBogusNumbers(stdout)
})

// ---------------------------------------------------------------------------
// 4. empty ledger
// ---------------------------------------------------------------------------
test('empty ledger: zero records, empty states, exit 0', () => {
  const stdout = runQuery([])
  assert.match(stdout, /records: 0/)
  assert.match(stdout, /no records in this selection/)
  assert.match(stdout, /no latency samples in this selection \(0 records, 0 carry ttft_ms \/ tokens_per_second\)/)
  assertNoBogusNumbers(stdout)
})

// ---------------------------------------------------------------------------
// 5. NaN / Infinity / garbage protection
// ---------------------------------------------------------------------------
test('garbage latency values never reach the averages and never print NaN/Infinity', () => {
  // 1e999 overflows to Infinity through JSON.parse, so it is a real-world
  // way for a corrupt/overflowing ledger value to arrive as Infinity.
  const overflows = '{"timestamp":"2026-11-20T10:00:00Z","outer_model":"auto","actual_provider":"prov-a",'
    + '"actual_model":"model-a","estimated_cost_usd":0.001,"failure_code":null,'
    + '"ttft_ms":1e999,"tokens_per_second":1e999}'
  const rows = [
    newRow({ ttft_ms: 100, tokens_per_second: 10 }),
    newRow({ ttft_ms: 'abc', tokens_per_second: 'abc' }),
    newRow({ ttft_ms: null, tokens_per_second: null }),
    newRow({ ttft_ms: true, tokens_per_second: false }),
    newRow({ ttft_ms: '', tokens_per_second: '' }),
    newRow({ ttft_ms: -5, tokens_per_second: -1 }),
    overflows,
  ]
  const stdout = runQuery(rows)

  const latency = section(stdout, 'latency (per route):')
  // Only the one valid row is a sample; the failing hop count is untouched.
  assert.deepEqual(rowCells(latency, 'prov-a/model-a'), ['prov-a/model-a', '100', '100', '1*', '10.0', '1'])
  assert.match(stdout, /\* = fewer than 3 samples/)
  assertNoBogusNumbers(stdout)
})

// ---------------------------------------------------------------------------
// 6. "0ms" is data; "key absent" is not
// ---------------------------------------------------------------------------
test('an explicit ttft_ms of 0 is a real sample, distinct from a missing key', () => {
  const stdout = runQuery([newRow({ ttft_ms: 0 }), newRow({ ttft_ms: 100 })])
  const latency = section(stdout, 'latency (per route):')
  const cells = rowCells(latency, 'prov-a/model-a')
  assert.equal(cells[1], '50', 'mean of 0 and 100 is 50 — the 0 was counted as data')
  assert.equal(cells[2], '0', 'nearest-rank p50 of [0,100] is 0')
  assert.equal(cells[3], '2*', 'two samples, flagged as thin')
})

// ---------------------------------------------------------------------------
// 7. p50 is nearest-rank, defined for every sample size
// ---------------------------------------------------------------------------
test('p50 uses nearest-rank for n=1..4 (never an interpolated value)', () => {
  const cases = [
    { ttft: [500], p50: '500' },
    { ttft: [100, 300], p50: '100' },
    { ttft: [100, 300, 500], p50: '300' },
    { ttft: [100, 200, 300, 400], p50: '200' },
  ]
  for (const c of cases) {
    const stdout = runQuery(c.ttft.map(ttft_ms => newRow({ ttft_ms })))
    const latency = section(stdout, 'latency (per route):')
    const cells = rowCells(latency, 'prov-a/model-a')
    assert.equal(cells[2], c.p50, `p50 of [${c.ttft.join(',')}] must be ${c.p50}`)
    assert.equal(cells[3], c.ttft.length === 1 ? '1*' : String(c.ttft.length) + (c.ttft.length < 3 ? '*' : ''),
      'sample count is printed so a mean of one row is visible')
  }
})

// ---------------------------------------------------------------------------
// 8. failure rate
// ---------------------------------------------------------------------------
test('failure rate counts real codes only; null and blank codes are successes', () => {
  const rows = [
    newRow({ failure_code: null }),
    newRow({ failure_code: 'QUOTA' }),
    newRow({ failure_code: '' }),
    newRow({ failure_code: 'TIMEOUT' }),
  ]
  const stdout = runQuery(rows)
  const failure = section(stdout, 'failure rate (per route):')
  assert.deepEqual(rowCells(failure, 'prov-a/model-a'), ['prov-a/model-a', '4', '2', '50.0%'])
})

// ---------------------------------------------------------------------------
// 9. existing CLI surface unchanged
// ---------------------------------------------------------------------------
test('existing CLI surface still works: spend columns, --model footnote, --by-account, --since', () => {
  const rows = [
    newRow({ timestamp: '2026-11-20T10:00:00Z' }),
    legacyRow({ timestamp: '2026-11-19T09:00:00Z' }),
    legacyRow({ timestamp: '2026-11-19T09:00:00Z', actual_provider: 'prov-b', actual_model: 'model-b' }),
  ]

  // Unchanged spend table header, and the section order is spend -> failure -> latency.
  const plain = runQuery(rows)
  assert.match(plain, /by route \(share of estimated spend\):/)
  assert.deepEqual(
    ['by route (share of estimated spend):', 'failure rate (per route):', 'latency (per route):']
      .map(header => plain.indexOf(header) > -1).filter(Boolean).length,
    3,
    'all three sections are present',
  )
  const spendHeader = section(plain, 'by route (share of estimated spend):')[0]
  assert.deepEqual(spendHeader.trim().split(/\s+/), ['route', 'calls', 'in', 'tok', 'out', 'tok', 'cost', 'USD', 'share'])

  // --model keeps its trailing share line, and it is still the last thing printed.
  const filtered = runQuery(rows, ['--model', 'model-a'])
  const tail = filtered.trim().split('\n').pop()
  assert.match(tail, /^"model-a": \$0\.002000 of \$0\.003000 total = 66\.7% of all recorded spend\.$/)

  // --by-account switches both appended sections, not just the spend table.
  const byAccount = runQuery(rows, ['--by-account'])
  assert.ok(byAccount.includes('by account_id (share of estimated spend):'))
  assert.ok(byAccount.includes('failure rate (per account_id):'))
  assert.ok(byAccount.includes('latency (per account_id):'))

  // --since still filters.
  const since = runQuery(rows, ['--since', '2026-11-20'])
  assert.match(since, /records: 1/)
})

// ---------------------------------------------------------------------------
// 10. missing ledger file
// ---------------------------------------------------------------------------
test('missing ledger path is an honest empty state, not a crash', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--file', join(DIR, 'does-not-exist.jsonl')], { encoding: 'utf8' })
  assert.equal(res.status, 0, 'a missing ledger is not an error')
  assert.match(res.stdout, /records: 0/)
  assert.match(res.stdout, /no latency samples in this selection \(0 records/)
  assertNoBogusNumbers(res.stdout)
})

// ---------------------------------------------------------------------------
// 11. help documents the new sections
// ---------------------------------------------------------------------------
test('--help documents the appended sections and the exclusion rule', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /"failure rate" per group/)
  assert.match(res.stdout, /"latency" per group/)
  assert.match(res.stdout, /excluded from latency statistics entirely/)
})
