/**
 * Config schema for dsh-smart-provider.
 *
 * Loads @deepseek-ai/schemastery through a manifest anchor on real disk, the
 * same way dsh-bifrost-watch/schema.js does — a bare import from a symlinked
 * workspace bundle fails with ERR_MODULE_NOT_FOUND.
 */

import { loadDshPackage } from './lib/dsh.js'

/**
 * schemastery is resolved through the SAME manifest anchors as every other DSH
 * package this bundle loads (lib/dsh.js). Keeping one anchor list means
 * schema.js cannot drift back to a stale hard-coded install path, and a linked
 * workspace bundle works in any profile — not only the one that happens to ship
 * the package as a direct dependency.
 */
function loadSchemastery() {
  const loaded = loadDshPackage('@deepseek-ai/schemastery')
  for (const candidate of [loaded, loaded?.default]) {
    if (candidate && typeof candidate.object === 'function') return candidate
  }
  throw new Error('dsh-smart-provider: @deepseek-ai/schemastery resolved without a usable object() builder')
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
