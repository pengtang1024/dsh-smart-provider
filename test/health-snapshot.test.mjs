/**
 * Regression tests for lib/health-snapshot.js — the pure builder behind
 * SmartProviderRemote.accountHealth().
 *
 * Plain node is enough (no DSH import, no I/O, no network):
 *   node --test test/health-snapshot.test.mjs
 *
 * The honesty rules from 可用性自动管理设计.md / 账号池自动管理深化设计.md are
 * asserted directly: zero samples => UNKNOWN (never "unavailable"), a read path
 * never writes the registry, the effective cooldown is the MAX of both layers,
 * and malformed input degrades to an empty snapshot instead of throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHealthSnapshot, deriveState, mergeCooldown, projectAccount,
} from '../lib/health-snapshot.js'
import {
  ACCOUNT_STATES, createAccountHealthRegistry, noteFailure,
} from '../lib/account-health.js'
import { updateHealth } from '../lib/availability.js'

const NOW = 1_700_000_000_000
const MINUTE = 60 * 1000

/** A registry with one cooling account (shape written by account-health). */
function coolingRegistry(accountId, until, reason = 'QUOTA', streak = 1) {
  const registry = createAccountHealthRegistry()
  registry.records.set(accountId, {
    accountId,
    state: ACCOUNT_STATES.COOLING,
    until,
    reason,
    streak,
    samples: { success: 2, failure: 1 },
    halfOpenPermits: 1,
    lastSuccessAt: NOW - 10 * MINUTE,
    lastFailureAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
  })
  return registry
}

test('1. empty input -> enabled:false, empty arrays, numeric generatedAt', () => {
  const snapshot = buildHealthSnapshot()
  assert.deepEqual(snapshot, { enabled: false, generatedAt: snapshot.generatedAt, accounts: [], routes: [] })
  assert.equal(typeof snapshot.generatedAt, 'number')
  assert.ok(Number.isFinite(snapshot.generatedAt))

  // An explicit now is passed through verbatim (deterministic snapshots).
  assert.equal(buildHealthSnapshot({ now: NOW }).generatedAt, NOW)
  // Garbage instead of an input object is still a snapshot, never a throw.
  assert.deepEqual(buildHealthSnapshot('nonsense').accounts, [])
  assert.equal(buildHealthSnapshot(null).enabled, false)
})

test('2. enabled is passed through untouched', () => {
  assert.equal(buildHealthSnapshot({ enabled: true, now: NOW }).enabled, true)
  assert.equal(buildHealthSnapshot({ enabled: false, now: NOW }).enabled, false)
  // Only a real boolean true enables it; truthy strings must not fake it.
  assert.equal(buildHealthSnapshot({ enabled: 'yes', now: NOW }).enabled, false)
})

test('3. cooling record with a future until keeps COOLING + remainingMs/reason/streak', () => {
  const until = NOW + 5 * MINUTE
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a', models: ['model-x'], implicit: false }],
    accountHealth: coolingRegistry('acct-1', until),
  })
  assert.equal(snapshot.accounts.length, 1)
  const row = snapshot.accounts[0]
  assert.equal(row.id, 'acct-1')
  assert.equal(row.provider, 'route-a')
  assert.equal(row.implicit, false)
  assert.deepEqual(row.models, ['model-x'])
  assert.equal(row.state, 'COOLING')
  assert.equal(row.until, until)
  assert.equal(row.remainingMs, 5 * MINUTE)
  assert.equal(row.reason, 'QUOTA')
  assert.equal(row.streak, 1)
  assert.deepEqual(row.samples, { success: 2, failure: 1 })
  assert.equal(row.lastSuccessAt, NOW - 10 * MINUTE)
  assert.equal(row.lastFailureAt, NOW - MINUTE)
})

test('4. elapsed cooling derives HALF_OPEN read-only (registry record untouched)', () => {
  const registry = coolingRegistry('acct-1', NOW - MINUTE)
  const record = registry.records.get('acct-1')
  const before = JSON.stringify(record)

  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    accountHealth: registry,
  })

  const row = snapshot.accounts[0]
  assert.equal(row.state, 'HALF_OPEN', 'expired cooling is re-derived, not re-read')
  assert.equal(row.until, null, 'an expired cooldown has no effective until')
  assert.equal(row.remainingMs, 0)
  // The whole point: stateOf() would have written COOLING->HALF_OPEN back into
  // the registry. The read path must leave the record byte-identical.
  assert.equal(registry.records.get('acct-1'), record, 'same object identity')
  assert.equal(JSON.stringify(registry.records.get('acct-1')), before, 'record not mutated')
  assert.equal(registry.records.get('acct-1').state, 'COOLING')
})

test('5. legacy cooldown later than record.until -> until is the MAX of both', () => {
  const recordUntil = NOW + 2 * MINUTE
  const legacyUntil = NOW + 9 * MINUTE
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    accountHealth: coolingRegistry('acct-1', recordUntil),
    cooldowns: new Map([['acct-1', { until: legacyUntil, reason: 'RATE_LIMIT' }]]),
  })
  const row = snapshot.accounts[0]
  assert.equal(row.state, 'COOLING')
  assert.equal(row.until, legacyUntil, 'both layers block dispatch, so the later one wins')
  assert.equal(row.remainingMs, 9 * MINUTE)
  // The record reason still wins while the derived state is COOLING.
  assert.equal(row.reason, 'QUOTA')

  // Symmetry: a later record.until wins over an earlier legacy cooldown.
  const flipped = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    accountHealth: coolingRegistry('acct-1', NOW + 20 * MINUTE),
    cooldowns: new Map([['acct-1', { until: NOW + MINUTE, reason: 'RATE_LIMIT' }]]),
  })
  assert.equal(flipped.accounts[0].until, NOW + 20 * MINUTE)
})

test('6. legacy cooldown alone (no accountHealth) still reports COOLING', () => {
  const until = NOW + 3 * MINUTE
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    cooldowns: new Map([['acct-1', { until, reason: 'AUTH' }]]),
  })
  const row = snapshot.accounts[0]
  assert.equal(row.state, 'COOLING', 'dispatch really is blocked, so the UI must agree')
  assert.equal(row.until, until)
  assert.equal(row.reason, 'AUTH')
  assert.equal(row.streak, 0, 'no account-health record means no streak evidence')
  assert.deepEqual(row.samples, { success: 0, failure: 0 })

  // An expired legacy cooldown blocks nothing -> back to UNKNOWN.
  const expired = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    cooldowns: new Map([['acct-1', { until: NOW - MINUTE, reason: 'AUTH' }]]),
  })
  assert.equal(expired.accounts[0].state, 'UNKNOWN')
  assert.equal(expired.accounts[0].until, null)
  assert.equal(expired.accounts[0].remainingMs, 0)
})

test('7. usage comes from the pool counter, defaulting to 0', () => {
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [
      { id: 'acct-1', provider: 'route-a' },
      { id: 'acct-2', provider: 'route-a' },
      { id: 'acct-3', provider: 'route-a' },
    ],
    usage: new Map([['acct-1', 7], ['acct-2', 0]]),
  })
  const byId = new Map(snapshot.accounts.map(row => [row.id, row]))
  assert.equal(byId.get('acct-1').usage, 7)
  assert.equal(byId.get('acct-2').usage, 0)
  assert.equal(byId.get('acct-3').usage, 0, 'an unknown account has no fabricated usage')
})

test('8. routes skip isVirtual entries (§6.2 hard isolation)', () => {
  const registry = {}
  registry['route-a::model-x'] = updateHealth(registry, {
    provider: 'route-a', modelId: 'model-x', ok: true, timestamp: NOW,
  })
  registry['smart::model-x'] = updateHealth({}, {
    provider: 'smart', modelId: 'model-x', isVirtual: true, ok: true, timestamp: NOW,
  })

  const snapshot = buildHealthSnapshot({ enabled: true, now: NOW, availabilityRegistry: registry })
  assert.deepEqual(
    snapshot.routes.map(row => row.provider + '::' + row.modelId),
    ['route-a::model-x'],
  )
  assert.ok(snapshot.routes.every(row => row.provider !== 'smart'))
})

test('9. routes are sorted by provider::modelId and missing fields stay honest', () => {
  const registry = {
    'zeta::m2': updateHealth({}, { provider: 'zeta', modelId: 'm2', ok: true, timestamp: NOW }),
    'alpha::m2': updateHealth({}, { provider: 'alpha', modelId: 'm2', ok: true, timestamp: NOW }),
    'alpha::m1': updateHealth({}, { provider: 'alpha', modelId: 'm1', ok: true, timestamp: NOW }),
    // Bare minimum record: every optional field absent.
    'beta::m1': { key: { provider: 'beta', modelId: 'm1' } },
    // Junk that must never reach the wire.
    'broken::x': 'not-a-record',
    'nokey::y': { health: 'HEALTHY' },
  }
  const snapshot = buildHealthSnapshot({ enabled: true, now: NOW, availabilityRegistry: registry })

  assert.deepEqual(
    snapshot.routes.map(row => row.provider + '::' + row.modelId),
    ['alpha::m1', 'alpha::m2', 'beta::m1', 'zeta::m2'],
  )
  const bare = snapshot.routes.find(row => row.provider === 'beta')
  assert.equal(bare.health, 'UNKNOWN', 'no evidence is UNKNOWN, never HEALTHY')
  assert.equal(bare.tier, 'unknown')
  assert.equal(bare.confidence, 0)
  assert.deepEqual(bare.samples, { success: 0, failure: 0 })
  assert.equal(bare.lastSuccessAt, null)
  assert.equal(bare.lastFailureAt, null)

  // A real success carries its evidence through.
  const alpha = snapshot.routes.find(row => row.provider === 'alpha' && row.modelId === 'm1')
  assert.equal(alpha.health, 'HEALTHY')
  assert.deepEqual(alpha.samples, { success: 1, failure: 0 })
  assert.equal(alpha.lastSuccessAt, NOW)
  assert.equal(alpha.lastFailureAt, null)
})

test('10. malformed input never throws and never invents data', () => {
  const junkInputs = [
    undefined,
    null,
    'string',
    42,
    [],
    {},
    { accounts: 'nope', cooldowns: 'nope', usage: 'nope', accountHealth: 'nope' },
    { accounts: [null, undefined, 7, 'x', [], { noId: true }, { id: '' }] },
    { accounts: [{ id: 'acct-1', provider: 42, models: 'nope' }] },
    {
      accounts: [{ id: 'acct-1', provider: 'route-a' }],
      accountHealth: { records: 'not-a-map' },
      cooldowns: new Map([['acct-1', null]]),
      usage: new Map([['acct-1', 'lots']]),
      availabilityRegistry: { 'route-a::model-x': null },
    },
    { availabilityRegistry: 'nope' },
    { availabilityRegistry: { a: { key: { provider: 1, modelId: 2 } } } },
  ]

  for (const input of junkInputs) {
    let snapshot
    assert.doesNotThrow(() => { snapshot = buildHealthSnapshot(input) }, JSON.stringify(input))
    assert.equal(typeof snapshot.generatedAt, 'number')
    assert.ok(Array.isArray(snapshot.accounts))
    assert.ok(Array.isArray(snapshot.routes))
  }

  // Malformed account fields degrade to the contract's empty values.
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 42, models: 'nope' }],
    accountHealth: { records: 'not-a-map' },
    cooldowns: new Map([['acct-1', null]]),
    usage: new Map([['acct-1', 'lots']]),
  })
  assert.deepEqual(snapshot.accounts, [{
    id: 'acct-1', provider: '', implicit: false, models: [],
    state: 'UNKNOWN', reason: null, until: null, remainingMs: 0,
    streak: 0, samples: { success: 0, failure: 0 }, usage: 0,
    lastSuccessAt: null, lastFailureAt: null,
  }])
})

test('11. accounts are sorted by id and the input is not mutated', () => {
  const accounts = [
    { id: 'zeta', provider: 'route-z' },
    { id: 'alpha', provider: 'route-a' },
    { id: 'mike', provider: 'route-m' },
  ]
  const cooldowns = new Map([['zeta', { until: NOW + MINUTE, reason: 'QUOTA' }]])
  const usage = new Map([['alpha', 3]])
  const snapshot = buildHealthSnapshot({ enabled: true, now: NOW, accounts, cooldowns, usage })

  assert.deepEqual(snapshot.accounts.map(row => row.id), ['alpha', 'mike', 'zeta'])
  // Input containers are read-only: order and contents survive the call.
  assert.deepEqual(accounts.map(account => account.id), ['zeta', 'alpha', 'mike'])
  assert.deepEqual([...cooldowns.keys()], ['zeta'])
  assert.deepEqual([...usage.entries()], [['alpha', 3]])
  // Returned rows are fresh objects, not the caller's descriptors.
  assert.notEqual(snapshot.accounts[0], accounts[1])
})

test('12. a real account-health failure record is reported faithfully', () => {
  const registry = createAccountHealthRegistry()
  const record = noteFailure(registry, 'acct-1', 'QUOTA', NOW)
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: [{ id: 'acct-1', provider: 'route-a' }],
    accountHealth: registry,
  })
  const row = snapshot.accounts[0]
  assert.equal(row.state, 'COOLING')
  assert.equal(row.reason, 'QUOTA')
  assert.equal(row.streak, 1)
  assert.equal(row.until, record.until)
  assert.equal(row.remainingMs, record.until - NOW)
  assert.deepEqual(row.samples, { success: 0, failure: 1 })
})

test('13. a bare Map works as the account-health registry (documented tolerance)', () => {
  const records = new Map([['acct-1', {
    state: 'ACTIVE', streak: 0, samples: { success: 4, failure: 0 },
    lastSuccessAt: NOW - MINUTE,
  }]])
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now: NOW,
    accounts: new Map([['acct-1', { id: 'acct-1', provider: 'route-a', implicit: true }]]),
    accountHealth: records,
  })
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].state, 'ACTIVE')
  assert.equal(snapshot.accounts[0].implicit, true)
  assert.deepEqual(snapshot.accounts[0].samples, { success: 4, failure: 0 })
})

test('14. deriveState derives HALF_OPEN read-only; live legacy still forces COOLING', () => {
  const record = { state: 'COOLING', until: NOW - MINUTE, reason: 'QUOTA' }
  const before = JSON.stringify(record)
  assert.equal(deriveState(record, NOW), 'HALF_OPEN')
  assert.equal(JSON.stringify(record), before, 'read path never writes the record')
  assert.equal(record.state, 'COOLING')
  assert.equal(deriveState(record, NOW, { until: NOW + MINUTE }), 'COOLING',
    'a live legacy cooldown overrides the derived HALF_OPEN')
})

test('15. mergeCooldown keeps the later of both layers (legacy MAX preserved)', () => {
  const record = { state: 'COOLING', until: NOW + 2 * MINUTE }
  assert.equal(mergeCooldown(record, undefined, NOW), NOW + 2 * MINUTE)
  assert.equal(mergeCooldown(record, { until: NOW + 9 * MINUTE }, NOW), NOW + 9 * MINUTE,
    'both layers block dispatch, so the later until wins')
  assert.equal(mergeCooldown({ state: 'COOLING', until: NOW - MINUTE }, undefined, NOW), null,
    'an expired record cooldown has no effective until')
})

test('16. projectAccount reports UNKNOWN with zero samples when there is no record', () => {
  const row = projectAccount({
    account: { id: 'acct-1', provider: 'route-a' },
    records: new Map(),
    source: {},
    now: NOW,
  })
  assert.equal(row.state, 'UNKNOWN', 'no evidence is UNKNOWN, never HEALTHY')
  assert.deepEqual(row.samples, { success: 0, failure: 0 })
  assert.equal(row.until, null)
  assert.equal(row.remainingMs, 0)
})
