/**
 * Regression tests for task-6 cold-start health-evidence hydration.
 *
 *   lib/health-persistence.js  →  lib/availability.js (L1) + lib/account-health.js (L2)
 *
 * The module under test is pure logic plus READ-ONLY fs access; every ledger is
 * written to a throwaway temp dir, so plain node is enough:
 *
 *   node --test test/persistence.test.mjs
 *
 * Coverage required by the task card: normal hydration, missing files, corrupt
 * lines, bound truncation, health=false (no hydration), and "new live evidence
 * wins over replayed history".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'

import { buildHealthDeps } from '../lib/health-setup.js'
import {
  updateHealth, healthOf, billingTierOf, registryKey, HEALTH, BILLING_TIER,
} from '../lib/availability.js'
import { getRecord, stateOf, noteSuccess, ACCOUNT_STATES } from '../lib/account-health.js'
import {
  DEFAULT_HYDRATION_BOUNDS,
  readLedgerWindow,
  parseLedgerRows,
  hydrateRouteEvidence,
  hydrateAccountEvidence,
  hydrateProbeEvidence,
  hydrateHealthEvidence,
} from '../lib/health-persistence.js'

const HOUR = 60 * 60 * 1000

/** A cost.jsonl-shaped row (the fields hydration reads). */
function ledgerRow({
  provider = 'route-a', model = 'model-x', cost = 0, failure = null,
  message = null, at = Date.now(), account = 'acct-1', priceKnown = false,
} = {}) {
  const row = {
    timestamp: new Date(at).toISOString(),
    outer_model: 'auto',
    actual_provider: provider,
    actual_model: model,
    account_id: account,
    input_tokens: 10,
    output_tokens: 5,
    estimated_cost_usd: cost,
    hop_index: 0,
    failure_code: failure,
    failure_message: message,
  }
  if (priceKnown !== null) row.price_known = priceKnown
  return JSON.stringify(row)
}

/** mkdtemp + guaranteed cleanup. */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'smart-health-persist-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Capture every info/warn line the hydration pass emits. */
function spyLogger() {
  const info = []
  const warn = []
  return { info, warn, infoFn: message => info.push(message), warnFn: message => warn.push(message) }
}

// ===========================================================================
// 1. Normal hydration — evidence really comes back
// ===========================================================================

test('hydrates L1 billing/health and L2 account state from cost.jsonl', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = []
    // 20 zero-cost successes: enough ledger-only evidence for a medium-confidence
    // free tier (§7 FREE_LEDGER_SAMPLES = 20) and HEALTHY via updateHealth().
    for (let i = 0; i < 20; i++) lines.push(ledgerRow({ at: now - (20 - i) * 1000, priceKnown: true }))
    // One account-level quota failure: cools THAT account, must not lower model health.
    // Distinct timestamp: a row older than the newest success row would lose the
    // timestamp guard (that behaviour has its own test).
    lines.push(ledgerRow({ failure: 'QUOTA', message: 'insufficient balance', at: now, account: 'acct-quota' }))
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({})
    const availability = health.availabilityRegistry
    // The adapter keeps this exact object reference (adapter.js:181) — hydration
    // must fill it in place, never swap it.
    const accountRegistry = health.accountHealth
    const log = spyLogger()

    const summary = await hydrateHealthEvidence({
      dir, health, info: log.infoFn, warn: log.warnFn,
    })

    assert.equal(summary.hydrated, true)
    assert.equal(summary.cost.rows, 21)
    assert.equal(summary.cost.route.replayed, 21)
    assert.equal(summary.cost.malformed, 0)
    assert.equal(summary.cost.route.skipped, 0)
    assert.equal(summary.cost.account.accounts, 2, 'two account_ids -> two L2 records')
    assert.equal(health.accountHealth, accountRegistry, 'registry identity is preserved')
    assert.equal(health.availabilityRegistry, availability)

    const key = { provider: 'route-a', modelId: 'model-x' }
    const route = healthOf(availability, key)
    assert.equal(route.health, HEALTH.HEALTHY, 'L1 health evidence is back after a reload')
    assert.ok(route.confidence > 0)
    const tier = billingTierOf(availability, key)
    assert.equal(tier.tier, BILLING_TIER.FREE, '20 zero-cost rows -> proven free tier')
    assert.equal(tier.confidence, 0.7, 'ledger-only free is medium confidence, never high')

    assert.equal(getRecord(accountRegistry, 'acct-1').state, ACCOUNT_STATES.ACTIVE)
    assert.equal(getRecord(accountRegistry, 'acct-1').samples.success, 20)
    // L2 cooldown is reconstructed from the quota row (30 min from its timestamp).
    const cooling = getRecord(accountRegistry, 'acct-quota')
    assert.equal(cooling.reason, 'QUOTA')
    assert.equal(cooling.streak, 1)
    assert.equal(stateOf(accountRegistry, 'acct-quota', now), ACCOUNT_STATES.COOLING,
      'a persisted quota failure still cools the account after a restart')
    // Account failure never drags the MODEL down (§3 layering holds on replay).
    assert.equal(healthOf(availability, key).health, HEALTH.HEALTHY)

    assert.equal(log.info.length, 1, 'exactly one info line reports the pass')
    assert.match(log.info[0], /rows=21/)
    assert.match(log.info[0], /replayed\(L1\)=21/)
    assert.match(log.info[0], /skipped/)
    assert.match(log.info[0], /L2 accounts=2/)
    assert.deepEqual(log.warn, [])
  })
})

test('replays a server-jitter streak to DEGRADED and a rename to DEPRECATED', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = [
      // 3 jitter samples with a 5xx fingerprint -> DEGRADED (JITTER_THRESHOLD = 3).
      ledgerRow({ model: 'model-flaky', failure: 'SERVER', message: 'upstream 502 bad gateway', at: now - 3000 }),
      ledgerRow({ model: 'model-flaky', failure: 'SERVER', message: 'upstream 502 bad gateway', at: now - 2000 }),
      ledgerRow({ model: 'model-flaky', failure: 'SERVER', message: 'upstream 502 bad gateway', at: now - 1000 }),
      // A rename: normalized-equal id against the live id list -> RENAMED/DEPRECATED.
      ledgerRow({ model: 'model-x-free', failure: 'UNKNOWN_MODEL', message: 'unknown model', at: now - 500 }),
    ]
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({ health: { currentIdList: ['model-x'] } })
    await hydrateHealthEvidence({ dir, health })

    const registry = health.availabilityRegistry
    assert.equal(healthOf(registry, { provider: 'route-a', modelId: 'model-flaky' }).health, HEALTH.DEGRADED)
    const deprecated = registry[registryKey({ provider: 'route-a', modelId: 'model-x-free' })]
    assert.equal(deprecated.health, HEALTH.DEPRECATED)
    assert.equal(deprecated.billingTier, BILLING_TIER.UNKNOWN, 'a rename voids billing evidence (§4.1)')
  })
})

test('hydrates probe verdicts into L1 with high billing confidence, latest row wins', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const probe = [
      { provider: 'workbuddy', model: 'hy-free', verdict: 'unknown', evidence: 'no usage signal', ok: false, probedAt: now - 5000, cost: 0 },
      { provider: 'workbuddy', model: 'hy-free', verdict: 'free', evidence: 'cost=0 + free source', ok: true, probedAt: now - 4000, cost: 0 },
      { provider: 'workbuddy', model: 'hy-free', verdict: 'free', evidence: 'cost=0 + free source', ok: true, probedAt: now - 3000, cost: 0 },
      { provider: 'workbuddy', model: 'hy-paid', verdict: 'metered', evidence: 'cost=0.002', ok: true, probedAt: now - 2000, cost: 0.002 },
    ]
    await writeFile(join(dir, 'probe-cache.jsonl'), probe.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({})
    const log = spyLogger()
    const summary = await hydrateHealthEvidence({ dir, health, info: log.infoFn })

    assert.equal(summary.probe.rows, 4)
    assert.equal(summary.probe.duplicate, 2, 'the two older rows for one tuple are dropped')
    assert.equal(summary.probe.replayed, 2)
    assert.equal(summary.cost.missing, true, 'no cost.jsonl is a normal cold start')
    assert.equal(summary.probe.missing, false)

    const registry = health.availabilityRegistry
    const free = billingTierOf(registry, { provider: 'workbuddy', modelId: 'hy-free' })
    assert.equal(free.tier, BILLING_TIER.FREE)
    assert.equal(free.confidence, 0.95, 'an upstream-confirmed free verdict keeps high confidence')
    const metered = billingTierOf(registry, { provider: 'workbuddy', modelId: 'hy-paid' })
    assert.equal(metered.tier, BILLING_TIER.METERED)
    assert.equal(metered.confidence, 0.95)
    assert.match(log.info[0], /probe-cache\.jsonl rows=4 replayed=2/)
  })
})

test('replays L1 at (provider,modelId) granularity, never grouped by bare model', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = [
      ledgerRow({ provider: 'route-a', model: 'shared', cost: 0, at: now - 2000 }),
      ledgerRow({ provider: 'route-b', model: 'shared', failure: 'AUTH', message: 'invalid api key', at: now - 1000 }),
    ]
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')
    const health = buildHealthDeps({})
    await hydrateHealthEvidence({ dir, health })
    const registry = health.availabilityRegistry
    assert.deepEqual(Object.keys(registry).sort(), ['route-a::shared', 'route-b::shared'])
    assert.equal(healthOf(registry, { provider: 'route-a', modelId: 'shared' }).health, HEALTH.HEALTHY)
    assert.equal(registry['route-a::shared'].samples.failure, 0)
    assert.equal(registry['route-b::shared'].samples.failure, 1, 'the AUTH sample belongs to its own tuple')
  })
})

// ===========================================================================
// 2. Missing files — no throw, no evidence, still one honest info line
// ===========================================================================

test('missing ledgers are a normal cold start: no throw, nothing hydrated', async () => {
  await withTempDir(async dir => {
    const health = buildHealthDeps({})
    const log = spyLogger()
    const summary = await hydrateHealthEvidence({ dir, health, info: log.infoFn, warn: log.warnFn })

    assert.equal(summary.hydrated, true)
    assert.equal(summary.cost.missing, true)
    assert.equal(summary.probe.missing, true)
    assert.equal(summary.cost.rows, 0)
    assert.equal(summary.cost.route.replayed, 0)
    assert.deepEqual(health.availabilityRegistry, {}, 'an empty ledger leaves the registry untouched')
    assert.equal(health.accountHealth.records.size, 0)
    assert.deepEqual(log.warn, [], 'ENOENT is not a warning')
    assert.match(log.info[0], /rows=0/)
  })
})

test('a missing DIRECTORY is also tolerated (first run ever)', async () => {
  await withTempDir(async dir => {
    const health = buildHealthDeps({})
    const summary = await hydrateHealthEvidence({ dir: join(dir, 'does-not-exist'), health })
    assert.equal(summary.hydrated, true)
    assert.equal(summary.cost.missing, true)
    assert.equal(summary.probe.missing, true)
  })
})

// ===========================================================================
// 3. Corrupt / partial lines — counted, never thrown
// ===========================================================================

test('corrupt, half-written and non-row lines are skipped and counted', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = [
      ledgerRow({ model: 'first', at: now - 3000 }),
      'not json at all',
      '{"timestamp":"2026-11-25T00:00:00.000Z","actual_provider":"ro',
      '',
      '[1,2,3]',
      '{"timestamp":"2026-11-25T00:00:00.000Z","actual_provider":"route-a"}',
      ledgerRow({ model: 'second', at: now - 1000 }),
    ]
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({})
    const log = spyLogger()
    const summary = await hydrateHealthEvidence({ dir, health, info: log.infoFn, warn: log.warnFn })

    assert.equal(summary.cost.malformed, 3, 'garbage, half line and array are all malformed')
    assert.equal(summary.cost.route.noKey, 1)
    assert.equal(summary.cost.route.replayed, 2, 'the two well-formed rows still replay')
    assert.equal(Object.keys(health.availabilityRegistry).length, 2)
    assert.match(log.info[0], /malformed=3/)
    assert.match(log.info[0], /no-key=1/)
    assert.match(log.info[0], /skipped\(L1\)=1/, 'only the no-key row is an L1 skip')
    assert.match(log.info[0], /total skipped rows=4/, 'malformed lines are counted in the total')
  })
})

test('a truncated last line (process killed mid-append) does not break cold start', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const text = ledgerRow({ model: 'model-x', at: now - 1000 }) + '\n' + '{"timestamp":"2026-11-2'
    await writeFile(join(dir, 'cost.jsonl'), text, 'utf8')
    const health = buildHealthDeps({})
    const log = spyLogger()
    const summary = await hydrateHealthEvidence({ dir, health, info: log.infoFn })
    assert.equal(summary.cost.route.replayed, 1)
    assert.equal(summary.cost.malformed, 1)
    assert.equal(healthOf(health.availabilityRegistry, { provider: 'route-a', modelId: 'model-x' }).health, HEALTH.HEALTHY)
  })
})

// ===========================================================================
// 4. Bounds — the tail window is deterministic and testable
// ===========================================================================

test('line bound keeps only the newest maxLines rows', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = []
    for (let i = 0; i < 40; i++) lines.push(ledgerRow({ at: now - (40 - i) * 1000 }))
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({})
    const summary = await hydrateHealthEvidence({ dir, health, bounds: { maxLines: 5 } })

    assert.equal(summary.cost.rows, 5)
    assert.equal(summary.cost.route.replayed, 5)
    assert.equal(summary.cost.droppedLines, 35)
    const record = health.availabilityRegistry['route-a::model-x']
    assert.equal(record.samples.success, 5, 'older rows were not replayed')
    assert.equal(record.lastSuccessAt, now - 1000, 'the newest row is the one that survived')
  })
})

test('byte bound reads only the tail and drops the partial first line', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = []
    for (let i = 0; i < 6; i++) lines.push(ledgerRow({ at: now - (6 - i) * 1000 }))
    const file = join(dir, 'cost.jsonl')
    await writeFile(file, lines.join('\n') + '\n', 'utf8')

    const full = await stat(file)
    // 1.5 rows of tail: exactly one complete row survives, the partial one is dropped.
    const rowLen = Buffer.byteLength(lines[0]) + 1
    const bounds = { maxBytes: rowLen + Math.floor(rowLen / 2), maxLines: 100 }
    const window = await readLedgerWindow(file, bounds)
    assert.ok(window.truncatedBytes > 0, 'the read started mid-file')
    assert.equal(window.totalBytes, full.size)
    assert.ok(window.lines.length >= 1 && window.lines.length < 6)
    // Every retained line is a COMPLETE record: no half JSON reached the parser.
    const parsed = parseLedgerRows(window.lines)
    assert.equal(parsed.malformed, 0)
    assert.equal(parsed.rows.length, window.lines.length)

    const health = buildHealthDeps({})
    const summary = await hydrateHealthEvidence({ dir, health, bounds })
    assert.equal(summary.cost.truncatedBytes, window.truncatedBytes)
    assert.equal(summary.cost.route.replayed, window.lines.length)
  })
})

test('a boundary-aligned byte window keeps the first complete line', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const lines = []
    for (let i = 0; i < 4; i++) lines.push(ledgerRow({ at: now - (4 - i) * 1000 }))
    const file = join(dir, 'cost.jsonl')
    await writeFile(file, lines.join('\n') + '\n', 'utf8')
    // Exactly the last two lines: the window starts ON a line boundary.
    const lastTwo = Buffer.byteLength(lines[2]) + Buffer.byteLength(lines[3]) + 2
    const window = await readLedgerWindow(file, { maxBytes: lastTwo, maxLines: 100 })
    assert.equal(window.truncatedBytes, Buffer.byteLength(lines[0]) + Buffer.byteLength(lines[1]) + 2)
    assert.equal(window.lines.length, 2, 'an aligned window does not lose its first row')
    assert.deepEqual(window.lines, [lines[2], lines[3]])
  })
})

test('an over-tight byte bound yields zero rows instead of a crash', async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, 'cost.jsonl'), ledgerRow() + '\n', 'utf8')
    const window = await readLedgerWindow(join(dir, 'cost.jsonl'), { maxBytes: 20 })
    assert.equal(window.error, undefined)
    assert.deepEqual(window.lines, [], 'a window with no newline carries no complete row')
    const health = buildHealthDeps({})
    const summary = await hydrateHealthEvidence({ dir, health, bounds: { maxBytes: 20 } })
    assert.equal(summary.cost.route.replayed, 0)
    assert.equal(summary.cost.rows, 0)
  })
})

test('default bounds are the documented 4 MiB / 5000 lines', () => {
  assert.equal(DEFAULT_HYDRATION_BOUNDS.maxBytes, 4 * 1024 * 1024)
  assert.equal(DEFAULT_HYDRATION_BOUNDS.maxLines, 5000)
})

// ===========================================================================
// 5. health=false — hydration is skipped entirely
// ===========================================================================

test('health=false (all opt-out forms) never hydrates and never reads', async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, 'cost.jsonl'), ledgerRow() + '\n', 'utf8')

    assert.equal(buildHealthDeps({ health: false }), undefined, 'terse opt-out')
    assert.equal(buildHealthDeps({ health: { enabled: false } }), undefined, 'dedicated opt-out')
    assert.equal(buildHealthDeps({ ranking: { health: { enabled: false } } }), undefined, 'nested opt-out')

    const log = spyLogger()
    const summary = await hydrateHealthEvidence({
      health: buildHealthDeps({ health: false }),
      dir,
      info: log.infoFn,
      warn: log.warnFn,
    })
    assert.deepEqual(summary, { hydrated: false, reason: 'health-disabled' })
    assert.deepEqual(log.info, [], 'a disabled health layer logs nothing')
    assert.deepEqual(log.warn, [])

    // A health object that is present but not enabled is treated the same way.
    const manual = await hydrateHealthEvidence({ health: { enabled: false }, dir })
    assert.equal(manual.hydrated, false)
  })
})

// ===========================================================================
// 6. New live evidence wins over replayed history
// ===========================================================================

test('replay never overwrites newer live L1 evidence', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    // Live traffic already recorded a HEALTHY success at `now`...
    const liveKey = { provider: 'route-a', modelId: 'model-x' }
    const registry = {}
    registry[registryKey(liveKey)] = updateHealth(registry, {
      provider: 'route-a', modelId: 'model-x', success: true, cost: 0, timestamp: now,
    })
    // ...while the ledger only knows an hour-old jitter streak.
    const lines = []
    for (let i = 0; i < 3; i++) {
      lines.push(ledgerRow({ failure: 'SERVER', message: '502 bad gateway', at: now - HOUR + i * 1000 }))
    }
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const health = buildHealthDeps({})
    health.availabilityRegistry = registry
    const summary = await hydrateHealthEvidence({ dir, health })

    assert.equal(summary.cost.route.replayed, 0)
    assert.equal(summary.cost.route.newerKept, 3)
    const live = registry[registryKey(liveKey)]
    assert.equal(live.health, HEALTH.HEALTHY, 'live HEALTHY is not degraded by stale history')
    assert.equal(live.samples.failure, 0)
    assert.equal(live.samples.success, 1, 'history does not inflate the live sample count')
    assert.equal(live.updatedAt, now)
  })
})

test('replay never overwrites newer live L2 account evidence', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const health = buildHealthDeps({})
    noteSuccess(health.accountHealth, 'acct-1', now)
    const lines = [
      ledgerRow({ account: 'acct-1', failure: 'QUOTA', message: 'insufficient', at: now - HOUR }),
      ledgerRow({ account: 'acct-2', failure: 'QUOTA', message: 'insufficient', at: now - HOUR }),
    ]
    await writeFile(join(dir, 'cost.jsonl'), lines.join('\n') + '\n', 'utf8')

    const summary = await hydrateHealthEvidence({ dir, health })
    assert.equal(summary.cost.account.newerKept, 1)
    assert.equal(summary.cost.account.accounts, 1, 'only the untouched account was hydrated')
    assert.equal(getRecord(health.accountHealth, 'acct-1').state, ACCOUNT_STATES.ACTIVE)
    assert.equal(getRecord(health.accountHealth, 'acct-1').streak, 0)
    assert.equal(getRecord(health.accountHealth, 'acct-2').reason, 'QUOTA')
  })
})

test('rows without a usable timestamp lose to any live record (order guard)', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const health = buildHealthDeps({})
    const registry = health.availabilityRegistry
    registry['route-a::model-x'] = updateHealth(registry, {
      provider: 'route-a', modelId: 'model-x', success: true, cost: 0, timestamp: now,
    })
    const row = JSON.parse(ledgerRow({ failure: 'SERVER', message: '502' }))
    delete row.timestamp
    await writeFile(join(dir, 'cost.jsonl'), JSON.stringify(row) + '\n', 'utf8')

    const summary = await hydrateHealthEvidence({ dir, health })
    assert.equal(summary.cost.route.newerKept, 1)
    assert.equal(registry['route-a::model-x'].health, HEALTH.HEALTHY)
  })
})

// ===========================================================================
// 7. Purity — read-only, no new files, ledger bytes untouched
// ===========================================================================

test('hydration is read-only: no file is created or modified', async () => {
  await withTempDir(async dir => {
    const now = Date.now()
    const file = join(dir, 'cost.jsonl')
    const text = ledgerRow({ at: now - 1000 }) + '\n'
    await writeFile(file, text, 'utf8')
    const before = await stat(file)
    const beforeEntries = (await readdir(dir)).sort()
    const health = buildHealthDeps({})
    await hydrateHealthEvidence({ dir, health })
    const after = await stat(file)
    assert.deepEqual((await readdir(dir)).sort(), beforeEntries, 'probe-cache.jsonl was NOT created')
    assert.equal(await readFile(file, 'utf8'), text, 'ledger bytes are untouched')
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
  })
})

test('malformed registry/row shapes never throw (defensive, pure functions)', () => {
  assert.deepEqual(parseLedgerRows(null), { rows: [], malformed: 0 })
  assert.deepEqual(parseLedgerRows(['', '   ', '\n']), { rows: [], malformed: 0 })
  assert.equal(hydrateRouteEvidence(null, [{ actual_provider: 'p', actual_model: 'm' }]).skipped, 1)
  assert.equal(hydrateAccountEvidence(null, []).unavailable, true)
  assert.equal(hydrateProbeEvidence({}, 'not an array').replayed, 0)
})
