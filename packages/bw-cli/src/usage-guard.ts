/**
 * Minimum usage safeguards for a Bashwink launch (BW-075 / BW-076 minimum for the standard alpha).
 *
 * The pinned runtime already does the metering: every completed model request, including the session-title and
 * compaction requests that are not agent steps, produces one `session.usage.updated` event carrying cumulative
 * tokens and cost for that session, and every retry is announced by `session.retry.scheduled` before it is made.
 * This module only *reads* those events from the private server Bashwink owns, and stops the work when a limit
 * is reached. It does not meter anything itself and it is not an analytics system.
 *
 * What it can and cannot promise, and the tests check exactly this:
 *   - retries: bounded. The runtime announces a retry before making it, so a refused retry is never made.
 *   - new work after a limit: refused at the admission proxy, so no request starts.
 *   - the request in flight when a limit is crossed cannot be recalled, and one request can be large. This is
 *     therefore NOT a hard monetary ceiling. It limits how far past the line a run can go; it does not
 *     guarantee where it stops.
 *   - a cost limit needs a price. Without one the runtime reports cost 0 for real usage; Bashwink treats that
 *     as "unknown", says so, and refuses to run under a cost limit instead of pretending to enforce it.
 *   - the event stream is volatile by contract: events during a disconnection are lost. Gaps are counted and
 *     reported, and a summary with gaps is labelled incomplete.
 */

export const DEFAULT_MAX_REQUESTS = 300
export const DEFAULT_MAX_RETRIES = 5
/** The runtime's own retry ceiling, measured: 1 request plus 10 retries, then it fails with the provider's error. */
export const RUNTIME_MAX_RETRIES = 10

export interface UsageLimits {
  /** Model requests per Bashwink launch; undefined means the user asked for no limit. */
  readonly requests: number | undefined
  /** Input + output + reasoning tokens per launch; cached tokens are reported but not counted. */
  readonly tokens: number | undefined
  /** US dollars per launch, enforceable only when the model has a declared price. */
  readonly costUsd: number | undefined
  /** Retries of one failed request before the work is stopped. */
  readonly retries: number
  /** Optional wall-clock milliseconds limit per launch (BASHWINK_MAX_TIME_MS). */
  readonly timeMs?: number | undefined
}

export class LimitConfigError extends Error {}

function positive(
  name: string,
  raw: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (raw === undefined || raw === "") return fallback
  if (raw === "unlimited") return undefined
  if (!/^[1-9][0-9]{0,11}$/.test(raw))
    throw new LimitConfigError(
      `${name} must be a positive whole number or "unlimited" (got ${JSON.stringify(raw)})`,
    )
  return Number(raw)
}

export function parseLimits(env: Readonly<Record<string, string | undefined>>): UsageLimits {
  const requests = positive(
    "BASHWINK_MAX_REQUESTS",
    env["BASHWINK_MAX_REQUESTS"],
    DEFAULT_MAX_REQUESTS,
  )
  const tokens = positive("BASHWINK_MAX_TOKENS", env["BASHWINK_MAX_TOKENS"], undefined)
  const rawCost = env["BASHWINK_MAX_COST_USD"]
  let costUsd: number | undefined
  if (rawCost !== undefined && rawCost !== "" && rawCost !== "unlimited") {
    if (!/^(?:[0-9]+(?:\.[0-9]{1,6})?)$/.test(rawCost) || Number(rawCost) <= 0)
      throw new LimitConfigError(
        `BASHWINK_MAX_COST_USD must be a positive dollar amount such as 5 or 2.50 (got ${JSON.stringify(rawCost)})`,
      )
    costUsd = Number(rawCost)
  }
  const rawRetries = env["BASHWINK_MAX_RETRIES"]
  let retries = DEFAULT_MAX_RETRIES
  if (rawRetries !== undefined && rawRetries !== "") {
    if (!/^[0-9]{1,2}$/.test(rawRetries) || Number(rawRetries) > RUNTIME_MAX_RETRIES)
      throw new LimitConfigError(
        `BASHWINK_MAX_RETRIES must be a whole number from 0 to ${RUNTIME_MAX_RETRIES} (the runtime's own ceiling), got ${JSON.stringify(rawRetries)}`,
      )
    retries = Number(rawRetries)
  }
  const timeMs = positive("BASHWINK_MAX_TIME_MS", env["BASHWINK_MAX_TIME_MS"], undefined)
  return timeMs === undefined
    ? { requests, tokens, costUsd, retries }
    : { requests, tokens, costUsd, retries, timeMs }
}

interface SessionUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export interface UsageSummary {
  readonly requests: number
  readonly retries: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly costUsd: number
  /** True when the provider reported any token usage at all. */
  readonly tokensReported: boolean
  /** True when a price produced a non-zero cost. False with tokens reported means the price is unknown. */
  readonly costKnown: boolean
  /** Event-stream disconnections: usage after a gap may be missing. */
  readonly gaps: number
  readonly stopped?: string
  readonly limits: UsageLimits
}

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

/** Pure accounting. Feed it runtime events; it says whether the work must stop. */
export class UsageLedger {
  private readonly sessions = new Map<string, SessionUsage>()
  private requests = 0
  private retries = 0
  private gaps = 0
  private stopReason: string | undefined
  private readonly limits: UsageLimits

  constructor(limits: UsageLimits) {
    this.limits = limits
  }

  get stopped(): string | undefined {
    return this.stopReason
  }

  noteGap(): void {
    this.gaps += 1
  }

  /** Returns the stop reason the first time a limit is crossed, and nothing after that. */
  event(type: string, data: unknown): string | undefined {
    const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
    if (this.stopReason !== undefined) return undefined
    if (type === "session.retry.scheduled") return this.onRetry(body)
    if (type === "session.usage.updated") return this.onUsage(body)
    return undefined
  }

  private stop(reason: string): string {
    this.stopReason = reason
    return reason
  }

  private onRetry(body: Record<string, unknown>): string | undefined {
    const attempt = number(body["attempt"])
    // attempt 2 is the first retry of a failed request.
    const retriesOfThisRequest = Math.max(0, attempt - 1)
    if (retriesOfThisRequest > this.limits.retries)
      return this.stop(
        `the provider failed ${this.limits.retries + 1} times in a row, so the work was stopped instead of retrying again ` +
          `(BASHWINK_MAX_RETRIES=${this.limits.retries}). Check the provider and your connection, then try again.`,
      )
    if (this.limits.requests !== undefined && this.requests >= this.limits.requests)
      return this.stop(this.requestReason())
    this.requests += 1
    this.retries += 1
    return undefined
  }

  private requestReason(): string {
    return (
      `the request limit was reached (${this.limits.requests} model requests in this launch; BASHWINK_MAX_REQUESTS). ` +
      "No further model requests will be made. Raise the limit, or start Bashwink again, to continue."
    )
  }

  private onUsage(body: Record<string, unknown>): string | undefined {
    const id = typeof body["sessionID"] === "string" ? body["sessionID"] : "unknown"
    const tokens = (
      typeof body["tokens"] === "object" && body["tokens"] !== null ? body["tokens"] : {}
    ) as Record<string, unknown>
    const cache = (
      typeof tokens["cache"] === "object" && tokens["cache"] !== null ? tokens["cache"] : {}
    ) as Record<string, unknown>
    // Cumulative for the session, so the latest value replaces the previous one.
    this.sessions.set(id, {
      input: number(tokens["input"]),
      output: number(tokens["output"]),
      reasoning: number(tokens["reasoning"]),
      cacheRead: number(cache["read"]),
      cacheWrite: number(cache["write"]),
      costUsd: number(body["cost"]),
    })
    this.requests += 1
    const total = this.summary()
    const counted = total.tokens.input + total.tokens.output + total.tokens.reasoning
    if (this.limits.costUsd !== undefined) {
      if (counted > 0 && total.costUsd === 0)
        return this.stop(
          `a cost limit is set (BASHWINK_MAX_COST_USD=${this.limits.costUsd}) but this model reports no price, so the cost cannot be ` +
            "measured or limited. Declare the price with `bashwink auth add ... --price <model>=<input>:<output>` " +
            "(US dollars per million tokens), or limit tokens with BASHWINK_MAX_TOKENS.",
        )
      if (total.costUsd >= this.limits.costUsd)
        return this.stop(
          `the cost limit was reached ($${total.costUsd.toFixed(4)} of $${this.limits.costUsd}; BASHWINK_MAX_COST_USD). ` +
            "Requests already in flight were not recalled, so the final cost may be higher. No further requests will be made.",
        )
    }
    if (this.limits.tokens !== undefined && counted >= this.limits.tokens)
      return this.stop(
        `the token limit was reached (${counted} of ${this.limits.tokens}; BASHWINK_MAX_TOKENS). ` +
          "Requests already in flight were not recalled. No further requests will be made.",
      )
    if (this.limits.requests !== undefined && this.requests >= this.limits.requests)
      return this.stop(this.requestReason())
    return undefined
  }

  summary(): UsageSummary {
    const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    let costUsd = 0
    for (const usage of this.sessions.values()) {
      sum.input += usage.input
      sum.output += usage.output
      sum.reasoning += usage.reasoning
      sum.cacheRead += usage.cacheRead
      sum.cacheWrite += usage.cacheWrite
      costUsd += usage.costUsd
    }
    const counted = sum.input + sum.output + sum.reasoning
    return {
      requests: this.requests,
      retries: this.retries,
      tokens: sum,
      costUsd,
      tokensReported: counted > 0,
      costKnown: costUsd > 0,
      gaps: this.gaps,
      ...(this.stopReason === undefined ? {} : { stopped: this.stopReason }),
      limits: this.limits,
    }
  }
}

/** Human-readable end-of-run summary. Says what is unknown instead of showing a misleading zero. */
export function renderUsage(summary: UsageSummary): string {
  const t = summary.tokens
  const lines = [
    `Usage: ${summary.requests} model request${summary.requests === 1 ? "" : "s"}` +
      (summary.retries > 0
        ? ` (${summary.retries} retr${summary.retries === 1 ? "y" : "ies"})`
        : "") +
      (summary.limits.requests === undefined ? "" : ` of ${summary.limits.requests} allowed`),
    summary.tokensReported
      ? `  tokens: ${t.input} input, ${t.output} output` +
        (t.reasoning > 0 ? `, ${t.reasoning} reasoning` : "") +
        (t.cacheRead + t.cacheWrite > 0
          ? ` (cached: ${t.cacheRead} read, ${t.cacheWrite} written; not counted against a token limit)`
          : "")
      : "  tokens: unknown (the provider reported no usage, so a token limit cannot be enforced)",
    summary.costKnown
      ? `  cost: $${summary.costUsd.toFixed(4)} estimated from the declared price; the provider's invoice is authoritative`
      : summary.tokensReported
        ? "  cost: unknown (no price is declared for this model; add one with `bashwink auth add ... --price`)"
        : "  cost: unknown",
  ]
  if (summary.gaps > 0)
    lines.push(
      `  warning: usage events were missed ${summary.gaps} time${summary.gaps === 1 ? "" : "s"}; these figures may be too low`,
    )
  if (summary.stopped !== undefined) lines.push(`  STOPPED: ${summary.stopped}`)
  return lines.join("\n")
}

export interface GuardTarget {
  readonly url: string
  readonly authorization: string
  readonly workspace: string
}

export interface GuardOptions {
  readonly fetch?: typeof fetch
  /** Called once, when a limit stops the work. */
  readonly onStop?: (reason: string) => void
  /** Reconnect delay after the event stream ends; tests shorten it. */
  readonly reconnectMs?: number
}

/**
 * Reads the private server's event stream, applies the ledger and, when a limit is crossed, interrupts every
 * active session. The proxy that fronts the server asks `blocked()` before admitting new model work.
 */
export class UsageGuard {
  readonly ledger: UsageLedger
  readonly limits: UsageLimits
  private readonly options: GuardOptions
  private readonly doFetch: typeof fetch
  private target: GuardTarget | undefined
  private closed = false
  private readonly controller = new AbortController()
  private loop: Promise<void> | undefined
  private interrupting: Promise<void> | undefined
  private interruptAgain = false

  constructor(limits: UsageLimits, options: GuardOptions = {}) {
    this.limits = limits
    this.options = options
    this.ledger = new UsageLedger(limits)
    this.doFetch = options.fetch ?? fetch
  }

  blocked(): string | undefined {
    return this.ledger.stopped
  }

  summary(): UsageSummary {
    return this.ledger.summary()
  }

  attach(target: GuardTarget): void {
    if (this.target !== undefined) return
    this.target = target
    this.loop = this.run(target)
  }

  /** The server is being stopped on purpose: its event stream ending is not a gap. */
  detach(): void {
    this.closed = true
    this.controller.abort()
  }

  async stop(): Promise<void> {
    this.closed = true
    this.controller.abort()
    await this.loop?.catch(() => undefined)
    await this.interrupting?.catch(() => undefined)
  }

  private headers(target: GuardTarget): Record<string, string> {
    return {
      authorization: target.authorization,
      "x-opencode-directory": encodeURIComponent(target.workspace),
    }
  }

  private async run(target: GuardTarget): Promise<void> {
    let connected = false
    while (!this.closed) {
      try {
        const response = await this.doFetch(`${target.url}/api/event`, {
          headers: { ...this.headers(target), accept: "text/event-stream" },
          signal: this.controller.signal,
          redirect: "error",
        })
        if (!response.ok || response.body === null)
          throw new Error(`event stream returned HTTP ${response.status}`)
        if (connected) this.ledger.noteGap()
        connected = true
        const decoder = new TextDecoder()
        let buffer = ""
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true })
          let end: number
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            await this.frame(target, frame)
          }
        }
      } catch {
        if (this.closed) return
        if (connected) this.ledger.noteGap()
      }
      if (this.closed) return
      await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs ?? 250))
    }
  }

  private async frame(target: GuardTarget, frame: string): Promise<void> {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data === "") return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const { type, body } = unwrap(parsed)
    if (type === undefined) return
    const reason = this.ledger.event(type, body)
    if (reason !== undefined) {
      this.options.onStop?.(reason)
      this.requestInterrupt(target)
    } else if (this.ledger.stopped !== undefined && type === "session.execution.started") {
      // Work that began anyway (for example a request that was already queued) is stopped too.
      this.requestInterrupt(target)
    }
  }

  /**
   * Interrupting must not stall the event reader: the stream is volatile and a slow consumer is dropped, which
   * would lose exactly the events that matter after a limit is crossed. One interrupt runs at a time, and a
   * request that arrives meanwhile runs once more afterwards.
   */
  private requestInterrupt(target: GuardTarget): void {
    if (this.interrupting !== undefined) {
      this.interruptAgain = true
      return
    }
    this.interrupting = (async () => {
      do {
        this.interruptAgain = false
        await this.interrupt(target)
      } while (this.interruptAgain && !this.closed)
    })().finally(() => {
      this.interrupting = undefined
    })
  }

  private async interrupt(target: GuardTarget): Promise<void> {
    try {
      const active = await this.doFetch(`${target.url}/api/session/active`, {
        headers: this.headers(target),
        redirect: "error",
      })
      if (!active.ok) return
      const listed = (await active.json()) as { data?: Record<string, unknown> }
      for (const id of Object.keys(listed.data ?? {})) {
        if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) continue
        await this.doFetch(`${target.url}/api/session/${id}/interrupt`, {
          method: "POST",
          headers: this.headers(target),
          redirect: "error",
        })
      }
    } catch {
      // An interrupt that cannot be delivered is visible in the summary: the limit was crossed and the run continued.
    }
  }
}

/** Frames arrive as {type, data} or wrapped one level deeper as {id, event, data: {type, data}}. */
export function unwrap(parsed: unknown): { type: string | undefined; body: unknown } {
  if (typeof parsed !== "object" || parsed === null) return { type: undefined, body: undefined }
  const record = parsed as Record<string, unknown>
  if (typeof record["type"] === "string") return { type: record["type"], body: record["data"] }
  const inner = record["data"]
  if (typeof inner === "object" && inner !== null) {
    const nested = inner as Record<string, unknown>
    if (typeof nested["type"] === "string") return { type: nested["type"], body: nested["data"] }
  }
  if (typeof record["event"] === "string") return { type: record["event"], body: record["data"] }
  return { type: undefined, body: undefined }
}
