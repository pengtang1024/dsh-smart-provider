/**
 * Tests for the Host single-source free-signal policy (task-24).
 * The fixed vector table is exported so free-verify (task-26) can run the
 * browser mirror against exactly the same inputs and expected values.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeSignal, FREE_POLICY_VECTORS, FREE_SIGNAL_RULE_VERSION, FREE_SIGNAL_LEVELS } from '../lib/free-policy.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

test('rule version is the shared mirror identifier', () => {
  assert.equal(FREE_SIGNAL_RULE_VERSION, 'free-signal-v1')
  assert.deepEqual([...FREE_SIGNAL_LEVELS], ['measured', 'declared', 'weak', 'none'])
})

for (const vector of FREE_POLICY_VECTORS) {
  test('vector: ' + vector.name, () => {
    const got = freeSignal(vector.input)
    assert.equal(got.free, vector.expected.free, `${vector.name}: free mismatch`)
    assert.equal(got.level, vector.expected.level, `${vector.name}: level mismatch`)
    assert.ok(FREE_SIGNAL_LEVELS.includes(got.level), `${vector.name}: level must be a declared level`)
    assert.equal(typeof got.evidence, 'string')
    assert.equal(typeof got.source, 'string')
  })
}

test('paid hard evidence beats a measured free verdict and a zero multiplier', () => {
  const r = freeSignal({
    provider: 'x-free', model: 'free-model', probeVerdict: 'free', multiplier: 0,
    price: { known: true, estimated: false, input: 2e-6, output: 0 },
  })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('probe metered beats a real zero price row and a free name', () => {
  const r = freeSignal({ model: 'free-model', probeVerdict: 'metered',
    price: { known: true, estimated: false, input: 0, output: 0 } })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('multiplier accepts only a finite zero number, never string/null/negative/NaN', () => {
  for (const value of ['0', null, undefined, -1, NaN, Infinity, 'free', {}]) {
    const r = freeSignal({ model: 'm', multiplier: value })
    assert.equal(r.free, false, `multiplier ${String(value)} must not be a free signal`)
    assert.equal(r.level, 'none')
  }
  assert.equal(freeSignal({ model: 'm', multiplier: 0 }).level, 'declared')
})

test('case-insensitive name match only on provider/model/name/group, not flash or trial', () => {
  assert.equal(freeSignal({ provider: 'FREE-GW', model: 'm' }).level, 'weak')
  assert.equal(freeSignal({ name: 'A Free Tier' }).level, 'weak')
  assert.equal(freeSignal({ group: 'free-tier' }).level, 'weak')
  assert.equal(freeSignal({ model: 'claude-flash-trial' }).free, false)
  assert.equal(freeSignal({ model: 'hy4-flash-free' }).level, 'weak')
})

test('unknown verdict does not block declared or weak signals', () => {
  assert.equal(freeSignal({ model: 'free-m', probeVerdict: 'unknown' }).level, 'weak')
  assert.equal(freeSignal({ model: 'm', probeVerdict: 'unknown', multiplier: 0 }).level, 'declared')
})

test('pricing table estimate is not a real price declaration', () => {
  const estimate = { known: false, estimated: true, input: 0, output: 0, priceTier: 'free' }
  const r = freeSignal({ model: 'm', price: estimate })
  assert.deepEqual({ free: r.free, level: r.level }, { free: false, level: 'none' })
})

test('availabilityStatus projection attaches exactly {free,level,source}|null per tuple', () => {
  const src = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
  assert.match(src, /status\[modelId\]\.freeSignal\s*=\s*best/,
    'the top-level tag must come from the highest-evidence exact tuple')
  assert.match(src, /status\[modelId\]\.providers\s*=\s*providers/,
    'each (provider, modelId) tuple gets an independent providers map')
  assert.match(src, /return \{ free: signal\.free, level: signal\.level, source: signal\.source \}/,
    'the wire shape must not leak evidence to the strict codec'
  )
  assert.match(src, /probeReader\?\.\(\)\?\.peek\?\./,
    'probeReader is a lazy closure from index.js; peek must be called on the unwrapped probe')
  assert.match(src, /priceForExact\(provider, modelId\)/)
  const methods = [...src.matchAll(/method:\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(methods)].sort(),
    ['accountHealth', 'availabilityStatus', 'clearStats', 'cost', 'costDetail', 'modelPositions', 'probeModels', 'statsSince'])
})

test('pricing.js keeps its own price semantics; free-policy consumes a passed price object', () => {
  const pricing = readFileSync(join(PKG, 'lib', 'pricing.js'), 'utf8')
  assert.match(pricing, /estimated: true,\s*\n\s*priceTier: tier,/)
  const policy = readFileSync(join(PKG, 'lib', 'free-policy.js'), 'utf8')
  assert.doesNotMatch(policy, /from '\.\/pricing\.js'/,
    'free-policy must stay pure: it consumes a price object, never loads a table'
  )
})

// ---------------------------------------------------------------------------
// task-26: Host / browser mirror consistency gate.
//
// client.js is a browser module wrapped in window.__ModuleLoader__.load(...),
// so it cannot be imported under plain Node. We extract the inline declarations
// by source text and evaluate ONLY that self-contained slice with the two tiny
// helpers (obj/str) it closes over. This is the same honest trade as
// test/remote-surface.test.mjs: source-level checks catch drift cheaply, while
// the real wire is covered by the profile E2E. No @deepseek-ai/* import here.
// ---------------------------------------------------------------------------

function skipMirrorString(text, i) {
  const quote = text[i]
  i += 1
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return i
}

function skipMirrorComment(text, i) {
  if (text[i] === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i)
    return nl === -1 ? text.length : nl + 1
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2)
    return end === -1 ? text.length : end + 2
  }
  return -1
}

function matchMirrorBracket(text, openIndex) {
  const open = text[openIndex]
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let i = openIndex; i < text.length;) {
    const comment = skipMirrorComment(text, i)
    if (comment !== -1) { i = comment; continue }
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { i = skipMirrorString(text, i); continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

function clientFreeMirror() {
  const src = readFileSync(join(PKG, 'client.js'), 'utf8')
  const startAt = src.indexOf('const FREE_SIGNAL_RULE_VERSION = ')
  assert.notEqual(startAt, -1, 'client.js must inline FREE_SIGNAL_RULE_VERSION')
  const fnAt = src.indexOf('const freeSignal = ', startAt)
  assert.notEqual(fnAt, -1, 'client.js must inline freeSignal')
  const arrow = src.indexOf('=>', fnAt)
  assert.notEqual(arrow, -1, 'client freeSignal must be an arrow function')
  const open = src.indexOf('{', arrow)
  assert.notEqual(open, -1, 'client freeSignal body must be a block')
  const close = matchMirrorBracket(src, open)
  assert.notEqual(close, -1, 'client freeSignal body is unbalanced')
  const slice = src.slice(startAt, close + 1)
  const build = new Function('obj', 'str',
    slice + '\nreturn { FREE_SIGNAL_RULE_VERSION, FREE_POLICY_VECTORS, freeSignal }')
  return build(
    value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    value => (typeof value === 'string' ? value : ''),
  )
}

test('client inline mirror shares the exact rule version and the 24 host vectors', () => {
  const mirror = clientFreeMirror()
  assert.equal(mirror.FREE_SIGNAL_RULE_VERSION, FREE_SIGNAL_RULE_VERSION,
    'client and Host must share the same rule version')
  assert.equal(FREE_POLICY_VECTORS.length, 24, 'the shared vector table must have 24 rows')
  assert.equal(mirror.FREE_POLICY_VECTORS.length, FREE_POLICY_VECTORS.length,
    'the browser mirror must export the same number of vectors')
  for (let n = 0; n < FREE_POLICY_VECTORS.length; n += 1) {
    const host = FREE_POLICY_VECTORS[n]
    const browser = mirror.FREE_POLICY_VECTORS[n]
    assert.deepEqual(
      { name: browser.name, input: browser.input, expected: browser.expected },
      { name: host.name, input: host.input, expected: host.expected },
      'vector #' + n + ' (' + host.name + ') must be copied verbatim into client.js',
    )
  }
})

test('client inline freeSignal matches host free + level for all 24 vectors', () => {
  const mirror = clientFreeMirror()
  for (const vector of FREE_POLICY_VECTORS) {
    const host = freeSignal(vector.input)
    const browser = mirror.freeSignal(vector.input)
    assert.deepEqual({ free: browser.free, level: browser.level },
      { free: host.free, level: host.level },
      vector.name + ': browser mirror drifted from the Host single source')
    assert.deepEqual({ free: browser.free, level: browser.level }, vector.expected,
      vector.name + ': both implementations must satisfy the shared vector')
  }
  for (const input of [
    { model: 'm', multiplier: NaN },
    { model: 'm', multiplier: Infinity },
    { model: 'm', priceMultiplier: '0' },
    { model: 'free-m', probeVerdict: 'unknown' },
    { model: 'm', probeVerdict: 'metered', multiplier: 0, name: 'free-model' },
    { model: 'free-m', price: { known: false, estimated: true, input: 0, output: 0 } },
  ]) {
    const host = freeSignal(input)
    const browser = mirror.freeSignal(input)
    assert.deepEqual({ free: browser.free, level: browser.level },
      { free: host.free, level: host.level },
      'extra vector ' + JSON.stringify(input) + ': browser mirror drifted')
  }
})

test('client strict codec availabilityStatus freeSignal tag matches host projection field-for-field', () => {
  const client = readFileSync(join(PKG, 'client.js'), 'utf8')
  const host = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')

  const codecAt = client.indexOf('const freeSignalCodec = z.object({')
  assert.notEqual(codecAt, -1, 'AVAIL_STATUS_SCHEMA must declare freeSignalCodec')
  const codecBrace = client.indexOf('{', client.indexOf('z.object(', codecAt))
  const codecClose = matchMirrorBracket(client, codecBrace)
  assert.notEqual(codecClose, -1, 'freeSignalCodec object is unbalanced')
  const codecBody = client.slice(codecBrace + 1, codecClose)
  const codecFields = [...codecBody.matchAll(/\b(\w+)\s*:\s*z\.(\w+)/g)]
    .map(match => match[1] + ':' + match[2])
  assert.deepEqual(codecFields, ['free:boolean', 'level:string', 'source:string'],
    'the codec must declare exactly the three wire fields Host sends')
  assert.match(client.slice(codecAt, codecClose + 80), /\.nullable\(\)/,
    'a missing Host tag must survive the strict codec as null')
  const rowAt = client.indexOf('return z.record(z.string(), z.object({', codecAt)
  assert.notEqual(rowAt, -1, 'AVAIL_STATUS_SCHEMA must project a per-model row object')
  const rowBrace = client.indexOf('{', client.indexOf('z.object({', rowAt))
  const rowClose = matchMirrorBracket(client, rowBrace)
  const rowBody = client.slice(rowBrace + 1, rowClose)
  assert.match(rowBody, /(^|[\s,{])freeSignal:\s*freeSignalCodec\s*[,}]/,
    'freeSignal must be a required row key, not an optional one')
  assert.doesNotMatch(rowBody, /freeSignal\?\s*:/, 'freeSignal must not be optional')
  const rowFields = []
  for (let pos = 0; pos < rowBody.length;) {
    const comment = skipMirrorComment(rowBody, pos)
    if (comment !== -1) { pos = comment; continue }
    const ch = rowBody[pos]
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { pos = skipMirrorString(rowBody, pos); continue }
    const fieldMatch = /^(\w+)\s*:/.exec(rowBody.slice(pos))
    if (fieldMatch && (pos === 0 || /[\s,{]/.test(rowBody[pos - 1]))) {
      rowFields.push(fieldMatch[1])
      pos += fieldMatch[0].length
      continue
    }
    pos += 1
  }
  assert.deepEqual(rowFields.sort(), ['confidence', 'freeSignal', 'health', 'providers', 'tier'],
    'the projected row codec must list health/tier/confidence/freeSignal/providers')
  assert.match(rowBody, /providers:\s*z\.record\(z\.string\(\),\s*freeSignalCodec\)/, 'providers map must reuse the same three-field signal codec')
  assert.doesNotMatch(rowBody, /evidence/, 'evidence must NOT appear on the wire')

  const projAt = host.indexOf('function projectFreeSignal(')
  assert.notEqual(projAt, -1, 'lib/remote.js must implement projectFreeSignal')
  const projOpen = host.indexOf('{', projAt)
  const projClose = matchMirrorBracket(host, projOpen)
  const projBody = host.slice(projOpen, projClose + 1)
  const returnAt = projBody.lastIndexOf('return {')
  assert.notEqual(returnAt, -1, 'projectFreeSignal must return a plain object')
  const retOpen = projOpen + returnAt + 'return '.length
  const retClose = matchMirrorBracket(host, retOpen)
  const retBody = host.slice(retOpen + 1, retClose)
  const hostFields = [...retBody.matchAll(/(^|[\s,])([\w]+)\s*:/g)].map(match => match[2])
  assert.deepEqual(hostFields.sort(), ['free', 'level', 'source'],
    'Host projection must send exactly the three codec fields')
  assert.doesNotMatch(retBody, /evidence/, 'evidence stays Host-side; never put it on the wire')
  const availAt = host.indexOf('  availabilityStatus() {')
  assert.notEqual(availAt, -1, 'availabilityStatus() must exist on the remote service')
  const availOpen = host.indexOf('{', availAt)
  const availClose = matchMirrorBracket(host, availOpen)
  const availBody = host.slice(availOpen, availClose + 1)
  assert.match(availBody, /status\[modelId\]\.freeSignal\s*=\s*best/,
    'the projected row carries the strongest exact-tuple Host free signal')
  assert.match(availBody, /status\[modelId\]\.providers\s*=\s*providers/,
    'the projected row carries per-provider tuple free signals')
})

test('projectFreeSignal unwraps the lazy probeReader before peek (behavioral gate)', () => {
  const host = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
  const at = host.indexOf('function projectFreeSignal(')
  assert.notEqual(at, -1)
  const open = host.indexOf('{', at)
  const close = matchMirrorBracket(host, open)
  const src = host.slice(at, close + 1)
  const build = new Function('freeSignal', 'priceFor',
    src + '\nreturn projectFreeSignal')
  // No price table row: isolate the probe path from any real pricing.json row.
  const project = build(freeSignal, () => ({ known: false, estimated: true, input: 0, output: 0, priceTier: 'mid' }))
  const registry = {
    'opencode-go::m1': {
      key: { provider: 'opencode-go', modelId: 'm1' },
      confidence: 0.95,
      billing: { meteredSamples: 0, upstreamMetered: false, upstreamFree: false },
    },
  }
  const lazyProbeReader = verdict => () => ({ peek: () => ({ verdict }) })
  const taggedFree = project(registry, 'opencode-go', 'm1', lazyProbeReader('free'))
  assert.deepEqual(taggedFree, { free: true, level: 'measured', source: 'probe' },
    'a measured free verdict must reach the wire through the lazy reader')
  const taggedMetered = project(registry, 'opencode-go', 'm1', lazyProbeReader('metered'))
  assert.deepEqual(taggedMetered, { free: false, level: 'none', source: 'probe' },
    'a measured metered verdict must beat weak signals on the wire')
  const noProbe = project(registry, 'opencode-go', 'm1', undefined)
  assert.deepEqual(noProbe, { free: false, level: 'none', source: 'none' },
    'without probe evidence nothing may claim free')
})
