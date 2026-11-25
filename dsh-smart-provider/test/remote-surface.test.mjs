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

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REMOTE_SRC = readFileSync(join(PKG, 'lib', 'remote.js'), 'utf8')
const INDEX_SRC = readFileSync(join(PKG, 'index.js'), 'utf8')

/** The frozen @Remote surface the client contribution declares. */
const EXPECTED_METHODS = ['cost', 'costDetail', 'availabilityStatus', 'probeModels', 'accountHealth']

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

test('constructor accepts healthReader as the sixth parameter', () => {
  const match = /constructor\s*\(([^)]*)\)\s*\{/.exec(REMOTE_SRC)
  assert.ok(match, 'SmartProviderRemote constructor not found')
  const params = match[1].split(',').map(param => param.trim()).filter(Boolean)
  assert.equal(params.length, 6, `expected 6 constructor parameters, got ${params.length}: ${params.join(', ')}`)
  assert.equal(params[5], 'healthReader')
  assert.match(REMOTE_SRC, /this\.healthReader\s*=\s*healthReader/, 'the reader must be stored for the method to read')
})

// ---------------------------------------------------------------------------
// The single construction site in index.js must pass all six arguments.
// ---------------------------------------------------------------------------

test('index.js constructs SmartProviderRemote exactly once with six arguments', () => {
  const calls = constructionArgs(INDEX_SRC)
  assert.equal(calls.length, 1, `expected exactly one construction site, found ${calls.length}`)
  const args = calls[0]
  assert.equal(args.length, 6, `expected 6 constructor arguments, got ${args.length}: ${args.join(' | ')}`)
  // Position 5 (0-based) is the health reader; it must be an identifier or
  // closure defined in this file, never an eagerly evaluated snapshot.
  assert.equal(args[5], 'healthReader', 'the sixth argument must be the lazy healthReader closure')
  assert.match(INDEX_SRC, /const healthReader\s*=\s*\(\)\s*=>/, 'healthReader must be a lazily-invoked closure')
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
