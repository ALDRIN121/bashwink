/**
 * Interruption handling and idempotent resume (BW-019).
 *
 * Acceptance: *"Kill/restart fixture neither double-edits nor falsely verifies the abandoned
 * check."*
 *
 * The design principle, from PHASE-01's risk note, is **"prefer explicit uncertain states
 * over attempted automatic recovery"**. So this module does not try to guess what a dead
 * process did. It:
 *
 *   1. Marks work that was in flight as `interrupted` — never as `verified`, never as
 *      `failed`, because neither is known.
 *   2. Provides a *fingerprint* mechanism so a resumed run can ask "was this exact write
 *      already applied?" and skip it. That is what makes resume idempotent rather than
 *      optimistic.
 *   3. Requires a fresh observation after a resume before a task can be verified. A check
 *      that was running when the process died has no recorded outcome, and an interrupted
 *      check must never be inherited as a pass.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { Store } from "./store.js"
import type { TaskStatus } from "./status.js"

/**
 * Content fingerprint for an intended write.
 *
 * Hashing the *content* (not a timestamp, not a path) is what makes the check meaningful:
 * two runs asking to write identical bytes produce the same fingerprint, so the second can
 * be skipped. Hashing the path only would skip a genuinely different later edit.
 */
export function fingerprintWrite(file: string, content: string): string {
  return createHash("sha256").update(`${file}\u0000${content}`).digest("hex")
}

export interface ApplyResult {
  readonly applied: boolean
  /** `skipped_already_applied` is the idempotent-resume outcome, and is not an error. */
  readonly reason: "applied" | "skipped_already_applied" | "skipped_identical_on_disk"
  readonly fingerprint: string
  readonly attemptId?: number
}

export interface ApplyOptions {
  readonly store: Store
  readonly taskId: string
  readonly file: string
  readonly content: string
  /** Injected writer so a test can prove the write happened exactly once. */
  readonly write?: (file: string, content: string) => void
  /** Allow re-writing when the file already has the same bytes (default: skip). */
  readonly force?: boolean
}

/**
 * Apply a file write at most once per (task, file, content).
 *
 * Three ways this returns without writing, all of them correct:
 *   - the same fingerprint was already recorded `applied` for this task,
 *   - the file already holds exactly these bytes,
 *   - unless `force`, either of the above.
 *
 * The write itself is bracketed by `startAttempt`/`finishAttempt` so a process killed
 * mid-write leaves a `started` attempt behind — which `reconcile()` reports instead of
 * assuming success.
 */
export function applyWrite(options: ApplyOptions): ApplyResult {
  const fingerprint = fingerprintWrite(options.file, options.content)
  const write =
    options.write ??
    ((file: string, content: string) => {
      // Imported lazily so the pure helpers above stay importable without touching disk.
      const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content, "utf8")
    })

  if (!options.force) {
    if (options.store.alreadyApplied(options.taskId, "write_file", fingerprint))
      return { applied: false, reason: "skipped_already_applied", fingerprint }
    if (existsSync(options.file) && readFileSync(options.file, "utf8") === options.content)
      return { applied: false, reason: "skipped_identical_on_disk", fingerprint }
  }

  const attemptId = options.store.startAttempt(options.taskId, "write_file", fingerprint)
  try {
    write(options.file, options.content)
    options.store.finishAttempt(attemptId, "applied", options.file)
  } catch (error) {
    options.store.finishAttempt(
      attemptId,
      "failed",
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
  return { applied: true, reason: "applied", fingerprint, attemptId }
}

export interface InterruptedReport {
  /** Tasks left in a genuine unknown state. */
  readonly tasks: readonly { id: string; from: TaskStatus }[]
  /** Attempts that started and never finished. */
  readonly attempts: readonly {
    id: number
    taskId: string
    operation: string
    fingerprint: string
    startedAt: string
  }[]
  /** Runs with no recorded exit code. */
  readonly runs: readonly { id: string; planId: string; startedAt: string }[]
  /** True when anything was found; the CLI exits nonzero for this. */
  readonly found: boolean
  readonly limitations: readonly string[]
}

/**
 * Find everything a killed process left behind.
 *
 * Reads only — reconciliation is a separate, explicit step, because silently "fixing" an
 * interrupted task would destroy the evidence that the interruption happened.
 */
export function reconcile(store: Store, planId: string): InterruptedReport {
  const graph = store.taskGraph(planId)
  const tasks = graph
    .filter((task) => task.status === "in_progress" || task.status === "interrupted")
    .map((task) => ({ id: task.id, from: task.status }))
  const attempts = store.interruptedAttempts()
  const runs = store.interruptedRuns()
  const limitations: string[] = []
  if (tasks.length > 0)
    limitations.push(
      `${tasks.length} task(s) were in flight when the process stopped; their outcome is unknown, not passed`,
    )
  if (attempts.length > 0)
    limitations.push(
      `${attempts.length} write attempt(s) were started and never finished; resume will re-check the file before writing`,
    )
  if (runs.length > 0) limitations.push(`${runs.length} run(s) have no recorded exit code`)
  return {
    tasks,
    attempts,
    runs,
    found: tasks.length > 0 || attempts.length > 0 || runs.length > 0,
    limitations,
  }
}

export interface ResumeOptions {
  readonly store: Store
  readonly planId: string
  /** Explicit user consent to continue. Resume is never automatic. */
  readonly now?: () => Date
}

export interface ResumeResult {
  readonly reopened: readonly { id: string; to: TaskStatus }[]
  readonly abandonedAttempts: readonly number[]
  readonly interruptedRuns: readonly string[]
  /** Tasks that must be re-checked before they may be verified again. */
  readonly mustRecheck: readonly string[]
}

/**
 * Bring interrupted work back to an explicit, non-verified state.
 *
 * Every reopened task lands on `in_progress`, **never** on `verified`. The store's state
 * machine already forbids `interrupted -> verified`; this function is the reason that
 * restriction exists, and `test/resume.test.ts` asserts it.
 *
 * Unfinished attempts are marked `abandoned` rather than `applied`, because we do not know
 * whether the write landed. The resume path then re-checks the file on disk, which is the
 * only trustworthy source.
 */
export function resume(options: ResumeOptions): ResumeResult {
  const store = options.store
  const report = reconcile(store, options.planId)
  const reopened: { id: string; to: TaskStatus }[] = []
  const mustRecheck: string[] = []

  for (const task of report.tasks) {
    if (task.from === "in_progress") {
      store.transition(task.id, "interrupted", "process exited while the task was in progress")
    }
    store.transition(task.id, "in_progress", "resumed after interruption; checks must be re-run")
    reopened.push({ id: task.id, to: "in_progress" })
    mustRecheck.push(task.id)
  }

  const abandonedAttempts: number[] = []
  for (const attempt of report.attempts) {
    store.finishAttempt(attempt.id, "abandoned", "process exited before the attempt completed")
    abandonedAttempts.push(attempt.id)
  }

  const interruptedRuns: string[] = []
  for (const run of report.runs) {
    store.endRun(run.id, -1, true)
    interruptedRuns.push(run.id)
  }

  return { reopened, abandonedAttempts, interruptedRuns, mustRecheck }
}

/**
 * Can this task be verified right now?
 *
 * Wraps the store's check guard with the interruption rule, so the CLI has one function to
 * call and cannot accidentally bypass the "re-check after resume" requirement.
 */
export function canVerify(
  store: Store,
  taskId: string,
  mustRecheck: readonly string[],
): {
  ok: boolean
  reason?: string
} {
  if (mustRecheck.includes(taskId))
    return {
      ok: false,
      reason: `task '${taskId}' was interrupted and resumed; re-run its checks before verifying`,
    }
  return store.checksPassed(taskId)
}
