/**
 * Config schema for dsh-smart-provider.
 *
 * Loads @deepseek-ai/schemastery through a manifest anchor on real disk, the
 * same way dsh-bifrost-watch/schema.js does — a bare import from a symlinked
 * workspace bundle fails with ERR_MODULE_NOT_FOUND.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

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
  list.push('/opt/DSH NEXT/resources/app.asar/package.json')
  return [...new Set(list)]
}

function loadSchemastery() {
  const failures = []
  for (const anchor of anchors()) {
    let loaded
    try {
      loaded = createRequire(anchor)('@deepseek-ai/schemastery')
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? 'load failed'}`)
      continue
    }
    const candidate = loaded?.default ?? loaded
    if (candidate && typeof candidate.object === 'function') return candidate
    failures.push(`${anchor}: resolved without a usable object() builder`)
  }
  throw new Error(
    `dsh-smart-provider could not load @deepseek-ai/schemastery. Tried: ${failures.join('; ')}`,
  )
}

const z = loadSchemastery()

export const Config = z.object({
  /** Switch chains; each key is an outer model id, each hop {provider, model}. */
  chains: z.any().default(undefined).volatile(),
  /**
   * Account pool: an array of {id, provider(route), credentialRef, models[]}.
   * Multiple accounts of one model enable account-level failover + cooldown.
   * When absent/empty, behavior is byte-for-byte the legacy per-hop chain.
   */
  accounts: z.any().default(undefined).volatile(),
  /**
   * Account ranking config (see lib/ranking.js §8). Volatile so the settings
   * page can edit it and changes take effect without a restart.
   */
  ranking: z.any().default(undefined).volatile(),
  /**
   * P2 two-layer routing (opt-in, advanced only). Nested under ranking by
   * convention: ranking.routing = {enabled, strategy, tierPolicy, weights,
   * positionOverrides, tierLimit}. Kept in the same volatile object so the
   * settings page can edit it without a restart. Absent/disabled = legacy.
   */
  // Capability stage 2: default ON with neutral balanced. Users who set a
  // value override it entirely; absent uses DEFAULT_RANKING_CONFIG.routing.
  routing: z.any().default(undefined).volatile(),
  /** Enable the JSONL cost meter (volatile: editable without restart). */
  costEnabled: z.boolean().default(true).volatile(),
  /** Output directory for cost.jsonl; empty = ~/.dsh/smart-provider. */
  costDir: z.string().default('').volatile(),
  costBatchSize: z.number().default(16),
  costFlushIntervalMs: z.number().default(2000),
})
