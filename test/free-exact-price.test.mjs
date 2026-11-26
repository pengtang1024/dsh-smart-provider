/**
 * HB1/task-36 checkpoint B: free-signal prices must come from exact
 * (provider, model) rows only. The ranking cost factor keeps priceFor()'s
 * bare-model fallback; the free classifier does not.
 *
 *   env -u DSH_NODE_EXECUTABLE node --test test/free-exact-price.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeSignal } from '../lib/free-policy.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const HERE = dirname(fileURLToPath(import.meta.url))

async function freshPricing(env = {}) {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await import('../lib/pricing.js?case=' + mkdtempSync(join(tmpdir(), 'exact-price-')))
  mod.pricingSource() // force lazy index load under the override
  for (const [k, v] of Object.entries(saved)) process.env[k] = v
  return mod
}

test('BX1: priceForExact misses return known:false / estimated:true', async () => {
  const { priceForExact } = await freshPricing()
  const miss = priceForExact('workbuddy', 'hy4flash-free')
  assert.equal(miss.known, false)
  assert.equal(miss.estimated, true)
  assert.equal(miss.priceTier, 'free', 'a coarse tier hint is not a data row')
})

test('BX2: exact zero-price row stays known/measured for its own provider', async () => {
  const { priceForExact } = await freshPricing()
  const exact = priceForExact('x-opencode-free', 'hy4flash-free')
  assert.equal(exact.known, true)
  assert.equal(exact.estimated, false)
  assert.equal(exact.input + exact.output, 0)
  assert.equal(freeSignal({ provider: 'x-opencode-free', model: 'hy4flash-free', price: exact }).level, 'measured')
})

test('BX3: workbuddy/hy4flash-free is weak, not measured, through the exact price', async () => {
  const { priceFor, priceForExact } = await freshPricing()
  const fallback = priceFor('workbuddy', 'hy4flash-free')
  const exact = priceForExact('workbuddy', 'hy4flash-free')
  assert.equal(fallback.known, true, 'legacy fallback still finds a bare-model row')
  assert.equal(fallback.estimated, false)
  assert.equal(exact.known, false, 'free-signal lookup must not use that row')
  assert.equal(exact.estimated, true)
  const signal = freeSignal({ provider: 'workbuddy', model: 'hy4flash-free', price: exact })
  assert.equal(signal.free, true)
  assert.equal(signal.level, 'weak', 'name-only evidence is weak, never measured')
})

test('BX4: original priceFor keeps bare-model fallback across providers (ranking)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exact-fallback-'))
  try {
    const file = join(dir, 'pricing.user.json')
    writeFileSync(file, JSON.stringify({ entries: [
      { provider: 'a', model: 'shared-model', input: 5e-6, output: 9e-6 },
      { provider: 'b', model: 'shared-model', input: 1e-6, output: 3e-6 },
    ] }), 'utf8')
    const { priceFor, priceForExact } = await freshPricing({ DSH_SMART_PRICING_FILE: file })
    const got = priceFor('c', 'shared-model')
    assert.equal(got.known, true)
    assert.equal(got.input, 1e-6)
    assert.equal(got.output, 3e-6)
    const exact = priceForExact('c', 'shared-model')
    assert.equal(exact.known, false)
    assert.equal(exact.estimated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BX5: Host free projection uses priceForExact, never bare-model priceFor', () => {
  const src = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
  assert.match(src, /import \{ priceForExact \} from '\.\/pricing\.js'/)
  assert.match(src, /price = priceForExact\(provider, modelId\)/)
  assert.doesNotMatch(src, /import \{ priceFor(?:,| )/,
    'the free classifier must not import the fallback-capable lookup')
})
