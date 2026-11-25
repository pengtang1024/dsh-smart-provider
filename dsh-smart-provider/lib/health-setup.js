/**
 * L7 power-on: build the `deps.health` object handed to SmartAdapter.
 *
 * Product intent: "自动正确管理" — the three-layer health mechanism is ON by
 * default. A user can opt out (never opt in) via an existing volatile config
 * surface; no schema field was added because schema.js is outside this task's
 * write scope and `ranking` is already `z.any().volatile()` and the established
 * home for nested opt-in subsystems (ranking.routing).
 *
 * Opt-out matrix (single source of truth; any `false` opts out, OR semantics):
 *   config.health === false                     // terse dedicated form
 *   config.health.enabled === false             // dedicated field
 *   config.ranking.health === false             // DEPRECATED - warns on use
 *   config.ranking.health.enabled === false     // DEPRECATED - warns on use
 * Absent / malformed => enabled (default-on). No form can re-enable health.
 *
 * Registries are created here and shared with L5's availabilityStatus reader
 * (index.js registryReader) and L4's AccountPool: the adapter keeps the same
 * object references, so one real attempt updates the very registry the first
 * screen reads. No DSH dependency, no I/O, no provider/model names hardcoded.
 *
 * Cold start (task-6): this module only CREATES the registries, deliberately
 * empty and synchronously (apply() must not await disk). index.js then calls
 * hydrateHealthEvidence() (lib/health-persistence.js) from a ctx.effect and
 * fills these SAME objects in place from cost.jsonl / probe-cache.jsonl — L1 by
 * replaying updateHealth() rows, L2 by merging rebuildFromLedger() records —
 * so a reload no longer erases proven health/billing evidence. When the user
 * opt-outs (this factory returns undefined) that hydration is skipped entirely.
 */

import { createAccountHealthRegistry } from './account-health.js'

/** Unwrap a schemastery Volatile ref without trusting its runtime shape. */
function unwrap(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/**
 * The ordered opt-out matrix - the ONLY place health enable/disable is parsed.
 * A `false` on any surface opts out (OR); absent/malformed values are ignored,
 * so health stays ON by default and no surface can re-enable it.
 *
 * `config.health` and `config.ranking` are unwrapped first (schemastery
 * Volatile refs); nested `.enabled` values are read as-is. That asymmetry is
 * historical and intentional - do not "fix" it here without a behavior change.
 *
 * Only the two `ranking.health.*` OPT-OUT forms are deprecated. A
 * `ranking.health` object still carries legitimate nested config
 * (halfOpenPermits, topologyOpts, ...), so presence alone must NOT warn.
 */
function optOutSurfaces(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const dedicated = unwrap(config.health)
  const ranking = unwrap(config.ranking)
  const nested = ranking && typeof ranking === 'object' ? ranking.health : undefined
  return [
    { id: 'health', value: dedicated, deprecated: false, replacement: null },
    {
      id: 'health.enabled',
      value: dedicated && typeof dedicated === 'object' ? dedicated.enabled : undefined,
      deprecated: false,
      replacement: null,
    },
    { id: 'ranking.health', value: nested, deprecated: true, replacement: 'health' },
    {
      id: 'ranking.health.enabled',
      value: nested && typeof nested === 'object' ? nested.enabled : undefined,
      deprecated: true,
      replacement: 'health.enabled',
    },
  ]
}

function isOptOut(rawConfig) {
  let optedOut = false
  for (const surface of optOutSurfaces(rawConfig)) {
    if (surface.value !== false) continue
    optedOut = true
    if (surface.deprecated) {
      console.warn(
        `[health-setup] DEPRECATED opt-out form '${surface.id} === false'; ` +
        `use '${surface.replacement} === false' instead. Support will be removed in a future version.`
      )
    }
  }
  return optedOut
}

/**
 * buildHealthDeps(rawConfig) → {enabled, availabilityRegistry, accountHealth,
 *   virtualProviders, topologyOpts, currentIdList} | undefined
 *
 * Returns undefined when the user explicitly opted out, so SmartAdapter takes
 * its exact legacy path (all `this.health ? ... : undefined` fields stay
 * undefined). Otherwise returns a fully populated deps object.
 */
export function buildHealthDeps(rawConfig) {
  if (isOptOut(rawConfig)) return undefined
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const dedicated = unwrap(config.health)
  const healthCfg = dedicated && typeof dedicated === 'object' ? dedicated : {}
  const ranking = unwrap(config.ranking)
  const nested = ranking && typeof ranking === 'object' && ranking.health && typeof ranking.health === 'object'
    ? ranking.health : {}

  const accountHealth = createAccountHealthRegistry({
    ...(healthCfg.accountHealth ?? {}),
    ...nested,
  })

  // Virtual smart copies: 'smart' is the one legitimate exception to the
  // zero-hardcoded-name rule — it is the meta-provider this plugin itself
  // registers (registerAdapter(['smart'])), not a user resource. Additional
  // virtual providers may be supplied through config; none are invented.
  const configuredVirtual = healthCfg.virtualProviders ?? nested.virtualProviders
  // SmartAdapter converts arrays (or a Set) into its internal Set; pass an
  // array so the value survives the adapter's normalizer unchanged.
  const virtualProviders = ['smart']
  if (Array.isArray(configuredVirtual)) {
    for (const id of configuredVirtual) if (typeof id === 'string' && id && !virtualProviders.includes(id)) {
      virtualProviders.push(id)
    }
  } else if (configuredVirtual instanceof Set) {
    for (const id of configuredVirtual) if (typeof id === 'string' && id && !virtualProviders.includes(id)) {
      virtualProviders.push(id)
    }
  }

  return {
    enabled: true,
    availabilityRegistry: {},
    accountHealth,
    virtualProviders,
    topologyOpts: healthCfg.topologyOpts ?? nested.topologyOpts ?? {},
    currentIdList: Array.isArray(healthCfg.currentIdList) ? healthCfg.currentIdList : undefined,
  }
}
