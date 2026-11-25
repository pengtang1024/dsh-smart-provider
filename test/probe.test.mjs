/**
 * Regression tests for probe.peek() cache freshness (D1 audit P1-2).
 *
 * The writer emits { verdict, evidence, probedAt, cost, ok } and NEVER an
 * expiresAt field — persisted JSONL rows and in-memory rows alike. peek()
 * used to test `hit.expiresAt > Date.now()`, so it returned undefined for
 * every cached verdict. These tests pin the single TTL contract now shared
 * by probeOne / probeModels / peek.
 *
 *   node --test test/probe.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'

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
  try {
    const runtime = fakeRuntime({ r1: FREE })
    const probe = createProbe({
      runtime, availabilityRegistry: {}, cacheFile: join(dir, 'cache.jsonl'), ttlMs: 5,
    })
    await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.ok(probe.peek('r1', 'm1'), 'fresh right after the probe')

    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(probe.peek('r1', 'm1'), undefined, 'past TTL, peek must not leak a stale verdict')

    const again = await probe.probeModels([{ provider: 'r1', model: 'm1' }])
    assert.equal(again.results[0].verdict, 'free')
    assert.doesNotMatch(again.results[0].evidence, /cached/, 'probeModels uses the same freshness rule')
    assert.equal(runtime.calls.length, 2, 'the expired row triggered a real re-probe')
  } finally {
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
