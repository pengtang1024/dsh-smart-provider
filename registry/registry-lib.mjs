/**
 * Shared library for the custom-route registry: parse YAML, validate, and
 * generate the four downstream artifacts. Used by both gen- and
 * validate-custom-routes.mjs. Read-only except for the explicit --write path.
 *
 * Four generated artifacts (all idempotent, marker-delimited where possible):
 *   1. llm-pi-ai.providers x-* route  -> ~/.dsh/profiles/desktop/cordis.patch.yml (YAML insert)
 *   2. smart chains                   -> lib/chains.js            (marker block)
 *   3. client MODELS/PROVIDERS        -> client.js                (marker block)
 *   4. pricing entries                -> lib/pricing.json         (JSON transform)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_DIR = dirname(HERE)
/**
 * P1 user resource adaptation: the shipped `custom-routes.yaml` is an EMPTY
 * template (no user's models). A user's own declaration lives in
 * `custom-routes.user.yaml` (or DSH_SMART_ROUTES_FILE) and, when present,
 * takes precedence. This keeps the current user's x-opencode-free free-first
 * route fully effective while new users see a neutral empty template.
 */
const USER_FILE = join(HERE, 'custom-routes.user.yaml')
export const REGISTRY_FILE = (process.env.DSH_SMART_ROUTES_FILE && existsSync(process.env.DSH_SMART_ROUTES_FILE))
  ? process.env.DSH_SMART_ROUTES_FILE
  : existsSync(USER_FILE) ? USER_FILE : join(HERE, 'custom-routes.yaml')

/**
 * Candidate profile anchors, highest priority first: an explicit DSH_HOME, then
 * the current user's HOME, then os.homedir() — which is still the CURRENT user.
 * Never a baked-in path into some other person's home: on any other machine that
 * path is either absent or EACCES, i.e. a silent failure disguised as a config.
 * Duplicates collapse, so a normal POSIX shell probes exactly one location.
 */
function profileAnchors() {
  const profile = process.env.DSH_PROFILE ?? 'desktop'
  const dshHomes = []
  if (process.env.DSH_HOME) dshHomes.push(process.env.DSH_HOME)
  if (process.env.HOME) dshHomes.push(join(process.env.HOME, '.dsh'))
  let fallbackHome = ''
  try { fallbackHome = homedir() } catch { /* no passwd entry: the env chain is all we have */ }
  if (fallbackHome) dshHomes.push(join(fallbackHome, '.dsh'))
  const unique = dshHomes.filter((h, i) => h && dshHomes.indexOf(h) === i)
  if (unique.length === 0) {
    throw new Error(
      'registry-lib: cannot locate the DSH profile — neither DSH_HOME nor HOME is set '
      + 'and the current user has no home directory. Set DSH_HOME to the DSH install root '
      + '(the directory that contains profiles/) or export HOME.',
    )
  }
  return unique.map(h => join(h, 'profiles', profile, 'package.json'))
}

/** Load `yaml` from the desktop profile (the only place it is installed). */
function loadYaml() {
  const anchors = profileAnchors()
  for (const anchor of anchors) {
    try {
      const y = createRequire(anchor)('yaml')
      if (typeof y?.parse === 'function' && typeof y?.stringify === 'function') return y
    } catch { /* try next anchor */ }
  }
  throw new Error(`registry-lib: cannot load "yaml"; tried ${anchors.join(', ')} — expected it under <home>/.dsh/profiles/desktop/node_modules`)
}

export const yaml = loadYaml()

/** Protocol -> baseURL shape guidance (方案 §4 对照表). */
export const PROTOCOLS = new Set([
  'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai',
])

/** Routes that must never be shadowed by an x-* route id. */
export const RESERVED_IDS = new Set(['smart', 'opencode-go', 'xiaomi-token-plan-cn'])

/** Read + parse the registry YAML. */
export function readRegistry(path = REGISTRY_FILE) {
  const doc = yaml.parse(readFileSync(path, 'utf8'))
  if (!doc || typeof doc !== 'object') throw new Error('registry: empty document')
  if (doc.version !== 1) throw new Error(`registry: unsupported version ${doc.version} (expected 1)`)
  if (!Array.isArray(doc.routes)) throw new Error('registry: routes must be an array')
  return doc
}

/** Flatten every declared model into {provider, model, route, tier}. */
export function flattenModels(doc) {
  const rows = []
  for (const route of doc.routes ?? []) {
    for (const m of route.models ?? []) {
      rows.push({
        provider: route.id,
        model: m.id,
        routeId: route.id,
        routeTier: route.tier,
        modelTier: m.tier ?? route.tier,
      })
    }
  }
  return rows
}

/** Build the pi-ai provider profile objects keyed by x-* route id. */
export function buildProviders(doc) {
  const out = {}
  for (const r of doc.routes ?? []) {
    out[r.id] = {
      displayName: r.displayName,
      apiKeyEnv: r.credentialRef,
      api: r.protocol,
      baseURL: r.baseURL,
      // A catalog-external openai-completions route must carry compat: without
      // it pi-ai defaults to max_completion_tokens + role:developer, which
      // OpenAI-compatible gateways (e.g. opencode.ai) reject with 400
      // INVALID_REQUEST -> smart silently falls back to a paid hop. Pass the
      // declared compat through verbatim when present (task-49).
      ...r.compat === undefined ? {} : { compat: { ...r.compat } },
      // OpenCode Go requires x-opencode-session on every request. pi-ai only
      // auto-injects it when the provider name is opencode/opencode-go, so a
      // custom x-* route must declare it statically. pi-ai's assertValidHeaders
      // accepts any Fetch-valid header; merge order keeps this value (task-51).
      ...r.headers === undefined ? {} : { headers: { ...r.headers } },
      // task-77: a model marked `existing_route` is already served by a
      // catalog-backed route (e.g. opencode-go). Re-declaring it on this
      // custom route would collide with that route's model id and trip the
      // anti-break-29 validate gate. Keep it in the declaration source for
      // visibility/status, but do not write it into this route's models.
      models: (r.models ?? []).filter(m => !m.existing_route).map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: Array.isArray(m.input) ? [...m.input] : [],
        // Availability markers are passthrough (schemastery keeps unknown
        // fields). They make every declared model visible/annotated in the
        // patched profile without changing routing: buildChains decides which
        // ones are actually wired into the auto chain (task-77).
        ...m.status === undefined ? {} : { status: m.status },
        ...m.status_reason === undefined ? {} : { status_reason: m.status_reason },
      })),
    }
  }
  return out
}

/** Build smart chains: every free model first (in declaration order), then the
 *  pre-existing default paid chain. Deduped by model id so the fallback model
 *  is never swallowed by account-pool's seenModels (方案 §5). */
export function buildChains(doc, existingAuto = []) {
  const free = []
  for (const r of doc.routes ?? []) {
    for (const m of r.models ?? []) {
      if ((m.tier ?? r.tier) !== 'free') continue
      // task-77: a model explicitly marked unavailable is REGISTERED (visible
      // in models/pricing/client candidates) but NOT wired into the auto
      // chain — "登记但不接线" degradation, never deletion. status absent or
      // 'unverified' stays eligible so a newly declared model is not silently
      // disabled.
      if (m.status === 'unavailable') continue
      free.push({ provider: r.id, model: m.id })
    }
  }
  const seen = new Set(free.map(h => h.model))
  const paid = (existingAuto ?? []).filter(h => !seen.has(h.model) && !String(h.provider).startsWith('x-'))
  const explicit = {}
  for (const r of doc.routes ?? []) {
    for (const m of r.models ?? []) {
      if (!Object.hasOwn(explicit, m.id)) explicit[m.id] = [{ provider: r.id, model: m.id }]
    }
  }
  return { auto: [...free, ...paid], ...explicit }
}

/** Build pricing entries: free models priced at 0 so the meter proves the
 *  route was actually free. A model explicitly marked `status: unavailable`
 *  is a registration only, NOT a real free declaration: a zero row would
 *  upgrade a name-only weak signal to `measured` ("已确认免费"). Mirror
 *  buildChains' 登记但不接线 rule — visibility without a price claim. */
export function buildPricing(doc) {
  return (doc.routes ?? []).flatMap(r => (r.models ?? [])
    .filter(m => m.status !== 'unavailable')
    .map(m => ({
      provider: r.id,
      model: m.id,
      input: (m.tier ?? r.tier) === 'free' ? 0 : (m.price?.input ?? 0),
      output: (m.tier ?? r.tier) === 'free' ? 0 : (m.price?.output ?? 0),
      cacheRead: 0,
      cacheWrite: 0,
    })))
}

// ---- marker helpers -------------------------------------------------------

export const MARKERS = {
  chains: {
    begin: '// BEGIN custom-routes registry (generated by scripts/gen-custom-routes.mjs)',
    end: '// END custom-routes registry',
  },
  client: {
    begin: '// BEGIN custom-routes registry (generated)',
    end: '// END custom-routes registry',
  },
  cordis: {
    begin: '# BEGIN custom-routes registry (generated by scripts/gen-custom-routes.mjs)',
    end: '# END custom-routes registry',
  },
}

/** Replace a marker-delimited block, or append if no marker exists yet. */
export function upsertBlock(text, begin, end, body) {
  const b = text.indexOf(begin)
  const e = text.indexOf(end)
  if (b === -1 || e === -1 || e < b) {
    return `${text.trimEnd()}\n\n${begin}\n${body}\n${end}\n`
  }
  return text.slice(0, b) + begin + '\n' + body + '\n' + text.slice(e)
}

export function buildChainsBlock(doc, existingAuto) {
  const chains = buildChains(doc, existingAuto)
  return `export const CUSTOM_CHAINS = ${JSON.stringify(chains, null, 2)}`
}

export function buildClientBlock(doc) {
  const providers = [...new Set((doc.routes ?? []).map(r => r.id))]
  // task-77: the first screen lists every declared free model — including the
  // ones already served by a catalog route (catalog_models). Availability is
  // recorded separately (status/status_reason); nothing is hidden or deleted.
  const models = [
    ...flattenModels(doc).map(x => x.model),
    ...(doc.catalog_models ?? []).map(m => m.id),
  ]
  return [
    `const CUSTOM_PROVIDERS = ${JSON.stringify(providers)}`,
    `const CUSTOM_MODELS = ${JSON.stringify(models)}`,
  ].join('\n')
}

/** Extract the current DEFAULT_CHAINS auto list from chains.js source (regex,
 *  no eval) so the free models can be prepended without losing paid hops. */
export function readExistingAuto(chainsSrc) {
  // P1: DEFAULT_CHAINS is now `Object.freeze({ auto: [] })` (neutral empty
  // shell). Accept that form and an empty auto list — the generator builds
  // chains from the user's declaration, not from shipped default hops.
  const m = chainsSrc.match(/DEFAULT_CHAINS\s*=\s*(?:Object\.freeze\(\s*)?\{[\s\S]*?auto:\s*\[([\s\S]*?)\]/)
  if (!m) throw new Error('cannot locate DEFAULT_CHAINS.auto in chains.js')
  const hops = [...m[1].matchAll(/\{\s*provider:\s*'([^']+)'\s*,\s*model:\s*'([^']+)'\s*\}/g)]
    .map(x => ({ provider: x[1], model: x[2] }))
  return hops // may be [] — neutral default, not an error
}

/** Diff-style report (unified-ish): print old/new line counts and a short preview. */
export function describeChange(path, before, after) {
  if (before === after) return `[=] ${path}: unchanged`
  const bl = before.split('\n').length
  const al = after.split('\n').length
  const added = after.split('\n').filter(l => !before.includes(l)).length
  return `[~] ${path}: ${bl} -> ${al} lines (~${added} new lines)`
}

export function writeIf(write, path, content) {
  if (write) writeFileSync(path, content, 'utf8')
}
