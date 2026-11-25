/**
 * Account ranking — configurable multi-factor scoring for the account pool.
 *
 * Design source: 账号池择优设计.md (task-32), §8 interface contract.
 *
 * Two categories of exports:
 *   - Pure JSON metadata (no function values) for the settings UI to consume.
 *   - Runtime pure functions (no I/O beyond the local pricing table) used by
 *     AccountPool.plan() and by the "why was this account chosen" panel.
 *
 * Ranking is OFF by default. When disabled (or strategy === 'legacy') the
 * caller keeps its byte-for-byte legacy comparator; nothing here mutates state.
 */

import { priceFor } from './pricing.js'

// ---------------------------------------------------------------------------
// §8.1 metadata (pure JSON)
// ---------------------------------------------------------------------------

/** Pricing fields the scorer knows about. `null` in the price table means "route does not support this field". */
export const PRICE_FIELD_REGISTRY = Object.freeze([
  { key: 'input', label: '输入', present: true, fallback: null, help: '每输入 token 单价' },
  { key: 'output', label: '输出', present: true, fallback: null, help: '每输出 token 单价，通常高于输入' },
  { key: 'cacheRead', label: '缓存命中输入', present: true, fallback: 'input', help: 'null 表示不支持，回退到输入单价' },
  { key: 'cacheWrite', label: '写缓存', present: true, fallback: 'input', help: 'null 表示不支持，回退到输入单价' },
  { key: 'reasoning', label: '推理输出', present: false, fallback: 'output', help: '定价表暂无此字段，回退到输出单价' },
  { key: 'cacheOutput', label: '缓存输出', present: false, fallback: 'output', help: '用户点名的缓存输出收费，定价表暂无，回退到输出单价' },
])

/** field -> fallback field name (or null). Kept as a plain object for UI/json consumption. */
export const PRICE_FALLBACKS = Object.freeze({
  input: null,
  output: null,
  cacheRead: 'input',
  cacheWrite: 'input',
  reasoning: 'output',
  cacheOutput: 'output',
})

export const DEFAULT_TOKEN_MIX = Object.freeze({
  input: 10, output: 1, cacheRead: 5, cacheWrite: 1, reasoning: 0, cacheOutput: 0,
})

/** Strategy presets. `weights: null` means legacy/custom (no fixed weights). */
export const RANKING_STRATEGIES = Object.freeze([
  { id: 'legacy', label: '兼容模式', description: '完全保持旧行为：route 优先 + 最少使用', weights: null },
  // Neutral by default (P1 / 落地规格 C1): no single goal, including cost, is
  // favored. An individual user's "saving-first" preference belongs in that
  // user's config (cost-first strategy), never in the shipped default.
  { id: 'balanced', label: '均衡（推荐）', description: '各项均衡，不偏向省钱或速度', weights: { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 } },
  { id: 'cost-first', label: '成本优先', description: '长任务、批量、后台跑', weights: { cost: 0.7, speed: 0.05, tier: 0.1, load: 0.15 } },
  { id: 'speed-first', label: '速度优先', description: '交互、低延迟需求', weights: { cost: 0.1, speed: 0.65, tier: 0.1, load: 0.15 } },
  { id: 'tier-first', label: '等级优先', description: '先用高等级；配 low 方向则先耗备份额度', weights: { cost: 0.1, speed: 0.1, tier: 0.65, load: 0.15 } },
  { id: 'custom', label: '自定义', description: '用户自定义权重，保存时归一化到和 = 1', weights: null },
])

const BALANCED_WEIGHTS = Object.freeze({ cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 })

export const DEFAULT_RANKING_CONFIG = Object.freeze({
  // Capability stage 2 (user-decided): the neutral balanced strategy is ON by
  // default. No user's model/prices are embedded — four factors are equal and
  // task-type -> candidate tier routing is generic product behavior. Users
  // with their own config override these values (normalizeRankingConfig).
  enabled: true,
  strategy: 'balanced',
  // Two-layer routing default: ON, neutral balanced. Task recognition picks
  // candidate tiers; the four in-tier weights stay equal (cost not favored).
  routing: Object.freeze({ enabled: true, strategy: 'balanced', tierPolicy: 'auto', weights: { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 } }),
  weights: { cost: 0.25, speed: 0.25, tier: 0.25, load: 0.25 },
  tierDirection: 'high',
  respectHopRoute: true,
  priorityMode: 'hard',
  tokenMix: { input: 10, output: 1, cacheRead: 5, cacheWrite: 1, reasoning: 0, cacheOutput: 0 },
  historical: { enabled: false, window: 200, mixWeight: 0.3 },
})

export const RANKING_CONFIG_SCHEMA = Object.freeze({
  title: '账号择优',
  fields: [
    { id: 'enabled', label: '启用分级择优', type: 'boolean', default: true, help: '默认启用均衡策略；关闭则回到旧版行为（route 优先 + 最少使用）' },
    { id: 'strategy', label: '策略预设', type: 'enum', options: RANKING_STRATEGIES.map(s => s.id), default: 'balanced' },
    { id: 'weights', label: '自定义权重', type: 'weights', keys: ['cost', 'speed', 'tier', 'load'], default: BALANCED_WEIGHTS, normalize: true, showWhen: { strategy: 'custom' }, help: '填任意非负数，保存时自动归一化到和 = 1' },
    { id: 'tierDirection', label: '等级方向', type: 'enum', options: ['high', 'low'], default: 'high', help: 'high = 高等级先用；low = 先消耗备份账号额度' },
    { id: 'respectHopRoute', label: '优先走链上指定路由', type: 'boolean', default: true, help: '关闭后跨 route 混排，评分完全决定首选账号' },
    { id: 'priorityMode', label: '硬优先级模式', type: 'enum', options: ['hard', 'soft'], default: 'hard', help: 'hard = 按 priority 分层，层内才评分；soft = priority 仅作同分时的 tiebreak' },
    { id: 'tokenMix', label: '典型 token 配比', type: 'tokenMix', keysFrom: 'PRICE_FIELD_REGISTRY', default: DEFAULT_TOKEN_MIX, help: '用于估算一次典型请求成本；只影响排序，不影响计费' },
    { id: 'historical', label: '账本反哺', type: 'history', default: { enabled: false, window: 200, mixWeight: 0.3 }, help: '用最近 N 条成本记录的真实 token 配比校正估算。不能反推真实单价。' },
  ],
})

export const ACCOUNT_RANKING_FIELDS = Object.freeze([
  { id: 'tier', label: '等级', type: 'enum', options: ['premium', 'standard', 'backup'], default: 'standard', help: '也接受数字 3/2/1，数字越大越高' },
  { id: 'speedTier', label: '速率档', type: 'enum', options: ['fast', 'normal', 'slow'], default: 'normal', help: '手动标记；有实测延迟（账本 ttft）时自动优先于手动档' },
  { id: 'priceTier', label: '价格档（兜底）', type: 'enum', options: ['free', 'low', 'mid', 'high'], default: 'mid', help: '仅当定价表无此路由且未覆盖单价时生效' },
  { id: 'costModel', label: '计费形态', type: 'enum', options: ['metered', 'subscription', 'free'], default: 'metered', help: '订阅制用额度消耗代价代替价格' },
  { id: 'quotaCost', label: '额度消耗代价', type: 'number', min: 0, max: 1, showWhen: { costModel: 'subscription' } },
  { id: 'priceMultiplier', label: '单价倍率', type: 'number', min: 0, default: 1, help: '0 = 免费账号，0.8 = 八折渠道' },
  { id: 'priceOverrides', label: '分项单价覆盖', type: 'priceTable', keysFrom: 'PRICE_FIELD_REGISTRY', help: '可全局覆盖，也可按 model 覆盖；留空则用 pricing.json' },
  { id: 'priority', label: '硬优先级', type: 'integer', default: 0, help: '数字越小越优先，与等级方向相反' },
  { id: 'weight', label: '权重', type: 'number', min: 0, default: 1, help: '乘在最终分上；0 = 排最后但仍会被尝试' },
])

const STRATEGY_IDS = new Set(RANKING_STRATEGIES.map(s => s.id))
const PRICE_KEYS = PRICE_FIELD_REGISTRY.map(f => f.key)
const TIER_NAMES = new Set(['premium', 'standard', 'backup'])
const SPEED_NAMES = new Set(['fast', 'normal', 'slow'])
const PRICE_TIERS = new Set(['free', 'low', 'mid', 'high'])
const COST_MODELS = new Set(['metered', 'subscription', 'free'])
const PRICE_TIER_PROXY = Object.freeze({ free: 0, low: 0.25, mid: 0.6, high: 1 })

// ---------------------------------------------------------------------------
// §8.2 normalization helpers
// ---------------------------------------------------------------------------

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** Weights: any non-negative numbers, normalized to sum 1. */
export function resolveWeights(strategy, customWeights) {
  let raw
  if (strategy === 'custom') raw = customWeights ?? BALANCED_WEIGHTS
  else {
    const preset = RANKING_STRATEGIES.find(s => s.id === strategy)
    raw = preset?.weights ?? BALANCED_WEIGHTS
  }
  const out = {}
  let sum = 0
  for (const key of ['cost', 'speed', 'tier', 'load']) {
    const v = Math.max(0, finiteOr(raw?.[key], BALANCED_WEIGHTS[key]))
    out[key] = v
    sum += v
  }
  if (sum <= 0) return { ...BALANCED_WEIGHTS }
  for (const key of Object.keys(out)) out[key] = out[key] / sum
  return out
}

/** Normalize the whole ranking block. Invalid fields fall back; never drops config. */
export function normalizeRankingConfig(value) {
  if (value === undefined || value === null) return structuredClone(DEFAULT_RANKING_CONFIG)
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('smart provider config `ranking` must be an object')
  }
  const strategy = STRATEGY_IDS.has(value.strategy) ? value.strategy : DEFAULT_RANKING_CONFIG.strategy
  const direction = value.tierDirection === 'low' ? 'low' : 'high'
  const mode = value.priorityMode === 'soft' ? 'soft' : 'hard'

  const mix = {}
  let mixSum = 0
  for (const key of PRICE_KEYS) {
    const configured = value.tokenMix?.[key]
    // Invalid (negative / non-finite) falls back to the default weight.
    const v = Number.isFinite(configured) && configured >= 0
      ? configured : DEFAULT_TOKEN_MIX[key]
    mix[key] = v
    mixSum += v
  }
  if (mixSum === 0) Object.assign(mix, DEFAULT_TOKEN_MIX)

  return {
    enabled: value.enabled === true,
    strategy,
    weights: {
      cost: Math.max(0, finiteOr(value.weights?.cost, BALANCED_WEIGHTS.cost)),
      speed: Math.max(0, finiteOr(value.weights?.speed, BALANCED_WEIGHTS.speed)),
      tier: Math.max(0, finiteOr(value.weights?.tier, BALANCED_WEIGHTS.tier)),
      load: Math.max(0, finiteOr(value.weights?.load, BALANCED_WEIGHTS.load)),
    },
    tierDirection: direction,
    respectHopRoute: value.respectHopRoute !== false,
    priorityMode: mode,
    tokenMix: mix,
    historical: {
      enabled: value.historical?.enabled === true,
      window: Math.max(1, Math.floor(finiteOr(value.historical?.window, 200))),
      mixWeight: Math.min(1, Math.max(0, finiteOr(value.historical?.mixWeight, 0.3))),
    },
  }
}

/**
 * Normalize only the NEW ranking fields on one account. Invalid values fall
 * back to neutral defaults; the account itself is never dropped.
 * Merged result keeps all existing base fields untouched.
 */
export function normalizeAccountRanking(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}

  const tier = src.tier
  if (typeof tier === 'string' && TIER_NAMES.has(tier)) out.tier = tier
  else if (tier === 3 || tier === '3') out.tier = 'premium'
  else if (tier === 2 || tier === '2') out.tier = 'standard'
  else if (tier === 1 || tier === '1') out.tier = 'backup'
  else out.tier = 'standard'

  out.speedTier = SPEED_NAMES.has(src.speedTier) ? src.speedTier : 'normal'
  out.priceTier = PRICE_TIERS.has(src.priceTier) ? src.priceTier : 'mid'
  out.costModel = COST_MODELS.has(src.costModel) ? src.costModel : 'metered'
  // Invalid (non-finite OR negative) values fall back to defaults rather than
  // being clamped to 0 — a negative weight/multiplier is a config error, not
  // "the user wants 0". Only quotaCost intentionally lives in [0,1], so an
  // out-of-range value is clamped there.
  out.quotaCost = Number.isFinite(src.quotaCost)
    ? Math.min(1, Math.max(0, src.quotaCost))
    : undefined
  out.priceMultiplier = Number.isFinite(src.priceMultiplier) && src.priceMultiplier >= 0
    ? src.priceMultiplier : 1
  out.priority = Number.isFinite(src.priority) ? Math.trunc(src.priority) : 0
  out.weight = Number.isFinite(src.weight) && src.weight >= 0 ? src.weight : 1

  const overrides = {}
  if (src.priceOverrides && typeof src.priceOverrides === 'object' && !Array.isArray(src.priceOverrides)) {
    for (const [key, value] of Object.entries(src.priceOverrides)) {
      if (key.startsWith('__')) continue // avoid prototype-ish keys leaking
      if (PRICE_KEYS.includes(key) && Number.isFinite(value) && value >= 0) overrides[key] = value
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const perModel = {}
        for (const [field, price] of Object.entries(value)) {
          if (PRICE_KEYS.includes(field) && Number.isFinite(price) && price >= 0) perModel[field] = price
        }
        if (Object.keys(perModel).length > 0) overrides[key] = perModel
      }
    }
  }
  out.priceOverrides = overrides
  return out
}

// ---------------------------------------------------------------------------
// §3.2 / §3.3 pricing resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective per-token price for one account/model/field.
 * Priority: per-model override > account-global override > pricing table >
 * fallback field > 0. Never throws.
 *
 * @returns {{usdPerToken:number, source:string, known:boolean}}
 *   source ∈ override | table | fallback | tier-proxy | neutral
 */
export function resolveEffectivePrice(account, model, field, opts = {}) {
  const a = account && typeof account === 'object' ? account : {}
  const ranking = a.ranking && typeof a.ranking === 'object' ? a.ranking : {}
  const overrides = ranking.priceOverrides ?? a.priceOverrides ?? {}
  const key = PRICE_KEYS.includes(field) ? field : 'input'

  // 1. per-model override
  const perModel = overrides[model]
  if (perModel && typeof perModel === 'object' && Number.isFinite(perModel[key])) {
    return { usdPerToken: Math.max(0, perModel[key]), source: 'override', known: true }
  }
  // 2. account-global override
  if (Number.isFinite(overrides[key])) {
    return { usdPerToken: Math.max(0, overrides[key]), source: 'override', known: true }
  }

  const price = priceFor(String(a.provider ?? ''), String(model ?? ''))
  // 3. pricing table (null = route does not support -> treat as missing)
  if (Number.isFinite(price[key]) && price[key] !== null && price[key] > 0) {
    return { usdPerToken: price[key], source: price.known ? 'table' : 'fallback', known: price.known }
  }
  // 4. fallback field
  const fallback = PRICE_FALLBACKS[key]
  if (fallback && Number.isFinite(price[fallback]) && price[fallback] > 0) {
    return { usdPerToken: price[fallback], source: 'fallback', known: price.known }
  }
  // 5. no price data -> proxy from user-declared priceTier, else neutral
  const proxy = PRICE_TIER_PROXY[ranking.priceTier ?? a.priceTier] ?? undefined
  if (opts.useProxy !== false && proxy !== undefined) {
    // Proxy is a relative cost in [0,1]; scale to a small USD-like magnitude
    // so it stays comparable with real table prices without pretending to be one.
    return { usdPerToken: proxy * 1e-7, source: 'tier-proxy', known: false }
  }
  return { usdPerToken: 0, source: 'neutral', known: false }
}

/**
 * Typical blended cost per token from the configured mix.
 * @returns {{usdPerTypicalToken:number, breakdown:Record<string,number>}}
 */
export function estimateTypicalCost(account, model, cfg) {
  const mix = cfg?.tokenMix ?? DEFAULT_TOKEN_MIX
  const ranking = account?.ranking && typeof account.ranking === 'object' ? account.ranking : {}
  const multiplier = Math.max(0, finiteOr(ranking.priceMultiplier ?? account?.priceMultiplier, 1))
  const costModel = ranking.costModel ?? account?.costModel ?? 'metered'

  let total = 0
  let weightSum = 0
  const breakdown = {}
  for (const key of PRICE_KEYS) {
    const w = Math.max(0, finiteOr(mix[key], 0))
    if (w === 0) continue
    const resolved = resolveEffectivePrice(account, model, key)
    breakdown[key] = resolved.usdPerToken
    total += w * resolved.usdPerToken
    weightSum += w
  }
  const blended = weightSum > 0 ? total / weightSum : 0

  if (costModel === 'free') return { usdPerTypicalToken: 0, breakdown }
  if (costModel === 'subscription') {
    const q = ranking.quotaCost ?? account?.quotaCost
    // quotaCost is an absolute [0,1] cost proxy; leave it in that domain and
    // let costScore normalize across candidates.
    return { usdPerTypicalToken: Number.isFinite(q) ? q : blended * 1e7, breakdown }
  }
  return { usdPerTypicalToken: blended * multiplier, breakdown }
}

// ---------------------------------------------------------------------------
// §4 scoring
// ---------------------------------------------------------------------------

function normLow(value, lo, hi) {
  return lo === hi ? 1 : (hi - value) / (hi - lo)
}

const SPEED_SCORE = Object.freeze({ fast: 1, normal: 0.6, slow: 0.2 })
const TIER_SCORE = Object.freeze({ premium: 1, standard: 0.6, backup: 0.2 })

function rankingOf(account) {
  if (account?.ranking && typeof account.ranking === 'object') return account.ranking
  return account && typeof account === 'object' ? account : {}
}

/**
 * P2 (task-1): map one measured latency sample onto the same 0..1 scale the
 * manual speedTier uses, so weights/contributions stay comparable.
 * Banding (deliberately coarse — a single sample must not produce false
 * precision; bands match the SPEED_SCORE fast/normal/slow semantics):
 *   ttft <= 800ms or tps >= 40  -> 1.0   (fast)
 *   ttft <= 2500ms or tps >= 12 -> 0.6   (normal)
 *   otherwise                   -> 0.2   (slow)
 * Returns null when the sample has no usable measurement.
 */
export function measuredSpeedScore(sample) {
  if (!sample || typeof sample !== 'object') return null
  const ttft = Number(sample.ttftMs)
  const tps = Number(sample.tokensPerSecond)
  const hasTtft = Number.isFinite(ttft) && ttft > 0
  const hasTps = Number.isFinite(tps) && tps > 0
  if (!hasTtft && !hasTps) return null
  if ((hasTtft && ttft <= 800) || (hasTps && tps >= 40)) return 1
  if ((hasTtft && ttft <= 2500) || (hasTps && tps >= 12)) return 0.6
  return 0.2
}

/**
 * Speed factor for one account — the task-1 fallback chain:
 *   1. real measured ttft/tps from this session's ledger context (ctx.speedEvidence)
 *   2. the user's hand-set speedTier
 *   3. neutral 0.5
 * Without ctx.speedEvidence the result is identical to the pre-task-1 code.
 */
function speedScore(account, speedEvidence) {
  const measured = measuredSpeedScore(speedEvidence?.[account?.id])
  if (measured !== null) return measured
  const r = rankingOf(account)
  return SPEED_SCORE[r.speedTier] ?? 0.5
}

function tierScore(account, cfg) {
  const r = rankingOf(account)
  let base = TIER_SCORE[r.tier]
  if (base === undefined) {
    const numeric = Number(r.tier)
    if (numeric >= 3) base = 1
    else if (numeric >= 2) base = 0.6
    else if (numeric >= 1) base = 0.2
    else base = 0.5
  }
  return cfg.tierDirection === 'low' ? 1 - base : base
}

/** Collect per-account effective cost for the whole model domain (incl. cooled). */
function domainCosts(domain, model, cfg) {
  const map = new Map()
  for (const a of domain) map.set(a.id, estimateTypicalCost(a, model, cfg).usdPerTypicalToken)
  return map
}

/**
 * Score one account. `ctx.domainCosts` / `ctx.domainUsage` optional precomputed
 * maps; otherwise computes from `ctx.domain ?? [account]`.
 * `ctx.speedEvidence` (P2 task-1) is an optional accountId -> {ttftMs,
 * tokensPerSecond} map built from real cost.jsonl latency data; present
 * entries override the manual speedTier, absent ones fall back to it.
 */
export function scoreAccounts(accounts, model, cfg, ctx = {}) {
  const cfgN = normalizeRankingConfig(cfg)
  const w = resolveWeights(cfgN.strategy, cfgN.weights)
  const usage = ctx.usage instanceof Map ? ctx.usage : new Map(Object.entries(ctx.usage ?? {}))
  const domain = Array.isArray(ctx.domain) ? ctx.domain : accounts
  const costs = ctx.domainCosts instanceof Map ? ctx.domainCosts : domainCosts(domain, model, cfgN)
  const values = [...costs.values()].concat(domain.map(a => usage.get(a.id) ?? 0))
  const costVals = [...costs.values()]
  const loadVals = domain.map(a => usage.get(a.id) ?? 0)
  const costLo = costVals.length ? Math.min(...costVals) : 0
  const costHi = costVals.length ? Math.max(...costVals) : 0
  const loadLo = loadVals.length ? Math.min(...loadVals) : 0
  const loadHi = loadVals.length ? Math.max(...loadVals) : 0
  void values

  return accounts.map(account => {
    const r = rankingOf(account)
    const cost = costs.get(account.id) ?? 0
    const cScore = normLow(cost, costLo, costHi)
    // P2 (task-1): measured ttft (ctx.speedEvidence) wins over speedTier;
    // absent evidence keeps the exact pre-task-1 value.
    const sScore = speedScore(account, ctx.speedEvidence)
    const tScore = tierScore(account, cfgN)
    const lScore = normLow(usage.get(account.id) ?? 0, loadLo, loadHi)
    const weight = Math.max(0, finiteOr(r.weight, 1))
    const contributions = {
      cost: w.cost * cScore,
      speed: w.speed * sScore,
      tier: w.tier * tScore,
      load: w.load * lScore,
    }
    const score = weight * (contributions.cost + contributions.speed + contributions.tier + contributions.load)
    return {
      account,
      score,
      factors: { cost: cScore, speed: sScore, tier: tScore, load: lScore },
      contributions,
    }
  })
}

/** Human-readable "why this account" explanation (Chinese short sentences). */
export function explainScore(account, model, cfg, ctx = {}) {
  const cfgN = normalizeRankingConfig(cfg)
  if (!cfgN.enabled || cfgN.strategy === 'legacy') {
    return { score: null, factors: null, contributions: null, why: ['择优未启用，走旧版排序（route 优先 + 最少使用）'] }
  }
  const ranked = scoreAccounts([account], model, cfgN, ctx)
  const item = ranked[0]
  const why = []
  const r = rankingOf(account)
  if (r.tier) why.push(`等级 ${r.tier}`)
  if (r.speedTier) why.push(`速率 ${r.speedTier}`)
  why.push(`成本因素 ${item.factors.cost.toFixed(2)}`)
  why.push(`负载因素 ${item.factors.load.toFixed(2)}`)
  if ((r.priority ?? 0) !== 0) why.push(`硬优先级 ${r.priority}（数字越小越优先）`)
  if (cfgN.respectHopRoute && ctx.hop && account.provider === ctx.hop.provider) {
    why.push('与链上指定路由一致，享有优先层')
  }
  return { score: item.score, factors: item.factors, contributions: item.contributions, why }
}

/**
 * Rank accounts for one hop — §4.3 layered comparator.
 * Layers (outer -> inner): priority hard -> respectHopRoute -> score DESC -> tiebreak.
 * Returns the same account objects, already filtered to `healthy` by the caller.
 */
export function rankAccountsForHop(domain, healthy, model, hop, cfg, ctx = {}) {
  const cfgN = normalizeRankingConfig(cfg)
  if (!cfgN.enabled || cfgN.strategy === 'legacy') {
    // Legacy comparator: route preferred, then least-used. Caller normally
    // bypasses us in this case, but keep the exact semantics as a safety net.
    const usage = ctx.usage instanceof Map ? ctx.usage : new Map(Object.entries(ctx.usage ?? {}))
    return [...healthy].sort((a, b) => {
      const ap = a.provider === hop?.provider ? 0 : 1
      const bp = b.provider === hop?.provider ? 0 : 1
      if (ap !== bp) return ap - bp
      return (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0)
    })
  }

  const usage = ctx.usage instanceof Map ? ctx.usage : new Map(Object.entries(ctx.usage ?? {}))
  const costs = domainCosts(domain, model, cfgN)
  const costVals = [...costs.values()]
  const loadVals = domain.map(a => usage.get(a.id) ?? 0)
  const costLo = costVals.length ? Math.min(...costVals) : 0
  const costHi = costVals.length ? Math.max(...costVals) : 0
  const loadLo = loadVals.length ? Math.min(...loadVals) : 0
  const loadHi = loadVals.length ? Math.max(...loadVals) : 0
  const w = resolveWeights(cfgN.strategy, cfgN.weights)

  const factorFor = account => {
    const r = rankingOf(account)
    const cost = costs.get(account.id) ?? 0
    const c = normLow(cost, costLo, costHi)
    // P2 (task-1): measured ttft (ctx.speedEvidence) wins over speedTier;
    // absent evidence keeps the exact pre-task-1 value.
    const s = speedScore(account, ctx.speedEvidence)
    const t = tierScore(account, cfgN)
    const l = normLow(usage.get(account.id) ?? 0, loadLo, loadHi)
    const weight = Math.max(0, finiteOr(r.weight, 1))
    return { score: weight * (w.cost * c + w.speed * s + w.tier * t + w.load * l), priority: r.priority ?? 0 }
  }
  const cached = new Map(healthy.map(a => [a.id, factorFor(a)]))

  return [...healthy].sort((a, b) => {
    const fa = cached.get(a.id)
    const fb = cached.get(b.id)
    // 1. priority hard layer
    if (cfgN.priorityMode === 'hard' && fa.priority !== fb.priority) return fa.priority - fb.priority
    // 2. route layer
    if (cfgN.respectHopRoute) {
      const ap = a.provider === hop?.provider ? 0 : 1
      const bp = b.provider === hop?.provider ? 0 : 1
      if (ap !== bp) return ap - bp
    }
    // 3. score descending
    if (fa.score !== fb.score) return fb.score - fa.score
    // 4. deterministic tiebreak: priority (soft only) -> usage -> id
    if (cfgN.priorityMode === 'soft' && fa.priority !== fb.priority) return fa.priority - fb.priority
    const ua = usage.get(a.id) ?? 0
    const ub = usage.get(b.id) ?? 0
    if (ua !== ub) return ua - ub
    return String(a.id).localeCompare(String(b.id))
  })
}

export default {
  RANKING_STRATEGIES, DEFAULT_RANKING_CONFIG, RANKING_CONFIG_SCHEMA,
  ACCOUNT_RANKING_FIELDS, PRICE_FIELD_REGISTRY, PRICE_FALLBACKS, DEFAULT_TOKEN_MIX,
  normalizeRankingConfig, normalizeAccountRanking, resolveEffectivePrice,
  estimateTypicalCost, scoreAccounts, explainScore, rankAccountsForHop, resolveWeights,
  measuredSpeedScore,
}
