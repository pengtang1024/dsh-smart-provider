/**
 * Regression tests for probe.peek() cache freshness (D1 audit P1-2).
 *
 * The writer emits { verdict, evidence, probedAt, cost, ok } and NEVER an
 * expiresAt field — persisted JSONL rows and in-memory rows alike. peek()
 * used to test `hit.expiresAt > Date.now()`, so it returned undefined for
 * every cached verdict. These tests pin the single TTL contract now shared
 * by probeOne / probeModels / peek.
 *
 * P2 (unknown verdicts are cached too): an inconclusive probe is cached so a
 * settings-page open cannot re-issue a real billed request, under a short TTL,
 * while it still never becomes free/metered evidence (peek stays undefined).
 * The last two tests pin the hydrated-cache rule for persisted unknown rows.
 *
 *   node --test test/probe.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'

import { createProbe } from '../lib/probe.js'

/** Minimal fake llm runtime: one scripted stream per provider. */
function fakeRuntime(scripts) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push({ provider: options.provider, model: options.model })
      const chunks = scripts[options.provider] ?? [
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const FREE = [
  { type: 'usage', usage: { cost: 0, billingSource: 'free-tier' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const METERED = [
  { type: 'usage', usage: { cost: 0.001, billingSource: 'credit' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('probe.peek: a verdict written to cache is immediately readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-peek-'))
  try {
    const cacheFile = join(dir, 'cache.jsonl')
    const runtime = fakeRuntime({ r1: FREE })
    const probe = createProbe({ runtime, availabilityRegistry: {}, cacheFile, ttlMs: 60_000 })

    assert.equal(probe.peek('r1', 'm1'), undefined, 'nothing is cached before the first probe')
    const { results } = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(results[0].verdict, 'free')

    // The writer really emits probedAt only — this is why expiresAt could never work.
    const rows = (await readFile(cacheFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.length >= 1)
    assert.ok(Number.isFinite(rows[0].probedAt))
    assert.equal('expiresAt' in rows[0], false, 'writer has no expiresAt field')

    const hit = probe.peek('r1', 'm1')
    assert.ok(hit, 'peek must read the just-written verdict')
    assert.equal(hit.verdict, 'free')
    assert.match(hit.evidence, /upstream usage cost/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe.peek: a verdict past TTL is invisible and matches probeModels freshness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-peek-'))
  // Deterministic clock, no sleeping: the TTL gate is a pure
  // `probedAt + ttl > Date.now()` comparison, so a 5ms TTL used to race the
  // writer's appendFile queue (a >5ms delay between write and assert made this
  // test red). We advance a patched clock past the TTL instead of racing the
  // real one — same semantics, zero flake. Restored in finally.
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const runtime = fakeRuntime({ r1: FREE })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl'), ttlMs: 1000,
    })
    await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.ok(probe.peek('r1', 'm1'), 'fresh right after the probe')

    now += 1001
    assert.equal(probe.peek('r1', 'm1'), undefined, 'past TTL, peek must not leak a stale verdict')

    const again = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(again.results[0].verdict, 'free')
    assert.doesNotMatch(again.results[0].evidence, /cached/, 'probeModels uses the same freshness rule')
    assert.equal(runtime.calls.length, 2, 'the expired row triggered a real re-probe')
  } finally {
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe.peek: a hydrated cache keeps the live-cache rule for fresh and unknown rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-peek-'))
  try {
    const cacheFile = join(dir, 'cache.jsonl')
    const writer = fakeRuntime({
      r1: FREE,
      r2: [{ type: 'finish', reason: { kind: 'stop' } }], // no usage -> honest unknown
    })
    await createProbe({ runtime: writer, availabilityRegistry: {}, cacheFile, ttlMs: 60_000 })
      .probeModels([
        { provider: 'r1', model: 'm1' },
        { provider: 'r2', model: 'm2' },
      ])

    // A fresh instance hydrates probedAt-only rows from JSONL on first use.
    const reader = createProbe({
      runtime: fakeRuntime({}), availabilityRegistry: {}, cacheFile, ttlMs: 60_000,
    })
    await reader.probeModels([]) // hydrate only; no candidates, no upstream call

    const hit = reader.peek('r1', 'm1')
    assert.ok(hit, 'hydrated free row is visible to peek — same rule as the in-memory cache')
    assert.equal(hit.verdict, 'free')
    assert.equal(reader.peek('r2', 'm2'), undefined, 'unknown verdict is never projected (matches :127/:203)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: an unknown verdict is cached under the short TTL and never re-probed inside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-unknown-'))
  try {
    const cacheFile = join(dir, 'cache.jsonl')
    const runtime = fakeRuntime({ r2: [] }) // empty stream -> no usage signal -> honest unknown
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile, ttlMs: 60_000, unknownTtlMs: 60_000,
    })

    const first = await probe.probeModels([{ provider: 'r2', model: 'm2' }])
    assert.equal(first.results[0].verdict, 'unknown')
    assert.equal(first.results[0].ok, false, 'return contract: ok mirrors verdict !== unknown')
    assert.equal(runtime.calls.length, 1)

    // The unknown row really lands in the persistent cache.
    const rows = (await readFile(cacheFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.at(-1).verdict, 'unknown')

    // Inside the short TTL: cache hit, so no second (billed) upstream request.
    const second = await probe.probeModels([{ provider: 'r2', model: 'm2' }])
    assert.equal(runtime.calls.length, 1, 'a cached unknown must not re-probe inside the short TTL')
    assert.equal(second.results[0].verdict, 'unknown')
    assert.equal(second.results[0].ok, false, 'return shape unchanged for a cached unknown')
    assert.match(second.results[0].evidence, /^cached: /)
    assert.equal(second.results[0].cost, 0)

    // Admission semantics untouched: a cached unknown is still not evidence.
    assert.equal(probe.peek('r2', 'm2'), undefined, 'unknown is never projected as free/metered evidence')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: an unknown caused by a probe error is cached too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-unknown-'))
  try {
    const calls = []
    const runtime = {
      stream() {
        calls.push('stream')
        throw new Error('transport down')
      },
    }
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl'),
      ttlMs: 60_000, unknownTtlMs: 60_000,
    })

    const first = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(first.results[0].verdict, 'unknown')
    assert.match(first.results[0].evidence, /probe error: TRANSPORT/)

    const second = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(calls.length, 1, 'a failed probe is cached, not retried on the next open')
    assert.match(second.results[0].evidence, /^cached: probe error: TRANSPORT/)
    assert.equal(second.results[0].ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: free and metered keep the long TTL while the unknown expires on the short one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-unknown-'))
  try {
    const runtime = fakeRuntime({ r1: FREE, r2: [], r3: METERED })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl'),
      ttlMs: 60_000, unknownTtlMs: 5,
    })
    const candidates = [
      { provider: 'r1', model: 'm1' },
      { provider: 'r2', model: 'm2' },
      { provider: 'r3', model: 'm3' },
    ]

    const first = await probe.probeModels(candidates)
    assert.deepEqual(first.results.map(r => r.verdict), ['free', 'unknown', 'metered'])
    assert.equal(runtime.calls.length, 3)

    await new Promise(resolve => setTimeout(resolve, 30))

    const second = await probe.probeModels(candidates)
    assert.equal(runtime.calls.length, 4, 'only the expired unknown was re-probed')
    assert.deepEqual(runtime.calls[3], { provider: 'r2', model: 'm2' })
    assert.match(second.results[0].evidence, /^cached: /, 'free is untouched by the short unknown TTL')
    assert.match(second.results[2].evidence, /^cached: /, 'metered is untouched by the short unknown TTL')
    assert.equal(second.results[2].verdict, 'metered')
    assert.equal(second.results[2].cost, 0.001, 'cost survives the cache round-trip')
    assert.equal(second.results[1].verdict, 'unknown')
    assert.doesNotMatch(second.results[1].evidence, /^cached: /, 'the expired unknown really re-ran')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: a hydrated unknown row past the short TTL is not adopted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-unknown-'))
  try {
    const cacheFile = join(dir, 'cache.jsonl')
    const now = Date.now()
    const rows = [
      {
        provider: 'r1', model: 'm1', verdict: 'free', ok: true, cost: 0,
        evidence: 'upstream usage cost=0 + free billing source', probedAt: now - 60_000,
      },
      {
        provider: 'r2', model: 'm2', verdict: 'unknown', ok: false, cost: 0,
        evidence: 'probe error: TRANSPORT', probedAt: now - 60_000,
      },
    ]
    await writeFile(cacheFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    const runtime = fakeRuntime({ r1: FREE, r2: [] })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile, ttlMs: 600_000, unknownTtlMs: 1_000,
    })

    const unknown = await probe.probeModels([{ provider: 'r2', model: 'm2' }])
    assert.equal(runtime.calls.length, 1, 'the expired persisted unknown must be re-probed')
    assert.equal(unknown.results[0].verdict, 'unknown')
    assert.doesNotMatch(unknown.results[0].evidence, /^cached: /)

    const free = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(runtime.calls.length, 1, 'the fresh persisted free row is still adopted')
    assert.match(free.results[0].evidence, /^cached: /)
    assert.equal(probe.peek('r1', 'm1').verdict, 'free')
    assert.equal(probe.peek('r2', 'm2'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probe: a hydrated unknown row inside the short TTL suppresses the re-probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-unknown-'))
  try {
    const cacheFile = join(dir, 'cache.jsonl')
    const row = {
      provider: 'r2', model: 'm2', verdict: 'unknown', ok: false, cost: 0,
      evidence: 'probe error: TRANSPORT', probedAt: Date.now() - 1_000,
    }
    await writeFile(cacheFile, JSON.stringify(row) + '\n', 'utf8')

    const runtime = fakeRuntime({ r2: [] })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile, ttlMs: 600_000, unknownTtlMs: 600_000,
    })

    const { results } = await probe.probeModels([{ provider: 'r2', model: 'm2' }])
    assert.equal(runtime.calls.length, 0, 'a fresh persisted unknown must not re-probe')
    assert.equal(results[0].verdict, 'unknown')
    assert.equal(results[0].ok, false)
    assert.match(results[0].evidence, /^cached: probe error: TRANSPORT/)
    assert.equal(probe.peek('r2', 'm2'), undefined, 'still not free/metered evidence')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
