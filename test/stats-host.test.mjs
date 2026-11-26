/**
 * CF-1 Host contract: statistics start (since) + companion state file.
 *
 * Pure Node — no @deepseek-ai/* import. `lib/remote.js` is not imported here
 * (it top-level-awaits the Electron-only Typert base); its method/marker shape
 * is covered by test/remote-surface.test.mjs and test/loading.test.mjs.
 * This file owns the real ledger filtering, the state file round-trip, and
 * the clearStats -> zero-total / ledger-intact guarantee.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCostStats, readCostDetail, sinceMs, sinceIso } from '../lib/cost-stats.js'
import { readStatsState, clearStatsState } from '../lib/stats-state.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-stats-host-'))
}

function row(timestamp, cost, provider = 'openai') {
  return JSON.stringify({
    timestamp, actual_provider: provider, actual_model: 'm',
    input_tokens: 1, output_tokens: 1, estimated_cost_usd: cost, failure_code: null,
  })
}

// ---------------------------------------------------------------------------
// since parsing/normalization — invalid input degrades to "no filter"
// ---------------------------------------------------------------------------

test('sinceMs accepts ISO strings and epoch ms, rejects garbage as absent', () => {
  assert.equal(sinceMs('2026-01-02T03:04:05.000Z'), Date.parse('2026-01-02T03:04:05.000Z'))
  assert.equal(sinceMs('1767323045000'), 1767323045000)
  assert.equal(sinceMs(1767323045000), 1767323045000)
  for (const bad of [null, undefined, '', '   ', 'not-a-date', Number.NaN, {}, true]) {
    assert.equal(sinceMs(bad), undefined, `invalid since ${String(bad)} must mean no filter`)
  }
})

test('sinceIso canonicalizes epoch input and returns null for invalid input', () => {
  assert.equal(sinceIso('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z')
  assert.equal(sinceIso(0), '1970-01-01T00:00:00.000Z')
  assert.equal(sinceIso('nope'), null)
  assert.equal(sinceIso(null), null)
})

// ---------------------------------------------------------------------------
// ledger filtering — boundary is inclusive (>=), corrupt timestamps excluded
// ---------------------------------------------------------------------------

test('readCostStats respects an inclusive since boundary and excludes corrupt rows', () => {
  const dir = tempDir()
  const before = '2026-01-01T00:00:00.000Z'
  const at = '2026-01-02T00:00:00.000Z'
  const after = '2026-01-03T00:00:00.000Z'
  writeFileSync(join(dir, 'cost.jsonl'), [
    row(before, 1),
    row(at, 2),
    row(after, 4),
    row('not-a-timestamp', 8),
    JSON.stringify({ estimated_cost_usd: 16 }),
  ].join('\n') + '\n')

  const all = readCostStats(dir)
  assert.equal(all.records, 5)
  assert.equal(all.estimatedCostUsd, 31)

  const filtered = readCostStats(dir, { since: at })
  assert.equal(filtered.records, 2, 'the exact boundary row is included (>=), corrupt rows are excluded')
  assert.equal(filtered.estimatedCostUsd, 6, 'only the boundary and later rows are summed')
  assert.deepEqual(filtered.byProvider, { openai: 6 })

  // Epoch input produces the identical filter.
  const epoch = readCostStats(dir, { since: Date.parse(at) })
  assert.deepEqual(epoch, filtered)

  // An invalid since is NOT an empty filter — it must not fabricate a zero total.
  assert.deepEqual(readCostStats(dir, { since: 'nonsense' }), all)
})

test('readCostDetail passes opts.since through to rows and aggregations', () => {
  const dir = tempDir()
  const cut = '2026-02-01T00:00:00.000Z'
  writeFileSync(join(dir, 'cost.jsonl'), [
    row('2026-01-31T23:59:59.000Z', 5),
    row(cut, 7, 'anthropic'),
    row('bad-ts', 100),
  ].join('\n') + '\n')
  const detail = readCostDetail(dir, { since: cut })
  assert.equal(detail.total, 1)
  assert.equal(detail.rows.length, 1)
  assert.equal(detail.rows[0].costUsd, 7)
  assert.equal(detail.rows[0].provider, 'anthropic')
  assert.equal(detail.timeline.length, 1)
  assert.equal(detail.byModel.length, 1)
  const all = readCostDetail(dir)
  assert.equal(all.total, 3, 'no-since callers keep the exact legacy shape')
})

// ---------------------------------------------------------------------------
// stats-state.json — missing/corrupt degrade to empty; writes are atomic
// ---------------------------------------------------------------------------

test('readStatsState degrades to empty for missing and corrupt files', () => {
  const dir = tempDir()
  assert.deepEqual(readStatsState(dir), { version: 1, since: null, clearedAt: null })
  assert.deepEqual(readStatsState(''), { version: 1, since: null, clearedAt: null })

  const file = join(dir, 'stats-state.json')
  for (const bad of ['{not json', '[]', 'null', JSON.stringify({ version: 1, since: 'garbage', clearedAt: 7 })]) {
    writeFileSync(file, bad)
    assert.deepEqual(readStatsState(dir), { version: 1, since: null, clearedAt: null }, `bad state: ${bad}`)
  }
})

test('clearStatsState writes a canonical state, tolerates a corrupt clock, and leaves no temp file', () => {
  const dir = tempDir()
  const fixed = new Date('2026-03-04T05:06:07.000Z')
  const state = clearStatsState(dir, () => fixed)
  assert.deepEqual(state, { version: 1, since: fixed.toISOString(), clearedAt: fixed.toISOString() })

  const file = join(dir, 'stats-state.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), state)
  const temps = readdirSync(dir).filter(name => name.includes('.tmp'))
  assert.deepEqual(temps, [], 'atomic rename must not leave a temp file behind')

  // A corrupt clock degrades to a fresh real instant, never a NaN timestamp.
  const fallback = clearStatsState(dir, () => new Date('bad'))
  assert.match(fallback.since, /^\d{4}-\d{2}-\d{2}T/)
})

// ---------------------------------------------------------------------------
// clearStats semantics — total drops to zero, ledger bytes survive unchanged
// ---------------------------------------------------------------------------

test('clearStats resets the counted total to zero while cost.jsonl is byte-identical', () => {
  const dir = tempDir()
  const ledger = join(dir, 'cost.jsonl')
  const rows = [
    row('2026-04-01T00:00:00.000Z', 3),
    row('2026-04-02T00:00:00.000Z', 9),
  ].join('\n') + '\n'
  writeFileSync(ledger, rows)
  const original = readFileSync(ledger)

  assert.equal(readCostStats(dir, { since: null }).estimatedCostUsd, 12)
  const cleared = clearStatsState(dir, () => new Date('2026-04-03T00:00:00.000Z'))
  assert.ok(existsSync(ledger))
  assert.deepEqual(readFileSync(ledger), original, 'clear must never delete or rewrite the ledger')

  const after = readCostStats(dir, { since: readStatsState(dir).since })
  assert.equal(after.estimatedCostUsd, 0, 'no rows at/after the start instant -> honest zero')
  assert.equal(after.records, 0)
  assert.equal(cleared.since, '2026-04-03T00:00:00.000Z')
})
