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

import { BILLING_TIER, billingTierOf, healthOf, HEALTH } from '../lib/availability.js'
import { buildHealthDeps } from '../lib/health-setup.js'
import { hydrateHealthEvidence } from '../lib/health-persistence.js'
import { readCostDetail, readCostStats } from '../lib/cost-stats.js'

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
