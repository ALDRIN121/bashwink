/**
 * Standalone trust, workspace boundary, secret scrubbing, and hash-chained evidence helpers.
 *
 * Reuses Bashwink's pure tested modules directly:
 * - `trust.ts` (`readTrust`, `writeTrust`, `grantTrust`, `isTrusted`, `canonicalWorkspace`, `evaluateCall`)
 * - `bw-evidence/src/scope.ts` (`physicalPath`, `contains`)
 * - `bw-evidence/src/recorder.ts` (`EvidenceRecorder`, `redact`, `verify`)
 * - `test-changes.ts` (`isTestPath`)
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { EvidenceRecorder, redact, registerSecretValues } from "../../../bw-evidence/src/recorder.ts"
import { contains, physicalPath } from "../../../bw-evidence/src/scope.ts"
import type { Paths } from "../paths.ts"
import { isTestPath } from "../test-changes.ts"
import { canonicalWorkspace, isTrusted, readTrust, writeTrust, grantTrust } from "../trust.ts"
import type { RunSummaryRecord, StandaloneConfig } from "./types.ts"

export { EvidenceRecorder, redact, verify as verifyEvidenceFile } from "../../../bw-evidence/src/recorder.ts"
export { canonicalWorkspace, isTrusted, readTrust, writeTrust, grantTrust } from "../trust.ts"
export { physicalPath, contains } from "../../../bw-evidence/src/scope.ts"
export { isTestPath }

export function trustFilePath(configDirectory: string): string {
  return path.join(configDirectory, "trust.json")
}

export function isWorkspaceTrusted(configDirectory: string, workspace: string): boolean {
  return isTrusted(readTrust(trustFilePath(configDirectory)), workspace)
}

export function grantWorkspaceTrust(
  configDirectory: string,
  workspace: string,
  grantedBy: string,
): void {
  const file = trustFilePath(configDirectory)
  const updated = grantTrust(readTrust(file), workspace, grantedBy, new Date().toISOString())
  writeTrust(file, updated)
}

export interface BoundaryContext {
  readonly workspace: string
  readonly trusted: boolean
  readonly forbiddenWriteRoots: readonly string[]
  readonly forbiddenReadRoots: readonly string[]
}

export function createBoundaryContext(
  workspace: string,
  resolvedPaths: Paths,
  config: StandaloneConfig,
  env: NodeJS.ProcessEnv = process.env,
): BoundaryContext {
  const canonical = canonicalWorkspace(workspace)
  const trust = readTrust(path.join(resolvedPaths.config, "trust.json"))
  const trusted = isTrusted(trust, canonical)

  const protectedRoots = [
    resolvedPaths.config,
    resolvedPaths.data,
    resolvedPaths.cache,
    resolvedPaths.state,
    resolvedPaths.evidence,
  ].map((p) => physicalPath(p))

  const keyFileRoots: string[] = []
  if (config.credential.kind === "file") {
    keyFileRoots.push(physicalPath(config.credential.path))
  }

  const home = env["HOME"] ?? env["USERPROFILE"] ?? homedir()
  const foreignCredentialRoots = [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
  ].map((p) => physicalPath(p))

  const gitDir = physicalPath(path.join(canonical, ".git"))

  return {
    workspace: canonical,
    trusted,
    forbiddenReadRoots: [...protectedRoots, ...keyFileRoots, ...foreignCredentialRoots],
    forbiddenWriteRoots: [gitDir, ...protectedRoots, ...keyFileRoots, ...foreignCredentialRoots],
  }
}

export type PathCheckResult =
  | { readonly allow: true; readonly resolvedPath: string }
  | { readonly allow: false; readonly reason: string; readonly resolvedPath?: string }

export function checkWorkspaceReadPath(
  boundary: BoundaryContext,
  rawPath: string,
): PathCheckResult {
  if (rawPath.trim() === "") {
    return { allow: false, reason: "a readable path is required" }
  }
  let target: string
  try {
    target = physicalPath(path.resolve(boundary.workspace, rawPath))
  } catch {
    return { allow: false, reason: `could not resolve path '${rawPath}' safely` }
  }
  if (!contains(boundary.workspace, target)) {
    return {
      allow: false,
      resolvedPath: target,
      reason: `'${rawPath}' resolves to ${target}, outside workspace ${boundary.workspace}.`,
    }
  }
  if (boundary.forbiddenReadRoots.some((root) => contains(root, target))) {
    return {
      allow: false,
      resolvedPath: target,
      reason: `'${rawPath}' resolves inside protected configuration/credential path ${target}.`,
    }
  }
  return { allow: true, resolvedPath: target }
}

export function checkWorkspaceWritePath(
  boundary: BoundaryContext,
  rawPath: string,
): PathCheckResult {
  if (!boundary.trusted) {
    return {
      allow: false,
      reason: `workspace ${boundary.workspace} is not trusted (read-only mode); edits and commands are denied until trusted.`,
    }
  }
  if (rawPath.trim() === "") {
    return { allow: false, reason: "a writable file path is required" }
  }
  let target: string
  try {
    target = physicalPath(path.resolve(boundary.workspace, rawPath))
  } catch {
    return { allow: false, reason: `could not resolve path '${rawPath}' safely` }
  }
  if (!contains(boundary.workspace, target)) {
    return {
      allow: false,
      resolvedPath: target,
      reason: `'${rawPath}' resolves to ${target}, outside workspace ${boundary.workspace}.`,
    }
  }
  if (boundary.forbiddenWriteRoots.some((root) => contains(root, target))) {
    return {
      allow: false,
      resolvedPath: target,
      reason: `'${rawPath}' resolves to protected path ${target} (.git internals, Bashwink state, or credential file) and cannot be modified.`,
    }
  }
  return { allow: true, resolvedPath: target }
}

const SECRET_ENV_PATTERN =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|^OPENAI_|^ANTHROPIC_|^OPENROUTER_|^GEMINI_|^GOOGLE_GENERATIVE_AI_|^CMD_API_KEY$|^OPENCODE_)/i

/** Minimal child environment for `run_command` — never passes provider credentials or keys. */
export function scrubbedChildEnv(
  base: NodeJS.ProcessEnv,
  config: StandaloneConfig,
): Record<string, string> {
  const allowKeys =
    process.platform === "win32"
      ? [
          "PATH",
          "PATHEXT",
          "SystemRoot",
          "SYSTEMROOT",
          "ComSpec",
          "COMSPEC",
          "WINDIR",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "APPDATA",
          "LOCALAPPDATA",
          "TEMP",
          "TMP",
          "NUMBER_OF_PROCESSORS",
          "OS",
          "LANG",
        ]
      : ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ"]

  const declaredVar = config.credential.kind === "env" ? config.credential.variable : undefined
  const out: Record<string, string> = {}
  for (const key of allowKeys) {
    const val = base[key]
    if (val === undefined) continue
    if (key === declaredVar || SECRET_ENV_PATTERN.test(key)) continue
    out[key] = val
  }
  return out
}

export function sanitizeSecretText(text: string, activeSecret?: string): string {
  let out = String(redact(text))
  if (activeSecret && activeSecret.length >= 4) {
    out = out.split(activeSecret).join("[REDACTED]")
  }
  return out
}

export function createStandaloneRecorder(
  evidenceDir: string,
  _runId: string,
  activeSecret?: string,
): EvidenceRecorder {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  if (activeSecret) registerSecretValues([activeSecret])
  return new EvidenceRecorder({ directory: evidenceDir, file: "evidence.jsonl" })
}

export function saveRunRecord(dataDir: string, record: RunSummaryRecord): string {
  const runsDir = path.join(dataDir, "runs")
  mkdirSync(runsDir, { recursive: true, mode: 0o700 })
  const target = path.join(runsDir, `${record.runId}.json`)
  const temp = path.join(runsDir, `.${record.runId}.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, target)
  return target
}

export function findMissingFiles(files: readonly string[]): string[] {
  return files.filter((f) => !existsSync(f))
}
