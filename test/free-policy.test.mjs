/**
 * Tests for the Host single-source free-signal policy (task-24).
 * The fixed vector table is exported so free-verify (task-26) can run the
 * browser mirror against exactly the same inputs and expected values.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeSignal, FREE_POLICY_VECTORS, FREE_SIGNAL_RULE_VERSION, FREE_SIGNAL_LEVELS } from '../lib/free-policy.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

test('rule version is the shared mirror identifier', () => {
  assert.equal(FREE_SIGNAL_RULE_VERSION, 'free-signal-v1')
  assert.deepEqual([...FREE_SIGNAL_LEVELS], ['measured', 'declared', 'weak', 'none'])
})

for (const vector of FREE_POLICY_VECTORS) {
  test('vector: ' + vector.name, () => {
    const got = freeSignal(vector.input)
    assert.equal(got.free, vector.expected.free, `${vector.name}: free mismatch`)
    assert.equal(got.level, vector.expected.level, `${vector.name}: level mismatch`)
    assert.ok(FREE_SIGNAL_LEVELS.includes(got.level), `${vector.name}: level must be a declared level`)
    assert.equal(typeof got.evidence, 'string')
    assert.equal(typeof got.source, 'string')
  })
}

test('paid hard evidence beats a measured free verdict and a zero multiplier', () => {
  const r = freeSignal({
    provider: 'x-free', model: 'free-model', probeVerdict: 'free', multiplier: 0,
    price: { known: true, estimated: false, input: 2e-6, output: 0 },
  })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('probe metered beats a real zero price row and a free name', () => {
  const r = freeSignal({ model: 'free-model', probeVerdict: 'metered',
    price: { known: true, estimated: false, input: 0, output: 0 } })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('multiplier accepts only a finite zero number, never string/null/negative/NaN', () => {
  for (const value of ['0', null, undefined, -1, NaN, Infinity, 'free', {}]) {
    const r = freeSignal({ model: 'm', multiplier: value })
    assert.equal(r.free, false, `multiplier ${String(value)} must not be a free signal`)
    assert.equal(r.level, 'none')
  }
  assert.equal(freeSignal({ model: 'm', multiplier: 0 }).level, 'declared')
})

test('case-insensitive name match only on provider/model/name/group, not flash or trial', () => {
  assert.equal(freeSignal({ provider: 'FREE-GW', model: 'm' }).level, 'weak')
  assert.equal(freeSignal({ name: 'A Free Tier' }).level, 'weak')
  assert.equal(freeSignal({ group: 'free-tier' }).level, 'weak')
  assert.equal(freeSignal({ model: 'claude-flash-trial' }).free, false)
  assert.equal(freeSignal({ model: 'hy4-flash-free' }).level, 'weak')
})

test('unknown verdict does not block declared or weak signals', () => {
  assert.equal(freeSignal({ model: 'free-m', probeVerdict: 'unknown' }).level, 'weak')
  assert.equal(freeSignal({ model: 'm', probeVerdict: 'unknown', multiplier: 0 }).level, 'declared')
})

test('pricing table estimate is not a real price declaration', () => {
  const estimate = { known: false, estimated: true, input: 0, output: 0, priceTier: 'free' }
  const r = freeSignal({ model: 'm', price: estimate })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('availabilityStatus projection attaches exactly {free,level,source}|null', () => {
  const src = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
  assert.match(src, /status\[modelId\]\.freeSignal\s*=\s*projectFreeSignal\(/)
  assert.match(src, /return \{ free: signal\.free, level: signal\.level, source: signal\.source \}/,
    'the wire shape must not leak evidence to the strict codec'
  )
  assert.match(src, /probeReader\?\.\(\)\?\.peek\?\./,
    'probeReader is a lazy closure from index.js; peek must be called on the unwrapped probe')
  assert.match(src, /priceFor\(provider, modelId\)/)
  const methods = [...src.matchAll(/method:\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(methods)].sort(),
    ['accountHealth', 'availabilityStatus', 'cost', 'costDetail', 'probeModels'])
})

test('pricing.js keeps its own price semantics; free-policy consumes a passed price object', () => {
  const pricing = readFileSync(join(PKG, 'lib', 'pricing.js'), 'utf8')
  assert.match(pricing, /estimated: true,\s*\n\s*priceTier: tier,/)
  const policy = readFileSync(join(PKG, 'lib', 'free-policy.js'), 'utf8')
  assert.doesNotMatch(policy, /from '\.\/pricing\.js'/,
    'free-policy must stay pure: it consumes a price object, never loads a table'
  )
})
