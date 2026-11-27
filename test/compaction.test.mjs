/**
 * task-5: virtual-model contextWindow tests.
 *
 * The host's compaction preflight (compactPressure in dsh-session) resolves
 * resolveModelInfo(smart/<model>) and REFUSES the model switch when
 * `info.context === undefined` ("compaction-basic: no context capacity for
 * smart/<model>"). Both catalog surfaces must therefore always carry a real,
 * positive contextWindow:
 *   - listModels(): static declaration, read from the cached routes metadata
 *     (refreshDiscoveredChains keeps it fresh);
 *   - resolveModel(): delegates the first hop's resolveModelInfo, backfilling
 *     the cached/conservative floor window when the hop omits it.
 *
 * Pure in-memory fixtures — no DSH registry, so this suite runs under any
 * Node; it is also wired into the Electron full gate via run-tests.mjs.
 *
 * Full gate:
 *   ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/compaction.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SmartAdapter } from '../lib/adapter.js'
import { resolveChain } from '../lib/chains.js'
import {
  supportedEfforts, mapEffort, parseTierId, MANUAL_EFFORT_IDS,
} from '../lib/tier-ids.js'

/** Minimal runtime: only what listModels/resolveModel touch. */
function runtimeWith({ windows = {}, resolveModelInfo } = {}) {
  return {
    async *stream() { /* unused in these tests */ },
    resolveRetryPolicy(config) { return config },
    resolveModelInfo: resolveModelInfo ?? (async (provider, model) => ({
      provider,
      id: model,
      name: model,
      ...(windows[`${provider}/${model}`] !== undefined
        ? { context: { contextWindow: windows[`${provider}/${model}`] } }
        : {}),
    })),
    imageRequestPricing() { return undefined },
  }
}

/** Route cache shaped exactly like refreshDiscoveredChains fills it. */
const discoveredRoutes = [
  { provider: 'hopA', models: [{ id: 'big', name: 'Big', contextWindow: 200000 }, { id: 'small', name: 'Small' }] },
  { provider: 'hopB', models: ['plain-string-model'] },
]

function adapterWith({ chains, routes = [], runtime } = {}) {
  return new SmartAdapter({ runtime: runtime ?? runtimeWith(), chains, routes })
}

// ---------------------------------------------------------------------------
// 1. listModels: contextWindow from the cached first-hop route metadata
// ---------------------------------------------------------------------------

test('listModels lists the 4 single-segment virtual models with contextWindow from the first hop', async () => {
  const adapter = adapterWith({
    // All four MODEL_TIERS keys are configured here to exercise the
    // per-first-hop window inheritance; listing itself is unconditional.
    chains: {
      balanced: [{ provider: 'hopA', model: 'big' }],
      cost: [{ provider: 'hopA', model: 'big' }],
      speed: [{ provider: 'hopA', model: 'big' }],
      smart: [{ provider: 'hopA', model: 'big' }],
    },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const byId = new Map(models.map(m => [m.id, m]))
  assert.deepEqual(models.map(m => m.id), ['balanced', 'cost', 'speed', 'smart'],
    'catalog is exactly the 4 single-segment virtual models, never the 24 combination ids')
  // Names are locale-channel values (SPEC §2.1/§3), not hardcoded "Smart ...".
  const zhNames = { balanced: '均衡', cost: '省钱', speed: '效率', smart: '智能' }
  for (const [id, name] of Object.entries(zhNames)) {
    assert.equal(byId.get(id).name, name, `${id} name comes from the locale channel`)
    assert.equal(byId.get(id).contextWindow, 200000, `${id} inherits the first hop real window`)
  }
  for (const m of models) {
    assert.equal(m.provider, 'smart')
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, `every virtual model carries a positive contextWindow (${m.id})`)
  }
})

// Regression: a real migrated config can contain ONLY `chains.smart`
// (migrateChainKeys maps auto→smart and drops retired aliases). The locked
// 4-virtual-model catalog must not collapse to a single "smart" entry.
test('listModels lists all 4 tiers when only chains.smart is configured', async () => {
  const adapter = adapterWith({
    chains: {
      smart: [{ provider: 'hopA', model: 'big' }],
    },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  assert.deepEqual(models.map(m => m.id), ['balanced', 'cost', 'speed', 'smart'],
    'all 4 single-segment tiers are listed even with a single smart key')
  const byId = new Map(models.map(m => [m.id, m]))
  for (const m of models) {
    assert.equal(m.provider, 'smart')
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0,
      `${m.id} carries a positive contextWindow with only chains.smart configured`)
  }
  // Missing tiers resolve through the smart-chain fallback, so their windows
  // match smart's; none is an empty/UNKNOWN_MODEL chain or a fabricated value.
  const smartWindow = byId.get('smart').contextWindow
  for (const id of ['balanced', 'cost', 'speed']) {
    assert.equal(byId.get(id).contextWindow, smartWindow,
      `${id} inherits the smart chain window via the resolveChain fallback`)
  }
})

test('listModels falls back to the conservative floor when the route cache lacks the hop', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopB', model: 'plain-string-model' }] },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const smart = models.find(m => m.id === 'smart')
  // hopB's entry is a bare string (no contextWindow in the cache at all).
  assert.equal(smart.contextWindow, 128000, 'bare-string cache entry falls back to the 128k floor')
})

test('listModels falls back to the floor when discovery has not run yet (routes empty)', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'big' }] },
    routes: [], // refreshDiscoveredChains has not fired yet
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'smart').contextWindow, 128000)
})

test('listModels ignores malformed cached windows instead of propagating them', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'big' }] },
    routes: [{ provider: 'hopA', models: [{ id: 'big', contextWindow: -5 }] }],
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'smart').contextWindow, 128000, 'negative/zero windows fall back, never propagate')
})

// ---------------------------------------------------------------------------
// 2. resolveModel: first-hop truth, honest backfill on both fallback branches
// ---------------------------------------------------------------------------

test('resolveModel keeps the real first-hop contextWindow verbatim', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
    runtime: runtimeWith({ windows: { 'hopA/big': 200000 } }),
  })
  const info = await adapter.resolveModel('smart', 'smart')
  assert.deepEqual(info.context, { contextWindow: 200000 })
  assert.equal(info.provider, 'smart')
  assert.equal(info.id, 'smart')
})

test('resolveModel normalizes the legacy "auto" model alias to the smart chain', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
    runtime: runtimeWith({ windows: { 'hopA/big': 200000 } }),
  })
  const info = await adapter.resolveModel('smart', 'auto')
  assert.equal(info.context.contextWindow, 200000, 'legacy alias resolves through the smart chain')
  assert.equal(info.id, 'auto', 'the host keeps the id it asked for')
})

test('resolveModel backfills the cached window when the hop catalog omits it', async () => {
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'small' }] },
    routes: discoveredRoutes, // 'small' cached WITHOUT contextWindow
    runtime: runtimeWith({ windows: {} }), // runtime resolveModelInfo omits context too
  })
  const info = await adapter.resolveModel('smart', 'smart')
  assert.equal(info.context.contextWindow, 128000, 'hop omitted context -> cached/first-hop-free fallback to the floor')
})

test('resolveModel uses the floor when there is no chain at all', async () => {
  const adapter = adapterWith({ chains: { smart: [] }, routes: [] })
  const info = await adapter.resolveModel('smart', 'smart')
  assert.equal(info.context.contextWindow, 128000, 'no-chain branch must still advertise a capacity')
})

test('resolveModel without runtime.resolveModelInfo still advertises the floor capacity', async () => {
  const runtime = runtimeWith()
  delete runtime.resolveModelInfo // pre-capability runtime
  const adapter = adapterWith({
    chains: { smart: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
    runtime,
  })
  const info = await adapter.resolveModel('smart', 'smart')
  // The no-capability branch reads the cached route window for the first hop.
  assert.equal(info.context.contextWindow, 200000)
})

// ---------------------------------------------------------------------------
// 3. Single-segment chains, legacy composite ids, capability passthrough, effort injection
// ---------------------------------------------------------------------------

function tierFixture() {
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [...MANUAL_EFFORT_IDS] } }
    },
    imageRequestPricing() { return undefined },
  }
  const routes = [{ provider: 'p', models: [
    { id: 'm', contextWindow: 200000, reasoning: { efforts: [...MANUAL_EFFORT_IDS] } },
  ] }]
  const adapter = new SmartAdapter({
    runtime, routes,
    chains: {
      balanced: [{ provider: 'p', model: 'm' }],
      cost: [{ provider: 'p', model: 'm' }],
      speed: [{ provider: 'p', model: 'm' }],
      smart: [{ provider: 'p', model: 'm' }],
    },
  })
  return { adapter, seen }
}

test('composite ids normalize to single-segment tiers before chain resolution', () => {
  const { adapter } = tierFixture()
  // withTierChains is a pass-through: no <tier>/<effort> derived keys exist.
  assert.equal(Object.hasOwn(adapter.chains, 'cost/high'), false)
  for (const [id, tier] of [
    ['cost/high', 'cost'],
    ['balanced/off', 'balanced'],
    ['smart/medium', 'smart'],
    ['auto/medium', 'smart'], // legacy model alias auto -> smart
  ]) {
    const parsed = parseTierId(id)
    assert.equal(parsed.tier, tier, id)
    assert.deepEqual(resolveChain(parsed.tier, adapter.chains), [{ provider: 'p', model: 'm' }], id)
  }
})

test('resolveModel on a legacy combined id returns real first-hop reasoning.efforts verbatim', async () => {
  const { adapter } = tierFixture()
  const info = await adapter.resolveModel('smart', 'cost/high')
  assert.equal(info.provider, 'smart')
  assert.equal(info.id, 'cost/high', 'host keeps the full id it asked for')
  assert.deepEqual(info.reasoning.efforts, [...MANUAL_EFFORT_IDS])
  assert.equal(info.context.contextWindow, 200000)
})

test('stream materializes mapped effort and forwards all other options untouched', async () => {
  const { adapter, seen } = tierFixture()
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'cost/high', sessionId: 's1', temperature: 0.3 })) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], {
    model: 'm', provider: 'p', sessionId: 's1', temperature: 0.3, reasoningEffort: 'high',
  })
})

test('stream reads strength from defaultEffort for a single-segment model id', async () => {
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    imageRequestPricing() { return undefined },
  }
  const routes = [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: [...MANUAL_EFFORT_IDS] } }] }]
  const chains = { cost: [{ provider: 'p', model: 'm' }] }
  const manual = new SmartAdapter({ runtime, routes, chains, defaultEffort: 'high' })
  for await (const _ of manual.stream({ model: 'cost' })) { /* drain */ }
  assert.equal(seen[0].reasoningEffort, 'high', 'schema.defaultEffort supplies strength when the id has no effort suffix')

  seen.length = 0
  const auto = new SmartAdapter({ runtime, routes, chains, defaultEffort: 'auto' })
  for await (const _ of auto.stream({ model: 'cost' })) { /* drain */ }
  assert.equal(seen[0].reasoningEffort, 'off', 'auto stays dynamic: cost-model bias + general task picks off')
})

// ---------------------------------------------------------------------------
// 3b. auto-effort leak regression: the host materializes the catalog's
// defaultEffort='auto' into options; a free first hop with NO reasoning support
// must receive NO reasoningEffort key at all (not even the literal 'auto').
// ---------------------------------------------------------------------------

/** Stream fixture whose runtime.stream records the exact options it receives. */
function effortStreamFixture(efforts) {
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    imageRequestPricing() { return undefined },
  }
  const model = { id: 'm', contextWindow: 200000, ...(efforts ? { reasoning: { efforts } } : {}) }
  const routes = [{ provider: 'p', models: [model] }]
  const chains = { smart: [{ provider: 'p', model: 'm' }] }
  const adapter = new SmartAdapter({ runtime, routes, chains })
  return { adapter, seen }
}

test('stream auto effort on a chain with no reasoning support omits the reasoningEffort key entirely', async () => {
  const { adapter, seen } = effortStreamFixture(undefined)
  for await (const _ of adapter.stream({ model: 'smart', sessionId: 's-auto-free', reasoningEffort: 'auto', messages: [{ content: 'hi' }] })) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(Object.hasOwn(seen[0], 'reasoningEffort'), false,
    'auto on a no-reasoning free hop must strip the inherited key; leaking "auto" is the release-blocking bug')
  assert.equal(seen[0].sessionId, 's-auto-free', 'every other option is forwarded untouched')
})

test('stream auto effort on a reasoning-capable chain injects a concrete supported value', async () => {
  const supported = ['low', 'high']
  const { adapter, seen } = effortStreamFixture(supported)
  for await (const _ of adapter.stream({ model: 'smart', reasoningEffort: 'auto', messages: [{ content: 'hi' }] })) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.ok(supported.includes(seen[0].reasoningEffort) && seen[0].reasoningEffort !== 'auto',
    `auto must resolve to a supported concrete effort, got ${String(seen[0].reasoningEffort)}`)
})

test('stream native manual effort on a chain with no reasoning support degrades to off', async () => {
  const { adapter, seen } = effortStreamFixture(undefined)
  for await (const _ of adapter.stream({ model: 'smart', reasoningEffort: 'high', messages: [{ content: 'hi' }] })) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reasoningEffort, 'off',
    'manual high on an incapable chain degrades to the legal off value, never faked onto the free hop')
})

test('effort mapping uses cached support: medium->low, off->off, no clamp on unsupported', async () => {
  const routes = [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: ['off', 'low', 'high'] } }] }]
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    imageRequestPricing() { return undefined },
  }
  const chains = {
    balanced: [{ provider: 'p', model: 'm' }],
    cost: [{ provider: 'p', model: 'm' }],
    speed: [{ provider: 'p', model: 'm' }],
    smart: [{ provider: 'p', model: 'm' }],
  }
  const adapter = new SmartAdapter({ runtime, routes, chains })
  for await (const _ of adapter.stream({ model: 'cost/medium' })) { /* drain */ }
  assert.equal(seen[0].reasoningEffort, 'low')
  for await (const _ of adapter.stream({ model: 'cost/off' })) { /* drain */ }
  assert.equal(seen[1].reasoningEffort, 'off')

  const narrow = new SmartAdapter({
    runtime,
    routes: [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: ['off', 'low'] } }] }],
    chains,
  })
  const finishes = []
  for await (const chunk of narrow.stream({ model: 'cost/high' })) finishes.push(chunk)
  assert.equal(finishes.at(-1).reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT')

  // The new manual ids low/max are honored, never fabricated on a narrow chain.
  assert.equal(mapEffort('low', new Set(['off', 'low', 'high'])), 'low')
  assert.equal(mapEffort('max', new Set(['off', 'low'])), undefined, 'max falls back to high only when high is supported')
  // Pure helpers also stay honest on unknown capability sets.
  assert.equal(supportedEfforts([], [{ provider: 'p', model: 'm' }]).size, 0)
  assert.equal(mapEffort('high', new Set(['off', 'low'])), undefined)
})
