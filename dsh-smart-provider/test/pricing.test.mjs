/**
 * Unit tests for lib/pricing.js — 落地规格 C3 acceptance list.
 * Run: node --test test/pricing.test.mjs   (pure logic, any Node)
 *
 * Self-contained: the "user table" cases write a temp JSON file into os.tmpdir()
 * and delete it afterwards; nothing is left in the repo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname
const EXAMPLE_PATH = join(HERE, '..', 'lib', 'pricing.example.json')
const DEFAULT_PATH = join(HERE, '..', 'lib', 'pricing.json')

// lib/pricing.js caches INDEX per process, so each scenario needs a fresh
// module instance — load it with a per-case query string.
async function freshPricing(env = {}) {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await import(`../lib/pricing.js?case=${encodeURIComponent(mkdtempSync(join(tmpdir(), 'pricing-')))}`)
  mod.pricingSource() // force the lazy INDEX load while the env override is active
  for (const [k, v] of Object.entries(saved)) process.env[k] = v
  return mod
}

/** A minimal user table with one real price, one zero row, one null-cache row. */
function writeUserTable(dir) {
  const file = join(dir, 'pricing.user.json')
  writeFileSync(file, JSON.stringify({
    _note: 'test fixture',
    entries: [
      { provider: 'acme', model: 'paid-model', input: 2e-6, output: 8e-6, cacheRead: 5e-7, cacheWrite: null },
      { provider: 'acme', model: 'free-model', input: 0, output: 0, cacheRead: null, cacheWrite: null },
      { provider: 'bare', model: 'shared-model', input: 1e-6, output: 3e-6 },
    ],
  }), 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// C3-1: the example export is never auto-loaded
// ---------------------------------------------------------------------------

test('C3-1: product default never loads pricing.example.json', async () => {
  const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
  assert.equal(example._example, true, 'example file must be explicitly marked _example:true')

  const { priceFor, pricingSource, priceCount, pricingHasRealPrices } = await freshPricing({ DSH_SMART_PRICING_FILE: undefined })
  assert.equal(pricingSource(), 'default')
  assert.equal(pricingHasRealPrices(), false, 'default table must not carry real vendor prices')
  // A model that exists ONLY in the author's example export resolves to a
  // tier estimate, never to the author's historical price.
  const priced = example.entries.find(e => (e.input ?? 0) > 0 || (e.output ?? 0) > 0)
  assert.ok(priced, 'example export must contain at least one priced row for this test')
  const got = priceFor(priced.provider, priced.model)
  assert.equal(got.known, false)
  assert.equal(got.estimated, true)
  assert.ok(['free', 'low', 'mid', 'high'].includes(got.priceTier))
  assert.notEqual(got.input, priced.input)
  assert.notEqual(got.output, priced.output)
  // And the loaded row count equals the DEFAULT table, not the 151-row export.
  const def = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8'))
  assert.equal(priceCount(), def.entries.length)
})

// ---------------------------------------------------------------------------
// C3-2: no user table -> coarse tier estimate, never throws
// ---------------------------------------------------------------------------

test('C3-2: unknown model -> estimated tier guess with known:false', async () => {
  const { priceFor, estimateCost } = await freshPricing({ DSH_SMART_PRICING_FILE: undefined })
  const est = priceFor('no-such', 'model-xyz')
  assert.equal(est.known, false)
  assert.equal(est.estimated, true)
  assert.ok(['free', 'low', 'mid', 'high'].includes(est.priceTier))
  assert.ok(est.input >= 0 && est.output >= 0)
  // estimateCost propagates the flags and never throws on empty usage.
  const cost = estimateCost({ inputTokens: 1000, outputTokens: 100 }, 'no-such', 'model-xyz')
  assert.equal(cost.known, false)
  assert.equal(cost.estimated, true)
  assert.equal(cost.priceTier, est.priceTier)
  assert.equal(typeof cost.estimatedCostUsd, 'number')
})

test('C3-2b: free-suffixed unknown model guesses tier "free" (zero estimate)', async () => {
  const { priceFor } = await freshPricing({ DSH_SMART_PRICING_FILE: undefined })
  const est = priceFor('some-gw', 'tiny-free')
  assert.equal(est.known, false)
  assert.equal(est.estimated, true)
  assert.equal(est.priceTier, 'free')
  assert.equal(est.input + est.output, 0)
})

test('C3-2c: default table zero rows are honored as real free declarations', async () => {
  const { priceFor } = await freshPricing({ DSH_SMART_PRICING_FILE: undefined })
  const def = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8'))
  assert.ok(def.entries.length > 0, 'default table must keep the registry zero rows')
  for (const row of def.entries.slice(0, 3)) {
    const got = priceFor(row.provider, row.model)
    assert.equal(got.known, true)
    assert.equal(got.input, 0)
    assert.equal(got.output, 0)
  }
})

// ---------------------------------------------------------------------------
// C3-3: explicit user table -> exact prices (same behavior as before)
// ---------------------------------------------------------------------------

test('C3-3: DSH_SMART_PRICING_FILE -> exact prices, exact/fallback resolution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-user-'))
  try {
    const file = writeUserTable(dir)
    const { priceFor, pricingSource, pricingHasRealPrices } = await freshPricing({ DSH_SMART_PRICING_FILE: file })
    assert.equal(pricingSource(), 'user')
    assert.equal(pricingHasRealPrices(), true)
    const paid = priceFor('acme', 'paid-model')
    assert.equal(paid.known, true)
    assert.equal(paid.input, 2e-6)
    assert.equal(paid.output, 8e-6)
    assert.equal(paid.cacheRead, 5e-7)
    assert.equal(paid.cacheWrite, 2e-6, 'cacheWrite:null falls back to input')
    const free = priceFor('acme', 'free-model')
    assert.equal(free.known, true)
    assert.equal(free.input + free.output, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C3-3b: bare-model fallback picks cheapest entry and degrades malformed table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-user-'))
  try {
    const file = join(dir, 'pricing.user.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const { pricingSource, priceFor } = await freshPricing({ DSH_SMART_PRICING_FILE: file })
    // Malformed user table -> degrade to product default, never throw.
    assert.equal(pricingSource(), 'default')
    assert.equal(priceFor('x', 'whatever').estimated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C3-3c: bare-model fallback across providers picks the cheapest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-user-'))
  try {
    const file = join(dir, 'pricing.user.json')
    writeFileSync(file, JSON.stringify({ entries: [
      { provider: 'a', model: 'shared-model', input: 5e-6, output: 9e-6 },
      { provider: 'b', model: 'shared-model', input: 1e-6, output: 3e-6 },
    ] }), 'utf8')
    const { priceFor } = await freshPricing({ DSH_SMART_PRICING_FILE: file })
    const got = priceFor('c', 'shared-model') // provider c missing -> bare-model fallback
    assert.equal(got.known, true)
    assert.equal(got.input, 1e-6, 'must pick the cheapest combined price')
    assert.equal(got.output, 3e-6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C3-4: reasoning/cacheOutput missing-field degradation (ranking parity)
// ---------------------------------------------------------------------------

test('C3-4: missing reasoning/cacheOutput fields still degrade to output (ranking resolveEffectivePrice parity)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-user-'))
  try {
    const file = join(dir, 'pricing.user.json')
    writeFileSync(file, JSON.stringify({ entries: [
      { provider: 'acme', model: 'paid-model', input: 2e-6, output: 8e-6, cacheRead: 5e-7, cacheWrite: null },
    ] }), 'utf8')
    const { priceFor } = await freshPricing({ DSH_SMART_PRICING_FILE: file })
    const paid = priceFor('acme', 'paid-model')
    // The table has no reasoning/cacheOutput key at all; ranking's fallback
    // chain (reasoning->output, cacheOutput->output) must still see a price.
    assert.equal(paid.reasoning, undefined)
    assert.ok(paid.output > 0, 'output rate present for reasoning fallback')
    assert.ok(paid.cacheWrite > 0, 'cacheWrite null resolved to input inside priceFor')
    // priceFor itself never invents reasoning keys — the degradation lives in ranking.
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C3-5: gen-custom-routes anchor degrade + original path (spawn, pure node)
// ---------------------------------------------------------------------------

const { spawnSync } = await import('node:child_process')
const { mkdtempSync: mkTmp2, mkdirSync, writeFileSync: wFile, rmSync: rmDir } = await import('node:fs')
const PKG_ROOT = join(HERE, '..')
const REAL_HOME = process.env.HOME // spawn with real HOME so registry-lib finds the yaml package

function makeCordisHome(withAnchors) {
  const home = mkTmp2(join(tmpdir(), 'gen-home-'))
  const profileDir = join(home, '.dsh', 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const body = withAnchors
    ? [
        '# fixture patch',
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        '    provider: workbuddy',
        '    model: glm-5.3-flash',
        '- id: smart-provider',
        '  name: "@local/dsh-smart-provider"',
        '  config: {}',
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      opencode-go:',
        '        models:',
        '          - id: gpt-5.6-luna',
      ].join('\n') + '\n'
    : [
        '# app-managed patch (no llm-pi-ai / smart-provider entries)',
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        '    provider: workbuddy',
        '    model: glm-5.3-flash',
      ].join('\n') + '\n'
  wFile(join(profileDir, 'cordis.patch.yml'), body, 'utf8')
  return home
}

function runGen(home) {
  return spawnSync(process.execPath, ['scripts/gen-custom-routes.mjs'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: home, DSH_HOME: REAL_HOME + '/.dsh' },
  })
}

test('C3-5a: gen with anchor-bearing cordis keeps original behavior (exit 0, no degrade warns)', () => {
  const home = makeCordisHome(true)
  try {
    const r1 = runGen(home)
    assert.equal(r1.status, 0, 'gen must exit 0 on the anchored fixture; stderr: ' + (r1.stderr || ''))
    assert.ok(!/WARN providers:/.test(r1.stderr), 'no providers degrade warn expected on the anchored path')
    assert.ok(!/WARN chains:/.test(r1.stderr), 'no chains degrade warn expected on the anchored path')
    assert.ok(/guard: 3 top-level entry ids unchanged/.test(r1.stdout), 'no-deletion guard must pass with all 3 ids')
    // Idempotent: second run byte-identical output.
    const r2 = runGen(home)
    assert.equal(r2.status, 0)
    assert.equal(r2.stdout, r1.stdout, 'gen dry-run output must be byte-identical across runs')
  } finally {
    rmDir(home, { recursive: true, force: true })
  }
})

test('C3-5b: gen with anchor-less app-managed cordis degrades honestly (exit 0 + visible warns)', () => {
  const home = makeCordisHome(false)
  try {
    const r = runGen(home)
    assert.equal(r.status, 0, 'anchor-less cordis must degrade to exit 0, never throw; stderr: ' + (r.stderr || ''))
    // console.warn goes to stderr — degrade reasons MUST be visible there.
    assert.ok(/WARN providers:.*no llm-pi-ai "providers:" anchor/.test(r.stderr), 'providers degrade warn must be visible (stderr)')
    assert.ok(/WARN chains:.*no recognizable smart-provider config anchor/.test(r.stderr), 'chains degrade warn must be visible (stderr)')
    assert.ok(/GUARD NOTE: llm-pi-ai, smart-provider not present.*waived/.test(r.stderr), 'guard waiver must be explicit, not silent')
    // Nothing may be injected into the user's patch: file unchanged by dry run.
    const patch = readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('custom-routes:providers'), 'dry run must not write into user cordis')
    assert.ok(!patch.includes('custom-routes:chains'), 'dry run must not write chains into user cordis')
    // Idempotent: second run byte-identical.
    const r2 = runGen(home)
    assert.equal(r2.status, 0)
    assert.equal(r2.stdout, r.stdout, 'degraded dry-run output must be byte-identical across runs')
  } finally {
    rmDir(home, { recursive: true, force: true })
  }
})
