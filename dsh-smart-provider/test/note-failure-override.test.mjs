/**
 * E1D: noteFailure's optional upstream cooldown override (stage-1 groundwork).
 *
 * Contract frozen here:
 *   - passing a finite positive delayMs makes until === now + delayMs, even
 *     when the streak backoff would be longer;
 *   - omitting it (or passing junk) keeps the exact base x backoff^(streak-1)
 *     formula, so no current caller's behavior changes in this stage;
 *   - the registry's existing record is never mutated.
 *
 * Plain node, no DSH runtime:
 *   env -u DSH_NODE_EXECUTABLE node --test test/note-failure-override.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_STATES, createAccountHealthRegistry, getRecord, noteFailure,
} from '../lib/account-health.js'

const NOW = 1_700_000_000_000
const QUOTA_BASE_MS = 30 * 60 * 1000
const ACCOUNT = 'acct-override'

test('1. finite positive delayMs overrides streak backoff: until === now + delayMs', () => {
  const registry = createAccountHealthRegistry()
  const delayMs = 12_345

  // First failure: backoff would be QUOTA_BASE_MS; the hint must win.
  const first = noteFailure(registry, ACCOUNT, 'QUOTA', NOW, { delayMs })
  assert.equal(first.state, ACCOUNT_STATES.COOLING)
  assert.equal(first.until, NOW + delayMs)
  assert.equal(first.streak, 1, 'the override changes duration, not streak accounting')

  // Second failure: streak backoff would be 2x base; the hint must still win.
  const second = noteFailure(registry, ACCOUNT, 'QUOTA', NOW, { delayMs: 7_000 })
  assert.equal(second.streak, 2)
  assert.equal(second.until, NOW + 7_000)
})

test('2. no delayMs: backoff formula is unchanged (base x backoff^(streak-1))', () => {
  const registry = createAccountHealthRegistry()
  const first = noteFailure(registry, ACCOUNT, 'QUOTA', NOW)
  assert.equal(first.until, NOW + QUOTA_BASE_MS, 'streak 1 uses the base value')

  const second = noteFailure(registry, ACCOUNT, 'QUOTA', NOW)
  assert.equal(second.streak, 2)
  assert.equal(second.until, NOW + QUOTA_BASE_MS * 2, 'streak 2 doubles')

  // Explicitly empty / non-positive / non-finite options must not hijack it.
  const junk = [{}, { delayMs: 0 }, { delayMs: -1 }, { delayMs: Infinity }, { delayMs: 'nope' }]
  for (const options of junk) {
    const fresh = createAccountHealthRegistry()
    const record = noteFailure(fresh, ACCOUNT, 'QUOTA', NOW, options)
    assert.equal(record.until, NOW + QUOTA_BASE_MS, 'junk options ignored: ' + JSON.stringify(options))
  }
})

test('3. retryAfterMs alias behaves like delayMs and the registry record is immutable', () => {
  const registry = createAccountHealthRegistry()
  noteFailure(registry, ACCOUNT, 'QUOTA', NOW)
  const before = JSON.stringify(getRecord(registry, ACCOUNT))

  const next = noteFailure(registry, ACCOUNT, 'QUOTA', NOW, { retryAfterMs: 42_000 })
  assert.equal(next.until, NOW + 42_000, 'alias accepted for upstream Retry-After values')
  assert.equal(JSON.stringify(getRecord(registry, ACCOUNT)), JSON.stringify(next), 'registry holds the new record')
  assert.notEqual(JSON.stringify(next), before, 'a new record was produced, not an in-place edit')
})
