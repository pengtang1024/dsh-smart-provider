/**
 * HB1/task-36 checkpoint A: free evidence must be projected per
 * (provider, modelId) tuple, never by a bare-modelId cross-provider winner.
 *
 * lib/remote.js top-level-awaits the typert protocol package that only exists
 * inside the DSH Electron runtime, so this pure-Node guard reads the real
 * source text, checks the frozen @Remote surface, and evaluates the real
 * projectFreeSignal() body against a controlled registry probe.
 *
 *   env -u DSH_NODE_EXECUTABLE node --test test/free-signal-tuple.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateHealth, projectStatus } from '../lib/availability.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REMOTE_SRC = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')

function bracketClose(source, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const close = pairs[source[open]]
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === close) depth -= 1
    else if (ch === source[open]) depth += 1
    if (depth === 0) return i
  }
  return -1
}

function functionBody(name) {
  const at = REMOTE_SRC.indexOf('function ' + name + '(')
  assert.notEqual(at, -1, 'lib/remote.js must define ' + name + '()')
  const open = REMOTE_SRC.indexOf('{', at)
  const close = bracketClose(REMOTE_SRC, open)
  assert.notEqual(close, -1, name + '() body is unbalanced')
  return REMOTE_SRC.slice(open + 1, close)
}

function testRegistry() {
  const registry = {}
  // Two real registry records with the SAME bare modelId but different providers.
  // workbuddy has lower confidence, so the old winner logic picked x-opencode-free.
  registry['x-opencode-free::hy4flash-free'] = updateHealth({}, {
    provider: 'x-opencode-free', modelId: 'hy4flash-free', success: true, cost: 0,
  })
  registry['workbuddy::hy4flash-free'] = updateHealth({}, {
    provider: 'workbuddy', modelId: 'hy4flash-free', success: true, cost: 0,
  })
  const precise = {
    'x-opencode-free/hy4flash-free': { known: true, estimated: false, input: 0, output: 0 },
  }
  return { registry, priceLookup: (p, m) => precise[p + '/' + m] ?? { known: false, estimated: true, input: 0, output: 0 } }
}

/** Minimal faithful subset of free-policy.js for the evidence combinations tested here. */
function classifier(input) {
  const price = input.price
  const real = price?.known === true && price.estimated !== true
  const positive = real && ((Number(price.input) || 0) > 0 || (Number(price.output) || 0) > 0)
  const zero = real && Number(price.input) === 0 && Number(price.output) === 0
  if (input.probeVerdict === 'metered' || positive) return { free: false, level: 'none', source: 'paid' }
  if (input.probeVerdict === 'free' || zero) return { free: true, level: 'measured', source: 'probe-or-price' }
  if (/free/i.test(input.provider + '/' + input.model)) return { free: true, level: 'weak', source: 'name' }
  return { free: false, level: 'none', source: 'none' }
}

function projectSignal(registry, provider, model, priceLookup, verdict = 'unknown') {
  const body = functionBody('projectFreeSignal')
  const fn = new Function('registry', 'provider', 'modelId', 'probeReader', 'priceForExact', 'freeSignal',
    body + '\nreturn projectFreeSignal(registry, provider, modelId, probeReader)')
  return fn(registry, provider, model,
    () => ({ peek: (p, m) => ({ verdict: p === provider && m === model ? verdict : 'unknown' }) }),
    priceLookup, classifier)
}

test('AX1: projectFreeSignal uses the explicit provider, not a bare-modelId winner', () => {
  const { registry, priceLookup } = testRegistry()
  const workbuddy = projectSignal(registry, 'workbuddy', 'hy4flash-free', priceLookup)
  const opencode = projectSignal(registry, 'x-opencode-free', 'hy4flash-free', priceLookup)
  assert.equal(workbuddy.free, true)
  assert.equal(workbuddy.level, 'weak', 'workbuddy cannot inherit the x-opencode-free zero price row')
  assert.equal(opencode.level, 'measured', 'the exact zero-price row still counts for its own provider')
})

test('AX2: availabilityStatus builds one tag per provider tuple and keeps the shape', () => {
  const { registry, priceLookup } = testRegistry()
  const methodAt = REMOTE_SRC.indexOf('availabilityStatus() {')
  assert.notEqual(methodAt, -1, 'availabilityStatus() must remain a @Remote method')
  const open = REMOTE_SRC.indexOf('{', methodAt)
  const body = REMOTE_SRC.slice(open + 1, bracketClose(REMOTE_SRC, open))
  // Evaluate the real method body with injected dependencies. The method body
  // reads `this.registryReader()`; we bind the test registry through that reader.
  const source = 'return function availabilityStatus() {' + body + '}'
  const makeMethod = new Function('projectStatus', 'projectFreeSignal', source)
  const method = makeMethod(projectStatus,
    (reg, provider, model) => projectSignal(reg, provider, model, priceLookup))
  const status = method.call({ registryReader: () => registry, probeReader: () => null })
  const row = status['hy4flash-free']
  assert.ok(row, 'the projected row must stay keyed by bare modelId')
  assert.deepEqual(Object.keys(row.providers).sort(), ['workbuddy', 'x-opencode-free'])
  assert.equal(row.providers.workbuddy.level, 'weak')
  assert.equal(row.providers['x-opencode-free'].level, 'measured')
  for (const tag of [row.providers.workbuddy, row.providers['x-opencode-free'], row.freeSignal]) {
    assert.deepEqual(Object.keys(tag).sort(), ['free', 'level', 'source'])
  }
})

test('AX3: @Remote marker and method name stay frozen', () => {
  const markerAt = REMOTE_SRC.indexOf('Object.defineProperty(SmartProviderRemote.prototype, MARKER_KEY')
  assert.notEqual(markerAt, -1, 'prototype marker must be unchanged')
  const marker = REMOTE_SRC.slice(markerAt)
  assert.match(marker, /method:\s*'availabilityStatus'/, 'availabilityStatus must stay visible on the wire')
  // CF-1 adds statsSince/clearStats; the original five must stay visible.
  assert.equal((marker.match(/method:\s*'/g) ?? []).length, 7, 'the seven declared @Remote methods must stay visible')
})

test('AX4: projectStatus display projection still merges by bare modelId', () => {
  const { registry } = testRegistry()
  const status = projectStatus(registry)
  assert.deepEqual(Object.keys(status), ['hy4flash-free'], 'health display keeps its original bare-modelId shape')
})
