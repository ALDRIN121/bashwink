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
import {
  ContractGateError,
  ContractInvalidError,
  ContractRevisionError,
  contractId,
  deriveContract,
  validateContract,
  validateForExecution,
  type ContractCriterion,
  type ContractConstraints,
  type TaskContract,
} from "./contract.js"
import { build, toJson, toMarkdown } from "./evidence-export.js"
import { recentRuns, runsDir } from "./run-health.js"
import { reconcile, resume } from "./resume.js"
// Re-exported so `main.ts` imports every subcommand from one module, and so the CLI has a
// single import edge for tests that drive it as a library.
export { runAuthCommand, runModelCommand } from "./providers-cli.js"

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
      if (to === "in_progress") {
        // BW-055: once a contract exists it is a gate, not a document. Starting work under a
        // draft contract or a task the contract does not cover is refused. A plan with no
        // contract keeps Phase 1 behaviour, so existing flows are unaffected.
        const contract = store.contractForPlan(plan.id)
        if (contract !== undefined) {
          const gate = validateForExecution(contract, plan, taskId)
          if (!gate.ok)
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                `refusing to start '${taskId}': contract ${contract.id} revision ${contract.revision} does not allow it\n` +
                gate.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n") +
                "\nfix: `bashwink contract show`, amend with `contract revise`, then `contract approve --by <you>`",
            }
        }
      }
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
      try {
        store.transition(taskId, to as PlanTask["status"], "via CLI")
      } catch (error) {
        // Defense in depth: the command-level gate above gives the richer message, while the
        // store enforces the same rule for every other caller.
        if (error instanceof ContractGateError)
          return { exitCode: 1, stdout: "", stderr: error.message }
        throw error
      }
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

// --------------------------------------------------------------- contract

/** Repeatable `--flag value` pairs. */
function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!)
  return values
}

function flagValue(args: readonly string[], name: string): string | undefined {
  return flagValues(args, name).at(-1)
}

/** The subset of a contract a person is expected to author; ids and revisions are derived. */
interface ContractSpec {
  readonly objective?: string
  readonly baseCommit?: string
  readonly allowedPaths?: readonly string[]
  readonly forbiddenPaths?: readonly string[]
  readonly negativeRequirements?: readonly string[]
  readonly criteria?: readonly ContractCriterion[]
  readonly constraints?: ContractConstraints
}

function readSpec(file: string): ContractSpec {
  const parsed = JSON.parse(readFileSync(path.resolve(file), "utf8")) as unknown
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`contract spec '${file}' must be a JSON object`)
  return parsed as ContractSpec
}

/**
 * Compose a contract from a spec, or derive the default one from the plan.
 *
 * CLI flags win over the file, because the common case is "the file is right except the
 * allow-list", and re-editing a file to change one path is how mistakes accumulate.
 */
function composeContract(input: {
  readonly plan: Plan
  readonly spec?: ContractSpec
  readonly allow?: readonly string[]
  readonly forbid?: readonly string[]
  readonly negatives: readonly string[]
  readonly maxFiles?: number
  readonly base?: string
  readonly createdAt: string
}): TaskContract {
  const { plan, spec } = input
  if (spec === undefined) {
    return deriveContract(plan, {
      createdAt: input.createdAt,
      ...(input.base === undefined ? {} : { baseCommit: input.base }),
      ...(input.allow === undefined ? {} : { allowedPaths: input.allow }),
      ...(input.forbid === undefined ? {} : { forbiddenPaths: input.forbid }),
      negatives: input.negatives,
      ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
    })
  }
  const criteria = spec.criteria ?? []
  if (criteria.length === 0)
    throw new ContractInvalidError([
      { path: "criteria", message: "the spec declares no acceptance criteria" },
    ])
  const constraints: ContractConstraints = {
    ...spec.constraints,
    ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
  }
  return {
    v: 1,
    id: "",
    planId: plan.id,
    objective: spec.objective ?? plan.objective,
    revision: 1,
    ...((input.base ?? spec.baseCommit) === undefined
      ? {}
      : { baseCommit: (input.base ?? spec.baseCommit) as string }),
    allowedPaths: input.allow ?? spec.allowedPaths ?? plan.files,
    forbiddenPaths: input.forbid ?? spec.forbiddenPaths ?? [],
    negativeRequirements:
      input.negatives.length > 0 ? input.negatives : (spec.negativeRequirements ?? []),
    criteria,
    constraints,
    approval: "draft",
    createdAt: input.createdAt,
  }
}

export function runContractCommand(args: readonly string[]): CommandResult {
  ensurePaths(paths())
  const { plan, error } = readPlan()
  if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
  const store = new Store({ file: paths().database })
  try {
    const [sub, ...rest] = args
    const json = rest.includes("--json")

    if (sub === "new" || sub === undefined) {
      if (store.contractForPlan(plan.id) !== undefined)
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            'a contract already exists for this plan; amend it with `bashwink contract revise --file <spec> --reason "<why>"` ' +
            "so its history stays in one place",
        }
      const file = flagValue(rest, "--file")
      const createdAt = new Date().toISOString()
      const allow = flagValues(rest, "--allow")
        .flatMap((value) => value.split(","))
        .filter(Boolean)
      const forbid = flagValues(rest, "--forbid")
        .flatMap((value) => value.split(","))
        .filter(Boolean)
      const maxFilesRaw = flagValue(rest, "--max-files")
      const spec = file === undefined ? undefined : readSpec(file)
      const composed = composeContract({
        plan,
        ...(spec === undefined ? {} : { spec }),
        ...(allow.length === 0 ? {} : { allow }),
        ...(forbid.length === 0 ? {} : { forbid }),
        negatives: flagValues(rest, "--negative"),
        ...(maxFilesRaw === undefined ? {} : { maxFiles: Number(maxFilesRaw) }),
        ...(flagValue(rest, "--base") === undefined ? {} : { base: flagValue(rest, "--base")! }),
        createdAt,
      })
      // The id is derived, not supplied: a hand-written id could collide with an existing
      // contract and silently replace its history.
      const contract: TaskContract = {
        ...composed,
        id: contractId(plan.id, composed.objective, createdAt),
      }
      const validation = validateContract(contract, plan)
      if (!validation.ok)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `contract is invalid:\n${validation.issues
            .map((issue) => `  ${issue.path}: ${issue.message}`)
            .join("\n")}`,
        }
      store.saveContract(contract)
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(contract, null, 2)}\n` }
      return {
        exitCode: 0,
        stdout: [
          `created ${contract.id} revision ${contract.revision} (${contract.approval})`,
          `objective: ${contract.objective}`,
          `criteria:  ${contract.criteria.length} (${contract.criteria.filter((criterion) => criterion.required).length} required)`,
          `allowed:   ${contract.allowedPaths.join(", ") || "(read-only)"}`,
          "",
          'next: review with `bashwink contract show`, then `bashwink contract approve --by "<you>"`',
        ].join("\n"),
      }
    }

    if (sub === "show") {
      const contract = store.contractForPlan(plan.id)
      if (contract === undefined)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "no contract for the current plan; create one with `bashwink contract new`",
        }
      if (json)
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ contract, revisions: store.revisions(contract.id) }, null, 2)}\n`,
        }
      const criteria = store.criteria(contract.id)
      const lines = [
        `${contract.id}  revision ${contract.revision}  [${contract.approval}]`,
        `objective: ${contract.objective}`,
        `plan:      ${contract.planId}`,
        ...(contract.baseCommit === undefined ? [] : [`base:      ${contract.baseCommit}`]),
        `allowed:   ${contract.allowedPaths.join(", ") || "(read-only)"}`,
        `forbidden: ${contract.forbiddenPaths.join(", ") || "(none)"}`,
        ...(contract.negativeRequirements.length === 0
          ? []
          : [`must not:  ${contract.negativeRequirements.join("; ")}`]),
        ...(Object.keys(contract.constraints).length === 0
          ? []
          : [`limits:    ${JSON.stringify(contract.constraints)}`]),
        "",
        "criteria:",
      ]
      for (const criterion of criteria)
        lines.push(
          `  ${criterion.id.padEnd(32)} ${criterion.status.padEnd(8)} ${criterion.required ? "required" : "optional"}`,
        )
      if (contract.approval !== "approved")
        lines.push(
          "",
          "not approved — `bashwink plan task <id> in_progress` is refused until it is",
        )
      return { exitCode: 0, stdout: lines.join("\n") }
    }

    if (sub === "approve") {
      const by = flagValue(rest, "--by")
      if (by === undefined || by.trim() === "")
        return usage('usage: bashwink contract approve --by "<your name>"')
      const contract = store.contractForPlan(plan.id)
      if (contract === undefined)
        return { exitCode: 1, stdout: "", stderr: "no contract for the current plan" }
      if (contract.approval === "approved")
        return {
          exitCode: 0,
          stdout: `already approved by ${contract.approvedBy} at ${contract.approvedAt}`,
        }
      const approved = store.approveContract(contract.id, by)
      const validation = validateContract(approved, plan)
      if (!validation.ok)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `approval would produce an invalid contract: ${validation.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")}`,
        }
      return {
        exitCode: 0,
        stdout: `approved ${approved.id} revision ${approved.revision} by ${by} at ${approved.approvedAt}`,
      }
    }

    if (sub === "revise") {
      const file = flagValue(rest, "--file")
      const reason = flagValue(rest, "--reason")
      if (file === undefined)
        return usage('usage: bashwink contract revise --file <spec.json> --reason "<why>"')
      if (reason === undefined || reason.trim() === "")
        return usage('a revision must state why it exists: --reason "<why>"')
      const current = store.contractForPlan(plan.id)
      if (current === undefined)
        return { exitCode: 1, stdout: "", stderr: "no contract for the current plan" }
      const composed = composeContract({
        plan,
        spec: readSpec(file),
        negatives: flagValues(rest, "--negative"),
        createdAt: current.createdAt,
      })
      const revised: TaskContract = {
        ...composed,
        id: current.id,
        planId: current.planId,
        createdAt: current.createdAt,
        revision: current.revision + 1,
        // Content changed after approval, so approval must be given again. Carrying it over
        // would let a revision quietly inherit consent for text nobody approved.
        approval: "draft",
        reason,
      }
      const validation = validateContract(revised, plan)
      if (!validation.ok)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `revision is invalid:\n${validation.issues
            .map((issue) => `  ${issue.path}: ${issue.message}`)
            .join("\n")}`,
        }
      store.saveContract(revised)
      const dropped = store
        .criteria(revised.id)
        .filter((criterion) => criterion.status === "dropped")
      return {
        exitCode: 0,
        stdout: [
          `created revision ${revised.revision}: ${reason}`,
          `criteria: ${revised.criteria.length} current, ${dropped.length} dropped (kept, not deleted)`,
          "approval reset to draft; approve again before execution",
        ].join("\n"),
      }
    }

    if (sub === "status") {
      const contract = store.contractForPlan(plan.id)
      if (contract === undefined)
        return { exitCode: 1, stdout: "", stderr: "no contract for the current plan" }
      const rows = store.criteria(contract.id).map((criterion) => ({
        ...criterion,
        evidence: store.criterionEvidence(contract.id, criterion.id),
      }))
      // Dropped criteria are reported separately. Counting them as required would make a
      // revision look like it still had obligations it deliberately removed.
      const current = rows.filter((row) => row.status !== "dropped")
      const required = current.filter((row) => row.required)
      const summary = {
        contractId: contract.id,
        revision: contract.revision,
        approval: contract.approval,
        required: required.length,
        passed: required.filter((row) => row.status === "passed").length,
        failed: required.filter((row) => row.status === "failed").length,
        notRun: required.filter((row) => row.status === "not_run" || row.status === "pending")
          .length,
        dropped: rows.filter((row) => row.status === "dropped").length,
        criteria: rows,
      }
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n` }
      const lines = [
        `${contract.id} revision ${contract.revision} [${contract.approval}]`,
        `required: ${summary.required}  passed: ${summary.passed}  failed: ${summary.failed}  not_run: ${summary.notRun}  dropped: ${summary.dropped}`,
        "",
      ]
      for (const row of rows)
        lines.push(
          `  ${row.id.padEnd(32)} ${row.status.padEnd(8)} evidence: ${row.evidence.length}${row.statusReason === undefined ? "" : ` (${row.statusReason})`}`,
        )
      const outstanding = required.filter((row) => row.status !== "passed").length
      lines.push(
        "",
        outstanding === 0
          ? "every required criterion has a passing observation"
          : `${outstanding} required criterion(s) are not passed — the work is not done`,
      )
      return { exitCode: 0, stdout: lines.join("\n") }
    }

    return usage(
      "usage: bashwink contract new [--file spec.json] | show [--json] | approve --by <name> | revise --file spec.json --reason <why> | status [--json]",
    )
  } catch (error) {
    if (error instanceof ContractInvalidError || error instanceof ContractRevisionError)
      return { exitCode: 1, stdout: "", stderr: error.message }
    if (error instanceof SyntaxError)
      return {
        exitCode: 1,
        stdout: "",
        stderr: `contract spec is not valid JSON: ${error.message}`,
      }
    throw error
  } finally {
    store.close()
  }
}

// --------------------------------------------------------------- evidence

export function runEvidenceCommand(args: readonly string[]): CommandResult {
  const resolved = paths()

  // `evidence status` answers the question the silent-failure defect made unanswerable:
  // did the plugin initialise for the runs that were supposed to record? It reads the run
  // records, which survive a missing evidence file — and it must work with no plan at all,
  // because a failed run can happen before a plan exists.
  if (args[0] === "status") {
    const runs = recentRuns(resolved, args.includes("--all") ? 100 : 5)
    if (args.includes("--json"))
      return { exitCode: 0, stdout: `${JSON.stringify(runs, null, 2)}\n` }
    if (runs.length === 0)
      return {
        exitCode: 0,
        stdout: `no runs recorded under ${runsDir(resolved)}\nnext: run the agent through \`bashwink\``,
      }
    const lines = [
      `runs under ${runsDir(resolved)}`,
      "",
      "started                 run                   exit  evidence   plugin",
    ]
    for (const run of runs)
      lines.push(
        `${run.startedAt.padEnd(23)} ${run.runId.padEnd(21)} ${String(run.exitCode ?? "?").padEnd(5)} ${run.evidence.padEnd(10)} ${run.plugin?.id ?? "(none)"}`,
      )
    const broken = runs.filter((run) => run.evidence === "missing")
    if (broken.length > 0) {
      lines.push(
        "",
        `${broken.length} run(s) expected evidence and recorded none — they are NOT verified:`,
        ...broken.map((run) => `  ${run.runId}: ${run.detail ?? "no boot record"}`),
        "diagnose with `bashwink doctor`; the runtime log path is printed after a failed run.",
      )
    }
    return { exitCode: broken.length > 0 ? 3 : 0, stdout: lines.join("\n") }
  }

  const { plan, error } = readPlan()
  if (plan === undefined) return { exitCode: 1, stdout: "", stderr: error ?? "no plan" }
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
    let result
    try {
      result = resume({ store, planId: plan.id })
    } catch (error) {
      if (error instanceof ContractGateError)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `refusing to resume: ${error.message}\nfix: approve the contract, or revise it to cover the task.`,
        }
      throw error
    }
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
