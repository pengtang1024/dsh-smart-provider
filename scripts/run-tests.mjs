#!/usr/bin/env node
/**
 * One entry point for the package's verification gate.
 *
 * Discovery, not registration (task-8 rev 4). Three tasks in a row hit the same
 * trap: a new suite sat on disk while nobody added it to a hardcoded array, so
 * the gate stayed green while the new tests never ran — a fake green. The full
 * gate now runs every test/*.test.mjs it finds, and the discovery guard below
 * turns "exists but never runs" into a hard failure that names the file.
 *
 * Several suites must load the REAL DSH packages (SmartAdapter extends
 * LlmAdapter from @deepseek-ai/dsh-llm), and those live inside the Electron
 * app.asar — only Electron's Node can read that archive. --unit therefore runs
 * an explicit pure-logic subset and prints the suites it is leaving out.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # syntax check + every discovered suite
 *   node scripts/run-tests.mjs --unit     # pure-logic subset only, any Node
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(PKG, 'test')
const TEST_SUFFIX = '.test.mjs'
const UNIT_ONLY = process.argv.includes('--unit')

/**
 * The --unit whitelist: every suite that runs under plain Node, i.e. imports
 * nothing from @deepseek-ai/* and never reads the Electron app.asar. Keeping
 * this list exhaustive (not just the three original suites) is the point —
 * a pure-logic suite left out of --unit is a real gate gap, verified per file
 * with `env -u DSH_NODE_EXECUTABLE node --test <file>`. Suites that do need
 * the DSH runtime are absent here, still run by the full gate, and --unit
 * prints them as not covered.
 */
const UNIT_TESTS = [
  'test/health.test.mjs',
  'test/ranking.test.mjs',
  'test/pricing.test.mjs',
  'test/query-cost.test.mjs',
  'test/routing-tier.test.mjs',
  'test/persistence.test.mjs',
  'test/hydration-billing.test.mjs',
  'test/health-snapshot.test.mjs',
  'test/remote-surface.test.mjs',
  'test/probe.test.mjs',
  'test/health-taxonomy.test.mjs',
  'test/cooldown-consistency.test.mjs',
  'test/note-failure-override.test.mjs',
  'test/config.test.mjs',
  'test/free-policy.test.mjs',
]

/** Every source file worth a syntax check (client.js is browser code too). */
function sourceFiles() {
  const out = ['index.js', 'schema.js', 'client.js']
  for (const dir of ['lib', 'scripts', 'registry', 'test']) {
    const abs = join(PKG, dir)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs)) {
      if (['.js', '.mjs'].includes(extname(entry))) out.push(join(dir, entry))
    }
  }
  return out
}

/**
 * Every suite the full gate runs: all test/*.test.mjs, sorted so the order is
 * stable across machines and diffable between runs.
 */
function discoverSuites() {
  if (!existsSync(TEST_DIR)) return []
  return readdirSync(TEST_DIR)
    .filter(name => name.endsWith(TEST_SUFFIX))
    .sort()
    .map(name => `test/${name}`)
}

/**
 * Files in test/ the full gate would never execute: a typo'd name, the wrong
 * extension, a helper parked among the suites. With registration gone this is
 * the only way left to ship tests that never run, so it must be fatal.
 */
function undiscoveredFiles() {
  if (!existsSync(TEST_DIR)) return []
  const suites = new Set(discoverSuites().map(rel => rel.slice('test/'.length)))
  return readdirSync(TEST_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && !suites.has(entry.name))
    .map(entry => entry.name)
    .sort()
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: PKG,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  return result.status ?? 1
}

const suites = discoverSuites()
const ignored = undiscoveredFiles()
const unitSuites = UNIT_TESTS.filter(rel => existsSync(join(PKG, rel)))
const skipped = suites.filter(rel => !unitSuites.includes(rel))

// ---- discovery guard (runs in both modes) --------------------------------
console.log('== discovery guard ==')
console.log(`test dir: ${TEST_DIR} (pattern *${TEST_SUFFIX})`)
for (const rel of suites) console.log(`found ${rel}`)
if (suites.length === 0) {
  console.error(`\nFAIL: no *${TEST_SUFFIX} file under ${TEST_DIR} — the gate would pass without running anything.`)
  process.exit(1)
}
if (ignored.length > 0) {
  console.error(`\nFAIL: ${ignored.length} file(s) under test/ are never executed by the full gate:`)
  for (const name of ignored) console.error(`  test/${name}`)
  console.error(`Rename it to <name>${TEST_SUFFIX} (or move it out of test/) so it actually runs.`)
  process.exit(1)
}
for (const rel of UNIT_TESTS) {
  if (!unitSuites.includes(rel)) console.warn(`[warn] UNIT_TESTS lists ${rel}, which does not exist — the unit subset silently shrank`)
}

if (UNIT_ONLY) {
  if (unitSuites.length === 0) {
    console.error('\nFAIL: the UNIT_TESTS subset is empty, --unit would verify nothing.')
    process.exit(1)
  }
  console.log('\n== unit suites (pure logic, any Node) ==')
  console.log(`node --test ${unitSuites.join(' ')}`)
  if (skipped.length > 0) {
    console.log(`\n[note] ${skipped.length} discovered suite(s) are NOT in the --unit subset`)
    console.log('       (these need the DSH runtime from app.asar; only the full gate runs them):')
    for (const rel of skipped) console.log(`  ${rel}`)
  }
  process.exit(run(process.execPath, ['--test', ...unitSuites]))
}

let failed = false
console.log('\n== syntax check ==')
for (const file of sourceFiles()) {
  const status = run(process.execPath, ['--check', file])
  if (status !== 0) {
    console.error(`FAIL: ${file}`)
    failed = true
  } else {
    console.log(`ok   ${file}`)
  }
}
if (failed) process.exit(1)

const electron = process.env.DSH_NODE_EXECUTABLE
const useElectron = typeof electron === 'string' && electron && existsSync(electron)

if (useElectron) {
  console.log(`\n== full suite (${suites.length} discovered, DSH runtime via ELECTRON_RUN_AS_NODE) ==`)
  console.log(`ELECTRON_RUN_AS_NODE=1 ${electron} --test ${suites.join(' ')}`)
  process.exit(run(electron, ['--test', ...suites], { ELECTRON_RUN_AS_NODE: '1' }))
}

console.warn(
  '\n[warn] DSH_NODE_EXECUTABLE is not set (or points nowhere), so suites that load\n'
  + '       @deepseek-ai/* from app.asar cannot run. Falling back to the --unit subset;\n'
  + '       these discovered suites are SKIPPED:',
)
for (const rel of skipped) console.warn(`       skipped: ${rel}`)
console.warn('       Export DSH_NODE_EXECUTABLE to run the full gate.\n')
console.log(`node --test ${unitSuites.join(' ')}`)
process.exit(run(process.execPath, ['--test', ...unitSuites]))
