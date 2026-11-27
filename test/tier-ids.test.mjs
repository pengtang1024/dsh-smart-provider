/**
 * Combined virtual tier id contract (2026-11-27-combined-tier-ids.md).
 * Pure helpers + adapter wiring: 9-id cartesian product, two-segment parsing,
 * capability-derived effort mapping (never clamped/fabricated), stream
 * injection via ...options, and resolveModel first-hop capability passthrough.
 * Runs under any Node (no DSH imports beyond SmartAdapter's lazy shim).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_TIERS, EFFORT_IDS, TIER_IDS, parseTierId, composeTierId,
  tierDisplayName, supportedEfforts, mapEffort,
} from '../lib/tier-ids.js'

// ---------------------------------------------------------------------------
// 1. Pure parse / compose / display
// ---------------------------------------------------------------------------

test('catalog is the fixed 9-id cartesian product; name is free text only', () => {
  assert.deepEqual(MODEL_TIERS, ['auto', 'cost', 'balanced'])
  assert.deepEqual(EFFORT_IDS, ['off', 'medium', 'high'])
  assert.equal(TIER_IDS.length, 9)
  assert.equal(new Set(TIER_IDS).size, 9)
  for (const tier of MODEL_TIERS) {
    for (const effort of EFFORT_IDS) {
      const id = tier + '/' + effort
      assert.ok(TIER_IDS.includes(id), id + ' must be listed')
      assert.deepEqual(parseTierId(id), { tier, effort })
      assert.equal(composeTierId(tier, effort), id)
    }
  }
  assert.equal(tierDisplayName('cost', 'high'), 'Smart 省钱档 · 高强度')
  assert.deepEqual(parseTierId('auto'), { tier: 'auto', effort: undefined }, 'legacy single segment still parses')
  for (const bad of ['', null, 42, 'cost/high/extra', 'cost/low', 'fast/high', 'cost+high']) {
    assert.equal(parseTierId(bad), null, String(bad) + ' must not be guessed')
  }
})

// ---------------------------------------------------------------------------
// 2. Effort mapping: first supported wins, no clamp, no fabrication
// ---------------------------------------------------------------------------

const full = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

test('mapEffort respects per-model supported sets with ordered fallbacks', () => {
  assert.equal(mapEffort('off', full), 'off')
  assert.equal(mapEffort('medium', full), 'medium')
  assert.equal(mapEffort('high', full), 'high')
  assert.equal(mapEffort('medium', new Set(['off', 'low', 'high', 'max'])), 'low', 'DeepSeek medium -> low')
  assert.equal(mapEffort('high', new Set(['off', 'low', 'max'])), 'max', 'DeepSeek high -> max')
  assert.equal(mapEffort('off', new Set(['none'])), 'none', 'off wire sentinel fallback')

  assert.equal(mapEffort('high', new Set(['off', 'low'])), undefined, 'no clamp to a weaker effort')
  assert.equal(mapEffort('medium', new Set()), undefined, 'unknown support -> no fabrication')
})

test('supportedEfforts reads ONLY the cached routes first hop; no cache = empty', () => {
  const routes = [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: ['off', 'low', 'high'] } }] }]
  assert.deepEqual([...supportedEfforts(routes, [{ provider: 'p', model: 'm' }])], ['off', 'low', 'high'])
  assert.equal(supportedEfforts(routes, [{ provider: 'p', model: 'other' }]).size, 0)
  assert.equal(supportedEfforts([], [{ provider: 'p', model: 'm' }]).size, 0)
  assert.equal(supportedEfforts(routes, []).size, 0)
})
