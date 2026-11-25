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
import { withReleaseChecks } from "./release-doctor.js"
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
import { parseLimits, renderUsage, UsageGuard, type UsageLimits } from "./usage-guard.js"
import { changedTestFiles, renderTestChanges } from "./test-changes.js"
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
import { declaredCredentialVariables, preflightCredential, readRuntimeConfig } from "./providers.js"
import { findRuntimeFailure, renderRuntimeFailure } from "./service-health.js"
import {
  admitInteractiveConfig,
  isClientCommand,
  launchEnvironment,
  prepareLaunchPolicy,
  standaloneArguments,
} from "./execution-policy.js"
import { executionTimeout, runWithBackend, selectBackend } from "./execution-backend.js"
import {
  AcknowledgmentError,
  GUEST_BUILD,
  RELEASE_BUILD,
  STANDARD_BUILD,
  STARTUP_FAILURE_LOG,
  StartupError,
  UNRESTRICTED_FLAG,
  acknowledgeUnrestricted,
  describeMode,
  recordStartupFailure,
  type ExecutionMode,
} from "./release.js"
import { OFFLINE_USAGE, parseOffline, runNativeOffline } from "./native-offline.js"
import { recoverClosedNativeStage } from "./native-lifetime.js"
import { exportNativeStage, recoverNativeExport } from "./native-export.js"
import { probeNativeSandbox } from "./native-sandbox.js"
import {
  offlineVmCapabilities,
  offlineVmSelected,
  runOfflineVm,
  runOfflineVmVerification,
  terminalIO,
} from "./offline-vm.js"
import { assertVmProjectRevision, openVmProject } from "./vm-project.js"
import { recoverVmProject, reviewVmProject, vmProjectApplyPending } from "./vm-project-apply.js"
import { SESSION_ID } from "./native-stage.js"
import { offerWorkspaceTrust } from "./workspace-approval.js"
import { listStages, purgeStages, renderStageReports } from "./vm-stages.js"

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
/**
 * Report a launch that did not start (or did not finish starting) and record it. Used for
 * every release-mode failure so that the message, the exit status and the record agree.
 */
function startupFailure(error: unknown, mode: ExecutionMode): MainResult {
  const message = error instanceof Error ? error.message : String(error)
  err(`${mode === "isolated-vm" ? "isolated VM" : "bashwink"}: ${message}`)
  if (RELEASE_BUILD || STANDARD_BUILD) {
    const code =
      error instanceof StartupError
        ? error.code
        : error instanceof AcknowledgmentError
          ? "acknowledgment-required"
          : "vm-init-failed"
    if (error instanceof StartupError || error instanceof AcknowledgmentError)
      err("No model request was made and no tool was dispatched.")
    let recorded = false
    try {
      const data = paths().data
      recorded = recordStartupFailure(data, { code, mode, message })
      if (recorded) err(`This failure was recorded in ${path.join(data, STARTUP_FAILURE_LOG)}.`)
    } catch {
      // Recording is best effort; the message above has already been shown.
    }
    if (!recorded) err("(the failure could not be written to the startup log)")
  }
  return { exitCode: 3, handled: true }
}

export async function main(input: readonly string[]): Promise<MainResult> {
  let argv = input
  let unrestricted = false
  if (RELEASE_BUILD) {
    const at = input.indexOf(UNRESTRICTED_FLAG)
    if (at > 0) {
      err(`${UNRESTRICTED_FLAG} must be the first argument`)
      return { exitCode: 2, handled: true }
    }
    if (at === 0) {
      try {
        acknowledgeUnrestricted(terminalIO())
      } catch (error) {
        return startupFailure(error, "unrestricted-host")
      }
      unrestricted = true
      argv = input.slice(1)
    }
  }
  if (STANDARD_BUILD && argv.includes("--sandbox")) {
    // Sandbox mode is a separately qualified, optional artifact. This package does not contain it, so
    // asking for it must fail closed rather than run the agent natively.
    return startupFailure(
      new StartupError(
        "sandbox-unavailable",
        "sandbox mode is not installed. It is an optional, separately qualified component that this " +
          "package does not include, so Bashwink will not start. Run plain `bashwink` for standard " +
          "(native, permission-controlled) mode, which is not an operating-system sandbox.",
      ),
      "isolated-vm",
    )
  }
  const [first, ...rest] = argv
  // The standard build never selects the VM, whatever the environment says.
  const offlineVm = STANDARD_BUILD
    ? false
    : RELEASE_BUILD
      ? !unrestricted
      : offlineVmSelected(MODULE_DIR)

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
    if (offlineVm) {
      try {
        return { exitCode: await runOfflineVm(MODULE_DIR), handled: true }
      } catch (error) {
        return startupFailure(error, "isolated-vm")
      }
    }
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
    case "sandbox": {
      if (STANDARD_BUILD) {
        err(
          "sandbox commands belong to the optional sandbox component, which is not part of this package",
        )
        return { exitCode: 2, handled: true }
      }
      if (rest[0] === "stages") {
        // Read-only by default. `--purge` removes only stages this installation recorded and can
        // prove are its own, idle directories; everything else is kept and reported.
        if (rest.length > 2 || (rest.length === 2 && rest[1] !== "--purge")) {
          err("usage: bashwink sandbox stages [--purge]")
          return { exitCode: 2, handled: true }
        }
        try {
          const data = paths().data
          const purge = rest[1] === "--purge"
          const reports = purge ? purgeStages(data) : listStages(data)
          out(renderStageReports(reports, purge))
          return { exitCode: 0, handled: true }
        } catch (error) {
          err(
            `could not process the stage registry: ${error instanceof Error ? error.message : String(error)}`,
          )
          return { exitCode: 1, handled: true }
        }
      }
      if (
        RELEASE_BUILD &&
        rest[0] !== "vm-review" &&
        rest[0] !== "vm-recover" &&
        rest[0] !== "vm-verify"
      ) {
        err("this sandbox command is a development experiment and is not part of release builds")
        return { exitCode: 2, handled: true }
      }
      if (rest[0] === "vm-review" || rest[0] === "vm-recover" || rest[0] === "vm-verify") {
        try {
          if (!offlineVm && !RELEASE_BUILD)
            throw new Error("this installation has no offline VM selected")
          if (rest[0] !== "vm-review" && rest.length !== 1)
            throw new Error("unexpected VM operation arguments")
          if (rest[0] === "vm-verify")
            return { exitCode: await runOfflineVmVerification(MODULE_DIR), handled: true }
          const project = openVmProject()
          try {
            assertVmProjectRevision(project)
            if (rest[0] === "vm-recover") {
              const pending = vmProjectApplyPending(project.root)
              recoverVmProject(project.root, project.project, () =>
                assertVmProjectRevision(project),
              )
              out(
                pending
                  ? "Reconciled the approved VM apply journal."
                  : "No VM apply journal is pending.",
              )
            } else {
              const snapshot = project.record.snapshot
              if (!snapshot) throw new Error("no stopped VM checkpoint to review")
              await reviewVmProject(
                project.root,
                project.project,
                project.record.base,
                snapshot.files,
                rest.length > 1 ? rest.slice(1) : undefined,
                () => assertVmProjectRevision(project),
              )
            }
            return { exitCode: 0, handled: true }
          } finally {
            project.lifetime.close()
          }
        } catch (error) {
          err(`offline VM: ${error instanceof Error ? error.message : String(error)}`)
          return { exitCode: 3, handled: true }
        }
      }
      if (rest[0] === "offline") {
        try {
          const options = parseOffline(rest.slice(1))
          const plugin = resolvePluginDirectory(
            [path.join(MODULE_DIR, "evidence"), path.join(MODULE_DIR, "..", "..", "bw-evidence")],
            {},
          )
          const result = await runNativeOffline(options, plugin)
          if (result.outcome !== "exited") err(result.detail ?? result.outcome)
          return { exitCode: result.exitCode, handled: true }
        } catch (error) {
          const message = error instanceof Error ? error.message : "offline startup failed"
          err(message)
          return { exitCode: message === OFFLINE_USAGE ? 2 : 3, handled: true }
        }
      }
      if (rest[0] === "recover" && rest.length === 2) {
        try {
          out(
            recoverClosedNativeStage(rest[1]!)
              ? "Retired the closed native activation."
              : "No native activation to retire.",
          )
          return { exitCode: 0, handled: true }
        } catch (error) {
          err(error instanceof Error ? error.message : "native stage recovery failed")
          return { exitCode: 3, handled: true }
        }
      }
      if (rest[0] === "export" && rest.length === 2) {
        try {
          await exportNativeStage(rest[1]!)
          return { exitCode: 0, handled: true }
        } catch (error) {
          err(error instanceof Error ? error.message : "staged export failed")
          return { exitCode: 3, handled: true }
        }
      }
      if (rest[0] === "recover-export" && rest.length === 2) {
        try {
          out(
            recoverNativeExport(rest[1]!)
              ? "Reconciled the interrupted staged export."
              : "No interrupted staged export to reconcile.",
          )
          return { exitCode: 0, handled: true }
        } catch (error) {
          err(error instanceof Error ? error.message : "staged export reconciliation failed")
          return { exitCode: 3, handled: true }
        }
      }
      if (rest.length !== 1 || rest[0] !== "probe") {
        err("usage: bashwink sandbox probe")
        return { exitCode: 2, handled: true }
      }
      const result = await probeNativeSandbox(process.env["BASHWINK_OPENCODE_BIN"])
      out(JSON.stringify(result.report, null, 2))
      return { exitCode: result.exitCode, handled: true }
    }
    case "doctor": {
      const base = diagnose({ offlineVm })
      const report = RELEASE_BUILD
        ? await withReleaseChecks(
            base,
            MODULE_DIR,
            unrestricted ? "unrestricted-host" : "isolated-vm",
          )
        : base
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
  if (offlineVm) {
    if (
      (first === "--continue" && rest.length === 0) ||
      (first === "--session" && rest.length === 1 && SESSION_ID.test(rest[0]!))
    ) {
      try {
        return {
          exitCode: await runOfflineVm(MODULE_DIR, first === "--continue" ? "continue" : rest[0]),
          handled: true,
        }
      } catch (error) {
        return startupFailure(error, "isolated-vm")
      }
    }
    if (first === "backend") {
      out(JSON.stringify({ execution: "isolated-vm", ...offlineVmCapabilities }, null, 2))
      return { exitCode: 0, handled: true }
    }
    return startupFailure(
      new StartupError(
        "unsupported-invocation",
        "the isolated VM supports bare bashwink, --continue, and --session <id>. " +
          `Other invocations would run on the host, so they are refused; ${UNRESTRICTED_FLAG} is the explicit host mode.`,
      ),
      "isolated-vm",
    )
  }
  let backend
  let timeoutMs
  let limits: UsageLimits
  try {
    backend = selectBackend(
      STANDARD_BUILD
        ? "standard-native"
        : RELEASE_BUILD
          ? "unrestricted-host"
          : process.env["BASHWINK_BACKEND"],
    )
    if (first === "backend") {
      out(JSON.stringify(backend.capabilities, null, 2))
      return { exitCode: 0, handled: true }
    }
    timeoutMs = executionTimeout(process.env["BASHWINK_TIMEOUT_MS"])
    limits = parseLimits(process.env)
    runtimeArgs = standaloneArguments(argv)
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return { exitCode: 2, handled: true }
  }

  // Anything else belongs to the runtime.
  //
  // A locally built engine arrives as a *manifest*, not as BASHWINK_OPENCODE_BIN, so requiring the
  // env var here would make a verified local engine unusable through the npm launcher — the engine
  // builds, verifies, and then cannot start (exit 127). Either credential authorizes the runtime;
  // neither is invented, and both are verified before use.
  const engineManifestFromLauncher = process.env["BASHWINK_ENGINE_MANIFEST"]
  if (STANDARD_BUILD && !process.env["BASHWINK_OPENCODE_BIN"] && !engineManifestFromLauncher) {
    // The launcher resolves the pinned runtime and passes it explicitly. Searching PATH instead could
    // run some other OpenCode, so the standard build refuses to guess.
    err(
      "the pinned OpenCode runtime was not provided. Start Bashwink with the `bashwink` command that " +
        "npm installed; it supplies the runtime.",
    )
    return { exitCode: 127, handled: true }
  }
  let runtime
  try {
    // Task 4: a packaged build resolves the engine from the local build manifest and verifies it.
    // The old `bundledOnly` path is kept for a bundle that ships no manifest — it still refuses to
    // search PATH, so neither branch can run an engine this build did not produce.
    const defaultManifest =
      engineManifestFromLauncher ?? path.join(MODULE_DIR, "..", "engine-manifest.json")
    runtime = resolveRuntime(
      STANDARD_BUILD
        ? { engineManifest: defaultManifest }
        : RELEASE_BUILD
          ? existsSync(defaultManifest)
            ? { engineManifest: defaultManifest }
            : { bundled: path.join(MODULE_DIR, "..", "libexec", "opencode"), bundledOnly: true }
          : {},
    )
  } catch (error) {
    if (error instanceof RuntimeNotFoundError) {
      err(error.message)
      return { exitCode: 127, handled: true }
    }
    throw error
  }

  const resolved = paths()
  ensurePaths(resolved)
  if (STANDARD_BUILD) {
    try {
      const decision = offerWorkspaceTrust({
        configDirectory: resolved.config,
        workspace: process.cwd(),
        io: terminalIO(),
        user: process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
      })
      if (decision === "declined")
        out(
          "not trusted: this session can read files but cannot write, run commands or use the network",
        )
    } catch {
      // A trust file that cannot be read or written is reported by the launch policy below.
    }
  }

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
  // Host execution is never silent: say so before the terminal UI takes the screen, and again
  // in the title bar. The run record carries the same mode through `execution.backend.mode`.
  const hostMode = GUEST_BUILD
    ? describeMode("isolated-vm", "running inside the VM guest")
    : describeMode(
        STANDARD_BUILD
          ? "standard-native"
          : RELEASE_BUILD
            ? "unrestricted-host"
            : "development-host",
      )
  err(hostMode.banner)
  if (process.stderr.isTTY) process.stderr.write(`\x1b]0;bashwink [${hostMode.short}]\x07`)
  environment["BASHWINK_EXECUTION_MODE"] = hostMode.mode
  try {
    // Names only. The plugin looks the values up itself, to mask them in the evidence log and to keep them out of
    // the environment of shell commands the model runs.
    environment["BASHWINK_SECRET_ENV"] = declaredCredentialVariables(
      readRuntimeConfig(resolved.config),
    ).join(",")
  } catch {
    // An unreadable config is reported by the runtime launch itself; there is nothing to protect by name here.
  }
  beginRun({
    resolved,
    runId,
    plugin: { id: evidencePlugin.id, entry: evidencePlugin.entry, stagedPath: evidencePlugin.path },
  })

  // Usage limits. The terminal UI owns the screen while it runs, so a stop notice is printed at once only for
  // the non-interactive commands; for the UI it is in the summary printed when the UI exits.
  const noninteractive = isClientCommand(runtimeArgs)
  const guard = new UsageGuard(limits, {
    onStop: (reason) => {
      if (noninteractive) err(`bashwink: stopped: ${reason}`)
    },
  })
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  const stopSignals: NodeJS.Signals[] = [
    "SIGINT",
    "SIGTERM",
    ...(process.platform === "win32" ? (["SIGBREAK"] as const) : []),
  ]
  for (const signal of stopSignals) process.on(signal, interrupt)
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
        guard,
      },
      env: {
        ...environment,
        BASHWINK_RUN_ID: runId,
        BASHWINK_EVIDENCE_EXPECTED: "1",
      },
    },
    { signal: controller.signal, timeoutMs },
  ).finally(() => {
    for (const signal of stopSignals) process.off(signal, interrupt)
  })
  await guard.stop()
  const usage = guard.summary()
  if (usage.requests > 0 || usage.stopped !== undefined) err(renderUsage(usage))
  const { exitCode: runtimeExit } = execution
  // A run that a limit stopped must not look like a success to a script.
  const exitCode = usage.stopped === undefined ? runtimeExit : 4
  if (execution.outcome !== "exited")
    err(
      `execution ${execution.outcome} (${execution.backend.mode}): ${execution.detail ?? "no detail"}`,
    )

  const evidenceFile = path.join(resolved.evidence, "evidence.jsonl")
  const boot = checkBoot(evidenceFile, runId)
  const changedTests = boot.ok ? changedTestFiles(evidenceFile, boot.seq) : []
  if (changedTests.length > 0) err(renderTestChanges(changedTests))
  const record = finishRun({
    resolved,
    runId,
    exitCode,
    expected: true,
    execution,
    boot,
    usage,
    ...(changedTests.length > 0 ? { changedTests } : {}),
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
