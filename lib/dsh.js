/**
 * Resolve DSH runtime packages from a workspace bundle.
 *
 * A bundle installed from a workspace directory lands in the profile's
 * node_modules as a symlink. Node resolves bare specifiers from the *real*
 * path, so a plain `import ... from '@deepseek-ai/dsh-llm'` fails with
 * ERR_MODULE_NOT_FOUND even though the package is right there in the DSH
 * installation. The fix (same pattern used by dsh-bifrost-watch/schema.js)
 * is to create a `require` anchored at a manifest that really exists on disk.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Candidate package.json anchors, most specific first. */
function anchors() {
  const list = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) list.push(join(profileDir, 'package.json'))
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (home && profile) list.push(join(home, 'profiles', profile, 'package.json'))
  if (typeof process.resourcesPath === 'string') {
    list.push(join(process.resourcesPath, 'app.asar', 'package.json'))
  }
  // Last resort for this machine's install; harmless elsewhere because the
  // earlier anchors are tried first and createRequire never mutates disk.
  list.push('/opt/DSH NEXT/resources/app.asar/package.json')
  return [...new Set(list)]
}

/**
 * Load one DSH package by name.
 * @param {string} name bare package specifier, e.g. '@deepseek-ai/dsh-llm'
 * @returns {object} the CommonJS module namespace (ESM default is unwrapped)
 */
export function loadDshPackage(name) {
  const failures = []
  for (const anchor of anchors()) {
    let loaded
    try {
      loaded = createRequire(anchor)(name)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? 'load failed'}`)
      continue
    }
    // CJS builds expose the namespace directly; some relays wrap it in default.
    return loaded?.default && typeof loaded.default === 'object'
      ? { ...loaded.default, ...loaded }
      : loaded
  }
  throw new Error(
    `dsh-smart-provider could not load ${name}. Tried: ${failures.join('; ')}`,
  )
}

/** Lazily cached DSH packages. */
const cache = new Map()

/** @returns {object} dsh-llm runtime exports */
export function llmLib() {
  if (!cache.has('llm')) cache.set('llm', loadDshPackage('@deepseek-ai/dsh-llm'))
  return cache.get('llm')
}

/** @returns {object} dsh-session runtime exports */
export function sessionLib() {
  if (!cache.has('session')) cache.set('session', loadDshPackage('@deepseek-ai/dsh-session'))
  return cache.get('session')
}
