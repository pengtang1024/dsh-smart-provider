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
    chains: { auto: [{ provider: 'hopA', model: 'big' }], fast: [{ provider: 'hopA', model: 'big' }] },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const byId = new Map(models.map(m => [m.id, m]))
  assert.equal(byId.get('auto').contextWindow, 200000, 'auto inherits the first hop real window')
  assert.equal(byId.get('fast').contextWindow, 200000, 'alias chains inherit the same window')
  for (const m of models) {
    assert.equal(m.provider, 'smart')
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, `every virtual model carries a positive contextWindow (${m.id})`)
  }
})

test('listModels falls back to the conservative floor when the route cache lacks the hop', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopB', model: 'plain-string-model' }] },
    routes: discoveredRoutes,
  })
  const models = await adapter.listModels('smart')
  const auto = models.find(m => m.id === 'auto')
  // hopB's entry is a bare string (no contextWindow in the cache at all).
  assert.equal(auto.contextWindow, 128000, 'bare-string cache entry falls back to the 128k floor')
})

test('listModels falls back to the floor when discovery has not run yet (routes empty)', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: [], // refreshDiscoveredChains has not fired yet
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'auto').contextWindow, 128000)
})

test('listModels ignores malformed cached windows instead of propagating them', async () => {
  const adapter = adapterWith({
    chains: { auto: [{ provider: 'hopA', model: 'big' }] },
    routes: [{ provider: 'hopA', models: [{ id: 'big', contextWindow: -5 }] }],
  })
  const models = await adapter.listModels('smart')
  assert.equal(models.find(m => m.id === 'auto').contextWindow, 128000, 'negative/zero windows fall back, never propagate')
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
