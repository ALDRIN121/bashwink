import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyPrices } from "../src/providers-cli.js"
import { startAdmission, startsModelWork } from "../src/session-admission.js"
import { toRuntimeProvider } from "../src/providers.js"
import {
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_RETRIES,
  LimitConfigError,
  UsageGuard,
  UsageLedger,
  parseLimits,
  renderUsage,
  unwrap,
  type UsageLimits,
} from "../src/usage-guard.js"

const none: UsageLimits = { requests: undefined, tokens: undefined, costUsd: undefined, retries: 5 }
const usage = (session: string, input: number, output: number, cost = 0, extra = {}) => ({
  sessionID: session,
  cost,
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 }, ...extra },
})

describe("limit configuration", () => {
  test("defaults protect against runaway loops without needing any setting", () => {
    expect(parseLimits({})).toEqual({
      requests: DEFAULT_MAX_REQUESTS,
      tokens: undefined,
      costUsd: undefined,
      retries: DEFAULT_MAX_RETRIES,
    })
    expect(DEFAULT_MAX_RETRIES).toBeLessThanOrEqual(10)
  })

  test("explicit values, including an explicit request for no limit", () => {
    expect(
      parseLimits({
        BASHWINK_MAX_REQUESTS: "40",
        BASHWINK_MAX_TOKENS: "250000",
        BASHWINK_MAX_COST_USD: "2.50",
        BASHWINK_MAX_RETRIES: "0",
      }),
    ).toEqual({ requests: 40, tokens: 250000, costUsd: 2.5, retries: 0 })
    expect(parseLimits({ BASHWINK_MAX_REQUESTS: "unlimited" }).requests).toBeUndefined()
  })

  test("a malformed limit is refused rather than ignored", () => {
    for (const env of [
      { BASHWINK_MAX_REQUESTS: "0" },
      { BASHWINK_MAX_REQUESTS: "-3" },
      { BASHWINK_MAX_REQUESTS: "many" },
      { BASHWINK_MAX_REQUESTS: "1e3" },
      { BASHWINK_MAX_TOKENS: "12.5" },
      { BASHWINK_MAX_COST_USD: "0" },
      { BASHWINK_MAX_COST_USD: "$5" },
      { BASHWINK_MAX_COST_USD: "5.1234567" },
      { BASHWINK_MAX_RETRIES: "11" },
      { BASHWINK_MAX_RETRIES: "-1" },
    ])
      expect(() => parseLimits(env)).toThrow(LimitConfigError)
  })
})

describe("retries are bounded", () => {
  const retry = (attempt: number) => ({ sessionID: "ses_a", attempt, error: { status: 429 } })

  test("the first N retries are allowed and the next is refused before it is made", () => {
    const ledger = new UsageLedger({ ...none, retries: 5 })
    for (const attempt of [2, 3, 4, 5, 6])
      expect(ledger.event("session.retry.scheduled", retry(attempt))).toBeUndefined()
    const reason = ledger.event("session.retry.scheduled", retry(7))
    expect(reason).toContain("BASHWINK_MAX_RETRIES=5")
    expect(ledger.stopped).toBe(reason)
    expect(ledger.summary().retries).toBe(5)
  })

  test("zero retries refuses the first retry", () => {
    const ledger = new UsageLedger({ ...none, retries: 0 })
    expect(ledger.event("session.retry.scheduled", retry(2))).toContain("failed 1 times")
  })

  test("a stop is reported once, then latched", () => {
    const ledger = new UsageLedger({ ...none, retries: 0 })
    expect(ledger.event("session.retry.scheduled", retry(2))).toBeDefined()
    expect(ledger.event("session.retry.scheduled", retry(3))).toBeUndefined()
    expect(ledger.stopped).toBeDefined()
  })
})

describe("request, token and cost limits", () => {
  test("every completed model request counts, including title and compaction requests", () => {
    const ledger = new UsageLedger({ ...none, requests: 3 })
    expect(ledger.event("session.usage.updated", usage("ses_a", 30, 4))).toBeUndefined()
    expect(ledger.event("session.usage.updated", usage("ses_a", 1230, 49))).toBeUndefined()
    const reason = ledger.event("session.usage.updated", usage("ses_a", 2730, 61))
    expect(reason).toContain("BASHWINK_MAX_REQUESTS")
    expect(ledger.summary().requests).toBe(3)
  })

  test("a retry counts as a request and is refused when it would exceed the limit", () => {
    const ledger = new UsageLedger({ ...none, requests: 2, retries: 5 })
    expect(ledger.event("session.retry.scheduled", { attempt: 2 })).toBeUndefined()
    expect(ledger.event("session.retry.scheduled", { attempt: 3 })).toBeUndefined()
    expect(ledger.event("session.retry.scheduled", { attempt: 4 })).toContain("request limit")
    expect(ledger.summary().requests).toBe(2)
  })

  test("usage is cumulative per session: the latest value replaces the earlier one, sessions add up", () => {
    const ledger = new UsageLedger(none)
    ledger.event("session.usage.updated", usage("ses_a", 100, 10, 0.5))
    ledger.event("session.usage.updated", usage("ses_a", 300, 30, 1.5))
    ledger.event("session.usage.updated", usage("ses_child", 50, 5, 0.25))
    const summary = ledger.summary()
    expect(summary.tokens.input).toBe(350)
    expect(summary.tokens.output).toBe(35)
    expect(summary.costUsd).toBeCloseTo(1.75)
    expect(summary.requests).toBe(3)
  })

  test("a token limit counts input, output and reasoning but not cached tokens", () => {
    const ledger = new UsageLedger({ ...none, tokens: 1000 })
    expect(
      ledger.event(
        "session.usage.updated",
        usage("ses_a", 400, 100, 0, { cache: { read: 90_000, write: 5_000 } }),
      ),
    ).toBeUndefined()
    expect(ledger.event("session.usage.updated", usage("ses_a", 800, 250))).toContain(
      "BASHWINK_MAX_TOKENS",
    )
  })

  test("a cost limit stops at the limit and says in-flight requests were not recalled", () => {
    const ledger = new UsageLedger({ ...none, costUsd: 1 })
    expect(ledger.event("session.usage.updated", usage("ses_a", 1000, 100, 0.4))).toBeUndefined()
    const reason = ledger.event("session.usage.updated", usage("ses_a", 2000, 200, 1.2))
    expect(reason).toContain("BASHWINK_MAX_COST_USD")
    expect(reason).toContain("not recalled")
  })

  test("a cost limit with no known price refuses to run instead of pretending to enforce", () => {
    const ledger = new UsageLedger({ ...none, costUsd: 5 })
    const reason = ledger.event("session.usage.updated", usage("ses_a", 1000, 100, 0))
    expect(reason).toContain("reports no price")
    expect(reason).toContain("--price")
    expect(reason).toContain("BASHWINK_MAX_TOKENS")
  })

  test("without a cost limit, unknown pricing is a warning in the summary, never a silent zero", () => {
    const ledger = new UsageLedger(none)
    expect(ledger.event("session.usage.updated", usage("ses_a", 1000, 100, 0))).toBeUndefined()
    const text = renderUsage(ledger.summary())
    expect(text).toContain("cost: unknown")
    expect(text).toContain("--price")
    expect(text).not.toContain("$0")
  })

  test("a provider that reports no usage is reported as unknown, and gaps make the figures suspect", () => {
    const ledger = new UsageLedger({ ...none, tokens: 10 })
    ledger.noteGap()
    const text = renderUsage(ledger.summary())
    expect(text).toContain("tokens: unknown")
    expect(text).toContain("cannot be enforced")
    expect(text).toContain("may be too low")
  })
})

describe("the guard stops the runtime through its own API", () => {
  const frame = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, data })}\n\n`

  function runtime(events: string[], options: { reconnectAfterEnd?: boolean } = {}) {
    const calls: string[] = []
    let streams = 0
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers["authorization"]).toBe("Basic x")
      if (url.pathname === "/api/event") {
        streams += 1
        const first = streams === 1
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) for (const text of events) controller.enqueue(new TextEncoder().encode(text))
            if (first || options.reconnectAfterEnd !== true) controller.close()
            else init?.signal?.addEventListener("abort", () => controller.close())
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname === "/api/session/active")
        return Response.json({ data: { ses_one: {}, ses_two: {} } })
      return Response.json({ data: { interrupted: true } })
    }) as typeof fetch
    return { fake, calls }
  }

  test("crossing a limit interrupts every active session and latches the reason", async () => {
    const { fake, calls } = runtime([
      frame("session.usage.updated", usage("ses_one", 10, 1)),
      frame("session.usage.updated", usage("ses_one", 20, 2)),
    ])
    const stops: string[] = []
    const guard = new UsageGuard(
      { ...none, requests: 2 },
      { fetch: fake, onStop: (reason) => stops.push(reason), reconnectMs: 5 },
    )
    guard.attach({ url: "http://127.0.0.1:1", authorization: "Basic x", workspace: "/w" })
    for (let i = 0; i < 100 && guard.blocked() === undefined; i++) await Bun.sleep(10)
    await Bun.sleep(30)
    await guard.stop()
    expect(guard.blocked()).toContain("request limit")
    expect(stops).toHaveLength(1)
    expect(calls).toContain("GET /api/session/active")
    expect(calls).toContain("POST /api/session/ses_one/interrupt")
    expect(calls).toContain("POST /api/session/ses_two/interrupt")
  })

  test("a limit that is not crossed interrupts nothing", async () => {
    const { fake, calls } = runtime([frame("session.usage.updated", usage("ses_one", 10, 1))])
    const guard = new UsageGuard({ ...none, requests: 50 }, { fetch: fake, reconnectMs: 5 })
    guard.attach({ url: "http://127.0.0.1:1", authorization: "Basic x", workspace: "/w" })
    await Bun.sleep(80)
    await guard.stop()
    expect(guard.blocked()).toBeUndefined()
    expect(calls.some((call) => call.includes("interrupt"))).toBe(false)
    expect(guard.summary().requests).toBe(1)
  })

  test("a dropped event stream is counted as a gap, and the guard reconnects", async () => {
    const { fake } = runtime([frame("session.usage.updated", usage("ses_one", 10, 1))], {
      reconnectAfterEnd: true,
    })
    const guard = new UsageGuard({ ...none }, { fetch: fake, reconnectMs: 5 })
    guard.attach({ url: "http://127.0.0.1:1", authorization: "Basic x", workspace: "/w" })
    for (let i = 0; i < 100 && guard.summary().gaps === 0; i++) await Bun.sleep(10)
    await guard.stop()
    expect(guard.summary().gaps).toBeGreaterThanOrEqual(1)
    expect(renderUsage(guard.summary())).toContain("may be too low")
  })

  test("frames are understood in both wrapped and flat shapes, and junk is ignored", () => {
    expect(unwrap({ type: "a.b", data: { x: 1 } })).toEqual({ type: "a.b", body: { x: 1 } })
    expect(unwrap({ id: "1", event: "e", data: { type: "a.b", data: { x: 2 } } })).toEqual({
      type: "a.b",
      body: { x: 2 },
    })
    expect(unwrap("nope").type).toBeUndefined()
    expect(unwrap(null).type).toBeUndefined()
  })
})

describe("the admission proxy refuses new model work once a limit is reached", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-guard-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("only the actions that make the runtime call the model are classified as model work", () => {
    for (const suffix of ["prompt", "synthetic", "compact", "skill"])
      expect(startsModelWork("POST", `/api/session/ses_a/${suffix}`)).toBe(true)
    for (const suffix of ["interrupt", "model", "agent", "view"])
      expect(startsModelWork("POST", `/api/session/ses_a/${suffix}`)).toBe(false)
    expect(startsModelWork("GET", "/api/session/ses_a/prompt")).toBe(false)
  })

  test("blocked: a prompt gets 429 with the reason and never reaches the runtime; unblocked: it does", async () => {
    const reached: string[] = []
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        reached.push(`${request.method} ${url.pathname}`)
        if (request.method === "GET")
          return Response.json({ data: { location: { directory: root } } })
        return Response.json({ ok: true })
      },
    })
    let reason: string | undefined = "the request limit was reached (test)"
    const proxy = startAdmission(
      upstream.url.origin,
      "Basic up",
      "Basic client",
      root,
      async () => true,
      () => reason,
    )
    try {
      const prompt = (target: string) =>
        fetch(`${proxy.url.origin}/api/session/ses_a/${target}`, {
          method: "POST",
          headers: { authorization: "Basic client", "content-type": "application/json" },
          body: "{}",
        })
      const refused = await prompt("prompt")
      expect(refused.status).toBe(429)
      expect(((await refused.json()) as { message: string }).message).toContain("request limit")
      expect(reached).toEqual([])
      // Stopping the work in flight must still be possible while new work is blocked.
      expect((await prompt("interrupt")).status).toBe(200)
      reason = undefined
      expect((await prompt("prompt")).status).toBe(200)
      expect(reached).toContain("POST /api/session/ses_a/prompt")
    } finally {
      await proxy.stop(true)
      await upstream.stop(true)
    }
  })
})

describe("prices", () => {
  const models = [{ id: "a" }, { id: "b" }]

  test("a declared price is written for the runtime as dollars per million tokens", () => {
    const [a, b] = applyPrices(models, ["a=3:15"])
    expect(a).toEqual({ id: "a", price: { input: 3, output: 15 } })
    expect(b).toEqual({ id: "b" })
    const provider = toRuntimeProvider({
      id: "p",
      baseURL: "https://example.invalid/v1",
      models: [a!, b!],
    })
    expect(provider.models?.["a"]?.cost).toEqual({ input: 3, output: 15 })
    expect(provider.models?.["b"]?.cost).toBeUndefined()
  })

  test("nothing is guessed: bad, unknown or implausible prices are refused", () => {
    for (const bad of ["a=3", "a=x:y", "c=1:1", "a=-1:2", "a=1:2:3", "a=999999:1", "=1:2"])
      expect(() => applyPrices(models, [bad])).toThrow()
  })
})
