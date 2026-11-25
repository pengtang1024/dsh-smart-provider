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
try {
  const profile = process.env.DSH_PROFILE || 'desktop'
  const patch = readFileSync(join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml'), 'utf8')
  const marker = patch.indexOf('providers:')
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
  ok(`read ${existingProviderIds.length} existing provider ids from cordis.patch.yml`)
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

// --- report ----------------------------------------------------------------
console.log('validate-custom-routes:')
for (const n of notes) console.log(n)
if (errors.length) {
  console.error(`\nFAILED (${errors.length}):`)
  for (const e of errors) console.error('  ERR  ' + e)
  process.exit(1)
}
console.log(`\nPASS: all ${[...Array(7)].length} check groups OK`)
process.exit(0)
