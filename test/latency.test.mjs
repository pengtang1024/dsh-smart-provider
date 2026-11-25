/**
 * P2 (task-1) latency metric tests.
 *
 * Covers the task-1 acceptance list:
 *   1. adapter stamps startedAt/firstTokenAt/finishedAt on REAL stream flow
 *      (ordering + fallback-before-first-chunk semantics untouched);
 *   2. CostMeter derives ttft_ms/duration_ms/tokens_per_second and OMITS
 *      every field it lacks data for (never writes 0 to fake data);
 *   3. degradation when usage is missing (no tokens_per_second) or no
 *      content chunk ever flowed (no firstTokenAt/ttft_ms);
 *   4. old ledger rows without the new keys still aggregate in cost-stats;
 *   5. ranking speed factor fallback chain:
 *      measured ttft -> manual speedTier -> neutral 0.5, and scoring is
 *      byte-identical to pre-task-1 when ctx.speedEvidence is absent.
 *
 * The adapter tests need the real LlmAdapter base class, so run via the
 * DSH runtime:
 *   ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/latency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SmartAdapter } from '../lib/adapter.js'
import { CostMeter } from '../lib/cost-meter.js'
import { readCostStats, readCostDetail } from '../lib/cost-stats.js'
import { measuredSpeedScore, scoreAccounts, rankAccountsForHop, normalizeAccountRanking, normalizeRankingConfig } from '../lib/ranking.js'

/** A runtime whose stream script can control chunk timing. */
function timedRuntime(script) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push({ provider: options.provider, model: options.model })
      for (const step of script) {
        if (step.sleepMs) await new Promise(resolve => setTimeout(resolve, step.sleepMs))
        yield step.chunk
      }
    },
    resolveRetryPolicy(config) { return config },
    resolveModelInfo(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
    imageRequestPricing() { return undefined },
  }
}

function accountFor(id, provider, extraRanking = {}) {
  return { id, provider, models: ['m1'], ...normalizeAccountRanking(extraRanking) }
}

async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'auto', sessionId: 's1', ...options })) {
    chunks.push(chunk)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// 1. Adapter stamps the three time points on real stream flow
// ---------------------------------------------------------------------------

test('adapter stamps startedAt <= firstTokenAt <= finishedAt on a real stream', async () => {
  const runtime = timedRuntime([
    { sleepMs: 15, chunk: { type: 'text-delta', text: 'hello' } },
    { sleepMs: 15, chunk: { type: 'text-delta', text: ' world' } },
    { sleepMs: 15, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } },
    { chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat1-')) })
  const adapter = new SmartAdapter({
    runtime,
    chains: { auto: [{ provider: 'p1', model: 'm1' }] },
    meter,
  })
  const before = Date.now()
  const chunks = await collect(adapter)
  const after = Date.now()
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  await meter.close()

  const row = JSON.parse(readFileSync(join(meter.dir, 'cost.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.ok(row.started_at, 'started_at present')
  assert.ok(row.first_token_at, 'first_token_at present')
  assert.ok(row.finished_at, 'finished_at present')
  const s = Date.parse(row.started_at), f = Date.parse(row.first_token_at), e = Date.parse(row.finished_at)
  assert.ok(s >= before - 5 && s <= after, 'startedAt within the request window')
  assert.ok(s <= f && f <= e, 'ordering startedAt <= firstTokenAt <= finishedAt')
  assert.ok(row.ttft_ms >= 10, 'ttft_ms reflects the scripted 15ms first-chunk delay, got ' + row.ttft_ms)
  assert.ok(row.duration_ms >= row.ttft_ms, 'duration_ms >= ttft_ms')
  assert.ok(row.tokens_per_second > 0, 'tokens_per_second derived from real output tokens')
})

test('fallback-before-first-chunk semantics unchanged: failure without content still switches hops', async () => {
  const runtime = timedRuntime([
    { chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '402 exhausted' } } } },
  ])
  const runtime2 = timedRuntime([
    { chunk: { type: 'text-delta', text: 'ok' } },
    { chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  // First attempt fails BEFORE any content chunk: must fall back to hop 2.
  const calls = []
  const streams = [runtime, runtime2]
  let hop = 0
  const switching = {
    calls,
    get stream() {
      return (options) => {
        const r = streams[Math.min(hop, streams.length - 1)]
        hop += 1
        return r.stream(options)
      }
    },
    resolveRetryPolicy(c) { return c },
    resolveModelInfo(p, m) { return Promise.resolve({ provider: p, id: m, name: m }) },
    imageRequestPricing() { return undefined },
  }
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat2-')) })
  const adapter = new SmartAdapter({
    runtime: switching,
    chains: { auto: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm1' }] },
    meter,
  })
  const chunks = await collect(adapter)
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'second hop succeeded')
  await meter.close()

  const rows = readFileSync(join(meter.dir, 'cost.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].failure_code, 'QUOTA')
  // The failed first hop never saw content: no first_token_at / ttft_ms.
  assert.ok(!('first_token_at' in rows[0]), 'no first_token_at without content')
  assert.ok(!('ttft_ms' in rows[0]), 'no ttft_ms without content')
  assert.ok('started_at' in rows[0] && 'finished_at' in rows[0], 'but start/finish are stamped')
})

// ---------------------------------------------------------------------------
// 2. Derivation + degradation in CostMeter
// ---------------------------------------------------------------------------

test('CostMeter omits latency fields entirely when no latency data arrives', async () => {
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat3-')) })
  meter.record({ outerModel: 'auto', actualProvider: 'p', actualModel: 'm', usage: { inputTokens: 1, outputTokens: 2 }, hopIndex: 0 })
  await meter.close()
  const row = JSON.parse(readFileSync(join(meter.dir, 'cost.jsonl'), 'utf8').trim())
  for (const key of ['started_at', 'first_token_at', 'finished_at', 'ttft_ms', 'duration_ms', 'tokens_per_second']) {
    assert.ok(!(key in row), key + ' absent without latency data (no 0-fake)')
  }
})

test('CostMeter degradation: usage missing -> no tokens_per_second; firstToken missing -> no ttft_ms', async () => {
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat4-')) })
  const started = Date.now() - 100
  // No usage object at all.
  meter.record({ outerModel: 'auto', actualProvider: 'p', actualModel: 'm', usage: undefined, hopIndex: 0,
    latency: { startedAt: started, finishedAt: Date.now() } })
  // firstTokenAt before startedAt is meaningless -> no ttft_ms.
  meter.record({ outerModel: 'auto', actualProvider: 'p', actualModel: 'm', usage: { outputTokens: 5 }, hopIndex: 0,
    latency: { startedAt: started, firstTokenAt: started - 50, finishedAt: Date.now() } })
  // Zero output tokens -> no tokens_per_second even with a full timeline.
  meter.record({ outerModel: 'auto', actualProvider: 'p', actualModel: 'm', usage: { outputTokens: 0 }, hopIndex: 0,
    latency: { startedAt: started, firstTokenAt: started + 10, finishedAt: Date.now() } })
  await meter.close()
  const rows = readFileSync(join(meter.dir, 'cost.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(!('tokens_per_second' in rows[0]), 'no tps without usage')
  assert.ok('duration_ms' in rows[0] && 'started_at' in rows[0] && 'finished_at' in rows[0])
  assert.ok(!('ttft_ms' in rows[1]), 'no ttft_ms when firstTokenAt < startedAt')
  assert.ok(!('tokens_per_second' in rows[2]), 'no tps with zero output tokens')
  assert.ok('ttft_ms' in rows[2] && 'duration_ms' in rows[2])
})

// ---------------------------------------------------------------------------
// 4. Old-ledger-row compatibility in cost-stats
// ---------------------------------------------------------------------------

test('cost-stats aggregates old rows (no latency keys) exactly as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lat5-'))
  const oldRow = { timestamp: '2026-11-20T10:00:00.000Z', outer_model: 'auto', actual_provider: 'p1', actual_model: 'm1',
    input_tokens: 100, output_tokens: 50, estimated_cost_usd: 0.0000001, hop_index: 0, failure_code: null, failure_message: null,
    account_id: null, cache_read_tokens: 0, cache_write_tokens: 0, usage_complete: true, price_known: true,
    request_id: 'legacy-1', seq: 1 }
  const newRow = { ...oldRow, request_id: 'new-1', seq: 2, started_at: '2026-11-20T11:00:00.000Z',
    first_token_at: '2026-11-20T11:00:00.800000Z', finished_at: '2026-11-20T11:00:02.000000Z',
    ttft_ms: 800, duration_ms: 2000, tokens_per_second: 25 }
  writeFileSync(join(dir, 'cost.jsonl'), JSON.stringify(oldRow) + '\n' + JSON.stringify(newRow) + '\n')
  const stats = readCostStats(dir)
  assert.equal(stats.records, 2, 'both rows counted')
  assert.equal(stats.freeCount, 0)
  assert.equal(stats.paidCount, 2)
  const detail = readCostDetail(dir, { limit: 10 })
  assert.equal(detail.rows.length, 2)
  assert.equal(detail.rows[1].ttftMs, null, 'old row -> null ttftMs')
  assert.equal(detail.rows[1].durationMs, null)
  assert.equal(detail.rows[0].ttftMs, 800, 'new row keeps its measured ttftMs')
  assert.equal(detail.rows[0].tokensPerSecond, 25)
  assert.equal(detail.rows[0].startedAt, '2026-11-20T11:00:00.000Z')
})

// ---------------------------------------------------------------------------
// 5. ranking speed factor fallback chain
// ---------------------------------------------------------------------------

test('measuredSpeedScore bands real ttft/tps and returns null without data', () => {
  assert.equal(measuredSpeedScore({ ttftMs: 300 }), 1)
  assert.equal(measuredSpeedScore({ ttftMs: 1200 }), 0.6)
  assert.equal(measuredSpeedScore({ ttftMs: 5000 }), 0.2)
  assert.equal(measuredSpeedScore({ tokensPerSecond: 60 }), 1)
  assert.equal(measuredSpeedScore({ tokensPerSecond: 20 }), 0.6)
  assert.equal(measuredSpeedScore({ tokensPerSecond: 5 }), 0.2)
  // ttft and tps can disagree; the better band wins (real fast start).
  assert.equal(measuredSpeedScore({ ttftMs: 5000, tokensPerSecond: 60 }), 1)
  assert.equal(measuredSpeedScore(null), null)
  assert.equal(measuredSpeedScore({}), null)
  assert.equal(measuredSpeedScore({ ttftMs: 0 }), null, '0 is "no data", not fast')
  assert.equal(measuredSpeedScore({ ttftMs: Number.NaN }), null)
})

test('speed factor fallback chain: measured > speedTier > neutral, absent evidence = pre-task-1 value', () => {
  const fast = accountFor('fast', 'p1', { speedTier: 'slow' })
  const tiered = accountFor('tiered', 'p1', { speedTier: 'fast' })
  const cfg = normalizeRankingConfig({ enabled: true, strategy: 'speed-first' })
  // 1) measured ttft overrides a hand-set slow tier.
  const withEvidence = scoreAccounts([fast], 'm1', cfg, { domain: [fast], usage: new Map(),
    speedEvidence: { fast: { ttftMs: 300 } } })
  assert.equal(withEvidence[0].factors.speed, 1, 'measured ttft wins over manual slow')
  // 2) no measurement -> hand-set speedTier.
  const withoutEvidence = scoreAccounts([tiered], 'm1', cfg, { domain: [tiered], usage: new Map() })
  assert.equal(withoutEvidence[0].factors.speed, 1, 'manual fast tier used')
  // 3) neither -> neutral 0.5 (a raw account with no recognizable speedTier,
  //    e.g. an implicit hop account that never went through normalization).
  const plain = { id: 'plain', provider: 'p1', models: ['m1'] }
  const neutral = scoreAccounts([plain], 'm1', cfg, { domain: [plain], usage: new Map() })
  assert.equal(neutral[0].factors.speed, 0.5, 'neutral fallback')
  // 4) speedEvidence present but THIS account has no entry -> still speedTier.
  const partial = scoreAccounts([fast], 'm1', cfg, { domain: [fast], usage: new Map(),
    speedEvidence: { other: { ttftMs: 100 } } })
  assert.equal(partial[0].factors.speed, 0.2, 'unrelated evidence entry falls back to speedTier')
})

test('rankAccountsForHop consumes ctx.speedEvidence (measured beats manual tier)', () => {
  // Same provider for both accounts so the respectHopRoute hard layer cannot
  // decide before the speed factor does.
  // The measured account carries a pessimistic manual 'slow' tier that the
  // real ttft overrides; the competitor's manual 'normal' tier (0.6) must lose
  // to the measured fast band (1.0).
  const slowManual = accountFor('measured', 'p1', { speedTier: 'slow' })
  const fastManual = accountFor('manual', 'p1', { speedTier: 'normal' })
  const cfg = normalizeRankingConfig({ enabled: true, strategy: 'speed-first', priorityMode: 'soft' })
  // Without evidence, manual fast wins.
  const base = rankAccountsForHop([slowManual, fastManual], [slowManual, fastManual], 'm1',
    { provider: 'p1' }, cfg, { domain: [slowManual, fastManual], usage: new Map() })
  assert.equal(base[0].id, 'manual')
  // With a real fast ttft for the first account, measured wins.
  const withEvidence = rankAccountsForHop([slowManual, fastManual], [slowManual, fastManual], 'm1',
    { provider: 'p1' }, cfg, { domain: [slowManual, fastManual], usage: new Map(),
      speedEvidence: { measured: { ttftMs: 200 } } })
  assert.equal(withEvidence[0].id, 'measured')
})

// ---------------------------------------------------------------------------
// 6. P1 (task-9): the adapter actually produces speed evidence
// ---------------------------------------------------------------------------

test('adapter records a real successful call as speed evidence (measured ttft reaches the pool)', async () => {
  const runtime = timedRuntime([
    { sleepMs: 15, chunk: { type: 'text-delta', text: 'hi' } },
    { chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } },
    { chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat6-')) })
  const adapter = new SmartAdapter({
    runtime,
    chains: { auto: [{ provider: 'p1', model: 'm1' }] },
    meter,
  })
  assert.deepEqual(adapter.accountPool.readSpeedEvidence(), {}, 'no evidence before any call')
  await collect(adapter)
  await meter.close()

  const evidence = adapter.accountPool.readSpeedEvidence()
  const accountId = 'hop:p1/m1'
  assert.ok(evidence[accountId], 'the implicit hop account has measured evidence')
  assert.ok(evidence[accountId].ttftMs >= 10, 'ttft reflects the scripted 15ms first-chunk delay, got ' + evidence[accountId].ttftMs)
  assert.ok(evidence[accountId].tokensPerSecond > 0, 'tokensPerSecond derived from real usage')
})

test('adapter records NOTHING for a failed attempt (failure is not speed evidence)', async () => {
  const failing = timedRuntime([
    { chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '402 exhausted' } } } },
  ])
  const healthy = timedRuntime([
    { sleepMs: 12, chunk: { type: 'text-delta', text: 'ok' } },
    { chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  let hop = 0
  const streams = [failing, healthy]
  const switching = {
    get stream() {
      return options => {
        const picked = streams[Math.min(hop, streams.length - 1)]
        hop += 1
        return picked.stream(options)
      }
    },
    resolveRetryPolicy(c) { return c },
    resolveModelInfo(p, m) { return Promise.resolve({ provider: p, id: m, name: m }) },
    imageRequestPricing() { return undefined },
  }
  const meter = new CostMeter({ dir: mkdtempSync(join(tmpdir(), 'lat7-')) })
  const adapter = new SmartAdapter({
    runtime: switching,
    chains: { auto: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm1' }] },
    meter,
  })
  const chunks = await collect(adapter)
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'second hop succeeded')
  await meter.close()

  const evidence = adapter.accountPool.readSpeedEvidence()
  assert.deepEqual(Object.keys(evidence), ['hop:p2/m1'],
    'only the successful hop is evidence; the failed hop never produced content')
})

