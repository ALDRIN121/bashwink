/**
 * Subcommand implementations.
 *
 * Each returns `{ exitCode, stdout, stderr }` instead of printing or exiting, so every path
 * is testable and `main.ts` stays a dispatcher. Exit codes are conventional and documented in
 * `help.ts`: 0 ok, 1 refused/failed, 2 usage.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { ensurePaths, paths } from "./paths.js"
import { canonicalWorkspace, grantTrust, readTrust, revokeTrust, writeTrust } from "./trust.js"
import { validatePlan, dependenciesSatisfied, type Plan, type PlanTask } from "./plan.js"
import { canTransition } from "./status.js"
import { Store } from "./store.js"
import { build, toJson, toMarkdown } from "./evidence-export.js"
import { reconcile, resume } from "./resume.js"

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr?: string
}

const usage = (message: string): CommandResult => ({ exitCode: 2, stdout: "", stderr: message })

/** Plan id derived from the objective + createdAt, so it is stable and readable. */
export function planId(objective: string, createdAt: string): string {
  return `plan_${createHash("sha256").update(`${objective}\u0000${createdAt}`).digest("hex").slice(0, 12)}`
}

function planFile(): string {
  return path.join(paths().data, "current-plan.json")
}

function trustFile(): string {
  return path.join(paths().config, "trust.json")
}

/** Read the current plan, or `undefined` with a message the caller can act on. */
export function readPlan(): { plan?: Plan; error?: string } {
  const file = planFile()
  if (!existsSync(file)) return { error: `no plan yet; run \`bashwink plan new "<objective>"\`` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    return {
      error: `current plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const validation = validatePlan(parsed)
  if (!validation.ok)
    return {
      error:
        "current plan failed validation:\n" +
        validation.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n"),
    }
  return { plan: parsed as Plan }
}

export function writePlan(plan: Plan): void {
  const file = planFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8")
}

// ------------------------------------------------------------------ trust

export function runTrustCommand(args: readonly string[]): CommandResult {
  const resolved = paths()
  ensurePaths(resolved)
  const file = trustFile()
  let trust
  try {
    trust = readTrust(file)
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `trust file ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (args.length === 0 || args[0] === "--list") {
    if (trust.workspaces.length === 0) return { exitCode: 0, stdout: "no trusted workspaces" }
    return {
      exitCode: 0,
      stdout: trust.workspaces
        .map(
          (record) => `${record.directory}  (trusted ${record.trustedAt} by ${record.grantedBy})`,
        )
        .join("\n"),
    }
  }

  if (args[0] === "--revoke") {
    const target = args[1]
    if (target === undefined) return usage("usage: bashwink trust --revoke <dir>")
    const next = revokeTrust(trust, target)
    writeTrust(file, next)
    return { exitCode: 0, stdout: `revoked trust for ${canonicalWorkspace(target)}` }
  }

  const target = args[0]
  if (target === undefined) return usage("usage: bashwink trust <dir>")
  const by = args.includes("--by") ? args[args.indexOf("--by") + 1] : undefined
  if (by === undefined)
    // An unattributed trust grant is not auditable, so it is refused rather than defaulted.
    return usage('usage: bashwink trust <dir> --by <"your name">')
  const next = grantTrust(trust, target, by, new Date().toISOString())
  writeTrust(file, next)
  return {
    exitCode: 0,
    stdout: `trusted ${canonicalWorkspace(target)} (by ${by}) — shell and write actions now require per-call approval`,
  }
}

// ------------------------------------------------------------------- plan

/** A minimal but genuinely usable task graph for an objective. */
export function defaultTasks(objective: string, files: readonly string[]): PlanTask[] {
  const check = (id: string, description: string, command: string) => ({
    id,
    description,
    command,
    expectExit: 0,
  })
  return [
    {
      id: "inspect",
      title: `Inspect the code relevant to: ${objective}`,
      status: "pending",
      files: [...files],
      checks: [
        check(
          "inspect-files-exist",
          "every target file exists",
          `test -f ${files[0] ?? "README.md"}`,
        ),
      ],
    },
    {
      id: "implement",
      title: "Make the change",
      status: "pending",
      dependsOn: ["inspect"],
      files: [...files],
      checks: [
        check("implement-diff-present", "the working tree differs from HEAD", "! git diff --quiet"),
      ],
    },
    {
      id: "verify",
      title: "Prove the change with the project's tests",
      status: "pending",
      dependsOn: ["implement"],
      checks: [check("verify-tests-pass", "the evidence suite passes", "bun run test:evidence")],
    },
  ]
}

export async function runPlanCommand(args: readonly string[]): Promise<CommandResult> {
  ensurePaths(paths())
  const [sub, ...rest] = args

  if (sub === "new") {
    const objective = rest
      .filter((arg) => !arg.startsWith("--"))
      .join(" ")
      .trim()
    if (objective === "") return usage('usage: bashwink plan new "<objective>" [--files a.ts,b.ts]')
    const filesArg = rest.find((arg) => arg.startsWith("--files="))
    const files =
      filesArg === undefined ? [] : filesArg.slice("--files=".length).split(",").filter(Boolean)
    const createdAt = new Date().toISOString()
    const plan: Plan = {
      v: 1,
      id: planId(objective, createdAt),
      objective,
      files,
      tasks: defaultTasks(objective, files),
      approval: "draft",
      risks: [],
      createdAt,
    }
    const validation = validatePlan(plan)
    if (!validation.ok)
      return {
        exitCode: 1,
        stdout: "",
        stderr: `generated plan failed its own validation: ${validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      }
    writePlan(plan)
    // Register it in the durable store so tasks and transitions survive a restart.
    const store = new Store({ file: paths().database })
    try {
      store.savePlan(plan)
    } finally {
      store.close()
    }
    return {
      exitCode: 0,
      stdout:
        `created ${plan.id} (${plan.tasks.length} tasks, ${plan.approval})\n` +
        `objective: ${plan.objective}\n` +
        `next: bashwink plan show, then bashwink plan approve --by "<you>"`,
    }
  }

  if (sub === "show" || sub === undefined) {
    const { plan, error } = readPlan()
    if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
    if (rest.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(plan, null, 2) }
    const store = new Store({ file: paths().database })
    let lines: string[]
    try {
      lines = [
        `${plan.id}  [${plan.approval}]`,
        `objective: ${plan.objective}`,
        `files: ${plan.files.length === 0 ? "(read-only plan)" : plan.files.join(", ")}`,
        "",
        "tasks:",
      ]
      for (const task of plan.tasks) {
        const status = store.taskStatus(task.id) ?? task.status
        const ready = dependenciesSatisfied(task, plan.tasks) ? "ready" : "blocked"
        lines.push(
          `  ${task.id.padEnd(12)} ${status.padEnd(12)} ${ready.padEnd(8)} ${task.title}` +
            (task.dependsOn === undefined || task.dependsOn.length === 0
              ? ""
              : `\n  ${" ".repeat(12)} needs: ${task.dependsOn.join(", ")}`),
        )
      }
    } finally {
      store.close()
    }
    if (plan.approval !== "approved")
      lines.push("", "not approved — editing is blocked until `bashwink plan approve --by <you>`")
    return { exitCode: 0, stdout: lines.join("\n") }
  }

  if (sub === "approve") {
    const { plan, error } = readPlan()
    if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
    const byIndex = rest.indexOf("--by")
    const by = byIndex === -1 ? undefined : rest[byIndex + 1]
    if (by === undefined || by.trim() === "")
      // Approval must be attributable. Refusing is the point, not a validation nicety.
      return usage('usage: bashwink plan approve --by "<your name>"')
    const approved: Plan = {
      ...plan,
      approval: "approved",
      approvedBy: by,
      approvedAt: new Date().toISOString(),
    }
    const validation = validatePlan(approved)
    if (!validation.ok)
      return {
        exitCode: 1,
        stdout: "",
        stderr: `approval would produce an invalid plan: ${validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      }
    writePlan(approved)
    const store = new Store({ file: paths().database })
    try {
      store.savePlan(approved)
    } finally {
      store.close()
    }
    return { exitCode: 0, stdout: `approved by ${by} at ${approved.approvedAt}` }
  }

  if (sub === "task") {
    const [taskId, to] = rest
    if (taskId === undefined || to === undefined)
      return usage("usage: bashwink plan task <task-id> <status>")
    const { plan, error } = readPlan()
    if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
    const store = new Store({ file: paths().database })
    try {
      const current = store.taskStatus(taskId)
      if (current === undefined)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `unknown task '${taskId}'; known: ${plan.tasks.map((task) => task.id).join(", ")}`,
        }
      const check = canTransition(current, to as PlanTask["status"])
      if (!check.ok)
        return { exitCode: 1, stdout: "", stderr: check.reason ?? "illegal transition" }
      if (to === "verified") {
        // The whole point of the state machine: verification needs observations.
        const guard = store.checksPassed(taskId)
        if (!guard.ok)
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              `refusing to verify '${taskId}': ${guard.reason}\n` +
              `record a check result first: bashwink plan observe <task> <check-id> pass|fail|not_run`,
          }
      }
      store.transition(taskId, to as PlanTask["status"], "via CLI")
      return { exitCode: 0, stdout: `${taskId}: ${current} -> ${to}` }
    } finally {
      store.close()
    }
  }

  if (sub === "observe") {
    const [taskId, checkId, outcome] = rest
    if (taskId === undefined || checkId === undefined || outcome === undefined)
      return usage("usage: bashwink plan observe <task-id> <check-id> pass|fail|not_run [--exit N]")
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "not_run")
      return usage("outcome must be one of: pass, fail, not_run")
    const { plan, error } = readPlan()
    if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
    const store = new Store({ file: paths().database })
    try {
      const task = plan.tasks.find((candidate) => candidate.id === taskId)
      if (task === undefined)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `unknown task '${taskId}'; known: ${plan.tasks.map((entry) => entry.id).join(", ")}`,
        }
      const declared = (task.checks ?? []).map((check) => check.id)
      if (!declared.includes(checkId))
        // Recording an observation for a check the plan never declared would let a task be
        // "verified" against a check that does not prove it.
        return {
          exitCode: 1,
          stdout: "",
          stderr: `task '${taskId}' declares no check '${checkId}'; declared: ${declared.join(", ") || "(none)"}`,
        }
      const exitIndex = rest.indexOf("--exit")
      const exitCode = exitIndex === -1 ? undefined : Number(rest[exitIndex + 1])
      const detailIndex = rest.indexOf("--detail")
      store.observe(taskId, {
        checkId,
        status: outcome,
        ...(exitCode === undefined || Number.isNaN(exitCode) ? {} : { exitCode }),
        ...(detailIndex === -1 ? {} : { detail: String(rest[detailIndex + 1] ?? "") }),
      })
      return { exitCode: 0, stdout: `recorded ${taskId}/${checkId} = ${outcome}` }
    } finally {
      store.close()
    }
  }

  return usage(
    "usage: bashwink plan new <objective> | show [--json] | approve --by <name> | task <id> <status> | observe <id> <check> <outcome>",
  )
}

// --------------------------------------------------------------- evidence

export function runEvidenceCommand(args: readonly string[]): CommandResult {
  const { plan, error } = readPlan()
  if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
  const resolved = paths()
  const store = new Store({ file: resolved.database })
  try {
    const runId = `run_${Date.now().toString(36)}`
    const report = build({
      store,
      plan,
      runId,
      evidenceFile: path.join(resolved.evidence, "evidence.jsonl"),
    })
    if (args.includes("--json")) return { exitCode: 0, stdout: toJson(report) }
    return { exitCode: 0, stdout: toMarkdown(report) }
  } finally {
    store.close()
  }
}

// ----------------------------------------------------------------- resume

export function runResumeCommand(args: readonly string[]): CommandResult {
  const { plan, error } = readPlan()
  if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
  const store = new Store({ file: paths().database })
  try {
    if (args.includes("--status")) {
      const report = reconcile(store, plan.id)
      if (!report.found) return { exitCode: 0, stdout: "nothing to resume: no interrupted work" }
      return {
        exitCode: 0,
        stdout: [
          `interrupted tasks: ${report.tasks.map((task) => `${task.id}(${task.from})`).join(", ") || "none"}`,
          `unfinished attempts: ${report.attempts.length}`,
          `runs without exit code: ${report.runs.length}`,
          ...report.limitations.map((limitation) => `- ${limitation}`),
        ].join("\n"),
      }
    }
    const result = resume({ store, planId: plan.id })
    if (result.reopened.length === 0 && result.abandonedAttempts.length === 0)
      return { exitCode: 0, stdout: "nothing to resume: no interrupted work" }
    return {
      exitCode: 0,
      stdout: [
        `reopened: ${result.reopened.map((task) => `${task.id} -> ${task.to}`).join(", ")}`,
        `abandoned attempts: ${result.abandonedAttempts.length}`,
        `closed interrupted runs: ${result.interruptedRuns.length}`,
        "",
        "These tasks are NOT verified. Re-run their checks before verifying:",
        ...result.mustRecheck.map(
          (taskId) => `  bashwink plan task ${taskId} verified  # after re-running checks`,
        ),
      ].join("\n"),
    }
  } finally {
    store.close()
  }
}

/** Kept for `main.ts`'s import list; `doctor` is rendered there. */
export function runDoctorCommand(): CommandResult {
  throw new Error("doctor is handled by main.ts via doctor.ts")
}
