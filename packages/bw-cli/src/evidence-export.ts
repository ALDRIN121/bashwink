/**
 * Evidence export (BW-015).
 *
 * The evidence JSONL says what *tools ran*. This module turns a run's tasks, their declared
 * checks, their recorded observations and the tool events into a report a reviewer can read
 * — and, critically, keeps three outcomes distinct:
 *
 *   pass     the check ran and exited as expected
 *   fail     the check ran and did not
 *   not_run  the check was never executed
 *
 * Acceptance requires an export "verified against raw fixture process result, including
 * failure and `not_run` statuses", which is only possible if the export never collapses
 * `not_run` into `fail`. A report that says a test failed when it never ran is exactly the
 * fabrication this product exists to prevent.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { Store } from "./store.js"
import type { Plan, PlanCheck, PlanTask } from "./plan.js"

export type CheckOutcome = "pass" | "fail" | "not_run" | "skipped"

export interface CheckReport {
  readonly id: string
  readonly description: string
  readonly outcome: CheckOutcome
  readonly exitCode?: number
  /** When it ran (`ISO-8601`), absent when it never ran. */
  readonly at?: string
  /** Redacted, bounded detail. */
  readonly detail?: string
}

export interface TaskReport {
  readonly id: string
  readonly title: string
  readonly status: PlanTask["status"]
  readonly checks: readonly CheckReport[]
  /** How many declared checks are not `pass` — the number that decides "done". */
  readonly outstanding: number
  readonly note?: string
}

export interface ToolEventSummary {
  readonly seq: number
  readonly at: string
  readonly phase: "before" | "after"
  readonly tool: string
  readonly callId: string
  readonly taskId?: string
  readonly status?: "completed" | "error"
  readonly exit?: number
  readonly outputDigest?: string
  readonly truncated?: boolean
}

export interface EvidenceExport {
  readonly v: 1
  readonly runId: string
  readonly planId: string
  readonly objective: string
  readonly commit?: string
  readonly generatedAt: string
  readonly tasks: readonly TaskReport[]
  readonly toolEvents: readonly ToolEventSummary[]
  /** Aggregate: `pass` only when every task is `verified` AND every declared check passed. */
  readonly verdict: "pass" | "fail" | "incomplete"
  readonly summary: {
    readonly tasks: number
    readonly verified: number
    readonly failed: number
    readonly notRun: number
    readonly toolCalls: number
  }
  /** Non-empty when the export could not fully represent the run. */
  readonly limitations: readonly string[]
}

/** Bound for a verbatim detail string in the export. */
const MAX_DETAIL = 500

function bound(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL)}…`
}

/**
 * Merge declared checks with observed outcomes.
 *
 * A declared check with no observation is `not_run` — never `fail`, and never silently
 * omitted. This function is the single place that mapping happens.
 */
export function reportChecks(
  declared: readonly PlanCheck[] | undefined,
  observed: readonly {
    checkId: string
    status: "pass" | "fail" | "not_run"
    exitCode?: number
    at: string
    detail?: string
  }[],
): CheckReport[] {
  return (declared ?? []).map((check) => {
    // The LAST observation wins: a check that failed and then passed after a fix is a pass,
    // and the history is still in the store for anyone who wants it.
    const runs = observed.filter((entry) => entry.checkId === check.id)
    const last = runs.at(-1)
    if (last === undefined)
      return {
        id: check.id,
        description: check.description,
        outcome: "not_run",
      }
    const detail = bound(last.detail)
    return {
      id: check.id,
      description: check.description,
      outcome: last.status,
      ...(last.exitCode === undefined ? {} : { exitCode: last.exitCode }),
      at: last.at,
      // `exactOptionalPropertyTypes` treats `detail: undefined` as different from absent, so
      // the key is only spread in when there is actually a value.
      ...(detail === undefined ? {} : { detail }),
    }
  })
}

/**
 * Read the tool events for a run.
 *
 * Reads the JSONL the recorder wrote. Task association comes from the `taskID` field the
 * evidence plugin now records; an event without one is reported as unassigned rather than
 * guessed at, because a wrong association is worse than an admitted gap.
 */
export function readToolEvents(
  file: string,
  unassignedReason = "event recorded before a task was selected",
): { events: ToolEventSummary[]; limitations: string[] } {
  const limitations: string[] = []
  if (!existsSync(file))
    return {
      events: [],
      limitations: [`no evidence log at ${file}; the run produced no recorded tool events`],
    }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
  const events: ToolEventSummary[] = []
  for (const [index, line] of lines.entries()) {
    try {
      const entry = JSON.parse(line) as {
        seq?: number
        at?: string
        phase?: "before" | "after"
        call?: { id?: string; tool?: string; taskID?: string }
        payload?: {
          status?: "completed" | "error"
          exit?: number
          outputDigest?: string
          truncated?: boolean
        }
      }
      if (entry.phase !== "before" && entry.phase !== "after") continue
      const taskId = entry.call?.taskID
      events.push({
        seq: Number(entry.seq ?? index + 1),
        at: String(entry.at ?? ""),
        phase: entry.phase,
        tool: String(entry.call?.tool ?? "unknown"),
        callId: String(entry.call?.id ?? "unknown"),
        ...(taskId === undefined ? {} : { taskId }),
        ...(entry.payload?.status === undefined ? {} : { status: entry.payload.status }),
        ...(entry.payload?.exit === undefined ? {} : { exit: entry.payload.exit }),
        ...(entry.payload?.outputDigest === undefined
          ? {}
          : { outputDigest: entry.payload.outputDigest }),
        ...(entry.payload?.truncated === undefined ? {} : { truncated: entry.payload.truncated }),
      })
    } catch {
      limitations.push(
        `evidence line ${index + 1} was not parseable and is omitted from the export`,
      )
    }
  }
  const unassigned = events.filter((event) => event.taskId === undefined).length
  if (unassigned > 0)
    limitations.push(
      `${unassigned} of ${events.length} tool event(s) are unassigned (${unassignedReason}); they are listed, not attributed to a task`,
    )
  return { events, limitations }
}

export interface BuildOptions {
  readonly store: Store
  readonly plan: Plan
  readonly runId: string
  readonly evidenceFile: string
  readonly now?: () => Date
  readonly commit?: string
}

/** Assemble the export. Pure read: nothing here mutates the store. */
export function build(options: BuildOptions): EvidenceExport {
  const { store, plan } = options
  const { events, limitations } = readToolEvents(options.evidenceFile)
  const extraLimitations = [...limitations]

  const tasks: TaskReport[] = plan.tasks.map((task) => {
    const checks = reportChecks(task.checks, store.observations(task.id))
    // A task whose status claims verification but whose checks did not all pass is a
    // contradiction. Report it rather than smoothing it over.
    if (task.status === "verified" && checks.some((check) => check.outcome !== "pass"))
      extraLimitations.push(
        `task '${task.id}' is marked verified but has outstanding checks; the stored status and the observations disagree`,
      )
    return {
      id: task.id,
      title: task.title,
      status: store.taskStatus(task.id) ?? task.status,
      checks,
      outstanding: checks.filter((check) => check.outcome !== "pass").length,
      ...(task.note === undefined ? {} : { note: task.note }),
    }
  })

  const allChecks = tasks.flatMap((task) => task.checks)
  const notRun = allChecks.filter((check) => check.outcome === "not_run").length
  const failed = allChecks.filter((check) => check.outcome === "fail").length
  const verifiedTasks = tasks.filter((task) => task.status === "verified").length

  const verdict: EvidenceExport["verdict"] =
    tasks.length > 0 && verifiedTasks === tasks.length && failed === 0 && notRun === 0
      ? "pass"
      : failed > 0
        ? "fail"
        : "incomplete"

  if (notRun > 0 && failed === 0)
    extraLimitations.push(
      `${notRun} declared check(s) were never executed; the run is incomplete, not passing`,
    )

  return {
    v: 1,
    runId: options.runId,
    planId: plan.id,
    objective: plan.objective,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    tasks,
    toolEvents: events,
    verdict,
    summary: {
      tasks: tasks.length,
      verified: verifiedTasks,
      failed,
      notRun,
      toolCalls: events.filter((event) => event.phase === "before").length,
    },
    limitations: extraLimitations,
  }
}

/** Machine export. Stable key order so a diff between two runs is readable. */
export function toJson(report: EvidenceExport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * Human export.
 *
 * Renders `not_run` with a distinct glyph from `fail`, because a reader skimming for red
 * must not read "never executed" as "executed and failed".
 */
export function toMarkdown(report: EvidenceExport): string {
  const glyph: Record<CheckOutcome, string> = {
    pass: "✅ pass",
    fail: "❌ fail",
    not_run: "⬜ not_run",
    skipped: "⏭️ skipped",
  }
  const lines: string[] = [
    `# Evidence: ${report.objective}`,
    "",
    `- **Verdict:** \`${report.verdict}\``,
    `- **Plan:** \`${report.planId}\``,
    `- **Run:** \`${report.runId}\``,
    ...(report.commit === undefined ? [] : [`- **Commit:** \`${report.commit}\``]),
    `- **Generated:** ${report.generatedAt}`,
    "",
    "| tasks | verified | failed checks | not run | tool calls |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${report.summary.tasks} | ${report.summary.verified} | ${report.summary.failed} | ${report.summary.notRun} | ${report.summary.toolCalls} |`,
    "",
    "## Tasks",
    "",
  ]

  for (const task of report.tasks) {
    lines.push(`### ${task.id} — ${task.title}`, "", `Status: \`${task.status}\``)
    if (task.note !== undefined) lines.push("", `> ${task.note}`)
    lines.push("")
    if (task.checks.length === 0) {
      lines.push("_No declared checks._", "")
      continue
    }
    lines.push("| check | outcome | exit |", "| --- | --- | --- |")
    for (const check of task.checks) {
      const exit = check.exitCode === undefined ? "—" : String(check.exitCode)
      lines.push(`| \`${check.id}\` ${check.description} | ${glyph[check.outcome]} | ${exit} |`)
    }
    lines.push("")
  }

  if (report.toolEvents.length > 0) {
    lines.push(
      "## Tool events",
      "",
      "| seq | phase | tool | status | exit | task |",
      "| ---: | --- | --- | --- | --- | --- |",
    )
    for (const event of report.toolEvents)
      lines.push(
        `| ${event.seq} | ${event.phase} | \`${event.tool}\` | ${event.status ?? "—"} | ${event.exit ?? "—"} | ${event.taskId ?? "_unassigned_"} |`,
      )
    lines.push("")
  }

  if (report.limitations.length > 0) {
    lines.push("## Limitations", "")
    for (const limitation of report.limitations) lines.push(`- ${limitation}`)
    lines.push("")
  }
  return lines.join("\n")
}

/**
 * Digest of the *raw process result* a reviewer can recompute.
 *
 * Acceptance for BW-015 is "export verified against raw fixture process result". A digest of
 * the raw output file, recorded alongside the export, is what makes that check mechanical
 * instead of a claim that the two agree.
 */
export function digestFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}
