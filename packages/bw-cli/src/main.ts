/**
 * `bashwink` entrypoint — a thin launcher over the pinned OpenCode runtime (ADR-003).
 *
 * The wrapper owns exactly four things: its name, its version, its config directory, and its
 * own subcommands (`doctor`, `trust`, `plan`, `evidence`, `resume`, `init`). Everything else
 * is forwarded to the runtime under the execution policy, with a private OpenCode server.
 *
 * The execution backend owns child startup, inherited terminal I/O, and cancellation.
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
import { findRuntimeFailure, renderRuntimeFailure } from "./service-health.js"
import {
  admitInteractiveConfig,
  launchEnvironment,
  prepareLaunchPolicy,
  standaloneArguments,
} from "./execution-policy.js"
import { executionTimeout, runWithBackend, selectBackend } from "./execution-backend.js"

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
  if (first === "--help" || first === "-h") {
    out(renderHelp())
    return { exitCode: 0, handled: true }
  }

  // Bare `bashwink` launches the runtime TUI in the current directory. Printing help here instead would make the
  // most obvious invocation the one thing that cannot start a session.
  //
  // Help is still what a *non-interactive* bare invocation gets: a pipeline or a CI step
  // cannot drive a TUI, and spawning one onto a pipe produces a hung process rather than an
  // error. `stdout.isTTY` is the discriminator, and the message says how to force either
  // behaviour, so nobody has to guess which branch they hit.
  if (first === undefined) {
    // Either stream being a terminal is enough: `bashwink < /dev/null` from a real terminal
    // should still start the TUI, and the runtime handles EOF on stdin itself. Requiring both
    // would refuse a legitimate interactive invocation.
    if (process.stdout.isTTY !== true && process.stdin.isTTY !== true) {
      out(renderHelp())
      err(
        "note: no subcommand and stdout is not a terminal, so help was printed instead of " +
          "starting the TUI.\n" +
          "      run `bashwink` from an interactive terminal, or name a subcommand (e.g. `bashwink run ...`).",
      )
      return { exitCode: 0, handled: true }
    }
    // Fall through to the runtime’s default interactive command.
    out(`bashwink ${VERSION} — starting the interactive session in ${process.cwd()}`)
    out("(the workspace and model are shown in the TUI; Ctrl-C twice exits)")
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

  let runtimeArgs
  let backend
  let timeoutMs
  try {
    backend = selectBackend(process.env["BASHWINK_BACKEND"])
    if (first === "backend") {
      out(JSON.stringify(backend.capabilities, null, 2))
      return { exitCode: 0, handled: true }
    }
    timeoutMs = executionTimeout(process.env["BASHWINK_TIMEOUT_MS"])
    runtimeArgs = standaloneArguments(argv)
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return { exitCode: 2, handled: true }
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

  if (process.env["BASHWINK_EVIDENCE"] === "off") {
    err("policy readiness is required; BASHWINK_EVIDENCE=off cannot launch OpenCode")
    return { exitCode: 3, handled: true }
  }
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

  let environment
  let workspace
  let trusted
  try {
    const launch = prepareLaunchPolicy(resolved, runId)
    workspace = launch.workspace
    trusted = launch.trusted
    environment = launchEnvironment(environmentFor(resolved), launch)
    if (!launch.trusted)
      out(`scope fence: ${launch.policy.workspace} is not trusted; writes and shell are refused`)
  } catch {
    err(
      "could not prepare the execution policy; check the workspace trust, current plan, runtime configuration and state directory",
    )
    return { exitCode: 3, handled: true }
  }

  try {
    admitInteractiveConfig(argv, workspace, trusted)
  } catch {
    err(
      "could not admit untrusted project TUI configuration; inspect the workspace before trusting it",
    )
    return { exitCode: 3, handled: true }
  }

  let evidencePlugin
  try {
    ;[evidencePlugin] = stagePlugins(
      resolved.config,
      [{ id: EVIDENCE_PLUGIN_ID, directory: pluginDirectory, order: 0 }],
      { preserveExisting: true },
    )
    if (evidencePlugin === undefined) throw new PluginEntryError("no policy plugin was staged")
  } catch (error) {
    if (error instanceof PluginEntryError) {
      err(`required policy plugin cannot be staged: ${error.message}`)
      err("OpenCode was not started. Run `bashwink doctor` to check the install.")
      return { exitCode: 3, handled: true }
    }
    throw error
  }

  const content = JSON.parse(environment["OPENCODE_CONFIG_CONTENT"] ?? "{}") as Record<
    string,
    unknown
  >
  const configuredPlugins = Array.isArray(content["plugins"]) ? content["plugins"] : []
  // The absolute registration is reapplied after project configuration on every location.
  environment["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({
    ...content,
    plugins: [...configuredPlugins, evidencePlugin.path],
  })
  beginRun({
    resolved,
    runId,
    plugin: { id: evidencePlugin.id, entry: evidencePlugin.entry, stagedPath: evidencePlugin.path },
  })

  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const execution = await runWithBackend(
    backend,
    {
      command: runtime.command,
      args: runtimeArgs,
      cwd: workspace,
      readiness: {
        runId,
        workspace,
        scopesDirectory: path.join(resolved.data, "scopes"),
        pluginDirectory: evidencePlugin.path,
        logFile: runtimeLogHint(resolved),
      },
      env: {
        ...environment,
        BASHWINK_RUN_ID: runId,
        BASHWINK_EVIDENCE_EXPECTED: "1",
      },
    },
    { signal: controller.signal, timeoutMs },
  ).finally(() => {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  })
  const { exitCode } = execution
  if (execution.outcome !== "exited")
    err(
      `execution ${execution.outcome} (${execution.backend.mode}): ${execution.detail ?? "no detail"}`,
    )

  const evidenceFile = path.join(resolved.evidence, "evidence.jsonl")
  const boot = checkBoot(evidenceFile, runId)
  const record = finishRun({
    resolved,
    runId,
    exitCode,
    expected: true,
    execution,
    boot,
    ...(execution.detail !== undefined
      ? { detail: execution.detail }
      : boot.ok
        ? {}
        : { detail: boot.reason }),
  })
  if (!boot.ok && execution.outcome === "exited") {
    err("")
    // Before blaming the evidence plugin, ask the runtime's own log why it never booted one.
    // A launch that died on a held port produces an empty evidence log and would otherwise be
    // reported as "the agent may have done real work" — which it plainly did not.
    const infrastructure = findRuntimeFailure(runtimeLogHint(resolved))
    if (infrastructure !== undefined) {
      err(renderRuntimeFailure(infrastructure))
      return { exitCode: exitCode === 0 ? 1 : exitCode, handled: false }
    }
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

  return { exitCode, handled: false }
}

export { OWNED_FLAGS, runDoctorCommand }
