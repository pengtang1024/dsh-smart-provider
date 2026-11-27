/**
 * Tier selection + relax-diagnostic tests for lib/routing.js (task-7).
 *
 * The contract under test: when no position tier matches a request, routing
 * RELAXES to every available route (a request is never blocked) and the WARN
 * must be actionable — which tag is missing, what each candidate carries, why
 * the tags are absent, and a copy-pasteable positionOverrides snippet.
 *
 * Pure logic only (no DSH packages, no app.asar): runs under any Node.
 * Run: node --test test/routing-tier.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  POSITION_TAGS, classifyTask, derivePosition, selectTiers, explainTierMiss,
  resolveRoutingPolicy,
} from '../lib/routing.js'

const RELAX_LINE = 'smart routing: no tier matches task "reasoning"; relaxing to all available routes'

/** selectTiers with a captured warn sink (the production seam: adapter passes logger.warn). */
function capture(task, positions, routes, policy = {}) {
  const warns = []
  const tiers = selectTiers(task, positions, routes, { ...policy, warn: message => warns.push(message) })
  return { tiers, warns }
}

function reasoningTask(extra = {}) {
  return { kind: 'reasoning', secondary: [], signals: ['reasoningEffort'], ...extra }
}

/** Real-world "only general candidates": catalog proves a chat model and nothing else. */
function onlyGeneral() {
  const tagsFor = id => derivePosition({ id, tool: true, contextWindow: 8000 }).tags
  return new Map([
    ['alpha-route', { tags: tagsFor('chat-mini') }],
    ['beta-route', { tags: tagsFor('chat-pro') }],
  ])
}

// ---------------------------------------------------------------------------
// 1) A matching tier is selected and nothing is warned
// ---------------------------------------------------------------------------

test('matching tier: picked in priority order, secondary kind gets the next tier, no warn', () => {
  const positions = new Map([
    ['deep-route', { tags: ['reasoning', 'tool', 'general'] }],
    ['chat-route', { tags: ['tool', 'general'] }],
  ])
  const task = { kind: 'reasoning', secondary: ['tool'], signals: [] }
  const { tiers, warns } = capture(task, positions, ['deep-route', 'chat-route'])
  assert.deepEqual(warns, [])
  assert.deepEqual(tiers, [
    { position: 'reasoning', routes: ['deep-route'] },
    { position: 'tool', routes: ['deep-route', 'chat-route'] },
  ])
  // tierLimit still applies to a successful selection
  assert.deepEqual(capture(task, positions, ['deep-route', 'chat-route'], { tierLimit: 1 }).tiers, [
    { position: 'reasoning', routes: ['deep-route'] },
  ])
})

test('general task with general routes selects the general tier and stays silent', () => {
  const task = classifyTask({ messages: [{ content: 'hi' }] })
  assert.equal(task.kind, 'general')
  const { tiers, warns } = capture(task, onlyGeneral(), ['alpha-route', 'beta-route'])
  assert.deepEqual(warns, [])
  assert.deepEqual(tiers, [{ position: 'general', routes: ['alpha-route', 'beta-route'] }])
})

// ---------------------------------------------------------------------------
// 2) No matching tier: relax to all routes + actionable diagnostic
// ---------------------------------------------------------------------------

test('no matching tier: relaxes to every route and the diagnostic names the missing tag, the candidates and a copy-paste fix', () => {
  const positions = onlyGeneral()
  const routes = ['alpha-route', 'beta-route']
  const { tiers, warns } = capture(reasoningTask(), positions, routes)

  // Relax behaviour is unchanged: one general tier holding EVERY route.
  assert.deepEqual(tiers, [{ position: 'general', routes }])
  assert.equal(warns.length, 1)
  const [message] = warns

  // The historical first line survives verbatim, so log greps keep working.
  assert.ok(message.startsWith(RELAX_LINE), message)
  // What the request needed, and what is missing everywhere.
  assert.match(message, /task: kind="reasoning" signals=\[reasoningEffort\]/)
  assert.match(message, /needed position tag\(s\): "reasoning" — no candidate route carries "reasoning"/)
  // What each candidate actually carries.
  assert.match(message, /candidate routes \(2\) and the position tags they do carry:/)
  assert.match(message, /- alpha-route: tool, general/)
  assert.match(message, /- beta-route: tool, general/)
  // Why it is missing, and the exact lever that adds it.
  assert.match(message, /why "reasoning" is missing everywhere: auto-derived only when the model catalog reports reasoning:true/)
  // A copy-pasteable positionOverrides snippet (README array form).
  assert.match(message, /"ranking": \{"routing":\{"positionOverrides":\{"alpha-route\/<model-id>":\["reasoning"\]\}\}\}/)
  assert.match(message, /registry form: \{"overrides":\{"alpha-route\/<model-id>":\{"tags":\["reasoning"\]\}\}\}/)
  // Honest about the other knob.
  assert.match(message, /tierPolicy only reorders which tier is tried first; it cannot invent a tag that no route carries/)
  assert.match(message, /relax outcome: all 2 route\(s\) stay available; the request is NOT blocked/)
  // And it never fabricates a reasoning tier just to look healthy.
  assert.deepEqual(tiers.map(tier => tier.position), ['general'])
  // Relax also ignores tierLimit: it never narrows the route list away.
  assert.deepEqual(capture(reasoningTask(), positions, routes, { tierLimit: 1 }).tiers, [
    { position: 'general', routes },
  ])
})

test('explainTierMiss exposes structured evidence, not just a string', () => {
  const routes = ['alpha-route', 'beta-route']
  const info = explainTierMiss({ kind: 'vision', secondary: ['general'], signals: ['image'] }, onlyGeneral(), routes)
  assert.deepEqual(info.wanted, ['vision', 'general'])
  assert.deepEqual(info.missing, ['vision'])
  assert.deepEqual(info.candidates, [
    { route: 'alpha-route', tags: ['tool', 'general'] },
    { route: 'beta-route', tags: ['tool', 'general'] },
  ])
  assert.deepEqual(info.suggestion.positionOverrides, { 'alpha-route/<model-id>': ['vision'] })
  assert.match(info.message, /needed position tag\(s\): "vision", "general" — no candidate route carries "vision"/)
})

test('diagnostic truncates long candidate lists instead of flooding the log', () => {
  const routes = Array.from({ length: 12 }, (_, i) => 'route-' + i)
  const positions = new Map(routes.map(route => [route, { tags: ['general'] }]))
  const { warns } = capture(reasoningTask(), positions, routes)
  assert.match(warns[0], /candidate routes \(12\)/)
  assert.match(warns[0], /… and 4 more route\(s\)/)
  assert.equal(warns[0].split('\n').filter(line => line.startsWith('    - ')).length, 8)
})

test('empty route list: no tiers, but still one actionable log line instead of silence', () => {
  const { tiers, warns } = capture(reasoningTask(), new Map(), [])
  assert.deepEqual(tiers, [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /no routes available for task "reasoning"; tier selection skipped and the request is NOT blocked/)
})

// ---------------------------------------------------------------------------
// 3) positionOverrides actually works (README array form + registry object form)
// ---------------------------------------------------------------------------

test('positionOverrides (documented array form) makes the tier match and silences the warn', () => {
  const model = { id: 'chat-pro', reasoning: false, tool: true, contextWindow: 32000 }
  const policy = resolveRoutingPolicy({ routing: { positionOverrides: { 'alpha-route/chat-pro': ['reasoning'] } } })
  const declared = policy.positionOverrides['alpha-route/chat-pro']
  assert.deepEqual(declared, ['reasoning'])

  const tags = derivePosition(model, declared).tags
  assert.ok(tags.includes('reasoning'), 'declared tag must survive the merge')
  assert.ok(tags.includes('tool'), 'catalog capability must not be replaced')
  assert.ok(tags.includes('general'), 'general must never be dropped')

  const { tiers, warns } = capture(reasoningTask(), new Map([['alpha-route', { tags }]]), ['alpha-route'])
  assert.deepEqual(warns, [])
  assert.deepEqual(tiers, [{ position: 'reasoning', routes: ['alpha-route'] }])
})

test('derivePosition accepts BOTH override shapes, merges with catalog tags, filters junk', () => {
  const model = { id: 'm', reasoning: false, contextWindow: 8000, input: ['text'], tool: true }
  const arrayTags = derivePosition(model, ['reasoning', 'longctx']).tags
  const objectTags = derivePosition(model, { tags: ['reasoning', 'longctx'] }).tags
  assert.deepEqual(arrayTags, objectTags, 'README array form and registry object form must agree')
  assert.deepEqual(arrayTags, ['tool', 'general', 'reasoning', 'longctx'])

  // Conservative merge: catalog-derived capabilities are merged, never replaced.
  const merged = derivePosition({ id: 'm', reasoning: true, input: ['image'], tool: true }, ['thrifty']).tags
  assert.deepEqual(merged, ['reasoning', 'vision', 'tool', 'general', 'thrifty'])

  // Whitelist + case-insensitive + junk-tolerant.
  assert.deepEqual(derivePosition(model, [' Reasoning ', 'nope', 7]).tags, ['tool', 'general', 'reasoning'])
  // Absent or malformed overrides change nothing (never throw).
  assert.deepEqual(derivePosition(model, undefined).tags, ['tool', 'general'])
  assert.deepEqual(derivePosition(model, { tags: 'reasoning' }).tags, ['tool', 'general'])
  assert.deepEqual(derivePosition(model, []).tags, ['tool', 'general'])
})

test('reasoning-first is a hint, not a fix: the forced tier still relaxes and explains itself', () => {
  const policy = resolveRoutingPolicy({ routing: { strategy: 'reasoning-first' } })
  assert.equal(policy.tierPolicy, 'reasoning')
  const { tiers, warns } = capture({ kind: policy.tierPolicy, secondary: [] }, onlyGeneral(), ['alpha-route'])
  assert.deepEqual(tiers.map(tier => tier.position), ['general'])
  assert.match(warns[0], /needed position tag\(s\): "reasoning"/)
  assert.match(warns[0], /tierPolicy only reorders/)
})

// ---------------------------------------------------------------------------
// 4) Tier-limit handling (defect: -1/0 used to select ZERO tiers)
// ---------------------------------------------------------------------------

test('tierLimit: -1/0/non-numeric fall back to the documented default; 1/2/fraction slice as documented', () => {
  const positions = new Map([
    ['a', { tags: ['reasoning', 'general', 'tool'] }],
    ['b', { tags: ['tool', 'general'] }],
  ])
  const task = { kind: 'reasoning', secondary: ['tool', 'general'] }
  const at = limit => selectTiers(task, positions, ['a', 'b'], { tierLimit: limit })

  const full = [{ position: 'reasoning', routes: ['a'] }, { position: 'tool', routes: ['a', 'b'] }, { position: 'general', routes: ['a', 'b'] }]
  const defaulted = full.slice(0, 2) // DEFAULT_TIER_LIMIT === 2
  // Never "matched but selected nothing".
  assert.deepEqual(at(-1), defaulted)
  assert.deepEqual(at(0), defaulted)
  assert.deepEqual(at(undefined), defaulted)
  assert.deepEqual(at(NaN), defaulted)
  assert.deepEqual(at(1), full.slice(0, 1))
  assert.deepEqual(at(2), defaulted)
  assert.deepEqual(at(1.7), full.slice(0, 1))
  assert.deepEqual(full.length, 3)
})

// ---------------------------------------------------------------------------
// 5) Contract edges: both positions shapes, purity, absent inputs
// ---------------------------------------------------------------------------

test('plain-object positions behave exactly like the Map form', () => {
  const plain = { 'alpha-route': { tags: ['general', 'tool'] } }
  const map = new Map([['alpha-route', { tags: ['general', 'tool'] }]])
  const fromPlain = capture(reasoningTask(), plain, ['alpha-route'])
  const fromMap = capture(reasoningTask(), map, ['alpha-route'])
  assert.deepEqual(fromPlain.tiers, fromMap.tiers)
  assert.deepEqual(fromPlain.warns, fromMap.warns)
  assert.equal(fromPlain.warns.length, 1)
})

test('diagnosis is read-only: task/positions/routes are not mutated', () => {
  const task = reasoningTask({ secondary: ['tool'] })
  const positions = onlyGeneral()
  const snapshot = new Map([...positions].map(([route, pos]) => [route, { tags: [...pos.tags] }]))
  const routes = ['alpha-route', 'beta-route']
  selectTiers(task, positions, routes, { warn: () => {} })
  explainTierMiss(task, positions, routes)
  assert.deepEqual(task, reasoningTask({ secondary: ['tool'] }))
  assert.deepEqual(positions, snapshot)
  assert.deepEqual(routes, ['alpha-route', 'beta-route'])
})

test('never throws and never invents a tier on absent task/positions', () => {
  const info = explainTierMiss(undefined, undefined, ['alpha-route'])
  assert.deepEqual(info.wanted, [])
  assert.deepEqual(info.missing, [])
  assert.match(info.message, /kind="unknown"/)
  assert.doesNotThrow(() => selectTiers(undefined, undefined, ['alpha-route'], {}))
  assert.doesNotThrow(() => selectTiers(undefined, undefined, [], {}))
  assert.doesNotThrow(() => selectTiers(reasoningTask(), undefined, ['alpha-route']))
  // Both "none" (wire sentinel) and "off" (DSH canonical value) mean OFF —
  // no reasoning tier is invented upstream either; "high" is a real signal.
  assert.equal(classifyTask({ messages: [{ content: 'hi' }], reasoningEffort: 'none' }).kind, 'general')
  assert.equal(classifyTask({ messages: [{ content: 'hi' }], reasoningEffort: 'off' }).kind, 'general')
  assert.equal(classifyTask({ messages: [{ content: 'hi' }], reasoningEffort: 'high' }).kind, 'reasoning')
})

test('every position tag hint covers a documented tag', () => {
  // Guards the diagnostic from silently degrading to the generic sentence.
  for (const tag of POSITION_TAGS) {
    const probe = explainTierMiss({ kind: tag, secondary: [] }, new Map([['r', { tags: ['general'] }]]), ['r'])
    assert.ok(probe.message.includes('why "' + tag + '" is missing everywhere:'), tag)
    assert.ok(!probe.message.includes('no auto-derivation rule exists'), tag)
  }
})
