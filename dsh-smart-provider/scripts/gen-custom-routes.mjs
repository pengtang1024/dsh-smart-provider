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
 *   3. lib/pricing.json  -> zero-priced entries for free models
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
  flattenModels, yaml, describeChange, REGISTRY_FILE, PKG_DIR,
} from '../registry/registry-lib.mjs'

const WRITE = process.argv.includes('--write')
const CORDIS = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

// Distinct marker texts — no one is a substring of another.
const PM_B = '      # >>> custom-routes:providers >>>'
const PM_E = '      # <<< custom-routes:providers <<<'
const CM_B = '    # >>> custom-routes:chains >>>'
const CM_E = '    # <<< custom-routes:chains <<<'
const JS_B = '// >>> custom-routes:candidates >>>'
const JS_E = '// <<< custom-routes:candidates <<<'

/** Replace an exact marker block, or insert `body` right after `anchor`.
 *  `begin` must be unique in the document; we guard against duplicates. */
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
  if (i === -1) throw new Error(`anchor not found: ${JSON.stringify(anchorAfter)}`)
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
const providersAnchor = '    providers:\n'
cordis = upsertBlock(cordis, PM_B, PM_E, providersBlock, providersAnchor)

// ---- 2. smart config.chains block (4-space indent, volatile) -------------
const chainsSrc = readFileSync(join(PKG_DIR, 'lib', 'chains.js'), 'utf8')
const existingAuto = readExistingAuto(chainsSrc)
const chains = buildChains(doc, existingAuto)
const chainsYaml = yaml.stringify({ chains }, { indent: 2 }).trimEnd()
  .split('\n').map(l => '    ' + l).join('\n')
const chainsBlock = `${CM_B}\n${chainsYaml}\n${CM_E}`
const smartPrefix = "- id: smart-provider\n  name: '@local/dsh-smart-provider'\n  config:"
const smartAnchor = smartPrefix + ' {}\n'
let finalCordis
if (cordis.includes(CM_B) && cordis.includes(CM_E)) {
  const a = cordis.indexOf(CM_B)
  const b = cordis.indexOf(CM_E, a) + CM_E.length
  finalCordis = cordis.slice(0, a) + chainsBlock + cordis.slice(b)
} else if (cordis.includes(smartAnchor)) {
  // Replace `config: {}` with `config:\n<chains block>` in one shot.
  finalCordis = cordis.replace(smartAnchor, smartPrefix + '\n' + chainsBlock + '\n')
} else if (cordis.includes(smartPrefix)) {
  // Legacy/foreign shape: `config:` already has a bare `chains:` subtree
  // (e.g. written by an older generator, or by hand). Replace exactly the
  // smart-provider config subtree up to the next top-level `- id:` row,
  // wrapping it in our markers so subsequent runs are idempotent. Never
  // touch any other entry.
  const a = cordis.indexOf(smartPrefix)
  const nextRow = cordis.indexOf('\n- id:', a + smartPrefix.length)
  const end = nextRow === -1 ? cordis.length : nextRow + 1
  finalCordis = cordis.slice(0, a) + smartPrefix + '\n' + chainsBlock + '\n' + cordis.slice(end)
} else {
  throw new Error('cordis.patch.yml: smart-provider config anchor not found')
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

// ---- 4. pricing.json ------------------------------------------------------
const pricingPath = join(PKG_DIR, 'lib', 'pricing.json')
const pricingBefore = readFileSync(pricingPath, 'utf8')
const pricing = JSON.parse(pricingBefore)
const additions = buildPricing(doc).filter(e =>
  !(pricing.entries ?? []).some(x => `${x.provider}/${x.model}` === `${e.provider}/${e.model}`))
pricing.entries = [...(pricing.entries ?? []), ...additions]
pricing._rows = pricing.entries.length
const pricingAfter = JSON.stringify(pricing, null, 2) + '\n'

// ---- no-deletion guard: top-level entry ids must be byte-for-byte stable --
// Hard-fail if the STARTING patch already lost an entry that must exist: a
// prior agent wrote cordis outside this generator and dropped
// agent-default-model (2026-11-24 P0). A set-diff guard alone would silently
// bake the missing entry into every future gen, so require the invariant too.
const REQUIRED_IDS = ['agent-default-model', 'smart-provider', 'llm-pi-ai']
const missingRequired = REQUIRED_IDS.filter(id => !idsBefore.includes(id))
if (missingRequired.length) {
  console.error('GUARD FAIL: cordis.patch.yml is missing required top-level entries: ' + missingRequired.join(', '))
  console.error('  Restore them BEFORE gen --write; refusing to bake a broken patch.')
  process.exit(3)
}
const idsAfter = topLevelIds(finalCordis)
const removed = idsBefore.filter(id => !idsAfter.includes(id))
const added = idsAfter.filter(id => !idsBefore.includes(id))
const duplicated = idsAfter.filter((id, i) => idsAfter.indexOf(id) !== i)
if (removed.length || added.length || duplicated.length) {
  console.error('GUARD FAIL: top-level entry id set changed — refusing to write cordis.patch.yml')
  if (removed.length) console.error('  removed: ' + removed.join(', '))
  if (added.length) console.error('  unexpected added: ' + added.join(', '))
  if (duplicated.length) console.error('  duplicated: ' + duplicated.join(', '))
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
