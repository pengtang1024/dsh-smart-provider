/**
 * Load-path regression tests.
 *
 * These guard the two packaging defects the headless E2E exposed (a profile
 * that ships neither an extra plugin-carrying copy of the DSH packages nor a
 * `credentials` service):
 *
 *  1. lib/remote.js imported @deepseek-ai/dsh-typert-protocol with a bare ESM
 *     import. That only resolves when the profile's resolution map happens to
 *     contain the package; a freshly linked bundle in a lean profile failed
 *     with ERR_MODULE_NOT_FOUND, the plugin never activated, and the host
 *     reported NO_ADAPTER. It now falls back to the lib/dsh.js manifest anchors.
 *  2. index.js declared sessions/commands/credentials as hard injects even
 *     though every use is defensive, so a lean profile stalled at
 *     "pending (waiting for service: credentials)". Only `llm` is required now.
 *
 * Must run on the Electron runtime (app.asar is not readable by plain Node):
 *
 *   ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/loading.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('index.js injects only the llm service (optional services are read lazily)', async () => {
  const { inject, Config, apply } = await import('../index.js')
  assert.deepEqual(inject, ['llm'], 'a lean profile has no sessions/commands/credentials service')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('schema.js resolves schemastery through the shared anchors and exposes the config', async () => {
  const { Config } = await import('../schema.js')
  const config = Config({})
  assert.deepEqual(
    Object.keys(config).sort(),
    ['accounts', 'chains', 'costBatchSize', 'costDir', 'costEnabled', 'costFlushIntervalMs', 'costPillEnabled', 'costPillPosition', 'costPillRefreshMs', 'health', 'ranking', 'routing'],
  )
})

test('remote.js loads the Typert base class without a profile-local copy', async () => {
  // No profile in the test environment provides dsh-typert-protocol as a
  // direct dependency, so a successful import proves the anchor fallback runs.
  const { SmartProviderRemote } = await import('../lib/remote.js')
  assert.equal(typeof SmartProviderRemote, 'function')
  assert.ok(SmartProviderRemote.prototype instanceof Object)

  const marker = Object.getOwnPropertyDescriptor(
    SmartProviderRemote.prototype,
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )
  assert.ok(marker, 'the @Remote marker must be attached to the class prototype')
  assert.equal(marker.value.version, 1)
  assert.deepEqual(
    marker.value.methods.map(entry => entry.method),
    ['cost', 'costDetail', 'availabilityStatus', 'probeModels', 'accountHealth', 'modelPositions', 'statsSince', 'clearStats'],
  )
})

test('remote.js still exports the ledger readers the service delegates to', async () => {
  const remote = await import('../lib/remote.js')
  assert.equal(typeof remote.readCostStats, 'function')
  assert.equal(typeof remote.readCostDetail, 'function')
})
