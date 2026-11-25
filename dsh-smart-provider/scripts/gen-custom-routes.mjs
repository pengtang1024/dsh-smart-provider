#!/usr/bin/env node
/**
 * Generate downstream artifacts from registry/custom-routes.yaml.
 *
 * Default = DRY RUN (print what would change, touch nothing):
 *   node scripts/gen-custom-routes.mjs --write     # actually write
 *
 * Artifacts (all idempotent, marker-delimited):
 *   1. cordis.patch.yml  -> x-* route under llm-pi-ai.providers
 *                        -> smart-provider config.chains (volatile, free-first)
 *   2. client.js         -> CUSTOM_PROVIDERS / CUSTOM_MODELS candidates
 *   3. lib/pricing.json  -> zero-priced entries for free models (the ONLY
 *                           content this script ever writes there;
 *                           lib/pricing.example.json is never touched)
 *
 * It NEVER edits an existing provider route or its models. The two cordis
 * marker pairs use deliberately DISTINCT text so one cannot substring-match
 * the other (an earlier bug inserted chains blocks inside providers).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readRegistry, readExistingAuto, buildChains, buildProviders, buildPricing,
  flattenModels, yaml, describeChange, REGISTRY_FILE, PKG_DIR, RESERVED_IDS,
} from '../registry/registry-lib.mjs'

const WRITE = process.argv.includes('--write')
// Resolve the profile the same way DSH itself does (DSH_PROFILE, default
// 'desktop'), so this script also works for users on a non-desktop profile.
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const CORDIS = join(homedir(), '.dsh', 'profiles', PROFILE, 'cordis.patch.yml')

// Distinct marker texts — no one is a substring of another.
const PM_B = '      # >>> custom-routes:providers >>>'
const PM_E = '      # <<< custom-routes:providers <<<'
const CM_B = '    # >>> custom-routes:chains >>>'
const CM_E = '    # <<< custom-routes:chains <<<'
const JS_B = '// >>> custom-routes:candidates >>>'
const JS_E = '// <<< custom-routes:candidates <<<'
// Fallback registration for app-managed profiles that have no llm-pi-ai
// "providers:" anchor. P0 2026-11-25: a SECOND dsh-llm-pi-ai instance cannot
// coexist with the app-managed one — apply() unconditionally registers every
// installed catalog provider as configurable (DUPLICATE_DIRECTORY) and one
// authorization flow per catalog provider (DUPLICATE_FLOW) on every mount,
// with no config switch (Config only has "providers"). Verified in asar:
// dsh-llm-pi-ai/src/index.ts:169,264,280,305; dsh-llm/lib/index.js:2041.
// So the fallback patches the SINGLE existing llm-pi-ai entry's config with a
// providers dict, which is a whole-config replace but the entry had no
// configured providers before (that is exactly why the anchor is absent).
const FB_B = '# >>> custom-routes:providers-insert >>>'
const FB_E = '# <<< custom-routes:providers-insert <<<'
const PI_ID = 'llm-pi-ai'
const PI_NAME = '@deepseek-ai/dsh-llm-pi-ai'

/** Replace an exact marker block, or insert `body` right after `anchor`.
 *  `begin` must be unique in the document; we guard against duplicates.
 *  Returns null when `anchorAfter` is given but absent — callers decide
 *  whether to degrade honestly (warn + skip) or fail hard. Never silently
 *  injects a synthetic block into a document that has no anchor for it. */
function upsertBlock(text, begin, end, body, anchorAfter) {
  const a = text.indexOf(begin)
  const b = text.indexOf(end)
  if (a !== -1 && b !== -1 && b > a) {
    // Guard: if a second `begin` exists we would loop growing the file.
    if (text.indexOf(begin, a + 1) !== -1) {
      throw new Error(`duplicate marker ${begin.trim()} — refusing to grow the file`)
    }
    return text.slice(0, a) + body + text.slice(b + end.length)
  }
  if (anchorAfter === undefined) {
    // Append mode (client.js): marker absent -> append at end of module.
    return text.trimEnd() + '\n\n' + body + '\n'
  }
  const i = text.indexOf(anchorAfter)
  if (i === -1) return null // anchor absent: caller degrades (warn+skip); no injection
  const at = i + anchorAfter.length
  return text.slice(0, at) + '\n' + body + '\n' + text.slice(at)
}

/**
 * Top-level entry ids of a cordis patch (list items at column 0).
 * Used by the no-deletion guard below: the generator may edit the llm-pi-ai
 * providers block and the smart-provider config, but must NEVER add, drop or
 * rename a top-level plugin entry (history: agent-default-model was lost).
 */
function topLevelIds(text) {
  const doc = yaml.parse(text)
  if (!Array.isArray(doc)) throw new Error('cordis.patch.yml: top level is not a list')
  return doc.map(x => x?.id).filter(id => typeof id === 'string')
}

const doc = readRegistry(REGISTRY_FILE)
const providers = buildProviders(doc)
const originalCordis = readFileSync(CORDIS, 'utf8')
const idsBefore = topLevelIds(originalCordis)
let cordis = originalCordis

// ---- 1. providers block (6-space indent, inside llm-pi-ai.providers) ------
const providersYaml = yaml.stringify(providers, { indent: 2 }).trimEnd()
  .split('\n').map(l => '      ' + l).join('\n')
const providersBlock = `${PM_B}\n${providersYaml}\n${PM_E}`
// Anchor = a 4-space "providers:" line. A bare string also substring-matches
// the legacy 8-space insert line and our own fallback block; the marker-range
// check below excludes the latter. The former is removed by the anchor-present
// branch, so it cannot survive a gen --write.
const providersAnchor = '\n    providers:\n'
const fallbackAnchorAt = cordis.indexOf(FB_B)
const fallbackEndAt = fallbackAnchorAt === -1 ? -1 : cordis.indexOf(FB_E, fallbackAnchorAt)
// An existing fallback marker owns its llm-pi-ai entry and that entry IS now
// the canonical anchor. On re-run, do not insert a NEW providers block into
// the file; let the marker upsert replace the whole block in place.
const providersAnchorInFallback = fallbackAnchorAt !== -1 && fallbackEndAt > fallbackAnchorAt
const upserted = providersAnchorInFallback
  ? null
  : upsertBlock(cordis, PM_B, PM_E, providersBlock, providersAnchor)
let providersAnchorMissing = false
let chainsAnchorMissing = false
if (upserted === null) {
  providersAnchorMissing = true
  // App-managed profiles have no llm-pi-ai providers anchor: that means the
  // single app-managed llm-pi-ai instance has no configured providers, not that
  // a second instance is needed. A second instance is FATAL — apply() registers
  // the whole catalog as configurable providers and auth flows on every mount
  // (see constants above). Patch the one existing entry's config instead.
  if ('smart' in providers || Object.keys(providers).some(id => RESERVED_IDS.has(id))) {
    throw new Error('gen-custom-routes: refusing to register a reserved provider in fallback insert (smart/RESERVED_IDS must not be declared twice — DUPLICATE_ADAPTER)')
  }
  // Marker block holds the full llm-pi-ai entry (column 0). providersYaml is
  // already 6-space indented (route keys under a "providers:" key); inside
  // "- id:" -> config -> providers the route keys sit at 6 spaces too, so no
  // re-indent is needed — only the "providers:" key itself is added at 4.
  const fallbackBlock = [
    FB_B,
    '- id: ' + PI_ID,
    "  name: '" + PI_NAME + "'",
    '  config:',
    '    providers:',
    providersYaml,
    FB_E,
  ].join('\n')
  cordis = upsertBlock(cordis, FB_B, FB_E, fallbackBlock)
  console.warn('WARN providers: live cordis.patch.yml has no llm-pi-ai "providers:" anchor (app-managed shape) — registered x-* routes in the single llm-pi-ai entry config (marker ' + FB_B.trim() + '). Verify: grep -n "' + FB_B.trim() + '" ~/.dsh/profiles/' + PROFILE + '/cordis.patch.yml && node scripts/validate-custom-routes.mjs; then restart the Host to recompose the plugin tree.')
} else {
  // Existing anchor: keep the original in-place update. The upserter already
  // rewrote the providers body at the anchor. Drop any stale fallback marker
  // (legacy insert form or our own earlier single-instance form): for the
  // single-instance form the upserter has already refreshed the anchor entry,
  // so deleting the duplicate column-0 block is correct.
  cordis = upserted
  if (cordis.includes(FB_B) && cordis.includes(FB_E)) {
    const a = cordis.indexOf(FB_B)
    const b = cordis.indexOf(FB_E, a) + FB_E.length
    cordis = cordis.slice(0, a) + cordis.slice(b).replace(/^\n/, '')
  }
}

// ---- 2. smart config.chains block (4-space indent, volatile) -------------
const chainsSrc = readFileSync(join(PKG_DIR, 'lib', 'chains.js'), 'utf8')
const existingAuto = readExistingAuto(chainsSrc)
const chains = buildChains(doc, existingAuto)
const chainsYaml = yaml.stringify({ chains }, { indent: 2 }).trimEnd()
  .split('\n').map(l => '    ' + l).join('\n')
const chainsBlock = `${CM_B}\n${chainsYaml}\n${CM_E}`
// Quote-agnostic: yaml.stringify emits the name with double quotes while
// hand-written patches often use single quotes; accept both shapes.
const smartPrefixRe = /- id: smart-provider\n  name: (['"])@local\/dsh-smart-provider\1\n  config:/
const smartAnchorRe = /- id: smart-provider\n  name: (['"])@local\/dsh-smart-provider\1\n  config: \{\}\n/
let finalCordis
if (cordis.includes(CM_B) && cordis.includes(CM_E)) {
  const a = cordis.indexOf(CM_B)
  const b = cordis.indexOf(CM_E, a) + CM_E.length
  finalCordis = cordis.slice(0, a) + chainsBlock + cordis.slice(b)
} else if (smartAnchorRe.test(cordis)) {
  // Replace `config: {}` with `config:\n<chains block>` in one shot,
  // preserving the quote style the patch already uses.
  const matched = cordis.match(smartAnchorRe)[0]
  finalCordis = cordis.replace(matched, matched.replace(/config: \{\}\n$/, 'config:\n' + chainsBlock + '\n'))
} else if (smartPrefixRe.test(cordis)) {
  // Legacy/foreign shape: `config:` already has a bare `chains:` subtree
  // (e.g. written by an older generator, or by hand). Replace exactly the
  // smart-provider config subtree up to the next top-level `- id:` row,
  // wrapping it in our markers so subsequent runs are idempotent. Never
  // touch any other entry.
  const m3 = cordis.match(smartPrefixRe)
  const a = m3.index
  const nextRow = cordis.indexOf('\n- id:', a + m3[0].length)
  const end = nextRow === -1 ? cordis.length : nextRow + 1
  finalCordis = cordis.slice(0, a) + m3[0] + '\n' + chainsBlock + '\n' + cordis.slice(end)
} else {
  // Honest degrade: no smart-provider entry in the live patch either. Warn and
  // skip the chains artifact instead of failing the whole generation.
  console.warn('WARN chains: live cordis.patch.yml has no recognizable smart-provider config anchor (entry missing or config shape not {}/config: subtree) — chains block NOT written; other artifacts still generated.')
  chainsAnchorMissing = true
  finalCordis = cordis
}

// ---- 3. client.js candidates ---------------------------------------------
const clientPath = join(PKG_DIR, 'client.js')
const clientBefore = readFileSync(clientPath, 'utf8')
const provIds = [...new Set((doc.routes ?? []).map(r => r.id))]
// task-77: list ALL declared free models (custom route + catalog-backed) so
// the first screen can show availability markers instead of hiding them.
const modelIds = [
  ...flattenModels(doc).map(x => x.model),
  ...(doc.catalog_models ?? []).map(m => m.id),
]
// task-77 availability manifest: every declared free model, with status and
// evidence, emitted as a comment block so operators can see "接入但不可用" at
// a glance. Availability never deletes a model — unavailable ones are only
// excluded from the auto chain (see registry-lib buildChains).
const statusRows = [
  ...(doc.routes ?? []).flatMap(r => (r.models ?? []).map(m => ({ id: m.id, status: m.status ?? 'unverified', reason: m.status_reason ?? '' }))),
  ...(doc.catalog_models ?? []).map(m => ({ id: m.id, status: m.status ?? 'unverified', reason: m.status_reason ?? '' })),
]
const statusManifest = [
  '// BEGIN free-model availability (generated — task-77)',
  ...statusRows.map(x => `// ${x.id}: ${x.status}${x.reason ? ' — ' + x.reason : ''}`),
  '// END free-model availability',
].join('\n')
const clientBody = `${JS_B}\nconst CUSTOM_PROVIDERS = ${JSON.stringify(provIds)};\nconst CUSTOM_MODELS = ${JSON.stringify(modelIds)};\n${statusManifest}\n${JS_E}`
const clientAfter = upsertBlock(clientBefore, JS_B, JS_E, clientBody, undefined)

// ---- 4. pricing.json (product default: zero-price declarations ONLY) ------
// C3 ruling: pricing is user data, never a product default. This artifact
// manages ONLY lib/pricing.json, whose entries must all be zero-priced
// (free-tier) declarations. buildPricing() can emit REAL per-token prices when
// a registry model declares m.price — those are user data and are refused
// here with a loud note (they belong in the user's own table via
// registry/pricing.user.json or DSH_SMART_PRICING_FILE). The example export
// lib/pricing.example.json is NEVER read or written by this script.
const pricingPath = join(PKG_DIR, 'lib', 'pricing.json')
const pricingBefore = readFileSync(pricingPath, 'utf8')
const pricing = JSON.parse(pricingBefore)
const pricedRows = []
const additions = buildPricing(doc).filter(e => {
  if ((pricing.entries ?? []).some(x => `${x.provider}/${x.model}` === `${e.provider}/${e.model}`)) return false
  if ((Number(e.input) || 0) > 0 || (Number(e.output) || 0) > 0) { pricedRows.push(e); return false }
  return true
})
if (pricedRows.length) {
  console.warn('pricing: skipped REAL-price rows (user data never ships as a product default; declare them in registry/pricing.user.json instead):')
  for (const e of pricedRows) console.warn(`  - ${e.provider}/${e.model} (input=${e.input}, output=${e.output})`)
}
pricing.entries = [...(pricing.entries ?? []), ...additions]
pricing._rows = pricing.entries.length
const pricingAfter = JSON.stringify(pricing, null, 2) + '\n'

// ---- no-deletion guard: top-level entry ids must be byte-for-byte stable --
// Hard-fail if the STARTING patch already lost an entry that must exist: a
// prior agent wrote cordis outside this generator and dropped
// agent-default-model (2026-11-24 P0). A set-diff guard alone would silently
// bake the missing entry into every future gen, so require the invariant too.
// Required top-level ids depend on what the live patch actually hosts. On an
// app-managed profile without an llm-pi-ai block (providers/chains degraded
// above), demanding llm-pi-ai would misfire — require only ids that exist in
// the starting patch's expected shape, and record what was waived.
const REQUIRED_IDS = ['agent-default-model', 'smart-provider', 'llm-pi-ai']
const waivedRequired = [
  ...(providersAnchorMissing ? ['llm-pi-ai'] : []),
  ...(chainsAnchorMissing ? ['smart-provider'] : []),
]
const missingRequired = REQUIRED_IDS.filter(id => !idsBefore.includes(id) && !waivedRequired.includes(id))
if (waivedRequired.length) {
  console.warn('GUARD NOTE: ' + waivedRequired.join(', ') + ' not present in live cordis.patch.yml (app-managed shape) — requirement waived for this run, not baked into any file.')
}
if (missingRequired.length) {
  console.error('GUARD FAIL: cordis.patch.yml is missing required top-level entries: ' + missingRequired.join(', '))
  console.error('  Restore them BEFORE gen --write; refusing to bake a broken patch.')
  process.exit(3)
}
const idsAfter = topLevelIds(finalCordis)
// The fallback entry itself is owned by this marker. On a second --write run
// it is already present in idsBefore; it must be allowed to be replaced (not
// counted as removed) so the run is byte-idempotent.
const fallbackOwned = originalCordis.includes(FB_B) && originalCordis.includes(FB_E)
const removed = idsBefore.filter(id => !idsAfter.includes(id) && !(fallbackOwned && id === PI_ID))
// The single-instance fallback adds one `llm-pi-ai` patch entry to an
// app-managed profile that has no llm-pi-ai entry in its patch layer at all.
// That entry is the app's own plugin (name asserted below), not a new plugin
// instance, and is required for the x-* routes to have an adapter. Any OTHER
// added id is still a hard failure.
const EXPECTED_FALLBACK_ADD = providersAnchorMissing ? [PI_ID] : []
const added = idsAfter.filter(id => !idsBefore.includes(id) && !EXPECTED_FALLBACK_ADD.includes(id))
const duplicated = idsAfter.filter((id, i) => idsAfter.indexOf(id) !== i)
if (removed.length || added.length || duplicated.length) {
  console.error('GUARD FAIL: top-level entry id set changed — refusing to write cordis.patch.yml')
  if (removed.length) console.error('  removed: ' + removed.join(', '))
  if (added.length) console.error('  unexpected added: ' + added.join(', '))
  if (duplicated.length) console.error('  duplicated: ' + duplicated.join(', '))
  process.exit(3)
}
if (providersAnchorMissing && !idsBefore.includes(PI_ID) && !idsAfter.includes(PI_ID)) {
  console.error('GUARD FAIL: app-managed fallback must add exactly one "' + PI_ID + '" patch entry')
  process.exit(3)
}
console.log(`guard: ${idsAfter.length} top-level entry ids unchanged (incl. agent-default-model=${idsAfter.includes('agent-default-model')})`)

// ---- report ---------------------------------------------------------------
console.log(`gen-custom-routes: ${WRITE ? '--write' : 'DRY RUN'} (${doc.routes.length} route(s), ${modelIds.length} model(s))`)
console.log(describeChange(CORDIS + ' [providers + smart chains]', readFileSync(CORDIS, 'utf8'), finalCordis))
console.log(describeChange(clientPath, clientBefore, clientAfter))
console.log(describeChange(pricingPath, pricingBefore, pricingAfter))
console.log('\nfree-first auto chain:', chains.auto.map(h => `${h.provider}/${h.model}`).join(' -> '))
console.log('pi-ai profile:', JSON.stringify(providers, null, 2))
console.log('pricing additions:', JSON.stringify(additions, null, 2))

if (WRITE) {
  writeFileSync(CORDIS, finalCordis, 'utf8')
  writeFileSync(clientPath, clientAfter, 'utf8')
  writeFileSync(pricingPath, pricingAfter, 'utf8')
  console.log('\nWROTE 3 files / 4 artifacts.')
} else {
  console.log('\nDRY RUN only — nothing written.')
}
process.exit(0)
