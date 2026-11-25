/**
 * Resolve DSH runtime packages from a workspace bundle.
 *
 * A bundle installed from a workspace directory lands in the profile's
 * node_modules as a symlink. Node resolves bare specifiers from the *real*
 * path, so a plain `import ... from '@deepseek-ai/dsh-llm'` fails with
 * ERR_MODULE_NOT_FOUND even though the package is right there in the DSH
 * installation. The fix (same pattern used by dsh-bifrost-watch/schema.js)
 * is to create a `require` anchored at a manifest that really exists on disk.
 *
 * Anchor order matters. The profile manifest is tried first because that is
 * where user bundles and their dependencies live; the Electron resources
 * manifest is second because that is where the DSH core packages (dsh-llm,
 * dsh-session, ...) are actually shipped inside app.asar.
 *
 * Platform coverage: the app can be installed anywhere, so instead of
 * hard-coding one vendor path we derive the install directory from
 * DSH_NODE_EXECUTABLE (set by DSH itself) and then fall back to the few
 * well-known per-platform install roots. A missing anchor is simply skipped,
 * so this stays harmless on machines that use another layout.
 */

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Candidate package.json paths for the Electron *resources* manifest, derived
 * from the running DSH executable. The executable lives at:
 *   macOS   <app>/Contents/MacOS/DSH NEXT   -> <app>/Contents/Resources
 *   Linux   <install>/dsh                   -> <install>/resources
 *   Windows <install>\DSH NEXT.exe          -> <install>/resources
 * @returns {string[]} absolute candidate paths, best guess first
 */
function resourcesFromExecutable() {
  const exe = process.env.DSH_NODE_EXECUTABLE
  if (!exe) return []
  // macOS bundle: walk out of Contents/MacOS to Contents/Resources.
  const macContents = dirname(dirname(exe)) // .../Contents
  const macResources = join(macContents, 'Resources', 'app.asar', 'package.json')
  const genericResources = join(dirname(exe), 'resources', 'app.asar', 'package.json')
  return [macResources, genericResources]
}

/** Well-known install roots per platform (last resort only). */
function knownInstallRoots() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/DSH NEXT.app/Contents/Resources/app.asar/package.json',
      join(process.env.HOME ?? '', 'Applications', 'DSH NEXT.app', 'Contents', 'Resources', 'app.asar', 'package.json'),
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    return [
      join(localAppData, 'Programs', 'DSH NEXT', 'resources', 'app.asar', 'package.json'),
      'C:\\Program Files\\DSH NEXT\\resources\\app.asar\\package.json',
    ]
  }
  return [
    '/opt/DSH NEXT/resources/app.asar/package.json',
    '/usr/lib/dsh-next/resources/app.asar/package.json',
  ]
}

/**
 * Candidate package.json anchors, most specific first.
 * Only paths that exist on disk are returned, so failure messages name
 * real candidates instead of a list of guesses.
 * @returns {string[]} existing package.json paths
 */
export function anchors() {
  const list = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) list.push(join(profileDir, 'package.json'))
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (home && profile) list.push(join(home, 'profiles', profile, 'package.json'))
  // Inside the Electron app, process.resourcesPath is authoritative.
  if (typeof process.resourcesPath === 'string') {
    list.push(join(process.resourcesPath, 'app.asar', 'package.json'))
  }
  list.push(...resourcesFromExecutable())
  list.push(...knownInstallRoots())
  const unique = [...new Set(list.filter(Boolean))]
  const existing = unique.filter(path => {
    try { return existsSync(path) } catch { return false }
  })
  // If nothing exists yet, still return the ranked candidates so the error
  // message can explain what was tried instead of printing an empty list.
  return existing.length ? existing : unique
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
