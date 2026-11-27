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
   * Account/model health controls (see lib/health-setup.js). Volatile so the
   * settings page can discover and edit it without a restart. Declaration only:
   * parsing semantics (the four opt-out shapes) stay in health-setup.js.
   */
  health: z.any().default(undefined).volatile(),
  /**
   * P2 two-layer routing (default ON with neutral equal weights; explicitly
   * disableable). Nested under ranking by convention: ranking.routing =
   * {enabled, strategy, tierPolicy, weights, positionOverrides, tierLimit}.
   * Kept in the same volatile object so the settings page can edit it without
   * a restart. Absent = DEFAULT_RANKING_CONFIG.routing (enabled:true,
   * balanced, four factors .25); explicit enabled:false = byte-for-byte legacy.
   */
  routing: z.any().default(undefined).volatile(),
  /**
   * 新建会话默认思考强度：auto=按虚拟模型与任务内容动态决定；手动档覆盖自动判断
   * (SPEC §7). Manual ids are the host ReasoningEffortId values; strength is a
   * standalone config key, no longer carried by a model-id suffix. Volatile so
   * the settings page can change it without a restart.
   */
  defaultEffort: z.union([
    z.const('auto'),
    z.const('off'),
    z.const('low'),
    z.const('medium'),
    z.const('high'),
    z.const('max'),
  ]).default('auto').volatile(),
  /** Enable the JSONL cost meter (volatile: editable without restart). */
  costEnabled: z.boolean().default(true).volatile(),
  /** Output directory for cost.jsonl; empty = ~/.dsh/smart-provider. */
  costDir: z.string().default('').volatile(),
  costBatchSize: z.number().default(16),
  costFlushIntervalMs: z.number().default(2000),
  /**
   * Conversation cost-pill controls (CF-2/CF-3). Volatile so the settings page
   * toggles them without restart. The statistics start marker is NOT a config
   * key: clearStats() persists it in stats-state.json next to cost.jsonl.
   */
  costPillEnabled: z.boolean().default(false).volatile(),
  costPillPosition: z.string().default('conversation.input.right').volatile(),
  costPillRefreshMs: z.number().default(60000).volatile(),
})
