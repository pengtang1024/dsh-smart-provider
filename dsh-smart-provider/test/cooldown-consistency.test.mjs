/**
 * Characterization test for the dual cooldown authority (legacy adapter Map +
 * L2 account-health registry), frozen BEFORE stage-2 convergence.
 *
 * THE INVARIANT UNDER TEST — do not weaken it:
 *   snapshot.until === max(all `until`s that would block dispatch at `now`).
 * Dispatch is gated by BOTH the legacy cooldowns Map and the L2 COOLING record
 * (account-pool.js #dispatchable chains the two predicates), so a snapshot may
 * never report an until earlier than either live gate.
 *
 * This is NOT an assertion that the two algorithms produce equal durations:
 * legacy writes fixed per-code constants (adapter.js:59-64), L2 writes
 * base x backoffFactor^(streak-1) (account-health.js:293-298). They legitimately
 * differ; only the MAX / UI-vs-dispatch agreement is frozen here.
 *
 * Stage 2 collapses the authority onto L2. These tests MUST stay green after
 * that convergence — if they fail, convergence changed observable behavior.
 *
 * Plain node, no DSH runtime:
 *   env -u DSH_NODE_EXECUTABLE node --test test/cooldown-consistency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHealthSnapshot } from '../lib/health-snapshot.js'
import {
  ACCOUNT_STATES, createAccountHealthRegistry, getRecord, isDispatchable, noteFailure,
} from '../lib/account-health.js'

const NOW = 1_700_000_000_000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const ACCOUNT = { id: 'acct-1', provider: 'route-a' }
const ROUTE = { provider: 'route-a', modelId: 'model-x', isVirtual: false }

/**
 * Legacy durations mirrored from adapter.js:59-64. adapter.js cannot be
 * imported under plain node (it loads @deepseek-ai/* from app.asar), so the
 * constants the adapter writes into `cooldowns` are restated here on purpose.
 * These remain the injected inputs even after the legacy writer is removed.
 */
const LEGACY_MS = Object.freeze({
  QUOTA: 30 * MINUTE,
  AUTH: 24 * HOUR,
  RATE_LIMIT: MINUTE,
  SERVER: 5_000,
})

/** Legacy failure code per L2 FailureKind (adapter codes vs normalized kinds). */
const LEGACY_CODE = Object.freeze({
  QUOTA: 'QUOTA',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER_JITTER: 'SERVER',
})

function snapshotRow({ now = NOW, cooldowns, accountHealth } = {}) {
  const snapshot = buildHealthSnapshot({
    enabled: true,
    now,
    accounts: [ACCOUNT],
    cooldowns,
    accountHealth,
  })
  assert.equal(snapshot.accounts.length, 1)
  return snapshot.accounts[0]
}

/** Mirrors adapter.isHealthy (adapter.js:176-177): a future finite until blocks. */
function legacyBlockUntil(cooldowns, now) {
  const cool = cooldowns?.get(ACCOUNT.id)
  return cool && Number.isFinite(cool.until) && cool.until > now ? cool.until : null
}

/** Mirrors account-health.stateOf's read-only view: only COOLING + future blocks. */
function l2BlockUntil(registry, now) {
  const record = getRecord(registry, ACCOUNT.id)
  return record?.state === ACCOUNT_STATES.COOLING
    && Number.isFinite(record.until) && record.until > now
    ? record.until
    : null
}

function blockersAt(now, cooldowns, registry) {
  return [legacyBlockUntil(cooldowns, now), l2BlockUntil(registry, now)]
    .filter(value => value !== null)
}

/**
 * The invariant, cross-checked against the REAL L2 gate rather than only the
 * mirror: isDispatchable() is account-health's dispatch predicate. It lazily
 * writes COOLING -> HALF_OPEN on expiry, so it runs on a detached copy while
 * the registry handed to buildHealthSnapshot stays byte-identical.
 */
function assertMaxMatchesDispatch(row, { now, cooldowns, accountHealth }) {
  const legacyUntil = legacyBlockUntil(cooldowns, now)
  const l2Until = l2BlockUntil(accountHealth, now)

  const probe = createAccountHealthRegistry()
  const record = getRecord(accountHealth, ACCOUNT.id)
  if (record) probe.records.set(ACCOUNT.id, record)
  assert.equal(
    isDispatchable(probe, ACCOUNT.id, ROUTE, now), l2Until === null,
    'the mirrored L2 blocker must agree with the real dispatch gate',
  )

  const blockers = blockersAt(now, cooldowns, accountHealth)
  const expected = blockers.length > 0 ? Math.max(...blockers) : null
  assert.equal(row.until, expected, 'snapshot until = max(all dispatch blockers)')
  if (expected === null) {
    assert.notEqual(row.state, 'COOLING', 'no gate blocks -> UI must not claim COOLING')
    assert.equal(row.remainingMs, 0)
  } else {
    assert.equal(row.state, 'COOLING', 'a blocked dispatch must surface as COOLING')
    assert.equal(row.remainingMs, expected - now, 'remaining time follows the effective until')
  }
  return { legacyUntil, l2Until, expected }
}

test('1. legacy until later than L2 record until -> legacy wins, COOLING, exact remaining', () => {
  const registry = createAccountHealthRegistry()
  const record = noteFailure(registry, ACCOUNT.id, 'QUOTA', NOW) // NOW + 30min
  const legacyUntil = NOW + 45 * MINUTE
  const cooldowns = new Map([[ACCOUNT.id, { until: legacyUntil, reason: 'SERVER' }]])

  const row = snapshotRow({ cooldowns, accountHealth: registry })
  const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns, accountHealth: registry })
  assert.equal(observed.l2Until, record.until)
  assert.equal(observed.legacyUntil, legacyUntil)
  assert.equal(blockersAt(NOW, cooldowns, registry).length, 2, 'both gates really block at NOW')
  assert.equal(row.until, legacyUntil)
  assert.equal(row.remainingMs, 45 * MINUTE)
  assert.equal(row.reason, 'QUOTA', 'while COOLING the record reason wins over the legacy code')
})

test('2. L2 record until later than legacy -> record wins', () => {
  const registry = createAccountHealthRegistry()
  const record = noteFailure(registry, ACCOUNT.id, 'AUTH', NOW) // NOW + 24h
  const legacyUntil = NOW + 10 * MINUTE
  const cooldowns = new Map([[ACCOUNT.id, { until: legacyUntil, reason: 'RATE_LIMIT' }]])

  const row = snapshotRow({ cooldowns, accountHealth: registry })
  const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns, accountHealth: registry })
  assert.equal(observed.legacyUntil, legacyUntil)
  assert.equal(row.until, record.until)
  assert.equal(row.remainingMs, 24 * HOUR)
  assert.equal(row.reason, 'AUTH')
})

test('3. legacy only (no accountHealth) -> COOLING with the legacy reason', () => {
  const until = NOW + 7 * MINUTE
  const cooldowns = new Map([[ACCOUNT.id, { until, reason: 'RATE_LIMIT' }]])

  const row = snapshotRow({ cooldowns })
  const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns, accountHealth: undefined })
  assert.equal(observed.l2Until, null)
  assert.equal(row.state, 'COOLING', 'dispatch really is blocked by the legacy gate')
  assert.equal(row.until, until)
  assert.equal(row.remainingMs, 7 * MINUTE)
  assert.equal(row.reason, 'RATE_LIMIT')
  assert.equal(row.streak, 0, 'no L2 record means no streak evidence')
})

test('4. L2 only (no legacy cooldown) -> COOLING with the record reason', () => {
  const registry = createAccountHealthRegistry()
  const record = noteFailure(registry, ACCOUNT.id, 'SERVER_JITTER', NOW)

  const row = snapshotRow({ accountHealth: registry })
  const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns: undefined, accountHealth: registry })
  assert.equal(observed.legacyUntil, null)
  assert.equal(row.state, 'COOLING')
  assert.equal(row.until, record.until)
  assert.equal(row.remainingMs, record.until - NOW)
  assert.equal(row.reason, 'SERVER_JITTER')
})

test('5. both layers expired -> not COOLING, no until, 0 remaining (both gates open)', () => {
  const registry = createAccountHealthRegistry()
  noteFailure(registry, ACCOUNT.id, 'QUOTA', NOW - 100 * MINUTE) // expired long ago
  const cooldowns = new Map([[ACCOUNT.id, { until: NOW - MINUTE, reason: 'AUTH' }]])
  const before = JSON.stringify(getRecord(registry, ACCOUNT.id))

  const row = snapshotRow({ cooldowns, accountHealth: registry })
  const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns, accountHealth: registry })
  assert.equal(observed.expected, null)
  assert.equal(row.state, 'HALF_OPEN')
  assert.equal(row.until, null)
  assert.equal(row.remainingMs, 0)
  // A read path must never perform stateOf()'s COOLING -> HALF_OPEN write-through.
  assert.equal(JSON.stringify(getRecord(registry, ACCOUNT.id)), before)
  assert.equal(isDispatchable(probeWith(registry), ACCOUNT.id, ROUTE, NOW), true)
})

/** Detached copy of a registry's one record, for destructive gate probes. */
function probeWith(registry) {
  const probe = createAccountHealthRegistry()
  const record = getRecord(registry, ACCOUNT.id)
  if (record) probe.records.set(ACCOUNT.id, record)
  return probe
}

test('6. four kinds: both authorities recorded; MAX never earlier than a live gate', t => {
  const matrix = []
  for (const kind of ['QUOTA', 'AUTH', 'RATE_LIMIT', 'SERVER_JITTER']) {
    const code = LEGACY_CODE[kind]
    const legacyMs = LEGACY_MS[code]
    assert.ok(legacyMs > 0, `legacy base for ${kind} is characterized`)

    const registry = createAccountHealthRegistry()
    // Two failures -> streak 2: L2 backs off while the legacy Map would write
    // the same fixed base again. That algorithmic difference is the whole
    // reason not to assert equality between the two durations.
    noteFailure(registry, ACCOUNT.id, kind, NOW - 2 * HOUR)
    const record = noteFailure(registry, ACCOUNT.id, kind, NOW)
    const l2Ms = record.until - NOW
    assert.ok(l2Ms > 0, `L2 until for ${kind} is in the future`)
    assert.equal(record.streak, 2)

    const cooldowns = new Map([[ACCOUNT.id, { until: NOW + legacyMs, reason: code }]])
    const row = snapshotRow({ cooldowns, accountHealth: registry })
    const observed = assertMaxMatchesDispatch(row, { now: NOW, cooldowns, accountHealth: registry })

    // Recorded separately, never compared for equality (AUTH caps at 24h on
    // both sides by coincidence — that is not an invariant).
    matrix.push({ kind, legacyMs, l2Ms, until: row.until, reason: row.reason, streak: row.streak })
    assert.equal(observed.expected, Math.max(NOW + legacyMs, NOW + l2Ms))
    assert.equal(row.until, Math.max(NOW + legacyMs, NOW + l2Ms))
    assert.equal(row.remainingMs, row.until - NOW)
    assert.equal(row.reason, kind, 'record reason wins while the record is COOLING')
    assert.equal(row.streak, 2)

    // Just after the SHORTER authority expires, the longer gate is still live:
    // the snapshot must not fall back to the expired (earlier) until.
    const later = NOW + Math.min(legacyMs, l2Ms) + 1
    const laterRow = snapshotRow({ now: later, cooldowns, accountHealth: registry })
    const laterObserved = assertMaxMatchesDispatch(laterRow, {
      now: later, cooldowns, accountHealth: registry,
    })
    const stillBlocking = blockersAt(later, cooldowns, registry)
    assert.equal(
      laterObserved.expected,
      stillBlocking.length > 0 ? Math.max(...stillBlocking) : null,
      `${kind}: snapshot follows the still-live gate, never the expired one`,
    )
    assert.ok(laterRow.until === null || laterRow.until <= row.until,
      'the effective until never moves backwards in wall-clock time')
  }
  t.diagnostic('kind | legacyMs | l2Ms | snapshotUntil-now | reason | streak\n'
    + matrix.map(r => `${r.kind} | ${r.legacyMs} | ${r.l2Ms} | ${r.until - NOW} | ${r.reason} | ${r.streak}`).join('\n'))
})
