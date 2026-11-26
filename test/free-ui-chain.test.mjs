/**
 * FX3 end-to-end contract gate (task-32): the Host freeSignal must survive the
 * whole path into the settings UI. client.js is a browser module wrapped in a
 * module loader and cannot be imported under plain Node, so these are honest
 * source-level assertions (same trade as the codec/mirror gates in
 * test/free-policy.test.mjs). They fail on a partial fix: a dropped tag in the
 * merge, a call site that forgets account declarations, a health panel without
 * a pricing column, or a multiplier field hidden in collapse blocks.
 * No @deepseek-ai/* import, no new framework.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const client = readFileSync(join(PKG, 'client.js'), 'utf8')

/** Slice source from a literal anchor to the first line at indent 0 that closes a brace. */
function region(anchor) {
  const at = client.indexOf(anchor)
  assert.notEqual(at, -1, 'missing source anchor: ' + anchor)
  const start = client.lastIndexOf('\n', at) + 1
  const lines = client.slice(start).split('\n')
  let depth = 0
  let seen = false
  for (let i = 0; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; seen = true }
      else if (ch === '}') depth -= 1
    }
    if (seen && depth <= 0) return lines.slice(0, i + 1).join('\n')
  }
  assert.fail('unbalanced region: ' + anchor)
}

const addSample = region('const addSample = (id, samples, tier, hostRow)')
const overview = region('function Overview(')
const accounts = region('function AccountsTab(')
const panel = region('function AccountHealthPanel(')
const costTab = region('function CostHealthTab(')
const root = region('function SmartSettingsSection(')
const declaredOf = region('const accountDeclaredOf = config =>')

test('FX3-1: availability projection merge forwards the Host freeSignal tag', () => {
  // The old addSample wrote only {samples,tier}, silently erasing Host evidence.
  assert.match(addSample, /freeSignal:\s*freeTagOf\(hostRow\)\s*\?\?\s*freeTagOf\(prev\)/,
    'merged rows must keep the Host tag (ledger rows have none)')
  assert.match(root, /addSample\(id,\s*verified \? AVAIL_HIGH_SAMPLES : 0,\s*row\?\.tier,\s*row\)/,
    'the live registry row must be passed into the merge as hostRow')
})

test('FX3-2: all three freeSignal call sites pass account multiplier and cost model', () => {
  // Overview candidate picker, accounts "only free" filter, auto-probe selection.
  const callSites = [
    { src: overview, anchor: 'const isPossiblyFree' },
    { src: accounts, anchor: 'const modelFreeSignal' },
    { src: root, anchor: 'const sig = tagged', taggedBefore: false },
  ]
  for (const { src, anchor, taggedBefore } of callSites) {
    const at = src.indexOf(anchor)
    assert.notEqual(at, -1, 'missing call site: ' + anchor)
    // The auto-probe site declares `tagged` after `sig`; include the lines before.
    const body = taggedBefore === false ? src.slice(at - 200, at + 1200) : src.slice(at, at + 1200)
    assert.match(body, /freeSignal\(\{/, anchor + ' must call freeSignal')
    assert.match(body, /priceMultiplier:\s*obj\(declared\[id\]\)\.priceMultiplier/,
      anchor + ' must pass the account-declared multiplier')
    assert.match(body, /costModel:\s*str\(obj\(declared\[id\]\)\.costModel\)/,
      anchor + ' must pass the account-declared cost model')
    assert.match(body, /priceTier:\s*str\(obj\(availProjection\)\[id\]\?\.tier\)/,
      anchor + ' must keep the projection tier')
    assert.match(body, /const tagged = freeTagOf\(/,
      anchor + ' must prefer the Host tag')
  }
  // Account declarations read both the canonical nested ranking field and the
  // legacy flat alias, otherwise a saved multiplier never reaches the calls.
  assert.match(declaredOf, /ranking\?\.priceMultiplier\s*\?\?\s*a\?\.priceMultiplier/)
  assert.match(declaredOf, /obj\(a\)\.costModel\s*\?\?\s*a\?\.costModel/)
})

test('FX3-3: health panel consumes availProjection and renders a pricing column', () => {
  const signature = client.slice(client.indexOf('function AccountHealthPanel('), client.indexOf('function AccountHealthPanel(') + 120)
  assert.match(signature, /availProjection/, 'AccountHealthPanel must receive availProjection')
  assert.match(panel, /strongestFreeTag\(availProjection,/,
    'rows must derive freeSignal from the projection')
  const billingHeaders = panel.match(/t\('health\.billing'\)/g) ?? []
  assert.ok(billingHeaders.length >= 2,
    'both account and route tables must have a translated pricing column header')
  assert.match(panel, /freeTagText\(t,\s*freeForAccount\(row\)\)/)
  assert.match(panel, /freeTagText\(t,\s*freeForRoute\(row\)\)/)
  assert.match(costTab, /availProjection,/, 'CostHealthTab must forward the projection')
})

test('FX3-4: multiplier input sits at account-card top level, one input point', () => {
  const field = accounts.indexOf("h(Field, { label: t('account.priceMultiplier')")
  assert.notEqual(field, -1, 'the account card must render a price multiplier input')
  // No earlier <details> may remain open at the field position.
  const before = accounts.slice(0, field)
  // The field must precede the first collapse block of the account card.
  const detailsAt = accounts.indexOf("h('details'")
  assert.ok(detailsAt === -1 || field < detailsAt,
    'multiplier field must NOT be nested in a collapse block')
  const input = accounts.slice(field, field + 900)
  assert.match(input, /type: 'number', min: 0, step: 'any'/)
  assert.match(input, /aria-label': t\('account\.priceMultiplier'\)/)
  assert.equal(accounts.split("label: t('account.priceMultiplier')").length - 1, 1,
    'there must be exactly one multiplier input point')
})

// BX2: the pill config existed in the schema but no settings control ever
// wrote it, and the old default 'input.right' did not match any real Host
// slot. These gates pin the first-screen controls and slot-name contract.
test('BX2-1: overview first screen exposes all three cost-pill controls with mutate writes', () => {
  // The card is a separate component: inspect its full region from client.
  const at = client.indexOf('function CostPillSettingsCard(')
  assert.notEqual(at, -1, 'a dedicated cost-pill settings card must exist')
  const lines = client.slice(at).split('\n')
  let depth = 0, seen = false, end = 0
  for (let i = 0; i < lines.length; i += 1) {
    for (const ch of lines[i]) { if (ch === '{') { depth += 1; seen = true } else if (ch === '}') depth -= 1 }
    if (seen && depth <= 0) { end = i + 1; break }
  }
  const card = lines.slice(0, end).join('\n')
  for (const key of ['COST_PILL_ENABLED_KEY', 'COST_PILL_POSITION_KEY', 'COST_PILL_REFRESH_KEY']) {
    assert.match(card, new RegExp('save\\(\\[' + key + '\\]'), 'the card must write ' + key)
  }
  assert.match(card, /type: 'checkbox'/, 'an on/off checkbox must be visible')
  assert.match(card, /select\(COST_PILL_SLOTS/, 'a position dropdown must be visible')
  assert.match(card, /type: 'number', min: 1000/, 'a refresh interval input must be visible')
  // Placement: the card is rendered on the overview tab, not inside Advanced.
  assert.match(root, /tab === 'overview' \? h\(CostPillSettingsCard, \{ t, config, revision, mutate \}\) : null/,
    'the card must mount on the overview first screen')
})

test('BX2-2: pill position default and enum match the real conversation slot names', () => {
  assert.match(client, /const COST_PILL_DEFAULT_POSITION = 'conversation\.input\.right'/,
    'client default must be a real slot name')
  const slots = client.match(/const COST_PILL_SLOTS = \[([^\]]+)\]/)?.[1] ?? ''
  assert.deepEqual(slots.match(/'conversation\.[^']+'/g) ?? [], [
    "'conversation.input.right'",
    "'conversation.session.header.utilities'",
    "'conversation.input.dock'",
  ], 'the three positions must be the Host slot names')
  const schema = readFileSync(join(PKG, 'schema.js'), 'utf8')
  assert.match(schema, /costPillPosition: z\.string\(\)\.default\('conversation\.input\.right'\)/, 
    'schema default must match the client slot')
  for (const f of ['zh', 'en']) {
    const dict = JSON.parse(readFileSync(join(PKG, 'locale', f + '.json'), 'utf8'))
    for (const slot of ['conversation.input.right', 'conversation.session.header.utilities', 'conversation.input.dock']) {
      assert.ok(dict.costPill.pos?.[slot], f + ' locale must label slot ' + slot)
    }
    assert.ok(dict.costPill.cardTitle && dict.costPill.cardHelp, f + ' locale must explain the first-screen card')
  }
})

test('FX3-5: version is consistently 2.4.0 in package, client and changelog', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '2.4.0')
  assert.match(client, /const PLUGIN_VERSION = '2\.4\.0'/)
  const changelog = readFileSync(join(PKG, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^## 2\.4\.0$/m)
  assert.ok(changelog.indexOf('## 2.4.0') < changelog.indexOf('## 2.3.1'))
})
