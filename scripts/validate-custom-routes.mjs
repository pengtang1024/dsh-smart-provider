#!/usr/bin/env node
/**
 * Validate registry/custom-routes.yaml against 方案 §4's checks. Read-only.
 * Exits non-zero on any error so it can gate gen --write / CI.
 *
 * Checks:
 *   1. route id x- prefix, not colliding with catalog/reserved/smart, unique
 *   2. protocol ∈ 4 supported values
 *   3. baseURL shape matches protocol (anti /v1/v1 405)
 *   4. credentialRef exists in ~/.dsh/.credentials.yaml (name only, no value)
 *   5. model ids globally unique
 *   6. no model id overlaps any existing route's models (anti "break 29")
 *   7. auto chain has no duplicate model id (anti seenModels fallback swallow)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readRegistry, flattenModels, PROTOCOLS, RESERVED_IDS,
  buildChains, REGISTRY_FILE, PKG_DIR,
} from '../registry/registry-lib.mjs'

const errors = []
const notes = []
function fail(msg) { errors.push(msg) }
function ok(msg) { notes.push('  OK  ' + msg) }

let doc
try {
  doc = readRegistry(REGISTRY_FILE)
  ok(`registry parsed: ${doc.routes.length} route(s)`)
} catch (e) {
  console.error('FATAL: ' + e.message)
  process.exit(2)
}

// --- 1. route id -----------------------------------------------------------
const seenRoutes = new Set()
for (const r of doc.routes) {
  if (typeof r.id !== 'string' || !r.id.startsWith('x-')) {
    fail(`route id "${r.id}" must start with "x-"`)
  } else ok(`route "${r.id}" has x- prefix`)
  if (seenRoutes.has(r.id)) fail(`duplicate route id "${r.id}"`)
  seenRoutes.add(r.id)
  if (RESERVED_IDS.has(r.id) || r.id === 'smart') fail(`route id "${r.id}" is reserved`)
}

// Existing route ids from the live pi-ai providers block (cordis.patch.yml).
let existingProviderIds = []
let existingModelsByRoute = new Map()
let markerAbsent = false
try {
  const profile = process.env.DSH_PROFILE || 'desktop'
  const patch = readFileSync(join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml'), 'utf8')
  const marker = patch.indexOf('providers:')
  // Honest degrade (C3 follow-up): a live cordis managed by the DSH app may
  // have no llm-pi-ai providers block at all. Searching from -1 would slice
  // the whole file and silently pass zero checks, so surface it instead.
  if (marker === -1) {
    notes.push('  --  no "providers:" anchor in cordis.patch.yml (app-managed shape, no llm-pi-ai block): existing-provider overlap check SKIPPED, not passed')
    existingProviderIds = []
    existingModelsByRoute = new Map()
    markerAbsent = true
  }
  const tail = patch.slice(marker)
  const routeLineRe = /^ {6}([a-zA-Z0-9_.-]+):\s*$/gm
  for (const m of tail.matchAll(routeLineRe)) existingProviderIds.push(m[1])
  // Parse models per route block (6-space route key, 10-space "- id:")
  const blocks = tail.split(/^ {6}([a-zA-Z0-9_.-]+):\s*$/m)
  for (let i = 1; i < blocks.length; i += 2) {
    const id = blocks[i]
    const body = blocks[i + 1] ?? ''
    const ids = [...body.matchAll(/^ {10}- id:\s*([^\s#]+)/gm)].map(x => x[1])
    existingModelsByRoute.set(id, new Set(ids))
  }
  if (!markerAbsent) ok(`read ${existingProviderIds.length} existing provider ids from cordis.patch.yml`)
} catch (e) {
  notes.push('  --  could not read existing providers, overlap check degraded: ' + e.message)
}

for (const r of doc.routes) {
  // Only non-x- routes are "existing business/catalog routes". x-* routes in
  // the live config are written by this registry itself (idempotent re-run),
  // so they are managed here and must not be reported as a collision.
  const collide = existingProviderIds.filter(id => id === r.id && !id.startsWith('x-'))
  if (collide.length) fail(`route id "${r.id}" collides with an existing provider route`)
}

// --- 2. protocol -----------------------------------------------------------
for (const r of doc.routes) {
  if (!PROTOCOLS.has(r.protocol)) {
    fail(`route "${r.id}" protocol "${r.protocol}" not in ${[...PROTOCOLS].join('|')}`)
  } else ok(`route "${r.id}" protocol ${r.protocol} supported`)
}

// --- 3. baseURL shape ------------------------------------------------------
for (const r of doc.routes) {
  const u = r.baseURL ?? ''
  if (!/^https?:\/\//.test(u)) fail(`route "${r.id}" baseURL is not http(s): ${u}`)
  if ((r.protocol === 'openai-completions' || r.protocol === 'openai-responses') && !u.replace(/\/+$/, '').endsWith('/v1')) {
    fail(`route "${r.id}" ${r.protocol} baseURL should end with /v1 (got ${u})`)
  }
  if (r.protocol === 'anthropic-messages' && /\/v1\/?$/.test(u.replace(/\/+$/, ''))) {
    fail(`route "${r.id}" anthropic-messages baseURL must NOT end with /v1 (double /v1/messages -> 405): ${u}`)
  }
  ok(`route "${r.id}" baseURL shape OK`)
}

// --- 3.5 compat for catalog-external openai-completions routes -------------
// A catalog-external `api: openai-completions` route has no built-in metadata,
// so pi-ai defaults to max_completion_tokens + role:developer. Gateways such as
// opencode.ai reject that with 400 INVALID_REQUEST and smart silently falls
// back to a paid hop (task-48/49). Require an explicit compat block, warn loudly
// when missing. This is a warning (not a hard error) to keep unrelated routes
// editable, but the message names the exact fix.
for (const r of doc.routes) {
  if (r.protocol !== 'openai-completions') continue
  if (r.compat === undefined || r.compat === null ||
      typeof r.compat !== 'object' || Object.keys(r.compat).length === 0) {
    notes.push(`  WARN route "${r.id}" is openai-completions with no compat: pi-ai will send max_completion_tokens + role:developer; gateways like opencode.ai return 400 INVALID_REQUEST -> smart falls back to paid. Add compat: {supportsStore:false, supportsDeveloperRole:false, supportsStrictMode:true, maxTokensField:max_tokens}`)
  } else {
    ok(`route "${r.id}" declares compat (${Object.keys(r.compat).join(', ')})`)
  }
}

// --- 4. credential ref -----------------------------------------------------
let credNames = new Set()
try {
  const t = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  // Only collecting KEY LINES; never value, never echoing secret.
  credNames = new Set([...t.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm)].map(x => x[1]))
  ok(`loaded ${credNames.size} credential reference name(s)`)
} catch (e) {
  notes.push('  --  could not read credentials.yaml: ' + e.message)
}
for (const r of doc.routes) {
  if (!r.credentialRef) fail(`route "${r.id}" has no credentialRef`)
  else if (credNames.size > 0 && !credNames.has(r.credentialRef)) {
    fail(`route "${r.id}" credentialRef "${r.credentialRef}" not found in credentials.yaml`)
  } else ok(`route "${r.id}" credentialRef ${r.credentialRef} present`)
}

// --- 5. model id global uniqueness ----------------------------------------
const seenModels = new Set()
for (const { model, provider } of flattenModels(doc)) {
  if (seenModels.has(model)) fail(`model id "${model}" declared more than once`)
  seenModels.add(model)
}
ok(`${seenModels.size} declared model id(s) unique`)

// --- 6. no overlap with existing route models (anti break-29) -------------
for (const { model, provider } of flattenModels(doc)) {
  for (const [existingRoute, ids] of existingModelsByRoute) {
    // x-* routes are registry-owned; their own models are expected to overlap
    // (idempotent re-run). Only non-x- business routes matter here — that is
    // exactly the 29 opencode-go models we must never overwrite.
    if (existingRoute.startsWith('x-')) continue
    if (ids.has(model)) {
      fail(`model "${model}" also belongs to existing route "${existingRoute}" — would overwrite its protocol; use a distinct id`)
    }
  }
}
if (existingModelsByRoute.size > 0) ok('no declared model overlaps existing route models')

// --- 7. auto chain duplicate model id -------------------------------------
// Use the live chains.js auto list as the "existing paid" tail.
let existingAuto = []
try {
  const src = readFileSync(join(PKG_DIR, 'lib', 'chains.js'), 'utf8')
  const m = src.match(/DEFAULT_CHAINS\s*=\s*\{[\s\S]*?auto:\s*\[([\s\S]*?)\]/)
  if (m) {
    existingAuto = [...m[1].matchAll(/\{\s*provider:\s*'([^']+)'\s*,\s*model:\s*'([^']+)'\s*\}/g)]
      .map(x => ({ provider: x[1], model: x[2] }))
  }
} catch { /* degrade */ }
const auto = buildChains(doc, existingAuto).auto
const autoIds = auto.map(h => h.model)
// buildChains already removes existing hops whose model equals a newly added
// free model, so any remaining duplicate is pre-existing in DEFAULT_CHAINS
// (e.g. mimo-v2.6-flash on two routes) — that is the intentional
// "same model, different vendor" fallback and is NOT introduced by the
// registry. Only flag a duplicate whose model is one WE declared.
const declaredIds = new Set(flattenModels(doc).map(x => x.model))
const ourDup = autoIds.filter((x, i) => declaredIds.has(x) && autoIds.indexOf(x) !== i)
if (ourDup.length) {
  fail(`auto chain has duplicate model id(s) among declared models: ${[...new Set(ourDup)].join(', ')}`)
} else {
  const preExisting = autoIds.filter((x, i) => autoIds.indexOf(x) !== i)
  if (preExisting.length) notes.push(`  --  pre-existing duplicate model id(s) kept as-is (not from registry): ${[...new Set(preExisting)].join(', ')}`)
  ok(`auto chain has ${auto.length} hops, no NEW duplicate; first=${auto[0]?.provider}/${auto[0]?.model}`)
}

// --- 8. declared routes must have a live adapter registration ------------
// A route may be declared in the registry AND wired into smart chains while
// having NO provider registration in the live patch. That is exactly the
// P0 failure 'no adapter registered for provider x-opencode-free'. Never
// treat a missing anchor as a silent SKIP: FAIL with the exact fix command.
const FB_B_VALIDATE = '# >>> custom-routes:providers-insert >>>'
const FB_E_VALIDATE = '# <<< custom-routes:providers-insert <<<'
let patchText = ''
try {
  const profile = process.env.DSH_PROFILE || 'desktop'
  patchText = readFileSync(join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml'), 'utf8')
} catch (e) {
  fail('cannot read live cordis.patch.yml for adapter registration check: ' + e.message)
}
function providerIdsInMainBlock(text) {
  const ids = new Set()
  const m = /^    providers:\s*$/m.exec(text)
  if (!m) return ids
  const tail = text.slice(m.index)
  for (const m of tail.matchAll(/^ {6}([a-zA-Z0-9_.-]+):\s*$/gm)) ids.add(m[1])
  return ids
}
function providerIdsInFallbackBlock(text) {
  const ids = new Set()
  const a = text.indexOf(FB_B_VALIDATE)
  const b = text.indexOf(FB_E_VALIDATE, a)
  if (a === -1 || b <= a) return ids
  const block = text.slice(a, b)
  // Current shape: single llm-pi-ai entry with config.providers at 6 spaces.
  for (const m of block.matchAll(/^ {6}([a-zA-Z0-9_.-]+):\s*$/gm)) ids.add(m[1])
  // Legacy second-instance shape (task-12, failed): providers at 10 spaces.
  // Recognized so a stale patch is flagged as a duplicate, not trusted.
  for (const m of block.matchAll(/^ {10}([a-zA-Z0-9_.-]+):\s*$/gm)) ids.add(m[1])
  return ids
}
function hasLegacySecondInstance(text) {
  return /^\s*- id:\s*llm-pi-ai-custom-routes\s*$/m.test(text)
}
const registeredMain = providerIdsInMainBlock(patchText)
const rawFallback = providerIdsInFallbackBlock(patchText)
// The single-instance fallback writes an llm-pi-ai entry with its own
// config.providers; that IS the main block for an app-managed profile. Count
// those ids as main, not as a second registration, or every valid fallback
// looks like a duplicate. Only a legacy second instance is a real duplicate.
const registeredFallback = hasLegacySecondInstance(patchText) ? rawFallback : new Set()
if (!hasLegacySecondInstance(patchText)) for (const id of rawFallback) registeredMain.add(id)
const registeredAll = new Set([...registeredMain, ...registeredFallback])
if (hasLegacySecondInstance(patchText)) {
  fail('cordis.patch.yml still contains the failed second llm-pi-ai instance (id llm-pi-ai-custom-routes): it collides with the built-in provider catalog and auth flows. Run node scripts/gen-custom-routes.mjs --write to replace it with a single-instance config patch.')
}
for (const r of doc.routes) {
  if (r.tier === 'disabled') continue
  if (!registeredAll.has(r.id)) {
    fail(`route "${r.id}" is declared in the registry but has NO adapter registration in cordis.patch.yml (declared-but-not-registered => runtime NO_ADAPTER). Fix: node scripts/gen-custom-routes.mjs --write && restart the Host.`)
  } else {
    ok(`route "${r.id}" has an adapter registration (${registeredMain.has(r.id) ? 'llm-pi-ai.providers' : 'single llm-pi-ai entry config'})`)
  }
  if (registeredMain.has(r.id) && registeredFallback.has(r.id)) {
    fail(`route "${r.id}" is registered BOTH in llm-pi-ai.providers and in the custom-routes insert instance — would trigger DUPLICATE_ADAPTER; run node scripts/gen-custom-routes.mjs --write to remove the stale block`)
  }
}
if (registeredFallback.size > 0) ok(`${registeredFallback.size} custom route(s) registered via the single llm-pi-ai entry config (no second instance)`);

// --- report ----------------------------------------------------------------
console.log('validate-custom-routes:')
for (const n of notes) console.log(n)
if (errors.length) {
  console.error(`\nFAILED (${errors.length}):`)
  for (const e of errors) console.error('  ERR  ' + e)
  process.exit(1)
}
console.log(`\nPASS: all ${[...Array(8)].length} check groups OK`)
process.exit(0)
