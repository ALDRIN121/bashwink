/**
 * Standalone trust, workspace boundary, secret scrubbing, and hash-chained evidence helpers.
 *
 * Reuses Bashwink's pure tested modules directly:
 * - `trust.ts` (`readTrust`, `writeTrust`, `grantTrust`, `isTrusted`, `canonicalWorkspace`, `evaluateCall`)
 * - `bw-evidence/src/scope.ts` (`physicalPath`, `contains`)
 * - `bw-evidence/src/recorder.ts` (`EvidenceRecorder`, `redact`, `verify`)
 * - `test-changes.ts` (`isTestPath`)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { EvidenceRecorder, redact, registerSecretValues } from "../../../bw-evidence/src/recorder.ts"
import { contains, physicalPath } from "../../../bw-evidence/src/scope.ts"
import type { Paths } from "../paths.ts"
import { isTestPath } from "../test-changes.ts"
import { canonicalWorkspace, isTrusted, readTrust, writeTrust, grantTrust } from "../trust.ts"
import type {
  PermissionMode,
  RunSummaryRecord,
  SavedPermissionRule,
  StandaloneConfig,
} from "./types.ts"

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

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "manual",
  "accept-edits",
  "smart",
  "auto",
]

export function isValidPermissionMode(value: string): value is PermissionMode {
  return value === "manual" || value === "accept-edits" || value === "smart" || value === "auto"
}

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current)
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!
}

export function permissionModeLabel(mode: PermissionMode, compact = false): string {
  if (compact) {
    if (mode === "accept-edits") return "edits"
    return mode
  }
  return mode
}

export interface WorkspacePermissionState {
  readonly mode: PermissionMode
  readonly rules: readonly SavedPermissionRule[]
  readonly updatedAt: string
}

interface PermissionsStoreFile {
  readonly version: 1
  readonly workspaces: Record<string, WorkspacePermissionState>
}

export function permissionsFilePath(configDirectory: string): string {
  return path.join(configDirectory, "permissions.json")
}

function emptyWorkspacePermissions(): WorkspacePermissionState {
  return { mode: "manual", rules: [], updatedAt: "" }
}

function readPermissionsStore(filePath: string): PermissionsStoreFile {
  if (!existsSync(filePath)) return { version: 1, workspaces: {} }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return { version: 1, workspaces: {} }
    const obj = parsed as Record<string, unknown>
    if (obj["version"] !== 1 || typeof obj["workspaces"] !== "object" || obj["workspaces"] === null) {
      return { version: 1, workspaces: {} }
    }
    const clean: Record<string, WorkspacePermissionState> = {}
    for (const [ws, entry] of Object.entries(obj["workspaces"] as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue
      const e = entry as Record<string, unknown>
      const mode = typeof e["mode"] === "string" && isValidPermissionMode(e["mode"]) ? e["mode"] : "manual"
      const rules: SavedPermissionRule[] = []
      if (Array.isArray(e["rules"])) {
        for (const r of e["rules"]) {
          if (typeof r !== "object" || r === null) continue
          const ro = r as Record<string, unknown>
          if (
            (ro["tool"] === "edit_file" || ro["tool"] === "run_command") &&
            typeof ro["pattern"] === "string" &&
            ro["pattern"].trim() !== ""
          ) {
            rules.push({
              tool: ro["tool"],
              pattern: ro["pattern"],
              grantedAt: typeof ro["grantedAt"] === "string" ? ro["grantedAt"] : "",
            })
          }
        }
      }
      clean[ws] = {
        mode,
        rules,
        updatedAt: typeof e["updatedAt"] === "string" ? e["updatedAt"] : "",
      }
    }
    return { version: 1, workspaces: clean }
  } catch {
    return { version: 1, workspaces: {} }
  }
}

function writePermissionsStore(filePath: string, store: PermissionsStoreFile): void {
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.permissions.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, filePath)
}

export function loadWorkspacePermissions(
  configDirectory: string,
  workspace: string,
): WorkspacePermissionState {
  const canonical = canonicalWorkspace(workspace)
  const store = readPermissionsStore(permissionsFilePath(configDirectory))
  return store.workspaces[canonical] ?? emptyWorkspacePermissions()
}

export function setWorkspacePermissionMode(
  configDirectory: string,
  workspace: string,
  mode: PermissionMode,
): WorkspacePermissionState {
  const canonical = canonicalWorkspace(workspace)
  const file = permissionsFilePath(configDirectory)
  const store = readPermissionsStore(file)
  const current = store.workspaces[canonical] ?? emptyWorkspacePermissions()
  const updated: WorkspacePermissionState = {
    mode,
    rules: current.rules,
    updatedAt: new Date().toISOString(),
  }
  writePermissionsStore(file, {
    version: 1,
    workspaces: { ...store.workspaces, [canonical]: updated },
  })
  return updated
}

export function saveAlwaysPermissionRule(
  configDirectory: string,
  workspace: string,
  rule: { readonly tool: "edit_file" | "run_command"; readonly pattern: string },
): WorkspacePermissionState {
  const canonical = canonicalWorkspace(workspace)
  const file = permissionsFilePath(configDirectory)
  const store = readPermissionsStore(file)
  const current = store.workspaces[canonical] ?? emptyWorkspacePermissions()
  const already = current.rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern)
  const nextRules = already
    ? current.rules
    : [...current.rules, { tool: rule.tool, pattern: rule.pattern, grantedAt: new Date().toISOString() }]
  const updated: WorkspacePermissionState = {
    mode: current.mode,
    rules: nextRules,
    updatedAt: new Date().toISOString(),
  }
  writePermissionsStore(file, {
    version: 1,
    workspaces: { ...store.workspaces, [canonical]: updated },
  })
  return updated
}

export function clearWorkspacePermissionRules(
  configDirectory: string,
  workspace: string,
): WorkspacePermissionState {
  const canonical = canonicalWorkspace(workspace)
  const file = permissionsFilePath(configDirectory)
  const store = readPermissionsStore(file)
  const current = store.workspaces[canonical] ?? emptyWorkspacePermissions()
  const updated: WorkspacePermissionState = {
    mode: current.mode,
    rules: [],
    updatedAt: new Date().toISOString(),
  }
  writePermissionsStore(file, {
    version: 1,
    workspaces: { ...store.workspaces, [canonical]: updated },
  })
  return updated
}

/**
 * Simple iterative glob matcher supporting `*` and `?` without regex compilation / ReDoS.
 * Ported cleanly after OpenCode `packages/core/src/util/wildcard.ts`.
 */
export function globMatch(pattern: string, candidate: string): boolean {
  let pi = 0
  let ci = 0
  let starIdx = -1
  let matchIdx = 0

  while (ci < candidate.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === candidate[ci])) {
      pi += 1
      ci += 1
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi
      matchIdx = ci
      pi += 1
    } else if (starIdx !== -1) {
      pi = starIdx + 1
      matchIdx += 1
      ci = matchIdx
    } else {
      return false
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi += 1
  return pi === pattern.length
}

export function matchesPermissionRule(
  rules: readonly SavedPermissionRule[],
  tool: "edit_file" | "run_command",
  candidate: string,
): boolean {
  return rules.some((rule) => rule.tool === tool && globMatch(rule.pattern, candidate))
}

const PREFIX_SUBCOMMAND_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "cargo",
  "go",
  "pytest",
  "uv",
  "git",
  "tsc",
  "eslint",
  "oxlint",
])

const EXACT_ONLY_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "chmod",
  "chown",
  "chgrp",
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "rsync",
  "sudo",
  "su",
  "doas",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "env",
  "xargs",
])

export function suggestPermissionPattern(
  tool: "edit_file" | "run_command",
  targetOrCommand: string,
  args: readonly string[] = [],
): { readonly pattern: string; readonly summary: string } {
  if (tool === "edit_file") {
    return {
      pattern: "*",
      summary: "All edits inside this workspace (`edit_file:*`)",
    }
  }
  const base = path.basename(targetOrCommand.trim()).toLowerCase()
  const full = [targetOrCommand, ...args].join(" ").trim()
  if (!base || EXACT_ONLY_COMMANDS.has(base)) {
    return {
      pattern: full,
      summary: `Exact command \`${full}\``,
    }
  }
  if (PREFIX_SUBCOMMAND_RUNNERS.has(base)) {
    const firstArg = (args[0] ?? "").trim()
    const secondArg = (args[1] ?? "").trim()
    if (
      firstArg !== "" &&
      !firstArg.startsWith("-") &&
      !["push", "reset", "clean", "rebase", "eval", "exec"].includes(firstArg.toLowerCase())
    ) {
      if (base === "npm" && firstArg === "run" && secondArg !== "" && !secondArg.startsWith("-")) {
        const pat = `${targetOrCommand} run ${secondArg} *`
        return { pattern: pat, summary: `Commands matching \`${pat}\`` }
      }
      const pat = `${targetOrCommand} ${firstArg} *`
      return { pattern: pat, summary: `Commands matching \`${pat}\`` }
    }
  }
  return {
    pattern: full,
    summary: `Exact command \`${full}\``,
  }
}

/**
 * Quote-aware shell comment stripper ported from Hermes `tools/approval_smart.py` (`_strip_shell_comments`).
 * Strips `#` comments outside quotes/escapes before risk classification or LLM review so hidden
 * prompt-injection text inside shell comments never bypasses analysis.
 */
export function stripShellComments(command: string): string {
  const lines = command.split("\n")
  const outLines: string[] = []
  let inSingle = false
  let inDouble = false

  for (const line of lines) {
    let i = 0
    let cutAt: number | undefined
    while (i < line.length) {
      const ch = line[i]!
      if (ch === "\\" && !inSingle) {
        i += 2
        continue
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle
      } else if (ch === "\"" && !inSingle) {
        inDouble = !inDouble
      } else if (ch === "#" && !inSingle && !inDouble) {
        if (i === 0 || /\s|;|[|&()]/.test(line[i - 1]!)) {
          cutAt = i
          break
        }
      }
      i += 1
    }
    const kept = cutAt === undefined ? line : line.slice(0, cutAt).replace(/\s+$/, "")
    if (kept.trim() !== "") outLines.push(kept)
  }

  return outLines.join("\n")
}

export interface ActionSafetyAssessment {
  readonly hardBlockedFromAuto: boolean
  readonly autoSafeReadOnly: boolean
  readonly allowAlways: boolean
  readonly riskReason?: string
}

const HARD_RISK_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  {
    pattern: /(?:^|\s)rm\s+[^\n]*(?:-[rRf]*r[^\n]*-[rRf]*f|-[rRf]*f[^\n]*-[rRf]*r|-rf|-fr)\s+(?:\/|~|\*|\.\.)/,
    reason: "Recursive destructive `rm` against root, home, parent, or wildcard target",
  },
  {
    pattern: /(?:^|\s)(?:sudo|doas|su\s+-?|mkfs\b|fdisk\b|parted\b|shutdown\b|reboot\b|halt\b|dd\s+if=)/i,
    reason: "Privileged, disk-formatting, raw-device, or system power command",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    reason: "Fork bomb signature",
  },
  {
    pattern: /(?:curl|wget|fetch|nc|ncat|ssh|scp|rsync)\b[^\n]*(?:\|\s*(?:sh|bash|zsh|python|node)|\.ssh|\.aws|\.gnupg|API_KEY|SECRET|TOKEN)/i,
    reason: "Remote payload execution or credential/key-path network transfer",
  },
  {
    pattern: /(?:^|\s)git\s+(?:push\s+[^\n]*(?:--force|-f\b)|reset\s+--hard|clean\s+[^\n]*-f)/i,
    reason: "Destructive or history-rewriting git operation",
  },
  {
    pattern: /(?:^|\s)(?:chmod\s+(?:\+s|777)|chown\s+-R\s+root)\b/i,
    reason: "Unsafe permission/ownership escalation",
  },
]

const SAFE_READ_ONLY_EXECUTABLES = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "which",
  "stat",
  "file",
  "echo",
])

const SAFE_GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "branch", "show", "rev-parse"])
const SAFE_NODE_TEST_SCRIPTS = new Set(["test", "lint", "check", "typecheck", "build", "verify"])

function hasShellMetaChars(text: string): boolean {
  return /[|;&`<>]|\$\(/.test(text)
}

export function assessActionSafety(
  tool: "edit_file" | "run_command",
  targetOrCommand: string,
  args: readonly string[] = [],
): ActionSafetyAssessment {
  if (tool === "edit_file") {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: false,
      allowAlways: true,
    }
  }

  const rawJoined = [targetOrCommand, ...args].join(" ")
  const stripped = stripShellComments(rawJoined)
  for (const rule of HARD_RISK_PATTERNS) {
    if (rule.pattern.test(stripped)) {
      return {
        hardBlockedFromAuto: true,
        autoSafeReadOnly: false,
        allowAlways: false,
        riskReason: rule.reason,
      }
    }
  }

  const base = path.basename(targetOrCommand.trim()).toLowerCase()
  const argJoined = args.join(" ")
  const inlineExecShell =
    (base === "sh" || base === "bash" || base === "zsh" || base === "dash") ||
    ((base === "node" || base === "python" || base === "python3" || base === "perl" || base === "ruby") &&
      args.some((a) => a === "-e" || a === "-c" || a === "--eval"))

  if (inlineExecShell) {
    return {
      hardBlockedFromAuto: true,
      autoSafeReadOnly: false,
      allowAlways: false,
      riskReason: `Inline shell or code execution via '${base}' requires explicit approval`,
    }
  }

  if (hasShellMetaChars(stripped)) {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: false,
      allowAlways: true,
    }
  }

  if (SAFE_READ_ONLY_EXECUTABLES.has(base)) {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: !argJoined.includes(".."),
      allowAlways: true,
    }
  }

  if (base === "git" && args[0] && SAFE_GIT_READ_SUBCOMMANDS.has(args[0].toLowerCase())) {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: true,
      allowAlways: true,
    }
  }

  if (
    (base === "npm" || base === "pnpm" || base === "yarn" || base === "bun") &&
    ((args[0] === "test" && args.length <= 3) ||
      (args[0] === "run" && args[1] !== undefined && SAFE_NODE_TEST_SCRIPTS.has(args[1])))
  ) {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: true,
      allowAlways: true,
    }
  }

  if (base === "pytest" || (base === "go" && args[0] === "test") || (base === "cargo" && args[0] === "test")) {
    return {
      hardBlockedFromAuto: false,
      autoSafeReadOnly: true,
      allowAlways: true,
    }
  }

  return {
    hardBlockedFromAuto: false,
    autoSafeReadOnly: false,
    allowAlways: true,
  }
}
