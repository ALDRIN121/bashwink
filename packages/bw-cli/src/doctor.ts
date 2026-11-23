/**
 * `bashwink doctor` — precondition checks (BW-009).
 *
 * Acceptance: *"Missing preconditions produce actionable messages and nonzero exit; no
 * credentials printed."*
 *
 * Two rules this file is built around:
 *   1. A check reports `ok | warn | fail`, and the *summary* decides the exit code. Warnings
 *      do not fail the run, because a missing optional Docker must not look like a broken
 *      install.
 *   2. Credentials are reported as **present/absent plus a length and a fingerprint**, never
 *      a value or a prefix of one. A "last 4 characters" habit leaks enough to narrow a key
 *      search, and this output is designed to be pasteable into an issue.
 */

import { existsSync, readFileSync, accessSync, constants } from "node:fs"
import path from "node:path"
import { PINNED_RUNTIME_VERSION, RuntimeNotFoundError, resolveRuntime } from "./runtime.js"
import { paths, type Paths } from "./paths.js"
import { canonicalWorkspace, isTrusted, readTrust } from "./trust.js"

export type CheckStatus = "ok" | "warn" | "fail"

export interface Check {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  /** One line, always safe to print. */
  readonly detail: string
  /** Present when the check failed or warned: exactly what the user should do. */
  readonly fix?: string
}

export interface DoctorReport {
  readonly checks: readonly Check[]
  readonly ok: boolean
  /** 0 when every mandatory check passed, 1 otherwise. */
  readonly exitCode: number
  readonly summary: string
}

/** Environment variables that carry model/provider credentials. */
const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const

/**
 * Describe a secret without revealing it.
 *
 * Returns presence, length and a truncated SHA-256 — enough to tell "my key is set" from "a
 * *different* key is set" across two machines, without giving an attacker a substring to
 * search for. No prefix, no suffix.
 */
export function describeSecret(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "absent"
  const digest = sha256Hex(value).slice(0, 8)
  return `present (${value.trim().length} chars, sha256:${digest}…)`
}

/** Small local SHA-256 so `doctor` does not import the evidence package for one digest. */
function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex")
}

function which(binary: string): string | undefined {
  for (const entry of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, binary)
    if (existsSync(candidate)) {
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  return undefined
}

export interface DoctorOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Injected so the doctor itself is testable without a real repo. */
  readonly resolvedPaths?: Paths
}

/**
 * Run every check.
 *
 * Never throws: a doctor that crashes on a broken install is useless precisely when it is
 * needed. Errors become `fail` checks.
 */
export function diagnose(options: DoctorOptions = {}): DoctorReport {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const resolved = options.resolvedPaths ?? paths(env)
  const checks: Check[] = []

  // --- runtime -----------------------------------------------------------
  try {
    const runtime = resolveRuntime({ cwd })
    checks.push({
      id: "runtime",
      title: "OpenCode runtime",
      status: "ok",
      detail: `found ${runtime.command} (pinned ${PINNED_RUNTIME_VERSION}, via ${runtime.source})`,
    })
  } catch (error) {
    const message = error instanceof RuntimeNotFoundError ? error.message : String(error)
    checks.push({
      id: "runtime",
      title: "OpenCode runtime",
      status: "fail",
      detail: message.split("\n")[0] ?? message,
      fix: `bun add @opencode/cli@${PINNED_RUNTIME_VERSION}`,
    })
  }

  // --- bun / node --------------------------------------------------------
  checks.push({
    id: "bun",
    title: "Bun runtime",
    status: typeof Bun === "undefined" ? "fail" : "ok",
    detail:
      typeof Bun === "undefined"
        ? "not running under Bun"
        : `bun ${Bun.version} on ${process.platform}/${process.arch}`,
    ...(typeof Bun === "undefined" ? { fix: "install Bun >= 1.4.4" } : {}),
  })

  // --- git ---------------------------------------------------------------
  const git = which("git")
  if (!git)
    checks.push({
      id: "git",
      title: "Git",
      status: "fail",
      detail: "git not found on PATH",
      fix: "install Git (bashwink uses it for diffs, snapshots and undo)",
    })
  else {
    let version = "unknown"
    try {
      const result = Bun.spawnSync({ cmd: [git, "--version"], stdout: "pipe", stderr: "pipe" })
      version = result.stdout.toString().trim()
    } catch {
      version = "could not run git --version"
    }
    const isRepo = existsSync(path.join(cwd, ".git"))
    checks.push({
      id: "git",
      title: "Git",
      status: isRepo ? "ok" : "warn",
      detail: isRepo
        ? `${version}; ${cwd} is a git repository`
        : `${version}; ${cwd} is not a git repository`,
      ...(isRepo ? {} : { fix: "the diff/undo flow needs a git repository; run from inside one" }),
    })
  }

  // --- credentials -------------------------------------------------------
  const present = CREDENTIAL_VARS.filter((name) => (env[name] ?? "").trim() !== "")
  checks.push({
    id: "credentials",
    title: "Model credentials",
    // Not failing: a local/mock provider is a legitimate configuration (ADR-006).
    status: present.length > 0 ? "ok" : "warn",
    detail:
      present.length > 0
        ? `${present.length} provider credential(s) present: ${present.join(", ")} — values not printed`
        : "no provider credential environment variable is set",
    ...(present.length > 0
      ? {}
      : {
          fix:
            "set one of " +
            CREDENTIAL_VARS.join("/") +
            " for a hosted model, or use the local mock provider (fixtures/mock_provider.py)",
        }),
  })

  // --- config / data paths ----------------------------------------------
  const missing = [resolved.config, resolved.data].filter((directory) => !existsSync(directory))
  checks.push({
    id: "paths",
    title: "Config and data paths",
    status: missing.length === 0 ? "ok" : "warn",
    detail:
      missing.length === 0
        ? `config ${resolved.config}; data ${resolved.data}`
        : `not created yet: ${missing.join(", ")}`,
    ...(missing.length === 0
      ? {}
      : { fix: "run any bashwink command once to create them, or `bashwink init`" }),
  })

  // The database lives under data/, so report whether it is initialised rather than
  // pretending a fresh install is broken.
  checks.push({
    id: "database",
    title: "Local database",
    status: existsSync(resolved.database) ? "ok" : "warn",
    detail: existsSync(resolved.database)
      ? `${resolved.database} (${fileSize(resolved.database)} bytes)`
      : `not initialised at ${resolved.database}`,
    ...(existsSync(resolved.database) ? {} : { fix: "run `bashwink plan new` to create it" }),
  })

  // --- workspace trust --------------------------------------------------
  try {
    const trustFile = path.join(resolved.config, "trust.json")
    const trust = readTrust(trustFile)
    const workspace = canonicalWorkspace(cwd)
    const trusted = isTrusted(trust, workspace)
    checks.push({
      id: "trust",
      title: "Workspace trust",
      status: trusted ? "ok" : "warn",
      detail: trusted
        ? `${workspace} is trusted (${trust.workspaces.length} workspace(s) recorded)`
        : `${workspace} is NOT trusted; shell and write actions are denied by default`,
      ...(trusted ? {} : { fix: `bashwink trust ${workspace}` }),
    })
  } catch (error) {
    checks.push({
      id: "trust",
      title: "Workspace trust",
      status: "fail",
      detail: `trust file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      fix: "delete the corrupt trust.json or fix its JSON; bashwink will not guess",
    })
  }

  // --- docker (optional) -------------------------------------------------
  const docker = which("docker")
  checks.push({
    id: "docker",
    title: "Docker (optional)",
    status: docker ? "ok" : "warn",
    detail: docker ? `found ${docker}` : "not installed; sandboxed execution will be unavailable",
    ...(docker ? {} : { fix: "optional — install Docker Desktop only if you need sandboxing" }),
  })

  const failed = checks.filter((check) => check.status === "fail")
  const warned = checks.filter((check) => check.status === "warn")
  const ok = failed.length === 0
  return {
    checks,
    ok,
    exitCode: ok ? 0 : 1,
    summary: ok
      ? `${checks.length} checks, ${warned.length} warning(s), 0 failures`
      : `${checks.length} checks, ${failed.length} failure(s): ${failed.map((c) => c.id).join(", ")}`,
  }
}

function fileSize(file: string): number {
  try {
    return readFileSync(file).byteLength
  } catch {
    return 0
  }
}

/** Render the report for a terminal. Also used verbatim by the completion evidence. */
export function render(report: DoctorReport): string {
  const symbol = { ok: "✓", warn: "!", fail: "✗" } as const
  const lines = report.checks.map(
    (check) =>
      `${symbol[check.status]} ${check.title}: ${check.detail}` +
      (check.fix === undefined ? "" : `\n    fix: ${check.fix}`),
  )
  lines.push("", report.summary)
  return lines.join("\n")
}
