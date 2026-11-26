/**
 * Pure Node 22+ IntentLock TaskContract storage and execution gate (BW-056).
 *
 * Reuses `bw-cli/src/contract.ts` schema validation & criterion transition rules and
 * `bw-evidence/src/scope.ts` path canonicalization without any Bun or SQLite dependencies.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import {
  CONTRACT_VERSION,
  ContractGateError,
  ContractInvalidError,
  ContractRevisionError,
  assertContract,
  contractId,
  validateContract,
  type ContractAssumption,
  type ContractConstraints,
  type ContractCriterion,
  type ContractQuestion,
  type TaskContract,
} from "../contract.ts"
import { canonicalWorkspace } from "../trust.ts"
import { makePolicy, physicalPath, type ScopePolicy } from "../../../bw-evidence/src/scope.ts"
import type { WorkspaceBaseline } from "./types.ts"

interface ActiveContractsIndex {
  readonly version: 1
  readonly workspaces: Record<string, { readonly contractId: string; readonly revision: number }>
}

function contractsDir(dataDir: string): string {
  return path.join(dataDir, "contracts")
}

function activeIndexFile(dataDir: string): string {
  return path.join(contractsDir(dataDir), "active.json")
}

function contractRevisionFile(dataDir: string, id: string, revision: number): string {
  return path.join(contractsDir(dataDir), `${id}.r${revision}.json`)
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  )
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, filePath)
}

export class ContractStoreError extends Error {
  readonly code = "contract_store_error"
  constructor(message: string) {
    super(message)
    this.name = "ContractStoreError"
  }
}

function readActiveIndex(dataDir: string): ActiveContractsIndex {
  const file = activeIndexFile(dataDir)
  if (!existsSync(file)) return { version: 1, workspaces: {} }
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    throw new ContractStoreError(
      `Cannot read contract index '${file}': ${err instanceof Error ? err.message : String(err)}. Fix permissions or inspect/repair the index file before continuing.`,
    )
  }
  let parsed: Record<string, unknown>
  try {
    const val = JSON.parse(raw) as unknown
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      throw new Error("root value must be a JSON object")
    }
    parsed = val as Record<string, unknown>
  } catch (err) {
    throw new ContractStoreError(
      `Corrupted contract index '${file}': ${err instanceof Error ? err.message : String(err)}. Repair or back up and remove '${file}' before proceeding.`,
    )
  }
  if (
    parsed["version"] !== 1 ||
    typeof parsed["workspaces"] !== "object" ||
    parsed["workspaces"] === null ||
    Array.isArray(parsed["workspaces"])
  ) {
    throw new ContractStoreError(
      `Invalid contract index schema in '${file}' (expected version=1 and workspaces object).`,
    )
  }
  const clean: Record<string, { contractId: string; revision: number }> = {}
  for (const [ws, ptr] of Object.entries(parsed["workspaces"] as Record<string, unknown>)) {
    if (typeof ptr !== "object" || ptr === null || Array.isArray(ptr)) {
      throw new ContractStoreError(
        `Corrupted workspace pointer '${ws}' in contract index '${file}'.`,
      )
    }
    const p = ptr as Record<string, unknown>
    if (
      typeof p["contractId"] !== "string" ||
      !Number.isInteger(p["revision"]) ||
      Number(p["revision"]) < 1
    ) {
      throw new ContractStoreError(`Invalid contract pointer for workspace '${ws}' in '${file}'.`)
    }
    clean[ws] = { contractId: p["contractId"], revision: Number(p["revision"]) }
  }
  return { version: 1, workspaces: clean }
}

function setActivePointer(dataDir: string, workspace: string, id: string, revision: number): void {
  const key = canonicalWorkspace(workspace)
  const index = readActiveIndex(dataDir)
  const updated: ActiveContractsIndex = {
    version: 1,
    workspaces: {
      ...index.workspaces,
      [key]: { contractId: id, revision },
    },
  }
  atomicWriteJson(activeIndexFile(dataDir), updated)
}

export function loadContractRevision(
  dataDir: string,
  id: string,
  revision: number,
): TaskContract | undefined {
  const file = contractRevisionFile(dataDir, id, revision)
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
  } catch (err) {
    throw new ContractStoreError(
      `Cannot read or parse contract revision '${file}': ${err instanceof Error ? err.message : String(err)}.`,
    )
  }
  assertContract(parsed)
  return parsed
}

export function loadActiveContract(dataDir: string, workspace: string): TaskContract | undefined {
  const key = canonicalWorkspace(workspace)
  const index = readActiveIndex(dataDir)
  const ptr = index.workspaces[key]
  if (!ptr) return undefined
  const loaded = loadContractRevision(dataDir, ptr.contractId, ptr.revision)
  if (!loaded) {
    throw new ContractStoreError(
      `Contract index points to missing revision '${ptr.contractId}.r${ptr.revision}.json' for workspace '${key}'.`,
    )
  }
  return loaded
}

export interface CreateStandaloneContractInput {
  readonly objective: string
  readonly allowedPaths: readonly string[]
  readonly forbiddenPaths?: readonly string[]
  readonly negativeRequirements?: readonly string[]
  readonly criteria: readonly {
    readonly id: string
    readonly statement: string
    readonly required?: boolean
    readonly command?: string
  }[]
  readonly constraints?: ContractConstraints
  readonly assumptions?: readonly ContractAssumption[]
  readonly openQuestions?: readonly ContractQuestion[]
  readonly baseCommit?: string
  readonly createdAt?: string
}

export function createStandaloneContract(
  dataDir: string,
  workspace: string,
  input: CreateStandaloneContractInput,
): TaskContract {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const criteria: ContractCriterion[] = input.criteria.map((c) => ({
    id: c.id,
    statement: c.statement,
    required: c.required ?? true,
    task: "standalone",
    check: c.command ?? c.id,
    ...(c.command !== undefined ? { command: c.command } : {}),
  }))
  const contract: TaskContract = {
    v: CONTRACT_VERSION,
    id: contractId("standalone", input.objective, createdAt),
    planId: "standalone",
    objective: input.objective,
    revision: 1,
    ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
    allowedPaths: [...input.allowedPaths],
    forbiddenPaths: [...(input.forbiddenPaths ?? [])],
    negativeRequirements: [...(input.negativeRequirements ?? [])],
    criteria,
    constraints: input.constraints ?? {},
    ...(input.assumptions && input.assumptions.length > 0
      ? { assumptions: [...input.assumptions] }
      : {}),
    ...(input.openQuestions && input.openQuestions.length > 0
      ? { openQuestions: [...input.openQuestions] }
      : {}),
    approval: "draft",
    createdAt,
  }
  const validation = validateContract(contract)
  if (!validation.ok) {
    throw new ContractInvalidError(validation.issues)
  }
  const file = contractRevisionFile(dataDir, contract.id, contract.revision)
  if (existsSync(file)) {
    throw new ContractRevisionError(`Contract revision file already exists: ${file}`)
  }
  atomicWriteJson(file, contract)
  setActivePointer(dataDir, workspace, contract.id, contract.revision)
  return contract
}

export function approveActiveContract(
  dataDir: string,
  workspace: string,
  approvedBy: string,
  approvedAt = new Date().toISOString(),
): TaskContract {
  const current = loadActiveContract(dataDir, workspace)
  if (!current) {
    throw new ContractGateError(`No active contract for workspace '${workspace}'.`)
  }
  if (current.approval === "rejected") {
    throw new ContractGateError(
      "Rejected contracts cannot be approved without creating a new revision.",
    )
  }
  const unresolvedAssumptions = (current.assumptions ?? []).filter((a) => a.blocking && !a.resolved)
  const unresolvedQuestions = (current.openQuestions ?? []).filter((q) => q.blocking && !q.resolved)
  if (unresolvedAssumptions.length > 0 || unresolvedQuestions.length > 0) {
    throw new ContractGateError(
      `Cannot approve contract while blocking items remain unresolved (${unresolvedAssumptions.length} assumption(s), ${unresolvedQuestions.length} question(s)).`,
    )
  }
  const updated: TaskContract = {
    ...current,
    approval: "approved",
    approvedBy: approvedBy.trim(),
    approvedAt,
  }
  assertContract(updated)
  atomicWriteJson(contractRevisionFile(dataDir, updated.id, updated.revision), updated)
  return updated
}

export function rejectActiveContract(dataDir: string, workspace: string): TaskContract {
  const current = loadActiveContract(dataDir, workspace)
  if (!current) {
    throw new ContractGateError(`No active contract for workspace '${workspace}'.`)
  }
  const updated: TaskContract = {
    ...current,
    approval: "rejected",
  }
  assertContract(updated)
  atomicWriteJson(contractRevisionFile(dataDir, updated.id, updated.revision), updated)
  return updated
}

export interface ReviseContractInput {
  readonly reason: string
  readonly objective?: string
  readonly allowedPaths?: readonly string[]
  readonly forbiddenPaths?: readonly string[]
  readonly negativeRequirements?: readonly string[]
  readonly addCriteria?: readonly {
    readonly id: string
    readonly statement: string
    readonly required?: boolean
    readonly command?: string
  }[]
  readonly dropCriteriaIds?: readonly string[]
  readonly resolveAssumptionIds?: readonly string[]
  readonly resolveQuestionIds?: readonly string[]
  readonly constraints?: ContractConstraints
}

export function reviseActiveContract(
  dataDir: string,
  workspace: string,
  patch: ReviseContractInput,
): TaskContract {
  const current = loadActiveContract(dataDir, workspace)
  if (!current) {
    throw new ContractGateError(`No active contract for workspace '${workspace}'.`)
  }
  if (patch.reason.trim() === "") {
    throw new ContractRevisionError("Revising a contract requires a non-empty reason.")
  }

  const droppedPreviously = new Set(
    current.criteria.filter((c) => c.status === "dropped").map((c) => c.id),
  )
  const dropSet = new Set(patch.dropCriteriaIds ?? [])

  const criteria: ContractCriterion[] = current.criteria.map((c) => {
    if (dropSet.has(c.id)) {
      if (c.status === "dropped") return c
      return { ...c, status: "dropped" as const }
    }
    return c
  })

  for (const added of patch.addCriteria ?? []) {
    if (droppedPreviously.has(added.id)) {
      throw new ContractRevisionError(`Cannot re-add previously dropped criterion '${added.id}'.`)
    }
    if (criteria.some((c) => c.id === added.id)) {
      throw new ContractRevisionError(`Criterion '${added.id}' already exists in contract.`)
    }
    criteria.push({
      id: added.id,
      statement: added.statement,
      required: added.required ?? true,
      task: "standalone",
      check: added.command ?? added.id,
      ...(added.command !== undefined ? { command: added.command } : {}),
    })
  }

  const resolvedAssumptionIds = new Set(patch.resolveAssumptionIds ?? [])
  const assumptions = current.assumptions?.map((a) =>
    resolvedAssumptionIds.has(a.id) ? { ...a, resolved: true } : a,
  )
  const resolvedQuestionIds = new Set(patch.resolveQuestionIds ?? [])
  const openQuestions = current.openQuestions?.map((q) =>
    resolvedQuestionIds.has(q.id) ? { ...q, resolved: true } : q,
  )

  const nextRevision = current.revision + 1
  const next: TaskContract = {
    v: CONTRACT_VERSION,
    id: current.id,
    planId: current.planId,
    objective: patch.objective ?? current.objective,
    revision: nextRevision,
    ...(current.baseCommit !== undefined ? { baseCommit: current.baseCommit } : {}),
    allowedPaths: patch.allowedPaths ? [...patch.allowedPaths] : [...current.allowedPaths],
    forbiddenPaths: patch.forbiddenPaths ? [...patch.forbiddenPaths] : [...current.forbiddenPaths],
    negativeRequirements: patch.negativeRequirements
      ? [...patch.negativeRequirements]
      : [...current.negativeRequirements],
    criteria,
    constraints: patch.constraints ?? current.constraints,
    ...(assumptions ? { assumptions } : {}),
    ...(openQuestions ? { openQuestions } : {}),
    approval: "draft",
    createdAt: current.createdAt,
    reason: patch.reason.trim(),
  }

  assertContract(next)
  const nextFile = contractRevisionFile(dataDir, next.id, next.revision)
  if (existsSync(nextFile)) {
    throw new ContractRevisionError(`Contract revision file already exists: ${nextFile}`)
  }
  atomicWriteJson(nextFile, next)
  setActivePointer(dataDir, workspace, next.id, next.revision)
  return next
}

export function compileContractScopePolicy(
  contract: TaskContract,
  workspace: string,
  extraForbiddenRoots: readonly string[] = [],
): ScopePolicy {
  const canonical = physicalPath(workspace)
  const allowShell =
    contract.constraints.allowedCommands !== undefined
      ? contract.constraints.allowedCommands.length > 0
      : true
  const base = makePolicy({
    mode: "enforce",
    allowedPaths: contract.allowedPaths,
    readPaths: [canonical],
    allowShell,
    origin: "contract",
    cwd: canonical,
  })
  const forbiddenPaths = [
    ...contract.forbiddenPaths.map((p) => physicalPath(path.resolve(canonical, p))),
    ...extraForbiddenRoots.map((p) => physicalPath(p)),
  ]
  return {
    ...base,
    workspace: canonical,
    forbiddenPaths,
  }
}

export function evaluateContractGate(
  contract: TaskContract | undefined,
  requireContract: boolean,
  _workspace: string,
  baseline: WorkspaceBaseline,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly error: ContractGateError } {
  if (!contract) {
    if (!requireContract) return { ok: true }
    const reason =
      "Contract required (--require-contract), but no active contract exists for this workspace. Create and approve one with `bashwink contract new` and `bashwink contract approve`."
    return { ok: false, reason, error: new ContractGateError(reason) }
  }

  const valid = validateContract(contract)
  if (!valid.ok) {
    const reason = `Active contract '${contract.id}' is invalid: ${valid.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`
    return { ok: false, reason, error: new ContractGateError(reason) }
  }

  if (contract.approval !== "approved") {
    const reason = `Active contract '${contract.id}' r${contract.revision} has status '${contract.approval}' (must be 'approved' before execution).`
    return { ok: false, reason, error: new ContractGateError(reason) }
  }

  const blockingAssumptions = (contract.assumptions ?? []).filter((a) => a.blocking && !a.resolved)
  if (blockingAssumptions.length > 0) {
    const reason = `Contract '${contract.id}' has unresolved blocking assumption(s): ${blockingAssumptions.map((a) => a.id).join(", ")}.`
    return { ok: false, reason, error: new ContractGateError(reason) }
  }

  const blockingQuestions = (contract.openQuestions ?? []).filter((q) => q.blocking && !q.resolved)
  if (blockingQuestions.length > 0) {
    const reason = `Contract '${contract.id}' has unresolved blocking question(s): ${blockingQuestions.map((q) => q.id).join(", ")}.`
    return { ok: false, reason, error: new ContractGateError(reason) }
  }

  if (contract.constraints.requireCleanBase) {
    if (baseline.mode !== "git") {
      const reason = `Contract '${contract.id}' requires a clean git base, but workspace is not a valid git worktree.`
      return { ok: false, reason, error: new ContractGateError(reason) }
    }
    if (baseline.gitError || !baseline.gitHead) {
      const reason = `Contract '${contract.id}' requires a clean git base, but git metadata could not be verified (${baseline.gitError ?? "missing HEAD"}).`
      return { ok: false, reason, error: new ContractGateError(reason) }
    }
    if (contract.baseCommit && baseline.gitHead !== contract.baseCommit) {
      const reason = `Contract '${contract.id}' requires base commit ${contract.baseCommit}, but HEAD is ${baseline.gitHead}.`
      return { ok: false, reason, error: new ContractGateError(reason) }
    }
    if (baseline.partial) {
      const reason = `Contract '${contract.id}' requires a clean git base, but baseline scan was partial (${baseline.partialReason ?? "bounded"}).`
      return { ok: false, reason, error: new ContractGateError(reason) }
    }
    if (baseline.dirtyFiles.length > 0) {
      const reason = `Contract '${contract.id}' requires a clean git base, but ${baseline.dirtyFiles.length} file(s) are dirty: ${baseline.dirtyFiles.slice(0, 5).join(", ")}.`
      return { ok: false, reason, error: new ContractGateError(reason) }
    }
  }

  return { ok: true }
}

export function renderContractSummary(contract: TaskContract): string {
  const lines = [
    `Contract  ${contract.id} (revision ${contract.revision})`,
    `Approval  ${contract.approval}${contract.approvedBy ? ` by ${contract.approvedBy}` : ""}`,
    `Objective ${contract.objective}`,
    `Allow     ${contract.allowedPaths.length > 0 ? contract.allowedPaths.join(", ") : "(none — read-only)"}`,
  ]
  if (contract.forbiddenPaths.length > 0) {
    lines.push(`Forbid    ${contract.forbiddenPaths.join(", ")}`)
  }
  if (contract.constraints.maxFiles !== undefined) {
    lines.push(`MaxFiles  ${contract.constraints.maxFiles}`)
  }
  if (contract.constraints.allowedCommands !== undefined) {
    lines.push(`AllowCmd  ${contract.constraints.allowedCommands.join(", ") || "(shell disabled)"}`)
  }
  if (contract.constraints.forbiddenCommands !== undefined) {
    lines.push(`ForbidCmd ${contract.constraints.forbiddenCommands.join(", ")}`)
  }
  for (const c of contract.criteria) {
    lines.push(
      `  [${c.status ?? "pending"}] ${c.id}${c.required ? "" : " (optional)"}: ${c.statement}${c.command ? ` ($ ${c.command})` : ""}`,
    )
  }
  for (const a of contract.assumptions ?? []) {
    lines.push(
      `  [${a.resolved ? "resolved" : a.blocking ? "BLOCKING" : "open"}] assumption ${a.id}: ${a.statement}`,
    )
  }
  for (const q of contract.openQuestions ?? []) {
    lines.push(
      `  [${q.resolved ? "resolved" : q.blocking ? "BLOCKING" : "open"}] question ${q.id}: ${q.question}`,
    )
  }
  return lines.join("\n")
}
