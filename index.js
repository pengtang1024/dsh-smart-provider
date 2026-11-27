/**
 * dsh-smart-provider — Host plugin entry.
 *
 * Registers the `smart` meta-provider via ctx.llm.registerAdapter().
 * UX pass 2026-11-23: beginner-first settings section — plain-language first
 * screen, all editing via structured controls (no JSON in the UI at any level);
 * host commands: honest registration status + credential-name listing.
 * IMPORTANT: do NOT add a `smart:` block under llm-pi-ai.providers in
 * cordis.patch.yml — doing both triggers DUPLICATE_ADAPTER (方案盲点审查 §11.2).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from './schema.js'
import { yaml } from './registry/registry-lib.mjs'
import { SmartAdapter } from './lib/adapter.js'
import { discoverAutoChain } from './lib/chains.js'
import { CostMeter } from './lib/cost-meter.js'
import { buildHealthDeps } from './lib/health-setup.js' // L7: three-layer health power-on (default-on, opt-out)
import { hydrateHealthEvidence } from './lib/health-persistence.js' // task-6: cold-start replay of persisted health evidence
import { createProbe } from './lib/probe.js' // task-107: minimal real probe replaces name guessing
import { buildHealthSnapshot } from './lib/health-snapshot.js' // frozen accountHealth() wire shape (pure)
import { buildPositionSnapshot } from './lib/position-snapshot.js' // frozen modelPositions() wire shape (pure)
import { SmartProviderRemote, readCostStats } from './lib/remote.js'
import { readStatsState, clearStatsState } from './lib/stats-state.js' // CF-1: statistics start marker (ledger is never truncated)
import {
  normalizeRankingConfig, DEFAULT_RANKING_CONFIG, RANKING_STRATEGIES, RANKING_CONFIG_SCHEMA,
  ACCOUNT_RANKING_FIELDS, PRICE_FIELD_REGISTRY, PRICE_FALLBACKS, DEFAULT_TOKEN_MIX,
} from './lib/ranking.js'

/**
 * Cordis service injection (root cause of the previous `failed` plugin state:
 * ReflectService throws "cannot get property \"llm\" without inject").
 *
 * ONLY `llm` is a hard requirement. The router merely *optionally* uses
 * sessions (hop records), commands (read-only host commands) and credentials
 * (credential NAME listing); declaring them here made the whole plugin refuse
 * to load in a lean profile that provides none of them — a headless E2E failed
 * with "pending (waiting for service: credentials)" and then NO_ADAPTER. Those
 * three are read through ctx.get() at use time instead (see optionalService).
 */
export const inject = ['llm']

/** Accept either a provider object ({id,...}) or a bare id string. */
function strId(entry) {
  if (typeof entry === 'string') return entry
  return entry && typeof entry === 'object' ? (entry.id ?? entry.key ?? '') : ''
}

/**
 * Sweep the live registry for routable models — one provider at a time.
 *
 * A provider whose adapter is not registered throws from listModels()
 * ("no adapter registered for provider X"). The first version awaited that call
 * inside ONE try/catch wrapped around the whole loop, so a single such provider
 * aborted the sweep: adapter.routes was never assigned and reconfigure() never
 * ran, leaving the auto chain empty for the whole session (observed live with
 * trae-enterprise / qoder-global / workbuddy-global / trae-global). Failure is
 * per-provider now: the healthy part of the registry still yields routes.
 *
 * Pure and exported so this resilience contract is verifiable without a Host —
 * the only inputs are the two registry accessors.
 *
 * @param {() => Array<string|{id?:string}>} listProviders registry accessor
 * @param {(provider: string) => Promise<Array<string|{id:string}>>} listModels
 * @returns {Promise<{routes: Array<{provider: string, models: Array<string|object>}>, skipped: string[]}>}
 */
export async function collectProviderRoutes(listProviders, listModels) {
  let providers = []
  try { providers = listProviders?.() ?? [] } catch { providers = [] }
  const routes = []
  const skipped = []
  for (const entry of Array.isArray(providers) ? providers : []) {
    const provider = strId(entry)
    if (!provider || provider === 'smart') continue // never route to itself
    let listed
    try {
      listed = await listModels?.(provider)
    } catch {
      skipped.push(provider) // no adapter / provider error: skip, keep sweeping
      continue
    }
    const models = Array.isArray(listed)
      ? listed.map(m => (typeof m === 'string' ? m : m && typeof m === 'object' ? m : null)).filter(Boolean)
      : []
    if (models.length) routes.push({ provider, models })
  }
  return { routes, skipped }
}

/** Runtime-editable configuration schema (single source of truth in schema.js). */
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = Config({})) {
  const runtime = ctx.llm
  if (!runtime?.registerAdapter || !runtime?.stream) {
    throw new Error('dsh-smart-provider requires ctx.llm with registerAdapter() and stream()')
  }

  /**
   * Read an optional cordis service without making it a load dependency.
   * `ctx.<name>` throws when the name is not injected, so `ctx.get()` is the
   * only supported way to probe for one. A missing service degrades to
   * undefined and every call site below already tolerates that.
   * @param {string} name service name
   * @returns {() => any} lazy getter
   */
  const optionalService = name => () => {
    try { return ctx.get?.(name) } catch { return undefined }
  }
  const getSessions = optionalService('sessions')
  const getCommands = optionalService('commands')
  const getCredentials = optionalService('credentials')

  // Volatile fields are filled by the loader at activation; a direct Config({})
  // (tests, or an unconfigured row) returns schemastery marker objects for
  // them, so coerce defensively rather than trusting their runtime type.
  // Volatile fields arrive from the Loader as `{get()}` refs, never as the
  // raw value. Reading the ref itself makes normalizeChains() see `[['get',
  // fn]]`, drop every hop and fall back to the PAID DEFAULT_CHAINS, and makes
  // normalizeRankingConfig() silently discard the configured ranking
  // (task-44 root cause). Unwrap first, then coerce defensively. Retained for
  // the `loader/volatile-update` handler below, which rebuilds in place.
  const unwrap = v => v && typeof v.get === 'function' ? v.get() : v
  // Cost settings are volatile, so their coercion lives in ONE place that the
  // loader/volatile-update handler re-runs - freezing the activation-time
  // values here is exactly how a costDir/costEnabled edit silently did nothing.
  const readCostConfig = () => {
    const rawCostDir = unwrap(config.costDir)
    const rawCostBatchSize = unwrap(config.costBatchSize)
    const rawFlushInterval = unwrap(config.costFlushIntervalMs)
    return {
      dir: typeof rawCostDir === 'string' && rawCostDir ? rawCostDir : undefined,
      batchSize: Number.isFinite(rawCostBatchSize) ? rawCostBatchSize : 16,
      flushIntervalMs: Number.isFinite(rawFlushInterval) ? rawFlushInterval : 2000,
      enabled: unwrap(config.costEnabled) !== false,
    }
  }
  /** Build the ledger writer for one cost config (same shape as before). A
   *  disabled meter still accepts records but never writes them. */
  const createMeter = cost => {
    const next = new CostMeter({
      dir: cost.dir,
      batchSize: cost.batchSize,
      flushIntervalMs: cost.flushIntervalMs,
      onError: error => ctx.logger?.warn?.('smart: cost write failed: %o', error),
    })
    if (!cost.enabled) next.record = () => {}
    return next
  }
  const initialCost = readCostConfig()
  const dir = initialCost.dir
  // Reassignable on purpose: a cost* hot update REPLACES the writer (its
  // private dir-readiness cache is bound to the constructor's dir), so the
  // adapter and the ledger readers must follow the CURRENT instance rather
  // than a stale activation-time capture.
  let meter = createMeter(initialCost)

  // Coerce the unwrapped volatile values to the shapes adapter/pool expect.
  const rawChains = unwrap(config.chains)
  const chains = rawChains && typeof rawChains === 'object' && !Array.isArray(rawChains)
    && Object.keys(rawChains).length > 0 && !Object.hasOwn(rawChains, 'meta')
    ? rawChains : undefined
  const rawAccounts = unwrap(config.accounts)
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : undefined

  // Expose the REAL cost ledger to the settings client over a typed @Remote
  // service (`smartProvider/cost`). Same read path/口径 as the smart-cost host
  // command; the client mounts the matching contribution and renders these
  // numbers directly — no invented empty state, no client-side JSONL parsing.
  // Read through the LIVE meter, so a hot costDir edit moves the reader with
  // the writer instead of leaving the settings page on the old ledger.
  // CF-1: `since` is an optional ISO/epoch cutoff. Passing undefined keeps the
  // legacy call shape byte-for-byte; clearStats() stores the marker separately.
  const statsReader = since => readCostStats(meter.dir, { since })
  // L5b: live availability registry reader — adapter is constructed below, so
  // read it lazily at call time. projectStatus() (L1 availability.js) merges
  // ledger + #recordHop session signals (workbuddy routes don't write cost.jsonl).
  const registryReader = () => adapter?.availabilityRegistry
  // task-107: lazy probe reader (adapter constructed below with adapter.probe).
  // Account health / cooldown snapshot reader. LAZY for the same reason as the
  // two readers above: `adapter` is constructed further down, so evaluating any
  // of this eagerly would capture undefined and freeze the settings section on
  // an empty snapshot for the whole session. The closure reads the raw inputs at
  // call time and hands them to the pure builder — no derivation happens here.
  const healthReader = () => {
    const pool = adapter?.accountPool
    const accounts = []
    if (pool?.byId instanceof Map) {
      for (const a of pool.byId.values()) {
        accounts.push({
          id: a.id,
          provider: a.provider,
          models: a.models ?? [],
          // Chain-hop derived accounts are named `hop:<provider>/<model>` by
          // AccountPool.implicitAccountId(); the UI shows them as implicit.
          implicit: typeof a.id === 'string' && a.id.startsWith('hop:'),
        })
      }
    }
    return buildHealthSnapshot({
      enabled: adapter?.health !== undefined,
      accountHealth: adapter?.accountHealth,
      cooldowns: adapter?.cooldowns,
      // E2A2: thread the opt-in through to mergeCooldown's 4th arg so the
      // frozen wire snapshot reads the L2-only authority on the on-branch.
      singleCooldown: adapter?.healthSingleCooldown,
      usage: pool?.usage,
      accounts,
      availabilityRegistry: adapter?.availabilityRegistry,
      now: Date.now(),
    })
  }
  // modelPositions() snapshot reader. LAZY for the same reason as healthReader:
  // `adapter` and the effective overrides are built further down, so an eager
  // read would freeze the per-model table on empty for the whole session. The
  // overrides are the SAME map layer-1 routing consumes (withRouting() merges
  // the file reader at index.js:238-256 UNDER explicit config), so the table
  // cannot disagree with the routing it describes. Pure builder; no I/O here.
  const positionReader = () => {
    return buildPositionSnapshot({
      routes: adapter?.routes,
      overrides: unwrap(ranking?.routing)?.positionOverrides ?? userPositionOverrides,
    })
  }
  // Kept as a handle: a cost* hot update repoints its ledger directory too.
  // stats-state readers stay DIRECT here (never config/volatile-update): a
  // statistics start is a user action, not a setting. They take the live
  // meter.dir at call time so a costDir hot edit moves marker + ledger together.
  const statsStateReader = stateDir => readStatsState(stateDir)
  const statsStateWriter = stateDir => clearStatsState(stateDir)
  const remote = new SmartProviderRemote(
    ctx, statsReader, dir, registryReader, () => adapter?.probe, healthReader,
    statsStateReader, statsStateWriter, positionReader,
  )

  // ranking is volatile: normalize defensively (Config({}) in tests yields
  // schemastery markers for volatile paths, so never trust the raw type).
  // P2: routing is a separate opt-in config; normalizeRankingConfig() keeps
  // only its own fields, so attach routing explicitly. Accept both the nested
  // ranking.routing convention and the top-level Config.routing field.
  // User-specific position overrides (thrifty/swift) live in a USER file,
  // never in the shipped product default — a different user has no such
  // model, so baking it in would repeat the P1 "my配比 for everyone" bug.
  const PKG_DIR = dirname(fileURLToPath(import.meta.url))
  /** Read the overrides block out of ONE registry YAML (missing/broken -> {}). */
  const readOverridesFile = path => {
    if (!existsSync(path)) return {}
    try {
      const doc = yaml.parse(readFileSync(path, 'utf8'))
      return doc && typeof doc.overrides === 'object' && !Array.isArray(doc.overrides) ? doc.overrides : {}
    } catch { return {} }
  }
  // Same 口径 as registry-lib.mjs's custom-routes: the USER file wins and the
  // SHIPPED product template is the fallback - never the other way round.
  // Previously only the .user.yaml was read, so a build that ships a template
  // (registry/position-overrides.yaml) saw its content vanish silently. Both
  // empty -> {} exactly as before, so an unconfigured install is unchanged.
  const readPositionOverrides = () => {
    const user = readOverridesFile(join(PKG_DIR, 'registry', 'position-overrides.user.yaml'))
    if (Object.keys(user).length) return user
    return readOverridesFile(join(PKG_DIR, 'registry', 'position-overrides.yaml'))
  }
  const userPositionOverrides = readPositionOverrides()
  const withRouting = cfg => {
    const out = normalizeRankingConfig(cfg)
    const raw = cfg && typeof cfg === 'object' ? cfg : {}
    const userRouting = raw.routing && typeof raw.routing === 'object' ? raw.routing : unwrap(config.routing)
    if (userRouting && typeof userRouting === 'object') {
      out.routing = userRouting // explicit user choice always wins
    } else if (!cfg || Object.keys(raw).length === 0) {
      // No user ranking config at all -> capability stage 2 default: neutral
      // balanced two-layer routing ON. Users who configured ranking keep their
      // own behavior (no silent override of their settings).
      out.routing = DEFAULT_RANKING_CONFIG.routing
    }
    // Merge user's position overrides (file) UNDER explicit config so cordis
    // ranking.routing.positionOverrides, if present, still wins.
    if (Object.keys(userPositionOverrides).length) {
      out.routing = {
        ...(out.routing ?? {}),
        positionOverrides: { ...userPositionOverrides, ...(out.routing?.positionOverrides ?? {}) },
      }
    }
    return out
  }
  const ranking = withRouting(unwrap(config.ranking))

  // L7 power-on: health is default-ON (user intent = "自动正确管理"); an
  // explicit opt-out returns undefined and SmartAdapter takes its exact legacy
  // path. The shared registries are the SAME objects L5's registryReader reads.
  const health = buildHealthDeps(config)
  const adapter = new SmartAdapter({
    runtime,
    chains,
    accounts,
    ranking,
    // Lazy bridge: only the hop record (P0-3) needs sessions, so the adapter
    // keeps working when the profile has no sessions service.
    sessions: { get: id => getSessions()?.get?.(id) },
    meter,
    logger: ctx.logger,
    health,
  })

  // task-107: Host-side minimal probe. Shares the SAME availabilityRegistry
  // as the health layers, so a verdict immediately feeds billingTier/free-zone
  // projection. config-channel-fix's SmartProviderRemote.probeModels reads
  // this lazily; no new inject/namespace, no probe fired at construction.
  adapter.probe = createProbe({
    runtime,
    availabilityRegistry: adapter.availabilityRegistry,
    // Persistent cache next to cost.jsonl; never in the user's config file.
    cacheFile: dir ? join(dir, 'probe-cache.jsonl') : undefined,
    warn: message => ctx.logger?.warn?.(message),
  })

  const handle = runtime.registerAdapter(['smart'], adapter)

  // task-6 cold-start hydration: the registries buildHealthDeps() created start
  // empty, so a reload used to erase every proven route verdict (HEALTHY /
  // DEGRADED / DEPRECATED, free-vs-metered billing confidence) and every account
  // cooldown/streak. Replay the persisted evidence once from cost.jsonl +
  // probe-cache.jsonl (read-only, bounded tail window).
  // Fire-and-forget inside ctx.effect: apply() is synchronous and activation must
  // never wait for disk. If a real request wins the race, the replay's
  // timestamp/updatedAt guard keeps that newer live evidence — the hydration
  // skips rows older than what the registry already holds. health === undefined
  // (user opted out) skips hydration entirely; nothing is even opened.
  if (health) {
    ctx.effect(() => {
      void hydrateHealthEvidence({
        dir,
        health,
        info: message => ctx.logger?.info?.('%s', message),
        warn: message => ctx.logger?.warn?.('%s', message),
      })
      return () => {}
    }, 'dsh-smart-provider.health-hydration')
  }

  // P1 user resource adaptation: when the user has NOT configured chains,
  // build a NEUTRAL auto chain from the live DSH registry instead of shipping
  // one account's model list. Discovery is async (listModels returns a
  // Promise) so it runs after registration and is applied via the existing
  // in-place reconfigure path — no restart, no adapter re-registration.
  // Existing users' configured chains are untouched: discovery is skipped
  // entirely when `chains` is defined.
  async function refreshDiscoveredChains() {
    try {
      const { routes, skipped } = await collectProviderRoutes(
        () => runtime.listProviders?.() ?? [],
        provider => runtime.listModels?.(provider),
      )
      // P2: route metadata feeds the two-layer position classifier for ALL
      // users (including those with configured chains). P1 chain override
      // below still applies only when the user has NO configured chains.
      // Assigned UNCONDITIONALLY: whatever was discovered must reach the
      // adapter even when part of the registry failed, which is the whole
      // point of the per-provider try/catch above.
      adapter.routes = routes
      // One summary instead of a warn per provider: a missing adapter is an
      // expected, non-fatal condition (vendor routes come and go).
      if (skipped.length) {
        const head = skipped.slice(0, 8)
        const rest = skipped.length - head.length
        const tail = rest > 0 ? ` (+${rest} more)` : ''
        if (routes.length === 0) {
          ctx.logger?.warn?.('dsh-smart-provider: auto-chain discovery found no usable provider; skipped %d without an adapter: %s%s',
            skipped.length, head.join(', '), tail)
        } else {
          ctx.logger?.info?.('dsh-smart-provider: discovery kept %d provider(s) and skipped %d without an adapter: %s%s',
            routes.length, skipped.length, head.join(', '), tail)
        }
      }
      if (chains !== undefined) return // user-configured chains are authoritative
      const auto = discoverAutoChain(routes)
      if (auto.length === 0) {
        ctx.logger?.info?.('dsh-smart-provider: no provider models discovered; auto chain stays empty (honest)')
        return
      }
      adapter.reconfigure({ chains: { auto }, accounts, ranking })
      ctx.logger?.info?.('dsh-smart-provider: discovered %d neutral auto hop(s) from live registry', auto.length)
    } catch (error) {
      ctx.logger?.warn?.('dsh-smart-provider: auto-chain discovery failed (staying empty): %o', error)
    }
  }
  ctx.effect(() => {
    // Fire-and-forget at activation; failures are logged, never thrown.
    void refreshDiscoveredChains()
    // Real registry events (dsh-llm types): `llm/adapters-updated` and
    // `llm/models-updated` — NOT `web/providers-changed`. ctx.on() returns an
    // unsubscribe handle in this runtime; guard defensively anyway.
    const off = typeof ctx.on === 'function' ? ctx.on('llm/adapters-updated', () => {
      adapter.probe?.invalidate() // task-107: reprice/rename -> allow fresh evidence
      void refreshDiscoveredChains()
    }) : undefined
    const offModels = typeof ctx.on === 'function' ? ctx.on('llm/models-updated', () => {
      adapter.probe?.invalidate()
      void refreshDiscoveredChains()
    }) : undefined
    return () => {
      for (const fn of [off, offModels]) { try { fn?.() } catch { /* disposed */ } }
    }
  }, 'dsh-smart-provider.discovery')

  // The settings → models page joins listProviders() (adapter routes) with
  // listConfigurableProviders() (the directory table) and only renders rows
  // whose settingsNs resolves in the settings mirror. registerAdapter() alone
  // yields a row with settingsNs:'' ⇒ configured=false ⇒ invisible. Declaring
  // the same route in the directory table (a DIFFERENT registry from adapters)
  // makes the row appear with a working config link, without re-registering an
  // adapter (which would trigger DUPLICATE_ADAPTER).
  ctx.effect(() => {
    const withdraw = runtime.registerConfigurableProviders([{
      provider: 'smart',
      displayName: 'Smart Gateway',
      settingsNs: 'smart-provider',
      settingsPath: [],
    }])
    ctx.logger?.info?.('dsh-smart-provider: declared smart configurable provider (Smart Gateway)')
    return () => { try { withdraw() } catch { /* already disposed */ } }
  }, 'dsh-smart-provider.directory')

  // Volatile config edits (settings page) are committed in place by the Loader
  // and notified through `loader/volatile-update`. EVERY key the schema marks
  // volatile must be honored here: the handled set used to be
  // chains/accounts/ranking only, so health, the top-level routing field and
  // the cost* fields were written by the settings page and silently ignored
  // until a restart (task-6).
  const VOLATILE_KEYS = new Set([
    'chains', 'accounts', 'ranking', 'health', 'routing',
    'costEnabled', 'costDir', 'costBatchSize', 'costFlushIntervalMs',
  ])
  const COST_KEYS = ['costEnabled', 'costDir', 'costBatchSize', 'costFlushIntervalMs']
  /** Normalize the loader payload into the set of volatile keys it mentions.
   *  Both the 'a.b' string form and the array form are accepted. */
  const changedKeys = paths => {
    const changed = new Set()
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      for (const k of Array.isArray(p) ? p : String(p).split('.')) {
        if (VOLATILE_KEYS.has(k)) changed.add(k)
      }
    }
    return changed
  }
  /**
   * Re-derive the health deps after an edit and hand the adapter the fresh
   * options. The registries are PRESERVED while health stays enabled - they are
   * the SAME objects the settings reader (healthReader) and the cold-start
   * hydration write into, so swapping them would erase every proven verdict.
   * Only a real enabled/disabled flip replaces them (and then they start empty,
   * exactly like a restart). Nothing here can re-enable an explicit opt-out:
   * buildHealthDeps() remains the single parser of that matrix.
   */
  const applyHealthUpdate = () => {
    const next = buildHealthDeps(config)
    const wasEnabled = adapter.health !== undefined
    const isEnabled = next !== undefined
    if (!wasEnabled && !isEnabled) return
    let applied = next
    if (wasEnabled && isEnabled) {
      applied = { ...next }
      if (adapter.availabilityRegistry) applied.availabilityRegistry = adapter.availabilityRegistry
      if (adapter.accountHealth) applied.accountHealth = adapter.accountHealth
    }
    adapter.health = applied
    adapter.healthSingleCooldown = adapter.health?.healthSingleCooldown === true
    adapter.availabilityRegistry = adapter.health ? (adapter.health.availabilityRegistry ?? {}) : undefined
    adapter.accountHealth = adapter.health?.accountHealth
    adapter.virtualProviders = adapter.health && Array.isArray(adapter.health.virtualProviders)
      ? new Set(adapter.health.virtualProviders) : undefined
  }
  ctx.on('loader/volatile-update', (paths = []) => {
    const changed = changedKeys(paths)
    if (changed.size === 0) return
    try {
      // cost* -> the writer's dir and its private dir-readiness cache are fixed
      // at construction, so REPLACE the meter and repoint every reader at the
      // new instance; the old one is closed so what it queued still lands.
      if (COST_KEYS.some(k => changed.has(k))) {
        const previous = meter
        meter = createMeter(readCostConfig())
        adapter.meter = meter
        remote.costDir = meter.dir
        try { void previous.close()?.catch?.(() => {}) } catch { /* already closed */ }
      }
      // health/routing/ranking/chains/accounts -> in-place reconfigure.
      if (['health', 'routing', 'ranking', 'chains', 'accounts'].some(k => changed.has(k))) {
        const nextRawChains = unwrap(config.chains)
        const nextChains = nextRawChains && typeof nextRawChains === 'object' && !Array.isArray(nextRawChains)
          && !Object.hasOwn(nextRawChains, 'meta') ? nextRawChains : undefined
        const nextRawAccounts = unwrap(config.accounts)
        const nextAccounts = Array.isArray(nextRawAccounts) ? nextRawAccounts : undefined
        // health/routing can flip the pool's health wiring and the ranking
        // rewrite must not resurrect a registry the user just opted out of.
        applyHealthUpdate()
        adapter.reconfigure({
          chains: nextChains,
          accounts: nextAccounts,
          ranking: withRouting(unwrap(config.ranking)),
        })
      }
      ctx.logger?.info?.('dsh-smart-provider: applied volatile config update (%s)', [...changed].join(', '))
    } catch (error) {
      ctx.logger?.warn?.('dsh-smart-provider: volatile config update failed: %o', error)
    }
  })

  // Read-only Host commands consumed by the settings section (no secrets:
  // credentialRef is echoed only as the configured reference name).
  ctx.effect(() => {
    const off = []
    const commands = getCommands()
    if (typeof commands?.register !== 'function') {
      ctx.logger?.info?.('dsh-smart-provider: commands service unavailable; host commands stay unregistered')
      return () => {}
    }
    const register = (name, description, handler) => {
      off.push(commands.register({ name, description, handler }) ?? (() => {}))
    }
    register('smart-schema', 'Smart provider ranking schema', () => ({
      kind: 'text',
      text: JSON.stringify({
        strategies: RANKING_STRATEGIES,
        configSchema: RANKING_CONFIG_SCHEMA,
        accountFields: ACCOUNT_RANKING_FIELDS,
        priceFields: PRICE_FIELD_REGISTRY,
        priceFallbacks: PRICE_FALLBACKS,
        tokenMix: DEFAULT_TOKEN_MIX,
      }),
    }))
    register('smart-status', 'Smart provider status', () => {
      // Honest registration check: ask the live LLM registry whether the smart
      // adapter route actually exists. Never hard-code true.
      let registered = false
      let providerCount = 0
      try {
        const ids = (ctx.llm?.listProviders?.() ?? []).map(p => strId(p))
        providerCount = ids.length
        registered = ids.includes('smart')
      } catch { /* registry unavailable -> report false, never a false green */ }
      return {
        kind: 'text',
        text: JSON.stringify({
          registered,
          providerCount,
          chains: Object.keys(adapter.chains),
          accounts: adapter.accountPool.byId.size,
          ranking: adapter.ranking,
          cooldowns: [...adapter.cooldowns.entries()].map(([id, v]) => ({ id, ...v })),
        }),
      }
    })
    // Only credential REFERENCE NAMES — never values. listRecords() returns
    // [{key, kind}] with no secrets (verified in dsh-credentials docs).
    register('smart-credentials', 'Smart provider configured credential names', async () => {
      let credentials = []
      try {
        const records = await getCredentials()?.listRecords?.() ?? []
        credentials = records
          .map(r => strId(r?.key ?? r?.id ?? r))
          .filter(Boolean)
          .sort()
      } catch { /* unavailable -> empty list; client shows the human default */ }
      return { kind: 'text', text: JSON.stringify({ credentials, count: credentials.length }) }
    })
    register('smart-health', 'Smart provider account health', () => {
      const now = Date.now()
      const rows = [...adapter.accountPool.byId.values()].map(a => {
        const cool = adapter.cooldowns.get(a.id)
        const cooling = !!cool && cool.until > now
        return {
          id: a.id,
          provider: a.provider,
          healthy: !cooling,
          coolReason: cooling ? cool.reason : null,
          coolRemainingMs: cooling ? cool.until - now : 0,
          usage: adapter.accountPool.usage.get(a.id) ?? 0,
        }
      })
      return { kind: 'text', text: JSON.stringify({ accounts: rows }) }
    })
    register('smart-cost', 'Smart provider cost estimate', () => {
      // CostMeter has no totalCostUsd()/rowCount(): read the JSONL ledger
      // directly so an empty ledger still returns a real {rows:0} structure.
      let rows = []
      // Follow the LIVE meter (identical default when unconfigured) so a hot
      // costDir edit moves this command with the writer instead of the old dir.
      const source = meter.dir
      try {
        const text = readFileSync(join(source, 'cost.jsonl'), 'utf8')
        rows = text.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line) } catch { return null }
        }).filter(Boolean)
      } catch { /* no ledger yet -> empty rows */ }
      let total = 0
      for (const r of rows) total += Number(r?.estimated_cost_usd ?? 0)
      return {
        kind: 'text',
        text: JSON.stringify({
          estimatedCostUsd: Number(total.toFixed(12)),
          records: rows.length,
          rows: rows.length,
          source,
          byProvider: rows.reduce((acc, r) => {
            const p = r?.actual_provider ?? 'unknown'
            acc[p] = (acc[p] ?? 0) + Number(r?.estimated_cost_usd ?? 0)
            return acc
          }, {}),
        }),
      }
    })
    return () => off.forEach(fn => { try { fn() } catch { /* disposed */ } })
  }, 'smart.commands')

  ctx.effect(() => async () => {
    try { handle() } catch { /* already disposed */ }
    await adapter.close()
  }, 'dsh-smart-provider.dispose')

  ctx.logger?.info?.('dsh-smart-provider: registered smart adapter with %d chain keys',
    Object.keys(adapter.chains).length)
}

export { SmartAdapter } from './lib/adapter.js'
export { CostMeter } from './lib/cost-meter.js'
