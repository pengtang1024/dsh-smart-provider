/**
 * L7 power-on: build the `deps.health` object handed to SmartAdapter.
 *
 * Product intent: "自动正确管理" — the three-layer health mechanism is ON by
 * default. A user can opt out (never opt in) via an existing volatile config
 * surface; no schema field was added because schema.js is outside this task's
 * write scope and `ranking` is already `z.any().volatile()` and the established
 * home for nested opt-in subsystems (ranking.routing).
 *
 * Opt-out surface (any of these, checked in order):
 *   config.health.enabled === false             // dedicated field, if added later
 *   config.ranking.health.enabled === false     // nested under the existing any()
 *   config.health === false                     // terse form
 * Absent / malformed => enabled (default-on).
 *
 * Registries are created here and shared with L5's availabilityStatus reader
 * (index.js registryReader) and L4's AccountPool: the adapter keeps the same
 * object references, so one real attempt updates the very registry the first
 * screen reads. No DSH dependency, no I/O, no provider/model names hardcoded.
 */

import { createAccountHealthRegistry } from './account-health.js'

/** Unwrap a schemastery Volatile ref without trusting its runtime shape. */
function unwrap(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

function isOptOut(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const dedicated = unwrap(config.health)
  if (dedicated === false) return true
  if (dedicated && typeof dedicated === 'object' && dedicated.enabled === false) return true
  const ranking = unwrap(config.ranking)
  if (ranking && typeof ranking === 'object') {
    const nested = ranking.health
    if (nested === false) return true
    if (nested && typeof nested === 'object' && nested.enabled === false) return true
  }
  return false
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
