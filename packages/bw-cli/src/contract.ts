/**
 * TaskContract — the IntentLock data plane (BW-055).
 *
 * A plan says *what will be done*. A contract says *what must be true for it to count*, and
 * who agreed to that before work started:
 *
 *   - an explicit objective and base commit,
 *   - acceptance criteria, each tied to a declared task check,
 *   - allowed and forbidden paths,
 *   - execution constraints (file budget, command policy, clean base),
 *   - negative requirements ("must not change the fixture baselines"),
 *   - numbered revisions, so an amended contract cannot quietly rewrite history.
 *
 * The load-bearing rule is the last one. When a revision removes a criterion, the criterion
 * is marked `dropped` in place; it is never deleted. A status that can disappear is not a
 * record, and the failure mode this prevents is concrete: revise the contract until only the
 * easy criteria remain, then claim success.
 *
 * Validation is hand-written for the same reason as `plan.ts`: `bw-cli` stays dependency-light
 * (ADR-008), and every rule here is one a reviewer should be able to read.
 */

import { createHash } from "node:crypto"
import type { Plan } from "./plan.js"

export const CONTRACT_VERSION = 1

export type ContractApproval = "draft" | "approved" | "rejected"

export type CriterionStatus = "pending" | "passed" | "failed" | "not_run" | "dropped"

export interface ContractCriterion {
  /** Stable across revisions. Reusing a dropped id is refused. */
  readonly id: string
  readonly statement: string
  /** A required criterion is part of the definition of done; optional ones are advisory. */
  readonly required: boolean
  /** Plan task whose work this criterion proves ("standalone" for standalone contracts). */
  readonly task: string
  /** Declared check on that task; evidence is whatever that check observed. */
  readonly check: string
  /** Optional standalone verification command associated with this criterion. */
  readonly command?: string
  /**
   * Persisted lifecycle status. Set when reading a contract back from the store; ignored on
   * write, where the status lives in the `criterion` table and is moved only by evidence.
   */
  readonly status?: CriterionStatus
}

export interface ContractAssumption {
  readonly id: string
  readonly statement: string
  readonly blocking: boolean
  readonly resolved: boolean
  readonly resolution?: string
}

export interface ContractQuestion {
  readonly id: string
  readonly question: string
  readonly blocking: boolean
  readonly resolved: boolean
  readonly answer?: string
}

export interface ContractConstraints {
  /** Budget on files the work may modify. Absent means "no contract-level budget". */
  readonly maxFiles?: number
  /** Command first-tokens that are allowed. Absent means "not constrained here". */
  readonly allowedCommands?: readonly string[]
  /** Command first-tokens that are never allowed, regardless of the allow list. */
  readonly forbiddenCommands?: readonly string[]
  /** Refuse execution when the working tree is already dirty before work starts. */
  readonly requireCleanBase?: boolean
}

export interface TaskContract {
  readonly v: 1
  readonly id: string
  readonly planId: string
  readonly objective: string
  /** 1-based. A revision is immutable once written. */
  readonly revision: number
  readonly baseCommit?: string
  readonly allowedPaths: readonly string[]
  readonly forbiddenPaths: readonly string[]
  readonly negativeRequirements: readonly string[]
  readonly criteria: readonly ContractCriterion[]
  readonly constraints: ContractConstraints
  readonly assumptions?: readonly ContractAssumption[]
  readonly openQuestions?: readonly ContractQuestion[]
  readonly approval: ContractApproval
  readonly approvedBy?: string
  readonly approvedAt?: string
  readonly createdAt: string
  /** Why this revision exists. Required from revision 2 onward. */
  readonly reason?: string
}

export interface ContractIssue {
  readonly path: string
  readonly message: string
}

export interface ContractValidation {
  readonly ok: boolean
  readonly issues: readonly ContractIssue[]
}

const ID_PATTERN = /^ctr_[0-9a-f]{8,}$/
const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/
const COMMIT = /^[0-9a-f]{7,40}$/
const STATUSES: readonly CriterionStatus[] = ["pending", "passed", "failed", "not_run", "dropped"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isCriterionStatus(value: unknown): value is CriterionStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
}

/**
 * A repo-relative path with no escape hatch.
 *
 * Absolute paths and `..` are refused rather than normalised: silently rewriting
 * `/etc/passwd` to `etc/passwd` would turn a policy violation into a surprising allow.
 */
function pathIssue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return "must be a non-empty string"
  if (pathKind(value) === "absolute") return "must be repo-relative, not absolute"
  if (value.includes("\\")) return "must use '/' separators"
  if (value.split("/").some((segment) => segment === "..")) return "must not contain '..'"
  if (value === "." || value.endsWith("/")) return "must name a path, not a directory prefix"
  return undefined
}

/**
 * Absolute on any platform: a leading slash, or a Windows drive (`C:` or `C:/x`, which `path.resolve` treats as absolute
 * on Windows). Kept free of `node:path` so the answer does not depend on the host the contract is validated on.
 */
function pathKind(value: string): "absolute" | "relative" {
  return value.startsWith("/") || /^[A-Za-z]:/.test(value) ? "absolute" : "relative"
}

function stringList(
  value: unknown,
  field: string,
  issues: ContractIssue[],
  required = false,
): string[] {
  if (!Array.isArray(value)) {
    if (required) issues.push({ path: field, message: "must be an array of strings" })
    return []
  }
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push({ path: `${field}[${index}]`, message: "must be a non-empty string" })
      continue
    }
    out.push(item)
  }
  if (new Set(out).size !== out.length)
    issues.push({ path: field, message: "contains duplicates; each entry must be distinct" })
  return out
}

/**
 * Validate a contract read from a file, a store row, or a caller.
 *
 * `plan` is optional so a standalone contract can be checked structurally; when it is given,
 * every criterion must resolve to a real task and a check that task actually declares. That
 * resolution is what stops a criterion from citing evidence that could never exist.
 */
export function validateContract(value: unknown, plan?: Plan): ContractValidation {
  const issues: ContractIssue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })

  if (!isRecord(value)) return { ok: false, issues: [{ path: "", message: "must be an object" }] }

  if (value.v !== CONTRACT_VERSION)
    add("v", `unsupported version ${String(value.v)}; expected ${CONTRACT_VERSION}`)
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id))
    add("id", "must look like 'ctr_<hex8+>'")
  if (plan !== undefined) {
    if (typeof value.planId !== "string" || value.planId.trim() === "")
      add("planId", "must reference a plan")
  } else if (
    value.planId !== undefined &&
    (typeof value.planId !== "string" || value.planId.trim() === "")
  ) {
    add("planId", "must be a non-empty string when provided")
  }
  if (typeof value.objective !== "string" || value.objective.trim() === "")
    add("objective", "must be a non-empty statement of what the work achieves")
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))
    add("createdAt", "must be an ISO-8601 timestamp")
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1)
    add("revision", "must be an integer >= 1")
  if (value.revision !== 1 && (typeof value.reason !== "string" || value.reason.trim() === ""))
    add("reason", "a revision after the first must state why it exists")

  if (value.baseCommit !== undefined && value.baseCommit !== null) {
    if (typeof value.baseCommit !== "string" || !COMMIT.test(value.baseCommit))
      add("baseCommit", "must be a 7-40 character lowercase hex commit")
  }

  const allowed = stringList(value.allowedPaths, "allowedPaths", issues, true)
  const forbidden = stringList(value.forbiddenPaths, "forbiddenPaths", issues, true)
  for (const [field, list] of [
    ["allowedPaths", allowed],
    ["forbiddenPaths", forbidden],
  ] as const)
    for (const [index, item] of list.entries()) {
      const problem = pathIssue(item)
      if (problem !== undefined) add(`${field}[${index}]`, problem)
    }
  for (const allowedPath of allowed)
    for (const forbiddenPath of forbidden)
      if (
        allowedPath === forbiddenPath ||
        allowedPath.startsWith(`${forbiddenPath}/`) ||
        forbiddenPath.startsWith(`${allowedPath}/`)
      )
        add(
          "forbiddenPaths",
          `'${forbiddenPath}' overlaps allowed path '${allowedPath}'; a path cannot be both`,
        )
  // An empty allow-list is legal and means "read-only contract". It is not an error, but the
  // distinction matters, so it is stated in the docs rather than inferred from silence.

  stringList(value.negativeRequirements, "negativeRequirements", issues)

  // --- constraints -------------------------------------------------------
  if (!isRecord(value.constraints)) add("constraints", "must be an object")
  else {
    const constraints = value.constraints
    if (constraints["maxFiles"] !== undefined) {
      if (!Number.isInteger(constraints["maxFiles"]) || Number(constraints["maxFiles"]) < 0)
        add("constraints.maxFiles", "must be a non-negative integer")
    }
    const allowedCommands = stringList(
      constraints["allowedCommands"],
      "constraints.allowedCommands",
      issues,
    )
    const forbiddenCommands = stringList(
      constraints["forbiddenCommands"],
      "constraints.forbiddenCommands",
      issues,
    )
    for (const command of allowedCommands)
      if (forbiddenCommands.includes(command))
        add(
          "constraints.forbiddenCommands",
          `'${command}' is both allowed and forbidden; forbidden must win, so remove the ambiguity`,
        )
    if (
      constraints["requireCleanBase"] !== undefined &&
      typeof constraints["requireCleanBase"] !== "boolean"
    )
      add("constraints.requireCleanBase", "must be a boolean")
  }

  // --- criteria ----------------------------------------------------------
  if (!Array.isArray(value.criteria) || value.criteria.length === 0)
    add("criteria", "at least one acceptance criterion is required")
  else {
    const seen = new Set<string>()
    for (const [index, raw] of value.criteria.entries()) {
      const at = `criteria[${index}]`
      if (!isRecord(raw)) {
        add(at, "must be an object")
        continue
      }
      const id = raw["id"]
      if (typeof id !== "string" || !CRITERION_ID.test(id))
        add(`${at}.id`, "must be a stable id of 2-80 characters")
      else if (seen.has(id)) add(`${at}.id`, `duplicate criterion id '${id}'`)
      else seen.add(id)
      if (typeof raw["statement"] !== "string" || raw["statement"].trim() === "")
        add(`${at}.statement`, "must state what passing means")
      if (typeof raw["required"] !== "boolean") add(`${at}.required`, "must be a boolean")
      if (plan !== undefined) {
        if (typeof raw["task"] !== "string" || raw["task"].trim() === "")
          add(`${at}.task`, "must name the plan task this criterion proves")
        if (typeof raw["check"] !== "string" || raw["check"].trim() === "")
          add(`${at}.check`, "must name the declared check that produces the evidence")
      } else {
        if (
          raw["task"] !== undefined &&
          (typeof raw["task"] !== "string" || raw["task"].trim() === "")
        )
          add(`${at}.task`, "must be a non-empty string when provided")
        if (
          raw["check"] !== undefined &&
          (typeof raw["check"] !== "string" || raw["check"].trim() === "")
        )
          add(`${at}.check`, "must be a non-empty string when provided")
      }
      if (
        raw["command"] !== undefined &&
        (typeof raw["command"] !== "string" || raw["command"].trim() === "")
      )
        add(`${at}.command`, "must be a non-empty string when provided")
      if (raw["status"] !== undefined && !isCriterionStatus(raw["status"]))
        add(`${at}.status`, `must be one of ${STATUSES.join(", ")}`)

      if (plan !== undefined && typeof raw["task"] === "string") {
        const task = plan.tasks.find((candidate) => candidate.id === raw["task"])
        if (task === undefined) add(`${at}.task`, `plan has no task '${raw["task"]}'`)
        else if (
          typeof raw["check"] === "string" &&
          !(task.checks ?? []).some((check) => check.id === raw["check"])
        )
          add(
            `${at}.check`,
            `task '${task.id}' declares no check '${raw["check"]}'; declared: ${(task.checks ?? []).map((check) => check.id).join(", ") || "(none)"}`,
          )
      }
    }
    if (!value.criteria.some((raw) => isRecord(raw) && raw["required"] === true))
      add("criteria", "at least one criterion must be required")
  }

  // --- assumptions & openQuestions (optional IntentLock gates) ----------
  for (const [field, textKey] of [
    ["assumptions", "statement"],
    ["openQuestions", "question"],
  ] as const) {
    const rawList = value[field]
    if (rawList === undefined) continue
    if (!Array.isArray(rawList)) {
      add(field, "must be an array")
      continue
    }
    for (const [index, raw] of rawList.entries()) {
      const at = `${field}[${index}]`
      if (!isRecord(raw)) {
        add(at, "must be an object")
        continue
      }
      if (typeof raw["id"] !== "string" || raw["id"].trim() === "")
        add(`${at}.id`, "must be a non-empty string")
      if (typeof raw[textKey] !== "string" || raw[textKey].trim() === "")
        add(`${at}.${textKey}`, "must be a non-empty string")
      if (typeof raw["blocking"] !== "boolean") add(`${at}.blocking`, "must be a boolean")
      if (typeof raw["resolved"] !== "boolean") add(`${at}.resolved`, "must be a boolean")
    }
  }

  // --- approval ----------------------------------------------------------
  if (value.approval !== "draft" && value.approval !== "approved" && value.approval !== "rejected")
    add("approval", "must be one of draft | approved | rejected")
  if (value.approval === "approved") {
    if (typeof value.approvedBy !== "string" || value.approvedBy.trim() === "")
      add("approvedBy", "an approved contract must record who approved it")
    if (typeof value.approvedAt !== "string" || Number.isNaN(Date.parse(value.approvedAt)))
      add("approvedAt", "an approved contract must record when it was approved")
  }

  return { ok: issues.length === 0, issues }
}

/**
 * Criterion lifecycle, as a total map.
 *
 * `passed -> failed` is allowed on purpose: a later observation can disprove an earlier one,
 * and the record must be able to say so. `dropped` is terminal and `passed -> pending` is
 * refused — those are the two ways a status could otherwise be laundered.
 */
export const CRITERION_TRANSITIONS: Readonly<Record<CriterionStatus, readonly CriterionStatus[]>> =
  {
    pending: ["passed", "failed", "not_run", "dropped"],
    not_run: ["passed", "failed", "dropped"],
    failed: ["passed", "not_run", "dropped"],
    passed: ["failed", "dropped"],
    dropped: [],
  }

export class InvalidCriterionTransitionError extends Error {
  readonly code = "criterion_transition_invalid"
  readonly from: CriterionStatus
  readonly to: CriterionStatus
  constructor(from: CriterionStatus, to: CriterionStatus) {
    super(`criterion cannot move from '${from}' to '${to}'`)
    this.name = "InvalidCriterionTransitionError"
    this.from = from
    this.to = to
  }
}

export function canChangeCriterion(from: CriterionStatus, to: CriterionStatus): boolean {
  return CRITERION_TRANSITIONS[from].includes(to)
}

export function assertCriterionTransition(from: CriterionStatus, to: CriterionStatus): void {
  if (!canChangeCriterion(from, to)) throw new InvalidCriterionTransitionError(from, to)
}

export class ContractInvalidError extends Error {
  readonly code = "contract_invalid"
  readonly issues: readonly ContractIssue[]
  constructor(issues: readonly ContractIssue[]) {
    super(
      `contract is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    )
    this.name = "ContractInvalidError"
    this.issues = issues
  }
}

/**
 * A revision that cannot be applied — out of sequence, or trying to re-add a dropped
 * criterion. Separate from `ContractInvalidError` because the contract itself may be valid;
 * it is the *history* that refuses the write.
 */
/**
 * Execution was refused because the governing contract does not permit it.
 *
 * Thrown by the store, not only the CLI, so every path that can start a task (including
 * `resume`) passes through the same gate.
 */
export class ContractGateError extends Error {
  readonly code = "contract_gate_refused"
  constructor(message: string) {
    super(message)
    this.name = "ContractGateError"
  }
}

export class ContractRevisionError extends Error {
  readonly code = "contract_revision_invalid"
  constructor(message: string) {
    super(message)
    this.name = "ContractRevisionError"
  }
}

export function assertContract(value: unknown, plan?: Plan): asserts value is TaskContract {
  const result = validateContract(value, plan)
  if (!result.ok) throw new ContractInvalidError(result.issues)
}

/** Deterministic id, readable in a log and stable for the same plan + objective. */
export function contractId(planId: string, objective: string, createdAt: string): string {
  return `ctr_${createHash("sha256")
    .update(`${planId}\u0000${objective}\u0000${createdAt}`)
    .digest("hex")
    .slice(0, 12)}`
}

/**
 * Build the default contract for a plan: one criterion per declared check.
 *
 * This is deliberately conservative. Every check in the plan becomes a **required** criterion,
 * because a plan that declares a check is claiming that check proves the work; making them
 * optional by default would let "done" mean "the ones that passed".
 */
export function deriveContract(
  plan: Plan,
  options: {
    readonly createdAt: string
    readonly baseCommit?: string
    readonly allowedPaths?: readonly string[]
    readonly forbiddenPaths?: readonly string[]
    readonly negatives?: readonly string[]
    readonly maxFiles?: number
  },
): TaskContract {
  const criteria: ContractCriterion[] = []
  for (const task of plan.tasks)
    for (const check of task.checks ?? [])
      criteria.push({
        id: `${task.id}.${check.id}`,
        statement: check.description,
        required: true,
        task: task.id,
        check: check.id,
      })
  if (criteria.length === 0)
    throw new ContractInvalidError([
      {
        path: "criteria",
        message: "the plan declares no checks, so no criterion can be evidenced",
      },
    ])

  return {
    v: CONTRACT_VERSION,
    id: contractId(plan.id, plan.objective, options.createdAt),
    planId: plan.id,
    objective: plan.objective,
    revision: 1,
    ...(options.baseCommit === undefined ? {} : { baseCommit: options.baseCommit }),
    allowedPaths: options.allowedPaths === undefined ? [...plan.files] : [...options.allowedPaths],
    forbiddenPaths: [...(options.forbiddenPaths ?? [])],
    negativeRequirements: [...(options.negatives ?? [])],
    criteria,
    constraints: options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
    approval: "draft",
    createdAt: options.createdAt,
  }
}

/**
 * Refuse execution when the contract does not cover the task or is not approved.
 *
 * Called from the `plan task <id> in_progress` path. A plan with no contract keeps Phase 1
 * behaviour; once a contract exists it becomes a gate, not a document.
 */
export function validateForExecution(
  contract: TaskContract,
  plan: Plan,
  taskId: string,
): ContractValidation {
  const issues: ContractIssue[] = []
  const structural = validateContract(contract, plan)
  issues.push(...structural.issues)
  if (contract.approval !== "approved")
    issues.push({
      path: "approval",
      message: `contract is '${contract.approval}'; approve it before starting work`,
    })
  if (contract.planId !== plan.id)
    issues.push({
      path: "planId",
      message: `contract belongs to plan '${contract.planId}', not '${plan.id}'`,
    })
  const covering = contract.criteria.filter(
    (criterion) => criterion.task === taskId && criterion.status !== "dropped",
  )
  if (covering.length === 0)
    issues.push({
      path: "criteria",
      message: `no criterion covers task '${taskId}', so its work cannot be verified against this contract`,
    })
  return { ok: issues.length === 0, issues }
}
