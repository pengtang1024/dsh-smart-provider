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

test('BX6: unavailable registry models have no zero-price row (weak, not measured)', async () => {
  const { priceForExact } = await freshPricing()
  // These two registry entries are marked status: unavailable (badge id / plugin,
  // not working models). A zero row would make freeSignal report measured.
  for (const model of ['hy4-flash-free-trial-202611', 'web-search-free']) {
    const exact = priceForExact('x-opencode-free', model)
    assert.equal(exact.known, false, `${model} must not have an exact zero-price row`)
    assert.equal(exact.estimated, true)
    assert.equal(freeSignal({ provider: 'x-opencode-free', model, price: exact }).level, 'weak',
      `${model} may keep the name-only free hint, but never "已确认免费"`)
  }
  // Real declared-free models still ship a measured zero-price row.
  for (const model of ['hy4-flash-free', 'hy4flash-free']) {
    const exact = priceForExact('x-opencode-free', model)
    assert.equal(exact.known, true, `${model} must keep its exact zero-price row`)
    assert.equal(exact.estimated, false)
    assert.equal(exact.input + exact.output, 0)
    assert.equal(freeSignal({ provider: 'x-opencode-free', model, price: exact }).level, 'measured')
  }
  // Ranking's bare-model fallback semantics stay unchanged for rows that are
  // still in the table: a different provider resolves via model id alone.
  const { priceFor } = await freshPricing()
  const fallback = priceFor('another-provider', 'hy4-flash-free')
  assert.equal(fallback.known, true)
  assert.equal(fallback.estimated, false)
  // Every shipped default row must be an available declared-free model; no
  // unavailable model may re-enter even through hand edits of pricing.json.
  const shipped = JSON.parse(readFileSync(join(PKG, 'lib', 'pricing.json'), 'utf8'))
  assert.equal(shipped._rows, shipped.entries.length)
  for (const row of shipped.entries) {
    assert.ok(['hy4-flash-free', 'hy4flash-free'].includes(row.model),
      `${row.model} has no available zero-price declaration`)
  }
})
