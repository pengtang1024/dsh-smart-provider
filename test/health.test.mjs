/**
 * Regression tests for the three-layer health auto-management modules:
 *
 *   lib/availability.js       L1 route health registry  (可用性自动管理设计.md §2-§9)
 *   lib/account-health.js     L2 account state machine  (账号池自动管理深化设计.md §2-§8)
 *   lib/provider-topology.js  L2a aggregator/direct     (账号池自动管理深化设计.md §1.0-1.4)
 *   lib/health-setup.js       L7 wiring / opt-out
 *   lib/probe.js              task-107 minimal probe + cache
 *
 * Every module under test is pure (no DSH import, no network, no I/O except the
 * probe cache, which is redirected to a temp dir). Plain node is enough:
 *
 *   node --test test/health.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'

import {
  HEALTH, BILLING_TIER, FAILURE_KIND,
  registryKey, resolveModelId, classifyFailure, updateHealth,
  isCandidate, billingTierOf, healthOf, projectStatus,
} from '../lib/availability.js'
import {
  ACCOUNT_STATES, STATE_WEIGHTS, DEFAULT_HEALTH_CONFIG,
  kindFromLedgerCode, createAccountHealthRegistry, stateOf, weightOf, getRecord,
  noteSuccess, noteFailure, reserveHalfOpen, releaseHalfOpen, isDispatchable, rebuildFromLedger,
} from '../lib/account-health.js'
import {
  AGGREGATOR, DIRECT, UNKNOWN,
  observedAccountIdsFor, hasPoolCapability, isAggregator, observeTopology, resolveTopology,
} from '../lib/provider-topology.js'
import { buildHealthDeps } from '../lib/health-setup.js'
import { createProbe, DEFAULT_CACHE_FILE, PROBE_MAX_TOKENS } from '../lib/probe.js'

const KEY = { provider: 'route-a', modelId: 'model-x' }

// ===========================================================================
// L1 — availability.js
// ===========================================================================

test('registryKey is provider::modelId and empty on missing parts', () => {
  assert.equal(registryKey(KEY), 'route-a::model-x')
  assert.equal(registryKey({ provider: 'p' }), '')
  assert.equal(registryKey({ modelId: 'm' }), '')
  assert.equal(registryKey(null), '')
})

test('classifyFailure: request-shape (P0) failures never lower model health', () => {
  const header = classifyFailure({ message: 'MissingSessionID: x-opencode-session required' })
  assert.equal(header.kind, FAILURE_KIND.SESSION_HEADER)
  assert.equal(header.affectsModelHealth, false)

  const compat = classifyFailure({ code: 'SERVER', message: 'max_completion_tokens is not supported' })
  assert.equal(compat.kind, FAILURE_KIND.PARAM_COMPAT)
  assert.equal(compat.affectsModelHealth, false, 'a coarse SERVER code must not drag the model down')
})

test('classifyFailure: account-level (P2) failures are not model faults', () => {
  for (const [input, kind] of [
    [{ code: 'QUOTA' }, FAILURE_KIND.QUOTA],
    [{ code: '402' }, FAILURE_KIND.QUOTA],
    [{ code: '429' }, FAILURE_KIND.RATE_LIMIT],
    [{ code: '401' }, FAILURE_KIND.AUTH],
    [{ message: 'insufficient 余额' }, FAILURE_KIND.QUOTA],
  ]) {
    const verdict = classifyFailure(input)
    assert.equal(verdict.kind, kind, JSON.stringify(input))
    assert.equal(verdict.affectsModelHealth, false, JSON.stringify(input))
  }
})

test('classifyFailure: 5xx/timeout is jitter and does affect model health', () => {
  const jitter = classifyFailure({ message: '502 Bad Gateway' })
  assert.equal(jitter.kind, FAILURE_KIND.SERVER_JITTER)
  assert.equal(jitter.affectsModelHealth, true)
  assert.equal(classifyFailure({ message: 'stream closed' }).kind, FAILURE_KIND.SERVER_JITTER)
})

test('classifyFailure: a bare 400 lands in UNKNOWN, not the SERVER bucket', () => {
  const verdict = classifyFailure({ code: '400', message: 'bad request' })
  assert.equal(verdict.kind, FAILURE_KIND.UNKNOWN)
  assert.equal(verdict.affectsModelHealth, false)
})

test('resolveModelId: exact use / normalized remap / medium keep / far deprecate', () => {
  assert.deepEqual(resolveModelId('model-x', ['model-x'], {}), { id: 'model-x', action: 'use' })

  // Free/preview suffix is erased by normalization -> same model, automatic remap.
  const remap = resolveModelId('gpt-4o-free', ['gpt-4o'], {})
  assert.deepEqual(remap, { id: 'gpt-4o', action: 'remap' })

  // Medium similarity keeps the requested id (no silent rerouting).
  const medium = resolveModelId('model-x', ['model-y'], {})
  assert.equal(medium.id, 'model-x')
  assert.equal(medium.action, 'use')

  // Nothing close -> deprecated.
  assert.deepEqual(resolveModelId('zzz', ['completely-different'], {}), { id: 'zzz', action: 'deprecate' })
})

test('classifyFailure: 404 with a remappable id is RENAMED, otherwise OFFLINE', () => {
  const renamed = classifyFailure(
    { code: '404' },
    { currentIdList: ['gpt-4o'], requestedId: 'gpt-4o-preview' },
  )
  assert.equal(renamed.kind, FAILURE_KIND.RENAMED)
  assert.equal(renamed.retryable, false)

  const offline = classifyFailure(
    { code: '404' },
    { currentIdList: ['unrelated-model'], requestedId: 'gone-model' },
  )
  assert.equal(offline.kind, FAILURE_KIND.OFFLINE)
  assert.equal(offline.affectsModelHealth, true)
})

test('updateHealth is pure: the input registry is never mutated', () => {
  const registry = {}
  const snapshot = JSON.stringify(registry)
  updateHealth(registry, { ...KEY, success: true, cost: 0 })
  assert.equal(JSON.stringify(registry), snapshot, 'updateHealth must return a new record, not write in place')
  assert.deepEqual(registry, {})
})

test('updateHealth: a success yields HEALTHY with a positive confidence', () => {
  const record = updateHealth({}, { ...KEY, success: true, cost: 0 })
  assert.equal(record.health, HEALTH.HEALTHY)
  assert.equal(record.samples.success, 1)
  assert.equal(record.samples.failure, 0)
  assert.ok(record.confidence > 0)
  assert.equal(record.key.provider, 'route-a')
  assert.equal(record.key.modelId, 'model-x')
})

test('updateHealth: virtual copies never write health (§6.2)', () => {
  const registry = {}
  const record = updateHealth(registry, { ...KEY, isVirtual: true, success: true })
  assert.equal(record.health, HEALTH.UNKNOWN)
  assert.equal(record.samples.success, 0)
  assert.deepEqual(registry, {})
})

test('updateHealth: zero samples from both sources stay UNKNOWN with confidence 0', () => {
  assert.deepEqual(healthOf({}, KEY), { health: HEALTH.UNKNOWN, confidence: 0 })
  assert.deepEqual(billingTierOf({}, KEY), { tier: BILLING_TIER.UNKNOWN, confidence: 0 })
})

test('updateHealth: server jitter degrades only past the 3-failure threshold', () => {
  let registry = {}
  const apply = () => {
    const record = updateHealth(registry, {
      ...KEY, failure: { code: '502', message: '502 Bad Gateway' },
    })
    registry = { [registryKey(KEY)]: record }
    return record
  }
  assert.equal(apply().health, HEALTH.UNKNOWN)
  assert.equal(apply().health, HEALTH.UNKNOWN)
  assert.equal(apply().health, HEALTH.DEGRADED)
})

test('updateHealth: offline deprecates only past the 3-failure threshold', () => {
  let registry = {}
  const apply = () => {
    const record = updateHealth(registry, {
      ...KEY,
      failure: { code: '404' },
      currentIdList: ['unrelated-model'],
    })
    registry = { [registryKey(KEY)]: record }
    return record
  }
  assert.equal(apply().health, HEALTH.UNKNOWN)
  assert.equal(apply().health, HEALTH.UNKNOWN)
  assert.equal(apply().health, HEALTH.DEPRECATED)
})

test('updateHealth: quota failures never deprecate the model', () => {
  let registry = {}
  let record
  for (let i = 0; i < 5; i++) {
    record = updateHealth(registry, { ...KEY, failure: { code: 'QUOTA' } })
    registry = { [registryKey(KEY)]: record }
  }
  assert.equal(record.health, HEALTH.UNKNOWN, 'account-level quota is not a model fault')
  assert.equal(record.failureKinds[FAILURE_KIND.QUOTA], 5)
})

test('billing: 20 ledger-sourced free samples promote to FREE with medium confidence', () => {
  let registry = {}
  let record
  for (let i = 0; i < 20; i++) {
    record = updateHealth(registry, { ...KEY, success: true, cost: 0 })
    registry = { [registryKey(KEY)]: record }
  }
  assert.equal(record.billingTier, BILLING_TIER.FREE)
  const tier = billingTierOf(registry, KEY)
  assert.equal(tier.tier, BILLING_TIER.FREE)
  assert.ok(tier.confidence >= 0.7 && tier.confidence < 0.95, 'ledger-only free is medium confidence')
})

test('billing: one metered sample is high-confidence METERED', () => {
  const registry = {}
  const record = updateHealth(registry, { ...KEY, success: true, cost: 0.02 })
  registry[registryKey(KEY)] = record
  assert.equal(record.billingTier, BILLING_TIER.METERED)
  assert.equal(billingTierOf(registry, KEY).confidence, 0.95)
})

test('billing: an upstream billing source is authoritative', () => {
  const free = updateHealth({}, { ...KEY, success: true, cost: 0, billingSource: 'free-tier' })
  assert.equal(free.billingTier, BILLING_TIER.FREE)

  const metered = updateHealth({}, { ...KEY, success: true, cost: 0, billingSource: 'go-plus-credit' })
  assert.equal(metered.billingTier, BILLING_TIER.METERED)
})

test('billing: a rename voids old billing confidence (forced recheck §4.1)', () => {
  let record = updateHealth({}, { ...KEY, success: true, cost: 0, billingSource: 'free' })
  assert.equal(record.billingTier, BILLING_TIER.FREE)

  record = updateHealth({}, {
    ...KEY,
    failure: { code: '404' },
    currentIdList: ['model-x-preview'],
    relatedId: 'model-x-preview',
  })
  // A fresh registry reproduces the "only the rename happened" case.
  assert.equal(record.health, HEALTH.DEPRECATED)
  assert.deepEqual(record.billing, {
    freeSamples: 0, meteredSamples: 0, upstreamFree: false, upstreamMetered: false,
  })
})

test('isCandidate: virtual identities are excluded, everything else is kept', () => {
  assert.equal(isCandidate({}, { ...KEY, isVirtual: true }), false)
  assert.equal(isCandidate({}, KEY), true)
  assert.equal(isCandidate({}, {}), false, 'an incomplete key is not a candidate')
})

test('projectStatus merges by modelId at highest confidence and skips virtual copies', () => {
  const strong = updateHealth({}, { provider: 'r1', modelId: 'shared', success: true, cost: 0 })
  const weak = updateHealth({}, { provider: 'r2', modelId: 'shared', success: true, cost: 0 })
  weak.confidence = strong.confidence / 2
  const registry = {
    [registryKey({ provider: 'r1', modelId: 'shared' })]: strong,
    [registryKey({ provider: 'r2', modelId: 'shared' })]: weak,
    [registryKey({ provider: 'r3', modelId: 'virtual', isVirtual: true })]:
      updateHealth({}, { provider: 'r3', modelId: 'virtual', isVirtual: true, success: true }),
  }
  const status = projectStatus(registry)
  assert.equal(status.virtual, undefined, 'virtual rows are never projected')
  assert.equal(status.shared.health, HEALTH.HEALTHY)
  assert.equal(status.shared.confidence, strong.confidence)
})

// ===========================================================================
// L2 — account-health.js
// ===========================================================================

const QUOTA_COOLDOWN_MS = 30 * 60 * 1000

test('account health: an unknown account has no record and UNKNOWN state', () => {
  const registry = createAccountHealthRegistry()
  assert.equal(stateOf(registry, 'nobody'), ACCOUNT_STATES.UNKNOWN)
  assert.equal(weightOf(ACCOUNT_STATES.ACTIVE), 1)
  assert.equal(weightOf(ACCOUNT_STATES.COOLING), 0)
  assert.equal(weightOf('bogus'), 0)
  assert.equal(getRecord(registry, 'nobody'), undefined, 'reading never creates a record')
})

test('account health: a quota failure cools for 30min and doubles on the next streak', () => {
  const registry = createAccountHealthRegistry()
  const t0 = 1_700_000_000_000
  let record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  assert.equal(record.state, ACCOUNT_STATES.COOLING)
  assert.equal(record.reason, 'QUOTA')
  assert.equal(record.streak, 1)
  assert.equal(record.until, t0 + QUOTA_COOLDOWN_MS, 'first failure uses the base value, not backoff')

  record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  assert.equal(record.streak, 2)
  assert.equal(record.until, t0 + QUOTA_COOLDOWN_MS * 2, 'streak 2 doubles the cooldown')
})

test('account health: cooldown is capped at maxCooldownMs', () => {
  const registry = createAccountHealthRegistry({ maxCooldownMs: QUOTA_COOLDOWN_MS * 3 })
  const t0 = 1_700_000_000_000
  let record
  for (let i = 0; i < 6; i++) record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  assert.equal(record.until, t0 + QUOTA_COOLDOWN_MS * 3)
})

test('account health: an elapsed cooldown becomes HALF_OPEN, never ACTIVE', () => {
  const registry = createAccountHealthRegistry()
  const t0 = 1_700_000_000_000
  const record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  assert.equal(stateOf(registry, 'acct-a', record.until - 1), ACCOUNT_STATES.COOLING)
  assert.equal(stateOf(registry, 'acct-a', record.until), ACCOUNT_STATES.HALF_OPEN)
  // Half-open persists without real traffic (§8: no evidence, no recovery).
  assert.equal(stateOf(registry, 'acct-a', record.until + 86_400_000), ACCOUNT_STATES.HALF_OPEN)
  assert.equal(weightOf(ACCOUNT_STATES.HALF_OPEN), 0.5)
})

test('account health: half-open grants exactly one permit', () => {
  const registry = createAccountHealthRegistry({ halfOpenPermits: 1 })
  const t0 = 1_700_000_000_000
  const record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  stateOf(registry, 'acct-a', record.until) // trigger the COOLING -> HALF_OPEN transition
  assert.equal(reserveHalfOpen(registry, 'acct-a'), true)
  assert.equal(reserveHalfOpen(registry, 'acct-a'), false, 'the second permit is refused')
})

test('account health: reserveHalfOpen refuses non-half-open accounts', () => {
  const registry = createAccountHealthRegistry()
  noteSuccess(registry, 'acct-a')
  assert.equal(reserveHalfOpen(registry, 'acct-a'), false)
  assert.equal(reserveHalfOpen(registry, 'unknown-account'), false)
})

// --- P0-1: user cancellation must hand back the half-open permit -----------
test('account health: releaseHalfOpen restores a spent permit without changing state', () => {
  const registry = createAccountHealthRegistry({ halfOpenPermits: 1 })
  const t0 = 1_700_000_000_000
  const record = noteFailure(registry, 'acct-a', 'QUOTA', t0)
  stateOf(registry, 'acct-a', record.until) // COOLING -> HALF_OPEN
  assert.equal(reserveHalfOpen(registry, 'acct-a'), true)
  const spent = getRecord(registry, 'acct-a')
  assert.equal(spent.halfOpenPermits, 0)

  assert.equal(releaseHalfOpen(registry, 'acct-a'), true)
  const restored = getRecord(registry, 'acct-a')
  assert.equal(restored.halfOpenPermits, 1, 'permit is returned')
  assert.equal(restored.state, ACCOUNT_STATES.HALF_OPEN, 'no evidence: never promotes to ACTIVE')
  assert.equal(restored.until, spent.until, 'no cooldown field is written or cleared')
  assert.equal(spent.halfOpenPermits, 0, 'the input record is never mutated in place')

  // A caller can override the restored permit count; invalid values fall back
  // to the configured default (not a NaN / 0 permit that re-leaks the account).
  assert.equal(releaseHalfOpen(registry, 'acct-a', 3), true)
  assert.equal(getRecord(registry, 'acct-a').halfOpenPermits, 3)
  assert.equal(releaseHalfOpen(registry, 'acct-a', Number.NaN), true)
  assert.equal(getRecord(registry, 'acct-a').halfOpenPermits, DEFAULT_HEALTH_CONFIG.halfOpenPermits)
})

test('account health: releaseHalfOpen refuses non-half-open accounts', () => {
  const registry = createAccountHealthRegistry()
  const active = noteSuccess(registry, 'acct-a')
  assert.equal(releaseHalfOpen(registry, 'acct-a'), false)
  assert.deepEqual(getRecord(registry, 'acct-a'), active, 'ACTIVE record is unchanged')
  const t0 = 1_700_000_000_000
  const cooling = noteFailure(registry, 'acct-b', 'QUOTA', t0)
  assert.equal(releaseHalfOpen(registry, 'acct-b'), false)
  assert.deepEqual(getRecord(registry, 'acct-b'), cooling, 'COOLING record is unchanged')
})

test('account health: releaseHalfOpen does not create a missing record', () => {
  const registry = createAccountHealthRegistry()
  assert.equal(releaseHalfOpen(registry, 'ghost'), false)
  assert.equal(getRecord(registry, 'ghost'), undefined)
})

test('account health: a real success restores ACTIVE and clears the streak', () => {
  const registry = createAccountHealthRegistry()
  const t0 = 1_700_000_000_000
  noteFailure(registry, 'acct-a', 'QUOTA', t0)
  const record = noteSuccess(registry, 'acct-a', t0 + 1000)
  assert.equal(record.state, ACCOUNT_STATES.ACTIVE)
  assert.equal(record.streak, 0)
  assert.equal(record.samples.success, 1)
  assert.equal(record.until, undefined, 'the cooldown deadline is cleared on recovery')
})

test('account health: request-shape and model-layer failures cool nobody', () => {
  const registry = createAccountHealthRegistry()
  const t0 = 1_700_000_000_000
  for (const kind of ['SESSION_HEADER', 'PARAM_COMPAT', 'RENAMED', 'OFFLINE', 'VIRTUAL']) {
    const record = noteFailure(registry, 'acct-a', kind, t0)
    assert.notEqual(record.state, ACCOUNT_STATES.COOLING, kind)
    assert.equal(record.samples.failure, 0, kind)
  }
})

test('account health: an unrecognized kind is an honest sample, never a penalty', () => {
  const registry = createAccountHealthRegistry()
  const record = noteFailure(registry, 'acct-a', 'SOMETHING_NEW', 1_700_000_000_000)
  assert.notEqual(record.state, ACCOUNT_STATES.COOLING)
  assert.equal(record.samples.failure, 1)
})

test('account health: aggregator routes bypass the account layer', () => {
  const registry = createAccountHealthRegistry({ aggregators: ['pool-plugin'] })
  const t0 = 1_700_000_000_000
  const record = noteFailure(registry, 'acct-a', { kind: 'QUOTA', provider: 'pool-plugin' }, t0)
  assert.notEqual(record.state, ACCOUNT_STATES.COOLING, 'a pooled provider cools its own accounts')
  assert.equal(record.samples.failure, 0)
})

test('account health: isDispatchable combines the model gate and the account state', () => {
  const registry = createAccountHealthRegistry()
  noteSuccess(registry, 'acct-a')
  assert.equal(isDispatchable(registry, 'acct-a', KEY), true)

  const t0 = Date.now()
  noteFailure(registry, 'acct-a', 'QUOTA', t0)
  assert.equal(isDispatchable(registry, 'acct-a', KEY, t0 + 1), false, 'COOLING is not dispatchable')

  // A model-layer veto wins even for a healthy account.
  const gated = createAccountHealthRegistry({ isCandidate: () => false })
  noteSuccess(gated, 'acct-a')
  assert.equal(isDispatchable(gated, 'acct-a', KEY), false)
})

test('account health: kind aliases map ledger codes onto failure kinds', () => {
  // Symbolic codes are what the adapter actually writes into cost.jsonl.
  assert.equal(kindFromLedgerCode('QUOTA'), 'QUOTA')
  assert.equal(kindFromLedgerCode('RATE_LIMIT'), 'RATE_LIMIT')
  assert.equal(kindFromLedgerCode('AUTH'), 'AUTH')
  assert.equal(kindFromLedgerCode('INVALID_CREDENTIAL'), 'INVALID_CREDENTIAL')
  assert.equal(kindFromLedgerCode('SERVER'), 'SERVER_JITTER')
  assert.equal(kindFromLedgerCode('TIMEOUT'), 'SERVER_JITTER')
  assert.equal(kindFromLedgerCode('UNKNOWN_MODEL'), 'RENAMED')
  assert.equal(kindFromLedgerCode(null), null)
  assert.equal(kindFromLedgerCode(''), null)
  assert.equal(kindFromLedgerCode('WHATEVER'), 'UNKNOWN')
})

test('account health: bare HTTP statuses in an older ledger still classify', () => {
  assert.equal(kindFromLedgerCode('402'), 'QUOTA')
  assert.equal(kindFromLedgerCode(429), 'RATE_LIMIT')
  assert.equal(kindFromLedgerCode('401'), 'AUTH')
  assert.equal(kindFromLedgerCode('403'), 'AUTH')
  assert.equal(kindFromLedgerCode('404'), 'RENAMED')
  assert.equal(kindFromLedgerCode('503'), 'SERVER_JITTER')
})

test('account health: rebuildFromLedger replays a JSONL ledger in order', () => {
  const rows = [
    { account_id: 'acct-a', timestamp: '2026-11-01T00:00:00Z', failure_code: null, actual_provider: 'r1', actual_model: 'm1' },
    { account_id: 'acct-a', timestamp: '2026-11-01T00:01:00Z', failure_code: 'QUOTA', actual_provider: 'r1', actual_model: 'm1' },
    { account_id: 'acct-b', timestamp: '2026-11-01T00:02:00Z', failure_code: null, actual_provider: 'r2', actual_model: 'm1' },
  ]
  const registry = rebuildFromLedger(rows)
  assert.equal(getRecord(registry, 'acct-a').state, ACCOUNT_STATES.COOLING)
  assert.equal(getRecord(registry, 'acct-a').samples.failure, 1)
  assert.equal(getRecord(registry, 'acct-b').state, ACCOUNT_STATES.ACTIVE)

  // Malformed input must not throw: a partial ledger cannot block cold start.
  const tolerant = rebuildFromLedger('{"account_id":"acct-c","failure_code":null}\n\nnot json\n')
  assert.equal(getRecord(tolerant, 'acct-c').state, ACCOUNT_STATES.ACTIVE)
})

test('account health: DEFAULT_HEALTH_CONFIG is the documented neutral baseline', () => {
  assert.equal(DEFAULT_HEALTH_CONFIG.halfOpenPermits, 1)
  assert.equal(DEFAULT_HEALTH_CONFIG.backoffFactor, 2)
  assert.deepEqual(STATE_WEIGHTS, { ACTIVE: 1, UNKNOWN: 0.8, HALF_OPEN: 0.5, COOLING: 0 })
})

// ===========================================================================
// L2a — provider-topology.js
// ===========================================================================

test('topology: classification is structural, never name-based', () => {
  assert.equal(isAggregator('any-name-at-all', true), AGGREGATOR)
  assert.equal(isAggregator('any-name-at-all', false), DIRECT)
  // Same evidence for two different names -> same verdict.
  assert.equal(
    isAggregator('provider-one', undefined, ['a', 'b']),
    isAggregator('provider-two', undefined, ['a', 'b']),
  )
})

test('topology: >1 observed account id means aggregator, 1 means unknown', () => {
  assert.equal(isAggregator('p', undefined, ['a', 'b']), AGGREGATOR)
  assert.equal(isAggregator('p', undefined, ['a']), UNKNOWN)
  assert.equal(isAggregator('p', undefined, []), UNKNOWN)
  assert.equal(isAggregator('p', undefined, undefined), UNKNOWN)
})

test('topology: observedAccountIdsFor scopes by provider and optionally model', () => {
  const rows = [
    { provider: 'p', modelId: 'm1', accountId: 'a' },
    { provider: 'p', modelId: 'm1', accountId: 'b' },
    { provider: 'p', modelId: 'm2', accountId: 'c' },
    { provider: 'other', modelId: 'm1', accountId: 'd' },
    { provider: 'p', modelId: 'm1', account_id: 'e' },
  ]
  assert.deepEqual([...observedAccountIdsFor(rows, 'p', 'm1')].sort(), ['a', 'b', 'e'])
  assert.deepEqual([...observedAccountIdsFor(rows, 'p')].sort(), ['a', 'b', 'c', 'e'])
  assert.equal(observedAccountIdsFor('not-an-array', 'p').size, 0)
})

test('topology: capability shape reveals an internal pool', () => {
  assert.equal(hasPoolCapability({ accounts: [{ id: 'x' }] }), true)
  assert.equal(hasPoolCapability({ regions: ['us'] }), true)
  assert.equal(hasPoolCapability({ pool: true }), true)
  assert.equal(hasPoolCapability({ capabilities: { accounts: ['a'] } }), true)
  assert.equal(hasPoolCapability({}), false)
  assert.equal(hasPoolCapability(null), false)
  assert.equal(hasPoolCapability({ accounts: [] }), false)
})

test('topology: observation upgrades UNKNOWN but never downgrades, and DIRECT wins', () => {
  assert.equal(observeTopology(UNKNOWN, 'p', ['a', 'b']), AGGREGATOR)
  assert.equal(observeTopology(AGGREGATOR, 'p', ['a']), AGGREGATOR, 'evidence is monotonic')
  assert.equal(observeTopology(UNKNOWN, 'p', ['a']), UNKNOWN)
  assert.equal(observeTopology(UNKNOWN, 'p', ['a', 'b'], false), DIRECT, 'an explicit DIRECT declaration is respected')
})

test('resolveTopology: an aggregator with local accounts is transparent and warns', () => {
  const verdict = resolveTopology('pool-plugin', [{ id: 'a' }, { id: 'b' }], { declaredFlag: true })
  assert.equal(verdict.topology, 'aggregator')
  assert.equal(verdict.transparent, true)
  assert.equal(verdict.ignoredAccounts, 2)
  assert.deepEqual(verdict.accounts, [], 'two competing pools are never built')
  assert.equal(verdict.warnings.length, 1)
  assert.equal(verdict.warnings[0].code, 'AGGREGATOR_ACCOUNTS_IGNORED')
})

test('resolveTopology: forceAccountLayer overrides transparency, with a warning', () => {
  const verdict = resolveTopology('pool-plugin', [{ id: 'a', forceAccountLayer: true }], { declaredFlag: true })
  assert.equal(verdict.transparent, false)
  assert.equal(verdict.forceAccountLayer, true)
  assert.equal(verdict.accounts.length, 1)
  assert.equal(verdict.warnings[0].code, 'FORCE_ACCOUNT_LAYER')
})

test('resolveTopology: direct and unknown keep the configured accounts', () => {
  const direct = resolveTopology('solo', [{ id: 'a' }], { declaredFlag: false })
  assert.equal(direct.topology, 'direct')
  assert.equal(direct.transparent, false)
  assert.equal(direct.accounts.length, 1)
  assert.deepEqual(direct.warnings, [])

  const unknown = resolveTopology('mystery', [{ id: 'a' }])
  assert.equal(unknown.topology, 'unknown')
  assert.equal(unknown.transparent, false)
  assert.equal(unknown.accounts.length, 1)
})

test('resolveTopology: a pool capability declaration marks the route aggregator', () => {
  const verdict = resolveTopology('declared-pool', [], { declaration: { capabilities: { accounts: ['x'] } } })
  assert.equal(verdict.topology, 'aggregator')
  assert.equal(verdict.transparent, true)
})

// ===========================================================================
// L7 — health-setup.js
// ===========================================================================

test('health wiring: default-on supplies every registry the adapter needs', () => {
  const deps = buildHealthDeps({})
  assert.ok(deps, 'health must be ON when the user configured nothing')
  assert.equal(deps.enabled, true)
  assert.equal(typeof deps.availabilityRegistry, 'object')
  assert.ok(deps.accountHealth && deps.accountHealth.records instanceof Map)
  assert.ok(Array.isArray(deps.virtualProviders))
  assert.ok(deps.virtualProviders.includes('smart'), 'the meta-provider is the one legitimate virtual route')
})

test('health wiring: explicit opt-out in every supported shape returns undefined', () => {
  assert.equal(buildHealthDeps({ health: false }), undefined)
  assert.equal(buildHealthDeps({ health: { enabled: false } }), undefined)
  assert.equal(buildHealthDeps({ ranking: { health: false } }), undefined)
  assert.equal(buildHealthDeps({ ranking: { health: { enabled: false } } }), undefined)
  // Volatile (schemastery {get()}) values must be unwrapped before testing.
  assert.equal(buildHealthDeps({ health: { get: () => false } }), undefined)
})

test('health wiring: additional virtual providers are appended without duplicates', () => {
  const deps = buildHealthDeps({ health: { virtualProviders: ['gateway', 'smart', 'gateway'] } })
  assert.deepEqual(deps.virtualProviders, ['smart', 'gateway'])
})

test('health wiring: nested ranking.health config reaches the account registry', () => {
  const deps = buildHealthDeps({ ranking: { health: { halfOpenPermits: 3 } } })
  assert.equal(deps.accountHealth.config.halfOpenPermits, 3)
  // Unspecified fields keep the neutral default.
  assert.equal(deps.accountHealth.config.backoffFactor, DEFAULT_HEALTH_CONFIG.backoffFactor)
})
// --- Opt-out priority matrix -------------------------------------------------
// The four surfaces are OR-ed: any false opts out. The documented order
// (health, health.enabled, ranking.health, ranking.health.enabled) is the
// priority matrix; no form can re-enable health. These cases lock the OR
// semantics and deprecation warning behavior in place.

test('opt-out matrix: each of the four shapes alone disables health', () => {
  const cases = [
    ['health === false', { health: false }],
    ['health.enabled === false', { health: { enabled: false } }],
    ['ranking.health === false', { ranking: { health: false } }],
    ['ranking.health.enabled === false', { ranking: { health: { enabled: false } } }],
  ]
  for (const [label, config] of cases) {
    assert.equal(buildHealthDeps(config), undefined, label)
  }
})

test('opt-out matrix: absent / true / malformed values keep health ON', () => {
  const enabled = [
    {},
    { health: true },
    { health: { enabled: true } },
    { health: 'yes' },
    { health: 0 },
    { ranking: { health: true } },
    { ranking: { health: { enabled: true } } },
    { ranking: { health: 'off' } },
  ]
  for (const config of enabled) {
    const deps = buildHealthDeps(config)
    assert.ok(deps, JSON.stringify(config))
    assert.equal(deps.enabled, true, JSON.stringify(config))
  }
})

test('opt-out matrix: OR wins when a false surface is mixed with truthy ones', () => {
  assert.equal(buildHealthDeps({ health: false, ranking: { health: { enabled: true } } }), undefined)
  assert.equal(buildHealthDeps({ health: { enabled: false }, ranking: { health: true } }), undefined)
  assert.equal(buildHealthDeps({ health: true, ranking: { health: false } }), undefined)
  assert.equal(buildHealthDeps({ ranking: { health: false, enabled: false } }), undefined)
  assert.equal(buildHealthDeps({ health: { enabled: false, virtualProviders: ['x'] } }), undefined)
})

test('opt-out matrix: malformed containers are ignored, never crash', () => {
  for (const bad of [null, 0, 'off', [], true]) {
    const deps = buildHealthDeps({ health: bad, ranking: bad })
    assert.ok(deps, 'non-object / non-false values leave health ON: ' + JSON.stringify(bad))
    assert.equal(deps.enabled, true)
  }
})

test('opt-out matrix: deprecated ranking.health.* false forms warn, modern forms do not', () => {
  let warnings = []
  const origWarn = console.warn
  console.warn = msg => warnings.push(String(msg))
  try {
    buildHealthDeps({ health: false })
    buildHealthDeps({ health: { enabled: false } })
    assert.equal(warnings.length, 0, 'supported forms must not warn')

    warnings = []
    buildHealthDeps({ ranking: { health: false } })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /DEPRECATED/)
    assert.match(warnings[0], /ranking[.]health/)

    warnings = []
    buildHealthDeps({ ranking: { health: { enabled: false } } })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /DEPRECATED/)
    assert.match(warnings[0], /ranking[.]health[.]enabled/)

    warnings = []
    const deps = buildHealthDeps({ ranking: { health: { halfOpenPermits: 2 } } })
    assert.ok(deps)
    assert.equal(warnings.length, 0, 'legitimate nested config is not deprecated')
  } finally {
    console.warn = origWarn
  }
})

test('opt-out matrix: Volatile wrappers are unwrapped at the outer surfaces', () => {
  assert.equal(buildHealthDeps({ health: { get: () => false } }), undefined)
  assert.equal(buildHealthDeps({ ranking: { get: () => ({ health: false }) } }), undefined)
  assert.equal(buildHealthDeps({ health: { get: () => ({ enabled: false }) } }), undefined)
  const deps = buildHealthDeps({ health: { get: () => true } })
  assert.ok(deps && deps.enabled === true)
})

// ===========================================================================
// probe.js — task-107 minimal probe + cache
// ===========================================================================

test('probe: the default cache lives under the CURRENT home, not a baked-in path', () => {
  assert.equal(DEFAULT_CACHE_FILE, join(homedir(), '.dsh', 'smart-provider', 'probe-cache.jsonl'))
  assert.ok(DEFAULT_CACHE_FILE.startsWith(homedir() + '/'), 'cache must stay under the CURRENT home, not a baked-in path')
  assert.equal(PROBE_MAX_TOKENS, 1, 'one token per probe keeps a paid probe nearly free')
})

/** Minimal fake llm runtime: one scripted stream per (provider, model). */
function fakeRuntime(scripts) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens })
      const chunks = scripts[options.provider] ?? [
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

test('probe: a zero-cost free billing source records free evidence into L1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({
      'free-route': [
        { type: 'usage', usage: { cost: 0, billingSource: 'free-tier' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const availabilityRegistry = {}
    const probe = createProbe({ runtime, availabilityRegistry, cacheFile: join(dir, 'cache.jsonl') })

    const { results } = await probe.probeModels([{ provider: 'free-route', model: 'm1' }])
    assert.equal(results.length, 1)
    assert.equal(results[0].verdict, 'free')
    assert.equal(results[0].cost, 0)

    const record = availabilityRegistry['free-route::m1']
    assert.ok(record, 'the verdict must land in the shared L1 registry')
    assert.equal(record.billingTier, BILLING_TIER.FREE)
    assert.equal(record.health, HEALTH.HEALTHY)
    assert.equal(runtime.calls[0].maxTokens, PROBE_MAX_TOKENS)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: a non-zero cost is metered evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({
      'paid-route': [
        { type: 'usage', usage: { cost: 0.0001, billingSource: 'credit' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const availabilityRegistry = {}
    const probe = createProbe({ runtime, availabilityRegistry, cacheFile: join(dir, 'cache.jsonl') })
    const { results } = await probe.probeModels([{ provider: 'paid-route', model: 'm1' }])
    assert.equal(results[0].verdict, 'metered')
    assert.equal(availabilityRegistry['paid-route::m1'].billingTier, BILLING_TIER.METERED)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: cost 0 without a billing source is an honest unknown, never "free"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({
      'ambiguous': [
        { type: 'usage', usage: { cost: 0 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const probe = createProbe({ runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl') })
    const { results } = await probe.probeModels([{ provider: 'ambiguous', model: 'm1' }])
    assert.equal(results[0].verdict, 'unknown')
    assert.equal(results[0].ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- P0-1 end-to-end: ABORTED returns the permit so the account stays usable -
// SmartAdapter's constructor loads LlmAdapter from @deepseek-ai/dsh-llm (inside
// the DSH app.asar, unreadable by plain Node). Supply a throwaway profile with a
// stub package so this suite stays in the plain-Node --unit gate while still
// exercising the REAL constructor, REAL stream() and the REAL ABORTED branch.
async function withStubDshProfile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smart-halfopen-'))
  const previous = process.env.DSH_PROFILE_DIR
  try {
    const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'halfopen-stub', version: '1.0.0' }))
    await writeFile(join(pkg, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-llm', version: '1.0.0', main: 'index.js',
    }))
    await writeFile(join(pkg, 'index.js'), 'exports.LlmAdapter = class LlmAdapter {};')
    process.env.DSH_PROFILE_DIR = dir
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('P0-1 e2e: an ABORTED half-open attempt hands back the permit and the account is selectable again', async () => {
  await withStubDshProfile(async () => {
    const { SmartAdapter } = await import('../lib/adapter.js')
    const { AccountPool } = await import('../lib/account-pool.js')
    const chains = { auto: [{ provider: 'p', model: 'm' }] }
    const accounts = [{ id: 'acctA', provider: 'p', credentialRef: 'K', models: ['m'] }]

    const registry = createAccountHealthRegistry({ halfOpenPermits: 1 })
    const t0 = 1_700_000_000_000
    noteFailure(registry, 'acctA', 'QUOTA', t0)
    stateOf(registry, 'acctA', getRecord(registry, 'acctA').until) // -> HALF_OPEN

    const runtime = {
      stream() {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'user cancelled' } } }
        })()
      },
    }
    const adapter = new SmartAdapter({
      runtime, chains, accounts, meter: { record: () => {} },
      health: { enabled: true, accountHealth: registry },
      logger: { warn: () => {}, error: () => {} },
    })

    // First call: stream() -> plan() reserves the only permit -> ABORTED return.
    const first = []
    for await (const chunk of adapter.stream({ model: 'auto', sessionId: 's1' })) first.push(chunk)
    assert.equal(first.at(-1).reason.kind, 'aborted', 'user cancellation still passes through unchanged')
    assert.equal(getRecord(registry, 'acctA').state, ACCOUNT_STATES.HALF_OPEN)
    assert.equal(getRecord(registry, 'acctA').halfOpenPermits, 1, 'ABORTED returned the consumed permit')

    // The acceptance signal: the SAME account is selected again — without this
    // the permit leak froze it permanently until restart.
    const runtime2 = {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    adapter.runtime = runtime2
    const second = []
    for await (const chunk of adapter.stream({ model: 'auto', sessionId: 's2' })) second.push(chunk)
    assert.equal(second.at(-1).reason.kind, 'stop', 'the recovered account serves a real request')
    const planned = new AccountPool({ accounts, chains }).plan(chains.auto, Date.now())
    assert.ok(planned.some(a => a.account.id === 'acctA'))
  })
})

test('probe: the meta-provider "smart" is never probed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({})
    const probe = createProbe({ runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl') })
    await probe.probeModels([{ provider: 'smart', model: 'auto' }])
    assert.equal(runtime.calls.length, 0, 'probing ourselves would recurse')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: the per-call cap defers extra candidates instead of blocking them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({
      'r1': [{ type: 'usage', usage: { cost: 0, billingSource: 'free' } }, { type: 'finish', reason: { kind: 'stop' } }],
      'r2': [{ type: 'usage', usage: { cost: 0, billingSource: 'free' } }, { type: 'finish', reason: { kind: 'stop' } }],
    })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl'), maxPerCall: 1,
    })
    const { results } = await probe.probeModels([
      { provider: 'r1', model: 'm1' },
      { provider: 'r2', model: 'm1' },
    ])
    assert.equal(runtime.calls.length, 1, 'only one real probe per call')
    assert.equal(results[1].verdict, 'unknown')
    assert.match(results[1].evidence, /cap/)
    assert.equal(results[1].provider, 'r2', 'identity is preserved so nothing is hidden')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: a cached verdict is reused without a second upstream call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-probe-'))
  try {
    const runtime = fakeRuntime({
      'r1': [{ type: 'usage', usage: { cost: 0, billingSource: 'free' } }, { type: 'finish', reason: { kind: 'stop' } }],
    })
    const cacheFile = join(dir, 'cache.jsonl')
    await createProbe({ runtime, availabilityRegistry: {}, cacheFile }).probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(runtime.calls.length, 1)

    // A fresh probe instance hydrates the same cache file: no re-probe.
    const second = await createProbe({ runtime, availabilityRegistry: {}, cacheFile })
      .probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(runtime.calls.length, 1, 'the persistent TTL cache must survive a reload')
    assert.equal(second.results[0].verdict, 'free')
    assert.match(second.results[0].evidence, /cached/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
