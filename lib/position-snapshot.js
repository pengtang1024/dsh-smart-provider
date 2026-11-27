/**
 * Host-side, in-process projection behind @Remote modelPositions().
 *
 * The settings page needs a REAL per-model position table, but the client
 * cannot derive it: the browser cannot load this ESM and the Host catalog
 * Remote does not carry contextWindow / modalities / a boolean reasoning flag
 * (see docs/模型能力数据通路调研报告.md). So the derivation runs here, against
 * the same `adapter.routes` and the same effective position overrides the
 * adapter's layer-1 routing reads — no network, no new probe, no writes.
 *
 * Failure discipline matches lib/health-snapshot.js:260-273: the builder never
 * throws and degrades to an explicit `{enabled:false, rows:[]}` so the UI can
 * show "no data" instead of hanging on a rejected Remote call.
 */

import { derivePosition, projectModelForPosition } from './routing.js'

/**
 * The complete, closed tag vocabulary on the wire. The client declares exactly
 * these five lowercase i18n keys (`routing.tag.<tag>`) — any other internal
 * position tag is either mapped or dropped before crossing the boundary.
 */
export const MODEL_POSITION_TAGS = Object.freeze([
  'reasoning', 'multimodal', 'tool', 'longctx', 'general',
])

/** Internal routing name -> wire name. Only `vision` needs renaming. */
const TAG_ALIASES = Object.freeze({ vision: 'multimodal' })

/** Override lookup mirrors lib/adapter.js:667-668: `provider/model` wins over bare id. */
function declaredOverride(overrides, group, id) {
  if (!overrides) return undefined
  if (overrides instanceof Map) {
    return overrides.get(`${group}/${id}`) ?? overrides.get(id)
  }
  if (typeof overrides !== 'object') return undefined
  return overrides[`${group}/${id}`] ?? overrides[id]
}

/**
 * Build the modelPositions() wire snapshot from live in-process inputs.
 *
 * @param {{
 *   routes?: Array<{provider?:string, group?:string, models?:Array<object|string>}>,
 *   overrides?: object|Map<string, object|string[]>,
 * }} [input]
 * @returns {{
 *   enabled: boolean,
 *   rows: Array<{id:string, name:string, group:string, tags:string[],
 *     source:'auto'|'user'|'mixed'}>,
 * }}
 */
export function buildPositionSnapshot(input) {
  const source = input && typeof input === 'object' ? input : {}
  try {
    const routes = Array.isArray(source.routes) ? source.routes : []
    const overrides = source.overrides
    const rows = []

    for (const route of routes) {
      if (!route || typeof route !== 'object') continue
      const group = typeof route.provider === 'string' ? route.provider
        : (typeof route.group === 'string' ? route.group : '')
      // Same exclusion as collectProviderRoutes() / adapter layer-1: never
      // present the plugin's own virtual route as a real machine.
      if (!group || group === 'smart') continue

      for (const entry of Array.isArray(route.models) ? route.models : []) {
        const model = typeof entry === 'string' ? { id: entry }
          : (entry && typeof entry === 'object' ? entry : null)
        if (!model) continue
        const projected = projectModelForPosition(model)
        if (!projected.id) continue

        const derived = derivePosition(projected, declaredOverride(overrides, group, projected.id))
        const tags = []
        for (const tag of derived.tags) {
          const wire = Object.prototype.hasOwnProperty.call(TAG_ALIASES, tag) ? TAG_ALIASES[tag] : tag
          if (MODEL_POSITION_TAGS.includes(wire) && !tags.includes(wire)) tags.push(wire)
        }
        if (!tags.includes('general')) tags.push('general')

        rows.push({
          id: projected.id,
          name: typeof model.name === 'string' && model.name ? model.name : projected.id,
          group,
          tags,
          source: derived.source,
        })
      }
    }

    // "enabled" means there is real data to show; an empty discovery result is
    // reported as disabled rather than as a fabricated empty-but-valid table.
    return { enabled: rows.length > 0, rows }
  } catch {
    return { enabled: false, rows: [] }
  }
}

export default { buildPositionSnapshot, MODEL_POSITION_TAGS }
