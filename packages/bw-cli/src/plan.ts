/**
 * Plan artifact contract.
 *
 * A plan is the inspectable, exportable description of what an agent intends to do: an
 * objective, the files it may touch, the tasks and their dependencies, the checks that
 * prove each task, and a human approval state. It exists so that "the agent said it was
 * going to do X" is a document a reviewer can read *before* any edit happens.
 *
 * Validation lives here and produces a list of problems rather than throwing on the first
 * one, because a plan read from disk should be reported as a whole.
 */

import { isTaskStatus, type TaskStatus } from "./status.js"

/** A declared check: the command that proves a task, and what "pass" means. */
export interface PlanCheck {
  readonly id: string
  /** Human-readable description of what this proves. */
  readonly description: string
  /** Shell command to run. Optional: a check may be a manual/agent judgement. */
  readonly command?: string
  /** Exit code that counts as a pass. Default 0. */
  readonly expectExit?: number
}

export interface PlanTask {
  readonly id: string
  readonly title: string
  /** IDs of tasks that must be `verified` (or `skipped`) before this one is `ready`. */
  readonly dependsOn?: readonly string[]
  /** Files this task is allowed to modify. Advisory for review, enforced by scope policy. */
  readonly files?: readonly string[]
  readonly checks?: readonly PlanCheck[]
  readonly status: TaskStatus
  /** Why the task is in this state — mandatory when `skipped` or `failed`. */
  readonly note?: string
}

/**
 * Approval state.
 *
 * `approved` must be an explicit human act. Nothing in the codebase infers it, and the
 * editing tools refuse to write when a plan is not approved (BW-010/BW-011).
 */
export type PlanApproval = "draft" | "approved" | "rejected"

export interface Plan {
  /** Machine schema version, so a stored plan can be migrated rather than guessed at. */
  readonly v: 1
  /** Stable plan id, `plan_<hex>`. */
  readonly id: string
  /** One sentence. What is being achieved. */
  readonly objective: string
  /** Repo-relative paths this plan may modify. Empty means "read-only plan". */
  readonly files: readonly string[]
  readonly tasks: readonly PlanTask[]
  readonly approval: PlanApproval
  /** Who/when approved. Required when `approval` is `approved`, or the plan is not auditable. */
  readonly approvedBy?: string
  readonly approvedAt?: string
  /** Risks the reviewer should weigh. */
  readonly risks?: readonly string[]
  readonly createdAt: string
}

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `tasks[2].dependsOn[0]`. */
  readonly path: string
  readonly message: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly issues: readonly ValidationIssue[]
}

const ID_PATTERN = /^plan_[0-9a-f]{8,}$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate a partly-trusted value as a `Plan`.
 *
 * Written by hand rather than with a schema library: `bw-cli` must stay dependency-light so
 * its licence surface stays trivial (ADR-008), and the rules are few enough to read.
 */
export function validatePlan(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })

  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "", message: "plan must be a JSON object" }] }
  }

  if (value.v !== 1) add("v", `unsupported plan schema version ${String(value.v)}; expected 1`)
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id))
    add("id", "id must look like 'plan_<hex8+>'")
  if (typeof value.objective !== "string" || value.objective.trim().length === 0)
    add("objective", "objective must be a non-empty string")
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))
    add("createdAt", "createdAt must be an ISO-8601 timestamp")

  const approval = value.approval
  if (approval !== "draft" && approval !== "approved" && approval !== "rejected")
    add("approval", "approval must be one of draft | approved | rejected")
  if (approval === "approved") {
    // An "approved" plan with no approver is not an approval, it is a label.
    if (typeof value.approvedBy !== "string" || value.approvedBy.trim() === "")
      add("approvedBy", "an approved plan must record who approved it")
    if (typeof value.approvedAt !== "string" || Number.isNaN(Date.parse(value.approvedAt)))
      add("approvedAt", "an approved plan must record when it was approved")
  }

  if (!Array.isArray(value.files)) add("files", "files must be an array of repo-relative paths")
  else
    for (const [i, file] of value.files.entries()) {
      if (typeof file !== "string" || file.trim() === "")
        add(`files[${i}]`, "file path must be a non-empty string")
      else if (file.startsWith("/") || file.includes(".."))
        add(`files[${i}]`, `'${file}' must be repo-relative and may not traverse upward`)
    }

  if (!Array.isArray(value.risks)) add("risks", "risks must be an array (may be empty)")
  else
    for (const [i, risk] of value.risks.entries())
      if (typeof risk !== "string" || risk.trim() === "")
        add(`risks[${i}]`, "risk must be a non-empty string")

  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    add("tasks", "plan must declare at least one task")
    return { ok: issues.length === 0, issues }
  }

  const seen = new Set<string>()
  for (const [i, task] of value.tasks.entries()) {
    const at = `tasks[${i}]`
    if (!isRecord(task)) {
      add(at, "task must be an object")
      continue
    }
    if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id))
      add(`${at}.id`, "task id must be 2-64 chars of [A-Za-z0-9._-]")
    else if (seen.has(task.id)) add(`${at}.id`, `duplicate task id '${task.id}'`)
    else seen.add(task.id)

    if (typeof task.title !== "string" || task.title.trim() === "")
      add(`${at}.title`, "title must be a non-empty string")
    if (!isTaskStatus(task.status))
      add(`${at}.status`, `unknown task status '${String(task.status)}'`)
    if ((task.status === "skipped" || task.status === "failed") && typeof task.note !== "string")
      add(`${at}.note`, `a '${String(task.status)}' task must state why in 'note'`)

    if (task.dependsOn !== undefined) {
      if (!Array.isArray(task.dependsOn)) add(`${at}.dependsOn`, "dependsOn must be an array")
      else
        for (const [j, dep] of task.dependsOn.entries()) {
          if (typeof dep !== "string" || !TASK_ID_PATTERN.test(dep))
            add(`${at}.dependsOn[${j}]`, "dependency must be a task id")
          else if (task.id === dep) add(`${at}.dependsOn[${j}]`, "a task cannot depend on itself")
        }
    }

    if (task.files !== undefined && !Array.isArray(task.files))
      add(`${at}.files`, "files must be an array")

    if (task.checks !== undefined) {
      if (!Array.isArray(task.checks)) add(`${at}.checks`, "checks must be an array")
      else
        for (const [j, check] of task.checks.entries()) {
          const cat = `${at}.checks[${j}]`
          if (!isRecord(check)) {
            add(cat, "check must be an object")
            continue
          }
          if (typeof check.id !== "string" || check.id.trim() === "")
            add(`${cat}.id`, "check id must be a non-empty string")
          if (typeof check.description !== "string" || check.description.trim() === "")
            add(`${cat}.description`, "check description must be a non-empty string")
          if (check.expectExit !== undefined && !Number.isInteger(check.expectExit))
            add(`${cat}.expectExit`, "expectExit must be an integer exit code")
        }
    }
  }

  // Dependencies must resolve, and must not form a cycle: a plan whose graph cannot be
  // executed in any order is not a plan, it is a deadlock.
  for (const [i, task] of value.tasks.entries()) {
    if (!isRecord(task) || !Array.isArray(task.dependsOn)) continue
    for (const [j, dep] of task.dependsOn.entries())
      if (typeof dep === "string" && !seen.has(dep))
        add(`tasks[${i}].dependsOn[${j}]`, `depends on unknown task '${dep}'`)
  }
  const cycle = findCycle(value.tasks as readonly PlanTask[])
  if (cycle) add("tasks", `dependency cycle: ${cycle.join(" -> ")}`)

  return { ok: issues.length === 0, issues }
}

/** Depth-first cycle search. Returns the cycle as a path of ids, or `undefined`. */
export function findCycle(tasks: readonly PlanTask[]): string[] | undefined {
  const byId = new Map<string, PlanTask>()
  for (const task of tasks) byId.set(task.id, task)
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []

  const visit = (id: string): string[] | undefined => {
    const current = state.get(id)
    if (current === "done") return undefined
    if (current === "visiting") {
      const start = stack.indexOf(id)
      return [...stack.slice(start === -1 ? 0 : start), id]
    }
    state.set(id, "visiting")
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, "done")
    return undefined
  }

  for (const task of tasks) {
    const found = visit(task.id)
    if (found) return found
  }
  return undefined
}

/**
 * True when every dependency of `task` is satisfied (`verified` or `skipped`).
 *
 * `skipped` counts as satisfied on purpose: a deliberately out-of-scope dependency must not
 * permanently block its dependents, and the skip reason is recorded in the plan.
 */
export function dependenciesSatisfied(task: PlanTask, tasks: readonly PlanTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const dep of task.dependsOn ?? []) {
    const other = byId.get(dep)
    if (!other) return false
    if (other.status !== "verified" && other.status !== "skipped") return false
  }
  return true
}
