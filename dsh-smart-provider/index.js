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
import { homedir } from 'node:os'
import { Config } from './schema.js'
import { yaml } from './registry/registry-lib.mjs'
import { SmartAdapter } from './lib/adapter.js'
import { discoverAutoChain } from './lib/chains.js'
import { CostMeter } from './lib/cost-meter.js'
import { buildHealthDeps } from './lib/health-setup.js' // L7: three-layer health power-on (default-on, opt-out)
import { createProbe } from './lib/probe.js' // task-107: minimal real probe replaces name guessing
import { SmartProviderRemote, readCostStats } from './lib/remote.js'
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
  const costDir = unwrap(config.costDir)
  const rawCostBatchSize = unwrap(config.costBatchSize)
  const rawFlushInterval = unwrap(config.costFlushIntervalMs)
  const dir = typeof costDir === 'string' && costDir ? costDir : undefined
  const batchSize = Number.isFinite(rawCostBatchSize) ? rawCostBatchSize : 16
  const flushIntervalMs = Number.isFinite(rawFlushInterval) ? rawFlushInterval : 2000
  const costEnabled = unwrap(config.costEnabled) !== false

  // Coerce the unwrapped volatile values to the shapes adapter/pool expect.
  const rawChains = unwrap(config.chains)
  const chains = rawChains && typeof rawChains === 'object' && !Array.isArray(rawChains)
    && Object.keys(rawChains).length > 0 && !Object.hasOwn(rawChains, 'meta')
    ? rawChains : undefined
  const rawAccounts = unwrap(config.accounts)
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : undefined

  const meter = new CostMeter({
    dir,
    batchSize,
    flushIntervalMs,
    onError: error => ctx.logger?.warn?.('smart: cost write failed: %o', error),
  })
  // A disabled meter still accepts records but never writes them.
  if (!costEnabled) meter.record = () => {}

  // Expose the REAL cost ledger to the settings client over a typed @Remote
  // service (`smartProvider/cost`). Same read path/口径 as the smart-cost host
  // command; the client mounts the matching contribution and renders these
  // numbers directly — no invented empty state, no client-side JSONL parsing.
  const statsReader = () => readCostStats(dir)
  // L5b: live availability registry reader — adapter is constructed below, so
  // read it lazily at call time. projectStatus() (L1 availability.js) merges
  // ledger + #recordHop session signals (workbuddy routes don't write cost.jsonl).
  const registryReader = () => adapter?.availabilityRegistry
  // task-107: lazy probe reader (adapter constructed below with adapter.probe).
  new SmartProviderRemote(ctx, statsReader, dir, registryReader, () => adapter?.probe)

  // ranking is volatile: normalize defensively (Config({}) in tests yields
  // schemastery markers for volatile paths, so never trust the raw type).
  // P2: routing is a separate opt-in config; normalizeRankingConfig() keeps
  // only its own fields, so attach routing explicitly. Accept both the nested
  // ranking.routing convention and the top-level Config.routing field.
  // User-specific position overrides (thrifty/swift) live in a USER file,
  // never in the shipped product default — a different user has no such
  // model, so baking it in would repeat the P1 "my配比 for everyone" bug.
  const PKG_DIR = dirname(fileURLToPath(import.meta.url))
  const readUserPositionOverrides = () => {
    const path = join(PKG_DIR, 'registry', 'position-overrides.user.yaml')
    if (!existsSync(path)) return {}
    try {
      const doc = yaml.parse(readFileSync(path, 'utf8'))
      return doc && typeof doc.overrides === 'object' && !Array.isArray(doc.overrides) ? doc.overrides : {}
    } catch { return {} }
  }
  const userPositionOverrides = readUserPositionOverrides()
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

  // P1 user resource adaptation: when the user has NOT configured chains,
  // build a NEUTRAL auto chain from the live DSH registry instead of shipping
  // one account's model list. Discovery is async (listModels returns a
  // Promise) so it runs after registration and is applied via the existing
  // in-place reconfigure path — no restart, no adapter re-registration.
  // Existing users' configured chains are untouched: discovery is skipped
  // entirely when `chains` is defined.
  async function refreshDiscoveredChains() {
    try {
      const providers = runtime.listProviders?.() ?? []
      const routes = []
      for (const entry of providers) {
        const provider = strId(entry)
        if (!provider || provider === 'smart') continue // never route to itself
        const listed = await runtime.listModels?.(provider)
        const models = Array.isArray(listed)
          ? listed.map(m => (typeof m === 'string' ? m : m && typeof m === 'object' ? m : null)).filter(Boolean)
          : []
        if (models.length) routes.push({ provider, models })
      }
      // P2: route metadata feeds the two-layer position classifier for ALL
      // users (including those with configured chains). P1 chain override
      // below still applies only when the user has NO configured chains.
      adapter.routes = routes
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
  // and notified through `loader/volatile-update`. Rebuild the adapter's
  // chains/accounts/ranking in place so edits take effect without a restart.
  ctx.on('loader/volatile-update', (paths = []) => {
    const changed = paths.some(p => {
      const keys = Array.isArray(p) ? p : String(p).split('.')
      return keys.some(k => k === 'chains' || k === 'accounts' || k === 'ranking')
    })
    if (!changed) return
    try {
      const nextRawChains = unwrap(config.chains)
      const nextChains = nextRawChains && typeof nextRawChains === 'object' && !Array.isArray(nextRawChains)
        && !Object.hasOwn(nextRawChains, 'meta') ? nextRawChains : undefined
      const nextRawAccounts = unwrap(config.accounts)
      const nextAccounts = Array.isArray(nextRawAccounts) ? nextRawAccounts : undefined
      adapter.reconfigure({
        chains: nextChains,
        accounts: nextAccounts,
        ranking: withRouting(unwrap(config.ranking)),
      })
      ctx.logger?.info?.('dsh-smart-provider: applied volatile config update')
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
      let source = dir || join(homedir(), '.dsh', 'smart-provider')
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
