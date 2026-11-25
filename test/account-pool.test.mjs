/**
 * Regression tests for the dsh-smart-provider account-pool refactor.
 *
 * Run with the DSH asar-aware runtime (SmartAdapter extends the real LlmAdapter
 * loaded from the DSH installation):
 *
 *   ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
 *     node --test test/account-pool.test.mjs
 *
 * No real network calls: `runtime.stream` is stubbed with scripted chunks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { SmartAdapter } from '../lib/adapter.js'
import { AccountPool, normalizeAccounts, implicitAccountId } from '../lib/account-pool.js'

const dshRequire = createRequire('/opt/DSH NEXT/resources/app.asar/package.json')

/** A minimal fake runtime: stream routes to a per-(provider,model) script. */
function fakeRuntime(scripts) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push({ provider: options.provider, model: options.model, sessionId: options.sessionId })
      const script = scripts[`${options.provider}/${options.model}`]
      const chunks = script ? [...script] : [
        { type: 'text-delta', text: 'ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
    resolveRetryPolicy(config) { return config },
    resolveModelInfo(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
    imageRequestPricing() { return undefined },
  }
}

/** A fake meter that mirrors CostMeter's accountId -> account_id field mapping. */
function fakeMeter() {
  const rows = []
  return {
    rows,
    record: ({ accountId, failureCode, ...row }) =>
      rows.push({ ...row, account_id: accountId, failure_code: failureCode }),
    close: async () => {},
  }
}

function failureChunk(code) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message: code } } }
}

async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'auto', sessionId: 's1', ...options })) {
    chunks.push(chunk)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// AccountPool pure-logic tests
// ---------------------------------------------------------------------------

test('normalizeAccounts keeps valid accounts and drops invalid ones', () => {
  const accounts = normalizeAccounts([
    { id: 'a', provider: 'opencode-go', credentialRef: 'KEY_A', models: ['m1', 'm2'] },
    { id: 'a', provider: 'opencode-go', models: ['m3'] }, // duplicate id -> dropped
    { id: 'b', provider: 'opencode-alt', models: [] },    // no models -> dropped
    { id: '', provider: 'x', models: ['m1'] },            // no id -> dropped
  ])
  assert.deepEqual(accounts.map(a => a.id), ['a'])
  assert.deepEqual(accounts[0].models, ['m1', 'm2'])
})

test('implicit pool is 1:1 with chain hops (backward compatible shape)', () => {
  const chains = { auto: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }] }
  const pool = new AccountPool({ chains })
  assert.equal(pool.configured, false)
  assert.equal(pool.accountsFor('m1').length, 1)
  assert.equal(pool.accountsFor('m1')[0].id, implicitAccountId('p1', 'm1'))
  const plan = pool.plan(chains.auto)
  assert.deepEqual(plan.map(a => a.account.id), ['hop:p1/m1', 'hop:p2/m2'])
})

test('explicit pool groups multiple accounts under one model', () => {
  const chains = { auto: [{ provider: 'opencode-go', model: 'm1' }] }
  const accounts = [
    { id: 'acctA', provider: 'opencode-go', models: ['m1'] },
    { id: 'acctB', provider: 'opencode-go-alt', models: ['m1'] },
  ]
  const pool = new AccountPool({ chains, accounts })
  assert.equal(pool.configured, true)
  const plan = pool.plan(chains.auto)
  assert.deepEqual(plan.map(a => a.account.id), ['acctA', 'acctB'])
})

test('partial pool: models without configured accounts keep an implicit fallback', () => {
  const chains = {
    auto: [
      { provider: 'opencode-go', model: 'm1' },
      { provider: 'opencode-go', model: 'm2' },
    ],
  }
  const accounts = [{ id: 'acctA', provider: 'opencode-go', models: ['m1'] }]
  const pool = new AccountPool({ chains, accounts })
  const plan = pool.plan(chains.auto)
  assert.deepEqual(plan.map(a => a.account.id), ['acctA', 'hop:opencode-go/m2'])
})

// ---------------------------------------------------------------------------
// SmartAdapter integration tests
// ---------------------------------------------------------------------------

const POOL_CHAINS = { auto: [{ provider: 'opencode-go', model: 'm1' }] }
const POOL_ACCOUNTS = [
  { id: 'acctA', provider: 'opencode-go', credentialRef: 'KEY_A(masked)', models: ['m1'] },
  { id: 'acctB', provider: 'opencode-go-alt', credentialRef: 'KEY_B(masked)', models: ['m1'] },
]

test('A fails (402) then B succeeds — account failover within the same model', async () => {
  const runtime = fakeRuntime({
    'opencode-go/m1': [failureChunk('QUOTA')],
    'opencode-go-alt/m1': [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  const meter = fakeMeter()
  const adapter = new SmartAdapter({ runtime, chains: POOL_CHAINS, accounts: POOL_ACCOUNTS, meter })
  const chunks = await collect(adapter)

  assert.deepEqual(runtime.calls.map(c => c.provider), ['opencode-go', 'opencode-go-alt'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(meter.rows.map(r => r.account_id), ['acctA', 'acctB'])
  assert.deepEqual(meter.rows.map(r => r.failure_code), ['QUOTA', null])
})

test('account-level cooldown: a 402 on A does not freeze B on a later request', async () => {
  const runtime = fakeRuntime({ 'opencode-go/m1': [failureChunk('QUOTA')] })
  const meter = fakeMeter()
  const adapter = new SmartAdapter({ runtime, chains: POOL_CHAINS, accounts: POOL_ACCOUNTS, meter })

  // First request: A 402s, B succeeds. A now has an account-level cooldown.
  const first = await collect(adapter)
  assert.equal(first.at(-1).reason.kind, 'stop')
  assert.deepEqual([...adapter.cooldowns.keys()], ['acctA'])

  // Second request: A is cooled down and must be skipped entirely; B used.
  runtime.calls.length = 0
  const second = await collect(adapter)
  assert.deepEqual(runtime.calls.map(c => c.provider), ['opencode-go-alt'])
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.ok(adapter.cooldowns.get('acctA').until > Date.now())
})

test('model-level fallback still works without a pool (legacy behavior)', async () => {
  const chains = {
    auto: [
      { provider: 'opencode-go', model: 'm1' },
      { provider: 'opencode-go', model: 'm2' },
    ],
  }
  const runtime = fakeRuntime({ 'opencode-go/m1': [failureChunk('UNKNOWN_MODEL')] })
  const meter = fakeMeter()
  const adapter = new SmartAdapter({ runtime, chains, meter })

  const chunks = await collect(adapter)
  assert.deepEqual(runtime.calls.map(c => `${c.provider}/${c.model}`), ['opencode-go/m1', 'opencode-go/m2'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // Implicit account ids retain the legacy hop identity.
  assert.deepEqual(meter.rows.map(r => r.account_id), ['hop:opencode-go/m1', 'hop:opencode-go/m2'])
})

test('no pool config: single-account chain behaves exactly as before', async () => {
  const runtime = fakeRuntime({})
  const meter = fakeMeter()
  const adapter = new SmartAdapter({ runtime, chains: { auto: [{ provider: 'p', model: 'm' }] }, meter })
  const chunks = await collect(adapter)
  assert.deepEqual(runtime.calls.map(c => `${c.provider}/${c.model}`), ['p/m'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(meter.rows.length, 1)
  assert.equal(meter.rows[0].account_id, 'hop:p/m')
})

test('hop-selected session record includes accountId', async () => {
  const { Session, pluginRecordOf } = dshRequire('@deepseek-ai/dsh-session')
  const session = new Session('test-session')
  const sessions = { get: id => (id === 'test-session' ? session : undefined) }
  const runtime = fakeRuntime({})
  const adapter = new SmartAdapter({
    runtime, chains: POOL_CHAINS, accounts: POOL_ACCOUNTS, sessions, meter: fakeMeter(),
  })

  await collect(adapter, { sessionId: 'test-session' })
  const records = session.log.map(pluginRecordOf).filter(Boolean)
  assert.equal(records.length, 1)
  assert.equal(records[0].data.accountId, 'acctA')
  assert.equal(records[0].data.provider, 'opencode-go')
  assert.equal(records[0].data.model, 'm1')
})

test('all accounts cooling down yields a RATE_LIMIT error without any call', async () => {
  const runtime = fakeRuntime({})
  const adapter = new SmartAdapter({ runtime, chains: POOL_CHAINS, accounts: POOL_ACCOUNTS, meter: fakeMeter() })
  const future = Date.now() + 60_000
  adapter.cooldowns.set('acctA', { until: future, reason: 'QUOTA' })
  adapter.cooldowns.set('acctB', { until: future, reason: 'QUOTA' })

  const chunks = await collect(adapter)
  assert.equal(runtime.calls.length, 0)
  assert.equal(chunks.at(-1).reason.failure.code, 'RATE_LIMIT')
})
