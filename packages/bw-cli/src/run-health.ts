/**
 * Run health: did the evidence plugin actually initialise for this run?
 *
 * Phase 1 ended with a known hazard: the evidence plugin must be staged or nothing is
 * recorded, and a failure to load it was **silent**. The probe behind this module reproduced
 * three variants against the real OpenCode v2.3.2 binary:
 *
 *   1. the plugin's entry throws at import — the run exits 0, the tool call happens, the
 *      evidence log stays empty, and the only trace is a `WARN` line in OpenCode's own log;
 *   2. the staged directory has no resolvable server entry — the runtime drops it in
 *      discovery and logs **nothing at all**;
 *   3. the module exports the wrong shape — the run exits 0 and the log stays empty.
 *
 * A wrapper that only waits for the child's exit code cannot tell any of those from a
 * successful session that called no tools. So every run now writes a durable expectation
 * record before the child starts, the plugin writes a `boot` entry after registering its
 * hooks, and the wrapper reconciles the two afterwards.
 *
 * The record lives under `<data>/runs/` rather than in SQLite because a run can fail before
 * the database is usable, and the record must survive exactly that case.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { verify } from "@bashwink/evidence"
import type { Paths } from "./paths.js"
import type { BackendResult } from "./execution-backend.js"
import type { UsageSummary } from "./usage-guard.js"

/** What the wrapper knows about evidence for a run. */
export type EvidenceOutcome =
  /** Started; not yet reconciled. */
  | "pending"
  /** Plugin booted and its boot entry is in the chain. */
  | "recorded"
  /** Evidence was expected but no boot entry for this run exists. */
  | "missing"
  /** Deliberately disabled (`BASHWINK_EVIDENCE=off`); no claim is made either way. */
  | "disabled"

export interface RunRecord {
  readonly v: 1
  readonly runId: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly exitCode?: number
  readonly execution?: BackendResult
  readonly evidence: EvidenceOutcome
  readonly expected: boolean
  readonly plugin?: {
    readonly id: string
    readonly entry: string
    readonly stagedPath: string
  }
  /** Human-readable reason for a non-`recorded` outcome. */
  readonly detail?: string
  /** Seq of the boot entry in the evidence chain, when one was found. */
  readonly bootSeq?: number
  /** Entries the chain contained when it was verified (0 when absent). */
  readonly evidenceEntries?: number
  /** Head hash at reconciliation, so a later export can be tied to this record. */
  readonly evidenceHead?: string
  /** Model requests, tokens and cost the runtime reported for this launch, and the limit that stopped it, if any. */
  readonly usage?: UsageSummary
  /** Test files the agent wrote or edited through the file tools (shell-made changes are not detected). */
  readonly changedTests?: readonly string[]
}

export interface BeginRunInput {
  readonly resolved: Paths
  readonly runId: string
  readonly plugin?: RunRecord["plugin"]
  readonly now?: () => Date
}

/** Directory holding one JSON record per run. */
export function runsDir(resolved: Paths): string {
  return path.join(resolved.data, "runs")
}

export function runRecordFile(resolved: Paths, runId: string): string {
  return path.join(runsDir(resolved), `${runId}.json`)
}

/**
 * A run id that is unique per process, filesystem-safe, and sortable by time.
 *
 * `Date.now()` alone collides when two wrappers start in the same millisecond, which is
 * exactly what the integration fixture does. A random suffix costs nothing and makes the
 * record unambiguous.
 */
export function newRunId(now: () => Date = () => new Date()): string {
  const stamp = now()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 17)
  const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0")
  return `run_${stamp}_${random}`
}

/** Write the expectation before the child runtime starts. */
export function beginRun(input: BeginRunInput): RunRecord {
  const record: RunRecord = {
    v: 1,
    runId: input.runId,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    evidence: input.plugin === undefined ? "disabled" : "pending",
    expected: input.plugin !== undefined,
    ...(input.plugin === undefined ? {} : { plugin: input.plugin }),
  }
  writeRunRecord(input.resolved, record)
  return record
}

export function writeRunRecord(resolved: Paths, record: RunRecord): string {
  mkdirSync(runsDir(resolved), { recursive: true })
  const file = runRecordFile(resolved, record.runId)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  return file
}

export function readRunRecord(file: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunRecord
  } catch {
    return undefined
  }
}

/** Most recent run records, newest first. Unreadable files are skipped, not guessed at. */
export function recentRuns(resolved: Paths, limit = 5): RunRecord[] {
  let names: string[]
  try {
    names = readdirSync(runsDir(resolved)).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  return names
    .map((name) => readRunRecord(path.join(runsDir(resolved), name)))
    .filter((record): record is RunRecord => record !== undefined)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, limit)
}

export type BootCheck =
  | {
      readonly ok: true
      readonly seq: number
      readonly entries: number
      readonly head: string
    }
  | {
      readonly ok: false
      readonly reason: string
      /** Entries present in the chain, 0 when the file is absent. */
      readonly entries: number
    }

/**
 * Find this run's boot entry and verify the chain it lives in.
 *
 * A boot entry proves the plugin reached the end of `setup()`, which only happens after both
 * `execute.before` and `execute.after` are registered. It deliberately does not claim that
 * any tool ran: a session with zero tool calls is legitimate and still has evidence.
 */
export function checkBoot(evidenceFile: string, runId: string): BootCheck {
  if (!existsSync(evidenceFile))
    return {
      ok: false,
      reason: `no evidence log exists at ${evidenceFile}`,
      entries: 0,
    }
  const chain = verify(evidenceFile)
  if (!chain.ok)
    return {
      ok: false,
      reason: `the evidence log failed chain verification: ${chain.reason}`,
      entries: chain.entries,
    }
  const lines = readFileSync(evidenceFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { seq?: number; phase?: string; call?: { id?: string } }
      if (entry.phase !== "boot") continue
      if (entry.call?.id === `boot_${runId}`)
        return {
          ok: true,
          seq: Number(entry.seq ?? 0),
          entries: chain.entries,
          head: chain.head,
        }
    } catch {
      // verify() already proved every line parses; a throw here would be a contradiction,
      // so it is treated as "not this entry" rather than silently reported as success.
      continue
    }
  }
  return {
    ok: false,
    reason:
      chain.entries === 0
        ? "the evidence log is empty"
        : `the evidence log has ${chain.entries} entries but none is a boot record for ${runId}`,
    entries: chain.entries,
  }
}

/**
 * Reconcile a finished run and persist the outcome.
 *
 * Returns the updated record so `main.ts` can decide the exit code without re-reading disk.
 */
export function finishRun(input: {
  readonly resolved: Paths
  readonly runId: string
  readonly exitCode: number
  readonly execution?: BackendResult
  readonly expected: boolean
  readonly boot?: BootCheck
  readonly detail?: string
  readonly usage?: UsageSummary
  readonly changedTests?: readonly string[]
  readonly now?: () => Date
}): RunRecord {
  const file = runRecordFile(input.resolved, input.runId)
  const existing = readRunRecord(file)
  const evidence: EvidenceOutcome = !input.expected
    ? "disabled"
    : input.boot?.ok === true
      ? "recorded"
      : "missing"
  const record: RunRecord = {
    v: 1,
    runId: input.runId,
    startedAt: existing?.startedAt ?? (input.now ?? (() => new Date()))().toISOString(),
    endedAt: (input.now ?? (() => new Date()))().toISOString(),
    exitCode: input.exitCode,
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    evidence,
    expected: input.expected,
    ...(existing?.plugin === undefined ? {} : { plugin: existing.plugin }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.changedTests === undefined ? {} : { changedTests: input.changedTests }),
    ...(input.boot?.ok === true
      ? {
          bootSeq: input.boot.seq,
          evidenceEntries: input.boot.entries,
          evidenceHead: input.boot.head,
        }
      : input.boot === undefined
        ? {}
        : { evidenceEntries: input.boot.entries }),
  }
  writeRunRecord(input.resolved, record)
  return record
}

/** Where the pinned runtime writes its own server log for this home. */
export function runtimeLogHint(resolved: Paths): string {
  return path.join(path.dirname(resolved.data), "opencode", "log", "opencode.log")
}

/**
 * The message a user gets when evidence was expected and did not arrive.
 *
 * Actionable on purpose: it names the run, the plugin, the file that is missing, the runtime
 * log that may explain why, and the command that re-checks the install. A silent empty log was
 * the original defect; a vague "something went wrong" would only be a quieter version of it.
 */
export function renderMissingEvidence(input: {
  readonly record: RunRecord
  readonly boot: BootCheck
  readonly evidenceFile: string
  readonly logFile: string
}): string {
  const plugin = input.record.plugin
  const lines = [
    `evidence plugin did not initialise for ${input.record.runId}`,
    `  expected: ${plugin === undefined ? "bashwink-evidence" : plugin.id} (${plugin?.entry ?? "entry unknown"})`,
    `  evidence: ${input.evidenceFile}`,
    `  reason:   ${input.boot.ok ? "unreachable" : input.boot.reason}`,
    `  runtime log: ${input.logFile}`,
  ]

  // Distinguish the two ways this happens, because the advice differs and the wrong advice
  // wastes the reader's time. When the child exited before doing any work (a bad `--model`,
  // an unknown flag, a refused command), nothing ran to record — the honest statement is
  // "nothing happened", not "work happened but was not recorded". Only a run that actually
  // started, with no boot record, is the alarming case.
  // `boot.entries` is the length of the whole chain, not this run's entries. Testing it against
  // zero therefore stops working the moment any earlier run has logged anything: a typo'd
  // subcommand then reported "the agent may have done real work" about a process that exited
  // immediately, and the evidence log's previous boot record was the reason. What matters is
  // that no boot record exists *for this run*, and that the child exited nonzero.
  const exitCode = input.record.exitCode
  const neverStarted = exitCode !== undefined && exitCode !== 0 && !input.boot.ok
  if (neverStarted) {
    lines.push(
      `  the runtime exited ${String(exitCode)} before any evidence was written, so no work was`,
      "  recorded and none is known to have happened. This run is unverified either way.",
      "  fix: fix the error the runtime printed above and re-run.",
    )
    return lines.join("\n")
  }

  lines.push(
    "  the agent may have done real work; none of it was recorded, so this run is NOT verified.",
    "  fix: run `bashwink doctor` (it re-resolves the plugin and reads the last run record);",
    "       if the runtime log shows `failed to load plugin`, the cause is in that log's cause= field.",
  )
  return lines.join("\n")
}
