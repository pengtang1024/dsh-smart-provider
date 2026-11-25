/**
 * Config schema declaration tests (E1A).
 *
 * The health switch had four shapes in lib/health-setup.js but no field in
 * schema.js, so the settings page could not discover it. These tests pin the
 * DECLARATION only — parsing the four opt-out shapes stays in health-setup.js
 * (E1B) and no runtime behaviour changes here.
 *
 * Pure logic: schemastery resolves through lib/dsh.js anchors and works under
 * plain Node (no app.asar dependency). Run: node --test test/config.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../schema.js'

const EXPECTED_KEYS = [
  'accounts', 'chains', 'costBatchSize', 'costDir', 'costEnabled',
  'costFlushIntervalMs', 'health', 'ranking', 'routing',
]

test('schema declares health as a volatile any field, next to ranking', () => {
  const dict = Config.dict
  assert.ok(dict.health, 'health must be declared in the config schema (config-surface discoverability)')
  assert.equal(dict.health.type, 'any', 'health accepts every opt-out shape without schema-level coercion')
  assert.equal(dict.health.meta?.volatile, true, 'health must be volatile like ranking so settings edits need no restart')
  assert.match(Config.toString(), /health\?: any/, 'the declared field must show up in the schema surface')
})

test('Config({health}) accepts health and leaves every other field shape unchanged', () => {
  const base = Config({})
  const configured = Config({ health: { enabled: false, cooldownMs: 1000 } })

  assert.deepEqual(Object.keys(configured).sort(), EXPECTED_KEYS)
  // Volatile schemastery fields expose a {get()} wrapper, not the raw value.
  assert.deepEqual(
    configured.health.get(), { enabled: false, cooldownMs: 1000 },
    'health value passes through untouched — no schema-level parsing',
  )
  assert.equal(base.health.get(), undefined, 'health stays optional on an empty config')
  for (const key of EXPECTED_KEYS.filter(k => k !== 'health')) {
    // The volatile wrappers are distinct objects per Config() call; compare
    // their unwrapped values instead of their identity.
    const before = typeof base[key]?.get === 'function' ? base[key].get() : base[key]
    const after = typeof configured[key]?.get === 'function' ? configured[key].get() : configured[key]
    assert.deepEqual(after, before, `${key} shape changed by a health setting`)
  }
  assert.deepEqual(Object.keys(base).sort(), EXPECTED_KEYS, 'health is declared but still optional on an empty config')
})
