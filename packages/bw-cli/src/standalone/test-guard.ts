/**
 * TestGuard — structural test-integrity detection and post-command tamper auditing (BW-058).
 *
 * Guarantees & limitations:
 * - Guarantees: detects syntactic test deletion, `.skip`/`.todo`/`.only` modifiers, reduced
 *   assertion counts, trivial always-true assertions (`expect(true).toBe(true)`, etc.),
 *   `package.json` test-script neutering (no-op commands, `|| true`, `--passWithNoTests`),
 *   and out-of-band shell modifications to protected test/`package.json` SHA-256 hashes.
 * - Limitations: regex-based syntactic inspection does not execute semantic mutation testing
 *   or follow arbitrary helper-function indirections; `ProofPack` still requires passing
 *   verification command evidence on the final workspace state.
 */

import path from "node:path"
import { diffProtectedHashes, collectProtectedFileHashesBounded } from "./baseline.ts"
import { isTestPath } from "./security.ts"
import type { TestIntegrityFinding } from "./types.ts"

const TEST_CASE_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test)\s*(?:\.(?:skip|only|todo|concurrent|each|skipIf|runIf)\s*)?\(/g,
  /^\s*def\s+test_[A-Za-z0-9_]+\s*\(/gm,
  /^\s*func\s+Test[A-Za-z0-9_]+\s*\(/gm,
  /#\[test\]/g,
]

const SKIP_MODIFIER_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe)\.(?:skip|todo)\b/g,
  /\b(?:it|test|describe)\.(?:skipIf|runIf)\s*\(/g,
  /\b(?:xit|xtest|xdescribe)\s*\(/g,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bt\.(?:Skip|SkipNow)\s*\(/g,
  /#\[ignore\b/g,
]

const ONLY_MODIFIER_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe)\.only\b/g,
  /\bf(?:it|describe)\s*\(/g,
]

const ASSERTION_PATTERNS: readonly RegExp[] = [
  /\bexpect\s*\(/g,
  /\bassert(?:\.[A-Za-z0-9_]+)?\s*\(/g,
  /^\s*assert\s+/gm,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\bassert(?:_eq|_ne)?!\s*\(/g,
]

const TRIVIAL_TRUE_ASSERTIONS: readonly RegExp[] = [
  /\bexpect\s*\(\s*(?:true|1)\s*\)\s*\.to(?:Be|Equal|StrictEqual)\s*\(\s*(?:true|1)\s*\)/g,
  /\bexpect\s*\(\s*false\s*\)\s*\.to(?:Be|Equal|StrictEqual)\s*\(\s*false\s*\)/g,
  /\bassert\.(?:strictEqual|equal|deepEqual|deepStrictEqual)\s*\(\s*(?:true|1)\s*,\s*(?:true|1)\s*\)/g,
  /\bassert(?:\.ok)?\s*\(\s*(?:true|1)\s*\)/g,
  /^\s*assert\s+(?:True|1\s*==\s*1)\b/gm,
]

function stripCommentLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|#(?!!|\[)|\*|\/\*)/.test(line))
    .join("\n")
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`
    const cloned = new RegExp(re.source, flags)
    const matches = text.match(cloned)
    if (matches) count += matches.length
  }
  return count
}

export function countTestCases(text: string): number {
  return countMatches(stripCommentLines(text), TEST_CASE_PATTERNS)
}

export function countAssertions(text: string): number {
  const clean = stripCommentLines(text)
  const total = countMatches(clean, ASSERTION_PATTERNS)
  const trivial = countMatches(clean, TRIVIAL_TRUE_ASSERTIONS)
  return Math.max(0, total - trivial)
}

function isTrivialTestScript(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  return (
    trimmed === "" ||
    trimmed === "true" ||
    trimmed === ":" ||
    trimmed === "exit 0" ||
    /^echo\b/.test(trimmed) ||
    /^printf\b/.test(trimmed) ||
    /(?:\|\||;|&&)\s*(?:true|exit\s+0|:)\s*$/.test(trimmed) ||
    /--passwithnotests\b/.test(trimmed) ||
    /\bnode\s+-e\s+["']process\.exit\(0\)["']/.test(trimmed)
  )
}

function inspectPackageJsonTestScripts(
  relativePath: string,
  beforeNormalized: string | null,
  afterNormalized: string,
): readonly TestIntegrityFinding[] {
  if (beforeNormalized === null) return []
  let beforePkg: Record<string, unknown>
  let afterPkg: Record<string, unknown>
  try {
    beforePkg = JSON.parse(beforeNormalized) as Record<string, unknown>
    afterPkg = JSON.parse(afterNormalized) as Record<string, unknown>
  } catch {
    return [
      {
        kind: "script_weakened",
        path: relativePath,
        detail: `Modified '${relativePath}' resulted in invalid JSON affecting project scripts.`,
        severity: "block_auto",
      },
    ]
  }
  const beforeScripts =
    typeof beforePkg["scripts"] === "object" && beforePkg["scripts"] !== null
      ? (beforePkg["scripts"] as Record<string, unknown>)
      : {}
  const afterScripts =
    typeof afterPkg["scripts"] === "object" && afterPkg["scripts"] !== null
      ? (afterPkg["scripts"] as Record<string, unknown>)
      : {}

  const findings: TestIntegrityFinding[] = []
  for (const [name, oldVal] of Object.entries(beforeScripts)) {
    if (name !== "test" && !name.startsWith("test:")) continue
    if (typeof oldVal !== "string") continue
    const newVal = afterScripts[name]
    if (typeof newVal !== "string") {
      findings.push({
        kind: "script_weakened",
        path: relativePath,
        detail: `Removed script '${name}' from '${relativePath}'.`,
        severity: "block_auto",
      })
      continue
    }
    if (newVal !== oldVal && isTrivialTestScript(newVal)) {
      findings.push({
        kind: "script_weakened",
        path: relativePath,
        detail: `Weakened script '${name}' in '${relativePath}' to a no-op ('${newVal}').`,
        severity: "block_auto",
      })
    }
  }
  return findings
}

export function inspectTestEdit(
  relativePath: string,
  beforeNormalized: string | null,
  afterNormalized: string,
): readonly TestIntegrityFinding[] {
  const normalizedRel = relativePath.replace(/\\/g, "/")
  if (path.posix.basename(normalizedRel) === "package.json") {
    return inspectPackageJsonTestScripts(normalizedRel, beforeNormalized, afterNormalized)
  }
  if (!isTestPath(normalizedRel) || beforeNormalized === null) {
    return []
  }

  const findings: TestIntegrityFinding[] = []
  const beforeClean = stripCommentLines(beforeNormalized)
  const afterClean = stripCommentLines(afterNormalized)

  const beforeSkips = countMatches(beforeClean, SKIP_MODIFIER_PATTERNS)
  const afterSkips = countMatches(afterClean, SKIP_MODIFIER_PATTERNS)
  if (afterSkips > beforeSkips) {
    findings.push({
      kind: "skipped_test",
      path: normalizedRel,
      detail: `Added ${afterSkips - beforeSkips} skip modifier(s) in '${normalizedRel}'.`,
      removedCount: afterSkips - beforeSkips,
      severity: "block_auto",
    })
  }

  const beforeOnly = countMatches(beforeClean, ONLY_MODIFIER_PATTERNS)
  const afterOnly = countMatches(afterClean, ONLY_MODIFIER_PATTERNS)
  if (afterOnly > beforeOnly) {
    findings.push({
      kind: "only_test",
      path: normalizedRel,
      detail: `Added ${afterOnly - beforeOnly} '.only' focus filter(s) in '${normalizedRel}'.`,
      removedCount: afterOnly - beforeOnly,
      severity: "block_auto",
    })
  }

  const beforeTests = countTestCases(beforeNormalized)
  const afterTests = countTestCases(afterNormalized)
  if (afterTests < beforeTests) {
    findings.push({
      kind: "deleted_test",
      path: normalizedRel,
      detail: `Test case count dropped from ${beforeTests} to ${afterTests} in '${normalizedRel}'.`,
      removedCount: beforeTests - afterTests,
      severity: "block_auto",
    })
  } else if (beforeNormalized.trim().length > 0 && afterNormalized.trim().length === 0) {
    findings.push({
      kind: "deleted_test",
      path: normalizedRel,
      detail: `Cleared test file '${normalizedRel}'.`,
      removedCount: Math.max(1, beforeTests),
      severity: "block_auto",
    })
  }

  const beforeAssertions = countAssertions(beforeNormalized)
  const afterAssertions = countAssertions(afterNormalized)
  const beforeTrivial = countMatches(beforeClean, TRIVIAL_TRUE_ASSERTIONS)
  const afterTrivial = countMatches(afterClean, TRIVIAL_TRUE_ASSERTIONS)
  if (afterAssertions < beforeAssertions || afterTrivial > beforeTrivial) {
    findings.push({
      kind: "weakened_assertion",
      path: normalizedRel,
      detail:
        afterTrivial > beforeTrivial
          ? `Replaced meaningful assertions with trivial always-true assertions in '${normalizedRel}'.`
          : `Assertion count decreased from ${beforeAssertions} to ${afterAssertions} in '${normalizedRel}'.`,
      ...(afterAssertions < beforeAssertions
        ? { removedCount: beforeAssertions - afterAssertions }
        : {}),
      severity: "block_auto",
    })
  }

  return findings
}

export function inspectShellProtectedFileDelta(
  workspace: string,
  beforeHashes: Readonly<Record<string, string>>,
): {
  readonly findings: readonly TestIntegrityFinding[]
  readonly afterHashes: Readonly<Record<string, string>>
  readonly changedProtectedFiles: readonly string[]
  readonly partial: boolean
  readonly partialReason?: string
} {
  const scan = collectProtectedFileHashesBounded(workspace)
  const afterHashes = scan.hashes
  const delta = diffProtectedHashes(beforeHashes, afterHashes)
  const findings: TestIntegrityFinding[] = []

  for (const deletedFile of delta.deleted) {
    findings.push({
      kind: "deleted_test",
      path: deletedFile,
      detail: `Protected file '${deletedFile}' was deleted during shell command execution.`,
      severity: "block_auto",
    })
  }
  for (const modifiedFile of delta.modified) {
    findings.push({
      kind: "protected_file_tampered",
      path: modifiedFile,
      detail: `Protected file '${modifiedFile}' was modified outside edit_file during shell command execution.`,
      severity: "block_auto",
    })
  }

  return {
    findings,
    afterHashes,
    changedProtectedFiles: [...delta.modified, ...delta.deleted].sort(),
    partial: scan.partial,
    ...(scan.partialReason !== undefined ? { partialReason: scan.partialReason } : {}),
  }
}

export function formatTestGuardWarning(findings: readonly TestIntegrityFinding[]): string {
  return findings.map((f) => `[TestGuard:${f.kind}] ${f.detail}`).join("\n")
}
