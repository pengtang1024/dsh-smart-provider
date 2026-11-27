/**
 * task-5: virtual-model contextWindow tests.
 *
 * The host's compaction preflight (compactPressure in dsh-session) resolves
 * resolveModelInfo(smart/<id>) and REFUSES the model switch when
 * `info.context === undefined` ("compaction-basic: no context capacity for
 * smart/<id>"). Both catalog surfaces must therefore always carry a real,
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
import { supportedEfforts, mapEffort } from '../lib/tier-ids.js'

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

test('listModels backfills contextWindow from the first hop discovered route', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }], cost: [{ provider: 'hopA', model: 'big' }], balanced: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const byId = new Map(models.map(m => [m.id, m]))
  const ids = ['auto', 'cost', 'balanced'].flatMap(t => ['off', 'medium', 'high'].map(e => t + '/' + e))
  assert.deepEqual(models.map(m => m.id), ids, 'catalog is the fixed 9-id cartesian product')
  assert.equal(byId.get('auto/high').contextWindow, 200000, 'auto variants inherit the first hop real window')
  assert.equal(byId.get('cost/off').contextWindow, 200000, 'cost variants resolve through the outer tier chain')
  assert.equal(byId.get('balanced/medium').contextWindow, 200000, 'balanced variants resolve through the outer tier chain')
  for (const m of models) {
    assert.equal(m.provider, 'smart')
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, `every virtual model carries a positive contextWindow (${m.id})`)
    assert.ok(m.name.startsWith('Smart '), `display name uses free text, not a locale key (${m.id})`)
  }
})

test('listModels falls back to the conservative floor when the route cache lacks the hop', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopB', model: 'plain-string-model' }] },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const auto = models.find(m => m.id === 'auto/off')
  // hopB's entry is a bare string (no contextWindow in the cache at all).
  assert.equal(auto.contextWindow, 128000, 'bare-string cache entry falls back to the 128k floor')
})

test('listModels falls back to the floor when discovery has not run yet (routes empty)', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: [], // refreshDiscoveredChains has not fired yet
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'auto/off').contextWindow, 128000)
})

test('listModels ignores malformed cached windows instead of propagating them', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: [{ provider: 'hopA', models: [{ id: 'big', contextWindow: -5 }] }],
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'auto/off').contextWindow, 128000, 'negative/zero windows fall back, never propagate')
})

// ---------------------------------------------------------------------------
// 2. resolveModel: first-hop truth, honest backfill on both fallback branches
// ---------------------------------------------------------------------------

test('resolveModel keeps the real first-hop contextWindow verbatim', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
    runtime: runtimeWith({ windows: { 'hopA/big': 200000 } }),
  })
  const info = await adapter.resolveModel('smart', 'auto')
  assert.deepEqual(info.context, { contextWindow: 200000 })
  assert.equal(info.provider, 'smart')
  assert.equal(info.id, 'auto')
})

test('resolveModel backfills the cached window when the hop catalog omits it', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'small' }] },
    routes: discoveredRoutes, // 'small' cached WITHOUT contextWindow
    runtime: runtimeWith({ windows: {} }), // runtime resolveModelInfo omits context too
  })
  const info = await adapter.resolveModel('smart', 'auto')
  assert.equal(info.context.contextWindow, 128000, 'hop omitted context -> cached/first-hop-free fallback to the floor')
})

test('resolveModel uses the floor when there is no chain at all', async () => {
  const adapter = adapterWith({ chains: { auto: [] }, routes: [] })
  const info = await adapter.resolveModel('smart', 'auto')
  assert.equal(info.context.contextWindow, 128000, 'no-chain branch must still advertise a capacity')
})

test('resolveModel without runtime.resolveModelInfo still advertises the floor capacity', async () => {
  const runtime = runtimeWith()
  delete runtime.resolveModelInfo // pre-capability runtime
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
    runtime,
  })
  const info = await adapter.resolveModel('smart', 'auto')
  // The no-capability branch reads the cached route window for the first hop.
  assert.equal(info.context.contextWindow, 200000)
})

// ---------------------------------------------------------------------------
// 3. Combined tier ids: derived chains, capability passthrough, effort injection
// ---------------------------------------------------------------------------

function tierFixture() {
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: ['off', 'medium', 'high'] } }
    },
    imageRequestPricing() { return undefined },
  }
  const routes = [{ provider: 'p', models: [
    { id: 'm', contextWindow: 200000, reasoning: { efforts: ['off', 'medium', 'high'] } },
  ] }]
  const adapter = new SmartAdapter({
    runtime, routes,
    chains: {
      auto: [{ provider: 'p', model: 'm' }],
      cost: [{ provider: 'p', model: 'm' }],
      balanced: [{ provider: 'p', model: 'm' }],
    },
  })
  return { adapter, seen }
}

test('combined ids resolve through derived outer-tier chains (never vendor/model)', () => {
  const { adapter } = tierFixture()
  assert.deepEqual(resolveChain('cost/high', adapter.chains), resolveChain('cost', adapter.chains))
  assert.deepEqual(resolveChain('balanced/off', adapter.chains), resolveChain('balanced', adapter.chains))
  assert.deepEqual(resolveChain('auto/medium', adapter.chains), resolveChain('auto', adapter.chains))
})

test('resolveModel on a combined id returns real first-hop reasoning.efforts verbatim', async () => {
  const { adapter } = tierFixture()
  const info = await adapter.resolveModel('smart', 'cost/high')
  assert.equal(info.provider, 'smart')
  assert.equal(info.id, 'cost/high', 'host keeps the full combined id')
  assert.deepEqual(info.reasoning.efforts, ['off', 'medium', 'high'])
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

test('effort mapping uses cached support: medium->low, off->off, no clamp on unsupported', async () => {
  const routes = [{ provider: 'p', models: [{ id: 'm', reasoning: { efforts: ['off', 'low', 'high'] } }] }]
  const seen = []
  const runtime = {
    resolveRetryPolicy: config => config,
    async *stream(options) { seen.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
    imageRequestPricing() { return undefined },
  }
  const chains = { auto: [{ provider: 'p', model: 'm' }], cost: [{ provider: 'p', model: 'm' }], balanced: [{ provider: 'p', model: 'm' }] }
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

  // Pure helpers also stay honest on unknown capability sets.
  assert.equal(supportedEfforts([], [{ provider: 'p', model: 'm' }]).size, 0)
  assert.equal(mapEffort('high', new Set(['off', 'low'])), undefined)
})
