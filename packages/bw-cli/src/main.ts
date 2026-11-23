/**
 * `bashwink` entrypoint — a thin launcher over the pinned OpenCode runtime (ADR-003).
 *
 * The wrapper owns exactly four things: its name, its version, its config directory, and its
 * own subcommands (`doctor`, `trust`, `plan`, `evidence`, `resume`, `init`). Everything else
 * is forwarded to the runtime **unchanged**, so a new upstream flag works without a wrapper
 * release. That is the rule ADR-003 adopted and this file implements.
 *
 * Interactive TUI behaviour depends on not buffering stdio, so the child is spawned with
 * `stdio: "inherit"` and its exit code is propagated verbatim.
 */

import { VERSION, renderHelp } from "./help.js"
import { diagnose, render as renderDoctor } from "./doctor.js"
import { RuntimeNotFoundError, resolveRuntime } from "./runtime.js"
import {
  EVIDENCE_PLUGIN_ID,
  PluginEntryError,
  ensurePaths,
  environmentFor,
  paths,
  resolvePluginDirectory,
  stagePlugins,
  writeConfig,
} from "./paths.js"
import {
  beginRun,
  checkBoot,
  finishRun,
  newRunId,
  renderMissingEvidence,
  runtimeLogHint,
} from "./run-health.js"
import {
  runAuthCommand,
  runModelCommand,
  runContractCommand,
  runDoctorCommand,
  runEvidenceCommand,
  runPlanCommand,
  runResumeCommand,
  runTrustCommand,
} from "./commands.js"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { preflightCredential, readRuntimeConfig } from "./providers.js"

/** Value of `--flag value` or `--flag=value`, or undefined. First occurrence wins. */
function flagOf(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === flag) return argv[index + 1]
    if (value?.startsWith(`${flag}=`) === true) return value.slice(flag.length + 1)
  }
  return undefined
}

/** Directory of this module. Resolved from the module, never `process.cwd()`. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Repository root in a source checkout; `undefined` when the CLI is installed as a package.
 *
 * The wrapper is routinely run from inside the user's project, which is not where
 * Bashwink's own packages live, so this must not be derived from the working directory.
 * But it also must not be *assumed*: in `node_modules/@bashwink/cli/src`, three levels up
 * is `node_modules`, which is not a repository root.
 */
const REPO_ROOT = (() => {
  const candidate = path.resolve(MODULE_DIR, "..", "..", "..")
  return existsSync(path.join(candidate, "packages", "bw-evidence", "package.json"))
    ? candidate
    : undefined
})()

/** Flags this wrapper handles itself. Everything else is forwarded. */
const OWNED_FLAGS = new Set(["--version", "-v", "--help", "-h"])

export interface MainResult {
  readonly exitCode: number
  /** Set when the wrapper handled the invocation and did not exec a runtime. */
  readonly handled: boolean
}

function out(text: string): void {
  process.stdout.write(`${text}\n`)
}

function err(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * Run the CLI.
 *
 * Returns rather than calling `process.exit`, so tests can assert the exit code instead of
 * killing the test runner. `bin.ts` is the only place that actually exits.
 */
export async function main(argv: readonly string[]): Promise<MainResult> {
  const [first, ...rest] = argv

  if (first === "--version" || first === "-v") {
    out(`bashwink ${VERSION}`)
    return { exitCode: 0, handled: true }
  }
  if (first === "--help" || first === "-h" || first === undefined) {
    out(renderHelp())
    return { exitCode: 0, handled: true }
  }

  // Our own subcommands. A switch on the FIRST argument only, so `bashwink run --help` still
  // forwards `--help` to the runtime where it means the runtime's help.
  switch (first) {
    case "doctor": {
      const report = diagnose()
      out(renderDoctor(report))
      return { exitCode: report.exitCode, handled: true }
    }
    case "trust": {
      const result = runTrustCommand(rest)
      out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "plan": {
      const result = await runPlanCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "evidence": {
      const result = runEvidenceCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "contract": {
      const result = runContractCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "auth": {
      const result = runAuthCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "model": {
      const result = runModelCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "resume": {
      const result = runResumeCommand(rest)
      if (result.stdout !== "") out(result.stdout)
      if (result.stderr !== undefined) err(result.stderr)
      return { exitCode: result.exitCode, handled: true }
    }
    case "init": {
      const resolved = paths()
      ensurePaths(resolved)
      out(`initialised ${resolved.config}`)
      return { exitCode: 0, handled: true }
    }
    case "runtime-path": {
      // Small helper the completion evidence uses to prove which binary is being wrapped.
      const runtime = resolveRuntime()
      out(runtime.command)
      return { exitCode: 0, handled: true }
    }
    default:
      break
  }

  // Anything else belongs to the runtime.
  let runtime
  try {
    runtime = resolveRuntime()
  } catch (error) {
    if (error instanceof RuntimeNotFoundError) {
      err(error.message)
      return { exitCode: 127, handled: true }
    }
    throw error
  }

  const resolved = paths()
  ensurePaths(resolved)

  // Pre-flight the credential for an explicitly requested model, before spawning.
  //
  // The runtime's own failure for a missing key is `Invalid 'Authorization' header or
  // token.` — true, but it names the header rather than the environment variable, and it
  // arrives after a server has started and a session created. Bashwink resolved which
  // variable the provider declared, so it owes the user that sentence instead.
  //
  // Only an explicit `--model`/`-m` is checked. A default model resolved inside the runtime
  // is the runtime's business; re-deriving it here would duplicate its resolution and could
  // disagree with it.
  const requestedModel = flagOf(argv, "--model") ?? flagOf(argv, "-m")
  if (requestedModel !== undefined) {
    try {
      const preflight = preflightCredential(readRuntimeConfig(resolved.config), requestedModel)
      if (preflight !== undefined && !preflight.ok) {
        err(preflight.message)
        return { exitCode: 1, handled: true }
      }
    } catch {
      // A config this module cannot read is reported by `doctor` and by the runtime itself.
      // Failing here would turn a diagnostic nicety into a new failure mode.
    }
  }

  // Evidence collection is on by default. `BASHWINK_EVIDENCE=off` is the deliberate optional
  // mode ADR-002 allows: a caller may run the runtime without the recorder, and the run is
  // then recorded as `disabled` rather than being silently indistinguishable from a health
  // problem. Everything else is expected to record, and a missing boot record fails the run.
  const evidenceEnabled = (process.env["BASHWINK_EVIDENCE"] ?? "on") !== "off"
  const runId = newRunId()
  // Two layouts are supported: the source checkout (`packages/bw-evidence` beside this
  // package) and an installed CLI (`node_modules/@bashwink/evidence`). Both are tried, and
  // an honest miss refuses the run instead of starting one that cannot record.
  const pluginDirectory = (() => {
    try {
      return resolvePluginDirectory([
        // Built install: `lib/evidence` beside the bundle.
        path.join(MODULE_DIR, "evidence"),
        // Installed layout: `@bashwink/evidence` beside `@bashwink/cli` in node_modules.
        path.join(MODULE_DIR, "..", "..", "evidence"),
        // Source layout: the sibling workspace package.
        path.join(MODULE_DIR, "..", "..", "bw-evidence"),
        ...(REPO_ROOT === undefined ? [] : [path.join(REPO_ROOT, "packages", "bw-evidence")]),
        ...(REPO_ROOT === undefined
          ? []
          : [path.join(REPO_ROOT, "node_modules", "@bashwink", "evidence")]),
      ])
    } catch (error) {
      if (error instanceof PluginEntryError) {
        err(`evidence plugin cannot be located: ${error.message}`)
        err("refusing to start a run whose evidence would be silently absent.")
        return undefined
      }
      throw error
    }
  })()
  if (pluginDirectory === undefined) return { exitCode: 3, handled: true }
  let staged: ReturnType<typeof stagePlugins> = []
  try {
    // Stage the plugin directory contents before every run (ADR-002 constraint 2). Without
    // this the real runtime loads no Bashwink plugin at all: the config's plugin list does
    // not restrict or enable discovery, so the *directory* is the only thing that governs
    // loading. Staging also resolves the entry exactly as the runtime will, so a directory
    // the runtime would silently drop fails here with a message instead.
    staged = stagePlugins(
      resolved.config,
      evidenceEnabled ? [{ id: EVIDENCE_PLUGIN_ID, directory: pluginDirectory, order: 0 }] : [],
    )
  } catch (error) {
    if (error instanceof PluginEntryError) {
      err(`evidence plugin cannot be staged: ${error.message}`)
      err("refusing to start a run whose evidence would be silently absent.")
      err(
        "run `bashwink doctor` to re-check the install, or set BASHWINK_EVIDENCE=off to run unverified.",
      )
      return { exitCode: 3, handled: true }
    }
    throw error
  }

  // The config lists the staged plugins in explicit order. Discovery ignores the array, but
  // writing it keeps the file honest for anyone reading it.
  writeConfig(
    resolved.config,
    staged.map((entry) => entry.id),
  )
  if (process.env["BASHWINK_DEBUG"] === "1")
    process.stderr.write(
      `[bashwink] staged ${staged.length} plugin(s): ${staged.map((entry) => entry.id).join(", ")}\n`,
    )

  const evidencePlugin = staged[0]
  beginRun({
    resolved,
    runId,
    ...(evidencePlugin === undefined
      ? {}
      : {
          plugin: {
            id: evidencePlugin.id,
            entry: evidencePlugin.entry,
            stagedPath: evidencePlugin.path,
          },
        }),
  })
  if (!evidenceEnabled)
    err(
      "[bashwink] evidence collection is OFF (BASHWINK_EVIDENCE=off); this run is not verifiable.",
    )

  const child = Bun.spawn({
    cmd: [runtime.command, ...argv],
    env: {
      ...environmentFor(resolved),
      BASHWINK_RUN_ID: runId,
      BASHWINK_EVIDENCE_EXPECTED: evidenceEnabled ? "1" : "0",
    },
    // inherit, not pipe: the TUI needs a real tty and must not be buffered.
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await child.exited

  if (evidenceEnabled) {
    const evidenceFile = path.join(resolved.evidence, "evidence.jsonl")
    const boot = checkBoot(evidenceFile, runId)
    const record = finishRun({
      resolved,
      runId,
      exitCode,
      expected: true,
      boot,
      ...(boot.ok ? {} : { detail: boot.reason }),
    })
    if (!boot.ok) {
      err("")
      err(
        renderMissingEvidence({
          record,
          boot,
          evidenceFile,
          logFile: runtimeLogHint(resolved),
        }),
      )
      // 0 from the child now means "the agent ran", not "the work is evidenced". Exit 3 makes
      // that distinction visible to a script or a CI step instead of a green 0 over an empty log.
      return { exitCode: exitCode === 0 ? 3 : exitCode, handled: false }
    }
  } else {
    finishRun({
      resolved,
      runId,
      exitCode,
      expected: false,
      detail: "evidence disabled via BASHWINK_EVIDENCE=off",
    })
  }

  return { exitCode, handled: false }
}

export { OWNED_FLAGS, runDoctorCommand }
