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
  ensurePaths,
  environmentFor,
  paths,
  stagePlugins,
  writeConfig,
} from "./paths.js"
import {
  runDoctorCommand,
  runEvidenceCommand,
  runPlanCommand,
  runResumeCommand,
  runTrustCommand,
} from "./commands.js"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Repository root, used to point staged plugins at their real source.
 *
 * Resolved from this module's location rather than `process.cwd()`, because the wrapper is
 * routinely run from inside the user's project — which is not where Bashwink's own packages
 * live.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

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

  // Stage the plugin directory contents before every run (ADR-002 constraint 2). Without this
  // the real runtime loads no Bashwink plugin at all: the config's plugin list does not
  // restrict or enable discovery, so the *directory* is the only thing that governs loading.
  // This was a live bug — the runtime ran the tool and recorded nothing.
  const staged = stagePlugins(resolved.config, [
    {
      id: EVIDENCE_PLUGIN_ID,
      directory: path.join(REPO_ROOT, "packages", "bw-evidence"),
      order: 0,
    },
  ])
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

  const child = Bun.spawn({
    cmd: [runtime.command, ...argv],
    env: environmentFor(resolved),
    // inherit, not pipe: the TUI needs a real tty and must not be buffered.
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await child.exited
  return { exitCode, handled: false }
}

export { OWNED_FLAGS, runDoctorCommand }
