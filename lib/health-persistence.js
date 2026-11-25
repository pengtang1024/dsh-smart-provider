/**
 * Cold-start hydration of health evidence (task-6).
 *
 * Why: `buildHealthDeps()` hands SmartAdapter an EMPTY availabilityRegistry and
 * a fresh account-health registry, and `rebuildFromLedger()` (account-health.js)
 * had no caller in the whole package. So every plugin reload zeroed the L1
 * route verdicts (HEALTHY / DEGRADED / DEPRECATED, free-vs-metered billing
 * confidence) and the L2 account state machine (cooldowns, streaks, samples) —
 * evidence that was already proven by real traffic and sitting on disk.
 *
 * This module replays that persisted evidence once at activation:
 *   - `cost.jsonl`      → L1 via updateHealth() per row (same classifier the
 *                          live path uses) and → L2 via rebuildFromLedger();
 *   - `probe-cache.jsonl` → L1 via updateHealth() from the recorded probe
 *                          verdict (free / metered / unknown), latest per tuple.
 *
 * Hard rules (task card):
 *  - READ ONLY: no mkdir, no append, no rewrite. A missing/partial/corrupt line
 *    never throws — a bad ledger must not block plugin activation.
 *  - BOUNDED: only the tail window is read (DEFAULT_HYDRATION_BOUNDS). Rationale:
 *    the most recent rows carry the current verdict; both layers already cap
 *    their sample windows (200 for L1, per-streak for L2) and L1 billing
 *    confidence saturates at 20 free samples, so replaying older than the last
 *    few thousand rows cannot change any decision — it would only add startup
 *    latency. The window is a byte budget AND a line budget; when the byte
 *    window starts mid-line that partial line is dropped.
 *  - NEVER LOSES LIVE EVIDENCE: hydration is fire-and-forget (index.js
 *    ctx.effect) so a real request may land first. Every replayed row is
 *    compared by timestamp/updatedAt and skipped when the registry already
 *    holds newer evidence.
 *  - No DSH import, no provider/model names hardcoded.
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { updateHealth, registryKey } from './availability.js'
import { rebuildFromLedger } from './account-health.js'

/** Same data dir cost-meter.js / probe.js default to. */
export const DEFAULT_HYDRATION_DIR = join(homedir(), '.dsh', 'smart-provider')

/**
 * Bound on what cold start may read per ledger. 4 MiB / 5000 lines is far more
 * than either layer needs (see header) and caps activation cost at one small
 * tail read per file.
 */
export const DEFAULT_HYDRATION_BOUNDS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxLines: 5000,
})

function str(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Does the LIVE record beat replayed ledger evidence for the same key?
 *
 * Hydration is fire-and-forget (index.js fires it from ctx.effect), so a real
 * request or probe can land first. Replayed rows must never undo that state, and
 * an exact-millisecond tie goes to the LIVE side: both writes then carry the
 * same timestamp and "who ran first" would otherwise decide the outcome.
 *
 * Extracted because the layers used to disagree — route/probe evidence compared
 * with `>=` while the account layer used `>`, so a same-millisecond replay
 * silently overwrote live L2 account state (cooldown dropped, streaks reset).
 */
export function liveWins(existing, timestamp) {
  return Boolean(existing) && Number.isFinite(existing.updatedAt) && existing.updatedAt >= timestamp
}

function normalizedBounds(bounds) {
  const raw = bounds && typeof bounds === 'object' ? bounds : {}
  const maxBytes = Number.isFinite(raw.maxBytes) ? Math.max(1, Math.floor(raw.maxBytes)) : DEFAULT_HYDRATION_BOUNDS.maxBytes
  const maxLines = Number.isFinite(raw.maxLines) ? Math.max(1, Math.floor(raw.maxLines)) : DEFAULT_HYDRATION_BOUNDS.maxLines
  return { maxBytes, maxLines }
}

/**
 * Read at most `maxLines` non-empty lines from the tail of `file`, never more
 * than `maxBytes` from the end. Pure read (`open(file, 'r')`).
 *
 * A missing file is a normal cold start, not an error. Every other read error
 * is reported through the returned `error` field and swallowed.
 *
 * @returns {Promise<{file:string, missing:boolean, error:string|undefined,
 *   totalBytes:number, bytesRead:number, truncatedBytes:number,
 *   droppedLines:number, lines:string[]}>}
 */
export async function readLedgerWindow(file, bounds = {}) {
  const { maxBytes, maxLines } = normalizedBounds(bounds)
  const out = {
    file, missing: false, error: undefined,
    totalBytes: 0, bytesRead: 0, truncatedBytes: 0, droppedLines: 0, lines: [],
  }
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      out.missing = true
      return out
    }
    out.error = `open failed: ${String(error?.message ?? error)}`
    return out
  }
  try {
    const info = await handle.stat()
    out.totalBytes = Number.isFinite(info?.size) ? info.size : 0
    const start = Math.max(0, out.totalBytes - maxBytes)
    out.truncatedBytes = start
    // When the window does not start at byte 0, read one byte earlier so a
    // boundary-aligned window (start === a line start) is not misread as partial.
    const from = start > 0 ? start - 1 : 0
    const length = out.totalBytes - from
    if (length <= 0) return out
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    out.bytesRead = bytesRead
    let view = buffer.subarray(0, bytesRead)
    if (start > 0) {
      if (view[0] === 0x0a) {
        view = view.subarray(1) // the window already began on a line boundary
      } else {
        // The window begins mid-line: that fragment is not a record.
        const newline = view.indexOf(0x0a)
        view = newline === -1 ? Buffer.alloc(0) : view.subarray(newline + 1)
      }
    }
    const text = view.toString('utf8')
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
    if (lines.length > maxLines) {
      out.droppedLines = lines.length - maxLines
      out.lines = lines.slice(lines.length - maxLines)
    } else {
      out.lines = lines
    }
  } catch (error) {
    out.error = `read failed: ${String(error?.message ?? error)}`
  } finally {
    try { await handle.close() } catch { /* already closed */ }
  }
  return out
}

/** Parse JSONL lines; a corrupt or non-object line is counted, never thrown. */
export function parseLedgerRows(lines) {
  const rows = []
  let malformed = 0
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string' || line.trim() === '') continue
    let row
    try { row = JSON.parse(line) } catch { malformed++; continue }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { malformed++; continue }
    rows.push(row)
  }
  return { rows, malformed }
}

/** Row timestamp for replay: invalid/missing => 0 (loses to any live evidence). */
function replayTimestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Zero cost in cost.jsonl has two different meanings:
 *  - a REAL free route: priceFor() found a declared zero price (price_known:true,
 *    estimated:false), or an upstream billing source confirmed free;
 *  - a NO-PRICE-TABLE estimate: tierEstimate() returns 0 with known:false /
 *    estimated:true purely as a placeholder. A model id that happens to contain
 *    "flash" must never turn into "possibly free" because of that placeholder.
 *
 * Only real zero cost may become L1 free evidence. Legacy rows written before
 * price_known existed carry no provenance, so they are treated as "no evidence"
 * rather than silently claiming free (same口径 as probe.js: cost=0 without a
 * billing-source confirmation is honest unknown). Positive spend is always kept
 * as metered evidence even when the price flag is missing.
 */
function replayCost(row) {
  const cost = Number(row?.estimated_cost_usd)
  if (!Number.isFinite(cost)) return undefined
  if (cost > 0) return cost
  return row?.price_known === true && row?.estimated !== true ? cost : undefined
}

/**
 * Replay cost.jsonl rows into the L1 registry through updateHealth(), the same
 * entry point the live adapter and probe use, so classification stays single-
 * sourced. Keys stay at (provider, modelId) granularity (updateHealth's
 * registryKey). Rows without both parts are counted as no-key and skipped.
 *
 * A row is skipped when the registry already holds evidence with an
 * `updatedAt` >= the row timestamp: live traffic always wins, ties included
 * (see liveWins).
 */
export function hydrateRouteEvidence(registry, rows, options = {}) {
  const summary = { replayed: 0, skipped: 0, newerKept: 0, noKey: 0 }
  const reg = registry && typeof registry === 'object' ? registry : undefined
  const list = Array.isArray(rows) ? rows : []
  if (!reg) {
    summary.skipped = list.length
    return summary
  }
  const currentIdList = Array.isArray(options.currentIdList) ? options.currentIdList : undefined
  for (const row of list) {
    const provider = str(row?.actual_provider) || str(row?.provider)
    const modelId = str(row?.actual_model) || str(row?.model)
    const key = registryKey({ provider, modelId })
    if (!key) {
      summary.skipped++
      summary.noKey++
      continue
    }
    const timestamp = replayTimestamp(row?.timestamp)
    const existing = reg[key]
    if (liveWins(existing, timestamp)) {
      summary.skipped++
      summary.newerKept++
      continue
    }
    const code = row?.failure_code == null || row.failure_code === '' ? null : String(row.failure_code)
    const record = updateHealth(reg, {
      provider,
      modelId,
      success: code === null,
      failure: code === null ? undefined : { code, message: str(row?.failure_message) },
      cost: replayCost(row),
      timestamp,
      currentIdList,
    })
    if (!record) {
      summary.skipped++
      continue
    }
    reg[key] = record
    summary.replayed++
  }
  return summary
}

/**
 * Replay cost.jsonl rows into the L2 registry via the existing
 * rebuildFromLedger() (cooldowns / streaks / samples). The rebuilt records are
 * merged INTO the live registry object (the adapter holds that reference), and
 * a record is not merged when the live one is newer OR carries the same
 * millisecond (live wins ties — see liveWins).
 */
export function hydrateAccountEvidence(registry, rows) {
  const list = Array.isArray(rows) ? rows : []
  const summary = { accounts: 0, newerKept: 0, rowsWithoutAccount: 0, unavailable: false }
  if (!registry || !(registry.records instanceof Map)) {
    summary.unavailable = true
    return summary
  }
  for (const row of list) {
    if (row?.account_id == null || row.account_id === '') summary.rowsWithoutAccount++
  }
  const rebuilt = rebuildFromLedger(list, registry.config ?? {})
  for (const [accountId, record] of rebuilt.records) {
    const existing = registry.records.get(accountId)
    if (liveWins(existing, record.updatedAt)) {
      summary.newerKept++
      continue
    }
    registry.records.set(accountId, record)
    summary.accounts++
  }
  return summary
}

/**
 * Replay probe-cache.jsonl verdicts into L1. The cache records the probe's
 * conclusion (verdict) rather than the raw usage object, so the replay maps that
 * recorded verdict back onto the same attempt fields probe.js writes —
 * free/metered keeps its billing confidence, unknown stays an honest sample.
 * Latest row per (provider, model) wins; earlier duplicates are counted.
 */
export function hydrateProbeEvidence(registry, rows) {
  const list = Array.isArray(rows) ? rows : []
  const summary = { replayed: 0, skipped: 0, duplicate: 0, newerKept: 0, noKey: 0 }
  const reg = registry && typeof registry === 'object' ? registry : undefined
  if (!reg) {
    summary.skipped = list.length
    return summary
  }
  const latest = new Map()
  for (const row of list) {
    const key = registryKey({ provider: str(row?.provider), modelId: str(row?.model) })
    if (!key) {
      summary.skipped++
      summary.noKey++
      continue
    }
    if (latest.has(key)) {
      summary.duplicate++
      latest.delete(key) // re-insert so the map keeps chronological order
    }
    latest.set(key, { key, row, timestamp: Number(row?.probedAt) })
  }
  const ordered = [...latest.values()]
    .map(entry => ({ ...entry, timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : 0 }))
    .sort((a, b) => a.timestamp - b.timestamp)

  for (const { key, row, timestamp } of ordered) {
    const existing = reg[key]
    if (liveWins(existing, timestamp)) {
      summary.newerKept++
      continue
    }
    const verdict = str(row?.verdict)
    const known = verdict === 'free' || verdict === 'metered'
    const cost = Number(row?.cost)
    const record = updateHealth(reg, {
      provider: str(row.provider),
      modelId: str(row.model),
      success: known,
      failure: known ? undefined : { code: 'UNKNOWN', message: str(row?.evidence) },
      cost: Number.isFinite(cost) ? cost : undefined,
      billingSource: verdict === 'free' ? 'free' : verdict === 'metered' ? 'metered' : undefined,
      timestamp,
    })
    if (!record) {
      summary.skipped++
      continue
    }
    reg[key] = record
    summary.replayed++
  }
  return summary
}

/**
 * One cold-start hydration pass. Never throws; returns a summary that the
 * caller logs as a single info line.
 *
 * Returns {hydrated:false, reason:'health-disabled'} when the user explicitly
 * disabled health (`health:false` / `ranking.health.enabled:false`), which is
 * exactly the `undefined` buildHealthDeps() returns. Nothing is read then.
 *
 * @param {object} options
 * @param {object} [options.health] buildHealthDeps() result
 * @param {string} [options.dir] data dir (default ~/.dsh/smart-provider)
 * @param {string} [options.costFile] override for cost.jsonl
 * @param {string} [options.probeCacheFile] override for probe-cache.jsonl
 * @param {object} [options.bounds] {maxBytes, maxLines}
 * @param {(message:string)=>void} [options.info]
 * @param {(message:string)=>void} [options.warn]
 */
export async function hydrateHealthEvidence(options = {}) {
  const health = options.health
  if (!health || health.enabled !== true) {
    return { hydrated: false, reason: 'health-disabled' }
  }
  const dir = typeof options.dir === 'string' && options.dir ? options.dir : DEFAULT_HYDRATION_DIR
  const bounds = normalizedBounds(options.bounds)
  const costFile = typeof options.costFile === 'string' && options.costFile
    ? options.costFile : join(dir, 'cost.jsonl')
  const probeFile = typeof options.probeCacheFile === 'string' && options.probeCacheFile
    ? options.probeCacheFile : join(dir, 'probe-cache.jsonl')
  const info = typeof options.info === 'function' ? options.info : () => {}
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const registry = health.availabilityRegistry && typeof health.availabilityRegistry === 'object'
    ? health.availabilityRegistry : undefined

  const costWindow = await readLedgerWindow(costFile, bounds)
  if (costWindow.error) warn(`smart health hydrate: ${costWindow.error}`)
  const costParsed = parseLedgerRows(costWindow.lines)
  const route = hydrateRouteEvidence(registry, costParsed.rows, { currentIdList: health.currentIdList })
  const account = hydrateAccountEvidence(health.accountHealth, costParsed.rows)

  const probeWindow = await readLedgerWindow(probeFile, bounds)
  if (probeWindow.error) warn(`smart health hydrate: ${probeWindow.error}`)
  const probeParsed = parseLedgerRows(probeWindow.lines)
  const probe = hydrateProbeEvidence(registry, probeParsed.rows)

  const costSkipped = costParsed.malformed + route.skipped
  const probeSkipped = probeParsed.malformed + probe.skipped
  info(
    `smart health hydrate: cost.jsonl rows=${costParsed.rows.length} replayed(L1)=${route.replayed} `
    + `skipped(L1)=${route.skipped} (malformed=${costParsed.malformed} no-key=${route.noKey} `
    + `newer-live=${route.newerKept}) L2 accounts=${account.accounts} `
    + `(newer-live=${account.newerKept} no-account=${account.rowsWithoutAccount}) `
    + `| probe-cache.jsonl rows=${probeParsed.rows.length} replayed=${probe.replayed} `
    + `skipped=${probeSkipped} (malformed=${probeParsed.malformed} duplicate=${probe.duplicate} `
    + `newer-live=${probe.newerKept}) `
    + `| total skipped rows=${costSkipped + probeSkipped} `
    + `| truncated lines=${costWindow.droppedLines}+${probeWindow.droppedLines} `
    + `bytes=${costWindow.truncatedBytes}+${probeWindow.truncatedBytes} `
    + `| bounds maxBytes=${bounds.maxBytes} maxLines=${bounds.maxLines}`,
  )

  return {
    hydrated: true,
    reason: null,
    dir,
    cost: {
      file: costFile, missing: costWindow.missing, error: costWindow.error,
      rows: costParsed.rows.length, malformed: costParsed.malformed,
      droppedLines: costWindow.droppedLines, truncatedBytes: costWindow.truncatedBytes,
      route, account,
    },
    probe: {
      file: probeFile, missing: probeWindow.missing, error: probeWindow.error,
      rows: probeParsed.rows.length, malformed: probeParsed.malformed,
      droppedLines: probeWindow.droppedLines, truncatedBytes: probeWindow.truncatedBytes,
      ...probe,
    },
  }
}

export default {
  DEFAULT_HYDRATION_DIR,
  DEFAULT_HYDRATION_BOUNDS,
  readLedgerWindow,
  parseLedgerRows,
  hydrateRouteEvidence,
  hydrateAccountEvidence,
  hydrateProbeEvidence,
  hydrateHealthEvidence,
}
