/**
 * ProofPack manifest builder, structural ClaimGuard, terminal ProofSummary renderer,
 * and evidence/proof export helpers (`BW-060`, `BW-061`, `BW-017`).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  verify as verifyEvidenceFile,
  type EvidenceEntry,
} from "../../../bw-evidence/src/recorder.ts"
import type { TaskContract } from "../contract.ts"
import type {
  ClaimStatus,
  CommandOutcomeRecord,
  CriterionOutcomeRecord,
  ProofCheckRecord,
  ProofPackManifest,
  RunSummaryRecord,
  TaskResult,
  TestIntegrityFinding,
  WorkspaceBaseline,
} from "./types.ts"

const FALSE_CLAIM_PATTERN =
  /\b(?:all\s+tests?\s+(?:are\s+)?pass(?:ed|ing)?|tests?\s+pass(?:ed)?|everything\s+(?:passed|passes|works)|verified\s+(?:passing|clean)|all\s+checks?\s+(?:are\s+)?green)\b/i

const TEST_FILTER_FLAGS = new Set([
  "--grep",
  "-g",
  "-t",
  "--test-name-pattern",
  "-k",
  "--skip",
  "--passWithNoTests",
  "--only",
])

export function fileSha256(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex")
  } catch {
    return undefined
  }
}

function commandString(cmd: CommandOutcomeRecord): string {
  return [cmd.command, ...cmd.args].join(" ").trim()
}

function normalizeExeName(exe: string): string {
  return path
    .basename(exe.trim())
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "")
}

export function tokenizeCommandLine(commandLine: string): {
  readonly tokens: string[]
  readonly hasShellMeta: boolean
} {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let hasToken = false
  let hasShellMeta = false

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i]!
    if (ch === "\\" && !inSingle && i + 1 < commandLine.length) {
      current += commandLine[i + 1]!
      hasToken = true
      i += 1
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      hasToken = true
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      hasToken = true
      continue
    }
    if (!inSingle && !inDouble) {
      if (ch === "&" || ch === "|" || ch === ";" || ch === "<" || ch === ">" || ch === "`") {
        hasShellMeta = true
      }
      if (ch === "$" && commandLine[i + 1] === "(") {
        hasShellMeta = true
      }
      if (/\s/.test(ch)) {
        if (hasToken) {
          tokens.push(current)
          current = ""
          hasToken = false
        }
        continue
      }
    }
    current += ch
    hasToken = true
  }
  if (hasToken) tokens.push(current)
  return { tokens, hasShellMeta }
}

function looksLikeVerificationCommand(cmd: CommandOutcomeRecord): boolean {
  const exe = normalizeExeName(cmd.command)
  const a0 = (cmd.args[0] ?? "").toLowerCase()
  const a1 = (cmd.args[1] ?? "").toLowerCase()
  if (
    exe === "pytest" ||
    exe === "vitest" ||
    exe === "jest" ||
    exe === "mocha" ||
    exe === "ava" ||
    exe === "tap" ||
    exe === "tsc" ||
    exe === "oxlint" ||
    exe === "eslint"
  ) {
    return true
  }
  if (
    exe === "node" &&
    (cmd.args.includes("--test") || cmd.args.some((a) => /\.(?:test|spec)\.[cm]?[jt]s$/i.test(a)))
  ) {
    return true
  }
  if (
    (exe === "python" || exe === "python3") &&
    a0 === "-m" &&
    (a1 === "pytest" || a1 === "unittest")
  ) {
    return true
  }
  if (exe === "go" && a0 === "test") return true
  if (exe === "cargo" && (a0 === "test" || a0 === "check" || a0 === "clippy")) return true
  if (
    (exe === "npm" || exe === "pnpm" || exe === "yarn" || exe === "bun") &&
    (a0 === "test" ||
      (a0 === "run" && ["test", "lint", "check", "typecheck", "verify"].includes(a1)))
  ) {
    return true
  }
  return false
}

export function matchesCriterionCommand(
  declaredCommand: string,
  observedCmd: CommandOutcomeRecord,
): boolean {
  const { tokens, hasShellMeta } = tokenizeCommandLine(declaredCommand.trim())
  if (tokens.length === 0 || hasShellMeta) return false
  const declExe = normalizeExeName(tokens[0]!)
  const obsExe = normalizeExeName(observedCmd.command)
  if (!declExe || obsExe !== declExe) return false

  const declArgs = tokens.slice(1)
  if (observedCmd.args.length < declArgs.length) return false
  for (let i = 0; i < declArgs.length; i += 1) {
    if (observedCmd.args[i] !== declArgs[i]) return false
  }
  // Extra args (e.g. targeting a specific test file) cannot silently filter or skip tests.
  const extraArgs = observedCmd.args.slice(declArgs.length)
  for (const extra of extraArgs) {
    const flagName = extra.split("=")[0]!
    if (TEST_FILTER_FLAGS.has(flagName)) return false
  }
  return true
}

function sameCommandInvocation(a: CommandOutcomeRecord, b: CommandOutcomeRecord): boolean {
  if (normalizeExeName(a.command) !== normalizeExeName(b.command)) return false
  if (a.args.length !== b.args.length) return false
  return (
    a.args.every((val, idx) => val === b.args[idx]) && path.resolve(a.cwd) === path.resolve(b.cwd)
  )
}

export interface BuildProofPackInput {
  readonly runId: string
  readonly workspace?: string
  readonly outcome: RunSummaryRecord["outcome"]
  readonly finalText: string
  readonly baseline?: WorkspaceBaseline
  readonly commands: readonly CommandOutcomeRecord[]
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly testIntegrity: readonly TestIntegrityFinding[]
  readonly contract?: TaskContract
  readonly evidenceFile: string
  readonly lastMutationOrder?: number
  readonly unobservableMutations?: boolean
}

export function buildProofPack(input: BuildProofPackInput): ProofPackManifest {
  const evVerify = existsSync(input.evidenceFile)
    ? verifyEvidenceFile(input.evidenceFile)
    : { ok: false as const, entries: 0, reason: "evidence log not created" }
  const evidenceChainOk = evVerify.ok
  const evidenceEntries = evVerify.entries

  const rawChecks: ProofCheckRecord[] = []
  const lastMutationOrder = input.lastMutationOrder

  for (const [idx, cmd] of input.commands.entries()) {
    const cmdText = commandString(cmd)
    const kind: ProofCheckRecord["kind"] = looksLikeVerificationCommand(cmd) ? "test" : "command"
    if (cmd.decision === "denied") {
      rawChecks.push({
        id: `cmd-${idx + 1}`,
        name: cmdText,
        kind,
        status: "not_run",
        command: cmdText,
        cwd: cmd.cwd,
        ...(cmd.outputDigest ? { outputDigest: cmd.outputDigest } : {}),
        ...(cmd.evidenceSeq !== undefined ? { evidenceSeq: cmd.evidenceSeq } : {}),
        ...(cmd.evidenceHash ? { evidenceHash: cmd.evidenceHash } : {}),
      })
      continue
    }
    const passed = !cmd.timedOut && cmd.signal === null && cmd.exitCode === 0
    const isStale =
      passed &&
      lastMutationOrder !== undefined &&
      cmd.actionOrder !== undefined &&
      cmd.actionOrder < lastMutationOrder
    rawChecks.push({
      id: `cmd-${idx + 1}`,
      name: cmdText,
      kind,
      status: passed ? "passed" : "failed",
      command: cmdText,
      cwd: cmd.cwd,
      exitCode: cmd.exitCode,
      ...(cmd.outputDigest ? { outputDigest: cmd.outputDigest } : {}),
      ...(cmd.evidenceSeq !== undefined ? { evidenceSeq: cmd.evidenceSeq } : {}),
      ...(cmd.evidenceHash ? { evidenceHash: cmd.evidenceHash } : {}),
      ...(isStale ? { stale: true } : {}),
    })
  }

  // Mark earlier failures as superseded only if the exact same invocation subsequently passed on the final state.
  const checks: ProofCheckRecord[] = rawChecks.map((chk, idx) => {
    if (chk.status !== "failed") return chk
    const failedCmd = input.commands[idx]!
    const hasLaterFreshPass = rawChecks.some((laterChk, laterIdx) => {
      if (laterIdx <= idx || laterChk.status !== "passed" || laterChk.stale) return false
      return sameCommandInvocation(failedCmd, input.commands[laterIdx]!)
    })
    return hasLaterFreshPass ? { ...chk, superseded: true } : chk
  })

  const freshPassingChecks = checks.filter((c) => c.status === "passed" && !c.stale)
  const freshPassingTests = freshPassingChecks.filter((c) => c.kind === "test")
  const stalePassingChecks = checks.filter((c) => c.status === "passed" && c.stale)
  const unresolvedFailedChecks = checks.filter((c) => c.status === "failed" && !c.superseded)

  const criteria: CriterionOutcomeRecord[] = []
  if (input.contract) {
    for (const c of input.contract.criteria) {
      if (c.status === "dropped") {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "dropped",
        })
        continue
      }
      const declaredCmd = c.command?.trim()
      if (!declaredCmd) {
        const hasFreshTestPass = freshPassingTests.length > 0
        const hasUnresolvedFailure = unresolvedFailedChecks.length > 0
        const status: CriterionOutcomeRecord["status"] = hasUnresolvedFailure
          ? "failed"
          : hasFreshTestPass
            ? "passed"
            : "not_run"
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status,
          ...(c.check ? { checkId: c.check } : {}),
          ...(status === "not_run"
            ? {
                reason: stalePassingChecks.some((ch) => ch.kind === "test")
                  ? "Verification command ran before later workspace edits; re-run on the final state."
                  : "No passing verification command observed for this criterion.",
              }
            : {}),
        })
        continue
      }
      const matchingApproved = input.commands
        .map((cmd, idx) => ({ cmd, chk: checks[idx]! }))
        .filter(
          ({ cmd }) => cmd.decision === "approved" && matchesCriterionCommand(declaredCmd, cmd),
        )
      const lastEntry = matchingApproved.at(-1)
      if (!lastEntry) {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "not_run",
          checkId: declaredCmd,
          reason: `Required command '${declaredCmd}' was not run.`,
        })
      } else if (lastEntry.chk.status === "passed" && !lastEntry.chk.stale) {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "passed",
          checkId: declaredCmd,
        })
      } else if (lastEntry.chk.status === "passed" && lastEntry.chk.stale) {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "not_run",
          checkId: declaredCmd,
          reason: `Command '${declaredCmd}' passed before later workspace edits and is now stale.`,
        })
      } else {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "failed",
          checkId: declaredCmd,
          reason: `Command '${declaredCmd}' exited ${lastEntry.cmd.exitCode ?? "unknown"}.`,
        })
      }
    }
  }

  const unverifiedReasons: string[] = []
  if (!evidenceChainOk) {
    unverifiedReasons.push(`Evidence chain check failed (${evVerify.ok ? "" : evVerify.reason}).`)
  }
  if (input.baseline?.partial) {
    unverifiedReasons.push(
      `Workspace baseline scan was partial (${input.baseline.partialReason ?? "bounded"}); integrity is incomplete.`,
    )
  }
  if (input.unobservableMutations) {
    unverifiedReasons.push(
      "Workspace filesystem changes after command execution exceeded scan bounds and could not be fully observed.",
    )
  }
  if (unresolvedFailedChecks.length > 0) {
    unverifiedReasons.push(`${unresolvedFailedChecks.length} executed command/check(s) failed.`)
  }
  const declinedChecks = checks.filter((c) => c.status === "not_run")
  if (declinedChecks.length > 0) {
    unverifiedReasons.push(
      `${declinedChecks.length} proposed command/check(s) were not run (declined).`,
    )
  }
  if (input.testIntegrity.length > 0) {
    unverifiedReasons.push(
      `${input.testIntegrity.length} TestGuard integrity finding(s) recorded during run.`,
    )
  }
  if (stalePassingChecks.length > 0 && freshPassingChecks.length === 0) {
    unverifiedReasons.push(
      "Workspace was modified after the last passing verification command; re-run checks on the final state.",
    )
  }
  if (input.changedTests.length > 0 && freshPassingTests.length === 0) {
    unverifiedReasons.push(
      "Test files were modified with no fresh passing verification command on the final state.",
    )
  } else if (input.changedFiles.length > 0 && freshPassingChecks.length === 0) {
    unverifiedReasons.push(
      "Workspace files were modified without any fresh passing verification command.",
    )
  }
  if (input.contract) {
    for (const cr of criteria) {
      if (cr.required && (cr.status === "failed" || cr.status === "not_run")) {
        unverifiedReasons.push(`Required contract criterion '${cr.id}' is ${cr.status}.`)
      }
    }
  }
  const claimsSuccessInText = FALSE_CLAIM_PATTERN.test(input.finalText)
  if (claimsSuccessInText && freshPassingChecks.length === 0) {
    unverifiedReasons.push(
      "Model output claimed passing checks/tests without observed fresh passing command evidence.",
    )
  }

  let claimStatus: ClaimStatus
  if (input.outcome === "cancelled") {
    claimStatus = "cancelled"
  } else if (input.outcome === "budget_stopped") {
    claimStatus = "budget_stopped"
  } else if (input.outcome === "failed") {
    claimStatus = "failed"
  } else if (input.outcome === "uncertain") {
    claimStatus = "inconclusive"
  } else if (unverifiedReasons.length === 0) {
    claimStatus = "verified"
  } else if (
    unresolvedFailedChecks.length > 0 ||
    input.testIntegrity.length > 0 ||
    input.unobservableMutations ||
    Boolean(input.baseline?.partial) ||
    criteria.some((cr) => cr.required && cr.status === "failed") ||
    !evidenceChainOk
  ) {
    claimStatus = "inconclusive"
  } else {
    claimStatus = "done_unverified"
  }

  return {
    version: 1,
    runId: input.runId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.baseline ? { baseline: input.baseline } : {}),
    checks,
    criteria,
    testIntegrity: input.testIntegrity,
    verified: claimStatus === "verified",
    claimStatus,
    unverifiedReasons,
    ...(input.unobservableMutations ? { unobservableMutations: true } : {}),
    evidenceFile: input.evidenceFile,
    evidenceEntries,
    evidenceChainOk,
  }
}

export function verifyProofPack(manifest: ProofPackManifest): {
  readonly ok: boolean
  readonly issues: readonly string[]
} {
  const issues: string[] = []
  if (manifest.version !== 1)
    issues.push(`Unsupported ProofPack version: ${String(manifest.version)}`)
  const entriesBySeq = new Map<number, EvidenceEntry>()
  if (!existsSync(manifest.evidenceFile)) {
    issues.push(`Missing evidence file: ${manifest.evidenceFile}`)
  } else {
    const ev = verifyEvidenceFile(manifest.evidenceFile)
    if (!ev.ok) {
      issues.push(`Evidence chain verification failed: ${ev.reason}`)
    } else {
      if (ev.entries < manifest.evidenceEntries) {
        issues.push(
          `Evidence file has fewer entries (${ev.entries}) than ProofPack declared (${manifest.evidenceEntries}).`,
        )
      }
      try {
        const lines = readFileSync(manifest.evidenceFile, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
        for (const line of lines) {
          const parsed = JSON.parse(line) as EvidenceEntry
          entriesBySeq.set(parsed.seq, parsed)
        }
      } catch {
        issues.push(`Could not parse evidence entries from ${manifest.evidenceFile}`)
      }
    }
  }
  if (manifest.verified || manifest.claimStatus === "verified") {
    if (!manifest.verified || manifest.claimStatus !== "verified") {
      issues.push(
        `ProofPack inconsistent verified (${String(manifest.verified)}) vs claimStatus (${manifest.claimStatus}).`,
      )
    }
    if (!manifest.evidenceChainOk) {
      issues.push("ProofPack claims verified=true while evidenceChainOk=false.")
    }
    if (manifest.unverifiedReasons.length > 0) {
      issues.push("ProofPack claims verified=true despite non-empty unverifiedReasons.")
    }
    if (manifest.baseline?.partial) {
      issues.push("ProofPack claims verified=true despite partial baseline scan.")
    }
    if (manifest.unobservableMutations) {
      issues.push("ProofPack claims verified=true despite unobservable workspace mutations.")
    }
    if (manifest.checks.some((c) => c.status === "failed" && !c.superseded)) {
      issues.push("ProofPack claims verified=true despite unresolved failed check(s).")
    }
    if (manifest.checks.some((c) => c.status === "not_run")) {
      issues.push("ProofPack claims verified=true despite declined/not_run check(s).")
    }
    if (manifest.checks.some((c) => c.status === "passed" && c.stale)) {
      const hasFresh = manifest.checks.some((c) => c.status === "passed" && !c.stale)
      if (!hasFresh) {
        issues.push("ProofPack claims verified=true with only stale check(s).")
      }
    }
    if (
      manifest.criteria.some((c) => c.required && (c.status === "failed" || c.status === "not_run"))
    ) {
      issues.push("ProofPack claims verified=true despite unmet required criterion.")
    }
    if (manifest.testIntegrity.length > 0) {
      issues.push("ProofPack claims verified=true despite TestGuard findings.")
    }
    for (const chk of manifest.checks) {
      if (chk.status !== "passed") continue
      if (chk.evidenceSeq === undefined || !chk.evidenceHash) {
        issues.push(`Passed check '${chk.id}' lacks linked evidenceSeq/evidenceHash.`)
        continue
      }
      const evEntry = entriesBySeq.get(chk.evidenceSeq)
      if (!evEntry) {
        issues.push(`Passed check '${chk.id}' references missing evidence seq ${chk.evidenceSeq}.`)
        continue
      }
      if (evEntry.hash !== chk.evidenceHash) {
        issues.push(`Passed check '${chk.id}' evidenceHash mismatch at seq ${chk.evidenceSeq}.`)
      }
      if (
        evEntry.phase !== "after" ||
        evEntry.payload.status !== "completed" ||
        evEntry.payload.exit !== 0
      ) {
        issues.push(
          `Passed check '${chk.id}' linked evidence seq ${chk.evidenceSeq} does not record a passing exit=0 completion.`,
        )
      }
      if (evEntry.call.sessionID !== manifest.runId) {
        issues.push(
          `Passed check '${chk.id}' linked evidence seq ${chk.evidenceSeq} belongs to run '${evEntry.call.sessionID}', not '${manifest.runId}'.`,
        )
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function renderProofSummary(result: TaskResult): string {
  const lines: string[] = []
  const pack = result.proofPack
  const claim = result.claimStatus ?? pack?.claimStatus ?? "inconclusive"
  lines.push(`Claim: ${claim} (${pack?.verified ? "verified" : "unverified"})`)
  if (pack && pack.unverifiedReasons.length > 0) {
    for (const reason of pack.unverifiedReasons) {
      lines.push(`  Reason: ${reason}`)
    }
  }
  if (pack && pack.checks.length > 0) {
    for (const check of pack.checks) {
      const code =
        check.exitCode !== undefined && check.exitCode !== null ? ` (exit ${check.exitCode})` : ""
      lines.push(`  Check [${check.status}] ${check.name}${code}`)
    }
  } else {
    lines.push("  Check [not_run] no verification commands executed")
  }
  if (pack && pack.criteria.length > 0) {
    for (const c of pack.criteria) {
      lines.push(`  Criterion [${c.status}] ${c.id}: ${c.statement}`)
    }
  }
  if (pack && pack.testIntegrity.length > 0) {
    for (const f of pack.testIntegrity) {
      lines.push(`  TestGuard [${f.kind}] ${f.path}: ${f.detail}`)
    }
  }
  if (pack) {
    lines.push(
      `  Evidence chain: ${pack.evidenceChainOk ? "ok" : "FAILED"} (${pack.evidenceEntries} entries) [${path.basename(pack.evidenceFile)}]`,
    )
  }
  return lines.join("\n")
}

export function exportProofBundle(
  summary: RunSummaryRecord,
  options: { readonly format: "json" | "md" },
): string {
  const evidenceSha256 = fileSha256(summary.evidenceFile)
  if (options.format === "json") {
    return `${JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        runId: summary.runId,
        workspace: summary.workspace,
        outcome: summary.outcome,
        claimStatus: summary.claimStatus ?? summary.proofPack?.claimStatus ?? "inconclusive",
        ...(summary.contractId
          ? { contractId: summary.contractId, contractRevision: summary.contractRevision }
          : {}),
        changedFiles: summary.changedFiles,
        changedTests: summary.changedTests,
        proofPack: summary.proofPack ?? null,
        evidenceFile: summary.evidenceFile,
        ...(evidenceSha256 ? { evidenceFileSha256: evidenceSha256 } : {}),
      },
      null,
      2,
    )}\n`
  }

  const pack = summary.proofPack
  const lines = [
    `# Bashwink Proof & Evidence Export (${summary.runId})`,
    "",
    `- **Workspace:** \`${summary.workspace}\``,
    `- **Outcome:** \`${summary.outcome}\``,
    `- **Claim status:** \`${summary.claimStatus ?? pack?.claimStatus ?? "inconclusive"}\``,
    `- **Changed files:** ${summary.changedFiles.length > 0 ? summary.changedFiles.map((f) => `\`${f}\``).join(", ") : "none"}`,
    `- **Evidence file:** \`${summary.evidenceFile}\`${evidenceSha256 ? ` (sha256: \`${evidenceSha256}\`)` : ""}`,
    "",
    "## Checks",
    ...(pack && pack.checks.length > 0
      ? pack.checks.map(
          (c) =>
            `- [${c.status}] \`${c.name}\`${c.exitCode !== undefined && c.exitCode !== null ? ` (exit ${c.exitCode})` : ""}${c.evidenceSeq !== undefined ? ` [seq=${c.evidenceSeq}]` : ""}`,
        )
      : ["- [not_run] No verification commands executed."]),
  ]
  if (pack && pack.criteria.length > 0) {
    lines.push("", "## Criteria")
    for (const cr of pack.criteria) {
      lines.push(
        `- [${cr.status}] \`${cr.id}\`: ${cr.statement}${cr.reason ? ` — ${cr.reason}` : ""}`,
      )
    }
  }
  if (pack && pack.testIntegrity.length > 0) {
    lines.push("", "## TestGuard Findings")
    for (const f of pack.testIntegrity) {
      lines.push(`- [${f.kind}] \`${f.path}\`: ${f.detail}`)
    }
  }
  if (pack && pack.unverifiedReasons.length > 0) {
    lines.push("", "## ClaimGuard Reasons")
    for (const r of pack.unverifiedReasons) {
      lines.push(`- ${r}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}
