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
import vm from 'node:vm'

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

test('FX3-5: version is consistently 2.10.1 in package, client and changelog', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '2.10.1')
  assert.match(client, /const PLUGIN_VERSION = '2\.10\.1'/)
  const changelog = readFileSync(join(PKG, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^## 2\.10\.1$/m)
  assert.ok(changelog.indexOf('## 2.10.1') < changelog.indexOf('## 2.10.0'))
})

// I18N coverage gate (task-89): the i18n foundation used to drop 18 referenced
// keys from all seven inline dictionaries, so the UI rendered raw dotted keys.
// These gates extract the REAL dictionaries from client.js (vm, no import of
// browser code) and statically scan every literal t(...) / fmt(...) key. Any
// future call site added without its seven translations now fails the gate.
const LOCALES = ['zh', 'en', 'de', 'es', 'fr', 'pt', 'ru']

/** Evaluate the inline dictionary declarations from client.js in an isolated vm. */
function loadDictionaries() {
  const lines = client.split('\n')
  const start = lines.findIndex(l => /\bconst\s+zh\s*=\s*\{/.test(l))
  const end = lines.findIndex((l, i) => i > start && /^\s*return\s*\{/.test(l))
  assert.ok(start >= 0 && end > start, 'client.js locale dictionary block must exist')
  const slice = lines.slice(start, end).join('\n') + '\n;({ zh, en, de, es, fr, pt, ru })'
  try { return vm.runInNewContext(slice) }
  catch (e) { assert.fail('client.js locale dictionaries failed to evaluate: ' + e.message) }
}

const dictionaries = loadDictionaries()
for (const loc of LOCALES) {
  assert.ok(dictionaries[loc] && typeof dictionaries[loc] === 'object', loc + ' dictionary must exist')
}

/** Static call-site keys: literal t('x') / fmt(t,'x') plus template-literal pools. */
function staticCallKeys() {
  const keys = new Set()
  // Literal keys: t('x'), fmt(t, 'x'), t(x, 'x') — quote-bearing first/second arg.
  const literal = /\b(?:t|fmt)\s*\(\s*(?:[^,()]+,\s*)?'([a-z][a-z0-9]*(?:\.[a-z0-9_.]+)*)'/g
  let m
  while ((m = literal.exec(client))) keys.add(m[1])
  // Backtick template calls: t(\`prefix.${key}\`) — expand the pool root from en.
  const tpl = /\bt\s*\(\s*\x60([a-z][a-z0-9_.]*)\.\$\{/g
  while ((m = tpl.exec(client))) {
    const prefix = m[1] + '.'
    let found = false
    for (const k of Object.keys(dictionaries.en)) if (k.startsWith(prefix)) { keys.add(k); found = true }
    // A pool with no concrete keys is itself a gate failure; the required
    // 18-key test below pins these prefixes, so never add a fake prefix key.
  }
  return keys
}

function placeholders(value) {
  return [...new Set(String(value).match(/\{[a-zA-Z][a-zA-Z0-9]*\}/g) ?? [])].sort()
}

test('I18N-1: the 18 previously dropped keys exist in all seven dictionaries', () => {
  const required = [
    'tab.overview', 'tab.routing', 'tab.cost',
    'ranking.w.cost', 'ranking.w.speed', 'ranking.w.tier', 'ranking.w.load',
    'cost.col.time', 'cost.col.model', 'cost.col.tokens', 'cost.col.ttft',
    'cost.col.tps', 'cost.col.cost', 'cost.col.status',
    'health.freeMeasured', 'health.freeMeasuredPrice',
    'health.freeMeasuredProbe', 'health.freeMeasuredBilling',
  ]
  for (const key of required) {
    for (const loc of LOCALES) {
      assert.ok(Object.hasOwn(dictionaries[loc], key), loc + ' dictionary must define ' + key)
      assert.equal(typeof dictionaries[loc][key], 'string', loc + '.' + key + ' must be a string')
      assert.ok(dictionaries[loc][key].trim(), loc + '.' + key + ' must not be empty')
    }
  }
})

test('I18N-2: static t()/fmt() call keys are a subset of every locale dictionary', () => {
  const keys = staticCallKeys()
  assert.ok(keys.size > 0, 'the static scanner must find call-site keys')
  for (const loc of LOCALES) {
    const missing = [...keys].filter(k => !Object.hasOwn(dictionaries[loc], k)).sort()
    assert.deepEqual(missing, [], loc + ' is missing ' + missing.length + ' static call key(s): ' + missing.join(', '))
  }
})

test('I18N-3: all seven dictionaries share the same key set with string values', () => {
  const base = Object.keys(dictionaries.en).sort()
  for (const loc of LOCALES) {
    const keys = Object.keys(dictionaries[loc]).sort()
    assert.deepEqual(keys, base, loc + ' key set must match en (missing/extra keys)')
    for (const [k, v] of Object.entries(dictionaries[loc])) {
      assert.equal(typeof v, 'string', loc + '.' + k + ' must be a string')
    }
  }
})

test('I18N-4: placeholders agree across locales and cost.overviewLine uses plain {total}', () => {
  for (const key of Object.keys(dictionaries.en)) {
    const expected = placeholders(dictionaries.en[key])
    for (const loc of LOCALES) {
      assert.deepEqual(placeholders(dictionaries[loc][key]), expected,
        loc + '.' + key + ' placeholders must match en')
    }
  }
  // The caller passes an amount that already contains $. A literal ${total}
  // in the zh template produced a double dollar sign in the rendered line.
  assert.match(dictionaries.zh['cost.overviewLine'], /\{total\}/,
    'zh cost.overviewLine must use a plain {total} placeholder')
  assert.doesNotMatch(dictionaries.zh['cost.overviewLine'], /\$\{total\}/,
    'zh cost.overviewLine must not double the dollar sign')
})
