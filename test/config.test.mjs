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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config } from '../schema.js'

const EXPECTED_KEYS = [
  'accounts', 'chains', 'costBatchSize', 'costDir', 'costEnabled',
  'costFlushIntervalMs', 'costPillEnabled', 'costPillPosition',
  'costPillRefreshMs', 'health', 'ranking', 'routing',
]

test('schema declares the three cost-pill fields as volatile with documented defaults', () => {
  const dict = Config.dict
  const expected = {
    costPillEnabled: { type: 'boolean', default: false },
    costPillPosition: { type: 'string', default: 'input.right' },
    costPillRefreshMs: { type: 'number', default: 60000 },
  }
  for (const [key, spec] of Object.entries(expected)) {
    assert.ok(dict[key], `${key} must be declared in the config schema`)
    assert.equal(dict[key].type, spec.type, `${key} type`)
    assert.equal(dict[key].meta?.volatile, true, `${key} must be volatile (no restart to edit)`)
  }
  const cfg = Config({})
  for (const [key, spec] of Object.entries(expected)) {
    const value = typeof cfg[key]?.get === 'function' ? cfg[key].get() : cfg[key]
    assert.equal(value, spec.default, `${key} default must be ${JSON.stringify(spec.default)}`)
  }
  // The statistics start marker is state, not config: never let it sneak in.
  assert.equal(Object.hasOwn(dict, 'statStartAt'), false, 'statStartAt belongs in stats-state.json, not config')
})

test('client contribution declares both new stats descriptors as strict codec triads', () => {
  const pkg = dirname(dirname(fileURLToPath(import.meta.url)))
  const src = readFileSync(join(pkg, 'client.js'), 'utf8')
  for (const method of ['statsSince', 'clearStats']) {
    const at = src.indexOf("method: '" + method + "'")
    assert.notEqual(at, -1, `client.js must declare a descriptor for ${method}()`)
    const block = src.slice(at, at + 1400)
    assert.match(block, /mode:\s*'strict'/, `${method} result must be strict`)
    assert.match(block, /typeSymbol:\s*'@local\/dsh-smart-provider\/types#[A-Za-z]+'/, `${method} needs a non-empty unique typeSymbol`)
    assert.match(block, /create:\s*\(\)/, `${method} needs a create() factory`)
    assert.match(block, new RegExp('receiver\\.' + method + '\\('), `${method} must invoke the Host method`)
  }
  assert.doesNotMatch(src, /typeSymbol:\s*'@local\/dsh-smart-provider\/types#Stats[^']*'[\s\S]{0,80}typeSymbol:\s*'\1'/, 'typeSymbols must be unique')
})

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
