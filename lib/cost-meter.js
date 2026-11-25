/**
 * Non-blocking JSONL cost meter.
 *
 * Each finished call enqueues one flat record; a single background flusher
 * batches records and appends them with one `fs.appendFile` per batch. The
 * stream hot path never awaits I/O — enqueue is an in-memory push only. Writes
 * are best-effort: a disk failure is reported through `onError` and never
 * propagates into the LLM stream.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { estimateCost } from './pricing.js'

const DEFAULT_DIR = join(homedir(), '.dsh', 'smart-provider')

/** Required JSONL fields (the leading nine named by the task). */
const FIELDS = [
  'timestamp', 'outer_model', 'actual_provider', 'actual_model',
  'input_tokens', 'output_tokens', 'estimated_cost_usd', 'hop_index',
  'failure_code',
  // task-50 diagnostic: sanitized upstream failure message (nullable). Kept as
  // a required field so a record written by this build always carries the key
  // (null for success), making the ledger schema self-describing.
  'failure_message',
]

/**
 * P2 (task-1): derive the optional latency block for one ledger record.
 *
 * All inputs are wall-clock ms from the adapter's REAL stream timeline — a
 * missing timestamp simply omits the fields, no 0-fake. ISO timestamps are
 * stored alongside the millisecond deltas so a human can read the ledger and
 * a scorer can skip the parse.
 *
 * @param {{startedAt?:number, firstTokenAt?:number, finishedAt?:number}} [latency]
 * @param {object|undefined} usage token usage (needed for tokens_per_second)
 * @returns {object} a spreadable object; empty when there is no data
 */
function latencyFields(latency, usage) {
  if (!latency || typeof latency !== 'object') return {}
  const { startedAt, firstTokenAt, finishedAt } = latency
  const out = {}
  if (Number.isFinite(startedAt) && startedAt > 0) out.started_at = new Date(startedAt).toISOString()
  if (Number.isFinite(firstTokenAt) && firstTokenAt > 0) out.first_token_at = new Date(firstTokenAt).toISOString()
  if (Number.isFinite(finishedAt) && finishedAt > 0) out.finished_at = new Date(finishedAt).toISOString()
  // ttft: first visible content chunk minus request start. Both endpoints must
  // exist and be ordered, otherwise the number would be meaningless.
  if (Number.isFinite(startedAt) && Number.isFinite(firstTokenAt) && firstTokenAt >= startedAt) {
    out.ttft_ms = Math.round(firstTokenAt - startedAt)
  }
  // duration: total wall time of the streaming attempt.
  if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
    out.duration_ms = Math.round(finishedAt - startedAt)
    // Generation throughput: output tokens over the whole attempt duration.
    // We deliberately use the full duration (not finishedAt - firstTokenAt):
    // DSH's usage chunk carries only a token COUNT, not a per-token timeline,
    // and inventing a finer window would be fabrication.
    const outputTokens = Math.max(0, Number(usage?.outputTokens ?? 0))
    if (usage != null && outputTokens > 0 && out.duration_ms > 0) {
      out.tokens_per_second = Number((outputTokens / (out.duration_ms / 1000)).toFixed(3))
    }
  }
  return out
}

export class CostMeter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir] output directory (default ~/.dsh/smart-provider)
   * @param {number} [opts.batchSize] records per flush (default 16)
   * @param {number} [opts.flushIntervalMs] max batch age in ms (default 2000)
   * @param {(error: Error) => void} [opts.onError] error sink (must not throw)
   */
  constructor(opts = {}) {
    this.dir = opts.dir ?? DEFAULT_DIR
    this.file = join(this.dir, 'cost.jsonl')
    this.batchSize = Math.max(1, Math.floor(opts.batchSize ?? 16))
    this.flushIntervalMs = Math.max(50, Math.floor(opts.flushIntervalMs ?? 2000))
    this.onError = typeof opts.onError === 'function' ? opts.onError : () => {}
    this.queue = []
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.timer
    this.flushing = false
    this.closed = false
    this.seq = 0
  }

  /** Ensure the directory exists before the first flush. Lazy, non-blocking. */
  #ensureDir() {
    if (!this.#dirReady) {
      this.#dirReady = mkdir(this.dir, { recursive: true }).catch(error => {
        this.onError(error)
      })
    }
    return this.#dirReady
  }

  /** @type {Promise<void>|undefined} */
  #dirReady

  /**
   * Enqueue one record from a finished hop. Synchronous and allocation-only.
   * @param {object} args
   */
  record({
    outerModel,
    actualProvider,
    actualModel,
    accountId,
    usage,
    hopIndex,
    failureCode = null,
    failureMessage = null,
    latency,
  }) {
    if (this.closed) return
    // Distinguish "the adapter never sent a usage chunk" from "usage was
    // reported but genuinely zero" — both otherwise look like 0 tokens.
    const usageComplete = usage !== undefined && usage !== null && typeof usage === 'object'
    const { estimatedCostUsd, known } = estimateCost(usage, actualProvider, actualModel)
    const record = {
      timestamp: new Date().toISOString(),
      outer_model: String(outerModel ?? ''),
      actual_provider: String(actualProvider ?? ''),
      actual_model: String(actualModel ?? ''),
      // Account-level attribution from the pool (implicit hop id when no pool
      // is configured). Optional so legacy/in-flight records still pass the
      // required-field filter below.
      account_id: accountId == null ? null : String(accountId),
      input_tokens: Math.max(0, Number(usage?.inputTokens ?? 0)),
      output_tokens: Math.max(0, Number(usage?.outputTokens ?? 0)),
      estimated_cost_usd: Number(estimatedCostUsd.toFixed(12)),
      hop_index: Number(hopIndex ?? 0),
      failure_code: failureCode == null ? null : String(failureCode),
      // Sanitized + truncated upstream message; adapter owns masking (task-50).
      failure_message: failureMessage == null ? null : String(failureMessage),
      // Extra diagnostic fields; the query script ignores unknown keys.
      cache_read_tokens: Math.max(0, Number(usage?.cacheReadTokens ?? 0)),
      cache_write_tokens: Math.max(0, Number(usage?.cacheWriteTokens ?? 0)),
      usage_complete: usageComplete,
      price_known: known,
      // P2 latency metrics (task-1). Timestamps come from the adapter's real
      // stream timeline; derivations are omitted entirely when the required
      // inputs are missing — never written as 0 to fake completeness. Older
      // ledger rows simply lack these keys, which every reader tolerates.
      ...latencyFields(latency, usageComplete ? usage : undefined),
      request_id: randomUUID(),
      seq: ++this.seq,
    }
    this.queue.push(record)
    if (this.queue.length >= this.batchSize) {
      // Fire-and-forget: never block the stream on the write.
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.flushIntervalMs)
      this.timer.unref?.()
    }
  }

  /** Flush the current batch. Safe to call concurrently; writes are serialized. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, this.queue.length)
    try {
      await this.#ensureDir()
      const lines = batch
        .filter(record => FIELDS.every(field => Object.hasOwn(record, field)))
        .map(record => JSON.stringify(record))
        .join('\n') + '\n'
      await appendFile(this.file, lines, 'utf8')
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.flushing = false
      // Records may have arrived while we were writing.
      if (this.queue.length >= this.batchSize) void this.flush()
      else if (this.queue.length > 0 && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.flush()
        }, this.flushIntervalMs)
        this.timer.unref?.()
      }
    }
  }

  /** Flush remaining records and stop accepting new ones. */
  async close() {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // Drain in case multiple batches accumulated.
    while (this.queue.length > 0 || this.flushing) {
      await this.flush()
      if (this.flushing) await new Promise(resolve => setImmediate(resolve))
    }
  }
}

/** @type {CostMeter|undefined} process-wide meter shared by the adapter */
let shared
/** @returns {CostMeter} lazily-created shared meter */
export function sharedMeter(opts) {
  if (!shared) shared = new CostMeter(opts)
  return shared
}
