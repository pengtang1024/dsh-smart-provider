/**
 * Single-source free-signal policy (Host side).
 *
 * NF2/task-24. User wording: "名字带 free 或者倍率为 0 的可以默认认为免费".
 * Ruling (free-contract task-23): name/multiplier/costModel/tier are WEAK or
 * USER-DECLARED signals — never hard billing evidence. This function is a pure
 * classifier: it reads the evidence passed in, writes no registry, and never
 * changes L1 billingTier / L2 health. A measured verdict or a real paid ledger
 * row always wins over any weak signal.
 *
 * Rule version is shared verbatim with the browser inline mirror in client.js
 * (free-client task-25) and is checked by free-verify task-26. Bump it only
 * when the decision semantics change, not for wording-only edits.
 */
export const FREE_SIGNAL_RULE_VERSION = 'free-signal-v1'

/** Level ladder: measured > declared > weak > none. */
export const FREE_SIGNAL_LEVELS = Object.freeze(['measured', 'declared', 'weak', 'none'])

const PAID_SOURCE_RE = /paid|meter|subscription|credit|go-plus/i

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function hasFreeName(input) {
  // Only the four explicit ids are considered: flash / trial / preview are NOT
  // free signals on their own (a route named 'flash' can still be paid).
  // Case-insensitive, substring match; 'hy4-flash-free' hits because of 'free'.
  return [input.provider, input.model, input.name, input.group]
    .some(value => typeof value === 'string' && value.toLowerCase().includes('free'))
}

/** Real price-table row: explicitly known and NOT a coarse tier estimate. */
function isRealPrice(price) {
  const p = asObject(price)
  return !!(p && p.known === true && p.estimated !== true)
}

function positivePrice(price) {
  if (!isRealPrice(price)) return false
  const inputPrice = Number(price.input ?? 0)
  const outputPrice = Number(price.output ?? 0)
  return (Number.isFinite(inputPrice) && inputPrice > 0) || (Number.isFinite(outputPrice) && outputPrice > 0)
}

function zeroPrice(price) {
  if (!isRealPrice(price)) return false
  const inputPrice = Number(price.input ?? 0)
  const outputPrice = Number(price.output ?? 0)
  return Number.isFinite(inputPrice) && Number.isFinite(outputPrice)
    && inputPrice === 0 && outputPrice === 0
}

function paidLedger(billing) {
  const b = asObject(billing)
  if (!b) return false
  if ((Number.isFinite(b.cost) && b.cost > 0)
    || (Number.isFinite(b.costUsd) && b.costUsd > 0)
    || (Number.isFinite(b.estimatedCostUsd) && b.estimatedCostUsd > 0)
    || (Number.isFinite(b.meteredSamples) && b.meteredSamples > 0)
    || (Number.isFinite(b.paidCalls) && b.paidCalls > 0)) return true
  const source = typeof b.billingSource === 'string' ? b.billingSource : ''
  return PAID_SOURCE_RE.test(source)
}

function freeLedger(billing) {
  const b = asObject(billing)
  if (!b) return false
  const source = typeof b.billingSource === 'string' ? b.billingSource : ''
  return /free|trial|bonus|allowance/i.test(source)
}

/**
 * Classify a provider/model route into a free signal.
 *
 * @param {{provider?:string, model?:string, name?:string, group?:string,
 *          multiplier?:number, priceMultiplier?:number, costModel?:string,
 *          priceTier?:string, probeVerdict?:string, billing?:object,
 *          price?:object}} input
 * @returns {{free:boolean, level:'measured'|'declared'|'weak'|'none',
 *            evidence:string, source:string}}
 */
export function freeSignal(input) {
  const i = asObject(input) ?? {}
  const verdict = typeof i.probeVerdict === 'string' ? i.probeVerdict : ''
  const b = asObject(i.billing)
  const price = asObject(i.price)
  // Two spellings of the same user-declared multiplier: 'multiplier' is the
  // canonical name, 'priceMultiplier' is the account ranking field name.
  // A non-number ('0', null, missing, negative, NaN/Infinity) is NOT zero.
  const rawMultiplier = i.multiplier === undefined ? i.priceMultiplier : i.multiplier
  const multiplierZero = typeof rawMultiplier === 'number'
    && Number.isFinite(rawMultiplier) && rawMultiplier === 0
  const costModelFree = typeof i.costModel === 'string' && i.costModel.toLowerCase() === 'free'

  // 1. Hard paid evidence beats everything, including a measured free verdict.
  if (verdict === 'metered' || paidLedger(b) || positivePrice(price)) {
    return { free: false, level: 'none',
      evidence: verdict === 'metered' ? 'probe verdict metered'
        : positivePrice(price) ? 'real price table row is positive'
          : 'paid billing evidence',
      source: verdict === 'metered' ? 'probe' : positivePrice(price) ? 'price' : 'billing' }
  }
  // 2. Measured free evidence: probe verdict or a real zero-price table row.
  if (verdict === 'free' || zeroPrice(price)) {
    return { free: true, level: 'measured',
      evidence: verdict === 'free' ? 'probe verdict free' : 'real price table row is zero',
      source: verdict === 'free' ? 'probe' : 'price' }
  }
  // 2b. Upstream free billing source is real evidence but weaker than a probe
  // verdict; keep it 'measured' so a user may still see "确认免费". Never
  // override a paid source because rule 1 already handled that case.
  if (freeLedger(b)) {
    return { free: true, level: 'measured', evidence: 'free upstream billing source', source: 'billing' }
  }
  // 3. User-declared defaults: multiplier 0 or costModel 'free'.
  if (multiplierZero || costModelFree) {
    return { free: true, level: 'declared',
      evidence: multiplierZero ? 'priceMultiplier=0 (declared)' : 'costModel=free (declared)',
      source: 'declared' }
  }
  // 4. Name / tier weak signals. 'unknown' verdict does not block these.
  if (hasFreeName(i)) {
    return { free: true, level: 'weak', evidence: 'name contains free (unmeasured)', source: 'name' }
  }
  if (typeof i.priceTier === 'string' && i.priceTier.toLowerCase() === 'free') {
    return { free: true, level: 'weak', evidence: 'user-declared priceTier=free', source: 'tier' }
  }
  // 5. No signal at all — never claim free.
  return { free: false, level: 'none', evidence: 'no free signal', source: 'none' }
}

/**
 * Fixed cross-implementation vectors. The browser mirror (client.js) and the
 * Host implementation must agree on free + level for every row; evidence and
 * source wording may differ. Exported for test/free-policy.test.mjs and for
 * task-26's mirror-consistency gate.
 */
export const FREE_POLICY_VECTORS = Object.freeze([
  { name: 'name-free', input: { provider: 'x-opencode-free', model: 'hy4-flash-free' }, expected: { free: true, level: 'weak' } },
  { name: 'multiplier-zero', input: { model: 'm', multiplier: 0 }, expected: { free: true, level: 'declared' } },
  { name: 'price-multiplier-zero-alias', input: { model: 'm', priceMultiplier: 0 }, expected: { free: true, level: 'declared' } },
  { name: 'multiplier-string-zero', input: { model: 'm', multiplier: '0' }, expected: { free: false, level: 'none' } },
  { name: 'multiplier-null', input: { model: 'm', multiplier: null }, expected: { free: false, level: 'none' } },
  { name: 'multiplier-missing', input: { model: 'm' }, expected: { free: false, level: 'none' } },
  { name: 'multiplier-negative', input: { model: 'm', multiplier: -1 }, expected: { free: false, level: 'none' } },
  { name: 'cost-model-free', input: { model: 'm', costModel: 'free' }, expected: { free: true, level: 'declared' } },
  { name: 'probe-free', input: { model: 'm', probeVerdict: 'free' }, expected: { free: true, level: 'measured' } },
  { name: 'probe-metered', input: { model: 'm', probeVerdict: 'metered', name: 'free-model', multiplier: 0 }, expected: { free: false, level: 'none' } },
  { name: 'probe-unknown-name-free', input: { model: 'hy4flash-free', probeVerdict: 'unknown' }, expected: { free: true, level: 'weak' } },
  { name: 'probe-unknown-multiplier-zero', input: { model: 'm', probeVerdict: 'unknown', multiplier: 0 }, expected: { free: true, level: 'declared' } },
  { name: 'real-zero-price', input: { model: 'm', price: { known: true, estimated: false, input: 0, output: 0 } }, expected: { free: true, level: 'measured' } },
  { name: 'real-positive-price', input: { model: 'free-model', price: { known: true, estimated: false, input: 1e-6, output: 2e-6 } }, expected: { free: false, level: 'none' } },
  { name: 'estimated-zero-price-not-free', input: { model: 'm', price: { known: false, estimated: true, input: 0, output: 0, priceTier: 'free' } }, expected: { free: false, level: 'none' } },
  { name: 'ledger-positive-cost', input: { model: 'free-model', billing: { costUsd: 0.01 } }, expected: { free: false, level: 'none' } },
  { name: 'ledger-paid-source', input: { model: 'free-model', billing: { billingSource: 'subscription-credit' } }, expected: { free: false, level: 'none' } },
  { name: 'ledger-free-source', input: { model: 'm', billing: { billingSource: 'free-allowance' } }, expected: { free: true, level: 'measured' } },
  { name: 'no-price-weak-signal', input: { model: 'm', name: 'free-tier' }, expected: { free: true, level: 'weak' } },
  { name: 'flash-not-free', input: { model: 'deepseek-v4-flash', provider: 'opencode-go' }, expected: { free: false, level: 'none' } },
  { name: 'price-tier-free-weak', input: { model: 'm', priceTier: 'free' }, expected: { free: true, level: 'weak' } },
  { name: 'uppercase-free', input: { provider: 'OPENCODE-GO', model: 'Beam-FREE' }, expected: { free: true, level: 'weak' } },
  { name: 'group-free', input: { model: 'm', group: 'Free-Tier' }, expected: { free: true, level: 'weak' } },
  { name: 'empty-input', input: {}, expected: { free: false, level: 'none' } },
])
