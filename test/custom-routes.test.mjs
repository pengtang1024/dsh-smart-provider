#!/usr/bin/env node
/**
 * P0 regression: a declared custom route must always end up with a live
 * adapter registration, including app-managed cordis.patch.yml profiles
 * that have no llm-pi-ai 'providers:' anchor. Covers gen/validate
 * behaviour, idempotency, and the DUPLICATE_ADAPTER guard.
 *
 * Pure Node: spawns the real scripts under an isolated HOME so the live
 * user profile is never touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REAL_HOME = homedir()
const REAL_NODE_MODULES = join(REAL_HOME, '.dsh', 'profiles', 'desktop', 'node_modules')

function isolatedProfile(patchYaml) {
  const root = mkdtempSync(join(tmpdir(), 'custom-routes-test-'))
  const profile = join(root, '.dsh', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), patchYaml)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-test-profile' }))
  if (existsSync(REAL_NODE_MODULES)) symlinkSync(REAL_NODE_MODULES, join(profile, 'node_modules'))
  return { root, patch: join(profile, 'cordis.patch.yml') }
}

function run(script, home, args = []) {
  return spawnSync(process.execPath, [join(PKG, 'scripts', script), ...args], {
    cwd: PKG,
    env: { ...process.env, HOME: home, DSH_PROFILE: 'desktop' },
    encoding: 'utf8',
  })
}

const APP_MANAGED_PATCH = [
  '# app-managed shape: no llm-pi-ai providers anchor',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: workbuddy',
  '    model: hy4flash',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config:',
  '    # >>> custom-routes:chains >>>',
  '    chains:',
  '      auto:',
  '        - provider: x-opencode-free',
  '          model: hy4-flash-free',
  '    # <<< custom-routes:chains <<<',
  '',
].join('\n')

const ANCHOR_PATCH = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config: {}',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        displayName: OpenCode Go',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://opencode.ai/inference/go/v1',
  '        models: []',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config: {}',
  '',
].join('\n')

test('validate FAILS when a declared route has no adapter registration (anti fake-green)', () => {
  const { root } = isolatedProfile(APP_MANAGED_PATCH)
  const r = run('validate-custom-routes.mjs', root)
  assert.equal(r.status, 1, `validate should FAIL, stdout=${r.stdout}, stderr=${r.stderr}`)
  assert.match(r.stderr, /NO adapter registration in cordis\.patch\.yml/)
  assert.match(r.stderr, /gen-custom-routes\.mjs --write/)
})

test('gen registers the custom route in an app-managed profile and validate then PASSES', () => {
  const { root, patch } = isolatedProfile(APP_MANAGED_PATCH)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g.status, 0, `gen failed: ${g.stdout} ${g.stderr}`)
  const text = readFileSync(patch, 'utf8')
  assert.match(text, /# >>> custom-routes:providers-insert >>>/)
  assert.match(text, /- id: llm-pi-ai\n  name: '@deepseek-ai\/dsh-llm-pi-ai'/)
  assert.ok(!text.includes('llm-pi-ai-custom-routes'), 'must NOT create a second llm-pi-ai instance')
  assert.ok(!text.includes('- insert:'), 'must NOT use a plugin insert for this fallback')
  assert.match(text, /x-opencode-free:/)
  assert.match(g.stderr, /registered x-\* routes in the single llm-pi-ai entry config/)
  const v = run('validate-custom-routes.mjs', root)
  assert.equal(v.status, 0, `validate failed: ${v.stdout} ${v.stderr}`)
  assert.match(v.stdout, /route "x-opencode-free" has an adapter registration \((?:llm-pi-ai\.providers|single llm-pi-ai entry config)\)/)
})

test('validate FAILS on a stale second llm-pi-ai instance (collision guard)', () => {
  const { root, patch } = isolatedProfile(APP_MANAGED_PATCH)
  // A previous generator revision produced this; it must be rejected, not
  // trusted as a registration, because it re-registers catalog providers.
  const stale = readFileSync(patch, 'utf8') + [
    '# >>> custom-routes:providers-insert >>>',
    '- insert:',
    '    - id: llm-pi-ai-custom-routes',
    "      name: '@deepseek-ai/dsh-llm-pi-ai'",
    '      config:',
    '        providers:',
    '          x-opencode-free:',
    '# <<< custom-routes:providers-insert <<<',
    '',
  ].join('\n')
  writeFileSync(patch, stale)
  const v = run('validate-custom-routes.mjs', root)
  assert.equal(v.status, 1, 'validate must reject the old second-instance patch')
  assert.match(v.stderr, /second llm-pi-ai instance|llm-pi-ai-custom-routes/)
})

test('gen is idempotent: two consecutive --write runs are byte-identical', () => {
  const { root, patch } = isolatedProfile(APP_MANAGED_PATCH)
  const g1 = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g1.status, 0)
  const first = readFileSync(patch)
  const g2 = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g2.status, 0, `second gen failed: ${g2.stdout} ${g2.stderr}`)
  const second = readFileSync(patch)
  assert.ok(first.equals(second), 'patch changed on second gen run')
})

test('anchor-present profile keeps original in-place providers block (no fallback insert)', () => {
  const { root, patch } = isolatedProfile(ANCHOR_PATCH)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g.status, 0, `gen failed: ${g.stdout} ${g.stderr}`)
  const text = readFileSync(patch, 'utf8')
  assert.match(text, /# >>> custom-routes:providers >>>/)
  assert.match(text, /x-opencode-free:/)
  assert.ok(!text.includes('custom-routes:providers-insert'), 'fallback insert must not be used when anchor exists')
  const v = run('validate-custom-routes.mjs', root)
  assert.equal(v.status, 0, `validate failed: ${v.stdout} ${v.stderr}`)
})

test('smart is never declared in the fallback insert (DUPLICATE_ADAPTER guard)', () => {
  const { root, patch } = isolatedProfile(APP_MANAGED_PATCH)
  // Inject a registry that declares smart as a route; gen must hard-fail.
  const badRegistry = join(root, 'bad-registry.yaml')
  writeFileSync(badRegistry, [
    'version: 1',
    'routes:',
    '  - id: smart',
    '    displayName: Smart',
    '    protocol: openai-completions',
    '    baseURL: https://example.com/v1',
    '    credentialRef: OPENCODE_GO_API_KEY',
    '    tier: free',
    '    models: []',
    '',
  ].join('\n'))
  const env = { ...process.env, HOME: root, DSH_PROFILE: 'desktop', DSH_SMART_ROUTES_FILE: badRegistry }
  const r = spawnSync(process.execPath, [join(PKG, 'scripts', 'gen-custom-routes.mjs'), '--write'], {
    cwd: PKG, env, encoding: 'utf8',
  })
  assert.ok(r.status !== 0, 'gen must refuse to declare smart (DUPLICATE_ADAPTER)')
  assert.match(r.stderr, /DUPLICATE_ADAPTER|reserved provider/)
  assert.ok(!readFileSync(patch, 'utf8').includes('custom-routes:providers-insert'))
})

// ---------------------------------------------------------------------------
// P0 2026-11-26: the generator used to insert a x-* provider route even when
// the live patch ALREADY declared it by hand without markers. The inserted
// block duplicated the YAML key, so yaml.parse rejected the whole file with
// "Map keys must be unique ... DUPLICATE_KEY" and the run died with a stack
// trace. The fixtures below pin the fix: skip with an actionable note, replace
// when the block is marker-owned, and refuse loudly (without writing) when the
// live patch is already broken.
// ---------------------------------------------------------------------------

const HAND_WRITTEN_PROVIDER_PATCH = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config: {}',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      x-opencode-free:',
  '        displayName: Hand Written Free',
  '        api: openai-completions',
  '        baseURL: https://opencode.ai/inference/go/v1',
  '        models: []',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config: {}',
  '',
].join('\n')

const MARKED_PROVIDER_PATCH = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config: {}',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      # >>> custom-routes:providers >>>',
  '      x-opencode-free:',
  '        displayName: Stale Display Name',
  '        api: openai-completions',
  '        baseURL: https://stale.example.com/v1',
  '        models: []',
  '      # <<< custom-routes:providers <<<',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config: {}',
  '',
].join('\n')

const DUPLICATE_KEY_PATCH = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config: {}',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      x-opencode-free:',
  '        displayName: First',
  '      x-opencode-free:',
  '        displayName: Second',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config: {}',
  '',
].join('\n')

const CHAINS_WITH_RANKING_PATCH = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config: {}',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        displayName: OpenCode Go',
  '        api: openai-completions',
  '        baseURL: https://opencode.ai/inference/go/v1',
  '        models: []',
  '- id: smart-provider',
  '  name: "@local/dsh-smart-provider"',
  '  config:',
  '    chains:',
  '      auto:',
  '        - provider: opencode-go',
  '          model: mimo-v2.6-flash',
  '    ranking:',
  '      enabled: true',
  '      strategy: cost-first',
  '      weights:',
  '        cost: 0.7',
  '',
].join('\n')

function countProviderKeys(text, id) {
  return text.split('\n').filter(l => l === '      ' + id + ':').length
}

test('gen SKIPS a provider already declared outside the markers (no DUPLICATE_KEY, exit 0)', () => {
  const { root, patch } = isolatedProfile(HAND_WRITTEN_PROVIDER_PATCH)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g.status, 0, 'gen must not crash: ' + g.stdout + g.stderr)
  assert.match(g.stderr, /already declared in cordis[.]patch[.]yml OUTSIDE the generator markers/)
  assert.match(g.stderr, /x-opencode-free at cordis[.]patch[.]yml:[0-9]+/)
  assert.match(g.stderr, /merge by hand/)
  const text = readFileSync(patch, 'utf8')
  assert.equal(countProviderKeys(text, 'x-opencode-free'), 1, 'provider key must NOT be duplicated')
  assert.ok(!text.includes('custom-routes:providers >>>'), 'no providers block inserted over hand-written data')
  assert.match(text, /displayName: Hand Written Free/, 'hand-written provider block must be untouched')
  // Other artifacts are still generated, and a second run is a byte no-op.
  assert.match(text, /# >>> custom-routes:chains >>>/)
  const first = readFileSync(patch)
  const g2 = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g2.status, 0, 'second gen failed: ' + g2.stdout + g2.stderr)
  assert.ok(first.equals(readFileSync(patch)), 'second run must not change the patch')
})

test('gen REPLACES a provider block that already carries generator markers (single key, idempotent)', () => {
  const { root, patch } = isolatedProfile(MARKED_PROVIDER_PATCH)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g.status, 0, 'gen failed: ' + g.stdout + g.stderr)
  const text = readFileSync(patch, 'utf8')
  assert.equal(countProviderKeys(text, 'x-opencode-free'), 1, 'marker-owned block must be replaced, not appended')
  assert.match(text, /displayName: OpenCode Free/, 'marker-owned block must be refreshed from the registry')
  assert.ok(!text.includes('stale.example.com'), 'stale body must be gone')
  const first = readFileSync(patch)
  const g2 = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g2.status, 0)
  assert.ok(first.equals(readFileSync(patch)), 'second run must not change the patch')
})

test('gen REFUSES an already-duplicate live patch: non-zero exit, offending line, file untouched', () => {
  const { root, patch } = isolatedProfile(DUPLICATE_KEY_PATCH)
  const before = readFileSync(patch)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.notEqual(g.status, 0, 'a live patch with duplicate keys must fail the run')
  assert.match(g.stderr, /PARSE FAIL/)
  assert.match(g.stderr, /unique at line [0-9]+/)
  assert.match(g.stderr, /Nothing was written/)
  assert.ok(!g.stderr.includes('YAMLParseError'), 'must not dump a raw YAMLParseError stack')
  assert.ok(!g.stdout.includes('WROTE'), 'must not claim a write')
  assert.ok(before.equals(readFileSync(patch)), 'the original file must be left untouched')
})

test('hand-written chains keep sibling config keys (e.g. ranking) and gain markers', () => {
  const { root, patch } = isolatedProfile(CHAINS_WITH_RANKING_PATCH)
  const g = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g.status, 0, 'gen failed: ' + g.stdout + g.stderr)
  const text = readFileSync(patch, 'utf8')
  assert.match(text, /# >>> custom-routes:chains >>>/)
  assert.ok(text.includes('ranking:\n      enabled: true\n      strategy: cost-first'), 'sibling config must survive the rewrite')
  assert.ok(text.includes('weights:\n        cost: 0.7'), 'nested sibling config must survive too')
  const first = readFileSync(patch)
  const g2 = run('gen-custom-routes.mjs', root, ['--write'])
  assert.equal(g2.status, 0)
  assert.ok(first.equals(readFileSync(patch)), 'second run must not change the patch')
})

// ---------------------------------------------------------------------------
// task-40: the generator must not write zero-price rows for models explicitly
// marked unavailable. The generator is additive-only, so start from a table
// with no entries (mirroring a fresh product) and assert the exact result.
// The live product table (lib/pricing.json) is never touched by this test.
// ---------------------------------------------------------------------------

test('gen emits zero-price rows only for available declared-free models', () => {
  const { root } = isolatedProfile(APP_MANAGED_PATCH)
  // Copy the package (without .git) into the isolated HOME so the generator
  // writes its copy of client.js / pricing.json — never the real working tree.
  const pkg = join(root, 'pkg')
  mkdirSync(pkg, { recursive: true })
  spawnSync('rsync', ['-a', '--exclude=.git', PKG + '/', pkg + '/'], { encoding: 'utf8' })
  const pricingPath = join(pkg, 'lib', 'pricing.json')
  const clean = JSON.parse(readFileSync(pricingPath, 'utf8'))
  clean.entries = []
  clean._rows = 0
  writeFileSync(pricingPath, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  const g = spawnSync(process.execPath, [join(pkg, 'scripts', 'gen-custom-routes.mjs'), '--write'], {
    cwd: pkg,
    env: { ...process.env, HOME: root, DSH_PROFILE: 'desktop', DSH_SMART_ROUTES_FILE: '' },
    encoding: 'utf8',
  })
  assert.equal(g.status, 0, 'gen failed: ' + g.stdout + g.stderr)
  const table = JSON.parse(readFileSync(pricingPath, 'utf8'))
  const ids = table.entries.map(e => `${e.provider}/${e.model}`)
  assert.deepEqual(ids, [
    'x-opencode-free/hy4-flash-free',
    'x-opencode-free/hy4flash-free',
  ], 'unavailable registry models must not ship as zero-price declarations')
  assert.equal(table._rows, table.entries.length)
  for (const row of table.entries) {
    assert.equal(row.input, 0)
    assert.equal(row.output, 0)
  }
})

