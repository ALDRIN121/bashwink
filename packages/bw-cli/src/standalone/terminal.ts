/**
 * Original line-oriented terminal UI and CLI commands for standalone Bashwink.
 *
 * Kept strictly decoupled from provider HTTP transport and task-loop orchestration:
 * communicates with `runTask` through plain `TaskInput`, `ApprovalRequest`, and `TaskEvent`s.
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises"
import { ensurePaths } from "../paths.ts"
import {
  formatDestination,
  inspectLegacyOpenAiProviders,
  loadStandaloneConfig,
  normalizeBaseURL,
  resolveCredentialSecret,
  resolveStandalonePaths,
  saveStandaloneConfig,
  standaloneConfigFile,
  validateEnvVarName,
  validateKeyFilePath,
  validateModelID,
} from "./config.ts"
import {
  canonicalWorkspace,
  grantWorkspaceTrust,
  isWorkspaceTrusted,
  verifyEvidenceFile,
} from "./security.ts"
import { runTask, type ApprovalRequest } from "./task-loop.ts"
import type { CredentialConfig, StandaloneConfig, TaskEvent, TaskResult } from "./types.ts"

export const STANDALONE_VERSION = "0.2.0-alpha.1"

/** Strip ANSI escape sequences and unsafe control characters from untrusted model/file/command text. */
export function sanitizeTerminalText(text: string): string {
  // Build control character patterns from hex escapes via String.fromCharCode or linear scan
  // so no literal control bytes appear in source regexes.
  let out = ""
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1)
      if (next === 0x5b) {
        // CSI: ESC [ ... [@-~]
        let j = i + 2
        while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1
        i = j < text.length ? j + 1 : text.length
        continue
      }
      if (next === 0x5d) {
        // OSC: ESC ] ... (BEL | ESC \)
        let j = i + 2
        while (j < text.length) {
          if (text.charCodeAt(j) === 0x07) {
            j += 1
            break
          }
          if (text.charCodeAt(j) === 0x1b && text.charCodeAt(j + 1) === 0x5c) {
            j += 2
            break
          }
          j += 1
        }
        i = j
        continue
      }
      if (next >= 0x40 && next <= 0x5f) {
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      i += 1
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

export interface TerminalIO {
  readonly isTTY: boolean
  write(text: string): void
  writeError(text: string): void
  ask(prompt: string, signal?: AbortSignal): Promise<string | null>
  close(): void
}

class NodeTerminalIO implements TerminalIO {
  readonly isTTY: boolean
  private rl: ReadlineInterface | undefined

  constructor() {
    this.isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  }

  private ensureRl(): ReadlineInterface {
    if (!this.rl) {
      this.rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: Boolean(process.stdin.isTTY),
      })
      this.rl.on("SIGINT", () => {
        if (process.listenerCount("SIGINT") > 0) {
          process.emit("SIGINT")
        } else {
          this.close()
        }
      })
    }
    return this.rl
  }

  write(text: string): void {
    process.stdout.write(text)
  }

  writeError(text: string): void {
    process.stderr.write(text)
  }

  async ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    const rl = this.ensureRl()
    try {
      const answer = signal ? await rl.question(prompt, { signal }) : await rl.question(prompt)
      return answer
    } catch {
      return null
    }
  }

  close(): void {
    this.rl?.close()
    this.rl = undefined
  }
}

export function renderVersion(): string {
  return `bashwink ${STANDALONE_VERSION}\n`
}

export function renderHelp(configDir: string, dataDir: string): string {
  return [
    `bashwink ${STANDALONE_VERSION} — standalone evidence-first coding CLI`,
    "",
    "USAGE",
    "  bashwink                 Open setup (if unconfigured) or the coding prompt",
    "  bashwink setup           Configure or update the model endpoint, model ID, and credentials",
    "  bashwink doctor          Check Node, saved profile, credential reference, trust, and evidence",
    "  bashwink trust [dir] --by <name>",
    "                           Grant interactive write/command trust to a workspace",
    "  bashwink evidence verify Verify the hash-chained evidence.jsonl log",
    "  bashwink --version       Print version",
    "  bashwink --help          Print this help",
    "",
    "BUILT-IN TOOLS",
    "  list_files, read_file, edit_file (diff + approval), run_command (argv + approval)",
    "",
    "PATHS",
    `  Config:   ${configDir}`,
    `  Data:     ${dataDir}`,
    "",
    "EXIT CODES",
    "  0   completed",
    "  1   check failed (doctor / evidence verify) or runtime error",
    "  2   invalid usage or removed legacy subcommand",
    "  3   unsupported mode requested (--sandbox)",
    "  130 interrupted (Ctrl+C / SIGTERM)",
    "",
  ].join("\n")
}

function isYes(answer: string | null): boolean {
  if (answer === null) return false
  const clean = answer.trim().toLowerCase()
  return clean === "y" || clean === "yes"
}

function parseCredentialChoice(cred: CredentialConfig): string {
  if (cred.kind === "none") return "None (unauthenticated)"
  if (cred.kind === "env") return `Environment variable ${cred.variable}`
  return `Key file ${cred.path}`
}

export async function runInteractiveSetup(
  io: TerminalIO,
  configDirectory: string,
  env: NodeJS.ProcessEnv,
  existing?: StandaloneConfig,
): Promise<{ readonly status: "saved"; readonly config: StandaloneConfig } | { readonly status: "cancelled" }> {
  io.write(`\nBashwink ${STANDALONE_VERSION}\n`)
  io.write(existing ? "Update provider connection (cancelling keeps your existing profile)\n" : "First-time setup\n")

  if (!existing) {
    const legacy = inspectLegacyOpenAiProviders(configDirectory)
    if (legacy.length > 0) {
      io.write(`Found ${legacy.length} legacy provider entry(ies) in opencode.json (not loaded automatically):\n`)
      for (const item of legacy) {
        io.write(`  - ${sanitizeTerminalText(item.id)}: ${sanitizeTerminalText(item.model)} at ${sanitizeTerminalText(item.baseURL)}\n`)
      }
      const importAns = await io.ask("Import one of these references? [y/N] ")
      if (importAns === null) return { status: "cancelled" }
      if (isYes(importAns)) {
        const chosen = legacy[0]!
        const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\b/i.test(chosen.baseURL)
        const endpointType: "local" | "hosted" = isLoopback ? "local" : "hosted"
        try {
          const normalizedURL = normalizeBaseURL(chosen.baseURL, endpointType)
          const model = validateModelID(chosen.model)
          io.write(`  Endpoint    ${normalizedURL}\n`)
          io.write(`  Model       ${model}\n`)
          io.write(`  Credentials ${parseCredentialChoice(chosen.credential)}\n`)
          const confirm = await io.ask("Save and use this imported connection? [y/N] ")
          if (isYes(confirm)) {
            const cfg: StandaloneConfig = {
              version: 1,
              endpointType,
              baseURL: normalizedURL,
              model,
              credential: chosen.credential,
              updatedAt: new Date().toISOString(),
            }
            saveStandaloneConfig(configDirectory, cfg)
            return { status: "saved", config: cfg }
          }
          if (confirm === null) return { status: "cancelled" }
        } catch (err) {
          io.writeError(`  Could not import legacy entry: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
    }
  }

  let endpointType: "local" | "hosted" | undefined
  while (endpointType === undefined) {
    io.write("Where should Bashwink send model requests?\n")
    io.write("  1) Hosted endpoint (HTTPS)\n")
    io.write("  2) Local endpoint (loopback HTTP or HTTPS)\n")
    const choice = await io.ask("Choose [1/2] (or 'cancel'): ")
    if (choice === null) return { status: "cancelled" }
    const t = choice.trim().toLowerCase()
    if (t === "cancel" || t === "q" || t === "quit") return { status: "cancelled" }
    if (t === "1" || t === "hosted") endpointType = "hosted"
    else if (t === "2" || t === "local") endpointType = "local"
    else io.write("  Please enter 1 (Hosted) or 2 (Local).\n")
  }

  let baseURL: string | undefined
  while (baseURL === undefined) {
    const hint =
      endpointType === "local" ? "Endpoint URL (e.g. http://127.0.0.1:8080/v1): " : "Endpoint URL (https://...): "
    const rawUrl = await io.ask(hint)
    if (rawUrl === null) return { status: "cancelled" }
    if (rawUrl.trim().toLowerCase() === "cancel") return { status: "cancelled" }
    try {
      baseURL = normalizeBaseURL(rawUrl, endpointType)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  let model: string | undefined
  while (model === undefined) {
    const rawModel = await io.ask("Model ID (for example gpt-4o-mini or qwen-coder): ")
    if (rawModel === null) return { status: "cancelled" }
    if (rawModel.trim().toLowerCase() === "cancel") return { status: "cancelled" }
    try {
      model = validateModelID(rawModel)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  let credential: CredentialConfig | undefined
  while (credential === undefined) {
    io.write("How should Bashwink authenticate to this endpoint?\n")
    io.write("  1) None (no key needed)\n")
    io.write("  2) Environment variable name\n")
    io.write("  3) Key file path\n")
    const mode = await io.ask("Choose [1/2/3] (or 'cancel'): ")
    if (mode === null) return { status: "cancelled" }
    const m = mode.trim().toLowerCase()
    if (m === "cancel") return { status: "cancelled" }
    if (m === "1" || m === "none") {
      credential = { kind: "none" }
    } else if (m === "2" || m === "env") {
      const varName = await io.ask("Environment variable name (e.g. MY_API_KEY): ")
      if (varName === null) return { status: "cancelled" }
      try {
        credential = { kind: "env", variable: validateEnvVarName(varName) }
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
    } else if (m === "3" || m === "file") {
      const keyFile = await io.ask("Key file path: ")
      if (keyFile === null) return { status: "cancelled" }
      try {
        credential = { kind: "file", path: validateKeyFilePath(keyFile) }
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
    } else {
      io.write("  Please enter 1, 2, or 3.\n")
    }
  }

  const credCheck = resolveCredentialSecret(credential, env)
  io.write("\nReview connection (zero requests sent during setup):\n")
  io.write(`  Type        ${endpointType}\n`)
  io.write(`  Endpoint    ${baseURL}\n`)
  io.write(`  Model       ${model}\n`)
  io.write(`  Credentials ${credCheck.summary}\n`)
  if (credCheck.warning) {
    io.write(`  Warning     ${credCheck.warning}\n`)
  }
  const confirm = await io.ask("Save and use this connection? [y/N] ")
  if (!isYes(confirm)) {
    io.write("Setup cancelled; profile unchanged.\n")
    return { status: "cancelled" }
  }

  const config: StandaloneConfig = {
    version: 1,
    endpointType,
    baseURL,
    model,
    credential,
    updatedAt: new Date().toISOString(),
  }
  saveStandaloneConfig(configDirectory, config)
  io.write(`Saved connection to ${standaloneConfigFile(configDirectory)}.\n`)
  return { status: "saved", config }
}

function runDoctor(cwd: string, env: NodeJS.ProcessEnv, io: TerminalIO): number {
  const resolved = resolveStandalonePaths(env)
  const [majorRaw, minorRaw] = process.versions.node.split(".")
  const major = Number(majorRaw ?? "0")
  const minor = Number(minorRaw ?? "0")
  let failures = 0

  if (major > 22 || (major === 22 && minor >= 13)) {
    io.write(`✓ Node.js: v${process.versions.node} (>= 22.13.0 required)\n`)
  } else {
    io.write(`✗ Node.js: v${process.versions.node} (Node.js >= 22.13.0 is required)\n`)
    failures += 1
  }

  const cfgState = loadStandaloneConfig(resolved.config)
  if (cfgState.status === "ok") {
    io.write(`✓ Profile: ${cfgState.config.model} at ${cfgState.config.baseURL} (${standaloneConfigFile(resolved.config)})\n`)
    const cred = resolveCredentialSecret(cfgState.config.credential, env)
    if (cred.ok) {
      io.write(`✓ Credentials: ${cred.summary}\n`)
      if (cred.warning) io.write(`! Credential warning: ${cred.warning}\n`)
    } else {
      io.write(`✗ Credentials: ${cred.summary}\n`)
      io.write("    fix: set the configured variable/file or run `bashwink setup`\n")
      failures += 1
    }
  } else if (cfgState.status === "missing") {
    io.write(`! Profile: not configured yet (${standaloneConfigFile(resolved.config)})\n`)
    io.write("    fix: run `bashwink` or `bashwink setup` in an interactive terminal\n")
  } else {
    io.write(`✗ Profile: invalid config (${cfgState.reason})\n`)
    io.write("    fix: run `bashwink setup` to repair it\n")
    failures += 1
  }

  const canonical = canonicalWorkspace(cwd)
  const trusted = isWorkspaceTrusted(resolved.config, canonical)
  if (trusted) {
    io.write(`✓ Workspace trust: ${canonical} is trusted (edits and commands still confirm)\n`)
  } else {
    io.write(`! Workspace trust: ${canonical} is NOT trusted (read-only until trusted)\n`)
    io.write(`    fix: run \`bashwink\` interactively or \`bashwink trust "${canonical}" --by "<you>"\`\n`)
  }

  const evFile = path.join(resolved.evidence, "evidence.jsonl")
  if (existsSync(evFile)) {
    const v = verifyEvidenceFile(evFile)
    if (v.ok) {
      io.write(`✓ Evidence log: ${evFile} (${v.entries} entries, head ${v.head.slice(0, 12)}…)\n`)
    } else {
      io.write(`✗ Evidence log: verification failed (${v.reason})\n`)
      failures += 1
    }
  } else {
    io.write(`! Evidence log: not created yet (${evFile})\n`)
  }

  return failures === 0 ? 0 : 1
}

function renderTaskOutcome(result: TaskResult, io: TerminalIO): void {
  if (result.finalText.trim() !== "") {
    io.write(`\n${sanitizeTerminalText(result.finalText.trim())}\n`)
  }
  io.write("\n--- Task Summary ---\n")
  io.write(`Outcome   ${result.outcome}${result.stopReason ? ` — ${sanitizeTerminalText(result.stopReason)}` : ""}\n`)
  io.write(`Changed   ${result.changedFiles.length > 0 ? result.changedFiles.join(", ") : "none"}\n`)
  if (result.changedTests.length > 0) {
    io.write(`Tests     modified test files: ${result.changedTests.join(", ")} (verify independently)\n`)
  }
  if (result.commands.length === 0) {
    io.write("Commands  none\n")
  } else {
    for (const cmd of result.commands) {
      const cmdStr = sanitizeTerminalText([cmd.command, ...cmd.args].join(" "))
      const status =
        cmd.decision === "denied"
          ? "declined"
          : cmd.timedOut
            ? "timed out"
            : cmd.signal
              ? `signal ${cmd.signal}`
              : `exited ${cmd.exitCode === null ? "unknown" : String(cmd.exitCode)}`
      io.write(`Command   ${cmdStr} -> ${status}\n`)
    }
  }
  io.write(
    `Usage     ${result.requests} request(s), ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens` +
      (result.usage.costUsd !== undefined ? `, est. $${result.usage.costUsd.toFixed(6)}` : "") +
      "\n",
  )
  io.write(`Evidence  ${result.evidenceFile}\n`)
  io.write(`Run       ${result.runRecordFile}\n`)
}

export async function runStandalone(
  argv: readonly string[],
  options: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    readonly io?: TerminalIO
    readonly completeImpl?: Parameters<typeof runTask>[1]["completeImpl"]
  } = {},
): Promise<number> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const io = options.io ?? new NodeTerminalIO()
  const resolved = resolveStandalonePaths(env)

  try {
    const first = argv[0]

    if (first === "--version" || first === "-v") {
      io.write(renderVersion())
      return 0
    }
    if (first === "--help" || first === "-h") {
      io.write(renderHelp(resolved.config, resolved.data))
      return 0
    }
    if (argv.includes("--sandbox")) {
      io.writeError(
        "bashwink: --sandbox (isolated VM) is not included in the standalone alpha package; refusing rather than running unsandboxed.\n",
      )
      return 3
    }
    if (first === "doctor") {
      return runDoctor(cwd, env, io)
    }
    if (first === "trust") {
      const args = argv.slice(1)
      let dir = cwd
      let by: string | undefined
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i]!
        if (a === "--by") {
          by = args[i + 1]
          i += 1
        } else if (a.startsWith("--by=")) {
          by = a.slice("--by=".length)
        } else if (!a.startsWith("-")) {
          dir = a
        }
      }
      if (!by || by.trim() === "") {
        io.writeError("bashwink trust requires --by <name> for attribution.\n")
        return 2
      }
      const canonical = canonicalWorkspace(path.resolve(cwd, dir))
      ensurePaths(resolved)
      grantWorkspaceTrust(resolved.config, canonical, by.trim())
      io.write(`Trusted ${canonical} (granted by ${by.trim()}).\n`)
      return 0
    }
    if (first === "evidence" && argv[1] === "verify") {
      const file = argv[2] ? path.resolve(cwd, argv[2]) : path.join(resolved.evidence, "evidence.jsonl")
      const res = verifyEvidenceFile(file)
      if (res.ok) {
        io.write(`Evidence OK: ${res.entries} entries (head ${res.head}).\n`)
        return 0
      }
      io.writeError(`Evidence verification failed: ${res.reason}\n`)
      return 1
    }
    if (first === "setup") {
      if (!io.isTTY) {
        io.writeError(
          "bashwink setup requires an interactive terminal to configure endpoint, model, and credential references.\n",
        )
        return 2
      }
      const existing = loadStandaloneConfig(resolved.config)
      const outcome = await runInteractiveSetup(
        io,
        resolved.config,
        env,
        existing.status === "ok" ? existing.config : undefined,
      )
      return outcome.status === "saved" ? 0 : 0
    }
    if (first !== undefined) {
      io.writeError(
        `bashwink: '${first}' is not part of the standalone alpha CLI (run 'bashwink --help'). No external runtime was invoked.\n`,
      )
      return 2
    }

    // Bare `bashwink`: interactive first-run setup or task prompt.
    if (!io.isTTY) {
      const cfg = loadStandaloneConfig(resolved.config)
      if (cfg.status !== "ok") {
        io.write(
          `Bashwink ${STANDALONE_VERSION}: no provider profile is configured.\n` +
            "Run `bashwink` or `bashwink setup` in an interactive terminal to choose an endpoint, model, and credential reference.\n",
        )
        return 0
      }
      io.write(
        `Bashwink ${STANDALONE_VERSION} requires an interactive terminal (TTY) for approvals.\n` +
          `Saved model: ${cfg.config.model} at ${formatDestination(cfg.config.baseURL)}.\n`,
      )
      return 0
    }

    let cfgState = loadStandaloneConfig(resolved.config)
    let activeConfig: StandaloneConfig
    if (cfgState.status !== "ok") {
      if (cfgState.status === "invalid") {
        io.writeError(`Saved profile could not be loaded: ${cfgState.reason}\n`)
      }
      const setupResult = await runInteractiveSetup(io, resolved.config, env)
      if (setupResult.status === "cancelled") {
        return 0
      }
      activeConfig = setupResult.config
    } else {
      activeConfig = cfgState.config
    }

    const canonical = canonicalWorkspace(cwd)
    ensurePaths(resolved)

    if (!isWorkspaceTrusted(resolved.config, canonical)) {
      io.write(`\nWorkspace ${canonical} is NOT trusted yet (read-only mode).\n`)
      io.write(
        "Reads are allowed. File edits and commands require trusting this directory, and approved actions run with your user permissions (not an OS sandbox).\n",
      )
      const trustAns = await io.ask("Trust this workspace for interactive edit/command approvals? [y/N] ")
      if (trustAns === null) return 0
      if (isYes(trustAns)) {
        const user = env["USER"] ?? env["USERNAME"] ?? "terminal-user"
        grantWorkspaceTrust(resolved.config, canonical, user)
        io.write(`Trusted ${canonical}.\n`)
      } else {
        io.write("Continuing in read-only mode (edits and commands will be denied).\n")
      }
    }

    let currentAbort: AbortController | undefined
    let interruptedAtPrompt = false
    const onSigint = () => {
      if (currentAbort) {
        io.write("\nCancelling current task...\n")
        currentAbort.abort()
      } else {
        interruptedAtPrompt = true
        io.write("\nInterrupted.\n")
        io.close()
      }
    }
    const onResize = () => {
      // Line-oriented UI adapts naturally to width changes; keep running cleanly on SIGWINCH.
    }
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigint)
    process.stdout.on("resize", onResize)

    try {
      while (!interruptedAtPrompt) {
        const trusted = isWorkspaceTrusted(resolved.config, canonical)
        io.write("\n")
        io.write(`Project  ${canonical}\n`)
        io.write(`Trust    ${trusted ? "trusted (confirm edits & commands)" : "read-only (untrusted)"}\n`)
        io.write(`Model    ${activeConfig.model} at ${formatDestination(activeConfig.baseURL)}\n`)
        io.write("Type a task, or /setup, /trust, /help, /exit:\n")

        const line = await io.ask("> ")
        if (line === null || interruptedAtPrompt) break

        const trimmed = line.trim()
        if (trimmed === "") continue
        if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") break
        if (trimmed === "/help") {
          io.write(renderHelp(resolved.config, resolved.data))
          continue
        }
        if (trimmed === "/trust") {
          const user = env["USER"] ?? env["USERNAME"] ?? "terminal-user"
          grantWorkspaceTrust(resolved.config, canonical, user)
          io.write(`Trusted ${canonical}.\n`)
          continue
        }
        if (trimmed === "/setup") {
          const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
          if (res.status === "saved") activeConfig = res.config
          continue
        }

        const cred = resolveCredentialSecret(activeConfig.credential, env)
        if (!cred.ok) {
          io.writeError(
            `\nProvider at ${formatDestination(activeConfig.baseURL)} cannot authenticate (${cred.summary}).\n`,
          )
          const repair = await io.ask("Open setup to repair provider credentials? [y/N] ")
          if (isYes(repair)) {
            const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
            if (res.status === "saved") activeConfig = res.config
          }
          continue
        }

        currentAbort = new AbortController()
        const result = await runTask(
          {
            workspace: canonical,
            prompt: trimmed,
            trusted,
            config: activeConfig,
            signal: currentAbort.signal,
          },
          {
            paths: resolved,
            env,
            ...(options.completeImpl ? { completeImpl: options.completeImpl } : {}),
            onEvent: (event: TaskEvent) => {
              if (event.type === "model_requested") {
                io.write(`Waiting for ${event.model} at ${formatDestination(event.endpoint)}...\n`)
              } else if (event.type === "tool_completed") {
                if (event.result.tool === "list_files" || event.result.tool === "read_file") {
                  io.write(`${event.result.tool} -> ${event.result.status}\n`)
                }
              }
            },
            confirmAction: async (req: ApprovalRequest): Promise<boolean> => {
              if (req.kind === "edit_file") {
                io.write(`\nEdit     ${sanitizeTerminalText(req.prepared.relativePath)}\n`)
                io.write(`${sanitizeTerminalText(req.prepared.diffPreview)}\n`)
                const ans = await io.ask("Apply this change? [y/N] ", currentAbort?.signal)
                return isYes(ans)
              }
              const cmdLine = sanitizeTerminalText([req.prepared.command, ...req.prepared.args].join(" "))
              io.write(`\nRun      ${cmdLine}\n`)
              io.write(`Dir      ${sanitizeTerminalText(req.prepared.cwd)}\n`)
              io.write(`Warning  ${req.hostAccessWarning}\n`)
              const ans = await io.ask("Run this command? [y/N] ", currentAbort?.signal)
              return isYes(ans)
            },
          },
        )
        currentAbort = undefined
        renderTaskOutcome(result, io)

        if (
          result.outcome === "failed" &&
          result.stopReason &&
          /(401|403|rejected authentication|cannot authenticate)/i.test(result.stopReason)
        ) {
          const repair = await io.ask("Provider rejected request. Run /setup to repair? [y/N] ")
          if (isYes(repair)) {
            const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
            if (res.status === "saved") activeConfig = res.config
          }
        }
      }
      return interruptedAtPrompt ? 130 : 0
    } finally {
      process.removeListener("SIGINT", onSigint)
      process.removeListener("SIGTERM", onSigint)
      process.stdout.removeListener("resize", onResize)
    }
  } finally {
    io.close()
  }
}
