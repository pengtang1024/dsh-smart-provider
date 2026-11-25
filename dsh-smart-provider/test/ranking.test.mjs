/**
 * Unit tests for lib/ranking.js — 账号池择优设计.md §9 acceptance list.
 * Run: ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/ranking.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RANKING_STRATEGIES, RANKING_CONFIG_SCHEMA, ACCOUNT_RANKING_FIELDS,
  PRICE_FIELD_REGISTRY, DEFAULT_TOKEN_MIX, DEFAULT_RANKING_CONFIG,
  normalizeRankingConfig, normalizeAccountRanking, resolveEffectivePrice,
  estimateTypicalCost, scoreAccounts, explainScore, rankAccountsForHop,
  resolveWeights,
} from '../lib/ranking.js'

// task-2 (pricing2) changed lib/pricing.js: with no user table the module now
// answers coarse tier estimates instead of the historical author prices. The
// two tests below assert the table/fallback RESOLUTION BRANCHES of
// resolveEffectivePrice, so this suite pins the explicit author export
// (lib/pricing.example.json) BEFORE any price lookup runs — pricing.js
// memoizes its index on first use, and ranking.js binds priceFor statically,
// so the env must be set before the first resolveEffectivePrice call in this
// process. Assertions themselves are unchanged from the pre-task-2 suite.
process.env.DSH_SMART_PRICING_FILE = new URL('../lib/pricing.example.json', import.meta.url).pathname

function account(id, extra = {}) {
  // `provider` is a base field, not a ranking field: keep it out of the
  // ranking normalizer so route-layer tests see the intended provider.
  const { provider = 'p', ...rankingFields } = extra
  return {
    id,
    provider,
    models: ['m1'],
    ...normalizeAccountRanking(rankingFields),
  }
}

function enabled(strategy, overrides = {}) {
  return normalizeRankingConfig({ enabled: true, strategy, ...overrides })
}

// ---------------------------------------------------------------------------
// §9.7 metadata is pure JSON
// ---------------------------------------------------------------------------

test('metadata schemas are JSON-serializable and contain no function values', () => {
  for (const value of [RANKING_CONFIG_SCHEMA, ACCOUNT_RANKING_FIELDS, PRICE_FIELD_REGISTRY, DEFAULT_TOKEN_MIX, DEFAULT_RANKING_CONFIG]) {
    const json = JSON.stringify(value)
    assert.ok(json.length > 0)
    assert.deepEqual(JSON.parse(json), value)
  }
  assert.deepEqual(RANKING_STRATEGIES.map(s => s.id), [
    'legacy', 'balanced', 'cost-first', 'speed-first', 'tier-first', 'custom',
  ])
})

// ---------------------------------------------------------------------------
// §8 resolveWeights
// ---------------------------------------------------------------------------

test('resolveWeights normalizes presets and custom weights to sum 1', () => {
  for (const id of ['balanced', 'cost-first', 'speed-first', 'tier-first']) {
    const w = resolveWeights(id)
    assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, id)
  }
  const custom = resolveWeights('custom', { cost: 7, speed: 2, tier: 1, load: 0 })
  assert.ok(Math.abs(custom.cost - 0.7) < 1e-9)
  assert.equal(custom.load, 0)
})

// ---------------------------------------------------------------------------
// §9.2 / §4.4 preset scoring produces different first choices
// ---------------------------------------------------------------------------

const CANDIDATES = [
  account('A', { tier: 'premium', speedTier: 'fast', priceTier: 'high', weight: 1 }),
  account('B', { tier: 'standard', speedTier: 'normal', priceTier: 'mid', weight: 1 }),
  account('C', { tier: 'backup', speedTier: 'slow', priceTier: 'low', weight: 1 }),
]

test('scoreAccounts: cost-first prefers cheap backup, speed/tier-first prefers premium fast', () => {
  const ctx = { domain: CANDIDATES, usage: new Map() }
  const costFirst = scoreAccounts(CANDIDATES, 'm1', enabled('cost-first'), ctx)
    .sort((a, b) => b.score - a.score)
  const speedFirst = scoreAccounts(CANDIDATES, 'm1', enabled('speed-first'), ctx)
    .sort((a, b) => b.score - a.score)
  const tierFirst = scoreAccounts(CANDIDATES, 'm1', enabled('tier-first'), ctx)
    .sort((a, b) => b.score - a.score)
  assert.equal(costFirst[0].account.id, 'C')
  assert.equal(speedFirst[0].account.id, 'A')
  assert.equal(tierFirst[0].account.id, 'A')
})

// ---------------------------------------------------------------------------
// §9.1 / §6 backward compatibility
// ---------------------------------------------------------------------------

test('rankAccountsForHop legacy path matches the old comparator exactly', () => {
  const a = account('a', { provider: 'opencode-go' })
  const b = account('b', { provider: 'opencode-go-alt' })
  const usage = new Map([['b', 0], ['a', 5]])
  const ranked = rankAccountsForHop([a, b], [a, b], 'm1', { provider: 'opencode-go' }, enabled('legacy'), { usage })
  // route preferred first (a), even though a has higher usage.
  assert.deepEqual(ranked.map(x => x.id), ['a', 'b'])
})

test('disabled ranking returns neutral explanation', () => {
  const exp = explainScore(account('x'), 'm1', normalizeRankingConfig({ enabled: false }), {})
  assert.equal(exp.score, null)
  assert.ok(exp.why[0].includes('未启用'))
})

// ---------------------------------------------------------------------------
// §9.3 resolveEffectivePrice priority chain
// ---------------------------------------------------------------------------

test('resolveEffectivePrice: per-model override > global override > table > fallback > tier-proxy', () => {
  const base = { provider: 'p', models: ['m1'] }
  // per-model override
  assert.equal(resolveEffectivePrice({ ...base, ranking: { priceOverrides: { m1: { input: 0.5 } } } }, 'm1', 'input').source, 'override')
  assert.equal(resolveEffectivePrice({ ...base, ranking: { priceOverrides: { m1: { input: 0.5 } } } }, 'm1', 'input').usdPerToken, 0.5)
  // global override
  assert.equal(resolveEffectivePrice({ ...base, ranking: { priceOverrides: { output: 0.7 } } }, 'm1', 'output').source, 'override')
  // table lookup (xiaomi/mimo-v2.6-flash exists in pricing.json)
  const t = resolveEffectivePrice({ provider: 'xiaomi' }, 'mimo-v2.6-flash', 'input')
  assert.ok(t.usdPerToken > 0)
  assert.ok(['table', 'fallback'].includes(t.source))
  // tier-proxy when no table data
  const proxy = resolveEffectivePrice({ ...base, ranking: { priceTier: 'low' } }, 'no-such-model-xyz', 'input')
  assert.equal(proxy.source, 'tier-proxy')
  assert.equal(proxy.known, false)
  // neutral when no tier either
  const neutral = resolveEffectivePrice({ ...base }, 'no-such-model-xyz', 'input')
  assert.equal(neutral.usdPerToken, 0)
  assert.equal(neutral.source, 'neutral')
})

test('cacheRead:null falls back to input (via priceFor path fallback)', () => {
  // opencode-go/gpt-5.6-luna has cacheWrite:null in pricing.json; our registry
  // maps cacheWrite fallback -> input, so a positive price must resolve.
  const r = resolveEffectivePrice({ provider: 'opencode-go' }, 'gpt-5.6-luna', 'cacheWrite')
  assert.ok(r.usdPerToken > 0)
  assert.ok(['table', 'fallback'].includes(r.source))
})

// ---------------------------------------------------------------------------
// §9.4 subscription / free cost models
// ---------------------------------------------------------------------------

test('subscription quotaCost and free costModel drive effective cost', () => {
  const sub = account('sub', { costModel: 'subscription', quotaCost: 0.35 })
  assert.equal(estimateTypicalCost(sub, 'm1', enabled('balanced')).usdPerTypicalToken, 0.35)
  // out-of-range quotaCost clamps to [0,1]
  const sub2 = account('sub2', { costModel: 'subscription', quotaCost: 5 })
  assert.equal(estimateTypicalCost(sub2, 'm1', enabled('balanced')).usdPerTypicalToken, 1)
  const free = account('free', { costModel: 'free' })
  assert.equal(estimateTypicalCost(free, 'm1', enabled('balanced')).usdPerTypicalToken, 0)
  const freeScored = scoreAccounts([free], 'm1', enabled('cost-first'), { domain: [free], usage: new Map() })
  assert.equal(freeScored[0].factors.cost, 1)
})

// ---------------------------------------------------------------------------
// §9.5 tierDirection / respectHopRoute / priorityMode
// ---------------------------------------------------------------------------

test('tierDirection low reverses tier preference', () => {
  const premium = account('premium', { tier: 'premium' })
  const backup = account('backup', { tier: 'backup' })
  const ctx = { domain: [premium, backup], usage: new Map() }
  const high = scoreAccounts([premium, backup], 'm1', enabled('tier-first', { tierDirection: 'high' }), ctx)
  const low = scoreAccounts([premium, backup], 'm1', enabled('tier-first', { tierDirection: 'low' }), ctx)
  assert.ok(high.find(x => x.account.id === 'premium').factors.tier > high.find(x => x.account.id === 'backup').factors.tier)
  assert.ok(low.find(x => x.account.id === 'premium').factors.tier < low.find(x => x.account.id === 'backup').factors.tier)
})

test('respectHopRoute false removes the route hard layer', () => {
  const same = account('same', { provider: 'p', tier: 'backup', speedTier: 'slow', priceTier: 'low' })
  const cross = account('cross', { provider: 'q', tier: 'premium', speedTier: 'fast', priceTier: 'high' })
  const cfgOn = enabled('speed-first', { respectHopRoute: true })
  const cfgOff = enabled('speed-first', { respectHopRoute: false })
  const ctx = { domain: [same, cross], usage: new Map() }
  const withRoute = rankAccountsForHop([same, cross], [same, cross], 'm1', { provider: 'p' }, cfgOn, ctx)
  const withoutRoute = rankAccountsForHop([same, cross], [same, cross], 'm1', { provider: 'p' }, cfgOff, ctx)
  assert.equal(withRoute[0].id, 'same')
  assert.equal(withoutRoute[0].id, 'cross')
})

test('priorityMode hard layers priority; soft only tiebreaks', () => {
  const p0 = account('p0', { priority: 0, tier: 'backup', speedTier: 'slow' })
  const p1 = account('p1', { priority: 1, tier: 'premium', speedTier: 'fast' })
  const hard = rankAccountsForHop([p0, p1], [p0, p1], 'm1', { provider: 'p' }, enabled('speed-first', { priorityMode: 'hard' }), { domain: [p0, p1], usage: new Map() })
  assert.equal(hard[0].id, 'p0')
  // soft: p1 wins on score (fast+premium)
  const soft = rankAccountsForHop([p0, p1], [p0, p1], 'm1', { provider: 'p' }, enabled('speed-first', { priorityMode: 'soft' }), { domain: [p0, p1], usage: new Map() })
  assert.equal(soft[0].id, 'p1')
})

// ---------------------------------------------------------------------------
// §9.6 invalid fields fall back without dropping the account
// ---------------------------------------------------------------------------

test('normalizeAccountRanking clamps invalid values and never drops the account', () => {
  const n = normalizeAccountRanking({
    tier: 'garbage', speedTier: 'turbo', priceTier: 'ultra', costModel: 'whatever',
    quotaCost: -3, priceMultiplier: -5, priority: 'x', weight: -1,
    priceOverrides: { input: -2, m1: { output: 1e-7 }, junk: 5 },
  })
  assert.equal(n.tier, 'standard')
  assert.equal(n.speedTier, 'normal')
  assert.equal(n.priceTier, 'mid')
  assert.equal(n.costModel, 'metered')
  assert.equal(n.quotaCost, 0)       // quotaCost is [0,1] -> out-of-range clamps
  assert.equal(n.priceMultiplier, 1) // other invalid values fall back to DEFAULT
  assert.equal(n.priority, 0)
  assert.equal(n.weight, 1)
  assert.deepEqual(n.priceOverrides, { m1: { output: 1e-7 } })
})

test('normalizeRankingConfig clamps negative weights and bogus enums', () => {
  const n = normalizeRankingConfig({
    enabled: 1, strategy: 'bogus', tierDirection: 'sideways', respectHopRoute: 0,
    priorityMode: 'chaos', weights: { cost: -1, speed: 'x', tier: 2, load: null },
    tokenMix: { input: -1 }, historical: { window: -5, mixWeight: 9 },
  })
  assert.equal(n.enabled, false)
  assert.equal(n.strategy, 'balanced')
  assert.equal(n.tierDirection, 'high')
  assert.equal(n.respectHopRoute, true)
  assert.equal(n.priorityMode, 'hard')
  assert.equal(n.weights.cost, 0)
  assert.equal(n.weights.tier, 2)
  assert.equal(n.tokenMix.input, 10)
  assert.equal(n.historical.window, 1)
  assert.equal(n.historical.mixWeight, 1)
})

// ---------------------------------------------------------------------------
// explainScore shape
// ---------------------------------------------------------------------------

test('explainScore returns score/factors/contributions/why with Chinese sentences', () => {
  const a = account('a', { tier: 'premium', speedTier: 'fast', priority: 2 })
  const exp = explainScore(a, 'm1', enabled('balanced'), { domain: [a], usage: new Map(), hop: { provider: 'p' } })
  assert.equal(typeof exp.score, 'number')
  assert.ok(exp.factors && exp.contributions)
  assert.ok(exp.why.some(s => /等级/.test(s)))
  assert.ok(exp.why.some(s => /优先级/.test(s)))
  assert.ok(exp.why.some(s => /路由/.test(s)))
})
