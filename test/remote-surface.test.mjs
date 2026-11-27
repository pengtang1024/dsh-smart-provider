/**
 * Source-level guard for the Host @Remote surface of smartProvider.
 *
 * WHY THIS FILE DOES NOT IMPORT lib/remote.js: that module top-level-awaits
 * `await loadTypertRemoteService()` to obtain TypertRemoteService from
 * @deepseek-ai/dsh-typert-protocol, which only resolves inside the Electron
 * app.asar runtime. A plain `node --test` import would fail for reasons that
 * have nothing to do with this contract, so the guard reads the source TEXT
 * instead. That is the honest trade: the real wire is covered by the profile
 * E2E; this file covers the two failures a source diff can catch cheaply and
 * that the E2E would only report as "the section is empty":
 *
 *   1. added a method but forgot the prototype marker -> the method exists on
 *      the class yet the Gateway never exposes it (marker = visibility), and
 *      the client's direct invocation silently 404s;
 *   2. forgot to pass a constructor argument at the single call site ->
 *      `this.healthReader` is undefined, accountHealth() returns the
 *      "disabled / nothing known" fallback forever, and nothing throws.
 *
 * Both are exactly the "green UI, no data" class of bug the design docs warn
 * about, so they get an executable assertion instead of a code-review habit.
 *
 *   node --test test/remote-surface.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePosition, projectModelForPosition } from '../lib/routing.js'
import { buildPositionSnapshot, MODEL_POSITION_TAGS } from '../lib/position-snapshot.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REMOTE_SRC = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
const INDEX_SRC = readFileSync(join(PKG, 'index.js'), 'utf8')
const CLIENT_SRC = readFileSync(join(PKG, 'client.js'), 'utf8')

/** The frozen @Remote surface the client contribution declares. */
const EXPECTED_METHODS = ['cost', 'costDetail', 'availabilityStatus', 'probeModels', 'accountHealth', 'modelPositions', 'statsSince', 'clearStats']

// ---------------------------------------------------------------------------
// Minimal JS-aware scanner. Regex counting is the trap this guard must avoid:
// `split(',')` breaks on the arrow function passed to the constructor, and a
// greedy brace regex breaks on nested object literals. Bracket balancing plus
// string/comment skipping is small and actually correct.
// ---------------------------------------------------------------------------

/** Skip a '…' / "…" / `…` literal starting at i; returns the index after it. */
function skipString(text, i) {
  const quote = text[i]
  i += 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === quote) return i + 1
    i += 1
  }
  return i
}

/** Skip a // or /* … *\/ comment at i; returns the index after it, or -1. */
function skipComment(text, i) {
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

/** Index of the bracket that closes the one at openIndex, or -1. */
function matchBracket(text, openIndex) {
  const open = text[openIndex]
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  let i = openIndex
  while (i < text.length) {
    const comment = skipComment(text, i)
    if (comment !== -1) { i = comment; continue }
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(text, i); continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** Split a call's argument text on commas that sit at bracket depth 0. */
function splitTopLevelArgs(text) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const comment = skipComment(text, i)
    if (comment !== -1) { i = comment; continue }
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(text, i); continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(part => part.length > 0)
}

/** All argument source slices of every `new SmartProviderRemote(...)` call. */
function constructionArgs(source) {
  const calls = []
  const needle = 'new SmartProviderRemote('
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) break
    const open = at + needle.length - 1
    const close = matchBracket(source, open)
    assert.notEqual(close, -1, 'unbalanced new SmartProviderRemote( — cannot verify arguments')
    calls.push(splitTopLevelArgs(source.slice(open + 1, close)))
    from = close + 1
  }
  return calls
}

/** Method names listed in the prototype marker block. */
function markerMethods(source) {
  const markerAt = source.indexOf('Object.defineProperty(SmartProviderRemote.prototype, MARKER_KEY')
  assert.notEqual(markerAt, -1, 'prototype marker is missing — every @Remote method becomes invisible')
  const block = source.slice(markerAt)
  return [...block.matchAll(/method:\s*'([^']+)'/g)].map(match => match[1])
}

/** Source of one class method body, located by name and bracket-balanced. */
function methodBody(source, name) {
  const match = new RegExp('\\n\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{').exec(source)
  assert.ok(match, `${name}() is not defined on SmartProviderRemote`)
  const open = match.index + match[0].length - 1
  const close = matchBracket(source, open)
  assert.notEqual(close, -1, `${name}() body is unbalanced`)
  return { params: match[1].trim(), body: source.slice(open, close + 1) }
}

// ---------------------------------------------------------------------------
// Marker visibility — the Gateway only routes methods listed here.
// ---------------------------------------------------------------------------

test('marker lists every declared @Remote method, including accountHealth', () => {
  const methods = markerMethods(REMOTE_SRC)
  for (const method of EXPECTED_METHODS) {
    assert.ok(methods.includes(method), `marker is missing '${method}' — the Gateway would not expose it`)
  }
  // No stale entries: a marker naming a method that no longer exists routes to
  // undefined at call time.
  assert.deepEqual([...methods].sort(), [...EXPECTED_METHODS].sort())
  assert.equal(new Set(methods).size, methods.length, 'marker must not list a method twice')
})

test('every marker entry is a frozen direct-invocation descriptor', () => {
  const markerAt = REMOTE_SRC.indexOf('Object.defineProperty(SmartProviderRemote.prototype, MARKER_KEY')
  const block = REMOTE_SRC.slice(markerAt)
  const entries = [...block.matchAll(/Object\.freeze\(\{\s*method:\s*'([^']+)',\s*invocation:\s*Object\.freeze\(\{\s*kind:\s*'([^']+)'\s*\}\)\s*\}\)/g)]
  assert.deepEqual(entries.map(entry => entry[1]).sort(), [...EXPECTED_METHODS].sort())
  assert.ok(entries.every(entry => entry[2] === 'direct'), 'accountHealth() is a zero-arg direct call')
})

// ---------------------------------------------------------------------------
// accountHealth() — thin forwarder, zero parameters.
// ---------------------------------------------------------------------------

test('accountHealth() takes no parameters and forwards this.healthReader', () => {
  const { params, body } = methodBody(REMOTE_SRC, 'accountHealth')
  // Gateway srcDescriptor() rejects defaults/destructuring/rest in a Host
  // signature; a zero-arg @Remote must also declare nothing at all.
  assert.equal(params, '', 'a zero-parameter @Remote must declare no parameter')
  assert.match(body, /this\.healthReader\?\.\(\)/, 'accountHealth() must read the injected reader')
  assert.match(body, /catch/, 'a throwing reader must not propagate to the wire')
  // The degraded shape must match the frozen contract, not a half-filled object.
  assert.match(body, /enabled:\s*false/)
  assert.match(body, /generatedAt:\s*Date\.now\(\)/)
  assert.match(body, /accounts:\s*\[\]/)
  assert.match(body, /routes:\s*\[\]/)
})

test('modelPositions() takes no parameters and forwards this.positionReader', () => {
  const { params, body } = methodBody(REMOTE_SRC, 'modelPositions')
  // Same Gateway rule as accountHealth(): a zero-arg @Remote declares nothing.
  assert.equal(params, '', 'a zero-parameter @Remote must declare no parameter')
  assert.match(body, /this\.positionReader\?\.\(\)/, 'modelPositions() must read the injected reader')
  assert.match(body, /catch/, 'a throwing reader must not propagate to the wire')
  assert.match(body, /enabled:\s*false/)
  assert.match(body, /rows:\s*\[\]/)
  // No generatedAt on this wire shape — the client strict codec has no such key.
  assert.doesNotMatch(body, /generatedAt/)
})

test('constructor accepts all nine readers/writers in order', () => {
  const match = /constructor\s*\(([^)]*)\)\s*\{/.exec(REMOTE_SRC)
  assert.ok(match, 'SmartProviderRemote constructor not found')
  // Comments may precede the JSDoc block; strip them before counting params.
  const raw = match[1]
  const params = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(param => param.trim()).filter(Boolean)
  assert.deepEqual(params,
    ['ctx', 'statsReader', 'costDir', 'registryReader', 'probeReader', 'healthReader', 'statsStateReader', 'statsStateWriter', 'positionReader'],
    'constructor must inject the stats-state reader/writer and the position reader, not read the filesystem itself')
  assert.match(REMOTE_SRC, /this\.healthReader\s*=\s*healthReader/, 'the health reader must be stored for the method to read')
  assert.match(REMOTE_SRC, /this\.statsStateReader\s*=\s*statsStateReader/)
  assert.match(REMOTE_SRC, /this\.statsStateWriter\s*=\s*statsStateWriter/)
  assert.match(REMOTE_SRC, /this\.positionReader\s*=\s*positionReader/, 'the position reader must be stored for modelPositions() to read')
})

// ---------------------------------------------------------------------------
// The single construction site in index.js must pass all nine arguments.
// ---------------------------------------------------------------------------

test('index.js constructs SmartProviderRemote exactly once with nine arguments', () => {
  const calls = constructionArgs(INDEX_SRC)
  assert.equal(calls.length, 1, `expected exactly one construction site, found ${calls.length}`)
  const args = calls[0]
  assert.equal(args.length, 9, `expected 9 constructor arguments, got ${args.length}: ${args.join(' | ')}`)
  // Position 5 (0-based) is the health reader; it must be an identifier or
  // closure defined in this file, never an eagerly evaluated snapshot.
  assert.equal(args[5], 'healthReader', 'the sixth argument must be the lazy healthReader closure')
  assert.equal(args[6], 'statsStateReader', 'the seventh argument must be the stats-state reader')
  assert.equal(args[7], 'statsStateWriter', 'the eighth argument must be the stats-state writer')
  assert.equal(args[8], 'positionReader', 'the ninth argument must be the lazy positionReader closure')
  assert.match(INDEX_SRC, /const healthReader\s*=\s*\(\)\s*=>/, 'healthReader must be a lazily-invoked closure')
  assert.match(INDEX_SRC, /const statsStateReader\s*=\s*\w+\s*=>/, 'statsStateReader must be a lazy closure')
  assert.match(INDEX_SRC, /const statsStateWriter\s*=\s*\w+\s*=>/, 'statsStateWriter must be a lazy closure')
  assert.match(INDEX_SRC, /const positionReader\s*=\s*\(\)\s*=>/, 'positionReader must be a lazily-invoked closure')
  assert.match(INDEX_SRC, /import \{ buildPositionSnapshot \} from '\.\/lib\/position-snapshot\.js'/)
})

/** Body of a `const name = (...) => { … }` declaration, bracket-balanced. */
function arrowBody(source, name) {
  const match = new RegExp('const\\s+' + name + '\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{').exec(source)
  assert.ok(match, `${name} is not declared as a block-bodied arrow function`)
  const open = match.index + match[0].length - 1
  const close = matchBracket(source, open)
  assert.notEqual(close, -1, `${name} body is unbalanced`)
  return source.slice(open, close + 1)
}

test('healthReader builds the snapshot from the live adapter at call time', () => {
  const body = { body: arrowBody(INDEX_SRC, 'healthReader') }
  // Lazy, not eager: `adapter` is constructed after the @Remote instance, so an
  // eager read would capture undefined and freeze the section on empty forever.
  assert.match(body.body, /adapter\?\.accountPool/, 'the closure must read the adapter at call time')
  assert.match(body.body, /buildHealthSnapshot\(/, 'the closure must delegate to the pure builder')
  // Read the builder call's own object literal, so a field added elsewhere in
  // the closure cannot satisfy the check. Shorthand (`accounts,`) and explicit
  // (`now: …`) properties are both accepted.
  const callAt = body.body.indexOf('buildHealthSnapshot(')
  const callOpen = callAt + 'buildHealthSnapshot('.length - 1
  const callClose = matchBracket(body.body, callOpen)
  assert.notEqual(callClose, -1, 'buildHealthSnapshot() call is unbalanced')
  const passed = body.body.slice(callOpen + 1, callClose)
  for (const field of ['enabled', 'accountHealth', 'cooldowns', 'usage', 'accounts', 'availabilityRegistry', 'now']) {
    assert.match(passed, new RegExp('(^|[^\\w.])' + field + '\\s*[:,}]'), `buildHealthSnapshot() call must pass ${field}`)
  }
  assert.match(INDEX_SRC, /import \{ buildHealthSnapshot \} from '\.\/lib\/health-snapshot\.js'/)
  // Defensive shape check from the card: a non-Map byId yields an empty list.
  assert.match(body.body, /instanceof Map/, 'a non-Map pool.byId must degrade to an empty account list')
})

test('healthReader is genuinely lazy: its only exit is the live builder call', () => {
  // A closure that is syntactically lazy but returns a precomputed snapshot is
  // the dangerous shape: it passes "is an arrow function", the app boots, and
  // the settings section shows a snapshot frozen at apply() time forever. The
  // real TDZ accident (evaluating `adapter` before its `const` declaration)
  // throws loudly at load, but that safety is incidental — a hoisted or `let`
  // refactor makes it silent. So assert the property, not the accident:
  // exactly one return, and that return IS the builder call.
  const body = arrowBody(INDEX_SRC, 'healthReader')
  const returns = [...body.matchAll(/\breturn\b/g)]
  assert.equal(returns.length, 1, `healthReader must have exactly one return, found ${returns.length}`)
  const afterReturn = body.slice(returns[0].index + 'return'.length).trimStart()
  assert.match(afterReturn, /^buildHealthSnapshot\(/, 'the single return must be the live buildHealthSnapshot() call')
  // No snapshot may be captured outside the closure and handed back later.
  assert.doesNotMatch(INDEX_SRC, /const\s+\w*[Ss]napshot\w*\s*=\s*buildHealthSnapshot\(/,
    'buildHealthSnapshot() must not be called outside the lazy reader')
})

test('positionReader is genuinely lazy and reads live routes + overrides', () => {
  const body = arrowBody(INDEX_SRC, 'positionReader')
  const returns = [...body.matchAll(/\breturn\b/g)]
  assert.equal(returns.length, 1, `positionReader must have exactly one return, found ${returns.length}`)
  const afterReturn = body.slice(returns[0].index + 'return'.length).trimStart()
  assert.match(afterReturn, /^buildPositionSnapshot\(/, 'the single return must be the live builder call')
  assert.match(body, /adapter\?\.routes/, 'routes must be read at call time, not captured at apply() time')
  assert.match(body, /positionOverrides/, 'the effective override map the adapter uses must be forwarded')
  assert.doesNotMatch(INDEX_SRC, /const\s+\w*[Ss]napshot\w*\s*=\s*buildPositionSnapshot\(/,
    'the snapshot must never be built outside the lazy reader')
})

// ---------------------------------------------------------------------------
// costDetail() degraded payload — the strict-codec trap.
//
// When reading the ledger throws, the Host used to return a hand-rolled object
// ({estimated, known, models}) missing priceSource and note. The client's
// COST_DETAIL_SCHEMA requires both as z.string(), so the whole payload failed
// to parse and the cost section stayed on "正在读取" forever. The guard below
// reads the real schema text and the real EMPTY_COST_DETAIL literal, so client
// and Host cannot drift apart again without this test failing.
// ---------------------------------------------------------------------------

/** Field -> zod type name of the z.object({...}) literal that encloses an anchor. */
function zodObjectFields(source, anchor) {
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, 'anchor not found: ' + anchor)
  const objectAt = source.lastIndexOf('z.object({', at)
  assert.notEqual(objectAt, -1, 'no enclosing z.object({ before: ' + anchor)
  const open = objectAt + 'z.object('.length
  const close = matchBracket(source, open)
  assert.notEqual(close, -1, 'unbalanced z.object({ at: ' + anchor)
  const body = source.slice(open + 1, close)
  const fields = new Map()
  let depth = 0
  let i = 0
  while (i < body.length) {
    const comment = skipComment(body, i)
    if (comment !== -1) { i = comment; continue }
    const ch = body[i]
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { i = skipString(body, i); continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; i += 1; continue }
    if (depth === 0) {
      const match = /^(\w+)\s*:\s*z\.(\w+)/.exec(body.slice(i, i + 120))
      if (match && (i === 0 || /[\s,{]/.test(body[i - 1]))) {
        fields.set(match[1], match[2])
        i += match[0].length
        continue
      }
    }
    i += 1
  }
  return fields
}

/** Evaluate the frozen EMPTY_COST_DETAIL object literal straight from the source. */
function emptyCostDetailValue() {
  const at = REMOTE_SRC.indexOf('const EMPTY_COST_DETAIL = ')
  assert.notEqual(at, -1, 'lib/remote.js must declare EMPTY_COST_DETAIL')
  const open = REMOTE_SRC.indexOf('{', at)
  const close = matchBracket(REMOTE_SRC, open)
  assert.notEqual(close, -1, 'EMPTY_COST_DETAIL literal is unbalanced')
  return new Function('return (' + REMOTE_SRC.slice(open, close + 1) + ')')()
}

/** Assert one payload satisfies a parsed zod-object field map: keys AND types. */
function assertZodShape(value, fields, label) {
  assert.deepEqual(
    Object.keys(value).sort(), [...fields.keys()].sort(),
    label + ' must carry exactly the client-declared fields (a missing one fails the strict codec)',
  )
  for (const [name, type] of fields) {
    const actual = value[name]
    if (type === 'number') assert.equal(typeof actual, 'number', label + '.' + name + ' must be a number')
    else if (type === 'string') assert.equal(typeof actual, 'string', label + '.' + name + ' must be a string')
    else if (type === 'boolean') assert.equal(typeof actual, 'boolean', label + '.' + name + ' must be a boolean')
    else if (type === 'array') assert.ok(Array.isArray(actual), label + '.' + name + ' must be an array')
    else if (type === 'object') assert.equal(typeof actual, 'object', label + '.' + name + ' must be an object')
    else assert.fail('unhandled zod type z.' + type + ' for ' + label + '.' + name)
  }
}

test('degraded costDetail payload matches the client strict schema field-for-field', () => {
  // Anchors are the exact default-value lines of COST_DETAIL_SCHEMA in client.js.
  const topFields = zodObjectFields(CLIENT_SRC, 'total: z.number(), offset: z.number(), limit: z.number(),')
  const savingFields = zodObjectFields(CLIENT_SRC, 'estimated: z.boolean(), priceSource: z.string(), note: z.string(),')

  // The two fields the old fallback omitted are exactly the ones that broke it.
  assert.equal(savingFields.get('priceSource'), 'string', 'client schema requires a priceSource string')
  assert.equal(savingFields.get('note'), 'string', 'client schema requires a note string')

  const empty = emptyCostDetailValue()
  assertZodShape(empty, topFields, 'EMPTY_COST_DETAIL')
  assertZodShape(empty.savings, savingFields, 'EMPTY_COST_DETAIL.savings')

  // Degraded values are explicit "nothing known", never a fabricated number.
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(empty.timeline, [])
  assert.deepEqual(empty.byModel, [])
  assert.equal(empty.savings.estimated, true)
  assert.equal(empty.savings.priceSource, '')
  assert.equal(empty.savings.note, '')
  assert.deepEqual(empty.savings.models, [])

  // One shared definition, exported so the wire path and this guard agree.
  assert.match(REMOTE_SRC, /export \{[^}]*\bEMPTY_COST_DETAIL\b[^}]*\}/,
    'EMPTY_COST_DETAIL must be exported from lib/remote.js')
})

test('costDetail() catch path returns EMPTY_COST_DETAIL, never a partial literal', () => {
  const { body } = methodBody(REMOTE_SRC, 'costDetail')
  assert.match(body, /catch\s*\{[^}]*emptyCostDetail\(/, 'the catch must build the payload from the frozen constant')
  assert.match(body, /readCostDetail\(/, 'the happy path still delegates to readCostDetail')
  // The exact shape that broke: an inline savings object with no priceSource/note.
  assert.doesNotMatch(body, /savings:\s*\{\s*estimated/,
    'no inline savings literal in costDetail() — it drifted from the client schema once already')
  assert.doesNotMatch(body, /\bknown:\s*false/,
    'savings has no "known" key; the required keys are estimated/priceSource/note/models')
})

// ---------------------------------------------------------------------------
// modelPositions() pure projection — the mapping rules are frozen here so a
// Host field rename cannot silently degrade the table back to [tool, general].
// ---------------------------------------------------------------------------

test('projectModelForPosition maps real Host fields into derivePosition shape', () => {
  const real = Object.freeze({
    id: 'gpt-5',
    name: 'GPT-5',
    reasoning: Object.freeze({ efforts: Object.freeze([{ id: 'high' }]) }),
    inputModalities: Object.freeze(['text', 'image']),
    context: Object.freeze({ contextWindow: 256000 }),
    toolUpdate: Object.freeze({ mode: 'replace' }),
  })
  assert.deepEqual(projectModelForPosition(real), {
    id: 'gpt-5',
    reasoning: true,
    contextWindow: 256000,
    input: ['image'],
    tool: true,
  })
  // Pure: the input is frozen and must not be touched by the projection.
  assert.equal(real.inputModalities.length, 2)

  // toolUpdate is a schema-update policy, never a tool-capability boolean.
  assert.equal(projectModelForPosition({ id: 'm', toolUpdate: { mode: 'noop' } }).tool, true)
  // An explicit legacy tool:false still opts out — derivePosition semantics stay.
  assert.equal(projectModelForPosition({ id: 'm', tool: false }).tool, false)

  // Legacy catalog shape (used by existing routing tests) must keep working.
  assert.deepEqual(projectModelForPosition({
    id: 'legacy', reasoning: true, contextWindow: 300000, input: ['image'], tool: false,
  }), { id: 'legacy', reasoning: true, contextWindow: 300000, input: ['image'], tool: false })

  // Missing / malformed fields degrade conservatively and never throw.
  assert.deepEqual(projectModelForPosition(null), {
    id: '', reasoning: false, contextWindow: undefined, input: [], tool: true,
  })
  assert.deepEqual(projectModelForPosition({
    id: 'x', reasoning: { efforts: [] }, context: {}, inputModalities: ['text'],
  }), { id: 'x', reasoning: false, contextWindow: undefined, input: [], tool: true })
  // Top-level contextWindow is the accepted fallback when context.contextWindow is absent.
  assert.equal(projectModelForPosition({ id: 'y', contextWindow: 123456 }).contextWindow, 123456)
})

test('derivePosition sees real Host capabilities through the projection', () => {
  const derived = derivePosition(projectModelForPosition({
    id: 'r', reasoning: { efforts: [{ id: 'medium' }] },
    inputModalities: ['text', 'image'], context: { contextWindow: 200000 },
  }))
  assert.ok(derived.tags.includes('reasoning'), 'reasoning.efforts must unlock the reasoning tier')
  assert.ok(derived.tags.includes('longctx'), 'context.contextWindow must unlock longctx')
  assert.ok(derived.tags.includes('vision'), 'inputModalities:image must unlock vision (renamed on the wire)')
  assert.ok(derived.tags.includes('general'))
  assert.equal(derived.source, 'auto')
})

test('buildPositionSnapshot projects routes into the closed five-tag wire vocabulary', () => {
  const snapshot = buildPositionSnapshot({
    routes: [
      {
        provider: 'openai',
        models: [
          {
            id: 'gpt-5', name: 'GPT-5', reasoning: { efforts: [{ id: 'high' }] },
            inputModalities: ['text', 'image'], context: { contextWindow: 256000 },
          },
          { id: 'cheap', name: 'Cheap' },
          'bare-id',
        ],
      },
      { provider: 'smart', models: [{ id: 'virtual' }] }, // virtual copy is skipped
      { provider: 'anthropic', models: [] },
    ],
    overrides: { 'openai/cheap': ['thrifty', 'reasoning'] },
  })
  assert.equal(snapshot.enabled, true)
  assert.deepEqual(snapshot.rows.map(row => row.id), ['gpt-5', 'cheap', 'bare-id'])
  assert.deepEqual(snapshot.rows[0], {
    id: 'gpt-5', name: 'GPT-5', group: 'openai',
    tags: ['reasoning', 'longctx', 'multimodal', 'tool', 'general'], source: 'auto',
  })
  // thrifty is a valid routing tag but NOT on the wire; reasoning from the same
  // override survives, and the source honestly reports a merge.
  assert.deepEqual(snapshot.rows[1], {
    id: 'cheap', name: 'Cheap', group: 'openai',
    tags: ['tool', 'general', 'reasoning'], source: 'mixed',
  })
  assert.deepEqual(snapshot.rows[2], {
    id: 'bare-id', name: 'bare-id', group: 'openai',
    tags: ['tool', 'general'], source: 'auto',
  })
  for (const row of snapshot.rows) {
    for (const tag of row.tags) {
      assert.ok(MODEL_POSITION_TAGS.includes(tag), `unexpected wire tag: ${tag}`)
    }
    assert.ok(['auto', 'user', 'mixed'].includes(row.source))
    // Strict codec: no functions, no classes, no undefined leak.
    assert.deepEqual(Object.keys(row).sort(), ['group', 'id', 'name', 'source', 'tags'])
    assert.ok(Object.values(row).every(value => typeof value !== 'function'))
  }
})

test('buildPositionSnapshot honours Map overrides and provider-qualified keys first', () => {
  const overrides = new Map([['p/m', ['reasoning']], ['m', ['longctx']]])
  const snapshot = buildPositionSnapshot({ routes: [{ provider: 'p', models: [{ id: 'm' }] }], overrides })
  assert.deepEqual(snapshot.rows[0].tags, ['tool', 'general', 'reasoning'])
  assert.equal(snapshot.rows[0].source, 'mixed')
  // Bare-id key is the fallback when no qualified key exists.
  const bare = buildPositionSnapshot({ routes: [{ provider: 'p', models: [{ id: 'm' }] }], overrides: { m: ['longctx'] } })
  assert.ok(bare.rows[0].tags.includes('longctx'))
})

test('buildPositionSnapshot degrades to a disabled empty table without throwing', () => {
  const empty = { enabled: false, rows: [] }
  assert.deepEqual(buildPositionSnapshot(), empty)
  assert.deepEqual(buildPositionSnapshot(null), empty)
  assert.deepEqual(buildPositionSnapshot({}), empty)
  assert.deepEqual(buildPositionSnapshot({ routes: [] }), empty)
  assert.deepEqual(buildPositionSnapshot({ routes: [{ provider: 'p', models: [{ name: 'no id' }] }] }), empty)
  // A hostile getter can throw mid-projection; the whole table still degrades.
  const hostile = { get models() { throw new Error('boom') } }
  assert.deepEqual(buildPositionSnapshot({ routes: [{ provider: 'p' }, hostile] }), empty)
})
