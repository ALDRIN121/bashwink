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
import { PROVIDER_CATALOG, findProviderPreset, type ProviderPreset } from "./provider-catalog.ts"
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
    "  bashwink                 Open Bashwink interactive CLI (prompts to configure model if unset)",
    "  bashwink setup           Configure or update provider, endpoint URL, model, and credentials",
    "  bashwink connect         Alias for setup (interactive OpenCode-compatible provider picker)",
    "  bashwink doctor          Check Node, saved profile, credential reference, trust, and evidence",
    "  bashwink trust [dir] --by <name>",
    "                           Grant interactive write/command trust to a workspace",
    "  bashwink evidence verify Verify the hash-chained evidence.jsonl log",
    "  bashwink --version       Print version",
    "  bashwink --help          Print this help",
    "",
    "INTERACTIVE COMMANDS",
    "  /model, /connect         Choose provider preset (OpenAI, OpenRouter, DeepSeek, Groq, xAI, Ollama, LM Studio, vLLM, or custom)",
    "  /trust                   Trust current project for interactive edit/command approvals",
    "  /help, /exit             Show help or quit",
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

function renderCliHeader(
  io: TerminalIO,
  workspace: string,
  trusted: boolean,
  config?: StandaloneConfig,
): void {
  const modelLine = config
    ? `${config.providerId ? `${config.providerId} / ` : ""}${config.model} (${formatDestination(config.baseURL)})`
    : "none configured"
  const trustLine = trusted
    ? "trusted (edits & commands confirm)"
    : "not trusted (read-only until /trust)"
  io.write("\n╭──────────────────────────────────────────────────────────────────╮\n")
  io.write(`│ Bashwink ${STANDALONE_VERSION}  (standalone CLI)                                │\n`)
  io.write(`│ Project  ${sanitizeTerminalText(workspace)}\n`)
  io.write(`│ Trust    ${trustLine}\n`)
  io.write(`│ Model    ${sanitizeTerminalText(modelLine)}\n`)
  io.write("╰──────────────────────────────────────────────────────────────────╯\n")
  io.write("Commands: /model  /connect  /trust  /help  /exit\n")
}

export async function runInteractiveSetup(
  io: TerminalIO,
  configDirectory: string,
  env: NodeJS.ProcessEnv,
  existing?: StandaloneConfig,
): Promise<{ readonly status: "saved"; readonly config: StandaloneConfig } | { readonly status: "cancelled" }> {
  io.write(`\nConfigure model  (0 network requests made during setup)\n`)
  if (existing) {
    io.write(
      `Current: ${existing.providerId ? `${existing.providerId} / ` : ""}${existing.model} (${formatDestination(existing.baseURL)})\n`,
    )
    io.write("Cancelling keeps your existing configuration.\n")
  }

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

  let preset: ProviderPreset | undefined
  while (preset === undefined) {
    io.write("\nHosted providers (HTTPS):\n")
    for (const p of PROVIDER_CATALOG.filter((c) => c.endpointType === "hosted")) {
      const tag = p.defaultBaseURL ?? p.note
      io.write(`  ${String(p.index).padStart(2, " ")}) ${p.name.padEnd(23, " ")} ${tag}\n`)
    }
    io.write("\nLocal servers (loopback HTTP/HTTPS):\n")
    for (const p of PROVIDER_CATALOG.filter((c) => c.endpointType === "local")) {
      const tag = p.defaultBaseURL ?? p.note
      io.write(`  ${String(p.index).padStart(2, " ")}) ${p.name.padEnd(23, " ")} ${tag}\n`)
    }
    const choice = await io.ask("Select provider [1-10 or id] (or 'cancel'): ")
    if (choice === null) return { status: "cancelled" }
    const t = choice.trim().toLowerCase()
    if (t === "cancel" || t === "q" || t === "quit") return { status: "cancelled" }
    const matched = findProviderPreset(t)
    if (matched) {
      preset = matched
    } else {
      io.write("  Please enter a number 1-10, a provider id (e.g. openai, ollama), or 'cancel'.\n")
    }
  }

  const endpointType = preset.endpointType
  let baseURL: string | undefined
  while (baseURL === undefined) {
    const promptText = preset.defaultBaseURL
      ? `Endpoint URL [Enter for ${preset.defaultBaseURL}]: `
      : endpointType === "local"
        ? "Endpoint URL (e.g. http://127.0.0.1:8080/v1): "
        : "Endpoint URL (https://...): "
    const rawUrl = await io.ask(promptText)
    if (rawUrl === null) return { status: "cancelled" }
    const trimmed = rawUrl.trim()
    if (trimmed.toLowerCase() === "cancel") return { status: "cancelled" }
    const effectiveRaw = trimmed === "" && preset.defaultBaseURL ? preset.defaultBaseURL : trimmed
    try {
      baseURL = normalizeBaseURL(effectiveRaw, endpointType)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  let model: string | undefined
  while (model === undefined) {
    if (preset.defaultModels.length > 0) {
      io.write(`\nSuggested ${preset.name} models:\n`)
      preset.defaultModels.forEach((m, idx) => {
        io.write(`  ${idx + 1}) ${m}\n`)
      })
    }
    const modelPrompt =
      preset.defaultModels.length > 0
        ? `Model ID or number [Enter for ${preset.defaultModels[0]}]: `
        : "Model ID (for example gpt-4o-mini or qwen-coder): "
    const rawModel = await io.ask(modelPrompt)
    if (rawModel === null) return { status: "cancelled" }
    const trimmed = rawModel.trim()
    if (trimmed.toLowerCase() === "cancel") return { status: "cancelled" }
    let candidate = trimmed
    if (candidate === "" && preset.defaultModels.length > 0) {
      candidate = preset.defaultModels[0]!
    } else if (/^\d+$/.test(candidate) && preset.defaultModels.length > 0) {
      const idx = Number(candidate) - 1
      if (idx >= 0 && idx < preset.defaultModels.length) {
        candidate = preset.defaultModels[idx]!
      }
    }
    try {
      model = validateModelID(candidate)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  let credential: CredentialConfig | undefined
  while (credential === undefined) {
    io.write("\nAuthentication:\n")
    io.write(
      `  1) Environment variable name${preset.defaultEnvVar ? ` (e.g. ${preset.defaultEnvVar})` : ""}\n`,
    )
    io.write("  2) Key file path\n")
    io.write("  3) None (no key needed)\n")
    const mode = await io.ask("Choose [1/2/3] (or 'cancel'): ")
    if (mode === null) return { status: "cancelled" }
    const m = mode.trim().toLowerCase()
    if (m === "cancel") return { status: "cancelled" }
    if (m === "1" || m === "env") {
      const envPrompt = preset.defaultEnvVar
        ? `Environment variable name [Enter for ${preset.defaultEnvVar}]: `
        : "Environment variable name (e.g. MY_API_KEY): "
      const varName = await io.ask(envPrompt)
      if (varName === null) return { status: "cancelled" }
      const effectiveVar = varName.trim() === "" && preset.defaultEnvVar ? preset.defaultEnvVar : varName
      try {
        credential = { kind: "env", variable: validateEnvVarName(effectiveVar) }
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
    } else if (m === "2" || m === "file") {
      const keyFile = await io.ask("Key file path: ")
      if (keyFile === null) return { status: "cancelled" }
      try {
        credential = { kind: "file", path: validateKeyFilePath(keyFile) }
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
    } else if (m === "3" || m === "none") {
      credential = { kind: "none" }
    } else {
      io.write("  Please enter 1, 2, or 3.\n")
    }
  }

  const credCheck = resolveCredentialSecret(credential, env)
  io.write("\nReview connection (zero requests sent during setup):\n")
  io.write(`  Provider    ${preset.name} (${preset.id})\n`)
  io.write(`  Type        ${endpointType}\n`)
  io.write(`  Endpoint    ${baseURL}\n`)
  io.write(`  Model       ${model}\n`)
  io.write(`  Credentials ${credCheck.summary}\n`)
  if (credCheck.warning) {
    io.write(`  Warning     ${credCheck.warning}\n`)
  }
  const confirm = await io.ask("Save and use this model? [y/N] ")
  if (!isYes(confirm)) {
    io.write("Setup cancelled; profile unchanged.\n")
    return { status: "cancelled" }
  }

  const config: StandaloneConfig = {
    version: 1,
    providerId: preset.id,
    endpointType,
    baseURL,
    model,
    credential,
    ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
    updatedAt: new Date().toISOString(),
  }
  saveStandaloneConfig(configDirectory, config)
  io.write(`Saved model configuration to ${standaloneConfigFile(configDirectory)}.\n`)
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
    if (first === "setup" || first === "connect" || (first === "model" && argv.length === 1)) {
      if (!io.isTTY) {
        io.writeError(
          `bashwink ${first} requires an interactive terminal to configure provider, model, and credential references.\n`,
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

    // Bare `bashwink`: open interactive CLI workspace immediately, prompting for model configuration on first launch.
    if (!io.isTTY) {
      const cfg = loadStandaloneConfig(resolved.config)
      if (cfg.status !== "ok") {
        io.write(
          `Bashwink ${STANDALONE_VERSION}: no provider/model configured.\n` +
            "Run `bashwink` or `bashwink setup` interactively and choose `/model` to configure a provider and model.\n",
        )
        return 0
      }
      io.write(
        `Bashwink ${STANDALONE_VERSION} requires an interactive terminal (TTY) for approvals.\n` +
          `Saved model: ${cfg.config.model} at ${formatDestination(cfg.config.baseURL)}.\n`,
      )
      return 0
    }

    const cfgState = loadStandaloneConfig(resolved.config)
    let activeConfig: StandaloneConfig | undefined =
      cfgState.status === "ok" ? cfgState.config : undefined
    if (cfgState.status === "invalid") {
      io.writeError(`Saved profile could not be loaded: ${cfgState.reason}\n`)
    }

    const canonical = canonicalWorkspace(cwd)
    ensurePaths(resolved)

    let currentAbort: AbortController | undefined
    let interruptedAtPrompt = false
    let trustPromptShown = false
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
      renderCliHeader(io, canonical, isWorkspaceTrusted(resolved.config, canonical), activeConfig)
      if (!activeConfig) {
        io.write("\nWelcome to Bashwink! Configure a model to get started\n")
        io.write("  (0 outbound requests sent; ambient env keys are ignored).\n")
        io.write("Type /model or /connect (or press Enter) to select a provider and model.\n")
      }

      while (!interruptedAtPrompt) {
        let trusted = isWorkspaceTrusted(resolved.config, canonical)
        const promptLabel = activeConfig ? "bashwink> " : "bashwink (no model)> "
        const line = await io.ask(`\n${promptLabel}`)
        if (line === null || interruptedAtPrompt) break

        const trimmed = line.trim()
        if (trimmed === "") {
          if (!activeConfig) {
            const res = await runInteractiveSetup(io, resolved.config, env, undefined)
            if (res.status === "saved") {
              activeConfig = res.config
              renderCliHeader(io, canonical, isWorkspaceTrusted(resolved.config, canonical), activeConfig)
            }
          }
          continue
        }
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
        if (
          trimmed === "/setup" ||
          trimmed === "/connect" ||
          trimmed === "/model" ||
          trimmed === "connect"
        ) {
          const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
          if (res.status === "saved") {
            activeConfig = res.config
            renderCliHeader(io, canonical, isWorkspaceTrusted(resolved.config, canonical), activeConfig)
          }
          continue
        }

        if (!activeConfig) {
          io.write("\nNo model configured yet — configure a model first.\n")
          const res = await runInteractiveSetup(io, resolved.config, env, undefined)
          if (res.status !== "saved") continue
          activeConfig = res.config
          renderCliHeader(io, canonical, isWorkspaceTrusted(resolved.config, canonical), activeConfig)
        }

        if (!trusted && !trustPromptShown) {
          trustPromptShown = true
          io.write(`\nWorkspace ${canonical} is NOT trusted yet (read-only mode).\n`)
          io.write(
            "Reads are allowed. File edits and commands require trusting this directory, and approved actions run with your user permissions (not an OS sandbox).\n",
          )
          const trustAns = await io.ask("Trust this workspace for interactive edit/command approvals? [y/N] ")
          if (trustAns === null) break
          if (isYes(trustAns)) {
            const user = env["USER"] ?? env["USERNAME"] ?? "terminal-user"
            grantWorkspaceTrust(resolved.config, canonical, user)
            trusted = true
            io.write(`Trusted ${canonical}.\n`)
          } else {
            io.write("Continuing in read-only mode (edits and commands will be denied).\n")
          }
        }

        const cred = resolveCredentialSecret(activeConfig.credential, env)
        if (!cred.ok) {
          io.writeError(
            `\nProvider at ${formatDestination(activeConfig.baseURL)} cannot authenticate (${cred.summary}).\n`,
          )
          const repair = await io.ask("Open /model setup to repair provider credentials? [y/N] ")
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
