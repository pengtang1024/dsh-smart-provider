#!/usr/bin/env node
/**
 * One entry point for the package's verification gate.
 *
 * Two of the suites (account-pool, ranking) must load the REAL DSH packages
 * (SmartAdapter extends LlmAdapter from @deepseek-ai/dsh-llm), and those live
 * inside the Electron app.asar — only Electron's Node can read that archive.
 * The pure-logic suites (health, routing, ranking internals) run under any Node.
 *
 * So: prefer the Electron runtime from DSH_NODE_EXECUTABLE, fall back to the
 * current Node with a warning that the DSH-backed suites will fail. Prints the
 * exact command it ran, so a reader can reproduce a failure by hand.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # syntax check + full suite
 *   node scripts/run-tests.mjs --unit     # pure-logic suites only, any Node
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const UNIT_ONLY = process.argv.includes('--unit')

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

/** The pure-logic suites: no DSH packages, so they run under any Node. */
const UNIT_TESTS = ['test/health.test.mjs', 'test/ranking.test.mjs', 'test/pricing.test.mjs']
/** The suites that need the real DSH runtime from app.asar. */
const DSH_TESTS = ['test/account-pool.test.mjs', 'test/loading.test.mjs', 'test/latency.test.mjs', 'test/compaction.test.mjs']

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: PKG,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  return result.status ?? 1
}

let failed = false

if (!UNIT_ONLY) {
  console.log('== syntax check ==')
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
}

const electron = process.env.DSH_NODE_EXECUTABLE
const useElectron = !UNIT_ONLY && typeof electron === 'string' && electron && existsSync(electron)

if (UNIT_ONLY) {
  console.log('\n== unit suites (pure logic, any Node) ==')
  console.log(`node --test ${UNIT_TESTS.join(' ')}`)
  process.exit(run(process.execPath, ['--test', ...UNIT_TESTS]))
}

if (useElectron) {
  const tests = [...UNIT_TESTS, ...DSH_TESTS]
  console.log('\n== full suite (DSH runtime via ELECTRON_RUN_AS_NODE) ==')
  console.log(`ELECTRON_RUN_AS_NODE=1 ${electron} --test ${tests.join(' ')}`)
  process.exit(run(electron, ['--test', ...tests], { ELECTRON_RUN_AS_NODE: '1' }))
}

console.warn(
  '\n[warn] DSH_NODE_EXECUTABLE is not set (or points nowhere), so the DSH-backed\n'
  + '       suites cannot read app.asar and will fail. Running the pure-logic\n'
  + '       suites only. Export DSH_NODE_EXECUTABLE to run the full gate.\n',
)
console.log(`node --test ${UNIT_TESTS.join(' ')}`)
process.exit(run(process.execPath, ['--test', ...UNIT_TESTS]))
