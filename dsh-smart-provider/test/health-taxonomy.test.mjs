/**
 * Parity guard for the single-source health taxonomy (E0A1).
 *
 * The EXPECTED_* snapshots below are verbatim copies of the legacy constants
 * from the four existing consumers (account-health.js, availability.js,
 * adapter.js, health-snapshot.js). They intentionally duplicate the taxonomy
 * HERE, and nowhere else: when E0A2 switches consumers to derive from
 * health-taxonomy.js, a missed alias or changed cooldown breaks these asserts
 * instead of silently introducing cross-layer semantic drift.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_STATES, STATE_WEIGHTS, KIND_ALIASES, BASE_COOLDOWN_MS,
  FAILURE_KINDS, COOLDOWN_MS, normalizeKind,
} from '../lib/health-taxonomy.js'

// account-health.js:21-26 (verbatim snapshot)
const EXPECTED_ACCOUNT_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  ACTIVE: 'ACTIVE',
  COOLING: 'COOLING',
  HALF_OPEN: 'HALF_OPEN',
})
// account-health.js:29-34 (verbatim snapshot)
const EXPECTED_STATE_WEIGHTS = Object.freeze({
  ACTIVE: 1,
  UNKNOWN: 0.8,
  HALF_OPEN: 0.5,
  COOLING: 0,
})
// account-health.js:66-76 KIND_ALIASES (verbatim snapshot)
const EXPECTED_KIND_ALIASES = Object.freeze({
  QUOTA: 'QUOTA', ACCOUNT_QUOTA: 'ACCOUNT_QUOTA', CODE_402: 'QUOTA',
  AUTH: 'AUTH', INVALID_CREDENTIAL: 'INVALID_CREDENTIAL', CODE_401: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT', RATELIMIT: 'RATE_LIMIT', CODE_429: 'RATE_LIMIT',
  SERVER: 'SERVER_JITTER', TIMEOUT: 'SERVER_JITTER', TRANSPORT: 'SERVER_JITTER',
  STREAM_CLOSED: 'SERVER_JITTER', SERVER_JITTER: 'SERVER_JITTER',
  SESSION_HEADER: 'SESSION_HEADER', PARAM_COMPAT: 'PARAM_COMPAT',
  RENAMED: 'RENAMED', OFFLINE: 'OFFLINE', VIRTUAL: 'VIRTUAL', UNKNOWN_MODEL: 'RENAMED',
  MODEL_UNSUPPORTED: 'RENAMED', UNSUPPORTED_REASONING_EFFORT: 'PARAM_COMPAT',
  UNKNOWN: 'UNKNOWN', EMPTY_RESPONSE: 'UNKNOWN', ABORTED: 'UNKNOWN',
})
// account-health.js:49-56 BASE_COOLDOWN_MS (verbatim snapshot)
const EXPECTED_BASE_COOLDOWN_MS = Object.freeze({
  QUOTA: 30 * 60 * 1000,
  ACCOUNT_QUOTA: 30 * 60 * 1000,
  AUTH: 24 * 60 * 60 * 1000,
  INVALID_CREDENTIAL: 24 * 60 * 60 * 1000,
  RATE_LIMIT: 60 * 1000,
  SERVER_JITTER: 5 * 1000,
})
// availability.js:40-50 FAILURE_KIND (verbatim snapshot)
const EXPECTED_FAILURE_KIND = Object.freeze({
  SESSION_HEADER: 'SESSION_HEADER',
  PARAM_COMPAT: 'PARAM_COMPAT',
  RENAMED: 'RENAMED',
  OFFLINE: 'OFFLINE',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  SERVER_JITTER: 'SERVER_JITTER',
  UNKNOWN: 'UNKNOWN',
})
// adapter.js:59-64 COOLDOWN_MS (verbatim snapshot)
const EXPECTED_COOLDOWN_MS = Object.freeze({
  quotaDefault: 30 * 60 * 1000,
  rateLimitDefault: 60 * 1000,
  authInvalid: 24 * 60 * 60 * 1000,
  upstreamJitter: 5 * 1000,
})
// health-snapshot.js:51 state whitelist (verbatim snapshot, order normalized as a set)
const EXPECTED_SNAPSHOT_STATES = ['UNKNOWN', 'ACTIVE', 'COOLING', 'HALF_OPEN']

test('taxonomy ACCOUNT_STATES matches legacy account-health.js', () => {
  assert.deepEqual(ACCOUNT_STATES, EXPECTED_ACCOUNT_STATES)
})

test('taxonomy STATE_WEIGHTS matches legacy account-health.js', () => {
  assert.deepEqual(STATE_WEIGHTS, EXPECTED_STATE_WEIGHTS)
})

test('taxonomy KIND_ALIASES matches legacy account-health.js verbatim', () => {
  assert.deepEqual(KIND_ALIASES, EXPECTED_KIND_ALIASES)
  // Guard against alias drift in either direction, not just key equality.
  assert.deepEqual(Object.keys(KIND_ALIASES).sort(), Object.keys(EXPECTED_KIND_ALIASES).sort())
})

test('taxonomy BASE_COOLDOWN_MS matches legacy account-health.js', () => {
  assert.deepEqual(BASE_COOLDOWN_MS, EXPECTED_BASE_COOLDOWN_MS)
})

test('taxonomy FAILURE_KINDS matches legacy availability.js FAILURE_KIND', () => {
  assert.deepEqual(FAILURE_KINDS, EXPECTED_FAILURE_KIND)
})

test('taxonomy COOLDOWN_MS matches legacy adapter.js', () => {
  assert.deepEqual(COOLDOWN_MS, EXPECTED_COOLDOWN_MS)
})

test('taxonomy account states match legacy health-snapshot.js whitelist', () => {
  assert.deepEqual(Object.keys(ACCOUNT_STATES).slice().sort(), EXPECTED_SNAPSHOT_STATES.slice().sort())
})

test('normalizeKind: symbolic alias codes', () => {
  assert.equal(normalizeKind('TIMEOUT'), 'SERVER_JITTER')
  assert.equal(normalizeKind('CODE_402'), 'QUOTA')
  assert.equal(normalizeKind('UNKNOWN_MODEL'), 'RENAMED')
})

test('normalizeKind: bare HTTP status codes', () => {
  assert.equal(normalizeKind('402'), 'QUOTA')
  assert.equal(normalizeKind('429'), 'RATE_LIMIT')
  assert.equal(normalizeKind('503'), 'SERVER_JITTER')
  assert.equal(normalizeKind('404'), 'RENAMED')
})

test('normalizeKind: unknown / null codes never throw', () => {
  assert.equal(normalizeKind('NO_SUCH_CODE'), 'UNKNOWN')
  assert.equal(normalizeKind(''), null)
  assert.equal(normalizeKind(null), null)
})
