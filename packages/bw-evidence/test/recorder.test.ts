import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEFAULT_MAX_TEXT,
  EVIDENCE_VERSION,
  EvidenceRecorder,
  canonical,
  entryHash,
  normalise,
  onToolAfter,
  onToolBefore,
  redact,
  sha256,
  verify,
  type ToolCallRef,
} from "../src/recorder"

/**
 * Assemble credential-shaped fixtures at runtime rather than writing them literally.
 *
 * Why: a literal classic PAT, AWS key id or PEM header in the tree is byte-indistinguishable
 * from a genuinely committed credential. The CI secret scanner — and GitHub push protection —
 * both refuse to special-case test files, and they are right not to: a scanner with a path
 * allowlist has a blind spot exactly where leaks are most often committed.
 *
 * Building each sample from parts keeps the assertions meaningful (the redactor still receives
 * a fully formed credential) while leaving nothing credential-shaped at rest. CI found this
 * the hard way: the scanner fired on this file, which is the scanner doing its job.
 */
const credential = (...parts: string[]): string => parts.join("")

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bw-evidence-test-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const call: ToolCallRef = {
  id: "call_abc",
  tool: "bash",
  sessionID: "ses_123",
  agent: "build",
  messageID: "msg_456",
}

const fixed = () => new Date("2026-01-02T03:04:05.678Z")

describe("canonical", () => {
  test("sorts object keys so equal payloads hash identically", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
  })

  test("preserves array order", () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]))
  })

  test("drops undefined object members but keeps null", () => {
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}')
  })

  test("is stable for nested structures", () => {
    const value = { z: [{ b: 2, a: 1 }], a: "text" }
    expect(canonical(value)).toBe(canonical(JSON.parse(JSON.stringify(value))))
  })
})

describe("redact", () => {
  test("removes values under secret-looking keys regardless of depth", () => {
    const input = { nested: { apiKey: "sk-live-abc", other: "visible" } }
    expect(redact(input)).toEqual({ nested: { apiKey: "[REDACTED]", other: "visible" } })
  })

  test("matches key names case-insensitively and by suffix", () => {
    const input = { OPENAI_API_KEY: "x", db_password: "y", GITHUB_TOKEN: "z", safe: "keep" }
    expect(redact(input)).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      db_password: "[REDACTED]",
      GITHUB_TOKEN: "[REDACTED]",
      safe: "keep",
    })
  })

  test("scrubs credential-shaped values under innocent keys", () => {
    const text = "export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwx"
    const out = redact({ content: text }) as { content: string }
    expect(out.content).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx")
    expect(out.content).toContain("[REDACTED]")
  })

  test("scrubs github, aws, slack and bearer tokens", () => {
    const samples = [
      credential("ghp_", "0".repeat(36)),
      credential("github_pat_", "A".repeat(11), "_", "B".repeat(30)),
      credential("AKIA", "IOSFODNN7EXAMPLE"),
      credential("xoxb-", "0".repeat(12), "-", "c".repeat(12)),
      credential("Authorization: Bearer ", "abcdef", "0".repeat(20), "2345"),
    ]
    // Every sample must actually be caught; a sample that never matched the redactor
    // would make this test pass vacuously.
    expect(samples.length).toBe(5)
    for (const sample of samples) {
      const out = redact({ blob: sample }) as { blob: string }
      expect(out.blob).not.toContain(sample)
      expect(out.blob).toContain("[REDACTED]")
    }
  })

  test("scrubs PEM private key blocks", () => {
    const pem = credential(
      "-----BEGIN RSA ",
      "PRIVATE KEY-----\n",
      "MIIEowIBAAKCAQEA0000000000000000000000000000000000\n",
      "-----END RSA ",
      "PRIVATE KEY-----",
    )
    const out = redact({ file: pem }) as { file: string }
    expect(out.file).not.toContain("MIIEow")
    expect(out.file).toContain("[REDACTED]")
  })

  test("preserves non-secret structure and scalars", () => {
    const input = { count: 3, ok: true, nothing: null, list: ["a", "b"] }
    expect(redact(input)).toEqual(input)
  })

  test("bounds recursion depth instead of overflowing", () => {
    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 40; i++) deep = { next: deep }
    const out = JSON.stringify(redact(deep))
    expect(out).toContain("DEPTH_LIMIT")
  })
})

describe("normalise", () => {
  test("keeps short payloads whole and records their digest", () => {
    const out = normalise({ a: 1 }, 1000)
    expect(out.truncated).toBe(false)
    expect(out.fullDigest).toBe(sha256('{"a":1}'))
    expect(out.value).toEqual({ a: 1 })
  })

  test("truncates long strings but hashes the full original", () => {
    const text = "x".repeat(500)
    const out = normalise(text, 100)
    expect(out.truncated).toBe(true)
    expect(String(out.value).length).toBeLessThanOrEqual(101)
    // Digest must correspond to the untruncated value, so truncation is detectable.
    expect(out.fullDigest).toBe(sha256(text))
    expect(out.fullDigest).not.toBe(sha256(String(out.value)))
  })

  test("hashes the redacted form so secrets never reach the digest input", () => {
    const out = normalise({ apiKey: "sk-secret-value" }, 100)
    expect(JSON.stringify(out.value)).not.toContain("sk-secret-value")
    expect(out.fullDigest).toBe(sha256(canonical({ apiKey: "[REDACTED]" })))
  })
})

describe("EvidenceRecorder", () => {
  test("writes one JSONL line per entry starting from genesis", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const entry = recorder.recordTool("before", call, { input: { command: "ls" } })

    expect(entry.seq).toBe(1)
    expect(entry.v).toBe(EVIDENCE_VERSION)
    expect(entry.prevHash).toBe("0".repeat(64))
    expect(entry.at).toBe("2026-01-02T03:04:05.678Z")

    const lines = readFileSync(path.join(dir, "evidence.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(entry)
  })

  test("chains hashes so each entry commits to its predecessor", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const first = recorder.recordTool("before", call, { input: { command: "ls" } })
    const second = recorder.recordTool(
      "after",
      { ...call, id: "call_def" },
      { status: "completed", output: "ok" },
    )

    expect(second.prevHash).toBe(first.hash)
    expect(second.hash).not.toBe(first.hash)
    expect(recorder.head).toBe(second.hash)
    expect(recorder.length).toBe(2)
  })

  test("resumes an existing chain after restart instead of forking it", () => {
    const first = new EvidenceRecorder({ directory: dir, now: fixed })
    const written = first.recordTool("before", call, { input: {} })

    const restarted = new EvidenceRecorder({ directory: dir, now: fixed })
    expect(restarted.length).toBe(1)
    expect(restarted.head).toBe(written.hash)

    const next = restarted.recordTool("after", call, { status: "completed" })
    expect(next.seq).toBe(2)
    expect(next.prevHash).toBe(written.hash)
    expect(verify(path.join(dir, "evidence.jsonl")).ok).toBe(true)
  })

  test("records an error result as evidence without throwing", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const entry = recorder.recordTool("after", call, { status: "error", output: "command failed" })
    expect(entry.payload.status).toBe("error")
    expect(entry.payload.output).toBe("command failed")
  })

  test("captures exit codes when supplied", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const entry = recorder.recordTool("after", call, { status: "completed", output: "ok", exit: 0 })
    expect(entry.payload.exit).toBe(0)
  })

  test("lifts the exit code out of a shell tool's structured output", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    // Shape produced by OpenCode's shell tool at v2.3.2.
    const entry = onToolAfter(recorder, {
      ...call,
      status: "completed",
      output: { exitCode: 1, output: "boom", wallTimeSeconds: 0.01 },
    })
    expect(entry.payload.exit).toBe(1)
  })

  test("never writes a secret to disk", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, {
      input: {
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'",
        apiKey: "sk-live",
      },
    })
    const raw = readFileSync(path.join(dir, "evidence.jsonl"), "utf8")
    expect(raw).not.toContain("sk-live")
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(raw).toContain("[REDACTED]")
  })

  test("honours a custom file name and creates nested directories", () => {
    const nested = path.join(dir, "a", "b")
    const recorder = new EvidenceRecorder({ directory: nested, file: "run.jsonl", now: fixed })
    recorder.recordTool("before", call, { input: {} })
    expect(verify(path.join(nested, "run.jsonl")).ok).toBe(true)
  })

  test("accepts an explicit maxText and flags truncation", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed, maxText: 10 })
    const entry = recorder.recordTool("before", call, { input: "y".repeat(100) })
    expect(entry.payload.truncated).toBe(true)
    expect(String(entry.payload.input).length).toBeLessThanOrEqual(11)
  })
})

describe("verify", () => {
  test("reports an empty or missing log as valid", () => {
    expect(verify(path.join(dir, "nope.jsonl"))).toMatchObject({
      ok: true,
      entries: 0,
      head: "0".repeat(64),
    })
  })

  test("accepts an intact chain and reports its head", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: {} })
    const last = recorder.recordTool("after", call, { status: "completed" })
    const result = verify(path.join(dir, "evidence.jsonl"))
    expect(result).toMatchObject({ ok: true, entries: 2, head: last.hash })
    if (!result.ok) return
    expect(result.limitations.length).toBeGreaterThan(0)
  })

  test("detects an edited entry", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: { command: "ls" } })
    recorder.recordTool("after", call, { status: "completed" })

    const file = path.join(dir, "evidence.jsonl")
    const lines = readFileSync(file, "utf8").trim().split("\n")
    const tampered = JSON.parse(lines[0]!) as Record<string, any>
    tampered.payload.input = { command: "rm -rf /" }
    lines[0] = JSON.stringify(tampered)
    writeFileSync(file, `${lines.join("\n")}\n`)

    const result = verify(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("hash mismatch")
  })

  test("detects a deleted middle entry", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: {} })
    recorder.recordTool("after", call, { status: "completed" })
    recorder.recordTool("before", { ...call, id: "call_2" }, { input: {} })

    const file = path.join(dir, "evidence.jsonl")
    const lines = readFileSync(file, "utf8").trim().split("\n")
    writeFileSync(file, `${lines[0]}\n${lines[2]}\n`)

    const result = verify(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("expected seq 2")
  })

  test("detects a truncated tail and malformed JSON", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: {} })
    const file = path.join(dir, "evidence.jsonl")
    appendFileSync(file, '{"v":1,"seq":2,"brok')

    const result = verify(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("not valid JSON")
  })

  test("rejects an unsupported record version", () => {
    const file = path.join(dir, "evidence.jsonl")
    const body = {
      v: 99,
      seq: 1,
      at: fixed().toISOString(),
      phase: "before",
      call,
      payload: {},
      prevHash: "0".repeat(64),
    }
    writeFileSync(file, `${JSON.stringify({ ...body, hash: entryHash(body as any) })}\n`)
    const result = verify(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("unsupported version")
  })
})

describe("hook ordering constraint (spike finding, OpenCode v2.3.2)", () => {
  // `packages/core/src/plugin/hooks.ts` -> `trigger` iterates callbacks and does
  // `yield* result` for each. A callback that throws (how `execute.before` denies a
  // call) aborts the loop, so every hook registered *after* it never runs.
  //
  // Consequence for Bashwink: the evidence recorder must register before any policy
  // plugin, or a denied call leaves no `before` record and the evidence log goes blind
  // exactly when something was refused. These tests encode the recorder's half of that
  // contract: ordering is the caller's job, but the recorder must be correct once it runs.
  test("records the denied call's input when it runs before the denying policy", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const hooks: Array<(event: unknown) => void> = []

    // Simulates `trigger`: run every callback, stopping at the first throw.
    const trigger = (event: unknown) => {
      for (const hook of hooks) hook(event)
    }

    hooks.push((event) => {
      onToolBefore(recorder, event as never)
    })
    hooks.push(() => {
      throw new Error("Bashwink policy: denied")
    })

    const event = { ...call, input: { command: "rm -rf /" } }
    expect(() => trigger(event)).toThrow("denied")

    // The evidence was written before the abort — this is the behaviour Bashwink needs.
    expect(recorder.length).toBe(1)
    expect(verify(path.join(dir, "evidence.jsonl")).ok).toBe(true)
  })

  test("loses the record when a denying policy runs first — why ordering matters", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const hooks: Array<(event: unknown) => void> = [
      () => {
        throw new Error("Bashwink policy: denied")
      },
      (event) => {
        onToolBefore(recorder, event as never)
      },
    ]

    expect(() => {
      for (const hook of hooks) hook({ ...call, input: {} })
    }).toThrow("denied")

    // Nothing recorded. This is a silent evidence gap, so registration order is a
    // security property, not a style preference.
    expect(recorder.length).toBe(0)
  })
})

describe("regressions — independent Phase 0 review F-02: object/array payloads must be bounded", () => {
  // Reproduced against the Phase 0 recorder: `normalise({nested:{message:'x'.repeat(10000)}},100)`
  // returned a 10,025-character payload with `truncated: true`. The cap only applied to
  // strings. Each test below failed before the fix.

  const cap = (n: { value: unknown }) => {
    // A truncated structured payload is stored as a JSON string; a truncated string is
    // stored as a string. Both are measured after the same serialisation a reader sees.
    const serialised = typeof n.value === "string" ? n.value : JSON.stringify(n.value)
    return Buffer.byteLength(serialised, "utf8")
  }

  test("bounds a large nested object to the byte cap", () => {
    const n = normalise({ nested: { message: "x".repeat(10_000) } }, 100)
    expect(n.truncated).toBe(true)
    expect(cap(n)).toBeLessThanOrEqual(100)
  })

  test("bounds a large array to the byte cap", () => {
    const n = normalise(
      Array.from({ length: 2_000 }, (_, i) => ({ i, s: "y".repeat(50) })),
      100,
    )
    expect(n.truncated).toBe(true)
    expect(cap(n)).toBeLessThanOrEqual(100)
  })

  test("bounds multibyte text by UTF-8 bytes, not UTF-16 code units", () => {
    // 5,000 euro signs = 15,000 UTF-8 bytes but only 5,000 JS characters.
    const n = normalise({ t: "€".repeat(5_000) }, 100)
    expect(n.truncated).toBe(true)
    expect(cap(n)).toBeLessThanOrEqual(100)
  })

  test("does not split a surrogate pair when truncating", () => {
    const n = normalise({ t: "😀".repeat(2_000) }, 100)
    const text = String(n.value)
    // A lone surrogate would make the string invalid UTF-8 after a round trip.
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  test("hashes the full untruncated value even when truncating", () => {
    const big = { nested: { message: "x".repeat(10_000) } }
    const n = normalise(big, 100)
    // Digest must cover the whole redacted payload, so a reader can prove what it was.
    expect(n.fullDigest).toBe(sha256(canonical(redact(big))))
  })

  test("leaves a payload under the cap untouched and unflagged", () => {
    const n = normalise({ command: "ls -la" }, 100)
    expect(n.truncated).toBe(false)
    expect(n.value).toEqual({ command: "ls -la" })
  })
})

describe("regressions — independent Phase 0 review F-03: every field must be redacted", () => {
  const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz0123456789"
  const RAW = "abcdefghijklmnopqrstuvwxyz0123456789"

  test("redacts a token written through the note field", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("after", call, { note: `denied; header was ${BEARER}` })
    const raw = readFileSync(path.join(dir, "evidence.jsonl"), "utf8")
    expect(raw).not.toContain(RAW)
    expect(raw).toContain("[REDACTED]")
  })

  test("redacts a token written through the raw record() entrypoint", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.record("before", call, { output: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" })
    const raw = readFileSync(path.join(dir, "evidence.jsonl"), "utf8")
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
  })

  test("redacts a token in call metadata", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    // Call metadata is caller-controlled: a token can arrive in `agent` or `messageID`.
    // Note a bare random string is NOT a credential and is correctly left alone; only a
    // credential-shaped value is redacted, which is why the value-shape pass matters here.
    recorder.recordTool("before", { ...call, agent: `agent ${BEARER}` }, { input: {} })
    const raw = readFileSync(path.join(dir, "evidence.jsonl"), "utf8")
    expect(raw).not.toContain(RAW)
    expect(raw).toContain("[REDACTED]")
  })

  test("redacts a token in an error output", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const token = credential("ghp_", "a".repeat(36))
    recorder.recordTool("after", call, { status: "error", output: `failed: ${token}` })
    const raw = readFileSync(path.join(dir, "evidence.jsonl"), "utf8")
    expect(raw).not.toContain(token)
    expect(raw).toContain("[REDACTED]")
  })

  test("bounds an oversized note instead of storing it whole", () => {
    const recorder = new EvidenceRecorder({ directory: dir, maxText: 100, now: fixed })
    const entry = recorder.recordTool("after", call, { note: "n".repeat(5_000) })
    expect(Buffer.byteLength(String(entry.payload.note), "utf8")).toBeLessThanOrEqual(100)
    expect(entry.payload.truncated).toBe(true)
  })
})

describe("regressions — independent Phase 0 review F-08: degradation must be visible", () => {
  test("refuses to extend a tampered log and reports degraded health", () => {
    const first = new EvidenceRecorder({ directory: dir, now: fixed })
    first.recordTool("before", call, { input: { command: "ls" } })
    first.recordTool("after", call, { status: "completed" })

    // Corrupt an existing entry in place.
    const file = path.join(dir, "evidence.jsonl")
    const lines = readFileSync(file, "utf8").trim().split("\n")
    const tampered = JSON.parse(lines[0]!)
    tampered.payload.input = { command: "rm -rf /" }
    writeFileSync(file, [JSON.stringify(tampered), lines[1]].join("\n") + "\n")

    const restarted = new EvidenceRecorder({ directory: dir, now: fixed })
    expect(restarted.health.ok).toBe(false)
    expect(restarted.health.degraded).toContain("failed verification")
    expect(restarted.length).toBe(0)
  })

  test("reports healthy when resuming an intact chain", () => {
    const first = new EvidenceRecorder({ directory: dir, now: fixed })
    first.recordTool("before", call, { input: {} })
    const restarted = new EvidenceRecorder({ directory: dir, now: fixed })
    expect(restarted.health.ok).toBe(true)
    expect(restarted.health.writeFailures).toBe(0)
  })

  test("surfaces what a valid chain does NOT prove", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: {} })
    const result = verify(path.join(dir, "evidence.jsonl"))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Tail truncation and recomputation must be stated, not hidden.
    expect(result.limitations.join(" ")).toContain("tail truncation")
    expect(result.limitations.join(" ")).toContain("not signed")
  })

  test("a wholly deleted tail still verifies — the documented limitation", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", call, { input: {} })
    recorder.recordTool("after", call, { status: "completed" })
    const file = path.join(dir, "evidence.jsonl")
    const lines = readFileSync(file, "utf8").trim().split("\n")
    // Drop the last entry entirely. This is the attack a hash chain cannot detect, and the
    // test exists so the limitation stays known rather than assumed away.
    writeFileSync(file, lines[0] + "\n")
    expect(verify(file).ok).toBe(true)
  })
})

describe("defaults", () => {
  test("exposes a 2000-character payload cap", () => {
    expect(DEFAULT_MAX_TEXT).toBe(2_000)
  })
})

describe("boot records: proving the plugin initialised", () => {
  test("writes a boot entry keyed by the wrapper's run id", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const entry = recorder.recordBoot({
      plugin: "bashwink-evidence",
      pid: 4242,
      cwd: "/work/project",
      runID: "run_abc",
      location: "/work/project",
    })

    expect(entry.phase).toBe("boot")
    expect(entry.call.id).toBe("boot_run_abc")
    expect(entry.payload.note).toContain("run=run_abc")
    expect(entry.payload.note).toContain("pid=4242")
  })

  test("a chain with a boot entry and a tool call still verifies", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordBoot({ plugin: "bashwink-evidence", pid: 1, cwd: "/", runID: "run_1" })
    recorder.recordTool("before", call, { input: { command: "ls" } })
    recorder.recordTool("after", call, { status: "completed", exit: 0 })

    const file = path.join(dir, "evidence.jsonl")
    const result = verify(file)
    expect(result.ok).toBe(true)
    expect(result.entries).toBe(3)
  })

  test("falls back to a pid-keyed id when no run id is supplied", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    const entry = recorder.recordBoot({ plugin: "bashwink-evidence", pid: 7, cwd: "/" })
    expect(entry.call.id).toBe("boot_pid_7")
  })
})

describe("literal secret redaction", () => {
  test("a registered provider key is masked wherever it appears, whatever shape it has", async () => {
    const { registerSecretValues, clearSecretValues, redact } = await import("../src/recorder.js")
    try {
      registerSecretValues(["synthetic-canary-not-a-secret", "short"])
      const masked = redact({
        output: "key=synthetic-canary-not-a-secret and again synthetic-canary-not-a-secret",
        nested: ["x synthetic-canary-not-a-secret"],
      }) as { output: string; nested: string[] }
      expect(JSON.stringify(masked)).not.toContain("synthetic-canary")
      // Values shorter than 8 characters are never registered: masking them would wreck the log.
      expect(redact("a short value")).toBe("a short value")
    } finally {
      clearSecretValues()
    }
    expect(redact("synthetic-canary-not-a-secret")).toBe("synthetic-canary-not-a-secret")
  })
})

describe("EX-27: shared evidence ledger serialization across instances and processes", () => {
  test("two independent EvidenceRecorder instances sharing one file produce a valid contiguous chain", () => {
    const r1 = new EvidenceRecorder({ directory: dir, now: fixed })
    const r2 = new EvidenceRecorder({ directory: dir, now: fixed })

    const e1 = r1.recordTool("before", { ...call, id: "c1" }, { input: { cmd: "a" } })
    const e2 = r2.recordTool("before", { ...call, id: "c2" }, { input: { cmd: "b" } })
    const e3 = r1.recordTool("after", { ...call, id: "c1" }, { status: "completed", exit: 0 })
    const e4 = r2.recordTool("after", { ...call, id: "c2" }, { status: "completed", exit: 0 })

    expect([e1.seq, e2.seq, e3.seq, e4.seq]).toEqual([1, 2, 3, 4])
    expect(e2.prevHash).toBe(e1.hash)
    expect(e3.prevHash).toBe(e2.hash)
    expect(e4.prevHash).toBe(e3.hash)

    const verified = verify(path.join(dir, "evidence.jsonl"))
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.entries).toBe(4)
  })

  test("two concurrent processes writing to the same evidence file do not collide or break the chain", async () => {
    const { spawn } = await import("node:child_process")
    const recorderPath = path.resolve(import.meta.dir, "../src/recorder.ts")
    const script = [
      `import { EvidenceRecorder } from ${JSON.stringify(recorderPath)};`,
      `const dir = process.argv[1];`,
      `const tag = process.argv[2];`,
      `const rec = new EvidenceRecorder({ directory: dir });`,
      `for (let i = 0; i < 15; i += 1) {`,
      `  rec.recordTool("before", { id: tag + "_" + i, tool: "run_command", sessionID: "s_" + tag }, { input: { i } });`,
      `}`,
    ].join("\n")

    const runWorker = (tag: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script, dir, tag], { stdio: "pipe" })
        let stderr = ""
        child.stderr?.on("data", (d) => (stderr += String(d)))
        child.on("error", reject)
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`worker ${tag} exited ${code}: ${stderr}`))
          else resolve(code)
        })
      })

    await Promise.all([runWorker("p1"), runWorker("p2")])
    const verified = verify(path.join(dir, "evidence.jsonl"))
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.entries).toBe(30)
  })
})

describe("Issue #102: full-prefix digest verification detects same-size and in-place tampering", () => {
  test("refuses subsequent append when an existing line was modified in place with identical byte length", () => {
    const recorder = new EvidenceRecorder({ directory: dir, now: fixed })
    recorder.recordTool("before", { ...call, id: "c1" }, { input: { cmd: "echo alpha" } })
    recorder.recordTool("after", { ...call, id: "c1" }, { status: "completed", exit: 0 })

    const file = path.join(dir, "evidence.jsonl")
    const original = readFileSync(file, "utf8")
    const tampered = original.replace("echo alpha", "echo omega")
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original))
    writeFileSync(file, tampered, "utf8")

    expect(() =>
      recorder.recordTool("before", { ...call, id: "c2" }, { input: { cmd: "pwd" } }),
    ).toThrow(/hash mismatch|tamper|chain/i)
  })

  test("a fresh resumed recorder marks degraded and refuses to append after same-size prefix tampering", () => {
    const r1 = new EvidenceRecorder({ directory: dir, now: fixed })
    r1.recordTool("before", { ...call, id: "c1" }, { input: { cmd: "echo 1111" } })
    r1.recordTool("after", { ...call, id: "c1" }, { status: "completed", exit: 0 })

    const file = path.join(dir, "evidence.jsonl")
    const original = readFileSync(file, "utf8")
    const tampered = original.replace("echo 1111", "echo 2222")
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original))
    writeFileSync(file, tampered, "utf8")

    const r2 = new EvidenceRecorder({ directory: dir, now: fixed })
    expect(r2.health.ok).toBe(false)
    expect(r2.health.degraded).toMatch(/hash mismatch|tamper/i)
    expect(() => r2.recordTool("before", { ...call, id: "c2" }, { input: { cmd: "pwd" } })).toThrow(
      /refusing|hash mismatch/i,
    )
    expect(readFileSync(file, "utf8")).toBe(tampered)
  })
})
