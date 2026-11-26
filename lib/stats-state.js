/**
 * Statistics start marker for the conversation-page cost banner.
 *
 * `clearStats()` sets a start instant; the ledger itself is NEVER truncated.
 * Readers aggregate only rows at/after that instant, so "clearing" is a pure
 * view filter and cost.jsonl stays byte-for-byte intact as the audit trail.
 *
 * Pure Node, no DSH/protocol dependency. The directory is always taken from
 * the live CostMeter instance (index.js passes meter.dir) so a hot costDir
 * edit moves both the ledger and its companion state together — never a
 * hardcoded ~/.dsh path that would silently split the two.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EMPTY = Object.freeze({ version: 1, since: null, clearedAt: null })

/**
 * Read the marker for one ledger directory. A missing, unreadable, or
 * malformed file degrades to the empty state: a broken marker must never make
 * the banner crash or silently hide every real cost.
 * @param {string} dir the live CostMeter directory
 * @returns {{version:1, since:string|null, clearedAt:string|null}}
 */
export function readStatsState(dir) {
  if (typeof dir !== 'string' || !dir) return { ...EMPTY }
  const file = join(dir, 'stats-state.json')
  if (!existsSync(file)) return { ...EMPTY }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY }
    // Only accept canonical ISO instants. A garbage/partial string is treated
    // as absent so a corrupt file can never filter the whole ledger to zero.
    const since = isoOrNull(parsed.since)
    const clearedAt = isoOrNull(parsed.clearedAt)
    return { version: 1, since, clearedAt }
  } catch { return { ...EMPTY } }
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/**
 * Atomically replace the marker file. Write to a unique sibling temp file,
 * then rename over the target: a crash between the two leaves either the old
 * marker or the new one, never a half-written JSON that would degrade to empty
 * and resurrect costs the user just cleared.
 * @param {string} dir the live CostMeter directory
 * @param {{since?:string|number|null, clearedAt?:string|number|null, now?:() => Date}} state
 * @returns {{version:1, since:string|null, clearedAt:string|null}}
 */
export function writeStatsState(dir, state = {}) {
  if (typeof dir !== 'string' || !dir) return { ...EMPTY }
  const now = typeof state.now === 'function' ? state.now : () => new Date()
  const stamp = isoOf(now(), null) ?? new Date().toISOString()
  const since = isoOf(state.since, null)
  const clearedAt = since === null ? null : isoOf(state.clearedAt, stamp)
  const next = { version: 1, since, clearedAt }
  const file = join(dir, 'stats-state.json')
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.stats-state.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temp, JSON.stringify(next), 'utf8')
  renameSync(temp, file)
  return next
}

function isoOf(value, fallback) {
  if (value == null) return fallback
  const at = typeof value === 'number'
    ? (Number.isFinite(value) ? value : NaN)
    : Date.parse(String(value))
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback
}

/**
 * Set the statistics start to `now` (the "clear" action). Returns the exact
 * state written so the caller can echo it on the wire. A broken injected clock
 * falls back to the real clock: clearing must always produce a valid instant,
 * never a null that would silently keep counting old costs.
 * @param {string} dir the live CostMeter directory
 * @param {() => Date} [clock] injectable clock for deterministic tests
 */
export function clearStatsState(dir, clock) {
  const candidate = typeof clock === 'function' ? clock() : new Date()
  const stamp = validDate(candidate) ? candidate : new Date()
  return writeStatsState(dir, { since: stamp, clearedAt: stamp, now: () => stamp })
}

function validDate(value) {
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(at)
}
