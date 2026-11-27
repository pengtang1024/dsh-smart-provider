/**
 * Virtual model / effort contract (SPEC-2026-11-27-smart-provider.md).
 * 4 models x 6 efforts = 24 combined ids; locale-keyed zh/en names; defaults
 * smart + auto; auto effort is a soft bias combined with task classification
 * and supported efforts (never a model->effort dead map); manual wins.
 * Runs under any Node (no DSH imports).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_TIERS, EFFORT_IDS, MANUAL_EFFORT_IDS, TIER_IDS,
  TIER_NAME_KEYS, EFFORT_NAME_KEYS, DEFAULT_MODEL_TIER, DEFAULT_EFFORT,
  DEFAULT_TIER_ID, parseTierId, composeTierId, migrateTierId,
  tierName, effortName, tierDisplayName, supportedEfforts,
  mapEffort, autoEffortScores, rankAutoEfforts, resolveAutoEffort, resolveEffort,
} from '../lib/tier-ids.js'

// ---------------------------------------------------------------------------
// 1. Catalog shape, defaults and id grammar
// ---------------------------------------------------------------------------

test('catalog is the fixed 4-model x 6-effort product (24 ids) with smart/auto default', () => {
  assert.deepEqual(MODEL_TIERS, ['balanced', 'cost', 'speed', 'smart'])
  assert.deepEqual(EFFORT_IDS, ['auto', 'off', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(MANUAL_EFFORT_IDS, ['off', 'low', 'medium', 'high', 'max'])
  assert.equal(TIER_IDS.length, 24)
  assert.equal(new Set(TIER_IDS).size, 24)
  assert.equal(DEFAULT_MODEL_TIER, 'smart')
  assert.equal(DEFAULT_EFFORT, 'auto')
  assert.equal(DEFAULT_TIER_ID, 'smart/auto')
  for (const tier of MODEL_TIERS) {
    for (const effort of EFFORT_IDS) {
      const id = tier + '/' + effort
      assert.ok(TIER_IDS.includes(id), id + ' must be listed')
      assert.deepEqual(parseTierId(id), { tier, effort })
      assert.equal(composeTierId(tier, effort), id)
    }
  }
  assert.equal(composeTierId('smart'), 'smart/auto', 'compose applies the default effort')
})

test('parse accepts auto effort, single segments and legacy auto model; rejects guesses', () => {
  assert.deepEqual(parseTierId('smart/auto'), { tier: 'smart', effort: 'auto' })
  assert.deepEqual(parseTierId('speed/max'), { tier: 'speed', effort: 'max' })
  assert.deepEqual(parseTierId('balanced'), { tier: 'balanced', effort: undefined })
  assert.deepEqual(parseTierId('auto'), { tier: 'smart', effort: undefined }, 'legacy 智能档 single id')
  assert.deepEqual(parseTierId('auto/high'), { tier: 'smart', effort: 'high' }, 'legacy 智能档 combo id')
  assert.equal(migrateTierId('auto/high'), 'smart/high')
  assert.equal(migrateTierId('cost/low'), 'cost/low', 'unchanged legacy model id')
  for (const bad of ['', null, 42, 'smart/high/extra', 'smart/minimal',
    'fast/high', 'smart+high', 'auto/auto-extra']) {
    assert.equal(parseTierId(bad), null, String(bad) + ' must not be guessed')
  }
})

// ---------------------------------------------------------------------------
// 2. i18n: locale-keyed name tables, no hardcoded free text
// ---------------------------------------------------------------------------

test('model and effort names are locale keys returning zh/en text, with en fallbacks', () => {
  assert.deepEqual(TIER_NAME_KEYS, {
    balanced: 'virtualModel.balanced', cost: 'virtualModel.cost',
    speed: 'virtualModel.speed', smart: 'virtualModel.smart',
  })
  assert.deepEqual(EFFORT_NAME_KEYS, {
    auto: 'virtualEffort.auto', off: 'virtualEffort.off', low: 'virtualEffort.low',
    medium: 'virtualEffort.medium', high: 'virtualEffort.high', max: 'virtualEffort.max',
  })
  assert.equal(tierName('smart', 'zh'), '智能')
  assert.equal(tierName('smart', 'en'), 'Smart')
  assert.equal(tierName('cost', 'zh'), '省钱')
  assert.equal(tierName('cost', 'en'), 'Economy')
  assert.equal(effortName('auto', 'zh'), '自动')
  assert.equal(effortName('auto', 'en'), 'Auto')
  assert.equal(effortName('max', 'zh'), '极高')
  assert.equal(effortName('max', 'en'), 'Max')
  assert.equal(tierDisplayName('cost', 'high', 'zh'), '省钱 · 高')
  assert.equal(tierDisplayName('cost', 'high', 'en'), 'Economy · High')
  assert.equal(tierDisplayName('smart', 'auto', 'zh'), '智能 · 自动')
  assert.equal(tierDisplayName('smart', 'auto', 'en'), 'Smart · Auto')
  assert.equal(tierDisplayName('smart', undefined, 'zh'), '智能', 'no effort -> model name only')
  assert.equal(tierName('smart', 'de'), 'Smart', 'missing locale falls back to en')
  assert.equal(effortName('ghost', 'zh'), 'ghost', 'unknown id falls back to raw id')
})

// ---------------------------------------------------------------------------
// 3. Effort mapping: first supported wins, no clamp, no fabrication
// ---------------------------------------------------------------------------

const full = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

test('mapEffort respects ordered fallbacks, never clamps or fabricates', () => {
  assert.equal(mapEffort('off', full), 'off')
  assert.equal(mapEffort('low', full), 'low')
  assert.equal(mapEffort('medium', full), 'medium')
  assert.equal(mapEffort('high', full), 'high')
  assert.equal(mapEffort('max', full), 'max')
  assert.equal(mapEffort('medium', new Set(['off', 'low', 'high', 'max'])), 'low', 'medium -> low')
  assert.equal(mapEffort('high', new Set(['off', 'low', 'max'])), 'max', 'high -> max')
  assert.equal(mapEffort('off', new Set(['none'])), 'none', 'off wire sentinel fallback')
  assert.equal(mapEffort('high', new Set(['off', 'low'])), undefined, 'no clamp to a weaker effort')
  assert.equal(mapEffort('max', new Set(['off'])), undefined, 'no clamp to a weaker effort')
  assert.equal(mapEffort('medium', new Set()), undefined, 'unknown support -> no fabrication')
  assert.equal(mapEffort('auto', full), undefined, 'auto is resolved, never mapped here')
})

test('supportedEfforts reads ONLY the cached routes first hop; no cache = empty', () => {
  const routes = [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: ['off', 'low', 'high'] } }] }]
  assert.deepEqual([...supportedEfforts(routes, [{ provider: 'p', model: 'm' }])], ['off', 'low', 'high'])
  assert.equal(supportedEfforts(routes, [{ provider: 'p', model: 'other' }]).size, 0)
  assert.equal(supportedEfforts([], [{ provider: 'p', model: 'm' }]).size, 0)
  assert.equal(supportedEfforts(routes, []).size, 0)
})

// ---------------------------------------------------------------------------
// 4. auto is a SOFT bias: task content + supported efforts always participate
// ---------------------------------------------------------------------------

test('auto preference is biased by the model but overridden by the task', () => {
  const general = { kind: 'general', secondary: [], signals: [] }
  const reasoning = { kind: 'reasoning', secondary: ['longctx'], signals: ['reasoningEffort'] }
  const thrifty = { kind: 'thrifty', secondary: [], signals: ['purpose'] }

  // Same task, different models -> different leaning (a bias, not one fixed map).
  assert.equal(rankAutoEfforts({ tier: 'smart', task: general })[0], 'high', 'smart leans high')
  assert.equal(rankAutoEfforts({ tier: 'cost', task: general })[0], 'off', 'cost leans off')
  assert.equal(rankAutoEfforts({ tier: 'balanced', task: general })[0], 'medium', 'balanced leans medium')
  assert.equal(rankAutoEfforts({ tier: 'speed', task: general })[0], 'low', 'speed leans low')

  // Same model, different tasks -> different decision: classifyTask still rules.
  assert.equal(resolveAutoEffort({ tier: 'smart', task: general, supported: full }), 'high')
  assert.equal(resolveAutoEffort({ tier: 'smart', task: thrifty, supported: full }), 'off',
    'thrifty task overrides smart high-bias')
  assert.equal(resolveAutoEffort({ tier: 'cost', task: reasoning, supported: full }), 'high',
    'reasoning task overrides cost low-bias')
  assert.equal(resolveAutoEffort({ tier: 'smart', task: reasoning, supported: full }), 'high')

  // Unknown model gets a neutral bias, so the task alone decides.
  const scores = autoEffortScores({ tier: 'unknown', task: reasoning })
  assert.equal(scores.high, 3, 'no hidden model bias for unknown tier')

  // Capability support always participates; no support -> no fabrication.
  assert.equal(resolveAutoEffort({ tier: 'smart', task: reasoning, supported: new Set(['off', 'low']) }), 'low')
  assert.equal(resolveAutoEffort({ tier: 'smart', task: reasoning, supported: new Set() }), undefined)
})

test('manual effort always overrides auto, including unsupported manual values', () => {
  const reasoning = { kind: 'reasoning', secondary: [], signals: [] }
  assert.equal(resolveEffort({ tier: 'smart', effort: 'low', task: reasoning, supported: full }), 'low',
    'manual low beats reasoning auto bias')
  assert.equal(resolveEffort({ tier: 'cost', effort: 'max', task: { kind: 'thrifty' }, supported: full }), 'max',
    'manual max beats cost/thrifty bias')
  assert.equal(resolveEffort({ tier: 'smart', effort: 'auto', task: { kind: 'thrifty' }, supported: full }), 'off',
    'explicit auto still follows the task')
  assert.equal(resolveEffort({ tier: 'smart', task: generalTask(), supported: full }), 'high',
    'missing effort defaults to auto')
  assert.equal(resolveEffort({ tier: 'smart', effort: 'low', task: reasoning, supported: new Set(['off']) }), undefined,
    'manual unsupported is honest, never silently falls back to auto')
})

function generalTask() { return { kind: 'general', secondary: [], signals: ['default:general'] } }
