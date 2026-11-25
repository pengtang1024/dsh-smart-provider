/**
 * P1 regression: estimated zero cost from the no-price-table fallback must not
 * be replayed as real "free" evidence (task-15).
 *
 * Regression suite (pure logic, any Node):
 *   node --test test/hydration-billing.test.mjs
 *
 * Fixtures are built in os.tmpdir() and removed after every case; nothing is
 * left in the repo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { BILLING_TIER, billingTierOf, healthOf, HEALTH } from '../lib/availability.js'
import { buildHealthDeps } from '../lib/health-setup.js'
import { hydrateAccountEvidence, hydrateHealthEvidence, liveWins } from '../lib/health-persistence.js'
import { localDayOf, readCostDetail, readCostStats } from '../lib/cost-stats.js'

const BASE = Date.parse('2026-11-25T00:00:00.000Z')

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'smart-hydration-billing-'))
  try {
    await writeFile(join(dir, 'probe-cache.jsonl'), '', 'utf8')
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Build a cost.jsonl row; omit a field entirely by passing undefined. */
function row({
  provider = 'deepseek-account', model = 'deepseek-flash', cost = 0,
  priceKnown, estimated, failure = null, at = BASE, account = 'acct-a',
} = {}) {
  const out = {
    timestamp: new Date(at).toISOString(),
    outer_model: 'auto',
    actual_provider: provider,
    actual_model: model,
    account_id: account,
    input_tokens: 100,
    output_tokens: 10,
    estimated_cost_usd: cost,
    hop_index: 0,
    failure_code: failure,
    failure_message: null,
    usage_complete: true,
  }
  if (priceKnown !== undefined) out.price_known = priceKnown
  if (estimated !== undefined) out.estimated = estimated
  return JSON.stringify(out)
}

async function hydrate(dir, lines, config = {}) {
  await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')
  const health = buildHealthDeps(config)
  const result = await hydrateHealthEvidence({ dir, health })
  assert.equal(result.hydrated, true)
  assert.equal(result.cost.malformed, 0, 'fixtures must have no malformed rows')
  return health
}

/** 21 distinct timestamps so the timestamp guard never drops a row. */
function rows(count, factory) {
  return Array.from({ length: count }, (_, i) => factory(BASE + i * 1000))
}

// ---------------------------------------------------------------------------
// P0 trigger proof: with the shipped zero-price-only table, deepseek-account
// resolves to estimated:true / known:false with all-zero placeholder amounts.
// ---------------------------------------------------------------------------

test('deepseek-account/deepseek-flash has no real price: estimated zero', async () => {
  const { priceFor } = await import(`../lib/pricing.js?case=${Date.now()}`)
  const price = priceFor('deepseek-account', 'deepseek-flash')
  assert.equal(price.known, false)
  assert.equal(price.estimated, true)
  assert.equal(price.input, 0)
  assert.equal(price.output, 0)
  assert.equal(price.cacheRead, 0)
  assert.equal(price.cacheWrite, 0)
})

// ---------------------------------------------------------------------------
// (a) 20+ estimated zero rows must NOT be replayed as free evidence.
// ---------------------------------------------------------------------------

test('21 estimated zero rows replay as HEALTHY but billing stays UNKNOWN', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, rows(21, at => row({ at, priceKnown: false, estimated: true })))
    const key = { provider: 'deepseek-account', modelId: 'deepseek-flash' }
    assert.equal(healthOf(health.availabilityRegistry, key).health, HEALTH.HEALTHY,
      'success samples are still replayed; only the free claim is suppressed')
    assert.equal(health.availabilityRegistry['deepseek-account::deepseek-flash'].samples.success, 21)
    assert.deepEqual(billingTierOf(health.availabilityRegistry, key), { tier: BILLING_TIER.UNKNOWN, confidence: 0 })
    assert.equal(health.availabilityRegistry['deepseek-account::deepseek-flash'].billing.freeSamples, 0)
  })
})

// ---------------------------------------------------------------------------
// (b) declared zero price (price_known=true) stays FREE.
// ---------------------------------------------------------------------------

test('21 real zero-cost rows still replay to medium-confidence FREE', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, rows(21, at => row({
      provider: 'x-opencode-free', model: 'hy4-flash-free', at, priceKnown: true,
    })))
    assert.deepEqual(
      billingTierOf(health.availabilityRegistry, { provider: 'x-opencode-free', modelId: 'hy4-flash-free' }),
      { tier: BILLING_TIER.FREE, confidence: 0.7 },
    )
  })
})

test('a real zero-price row explicitly marked estimated:false is still FREE', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, rows(21, at => row({
      provider: 'x-opencode-free', model: 'web-search-free', at, priceKnown: true, estimated: false,
    })))
    assert.equal(
      billingTierOf(health.availabilityRegistry, { provider: 'x-opencode-free', modelId: 'web-search-free' }).tier,
      BILLING_TIER.FREE,
    )
  })
})

// ---------------------------------------------------------------------------
// (c) upstream billingSource=free keeps high-confidence FREE via probe cache.
// ---------------------------------------------------------------------------

test('upstream-confirmed free verdict replays with high confidence', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, [], {})
    await writeFile(join(dir, 'probe-cache.jsonl'), JSON.stringify({
      provider: 'x-opencode-free', model: 'hy4-flash-free', verdict: 'free',
      evidence: 'upstream usage cost=0 + free billing source', probedAt: BASE + 1000, cost: 0,
    }) + '\n', 'utf8')
    const result = await hydrateHealthEvidence({ dir, health })
    assert.equal(result.probe.replayed, 1)
    assert.deepEqual(
      billingTierOf(health.availabilityRegistry, { provider: 'x-opencode-free', modelId: 'hy4-flash-free' }),
      { tier: BILLING_TIER.FREE, confidence: 0.95 },
    )
  })
})

test('probe verdict unknown with cost=0 never claims free (probe.js口径)', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, [], {})
    await writeFile(join(dir, 'probe-cache.jsonl'), JSON.stringify({
      provider: 'deepseek-account', model: 'deepseek-flash', verdict: 'unknown',
      evidence: 'cost=0 without billing-source confirmation', probedAt: BASE + 1000, cost: 0,
    }) + '\n', 'utf8')
    await hydrateHealthEvidence({ dir, health })
    assert.equal(
      billingTierOf(health.availabilityRegistry, { provider: 'deepseek-account', modelId: 'deepseek-flash' }).tier,
      BILLING_TIER.UNKNOWN,
    )
  })
})

// ---------------------------------------------------------------------------
// (d) legacy rows without price_known: no free evidence, but real spend still
// counts as metered (otherwise old paid rows would be silently discarded).
// ---------------------------------------------------------------------------

test('legacy rows without price_known are not free evidence', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, rows(21, at => row({ at })))
    assert.deepEqual(
      billingTierOf(health.availabilityRegistry, { provider: 'deepseek-account', modelId: 'deepseek-flash' }),
      { tier: BILLING_TIER.UNKNOWN, confidence: 0 },
    )
    assert.equal(health.availabilityRegistry['deepseek-account::deepseek-flash'].billing.freeSamples, 0)
  })
})

test('legacy rows with positive cost still replay as METERED', async () => {
  await withTempDir(async dir => {
    const health = await hydrate(dir, [row({ at: BASE, cost: 0.001 })])
    assert.deepEqual(
      billingTierOf(health.availabilityRegistry, { provider: 'deepseek-account', modelId: 'deepseek-flash' }),
      { tier: BILLING_TIER.METERED, confidence: 0.95 },
    )
  })
})

// ---------------------------------------------------------------------------
// Optional check: savings aggregation does not manufacture a fake amount for
// no-price-table zero rows (already marked known:false / estimatedUsd:null).
// ---------------------------------------------------------------------------

test('cost-stats savings: estimated zero rows keep known:false, no fake USD', async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, 'cost.jsonl'), rows(3, at => row({
      at, priceKnown: false, estimated: true,
    })).join('\n') + '\n', 'utf8')
    const detail = readCostDetail(dir)
    const entry = detail.savings.models.find(m => m.model === 'deepseek-flash')
    assert.ok(entry, 'zero-cost row is still counted as a free call in the report')
    assert.equal(entry.estimated, true)
    assert.equal(entry.known, false)
    assert.equal(entry.estimatedUsd, null, 'never present an estimated 0 as saved money')
    const stats = readCostStats(dir)
    assert.equal(stats.estimatedCostUsd, 0)
    assert.equal(stats.freeCount, 3)
  })
})

// ---------------------------------------------------------------------------
// Regression (task W3): the account layer compared replayed evidence with a
// strict ">" while the route/probe layers used ">=". A ledger row whose
// timestamp equalled the live record's updatedAt therefore OVERWROTE live L2
// state — a cooldown silently disappeared and streaks reset during the
// fire-and-forget cold-start hydration. Ties belong to the live side.
// ---------------------------------------------------------------------------

test('same-millisecond replay never overwrites a live account record', () => {
  const live = {
    provider: 'deepseek-account', updatedAt: BASE, state: 'COOLING',
    samples: { success: 0, failure: 2 }, streak: 2,
  }
  const registry = { records: new Map([['acct-a', live]]), config: {} }
  const summary = hydrateAccountEvidence(registry, [JSON.parse(row({ at: BASE }))])

  assert.equal(summary.newerKept, 1, 'a row at the SAME millisecond must be skipped, not merged')
  assert.equal(summary.accounts, 0)
  assert.equal(registry.records.get('acct-a'), live, 'the live record object is kept, not replaced')

  // A strictly newer row still replays — the tie rule must not freeze hydration.
  const older = { provider: 'deepseek-account', updatedAt: BASE - 1 }
  const later = hydrateAccountEvidence(
    { records: new Map([['acct-a', older]]), config: {} },
    [JSON.parse(row({ at: BASE }))],
  )
  assert.equal(later.accounts, 1, 'a row newer than the live record still applies')
  assert.equal(later.newerKept, 0)

  // liveWins(): the single shared rule both layers now use.
  assert.equal(liveWins({ updatedAt: BASE }, BASE), true, 'ties go to live')
  assert.equal(liveWins({ updatedAt: BASE }, BASE + 1), false, 'a newer timestamp still wins over live')
  assert.equal(liveWins({ updatedAt: BASE }, BASE - 1), true)
  assert.equal(liveWins(undefined, BASE), false, 'no live record -> replay applies')
  assert.equal(liveWins({}, BASE), false, 'missing updatedAt -> replay applies')
  assert.equal(liveWins({ updatedAt: Number.NaN }, BASE), false, 'unknown live stamp cannot block the replay')
})

// ---------------------------------------------------------------------------
// Regression (task W3): the timeline used ts.slice(0, 10), i.e. the UTC date.
// A UTC+8 user's 00:30 call was filed under the previous day, so everything
// before 08:00 local showed up as "yesterday" on the cost chart. Day buckets
// are human-facing, so they must be LOCAL days (old rows are not migrated).
// ---------------------------------------------------------------------------

test('timeline day buckets use the local calendar day, not the UTC date', () => {
  // 2026-11-24T16:30Z is 2026-11-25 00:30 in UTC+8.
  assert.equal(localDayOf('2026-11-24T16:30:00.000Z', 480), '2026-11-25',
    'a local 00:30 call lands on the local day, not the previous UTC day')
  assert.equal(localDayOf('2026-11-24T16:30:00.000Z', 0), '2026-11-24',
    'the same instant is still 11-24 in UTC — the local offset is what decides')
  assert.equal(localDayOf('2026-11-25T00:30:00.000Z', -300), '2026-11-24',
    'west of UTC the boundary shifts the other way')
  assert.equal(localDayOf('2026-11-25'), '2026-11-25', 'a date-only row is already a day')
  assert.equal(localDayOf(''), 'unknown', 'no timestamp stays the honest unknown bucket')
  assert.equal(localDayOf('not-a-date'), 'unknown')
})

test('local 00:30 is bucketed on that same day by a real readCostDetail (TZ=Asia/Shanghai)', async () => {
  await withTempDir(async dir => {
    const at = Date.parse('2026-11-24T16:30:00.000Z') // 2026-11-25 00:30 in Shanghai
    await writeFile(join(dir, 'cost.jsonl'), row({ at }) + '\n', 'utf8')
    const moduleUrl = new URL('../lib/cost-stats.js', import.meta.url).href
    // Run the real reader under a fixed timezone; the suite itself may run in
    // any TZ, so the process is the only honest way to pin this behaviour.
    const child = join(dir, 'read-timeline.mjs')
    await writeFile(child, 'const { readCostDetail } = await import(' + JSON.stringify(moduleUrl) + ')\n'
      + 'const detail = readCostDetail(' + JSON.stringify(dir) + ')\n'
      + 'process.stdout.write(JSON.stringify(detail.timeline))\n', 'utf8')
    const res = spawnSync(process.execPath, [child], {
      encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' },
    })
    assert.equal(res.status, 0, 'timeline probe failed: ' + res.stderr)
    const timeline = JSON.parse(res.stdout)
    assert.deepEqual(timeline.map(bucket => bucket.day), ['2026-11-25'],
      'a local 00:30 call must be counted on 2026-11-25, not the UTC date 2026-11-24')
    assert.equal(timeline[0].calls, 1)
  })
})
