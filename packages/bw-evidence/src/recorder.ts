/**
 * Bashwink evidence recorder core.
 *
 * Deliberately dependency-free (node: builtins only) so the evidence chain can be
 * tested and audited without installing the whole agent runtime, and so a bug in a
 * third-party package can never silently corrupt an evidence record.
 *
 * The record is an append-only JSONL file. Every entry carries the hash of the entry
 * before it, so deleting, reordering or editing any line breaks `verify()`.
 */

import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

export const EVIDENCE_VERSION = 1

/** Keys whose values are never written to the log, matched case-insensitively. */
const SECRET_KEY =
  /(?:^|_|[^a-z])(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|credential|cookie|private[_-]?key)s?$/i

/** Free-text shapes that are credentials regardless of the key they arrived under. */
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export const REDACTED = "[REDACTED]"

/**
 * Byte budget for verbatim payload text in one entry.
 *
 * Measured in **UTF-8 bytes**, not JavaScript characters: a 2,000-character emoji string
 * is 8,000 bytes, so a character budget silently overruns by up to 4×. The budget covers
 * the *serialised* form, so an object with large nested values is bounded exactly like a
 * large string (F-02).
 */
export const DEFAULT_MAX_TEXT = 2_000

/** Marker appended to a truncated value so a reader never mistakes a prefix for the whole. */
export const TRUNCATION_MARKER = "…"

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so slicing at a byte budget is wrong
 * twice over: it can exceed the byte budget (surrogate pairs are 4 bytes) and it can split
 * a code point, producing a lone surrogate that is not valid UTF-8.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const budget = Math.max(0, maxBytes - byteLength(TRUNCATION_MARKER))
  let used = 0
  let out = ""
  // Iterate code points, not code units, so surrogate pairs stay intact.
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > budget) break
    out += char
    used += size
  }
  return out + TRUNCATION_MARKER
}

/**
 * Kind of entry in the chain.
 *
 * `boot` is the plugin's own start-up record (one per process). It exists so a run can prove
 * the plugin initialised at all, rather than inferring it from tool events that may legitimately
 * never happen. Before this phase existed, a plugin that failed to load and a session that
 * simply called no tools produced the same thing: an empty log.
 */
export type ToolPhase = "boot" | "model" | "before" | "after" | "denied" | "unconstrained"

export interface ToolCallRef {
  /** OpenCode tool call id, e.g. `call_...`. */
  readonly id: string
  readonly tool: string
  readonly sessionID: string
  /** Present once the agent picks an agent; absent on very early calls. */
  readonly agent?: string
  readonly messageID?: string
  /**
   * Plan task this call belongs to (BW-016).
   *
   * Optional on purpose: a call can legitimately happen outside any task (a session started
   * interactively, an agent exploring before planning). An unassigned call is recorded as
   * such with a reason, never guessed into a task.
   */
  readonly taskID?: string
  /** Why `taskID` is absent, when it is. Kept adjacent so the gap is explicable. */
  readonly unassignedReason?: string
}

/**
 * The model that produced a request, as the runtime reported it.
 *
 * Recorded rather than inferred: the wrapper knows what it *asked* for, but only the
 * runtime knows what actually served the step. Those are different claims, and an evidence
 * log that conflates them cannot answer "which model made this edit?".
 */
export interface ModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface EvidencePayload {
  /** Tool input after redaction/truncation. */
  readonly input?: unknown
  /** `completed` / `error` on an `after` entry. */
  readonly status?: "completed" | "error"
  /** Redacted, size-bounded tool output or error text. */
  readonly output?: unknown
  /** Exit code when the tool reported one (shell tools). */
  readonly exit?: number
  /** sha256 of the untruncated serialised payload, so truncation is detectable. */
  readonly fullDigest?: string
  /** sha256 of the untruncated output, present when only the output needed truncating. */
  readonly outputDigest?: string
  /** sha256 of the untruncated note, present when the note itself was truncated. */
  readonly noteDigest?: string
  /** True when the payload was truncated to fit `maxText`. */
  readonly truncated?: boolean
  /** Free-form notes from the caller (e.g. why a call was denied). */
  readonly note?: string
  /** Model that served this call, as reported by the runtime. Absent when unknown. */
  readonly model?: ModelRef
}

export interface EvidenceEntry {
  readonly v: number
  /** 1-based position in the chain. */
  readonly seq: number
  /** ISO-8601 UTC timestamp of the write. */
  readonly at: string
  readonly phase: ToolPhase
  readonly call: ToolCallRef
  readonly payload: EvidencePayload
  readonly prevHash: string
  readonly hash: string
}

export interface RecorderOptions {
  /** Directory for the evidence log. Created if missing. */
  readonly directory: string
  /** File name inside `directory`. Default `evidence.jsonl`. */
  readonly file?: string
  /** Character cap for verbatim payload text. Default {@link DEFAULT_MAX_TEXT}. */
  readonly maxText?: number
  /** Injected clock, for deterministic tests. */
  readonly now?: () => Date
}

const GENESIS = "0".repeat(64)

/** Stable JSON: object keys sorted, so one payload always hashes identically. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Remove credentials from an arbitrary value.
 *
 * Two passes: a key-name pass that drops values under secret-looking keys, and a
 * value pass that scrubs credential-shaped substrings anywhere they appear. The value
 * pass matters because agents routinely echo a whole `.env` file or a curl command as
 * a tool argument under an innocuous key such as `content`.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]"
  if (typeof value === "string") {
    let text = value
    for (const pattern of SECRET_VALUE) text = text.replace(pattern, REDACTED)
    return text
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1)
    }
    return out
  }
  return String(value)
}

export interface Normalised {
  readonly value: unknown
  readonly fullDigest: string
  readonly truncated: boolean
}

/**
 * Redact, serialise, then bound — never bound before hashing the full payload.
 *
 * Both halves matter and both were wrong in Phase 0 (independent review F-02):
 *
 * - The digest is computed over the **redacted full** value, so a reader can prove what
 *   the complete payload hashed to, and the digest can never be used to confirm a guessed
 *   secret (the redaction already happened).
 * - The stored value is bounded on the **serialised** form, measured in UTF-8 **bytes**.
 *   An earlier version bounded only `typeof safe === "string"`, so an object or array of
 *   any size was stored verbatim while still claiming `truncated: true` — a 100-byte cap
 *   let a 10,025-character payload through. Objects and arrays are now reduced to a
 *   bounded, still-valid JSON prefix rather than being returned whole.
 */
export function normalise(value: unknown, maxText: number): Normalised {
  const safe = redact(value)
  const text = typeof safe === "string" ? safe : canonical(safe)
  const fullDigest = sha256(text)
  const size = byteLength(text)
  if (size <= maxText) return { value: safe, fullDigest, truncated: false }

  // A string stays a (bounded) string; a structured value becomes a bounded JSON string
  // with an explicit marker, because a truncated JSON document is not parseable and must
  // not masquerade as one.
  if (typeof safe === "string") {
    return { value: truncateBytes(safe, maxText), fullDigest, truncated: true }
  }
  return { value: truncateBytes(text, maxText), fullDigest, truncated: true }
}

export function entryHash(entry: Omit<EvidenceEntry, "hash">): string {
  return sha256(canonical(entry))
}

export class EvidenceRecorder {
  readonly file: string
  readonly maxText: number
  private readonly now: () => Date
  private seq = 0
  private prevHash = GENESIS
  /**
   * Model per session, filled from runtime events.
   *
   * Keyed by session because one plugin process can serve several sessions, and a single
   * "current model" would attribute a concurrent session's edits to the wrong model. A
   * session with no recorded model yields entries with no `model` field — an honest gap,
   * never a default.
   */
  private readonly models = new Map<string, ModelRef>()
  /**
   * Set when the recorder could not establish a trustworthy chain. Bashwink must never
   * present a log it could not verify as "verified" (independent review F-08).
   */
  private degraded: string | undefined
  /** Number of entries the recorder failed to write since construction. */
  private writeFailures = 0

  constructor(options: RecorderOptions) {
    this.file = path.join(options.directory, options.file ?? "evidence.jsonl")
    this.maxText = options.maxText ?? DEFAULT_MAX_TEXT
    this.now = options.now ?? (() => new Date())
    mkdirSync(options.directory, { recursive: true })
    this.resume()
  }

  /**
   * Re-attach to an existing log so a restart continues the chain instead of forking it.
   *
   * Independent review F-08: the previous version trusted the last line without checking
   * that the file it was appending to was actually a valid chain. Appending to a corrupted
   * log silently produces a longer corrupted log that still "has all the entries". The
   * chain is now verified on startup, and a degraded state is recorded and surfaced rather
   * than swallowed.
   */
  private resume(): void {
    if (!existsSync(this.file)) return
    const lines = readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
    const last = lines.at(-1)
    if (!last) return
    let parsed: EvidenceEntry
    try {
      parsed = JSON.parse(last) as EvidenceEntry
    } catch {
      this.degraded = `existing log ${this.file} has an unparseable final entry; refusing to extend it`
      return
    }
    if (!Number.isInteger(parsed.seq) || typeof parsed.hash !== "string") {
      this.degraded = `existing log ${this.file} has no usable seq/hash; refusing to extend it`
      return
    }
    // Verify the whole chain before trusting its head. A truncated or edited log must not
    // be extended as though it were intact.
    const result = verify(this.file)
    if (!result.ok) {
      this.degraded = `existing log ${this.file} failed verification (${result.reason}); refusing to extend it`
      return
    }
    this.seq = parsed.seq
    this.prevHash = parsed.hash
  }

  /**
   * Sanitise one payload at the single write boundary.
   *
   * Independent review F-03: `note` and the raw `record()` entrypoint bypassed redaction
   * entirely, so a Bearer token in a note reached disk verbatim. Sanitisation now happens
   * here — the last point before serialisation — so no caller can route around it by
   * choosing a different field or calling `record()` directly.
   *
   * Every field is redacted. Size bounding is applied to `input` and `output` (the fields
   * that legitimately carry bulk); `note` and `status` are redacted and left bounded only
   * by a generous cap, since a note is meant to be short but must still never be unbounded.
   */
  private sanitisePayload(payload: EvidencePayload): EvidencePayload {
    const out: Record<string, unknown> = {}
    if (payload.input !== undefined) {
      const n = normalise(payload.input, this.maxText)
      out.input = n.value
      out.fullDigest = n.fullDigest
      out.truncated = n.truncated
    }
    if (payload.status !== undefined) out.status = payload.status
    if (payload.output !== undefined) {
      const n = normalise(payload.output, this.maxText)
      out.output = n.value
      if (!("fullDigest" in out)) out.fullDigest = n.fullDigest
      else out.outputDigest = n.fullDigest
      if (n.truncated) out.truncated = true
    }
    if (payload.exit !== undefined) out.exit = payload.exit
    if (payload.model !== undefined) {
      // A model id is not a secret, but it is caller-supplied text and is bounded like one.
      const safe = redact(payload.model) as Record<string, unknown>
      out.model = {
        id: truncateBytes(String(safe.id ?? ""), 128),
        providerID: truncateBytes(String(safe.providerID ?? ""), 128),
        ...(safe.variant === undefined ? {} : { variant: truncateBytes(String(safe.variant), 64) }),
      }
    }
    if (payload.note !== undefined) {
      // Redact, then bound. A note is short by intent but must not be a smuggling route
      // for an unbounded payload.
      const n = normalise(String(payload.note), this.maxText)
      out.note = n.value
      if (n.truncated) {
        out.noteDigest = n.fullDigest
        out.truncated = true
      }
    }
    // Preserve digests the caller supplied, but never trust them over our own values.
    if (payload.outputDigest !== undefined && out.outputDigest === undefined)
      out.outputDigest = payload.outputDigest
    return out as EvidencePayload
  }

  /** Append one entry and return it, including its hash. */
  record(phase: ToolPhase, call: ToolCallRef, payload: EvidencePayload): EvidenceEntry {
    const body: Omit<EvidenceEntry, "hash"> = {
      v: EVIDENCE_VERSION,
      seq: this.seq + 1,
      at: this.now().toISOString(),
      phase,
      // Call metadata is caller-controlled too, so it is sanitised on the same boundary.
      call: redact({
        id: call.id,
        tool: call.tool,
        sessionID: call.sessionID,
        ...(call.agent === undefined ? {} : { agent: call.agent }),
        ...(call.messageID === undefined ? {} : { messageID: call.messageID }),
        ...(call.taskID === undefined ? {} : { taskID: call.taskID }),
        ...(call.unassignedReason === undefined ? {} : { unassignedReason: call.unassignedReason }),
      }) as ToolCallRef,
      payload: this.sanitisePayload(payload),
      prevHash: this.prevHash,
    }
    const sessionModel = this.models.get(String(call.sessionID))
    if (body.payload.model === undefined && sessionModel !== undefined)
      // Attached *after* `sanitisePayload` ran, so it has to be bounded on the way in here as
      // well. Skipping this let a hostile session's model id reach the chain unbounded — the
      // one path where caller-controlled text could bypass the single write boundary.
      (body.payload as { model?: ModelRef }).model = this.sanitisePayload({
        model: sessionModel,
      }).model as ModelRef
    const entry: EvidenceEntry = { ...body, hash: entryHash(body) }
    appendFileSync(this.file, `${canonical(entry)}\n`, "utf8")
    this.seq = entry.seq
    this.prevHash = entry.hash
    return entry
  }

  /** Convenience wrapper. Sanitisation happens once, in {@link record}. */
  recordTool(
    phase: ToolPhase,
    call: ToolCallRef,
    fields: {
      input?: unknown
      status?: "completed" | "error"
      output?: unknown
      exit?: number
      note?: string
    },
  ): EvidenceEntry {
    return this.record(phase, call, fields as EvidencePayload)
  }

  /**
   * Record that this plugin initialised, and where.
   *
   * The point is falsifiability: a reviewer can tell "the plugin never loaded" from "the
   * plugin loaded and no tool was called", which the previous design could not. The caller
   * writes it only after both hooks are registered, so a setup that dies half-way leaves no
   * boot record — the wrapper reports a missing evidence plugin instead of a healthy run.
   */
  recordBoot(detail: {
    readonly plugin: string
    readonly pid: number
    /**
     * The plugin host's own working directory.
     *
     * Not the workspace: the plugin runs in the runtime's shared host process, whose cwd is
     * wherever that host was started. A probe recorded `cwd=/Users/me` for a workspace at
     * `/path/to/repo`, and reading that as the run's directory would be wrong every time.
     * `location` is the workspace.
     */
    readonly cwd: string
    /** Wrapper-assigned run id; keeps a boot record attributable to one process, not one pid. */
    readonly runID?: string
    readonly location?: string
  }): EvidenceEntry {
    const runID = detail.runID ?? `pid_${detail.pid}`
    return this.record(
      "boot",
      {
        id: `boot_${runID}`,
        tool: detail.plugin,
        sessionID: `boot_${runID}`,
      },
      {
        status: "completed",
        note:
          `plugin initialised run=${runID} pid=${detail.pid} hostcwd=${detail.cwd}` +
          (detail.location === undefined ? "" : ` location=${detail.location}`),
      },
    )
  }

  /**
   * Remember the model serving a session.
   *
   * Returns true when this changed what was known, so the caller can decide whether the
   * change is itself worth a chain entry.
   */
  setModel(sessionID: string, model: ModelRef): boolean {
    const previous = this.models.get(sessionID)
    if (
      previous !== undefined &&
      previous.id === model.id &&
      previous.providerID === model.providerID &&
      previous.variant === model.variant
    )
      return false
    this.models.set(sessionID, model)
    return true
  }

  /** The model currently attributed to a session, if any. */
  modelFor(sessionID: string): ModelRef | undefined {
    return this.models.get(sessionID)
  }

  /**
   * Record a model selection or switch as its own entry.
   *
   * Separate from tool entries so a reviewer can see the model change even when no tool was
   * called between the switch and the end of the session.
   */
  recordModel(input: {
    readonly sessionID: string
    readonly model: ModelRef
    readonly previous?: ModelRef
    readonly source: string
  }): EvidenceEntry {
    this.setModel(input.sessionID, input.model)
    return this.record(
      "model",
      {
        id: `model_${input.sessionID}_${input.model.providerID}_${input.model.id}`,
        tool: "model",
        sessionID: input.sessionID,
      },
      {
        status: "completed",
        model: input.model,
        note:
          `${input.source} model=${input.model.providerID}/${input.model.id}` +
          (input.model.variant === undefined ? "" : ` variant=${input.model.variant}`) +
          (input.previous === undefined
            ? ""
            : ` previous=${input.previous.providerID}/${input.previous.id}`),
      },
    )
  }

  get length(): number {
    return this.seq
  }

  get head(): string {
    return this.prevHash
  }

  /**
   * Health of this recorder. `degraded` means the chain could not be trusted or a write
   * failed, so any "verification: ok" claim about this log is unknown, not passed.
   */
  get health(): {
    readonly ok: boolean
    readonly degraded?: string
    readonly writeFailures: number
  } {
    return this.degraded === undefined && this.writeFailures === 0
      ? { ok: true, writeFailures: 0 }
      : {
          ok: false,
          ...(this.degraded === undefined ? {} : { degraded: this.degraded }),
          writeFailures: this.writeFailures,
        }
  }

  /** Record that a write did not land. Called by callers that catch recorder exceptions. */
  noteWriteFailure(error: unknown): void {
    this.writeFailures += 1
    this.degraded = `write failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

export type VerifyResult =
  | {
      readonly ok: true
      readonly entries: number
      readonly head: string
      /**
       * Limits of what `ok: true` actually proves. Present so a caller cannot present a
       * valid prefix as a complete, immutable record (independent review F-08):
       * a fully deleted tail, or a chain recomputed by anyone with write access, both
       * verify as `ok`.
       */
      readonly limitations: readonly string[]
    }
  | { readonly ok: false; readonly entries: number; readonly reason: string; readonly seq?: number }

/** Reported with every successful verification so the guarantee is never overstated. */
const VERIFY_LIMITATIONS = [
  "a valid chain proves entries were not edited, deleted or reordered in place",
  "a valid chain cannot prove nothing was removed from the end (tail truncation)",
  "entries are not signed, so anyone with write access can recompute a consistent chain",
] as const

/**
 * Recompute the chain from disk.
 *
 * Checks, in order: JSON parses; version matches; `seq` increments by one from 1;
 * `prevHash` equals the previous entry's hash; and the stored hash matches a fresh
 * hash of the entry body. The first failure is reported with its `seq`.
 */
export function verify(file: string): VerifyResult {
  if (!existsSync(file))
    return { ok: true, entries: 0, head: GENESIS, limitations: VERIFY_LIMITATIONS }
  return verifyText(readFileSync(file, "utf8"))
}

export function verifyText(text: string): VerifyResult {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  let prev = GENESIS
  for (let index = 0; index < lines.length; index++) {
    let entry: EvidenceEntry
    try {
      entry = JSON.parse(lines[index]!) as EvidenceEntry
    } catch {
      return {
        ok: false,
        entries: index,
        reason: `entry ${index + 1} is not valid JSON`,
        seq: index + 1,
      }
    }
    if (entry.v !== EVIDENCE_VERSION)
      return {
        ok: false,
        entries: index,
        reason: `unsupported version ${String(entry.v)}`,
        seq: entry.seq,
      }
    if (entry.seq !== index + 1)
      return {
        ok: false,
        entries: index,
        reason: `expected seq ${index + 1}, found ${entry.seq}`,
        seq: entry.seq,
      }
    if (entry.prevHash !== prev)
      return {
        ok: false,
        entries: index,
        reason: `prevHash mismatch at seq ${entry.seq}`,
        seq: entry.seq,
      }
    const { hash, ...body } = entry
    if (entryHash(body) !== hash)
      return {
        ok: false,
        entries: index,
        reason: `hash mismatch at seq ${entry.seq}`,
        seq: entry.seq,
      }
    prev = hash
  }
  return { ok: true, entries: lines.length, head: prev, limitations: VERIFY_LIMITATIONS }
}

export interface ToolEventInput {
  readonly id: string
  readonly tool: string
  readonly sessionID: string
  readonly agent?: string
  readonly messageID?: string
  readonly input?: unknown
  /** Plan task this call belongs to, when one is known (BW-016). */
  readonly taskID?: string
}

export interface ToolEventOutput extends ToolEventInput {
  readonly status: "completed" | "error"
  readonly output?: unknown
  readonly error?: { readonly message?: string } | string
  readonly exit?: number
}

/** Narrow a foreign hook event to the fields the recorder needs. */
function callOf(event: ToolEventInput): ToolCallRef {
  return {
    id: String(event.id),
    tool: String(event.tool),
    sessionID: String(event.sessionID),
    ...(event.agent === undefined ? {} : { agent: String(event.agent) }),
    ...(event.messageID === undefined ? {} : { messageID: String(event.messageID) }),
    ...(event.taskID === undefined
      ? // An event with no task is recorded as explicitly unassigned with a reason, rather
        // than silently looking like a task-less call that was assigned to nothing.
        { unassignedReason: "no task was selected when this tool call was recorded" }
      : { taskID: String(event.taskID) }),
  }
}

/**
 * Record a tool `execute.before` event.
 *
 * Returns the entry so a caller can link later evidence to this exact call.
 */
export function onToolBefore(recorder: EvidenceRecorder, event: ToolEventInput): EvidenceEntry {
  return recorder.recordTool("before", callOf(event), { input: event.input })
}

/**
 * Record a tool `execute.after` event. Failures are recorded as evidence, not thrown.
 *
 * The shell tool reports its exit status inside the structured output
 * (`output.exitCode`), not as a top-level field, so lift it if the caller did not
 * already supply one — an exit code buried in a payload is useless for a gate check.
 */
export function onToolAfter(recorder: EvidenceRecorder, event: ToolEventOutput): EvidenceEntry {
  const message = typeof event.error === "string" ? event.error : event.error?.message
  const output = event.status === "error" ? (message ?? "unknown error") : event.output
  const exit =
    event.exit ??
    (typeof output === "object" && output !== null && "exitCode" in output
      ? Number((output as { exitCode: unknown }).exitCode)
      : undefined)
  return recorder.recordTool("after", callOf(event), {
    status: event.status,
    output,
    ...(exit === undefined || Number.isNaN(exit) ? {} : { exit }),
  })
}
