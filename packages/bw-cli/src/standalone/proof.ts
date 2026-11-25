/**
 * ProofPack manifest builder, structural ClaimGuard, terminal ProofSummary renderer,
 * and evidence/proof export helpers (`BW-060`, `BW-061`, `BW-017`).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { verify as verifyEvidenceFile } from "../../../bw-evidence/src/recorder.ts"
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

function looksLikeVerificationCommand(cmdText: string): boolean {
  const lower = cmdText.toLowerCase()
  return (
    /\b(?:test|pytest|vitest|jest|mocha|ava|tap|unittest|typecheck|tsc|lint|check|verify)\b/.test(
      lower,
    ) ||
    /node\s+--test/.test(lower) ||
    /go\s+test/.test(lower) ||
    /cargo\s+(?:test|check)/.test(lower) ||
    /npm\s+run\s+(?:test|lint|check|typecheck|verify)/.test(lower)
  )
}

function matchesCriterionCommand(
  declaredCommand: string,
  observedCmd: CommandOutcomeRecord,
): boolean {
  const observed = commandString(observedCmd)
  if (observed === declaredCommand.trim()) return true
  return observed.includes(declaredCommand.trim())
}

export interface BuildProofPackInput {
  readonly runId: string
  readonly outcome: RunSummaryRecord["outcome"]
  readonly finalText: string
  readonly baseline?: WorkspaceBaseline
  readonly commands: readonly CommandOutcomeRecord[]
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly testIntegrity: readonly TestIntegrityFinding[]
  readonly contract?: TaskContract
  readonly evidenceFile: string
}

export function buildProofPack(input: BuildProofPackInput): ProofPackManifest {
  const evVerify = existsSync(input.evidenceFile)
    ? verifyEvidenceFile(input.evidenceFile)
    : { ok: false as const, entries: 0, reason: "evidence log not created" }
  const evidenceChainOk = evVerify.ok
  const evidenceEntries = evVerify.entries

  const checks: ProofCheckRecord[] = []
  let lastPassingCommandIdx = -1

  for (const [idx, cmd] of input.commands.entries()) {
    const cmdText = commandString(cmd)
    const kind: ProofCheckRecord["kind"] = looksLikeVerificationCommand(cmdText) ? "test" : "command"
    if (cmd.decision === "denied") {
      checks.push({
        id: `cmd-${idx + 1}`,
        name: cmdText,
        kind,
        status: "not_run",
        command: cmdText,
        ...(cmd.outputDigest ? { outputDigest: cmd.outputDigest } : {}),
        ...(cmd.evidenceSeq !== undefined ? { evidenceSeq: cmd.evidenceSeq } : {}),
        ...(cmd.evidenceHash ? { evidenceHash: cmd.evidenceHash } : {}),
      })
      continue
    }
    const passed = !cmd.timedOut && cmd.signal === null && cmd.exitCode === 0
    if (passed) lastPassingCommandIdx = idx
    checks.push({
      id: `cmd-${idx + 1}`,
      name: cmdText,
      kind,
      status: passed ? "passed" : "failed",
      command: cmdText,
      exitCode: cmd.exitCode,
      ...(cmd.outputDigest ? { outputDigest: cmd.outputDigest } : {}),
      ...(cmd.evidenceSeq !== undefined ? { evidenceSeq: cmd.evidenceSeq } : {}),
      ...(cmd.evidenceHash ? { evidenceHash: cmd.evidenceHash } : {}),
    })
  }

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
        const hasPassingVerification = checks.some(
          (ch) => ch.status === "passed" && (ch.kind === "test" || checks.length > 0),
        )
        const hasFailedCommand = checks.some((ch) => ch.status === "failed")
        const status: CriterionOutcomeRecord["status"] = hasFailedCommand
          ? "failed"
          : hasPassingVerification
            ? "passed"
            : "not_run"
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status,
          ...(c.check ? { checkId: c.check } : {}),
          ...(status === "not_run"
            ? { reason: "No passing verification command observed for this criterion." }
            : {}),
        })
        continue
      }
      const matchingApproved = input.commands.filter(
        (cmd) => cmd.decision === "approved" && matchesCriterionCommand(declaredCmd, cmd),
      )
      const lastMatch = matchingApproved.at(-1)
      if (!lastMatch) {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "not_run",
          checkId: declaredCmd,
          reason: `Required command '${declaredCmd}' was not run.`,
        })
      } else if (!lastMatch.timedOut && lastMatch.signal === null && lastMatch.exitCode === 0) {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "passed",
          checkId: declaredCmd,
        })
      } else {
        criteria.push({
          id: c.id,
          statement: c.statement,
          required: c.required,
          status: "failed",
          checkId: declaredCmd,
          reason: `Command '${declaredCmd}' exited ${lastMatch.exitCode ?? "unknown"}.`,
        })
      }
    }
  }

  const unverifiedReasons: string[] = []
  if (!evidenceChainOk) {
    unverifiedReasons.push(`Evidence chain check failed (${evVerify.ok ? "" : evVerify.reason}).`)
  }
  const failedChecks = checks.filter((c) => c.status === "failed")
  if (failedChecks.length > 0) {
    unverifiedReasons.push(`${failedChecks.length} executed command/check(s) failed.`)
  }
  const declinedChecks = checks.filter((c) => c.status === "not_run")
  if (declinedChecks.length > 0) {
    unverifiedReasons.push(`${declinedChecks.length} proposed command/check(s) were not run (declined).`)
  }
  if (input.testIntegrity.length > 0) {
    unverifiedReasons.push(
      `${input.testIntegrity.length} TestGuard integrity finding(s) recorded during run.`,
    )
  }
  const passingChecks = checks.filter((c) => c.status === "passed")
  if (input.changedTests.length > 0 && lastPassingCommandIdx < 0) {
    unverifiedReasons.push("Test files were modified with no passing verification command.")
  } else if (input.changedFiles.length > 0 && passingChecks.length === 0) {
    unverifiedReasons.push("Workspace files were modified without any passing verification command.")
  }
  if (input.contract) {
    for (const cr of criteria) {
      if (cr.required && (cr.status === "failed" || cr.status === "not_run")) {
        unverifiedReasons.push(`Required contract criterion '${cr.id}' is ${cr.status}.`)
      }
    }
  }
  const claimsSuccessInText = FALSE_CLAIM_PATTERN.test(input.finalText)
  if (claimsSuccessInText && passingChecks.length === 0) {
    unverifiedReasons.push(
      "Model output claimed passing checks/tests without observed passing command evidence.",
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
    failedChecks.length > 0 ||
    input.testIntegrity.length > 0 ||
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
    ...(input.baseline ? { baseline: input.baseline } : {}),
    checks,
    criteria,
    testIntegrity: input.testIntegrity,
    verified: claimStatus === "verified",
    claimStatus,
    unverifiedReasons,
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
  if (manifest.version !== 1) issues.push(`Unsupported ProofPack version: ${String(manifest.version)}`)
  if (!existsSync(manifest.evidenceFile)) {
    issues.push(`Missing evidence file: ${manifest.evidenceFile}`)
  } else {
    const ev = verifyEvidenceFile(manifest.evidenceFile)
    if (!ev.ok) issues.push(`Evidence chain verification failed: ${ev.reason}`)
    else if (ev.entries < manifest.evidenceEntries) {
      issues.push(
        `Evidence file has fewer entries (${ev.entries}) than ProofPack declared (${manifest.evidenceEntries}).`,
      )
    }
  }
  if (manifest.verified) {
    if (manifest.claimStatus !== "verified") {
      issues.push(`ProofPack claims verified=true with claimStatus=${manifest.claimStatus}`)
    }
    if (manifest.checks.some((c) => c.status === "failed")) {
      issues.push("ProofPack claims verified=true despite failed check(s).")
    }
    if (manifest.criteria.some((c) => c.required && (c.status === "failed" || c.status === "not_run"))) {
      issues.push("ProofPack claims verified=true despite unmet required criterion.")
    }
    if (manifest.testIntegrity.length > 0) {
      issues.push("ProofPack claims verified=true despite TestGuard findings.")
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
      const code = check.exitCode !== undefined && check.exitCode !== null ? ` (exit ${check.exitCode})` : ""
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
        ...(summary.contractId ? { contractId: summary.contractId, contractRevision: summary.contractRevision } : {}),
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
      lines.push(`- [${cr.status}] \`${cr.id}\`: ${cr.statement}${cr.reason ? ` — ${cr.reason}` : ""}`)
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
