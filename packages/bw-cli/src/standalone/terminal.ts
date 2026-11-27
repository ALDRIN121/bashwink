/**
 * Interactive standalone Bashwink terminal UI and CLI commands.
 *
 * Kept strictly decoupled from provider HTTP transport and task-loop orchestration:
 * communicates with `runTask` through plain `TaskInput`, `ApprovalRequest`, and `TaskEvent`s.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises"
import { ensurePaths } from "../paths.ts"
import { LimitConfigError, parseLimits } from "../usage-guard.ts"
import {
  formatDestination,
  inspectLegacyOpenAiProviders,
  loadStandaloneConfig,
  normalizeBaseURL,
  resolveCredentialSecret,
  resolveStandalonePaths,
  saveProviderKeyFile,
  saveStandaloneConfig,
  standaloneConfigFile,
  validateEnvVarName,
  validateKeyFilePath,
  validateModelID,
} from "./config.ts"
import {
  approveActiveContract,
  createStandaloneContract,
  loadActiveContract,
  rejectActiveContract,
  renderContractSummary,
  reviseActiveContract,
} from "./contract-store.ts"
import { exportProofBundle, renderProofSummary, verifyProofPack } from "./proof.ts"
import { probeModels, testProviderConnection, type TestConnectionResult } from "./provider.ts"
import {
  PERMISSION_MODES,
  canonicalWorkspace,
  clearWorkspacePermissionRules,
  createBoundaryContext,
  grantWorkspaceTrust,
  isValidPermissionMode,
  isWorkspaceTrusted,
  loadRunRecord,
  loadWorkspacePermissions,
  nextPermissionMode,
  permissionModeLabel,
  purgeExpiredArtifacts,
  sanitizeSecretText,
  saveAlwaysPermissionRule,
  setWorkspacePermissionMode,
  verifyEvidenceFile,
} from "./security.ts"
import {
  appendPromptHistory,
  appendTurnToSession,
  captureFileCheckpoint,
  compactSessionMessages,
  createSession,
  deleteSession,
  detectGitBranch,
  finalizeTurnCheckpoints,
  forkSession,
  listSessions,
  loadPromptHistory,
  loadSession,
  restoreTurnCheckpoints,
  rewindSessionToTurn,
  saveSession,
  type FileCheckpoint,
  type SessionRecord,
} from "./session.ts"
import { runTask, type ApprovalRequest } from "./task-loop.ts"
import { PROVIDER_CATALOG, findProviderPreset, type ProviderPreset } from "./provider-catalog.ts"
import {
  CURSOR_SHOW,
  SYNC_END,
  SYNC_START,
  colorsEnabled,
  countDiffChanges,
  createStyle,
  getTerminalLayout,
  padPlainRight,
  renderOpenCodeDiff,
  renderOpenCodeMarkdown,
  renderOpenCodeShellCard,
  truncatePathMiddle,
  truncatePlain,
  type ParsedKeyEvent,
  type PromptMetadataInput,
  type StatusFooterInput,
  type TerminalLayout,
  type TuiStyle,
} from "./tui-theme.ts"
import {
  RawTerminalSession,
  SLASH_COMMANDS,
  askHybridChoice,
  askHybridConfirm,
  askHybridPermission,
  formatRelativeTime,
  openCommandPalette,
  openScrollableModal,
  openSessionBrowser,
  openTimelineRewind,
  openTranscriptViewer,
  runInteractiveComposer,
  type ComposerAction,
  type HybridChoiceOption,
  type HybridPermissionOptions,
  type PaletteCommandItem,
} from "./tui-widgets.ts"
import type {
  ApprovalDecision,
  CredentialConfig,
  PermissionMode,
  ProofPackManifest,
  SavedPermissionRule,
  StandaloneConfig,
  TaskBudgets,
  TaskEvent,
  TaskResult,
} from "./types.ts"

export const STANDALONE_VERSION = "0.2.0-alpha.2"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Strip ANSI escape sequences and unsafe control characters from untrusted model/file/command text. */
export function sanitizeTerminalText(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1)
      if (next === 0x5b) {
        let j = i + 2
        while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e))
          j += 1
        i = j < text.length ? j + 1 : text.length
        continue
      }
      if (next === 0x5d) {
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
  cols?(): number
  rows?(): number
  write(text: string): void
  writeError(text: string): void
  ask(prompt: string, signal?: AbortSignal): Promise<string | null>
  askSecret?(prompt: string, signal?: AbortSignal): Promise<string | null>
  close(): void
}

function terminalCols(io: TerminalIO): number {
  const v = io.cols?.() ?? process.stdout.columns ?? 100
  return Math.max(20, Number.isFinite(v) && v > 0 ? v : 100)
}

function terminalRows(io: TerminalIO): number {
  const v = io.rows?.() ?? process.stdout.rows ?? 30
  return Math.max(8, Number.isFinite(v) && v > 0 ? v : 30)
}

class NodeTerminalIO implements TerminalIO {
  readonly isTTY: boolean
  private rl: ReadlineInterface | undefined

  constructor() {
    this.isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  }

  cols(): number {
    return Math.max(20, process.stdout.columns ?? 100)
  }

  rows(): number {
    return Math.max(8, process.stdout.rows ?? 30)
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

class RawTerminalIO implements TerminalIO {
  readonly isTTY = true
  readonly raw: RawTerminalSession
  readonly style: TuiStyle

  constructor(env: NodeJS.ProcessEnv) {
    this.raw = new RawTerminalSession()
    this.style = createStyle(colorsEnabled(env, true))
  }

  cols(): number {
    return this.raw.cols()
  }

  rows(): number {
    return this.raw.rows()
  }

  write(text: string): void {
    this.raw.write(text)
  }

  writeError(text: string): void {
    process.stderr.write(text)
  }

  async ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    return await this.askLine(prompt, false, signal)
  }

  async askSecret(prompt: string, signal?: AbortSignal): Promise<string | null> {
    return await this.askLine(prompt, true, signal)
  }

  private async askLine(
    prompt: string,
    maskSecret: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let buffer = ""
    let cursor = 0
    let rendered = false

    const redraw = () => {
      const display = maskSecret ? "•".repeat(buffer.length) : buffer
      let frame = SYNC_START
      if (rendered) frame += "\r\x1b[2K"
      frame += prompt + display
      const back = (maskSecret ? display.length : buffer.length) - cursor
      if (back > 0) frame += `\x1b[${back}D`
      frame += CURSOR_SHOW + SYNC_END
      this.raw.write(frame)
      rendered = true
    }

    return await new Promise<string | null>((resolve) => {
      let done = false
      let cleanup = () => {}
      const onAbort = () => finish(null)
      const finish = (val: string | null) => {
        if (done) return
        done = true
        signal?.removeEventListener("abort", onAbort)
        cleanup()
        this.raw.write("\n")
        resolve(val)
      }
      if (signal?.aborted) {
        finish(null)
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      const onKey = (ev: ParsedKeyEvent) => {
        if (ev.kind === "ctrl") {
          if (ev.key === "c" || ev.key === "d") return finish(null)
          if (ev.key === "u") {
            buffer = buffer.slice(cursor)
            cursor = 0
            return redraw()
          }
          if (ev.key === "a") {
            cursor = 0
            return redraw()
          }
          if (ev.key === "e") {
            cursor = buffer.length
            return redraw()
          }
          return
        }
        if (ev.kind === "paste") {
          const clean = ev.text.replace(/[\r\n]+/g, "")
          buffer = buffer.slice(0, cursor) + clean + buffer.slice(cursor)
          cursor += clean.length
          return redraw()
        }
        if (ev.kind === "char") {
          buffer = buffer.slice(0, cursor) + ev.text + buffer.slice(cursor)
          cursor += ev.text.length
          return redraw()
        }
        if (ev.kind === "key") {
          if (ev.name === "escape") return finish(null)
          if (ev.name === "enter") return finish(buffer)
          if (ev.name === "backspace") {
            if (cursor > 0) {
              buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor)
              cursor -= 1
              redraw()
            }
            return
          }
          if (ev.name === "delete") {
            if (cursor < buffer.length) {
              buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1)
              redraw()
            }
            return
          }
          if (ev.name === "left" && cursor > 0) {
            cursor -= 1
            return redraw()
          }
          if (ev.name === "right" && cursor < buffer.length) {
            cursor += 1
            return redraw()
          }
          if (ev.name === "home") {
            cursor = 0
            return redraw()
          }
          if (ev.name === "end") {
            cursor = buffer.length
            return redraw()
          }
        }
      }
      cleanup = this.raw.beginCapture(onKey, redraw)
      redraw()
    })
  }

  async askChoice(prompt: string, options: readonly HybridChoiceOption[]): Promise<string | null> {
    return await askHybridChoice(this.raw, this.style, prompt, options)
  }

  async askConfirm(prompt: string, signal?: AbortSignal): Promise<string | null> {
    return await askHybridConfirm(this.raw, this.style, prompt, signal)
  }

  async askPermission(prompt: string, opts: HybridPermissionOptions): Promise<ApprovalDecision> {
    return await askHybridPermission(this.raw, this.style, prompt, opts)
  }

  close(): void {
    this.raw.dispose()
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
    "  bashwink                 Open Bashwink interactive TUI (prompts to configure model if unset)",
    "  bashwink --continue      Resume the most recent session in this workspace",
    "  bashwink --resume [id]   Open session browser or resume a specific session ID",
    "  bashwink setup           Configure or update provider, API key, model, and test connection",
    "  bashwink connect         Alias for setup (Hermes/OpenCode provider wizard)",
    "  bashwink test            Run /models probe and sample test against the saved model",
    "  bashwink doctor          Check Node, saved profile, credential reference, trust, and evidence",
    "  bashwink trust [dir] --by <name>",
    "                           Grant interactive write/command trust to a workspace",
    "  bashwink evidence verify Verify the hash-chained evidence.jsonl log",
    "  bashwink evidence export [--run <id>] [--out <file>] [--format json|md]",
    "  bashwink evidence purge --ttl-days <n>",
    "  bashwink contract new|show|approve|reject|edit|revise|status",
    "  bashwink proof show [runId] | proof verify [file|runId]",
    "  bashwink --require-contract --max-requests <n> --max-tokens <n> --max-cost-usd <amt> --max-time-ms <ms>",
    "  bashwink --version       Print version",
    "  bashwink --help          Print this help",
    "",
    "INTERACTIVE COMMANDS",
    "  /sessions, /resume       Browse, search, preview, rename, fork, or switch sessions (Ctrl+O)",
    "  /timeline, /rewind       Navigate turns, rewind chat/files, or fork from a turn (Esc Esc)",
    "  /transcript              Open scrollable full transcript & turn navigator (Ctrl+T)",
    "  /new, /clear, /fork      Create, reset, or branch the active session",
    "  /rename [title]          Rename the active session",
    "  /model, /connect         Choose provider, enter API key / env var, select or fetch models, and test",
    "  /test, /status           Test saved model connection or view session & budget status",
    "  /diff, /compact          Inspect edits or compact conversation context",
    "  /mode, /trust, /evidence Switch mode (accept-edits/smart/auto/manual/ask) or verify log",
    "  /contract, /proof [id]   Inspect active IntentLock contract or ProofPack verification",
    "  /help, /exit             Show help or quit",
    "",
    "KEYBOARD SHORTCUTS",
    "  Shift+Tab                Cycle permission mode (accept-edits -> smart -> auto -> manual -> ask)",
    "  Ctrl+P                   Command palette (fuzzy search all commands)",
    "  Ctrl+O                   Session browser & switcher",
    "  Esc Esc                  Timeline & checkpoint rewind",
    "  Ctrl+T / PgUp            Scrollable full transcript & turn navigator",
    "  Ctrl+R                   Reverse search prompt history",
    "  Up / Down                Cycle prompt history (or navigate menus)",
    "  / and @                  Inline slash command & workspace file autocomplete",
    "  Ctrl+J / Shift+Enter     Insert newline in prompt composer",
    "  Ctrl+L                   Redraw & clear screen",
    "  Ctrl+C                   Cancel running task or clear prompt",
    "  Ctrl+D                   Exit when input is empty",
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

async function askYesNo(
  io: TerminalIO,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (io instanceof RawTerminalIO) {
    return await io.askConfirm(prompt, signal)
  }
  return await io.ask(prompt, signal)
}

async function askPermissionDecision(
  io: TerminalIO,
  prompt: string,
  opts: HybridPermissionOptions,
): Promise<ApprovalDecision> {
  if (io instanceof RawTerminalIO) {
    return await io.askPermission(prompt, opts)
  }
  const suffixParts = ["Allow once (y)"]
  if (opts.allowAcceptEdits) suffixParts.push("Accept-edits mode (e)")
  if (opts.allowAlways) suffixParts.push("Always allow (a)")
  suffixParts.push("Reject (n)")
  const suffix = ` [${suffixParts.join(" / ")}] `
  const ans = await io.ask(`${prompt}${suffix}`, opts.signal)
  if (ans === null) return "reject"
  const clean = ans.trim().toLowerCase()
  if (clean === "y" || clean === "yes") return "once"
  if ((clean === "e" || clean === "accept-edits" || clean === "edits") && opts.allowAcceptEdits) {
    return "accept-edits"
  }
  if ((clean === "a" || clean === "always") && opts.allowAlways) return "always"
  return "reject"
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
  session?: SessionRecord,
): void {
  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
  const layout = getTerminalLayout(terminalCols(io), terminalRows(io))
  const modelLine = config
    ? `${config.providerId ? `${config.providerId} / ` : ""}${config.model} (${formatDestination(config.baseURL)})`
    : "none configured"
  const trustLine = trusted
    ? style.green(layout.isCompact ? "trusted" : "trusted (edits & commands confirm)")
    : style.yellow(layout.isCompact ? "read-only (/trust)" : "not trusted (read-only until /trust)")
  const branchTag = session?.gitBranch ? `, ${session.gitBranch}` : ""
  const sessionLine = session
    ? layout.isCompact
      ? `${session.title} (${session.turns.length}t${branchTag})`
      : `${session.title} (${session.id}, ${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}${branchTag})`
    : "new session"

  if (layout.isCompact || layout.isShort) {
    const bar = style.dim("─".repeat(Math.max(16, Math.min(layout.cols, 76))))
    const headerTitle = style.accentBold(`Bashwink ${STANDALONE_VERSION}`)
    io.write(`\n${headerTitle} ${style.muted(`(${layout.cols}×${layout.rows})`)}\n`)
    io.write(`${bar}\n`)
    const maxVal = Math.max(14, layout.cols - 10)
    io.write(`Project  ${truncatePathMiddle(sanitizeTerminalText(workspace), maxVal)}\n`)
    io.write(`Session  ${truncatePlain(sanitizeTerminalText(sessionLine), maxVal)}\n`)
    io.write(`Trust    ${truncatePlain(trustLine, maxVal)}\n`)
    io.write(`Model    ${truncatePlain(sanitizeTerminalText(modelLine), maxVal)}\n`)
    io.write(`${bar}\n`)
    io.write(
      `${style.muted(truncatePlain("Commands: /sessions /timeline /transcript /model /help /exit", layout.cols))}\n`,
    )
    return
  }

  const innerW = layout.contentWidth
  const topBorder = style.dim(`╭${"─".repeat(layout.boxWidth - 2)}╮`)
  const bottomBorder = style.dim(`╰${"─".repeat(layout.boxWidth - 2)}╯`)
  const boxRow = (styledContent: string) =>
    `${style.dim("│")} ${padPlainRight(styledContent, innerW)} ${style.dim("│")}\n`
  const valW = Math.max(18, innerW - 9)

  const titleLeft = `${style.accentBold(`Bashwink ${STANDALONE_VERSION}`)}  ${style.muted("(standalone TUI)")}`
  const titleStr = layout.isWide
    ? `${titleLeft}  ${style.dim(`[${layout.cols}×${layout.rows}]`)}`
    : titleLeft

  io.write(`\n${topBorder}\n`)
  io.write(boxRow(titleStr))
  io.write(boxRow(`Project  ${truncatePathMiddle(sanitizeTerminalText(workspace), valW)}`))
  io.write(boxRow(`Session  ${truncatePlain(sanitizeTerminalText(sessionLine), valW)}`))
  io.write(boxRow(`Trust    ${trustLine}`))
  io.write(boxRow(`Model    ${truncatePlain(sanitizeTerminalText(modelLine), valW)}`))
  io.write(`${bottomBorder}\n`)
  const cmdHint = layout.isWide
    ? "Commands: /sessions (Ctrl+O) · /timeline (Esc×2) · /transcript (Ctrl+T) · /model · /connect · /trust · /help · /exit"
    : "Commands: /sessions  /timeline  /transcript  /model  /connect  /trust  /help  /exit"
  io.write(`${style.muted(truncatePlain(cmdHint, layout.cols))}\n`)
}

function printConnectionTestResult(io: TerminalIO, res: TestConnectionResult, model: string): void {
  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
  if (res.ok) {
    const toolsVerified =
      res.toolSupport === undefined ||
      res.toolSupport === "untested" ||
      res.toolSupport === "supported"
    if (toolsVerified) {
      io.write(style.green(`  ✓ Connection verified in ${res.latencyMs} ms`) + "\n")
    } else {
      io.write(
        style.yellow(
          `  ⚠ Chat reachable in ${res.latencyMs} ms, but tool calling is ${res.toolSupport}`,
        ) + "\n",
      )
    }
    io.write(`    Sample reply: ${sanitizeTerminalText(res.replySnippet ?? "OK")}\n`)
    if (res.toolSupport && res.toolSupport !== "untested") {
      io.write(`    Tool support: ${res.toolSupport}\n`)
    }
    if (res.discoveredModelsCount !== undefined) {
      const listed = res.modelListedInCatalog
        ? "model listed"
        : `model '${model}' not returned by /models`
      io.write(`    Catalog:      ${res.discoveredModelsCount} model(s) visible (${listed})\n`)
    }
    if (res.usage?.totalTokens !== undefined) {
      io.write(`    Usage:        ${res.usage.totalTokens} tokens\n`)
    }
    return
  }
  io.writeError(
    style.red(`  ✗ Sample test failed (${res.latencyMs} ms): ${res.error ?? "unknown error"}`) +
      "\n",
  )
  if (res.discoveredModelsCount !== undefined) {
    const listed = res.modelListedInCatalog
      ? `'${model}' was listed in /models`
      : `'${model}' was not in ${res.discoveredModelsCount} discovered model(s) — check model ID`
    io.writeError(`    Catalog hint: ${listed}\n`)
  }
}

export async function runInteractiveSetup(
  io: TerminalIO,
  configDirectory: string,
  env: NodeJS.ProcessEnv,
  existing?: StandaloneConfig,
  opts: { readonly fetchImpl?: typeof fetch } = {},
): Promise<
  { readonly status: "saved"; readonly config: StandaloneConfig } | { readonly status: "cancelled" }
> {
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
      io.write(
        `Found ${legacy.length} legacy provider entry(ies) in opencode.json (not loaded automatically):\n`,
      )
      for (const item of legacy) {
        io.write(
          `  - ${sanitizeTerminalText(item.id)}: ${sanitizeTerminalText(item.model)} at ${sanitizeTerminalText(item.baseURL)}\n`,
        )
      }
      const importAns = await askYesNo(io, "Import one of these references? [y/N] ")
      if (importAns === null) return { status: "cancelled" }
      if (isYes(importAns)) {
        const chosen = legacy[0]!
        const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\b/i.test(
          chosen.baseURL,
        )
        const endpointType: "local" | "hosted" = isLoopback ? "local" : "hosted"
        try {
          const normalizedURL = normalizeBaseURL(chosen.baseURL, endpointType)
          const model = validateModelID(chosen.model)
          io.write(`  Endpoint    ${normalizedURL}\n`)
          io.write(`  Model       ${model}\n`)
          io.write(`  Credentials ${parseCredentialChoice(chosen.credential)}\n`)
          const confirm = await askYesNo(io, "Save and use this imported connection? [y/N] ")
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
          io.writeError(
            `  Could not import legacy entry: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    }
  }

  let preset: ProviderPreset | undefined
  while (preset === undefined) {
    let choice: string | null
    const rangeHint = `1-${PROVIDER_CATALOG.length}`
    if (io instanceof RawTerminalIO) {
      io.write("\nProviders (Hosted HTTPS & Local loopback):\n")
      const opts: HybridChoiceOption[] = PROVIDER_CATALOG.map((p) => ({
        value: String(p.index),
        display: `${String(p.index).padStart(2, " ")}) ${p.name.padEnd(25, " ")} ${p.endpointType === "hosted" ? "HTTPS" : "local"}  ${p.defaultBaseURL ?? p.note}`,
      }))
      choice = await io.askChoice(`Select provider [${rangeHint} or id] (or 'cancel'): `, opts)
    } else {
      io.write("\nHosted providers (HTTPS):\n")
      for (const p of PROVIDER_CATALOG.filter((c) => c.endpointType === "hosted")) {
        const tag = p.defaultBaseURL ?? p.note
        io.write(`  ${String(p.index).padStart(2, " ")}) ${p.name.padEnd(25, " ")} ${tag}\n`)
      }
      io.write("\nLocal servers (loopback HTTP/HTTPS):\n")
      for (const p of PROVIDER_CATALOG.filter((c) => c.endpointType === "local")) {
        const tag = p.defaultBaseURL ?? p.note
        io.write(`  ${String(p.index).padStart(2, " ")}) ${p.name.padEnd(25, " ")} ${tag}\n`)
      }
      choice = await io.ask(`Select provider [${rangeHint} or id] (or 'cancel'): `)
    }
    if (choice === null) return { status: "cancelled" }
    const t = choice.trim().toLowerCase()
    if (t === "cancel" || t === "q" || t === "quit") return { status: "cancelled" }
    const matched = findProviderPreset(t)
    if (matched) {
      preset = matched
    } else {
      io.write(
        `  Please enter a number ${rangeHint}, a provider id/alias (e.g. openai, anthropic, nvidia, ollama), or 'cancel'.\n`,
      )
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

  // Hermes-style order: Provider -> Endpoint URL -> API Key / Auth -> Model (curated or /models fetch) -> Sample Test & Save
  let credential: CredentialConfig | undefined
  let pendingSecret: string | undefined
  const endpointHostChanged =
    existing !== undefined && formatDestination(existing.baseURL) !== formatDestination(baseURL)
  if (endpointHostChanged && existing && existing.credential.kind !== "none") {
    io.write(
      `\n  Destination host changed (${formatDestination(existing.baseURL)} -> ${formatDestination(baseURL)}); existing credentials will not be reused automatically.\n`,
    )
  }
  const canKeepExisting =
    existing !== undefined &&
    (!existing.providerId || existing.providerId === preset.id) &&
    !endpointHostChanged
  const existingCredCheck = canKeepExisting
    ? resolveCredentialSecret(existing.credential, env)
    : undefined

  while (credential === undefined) {
    let mode: string | null
    const envHint = preset.defaultEnvVar
      ? preset.alternateEnvVars && preset.alternateEnvVars.length > 0
        ? ` (e.g. ${preset.defaultEnvVar}; alt: ${preset.alternateEnvVars.join(", ")})`
        : ` (e.g. ${preset.defaultEnvVar})`
      : ""
    const envLabel = `1) Environment variable name${envHint}`
    const pasteLabel = `4) Enter / paste API key (saved 0600 locally)`
    if (canKeepExisting && existingCredCheck) {
      io.write(`\nCurrent credentials: ${existingCredCheck.summary}\n`)
    }
    if (io instanceof RawTerminalIO) {
      io.write("\nAuthentication:\n")
      const authOpts: HybridChoiceOption[] = [
        ...(canKeepExisting ? [{ value: "k", display: "k) Keep existing credentials" }] : []),
        { value: "1", display: envLabel },
        { value: "2", display: "2) Key file path" },
        { value: "3", display: "3) None (no key needed)" },
        { value: "4", display: pasteLabel },
      ]
      mode = await io.askChoice("Choose [1/2/3/4] (or 'cancel'): ", authOpts)
    } else {
      io.write("\nAuthentication:\n")
      if (canKeepExisting) io.write("  k) Keep existing credentials\n")
      io.write(`  ${envLabel}\n`)
      io.write("  2) Key file path\n")
      io.write("  3) None (no key needed)\n")
      io.write(`  ${pasteLabel}\n`)
      mode = await io.ask("Choose [1/2/3/4] (or 'cancel'): ")
    }
    if (mode === null) return { status: "cancelled" }
    const m = mode.trim().toLowerCase()
    if (m === "cancel") return { status: "cancelled" }
    if ((m === "k" || m === "keep" || m === "") && canKeepExisting && existing) {
      credential = existing.credential
    } else if (m === "1" || m === "env") {
      const envPrompt = preset.defaultEnvVar
        ? `Environment variable name [Enter for ${preset.defaultEnvVar}]: `
        : "Environment variable name (e.g. MY_API_KEY): "
      const varName = await io.ask(envPrompt)
      if (varName === null) return { status: "cancelled" }
      const effectiveVar =
        varName.trim() === "" && preset.defaultEnvVar ? preset.defaultEnvVar : varName
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
    } else if (m === "4" || m === "key" || m === "paste") {
      const promptFn = io.askSecret ? io.askSecret.bind(io) : io.ask.bind(io)
      const entered = await promptFn(`Paste ${preset.name} API key (masked; Enter to go back): `)
      if (entered === null) return { status: "cancelled" }
      const secretTrimmed = entered.trim()
      if (secretTrimmed === "" || /[\r\n\0]/.test(secretTrimmed)) {
        io.writeError("  API key cannot be empty or multi-line.\n")
        continue
      }
      pendingSecret = secretTrimmed
      const slug = preset.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_")
      credential = {
        kind: "file",
        path: path.resolve(path.join(configDirectory, "keys", `${slug}.key`)),
      }
    } else {
      io.write("  Please enter 1, 2, 3, or 4.\n")
    }
  }

  let availableModels: string[] = [...preset.defaultModels]
  let model: string | undefined
  while (model === undefined) {
    let rawModel: string | null
    if (io instanceof RawTerminalIO && (availableModels.length > 0 || baseURL)) {
      io.write(`\n${preset.name} models (type id, number, or 'f' to fetch /models):\n`)
      const modelOpts: HybridChoiceOption[] = [
        ...availableModels.map((m, idx) => ({ value: m, display: `${idx + 1}) ${m}` })),
        { value: "f", display: `f) Fetch live models from ${baseURL}/models` },
      ]
      rawModel = await io.askChoice(
        availableModels.length > 0
          ? `Model ID, number, or 'f' [Enter for ${availableModels[0]}]: `
          : "Model ID or 'f' to fetch /models: ",
        modelOpts,
      )
    } else {
      if (availableModels.length > 0) {
        io.write(`\nSuggested ${preset.name} models:\n`)
        availableModels.forEach((m, idx) => {
          io.write(`  ${idx + 1}) ${m}\n`)
        })
      }
      io.write(`  f) Fetch live models from ${baseURL}/models\n`)
      const modelPrompt =
        availableModels.length > 0
          ? `Model ID, number, or 'f' [Enter for ${availableModels[0]}]: `
          : "Model ID (for example gpt-4o-mini or qwen-coder, or 'f' to fetch): "
      rawModel = await io.ask(modelPrompt)
    }
    if (rawModel === null) return { status: "cancelled" }
    const trimmed = rawModel.trim()
    if (trimmed.toLowerCase() === "cancel") return { status: "cancelled" }
    if (trimmed.toLowerCase() === "f" || trimmed.toLowerCase() === "fetch") {
      io.write(`  Probing ${baseURL} /models (Ctrl+C to cancel)...\n`)
      const probeAbort = new AbortController()
      const onSig = () => probeAbort.abort()
      process.once("SIGINT", onSig)
      let probe
      try {
        probe = await probeModels({
          baseURL,
          credential,
          ...(preset.wireProtocol ? { wireProtocol: preset.wireProtocol } : {}),
          ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
          env,
          ...(pendingSecret !== undefined ? { apiKeyOverride: pendingSecret } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          signal: probeAbort.signal,
        })
      } finally {
        process.removeListener("SIGINT", onSig)
      }
      if (probe.ok && probe.models.length > 0) {
        if (probe.usedFallback && probe.resolvedBaseURL) {
          io.write(
            `  Note: /models responded at ${probe.resolvedBaseURL}; updating endpoint URL.\n`,
          )
          baseURL = normalizeBaseURL(probe.resolvedBaseURL, endpointType)
        }
        const merged = [...probe.models]
        for (const curated of preset.defaultModels) {
          if (!merged.includes(curated)) merged.push(curated)
        }
        availableModels = merged
        io.write(`  ✓ Found ${probe.models.length} live model(s) from ${probe.probedURL}.\n`)
      } else {
        io.writeError(
          `  ! Could not fetch /models (${probe.error ?? "no models listed"}). Enter a model ID directly.\n`,
        )
      }
      continue
    }

    let candidate = trimmed
    if (candidate === "" && availableModels.length > 0) {
      candidate = availableModels[0]!
    } else if (/^\d+$/.test(candidate) && availableModels.length > 0) {
      const idx = Number(candidate) - 1
      if (idx >= 0 && idx < availableModels.length) {
        candidate = availableModels[idx]!
      }
    }
    try {
      model = validateModelID(candidate)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  const credCheck =
    pendingSecret !== undefined
      ? {
          ok: true,
          summary: `paste -> ${credential.kind === "file" ? credential.path : ""} (${pendingSecret.length} chars, saved 0600 on save)`,
          warning: undefined,
        }
      : resolveCredentialSecret(credential, env)

  const draftConfig: StandaloneConfig = {
    version: 1,
    providerId: preset.id,
    endpointType,
    ...(preset.wireProtocol && preset.wireProtocol !== "openai-chat"
      ? { wireProtocol: preset.wireProtocol }
      : {}),
    baseURL,
    model,
    credential,
    ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
    updatedAt: new Date().toISOString(),
  }

  let connectionStatus: StandaloneConfig["connectionStatus"] = "unverified"
  let lastVerifiedAt: string | undefined

  while (true) {
    io.write("\nReview connection (0 requests sent until you test or submit):\n")
    io.write(`  Provider    ${preset.name} (${preset.id})\n`)
    io.write(`  Type        ${endpointType}\n`)
    if (preset.wireProtocol && preset.wireProtocol !== "openai-chat") {
      io.write(`  Protocol    ${preset.wireProtocol}\n`)
    }
    io.write(`  Endpoint    ${baseURL}\n`)
    io.write(`  Model       ${model}\n`)
    io.write(`  Credentials ${credCheck.summary}\n`)
    io.write(`  Status      ${connectionStatus}\n`)
    if (credCheck.warning) {
      io.write(`  Warning     ${credCheck.warning}\n`)
    }
    const confirm = await askYesNo(
      io,
      "Save and use this model? [y/N] (or 't' to run sample test): ",
    )
    if (confirm === null) {
      io.write("Setup cancelled; profile unchanged.\n")
      return { status: "cancelled" }
    }
    const ans = confirm.trim().toLowerCase()
    if (ans === "t" || ans === "test") {
      io.write(`  Running sample test against ${baseURL} (${model})...\n`)
      const testAbort = new AbortController()
      const onSig = () => testAbort.abort()
      process.once("SIGINT", onSig)
      let testRes
      try {
        testRes = await testProviderConnection({
          config: draftConfig,
          env,
          ...(pendingSecret !== undefined ? { apiKeyOverride: pendingSecret } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          signal: testAbort.signal,
          onProgress: (stage) => {
            if (stage === "tool_probe") {
              io.write("  Verifying tool-call capability...\n")
            } else {
              io.write(`  ${stage}\n`)
            }
          },
        })
      } finally {
        process.removeListener("SIGINT", onSig)
      }
      if (testRes.ok && testRes.toolSupport === "supported") {
        connectionStatus = "verified"
        lastVerifiedAt = new Date().toISOString()
      } else if (testRes.ok) {
        connectionStatus = "unverified"
        lastVerifiedAt = undefined
        io.write(
          "  Note: Chat probe succeeded, but tool-call capability is unverified/unsupported; marking config unverified for agent execution.\n",
        )
      } else {
        connectionStatus = "failed"
        lastVerifiedAt = undefined
      }
      printConnectionTestResult(io, testRes, model)
      continue
    }
    if (!isYes(confirm)) {
      io.write("Setup cancelled; profile unchanged.\n")
      return { status: "cancelled" }
    }
    break
  }

  let finalCredential = credential
  if (pendingSecret !== undefined) {
    const savedKeyPath = saveProviderKeyFile(configDirectory, preset.id, pendingSecret)
    finalCredential = { kind: "file", path: savedKeyPath }
  }
  const config: StandaloneConfig = {
    ...draftConfig,
    credential: finalCredential,
    connectionStatus,
    ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
    updatedAt: new Date().toISOString(),
  }
  saveStandaloneConfig(configDirectory, config)
  io.write(
    `Saved model configuration to ${standaloneConfigFile(configDirectory)} (status: ${connectionStatus}).\n`,
  )
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
    io.write(
      `✓ Profile: ${cfgState.config.model} at ${cfgState.config.baseURL} (${standaloneConfigFile(resolved.config)})\n`,
    )
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
    io.write(
      `    fix: run \`bashwink\` interactively or \`bashwink trust "${canonical}" --by "<you>"\`\n`,
    )
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
  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
  const cols = terminalCols(io)
  if (result.finalText.trim() !== "") {
    const cleanMd = sanitizeTerminalText(result.finalText.trim())
    const rendered = renderOpenCodeMarkdown(cleanMd, cols, style)
    io.write(`\n${rendered.join("\n")}\n`)
  }
  const ruleW = Math.min(Math.max(20, cols - 4), 72)
  io.write(`\n  ${style.dim("─".repeat(ruleW))}\n`)
  const outcomeLine = `  Outcome   ${result.outcome}${result.stopReason ? ` — ${sanitizeTerminalText(result.stopReason)}` : ""}`
  const outcomeColored =
    result.outcome === "completed"
      ? style.green(outcomeLine)
      : result.outcome === "cancelled"
        ? style.yellow(outcomeLine)
        : style.red(outcomeLine)
  io.write(`${outcomeColored}\n`)
  if (result.claimStatus !== undefined) {
    const claimLine = `  Claim     ${result.claimStatus}`
    const claimColored =
      result.claimStatus === "verified"
        ? style.green(claimLine)
        : result.claimStatus === "done_unverified" || result.claimStatus === "cancelled"
          ? style.yellow(claimLine)
          : style.red(claimLine)
    io.write(`${claimColored}\n`)
    const reasons = result.proofPack?.unverifiedReasons ?? []
    for (const reason of reasons.slice(0, 3)) {
      io.write(`  ${style.yellow(`Note      ${sanitizeTerminalText(reason)}`)}\n`)
    }
  }
  if (result.diffPreviews && result.diffPreviews.length > 0) {
    const fileSummaries = result.diffPreviews.map((d) => {
      const c = countDiffChanges(d.patch)
      return `${d.path} (${style.green(`+${c.additions}`)} ${style.red(`-${c.deletions}`)})`
    })
    io.write(`  Changed   ${fileSummaries.join(", ")}\n`)
  } else {
    io.write(
      `  Changed   ${result.changedFiles.length > 0 ? result.changedFiles.join(", ") : "none"}\n`,
    )
  }
  if (result.changedTests.length > 0) {
    io.write(
      `  ${style.yellow("Tests")}     modified test files: ${result.changedTests.join(", ")} (verify independently)\n`,
    )
  }
  if (result.commands.length === 0) {
    io.write(`  ${style.muted("Commands  none")}\n`)
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
      io.write(`  Command   ${truncatePlain(cmdStr, Math.max(24, cols - 28))} -> ${status}\n`)
    }
  }
  io.write(
    `  ${style.muted("Usage")}     ${result.requests} request(s), ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens` +
      (result.usage.costUsd !== undefined ? `, est. $${result.usage.costUsd.toFixed(6)}` : "") +
      "\n",
  )
  io.write(`  ${style.dim(`Evidence  ${result.evidenceFile}`)}\n`)
  io.write(`  ${style.dim(`Run       ${result.runRecordFile}`)}\n`)
}

function renderResumedSessionContext(io: TerminalIO, session: SessionRecord): void {
  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
  if (session.turns.length === 0) {
    io.write(style.muted(`\nResumed empty session: ${session.title} (${session.id})\n`))
    return
  }
  io.write(
    style.accentBold(
      `\nResumed session: ${sanitizeTerminalText(session.title)} (${session.turns.length} turn(s))\n`,
    ),
  )
  const recent = session.turns.slice(-3)
  if (session.turns.length > recent.length) {
    io.write(
      style.muted(
        `  … ${session.turns.length - recent.length} earlier turn(s) — press Ctrl+T for full transcript\n`,
      ),
    )
  }
  const maxMsgW = Math.max(18, terminalCols(io) - 10)
  for (const turn of recent) {
    io.write(
      `  ${style.bold("You:")} ${sanitizeTerminalText(truncatePlain(turn.userPrompt.replace(/\n/g, " "), maxMsgW))}\n`,
    )
    if (turn.assistantText.trim() !== "") {
      io.write(
        `  ${style.green("Asst:")} ${sanitizeTerminalText(truncatePlain(turn.assistantText.replace(/\n/g, " "), maxMsgW))}\n`,
      )
    }
  }
}

function buildStatusSummary(
  session: SessionRecord,
  trusted: boolean,
  config?: StandaloneConfig,
  layout?: TerminalLayout,
  permissionMode: PermissionMode = "accept-edits",
): string {
  const modelText = config ? config.model : "no model"
  const trustText = permissionMode === "ask" ? "ask (read-only)" : trusted ? "trusted" : "read-only"
  const modeText = permissionModeLabel(permissionMode, Boolean(layout?.isCompact))
  const costText =
    session.usageTotals.costUsd !== undefined ? ` · $${session.usageTotals.costUsd.toFixed(4)}` : ""
  if (layout?.isCompact) {
    return `${truncatePlain(session.title, 18)} (${session.turns.length}t) · ${modelText} · ${modeText}`
  }
  if (layout && !layout.isWide) {
    return `${truncatePlain(session.title, 28)} (${session.turns.length}t) · ${modelText} · ${modeText} · ${trustText}${costText} · shift+tab mode`
  }
  return `${session.title} (${session.turns.length}t) · ${modelText} · ${modeText} · ${trustText}${costText} · shift+tab mode · ctrl+p palette · ctrl+o sessions`
}

function buildComposerMetadata(
  trusted: boolean,
  config?: StandaloneConfig,
  permissionMode: PermissionMode = "accept-edits",
): PromptMetadataInput {
  return {
    agent: permissionMode === "ask" ? "ask" : "build",
    model: config ? config.model : "no model selected (/model)",
    ...(config?.providerId ? { provider: config.providerId } : {}),
    permissionMode,
    trustLabel: permissionMode === "ask" ? "read-only" : trusted ? "trusted" : "read-only",
    trusted: permissionMode === "ask" ? false : trusted,
  }
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tok`
  return `${tokens} tok`
}

function buildComposerStatusFooter(
  workspace: string,
  env: NodeJS.ProcessEnv,
  session: SessionRecord,
): Omit<StatusFooterInput, "statusMessage"> {
  const home = env["HOME"] || ""
  const shortDir =
    home !== "" && workspace.startsWith(home)
      ? `~${workspace.slice(home.length) || "/"}`
      : workspace
  const branchTag = session.gitBranch ? ` (${session.gitBranch})` : ""
  const location = `${shortDir}${branchTag}`
  const tokens = session.usageTotals.totalTokens
  const tokensText = tokens > 0 ? formatCompactTokens(tokens) : undefined
  const costText =
    session.usageTotals.costUsd !== undefined
      ? `$${session.usageTotals.costUsd.toFixed(4)}`
      : undefined
  return {
    location,
    turnsCount: session.turns.length,
    ...(tokensText ? { tokensText } : {}),
    ...(costText ? { costText } : {}),
    shortcuts: [
      { key: "shift+tab", label: "mode" },
      { key: "ctrl+p", label: "commands" },
      { key: "ctrl+o", label: "sessions" },
      { key: "esc×2", label: "rewind" },
    ],
  }
}

function buildPaletteItems(): PaletteCommandItem[] {
  return SLASH_COMMANDS.map((c) => ({
    id: c.name,
    title: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
    category: c.category,
    description: c.description,
    ...(c.shortcut === undefined ? {} : { shortcut: c.shortcut }),
  }))
}

function buildDiffModalLines(session: SessionRecord, style: TuiStyle, maxWidth = 90): string[] {
  const lines: string[] = []
  if (session.turns.length === 0) {
    lines.push(style.muted("  No turns or file changes recorded in this session yet."))
    return lines
  }
  for (let i = 0; i < session.turns.length; i += 1) {
    const t = session.turns[i]!
    if (t.changedFiles.length === 0 && t.commands.length === 0) continue
    lines.push(
      style.accentBold(
        `  Turn ${i + 1} · ${formatRelativeTime(t.createdAt)} · ${truncatePlain(t.userPrompt.replace(/\n/g, " "), Math.max(20, maxWidth - 28))}`,
      ),
    )
    if (t.diffPreviews && t.diffPreviews.length > 0) {
      for (const d of t.diffPreviews) {
        const rendered = renderOpenCodeDiff(
          sanitizeTerminalText(d.patch),
          { path: d.path, create: d.create, maxWidth: Math.max(36, maxWidth - 4) },
          style,
        )
        for (const rLine of rendered) lines.push(`  ${rLine}`)
      }
    } else {
      for (const f of t.changedFiles) {
        lines.push(style.green(`    [edited] ${f}`))
      }
    }
    for (const cmd of t.commands) {
      const cmdStr = [cmd.command, ...cmd.args].join(" ")
      const status = cmd.decision === "denied" ? "declined" : `exit ${cmd.exitCode ?? "null"}`
      lines.push(style.cyan(`    $ ${cmdStr} -> ${status}`))
    }
    lines.push("")
  }
  if (lines.length === 0) {
    lines.push(style.muted("  No file edits or commands were executed in this session."))
  }
  return lines
}

function buildHelpModalLines(configDir: string, dataDir: string, style: TuiStyle): string[] {
  return renderHelp(configDir, dataDir)
    .split("\n")
    .map((l) => (l === l.toUpperCase() && l.trim() !== "" ? style.accentBold(`  ${l}`) : `  ${l}`))
}

function parseCriterionSpec(
  raw: string,
  index: number,
): {
  readonly id: string
  readonly statement: string
  readonly command?: string
} {
  const parts = raw.split(":")
  if (parts.length === 1) {
    return { id: `c_${index + 1}`, statement: raw.trim() }
  }
  const id = parts[0]!.trim() || `c_${index + 1}`
  if (parts.length === 2) {
    return { id, statement: parts[1]!.trim() || id }
  }
  const statement = parts[1]!.trim() || id
  const command = parts.slice(2).join(":").trim()
  return { id, statement, ...(command ? { command } : {}) }
}

function handleContractCli(
  subArgs: readonly string[],
  cwd: string,
  dataDir: string,
  io: TerminalIO,
): number {
  const action = subArgs[0] ?? "show"
  const canonical = canonicalWorkspace(cwd)

  const readFlagList = (flag: string): string[] => {
    const values: string[] = []
    for (let i = 1; i < subArgs.length; i += 1) {
      const a = subArgs[i]!
      if (a === flag && subArgs[i + 1] !== undefined) {
        values.push(subArgs[i + 1]!)
        i += 1
      } else if (a.startsWith(`${flag}=`)) {
        values.push(a.slice(flag.length + 1))
      }
    }
    return values
  }
  const readFlagOne = (flag: string): string | undefined => readFlagList(flag).at(-1)
  const hasFlag = (flag: string): boolean => subArgs.includes(flag)

  if (action === "show" || action === "status") {
    let active
    try {
      active = loadActiveContract(dataDir, canonical)
    } catch (err) {
      io.writeError(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    if (!active) {
      io.writeError(`No active contract for ${canonical}.\n`)
      return 1
    }
    io.write(`${renderContractSummary(active)}\n`)
    return 0
  }

  if (action === "new") {
    const objective = readFlagOne("--objective")
    if (!objective || objective.trim() === "") {
      io.writeError("bashwink contract new requires --objective <text>.\n")
      return 2
    }
    const allowedPaths = readFlagList("--allow")
    const forbiddenPaths = readFlagList("--forbid")
    const negativeRequirements = readFlagList("--negative")
    const rawCriteria = readFlagList("--criterion")
    const criteria =
      rawCriteria.length > 0
        ? rawCriteria.map((raw, idx) => parseCriterionSpec(raw, idx))
        : [{ id: "checks.pass", statement: "Verify changes with test/check run" }]
    const maxFilesRaw = readFlagOne("--max-files")
    let maxFiles: number | undefined
    if (maxFilesRaw !== undefined) {
      if (!/^[0-9]+$/.test(maxFilesRaw)) {
        io.writeError(`Invalid --max-files value '${maxFilesRaw}'.\n`)
        return 2
      }
      maxFiles = Number(maxFilesRaw)
    }
    const allowedCommands = readFlagList("--allow-cmd")
    const forbiddenCommands = readFlagList("--forbid-cmd")
    const requireCleanBase = hasFlag("--clean-base")
    const constraints = {
      ...(maxFiles !== undefined ? { maxFiles } : {}),
      ...(hasFlag("--allow-cmd") ? { allowedCommands } : {}),
      ...(forbiddenCommands.length > 0 ? { forbiddenCommands } : {}),
      ...(requireCleanBase ? { requireCleanBase: true } : {}),
    }
    const created = createStandaloneContract(dataDir, canonical, {
      objective: objective.trim(),
      allowedPaths,
      forbiddenPaths,
      negativeRequirements,
      criteria,
      constraints,
    })
    io.write(`${renderContractSummary(created)}\n`)
    return 0
  }

  if (action === "approve") {
    const by = readFlagOne("--by")
    if (!by || by.trim() === "") {
      io.writeError("bashwink contract approve requires --by <name>.\n")
      return 2
    }
    const approved = approveActiveContract(dataDir, canonical, by.trim())
    io.write(`${renderContractSummary(approved)}\n`)
    return 0
  }

  if (action === "reject") {
    const rejected = rejectActiveContract(dataDir, canonical)
    io.write(`${renderContractSummary(rejected)}\n`)
    return 0
  }

  if (action === "edit" || action === "revise") {
    const reason = readFlagOne("--reason")
    if (!reason || reason.trim() === "") {
      io.writeError(`bashwink contract ${action} requires --reason <text>.\n`)
      return 2
    }
    const allow = readFlagList("--allow")
    const forbid = readFlagList("--forbid")
    const addCriteria = readFlagList("--add-criterion").map((raw, idx) =>
      parseCriterionSpec(raw, idx),
    )
    const dropCriteriaIds = readFlagList("--drop-criterion")
    const resolveAssumptionIds = readFlagList("--resolve-assumption")
    const resolveQuestionIds = readFlagList("--resolve-question")
    const objective = readFlagOne("--objective")
    const revised = reviseActiveContract(dataDir, canonical, {
      reason: reason.trim(),
      ...(objective !== undefined ? { objective: objective.trim() } : {}),
      ...(allow.length > 0 ? { allowedPaths: allow } : {}),
      ...(forbid.length > 0 ? { forbiddenPaths: forbid } : {}),
      ...(addCriteria.length > 0 ? { addCriteria } : {}),
      ...(dropCriteriaIds.length > 0 ? { dropCriteriaIds } : {}),
      ...(resolveAssumptionIds.length > 0 ? { resolveAssumptionIds } : {}),
      ...(resolveQuestionIds.length > 0 ? { resolveQuestionIds } : {}),
    })
    io.write(`${renderContractSummary(revised)}\n`)
    return 0
  }

  io.writeError(
    `Unknown contract subcommand '${action}'. Use: new, show, approve, reject, edit, revise, status.\n`,
  )
  return 2
}

function handleProofCli(
  subArgs: readonly string[],
  cwd: string,
  dataDir: string,
  io: TerminalIO,
): number {
  const action = subArgs[0] ?? "show"
  const target = subArgs[1]
  if (action === "show") {
    const run = loadRunRecord(dataDir, target)
    if (!run) {
      io.writeError(target ? `Run '${target}' not found.\n` : "No recorded runs found.\n")
      return 1
    }
    const syntheticResult: TaskResult = {
      runId: run.runId,
      outcome: run.outcome,
      ...(run.claimStatus !== undefined ? { claimStatus: run.claimStatus } : {}),
      finalText: "",
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      changedFiles: run.changedFiles,
      changedTests: run.changedTests,
      commands: run.commands,
      requests: run.requests,
      usage: run.usage,
      ...(run.proofPack ? { proofPack: run.proofPack } : {}),
      evidenceFile: run.evidenceFile,
      runRecordFile: path.join(dataDir, "runs", `${run.runId}.json`),
    }
    io.write(`${renderProofSummary(syntheticResult)}\n`)
    return 0
  }

  if (action === "verify") {
    let manifest: ProofPackManifest | undefined
    if (target && existsSync(path.resolve(cwd, target))) {
      try {
        const parsed = JSON.parse(readFileSync(path.resolve(cwd, target), "utf8")) as Record<
          string,
          unknown
        >
        if (parsed["proofPack"] && typeof parsed["proofPack"] === "object") {
          manifest = parsed["proofPack"] as ProofPackManifest
        } else {
          manifest = parsed as unknown as ProofPackManifest
        }
      } catch {
        io.writeError(`Could not parse ProofPack JSON file '${target}'.\n`)
        return 1
      }
    } else {
      const run = loadRunRecord(dataDir, target)
      manifest = run?.proofPack
    }
    if (!manifest) {
      io.writeError("No ProofPack manifest found to verify.\n")
      return 1
    }
    const check = verifyProofPack(manifest)
    if (!check.ok) {
      for (const issue of check.issues) io.writeError(`ProofPack verification failed: ${issue}\n`)
      return 1
    }
    io.write(
      `ProofPack OK: ${manifest.runId} (claim=${manifest.claimStatus}, checks=${manifest.checks.length}, evidence=${manifest.evidenceEntries}).\n`,
    )
    return 0
  }

  io.writeError(`Unknown proof subcommand '${action}'. Use: show, verify.\n`)
  return 2
}

interface ParsedCliRunOptions {
  readonly cliBudgets: Partial<TaskBudgets>
  readonly requireContract: boolean
  readonly positional: readonly string[]
}

function parsePositiveIntFlag(val: string, flag: string): number {
  if (!/^\d+$/.test(val.trim())) {
    throw new LimitConfigError(`${flag} must be a positive integer`)
  }
  const n = Number(val.trim())
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new LimitConfigError(`${flag} must be greater than 0`)
  }
  return n
}

function parseTopLevelRunOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ParsedCliRunOptions {
  const positional: string[] = []
  let maxRequests: number | undefined
  let maxTotalTokens: number | undefined
  let maxOutputTokens: number | undefined
  let maxInputTokens: number | undefined
  let maxCostUsd: number | undefined
  let maxTimeMs: number | undefined
  let requireContract = false

  const envMap: Record<string, string | undefined> = { ...env }

  const readVal = (idx: number, flag: string): { readonly val: string; readonly step: number } => {
    const arg = argv[idx]!
    if (arg.startsWith(`${flag}=`)) return { val: arg.slice(flag.length + 1), step: 0 }
    const next = argv[idx + 1]
    if (next === undefined) throw new LimitConfigError(`${flag} requires a value`)
    return { val: next, step: 1 }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === "--require-contract") {
      requireContract = true
      continue
    }
    if (a === "--max-requests" || a.startsWith("--max-requests=")) {
      const { val, step } = readVal(i, "--max-requests")
      i += step
      envMap["BASHWINK_MAX_REQUESTS"] = val
      const parsed = parseLimits(envMap)
      maxRequests = parsed.requests ?? 1_000_000
      continue
    }
    if (a === "--max-tokens" || a.startsWith("--max-tokens=")) {
      const { val, step } = readVal(i, "--max-tokens")
      i += step
      envMap["BASHWINK_MAX_TOKENS"] = val
      maxTotalTokens = parseLimits(envMap).tokens
      continue
    }
    if (a === "--max-total-tokens" || a.startsWith("--max-total-tokens=")) {
      const { val, step } = readVal(i, "--max-total-tokens")
      i += step
      maxTotalTokens = parsePositiveIntFlag(val, "--max-total-tokens")
      continue
    }
    if (a === "--max-output-tokens" || a.startsWith("--max-output-tokens=")) {
      const { val, step } = readVal(i, "--max-output-tokens")
      i += step
      maxOutputTokens = parsePositiveIntFlag(val, "--max-output-tokens")
      continue
    }
    if (a === "--max-input-tokens" || a.startsWith("--max-input-tokens=")) {
      const { val, step } = readVal(i, "--max-input-tokens")
      i += step
      maxInputTokens = parsePositiveIntFlag(val, "--max-input-tokens")
      continue
    }
    if (a === "--max-cost-usd" || a.startsWith("--max-cost-usd=")) {
      const { val, step } = readVal(i, "--max-cost-usd")
      i += step
      envMap["BASHWINK_MAX_COST_USD"] = val
      maxCostUsd = parseLimits(envMap).costUsd
      continue
    }
    if (a === "--max-time-ms" || a.startsWith("--max-time-ms=")) {
      const { val, step } = readVal(i, "--max-time-ms")
      i += step
      envMap["BASHWINK_MAX_TIME_MS"] = val
      maxTimeMs = parseLimits(envMap).timeMs
      continue
    }
    positional.push(a)
  }

  const envLimits = parseLimits(envMap)
  const envOutTok = env["BASHWINK_MAX_OUTPUT_TOKENS"]
    ? parsePositiveIntFlag(env["BASHWINK_MAX_OUTPUT_TOKENS"], "BASHWINK_MAX_OUTPUT_TOKENS")
    : undefined
  const envInTok = env["BASHWINK_MAX_INPUT_TOKENS"]
    ? parsePositiveIntFlag(env["BASHWINK_MAX_INPUT_TOKENS"], "BASHWINK_MAX_INPUT_TOKENS")
    : undefined
  const envTotalTok = env["BASHWINK_MAX_TOTAL_TOKENS"]
    ? parsePositiveIntFlag(env["BASHWINK_MAX_TOTAL_TOKENS"], "BASHWINK_MAX_TOTAL_TOKENS")
    : env["BASHWINK_MAX_TOKENS"] && envLimits.tokens !== undefined
      ? envLimits.tokens
      : undefined
  const cliBudgets: Partial<TaskBudgets> = {
    ...(maxRequests !== undefined
      ? { maxRequests }
      : env["BASHWINK_MAX_REQUESTS"] && envLimits.requests !== undefined
        ? { maxRequests: envLimits.requests }
        : {}),
    ...(maxTotalTokens !== undefined
      ? { maxTotalTokens }
      : envTotalTok !== undefined
        ? { maxTotalTokens: envTotalTok }
        : {}),
    ...(maxOutputTokens !== undefined
      ? { maxOutputTokens }
      : envOutTok !== undefined
        ? { maxOutputTokens: envOutTok }
        : {}),
    ...(maxInputTokens !== undefined
      ? { maxInputTokens }
      : envInTok !== undefined
        ? { maxInputTokens: envInTok }
        : {}),
    ...(maxCostUsd !== undefined
      ? { maxCostUsd }
      : env["BASHWINK_MAX_COST_USD"] && envLimits.costUsd !== undefined
        ? { maxCostUsd: envLimits.costUsd }
        : {}),
    ...(maxTimeMs !== undefined
      ? { maxElapsedMs: maxTimeMs }
      : env["BASHWINK_MAX_TIME_MS"] && envLimits.timeMs !== undefined
        ? { maxElapsedMs: envLimits.timeMs }
        : {}),
  }

  return { cliBudgets, requireContract, positional }
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
  const autoTTY = !options.io && Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const io: TerminalIO = options.io ?? (autoTTY ? new RawTerminalIO(env) : new NodeTerminalIO())
  const resolved = resolveStandalonePaths(env)

  try {
    const firstRaw = argv[0]
    if (firstRaw === "--version" || firstRaw === "-v") {
      io.write(renderVersion())
      return 0
    }
    if (firstRaw === "--help" || firstRaw === "-h") {
      io.write(renderHelp(resolved.config, resolved.data))
      return 0
    }
    if (argv.includes("--sandbox")) {
      io.writeError(
        "bashwink: --sandbox (isolated VM) is not included in the standalone alpha package; refusing rather than running unsandboxed.\n",
      )
      return 3
    }
    if (firstRaw === "doctor") {
      return runDoctor(cwd, env, io)
    }
    if (firstRaw === "trust") {
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
    if (firstRaw === "contract") {
      ensurePaths(resolved)
      return handleContractCli(argv.slice(1), cwd, resolved.data, io)
    }
    if (firstRaw === "proof") {
      ensurePaths(resolved)
      return handleProofCli(argv.slice(1), cwd, resolved.data, io)
    }
    if (firstRaw === "evidence") {
      const sub = argv[1]
      if (sub === "verify") {
        const file = argv[2]
          ? path.resolve(cwd, argv[2])
          : path.join(resolved.evidence, "evidence.jsonl")
        const res = verifyEvidenceFile(file)
        if (res.ok) {
          io.write(`Evidence OK: ${res.entries} entries (head ${res.head}).\n`)
          return 0
        }
        io.writeError(`Evidence verification failed: ${res.reason}\n`)
        return 1
      }
      if (sub === "export") {
        let runIdArg: string | undefined
        let outFile: string | undefined
        let format: "json" | "md" = "json"
        for (let i = 2; i < argv.length; i += 1) {
          const a = argv[i]!
          if (a === "--run" && argv[i + 1]) {
            runIdArg = argv[++i]
          } else if (a === "--out" && argv[i + 1]) {
            outFile = path.resolve(cwd, argv[++i]!)
          } else if (a === "--format" && argv[i + 1]) {
            const f = argv[++i]!
            if (f !== "json" && f !== "md") {
              io.writeError(`Invalid --format '${f}'. Use 'json' or 'md'.\n`)
              return 2
            }
            format = f
          }
        }
        const run = loadRunRecord(resolved.data, runIdArg)
        if (!run) {
          io.writeError(
            runIdArg ? `Run '${runIdArg}' not found.\n` : "No recorded runs found to export.\n",
          )
          return 1
        }
        const rendered = exportProofBundle(run, { format })
        if (outFile) {
          mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 })
          writeFileSync(outFile, rendered, { mode: 0o600, encoding: "utf8" })
          io.write(`Exported proof/evidence bundle for ${run.runId} to ${outFile}.\n`)
        } else {
          io.write(rendered)
        }
        return 0
      }
      if (sub === "purge") {
        let ttlRaw: string | undefined
        for (let i = 2; i < argv.length; i += 1) {
          const a = argv[i]!
          if (a === "--ttl-days" && argv[i + 1]) ttlRaw = argv[++i]
          else if (a.startsWith("--ttl-days=")) ttlRaw = a.slice("--ttl-days=".length)
        }
        if (ttlRaw === undefined || !/^[0-9]+(?:\.[0-9]+)?$/.test(ttlRaw)) {
          io.writeError("bashwink evidence purge requires --ttl-days <non-negative number>.\n")
          return 2
        }
        const purged = purgeExpiredArtifacts(resolved.data, Number(ttlRaw))
        io.write(
          `Purged ${purged.deletedRuns} expired run record(s) and ${purged.deletedSessions} expired session(s); evidence.jsonl and contracts preserved.\n`,
        )
        return 0
      }
      io.writeError(`Unknown evidence subcommand '${sub ?? ""}'. Use: verify, export, purge.\n`)
      return 2
    }

    let parsedRunOpts: ParsedCliRunOptions
    try {
      parsedRunOpts = parseTopLevelRunOptions(argv, env)
    } catch (err) {
      if (err instanceof LimitConfigError) {
        io.writeError(`bashwink: ${err.message}\n`)
        return 2
      }
      throw err
    }

    const first = parsedRunOpts.positional[0]
    const secondPositional = parsedRunOpts.positional[1]

    if (
      first === "setup" ||
      first === "connect" ||
      (first === "model" && parsedRunOpts.positional.length === 1)
    ) {
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
    if (first === "test") {
      const cfgState = loadStandaloneConfig(resolved.config)
      if (cfgState.status !== "ok") {
        io.writeError("No saved Bashwink profile found. Run `bashwink setup` first.\n")
        return 1
      }
      io.write(`Testing ${cfgState.config.model} at ${cfgState.config.baseURL}...\n`)
      const res = await testProviderConnection({ config: cfgState.config, env })
      printConnectionTestResult(io, res, cfgState.config.model)
      return res.ok ? 0 : 1
    }

    const resumeFlag = first === "--resume" || first === "-r"
    const continueFlag = first === "--continue" || first === "-c"
    if (first !== undefined && !resumeFlag && !continueFlag) {
      io.writeError(
        `bashwink: '${first}' is not part of the standalone alpha CLI (run 'bashwink --help'). No external runtime was invoked.\n`,
      )
      return 2
    }

    // Bare `bashwink` (or `--continue`/`--resume`): open interactive CLI workspace
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
    if (activeConfig && activeConfig.connectionStatus !== "verified") {
      // #100: chat-only reachability is not tool-call capability. Warn before the first
      // agent task instead of letting a text-only provider look "configured" and then fail.
      io.write(
        `Warning: provider '${activeConfig.model}' has tool-calling status '${activeConfig.connectionStatus ?? "unverified"}'. ` +
          "Agent tasks need tool calls; run `bashwink setup` and test the connection to verify support.\n",
      )
    }

    const canonical = canonicalWorkspace(cwd)
    ensurePaths(resolved)
    const gitBranch = detectGitBranch(canonical)
    const initialPerms = loadWorkspacePermissions(resolved.config, canonical)
    let permissionMode: PermissionMode = initialPerms.mode
    let savedRules: readonly SavedPermissionRule[] = initialPerms.rules

    const confirmCrossWorkspaceSession = async (
      candidate: SessionRecord,
    ): Promise<SessionRecord | undefined> => {
      if (path.resolve(candidate.workspace) === path.resolve(canonical)) return candidate
      if (!io.isTTY) {
        io.writeError(
          `Refusing to resume session '${candidate.id}' from another workspace (${candidate.workspace}) in non-interactive mode.\n`,
        )
        return undefined
      }
      const allow = await askYesNo(
        io,
        `Session '${candidate.id}' belongs to ${candidate.workspace}. Resume its history into ${canonical}? [y/N] `,
      )
      return isYes(allow) ? candidate : undefined
    }

    let activeSession: SessionRecord = createSession(canonical, gitBranch)
    if (continueFlag) {
      const existing = listSessions(resolved.data, { workspace: canonical })[0]
      if (existing) activeSession = existing
    } else if (resumeFlag && secondPositional) {
      const targetId = secondPositional
      const direct = loadSession(resolved.data, targetId)
      const matched = direct ?? listSessions(resolved.data).find((s) => s.id.startsWith(targetId))
      if (matched) {
        const accepted = await confirmCrossWorkspaceSession(matched)
        if (accepted) activeSession = accepted
      } else {
        io.writeError(`Session '${targetId}' not found; starting a new session.\n`)
      }
    }

    let promptHistory = loadPromptHistory(resolved.data)
    let draftBuffer = ""

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
      // Raw components redraw on resize through RawTerminalSession; fallback mode flows naturally.
    }
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigint)
    process.stdout.on("resize", onResize)

    try {
      renderCliHeader(
        io,
        canonical,
        isWorkspaceTrusted(resolved.config, canonical),
        activeConfig,
        activeSession,
      )
      if (!activeConfig) {
        io.write("\nWelcome to Bashwink! Configure a model to get started\n")
        io.write("  (0 outbound requests sent; ambient env keys are ignored).\n")
        io.write("Type /model or /connect (or press Enter) to select a provider and model.\n")
      }
      if (activeSession.turns.length > 0) {
        renderResumedSessionContext(io, activeSession)
      }

      if (resumeFlag && !argv[1] && io instanceof RawTerminalIO) {
        const all = listSessions(resolved.data, { includeArchived: false })
        if (all.length > 0) {
          const picked = await openSessionBrowser(io.raw, io.style, {
            sessions: all,
            activeSessionId: activeSession.id,
            currentWorkspace: canonical,
          })
          if (picked.action === "select") {
            const loaded = loadSession(resolved.data, picked.sessionId)
            const accepted = loaded ? await confirmCrossWorkspaceSession(loaded) : undefined
            if (accepted) {
              activeSession = accepted
              renderResumedSessionContext(io, activeSession)
            }
          }
        }
      }

      const handleSessionBrowser = async () => {
        if (!(io instanceof RawTerminalIO)) {
          const list = listSessions(resolved.data, { workspace: canonical })
          io.write(`\nSessions in ${canonical}: ${list.length}\n`)
          for (const s of list.slice(0, 10)) {
            io.write(
              `  ${s.id}  ${s.title} (${s.turns.length} turns, ${formatRelativeTime(s.updatedAt)})\n`,
            )
          }
          return
        }
        while (true) {
          const sessions = listSessions(resolved.data, { includeArchived: false })
          const res = await openSessionBrowser(io.raw, io.style, {
            sessions,
            activeSessionId: activeSession.id,
            currentWorkspace: canonical,
          })
          if (res.action === "cancel") return
          if (res.action === "new") {
            activeSession = createSession(canonical, detectGitBranch(canonical))
            io.write("\x1b[2J\x1b[H")
            renderCliHeader(
              io,
              canonical,
              isWorkspaceTrusted(resolved.config, canonical),
              activeConfig,
              activeSession,
            )
            return
          }
          if (res.action === "select") {
            const loaded = loadSession(resolved.data, res.sessionId)
            const accepted = loaded ? await confirmCrossWorkspaceSession(loaded) : undefined
            if (accepted) {
              activeSession = accepted
              io.write("\x1b[2J\x1b[H")
              renderCliHeader(
                io,
                canonical,
                isWorkspaceTrusted(resolved.config, canonical),
                activeConfig,
                activeSession,
              )
              renderResumedSessionContext(io, activeSession)
            }
            return
          }
          if (res.action === "rename") {
            const target =
              loadSession(resolved.data, res.sessionId) ??
              (res.sessionId === activeSession.id ? activeSession : undefined)
            if (target) {
              const renamed: SessionRecord = {
                ...target,
                title: res.title,
                customTitle: true,
                updatedAt: new Date().toISOString(),
              }
              saveSession(resolved.data, renamed)
              if (renamed.id === activeSession.id) activeSession = renamed
            }
            continue
          }
          if (res.action === "fork") {
            const target =
              loadSession(resolved.data, res.sessionId) ??
              (res.sessionId === activeSession.id ? activeSession : undefined)
            if (target) {
              const forked = forkSession(target)
              saveSession(resolved.data, forked)
              activeSession = forked
              io.write("\x1b[2J\x1b[H")
              renderCliHeader(
                io,
                canonical,
                isWorkspaceTrusted(resolved.config, canonical),
                activeConfig,
                activeSession,
              )
              renderResumedSessionContext(io, activeSession)
            }
            return
          }
          if (res.action === "delete") {
            deleteSession(resolved.data, res.sessionId)
            if (res.sessionId === activeSession.id) {
              activeSession = createSession(canonical, detectGitBranch(canonical))
            }
            continue
          }
        }
      }

      const handleTimelineRewind = async () => {
        if (!(io instanceof RawTerminalIO)) {
          if (activeSession.turns.length === 0) {
            io.write("No turns in this session yet.\n")
            return
          }
          activeSession.turns.forEach((t, idx) => {
            io.write(`  [${idx + 1}] ${t.outcome} · ${truncatePlain(t.userPrompt, 60)}\n`)
          })
          return
        }
        const res = await openTimelineRewind(io.raw, io.style, activeSession)
        if (res.action === "close") return
        if (res.action === "inspect") {
          await openTranscriptViewer(io.raw, io.style, activeSession, res.turnIndex)
          return
        }
        if (res.action === "fork") {
          const forked = forkSession(activeSession, res.turnIndex + 1)
          saveSession(resolved.data, forked)
          activeSession = forked
          io.write("\x1b[2J\x1b[H")
          renderCliHeader(
            io,
            canonical,
            isWorkspaceTrusted(resolved.config, canonical),
            activeConfig,
            activeSession,
          )
          renderResumedSessionContext(io, activeSession)
          return
        }
        if (res.action === "rewind_conversation" || res.action === "rewind_all") {
          const { updated, revertedTurns, promptToRestore } = rewindSessionToTurn(
            activeSession,
            res.turnIndex,
          )
          const activeSecret = activeConfig
            ? resolveCredentialSecret(activeConfig.credential, env).secret
            : undefined
          if (res.action === "rewind_all" && activeConfig) {
            const boundary = createBoundaryContext(canonical, resolved, activeConfig, env)
            const restored = restoreTurnCheckpoints(boundary, revertedTurns)
            const hasRestoredWork = restored.restored.length > 0 || restored.removed.length > 0
            if (restored.skipped.length > 0 && !hasRestoredWork) {
              io.writeError(
                `\nFile rewind blocked/skipped (${restored.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ")}); session turns left unchanged.\n`,
              )
              return
            }
            activeSession = updated
            saveSession(resolved.data, activeSession, activeSecret)
            draftBuffer = promptToRestore
            io.write(
              `\nRewound ${revertedTurns.length} turn(s); restored ${restored.restored.length} file(s)` +
                (restored.removed.length > 0
                  ? `, removed ${restored.removed.length} created file(s)`
                  : "") +
                (restored.skipped.length > 0
                  ? `, skipped ${restored.skipped.length} (${restored.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ")})`
                  : "") +
                ".\n",
            )
          } else {
            activeSession = updated
            saveSession(resolved.data, activeSession, activeSecret)
            draftBuffer = promptToRestore
            io.write(
              `\nRewound conversation ${revertedTurns.length} turn(s); prompt restored to composer.\n`,
            )
          }
        }
      }

      const dispatchSlashCommand = async (
        cmdName: string,
        cmdArgs: string,
      ): Promise<"continue" | "exit"> => {
        if (cmdName === "exit" || cmdName === "quit" || cmdName === "q") {
          return "exit"
        }
        if (cmdName === "help" || cmdName === "?") {
          if (io instanceof RawTerminalIO) {
            await openScrollableModal(
              io.raw,
              io.style,
              "Bashwink Help & Shortcuts",
              buildHelpModalLines(resolved.config, resolved.data, io.style),
            )
          } else {
            io.write(renderHelp(resolved.config, resolved.data))
          }
          return "continue"
        }
        if (cmdName === "trust") {
          const user = env["USER"] ?? env["USERNAME"] ?? "terminal-user"
          grantWorkspaceTrust(resolved.config, canonical, user)
          io.write(`Trusted ${canonical}.\n`)
          return "continue"
        }
        if (cmdName === "mode" || cmdName === "approvals" || cmdName === "permissions") {
          const sub = cmdArgs.trim().toLowerCase()
          if (sub === "reset" || sub === "clear") {
            savedRules = clearWorkspacePermissionRules(resolved.config, canonical).rules
            io.write(`Cleared saved Always-allow rules for ${canonical}.\n`)
            return "continue"
          }
          if (sub !== "" && isValidPermissionMode(sub)) {
            permissionMode = setWorkspacePermissionMode(resolved.config, canonical, sub).mode
            io.write(`Permission mode set to '${permissionMode}'.\n`)
            return "continue"
          }
          if (sub === "" && io instanceof RawTerminalIO) {
            const picked = await io.askChoice(
              `Permission mode (current: ${permissionMode}, saved always-rules: ${savedRules.length}):`,
              [
                ...PERMISSION_MODES.map((m): HybridChoiceOption => ({
                  value: m,
                  display:
                    m === "accept-edits"
                      ? `${m}${m === permissionMode ? " (active)" : ""} — Auto-apply workspace edits; confirm commands (default)`
                      : m === "smart"
                        ? `${m}${m === permissionMode ? " (active)" : ""} — Guardian LLM security reviewer + breaker (Hermes style)`
                        : m === "auto"
                          ? `${m}${m === permissionMode ? " (active)" : ""} — Auto-allow edits & safe checks; guardian reviews risky commands`
                          : m === "manual"
                            ? `${m}${m === permissionMode ? " (active)" : ""} — Confirm edits & commands [Allow once / Accept-edits / Always / Reject]`
                            : `${m}${m === permissionMode ? " (active)" : ""} — Read-only Q&A mode (edits & commands disabled)`,
                })),
                {
                  value: "reset",
                  display: `reset rules — Clear ${savedRules.length} saved workspace Always-allow rule(s)`,
                },
              ],
            )
            if (picked === "reset") {
              savedRules = clearWorkspacePermissionRules(resolved.config, canonical).rules
              io.write(`Cleared saved Always-allow rules for ${canonical}.\n`)
            } else if (picked && isValidPermissionMode(picked)) {
              permissionMode = setWorkspacePermissionMode(resolved.config, canonical, picked).mode
              io.write(`Permission mode set to '${permissionMode}'.\n`)
            }
            return "continue"
          }
          io.write(
            `Mode: ${permissionMode} (${savedRules.length} saved Always-allow rule(s)).\n` +
              "Usage: /mode [accept-edits | smart | auto | manual | ask | reset]\n",
          )
          return "continue"
        }
        if (
          cmdName === "setup" ||
          cmdName === "connect" ||
          cmdName === "model" ||
          cmdName === "models"
        ) {
          const prevDest = activeConfig
            ? `${activeConfig.endpointType}:${formatDestination(activeConfig.baseURL)}`
            : undefined
          const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
          if (res.status === "saved") {
            const nextDest = `${res.config.endpointType}:${formatDestination(res.config.baseURL)}`
            if (prevDest && prevDest !== nextDest && activeSession.turns.length > 0) {
              const splitSession = await askYesNo(
                io,
                `Destination changed (${prevDest} -> ${nextDest}) with ${activeSession.turns.length} prior turn(s). Start a fresh session instead of sharing history? [y/N] `,
              )
              if (isYes(splitSession)) {
                activeSession = createSession(canonical, detectGitBranch(canonical))
              }
            }
            activeConfig = res.config
            renderCliHeader(
              io,
              canonical,
              isWorkspaceTrusted(resolved.config, canonical),
              activeConfig,
              activeSession,
            )
          }
          return "continue"
        }
        if (cmdName === "test" || cmdName === "ping" || cmdName === "verify") {
          if (!activeConfig) {
            io.write("No model configured yet. Run `/model` or `/connect` first.\n")
            return "continue"
          }
          io.write(`\nTesting ${activeConfig.model} at ${activeConfig.baseURL}...\n`)
          const testRes = await testProviderConnection({ config: activeConfig, env })
          printConnectionTestResult(io, testRes, activeConfig.model)
          return "continue"
        }
        if (cmdName === "sessions" || cmdName === "resume" || cmdName === "continue") {
          await handleSessionBrowser()
          return "continue"
        }
        if (cmdName === "new") {
          activeSession = createSession(canonical, detectGitBranch(canonical))
          if (io instanceof RawTerminalIO) io.write("\x1b[2J\x1b[H")
          renderCliHeader(
            io,
            canonical,
            isWorkspaceTrusted(resolved.config, canonical),
            activeConfig,
            activeSession,
          )
          return "continue"
        }
        if (cmdName === "clear") {
          activeSession = createSession(canonical, detectGitBranch(canonical))
          if (io instanceof RawTerminalIO) io.write("\x1b[2J\x1b[H")
          renderCliHeader(
            io,
            canonical,
            isWorkspaceTrusted(resolved.config, canonical),
            activeConfig,
            activeSession,
          )
          return "continue"
        }
        if (cmdName === "fork") {
          const forked = forkSession(activeSession)
          saveSession(resolved.data, forked)
          activeSession = forked
          io.write(`\nForked into new session ${activeSession.id} (${activeSession.title}).\n`)
          return "continue"
        }
        if (cmdName === "rename") {
          const newTitle =
            cmdArgs !== "" ? cmdArgs : ((await io.ask("New session title: "))?.trim() ?? "")
          if (newTitle !== "") {
            activeSession = {
              ...activeSession,
              title: newTitle,
              customTitle: true,
              updatedAt: new Date().toISOString(),
            }
            saveSession(resolved.data, activeSession)
            io.write(`Renamed session to '${sanitizeTerminalText(newTitle)}'.\n`)
          }
          return "continue"
        }
        if (
          cmdName === "timeline" ||
          cmdName === "rewind" ||
          cmdName === "checkpoint" ||
          cmdName === "undo"
        ) {
          await handleTimelineRewind()
          return "continue"
        }
        if (cmdName === "transcript") {
          if (io instanceof RawTerminalIO) {
            await openTranscriptViewer(io.raw, io.style, activeSession)
          } else {
            renderResumedSessionContext(io, activeSession)
          }
          return "continue"
        }
        if (cmdName === "diff") {
          if (io instanceof RawTerminalIO) {
            await openScrollableModal(
              io.raw,
              io.style,
              `Session Changes (${activeSession.title})`,
              buildDiffModalLines(activeSession, io.style, io.raw.cols()),
            )
          } else {
            const changed = [...new Set(activeSession.turns.flatMap((t) => t.changedFiles))]
            io.write(`Changed files: ${changed.length > 0 ? changed.join(", ") : "none"}\n`)
          }
          return "continue"
        }
        if (cmdName === "compact") {
          const compacted = compactSessionMessages(activeSession, 2)
          if (compacted.summarizedTurns === 0) {
            io.write("Session has <= 2 turns; nothing to compact.\n")
          } else {
            activeSession = compacted.updated
            saveSession(resolved.data, activeSession)
            io.write(
              `Compacted ${compacted.summarizedTurns} earlier turn(s) (${compacted.beforeMessages} -> ${compacted.afterMessages} context messages).\n`,
            )
          }
          return "continue"
        }
        if (cmdName === "status") {
          const trustedNow = isWorkspaceTrusted(resolved.config, canonical)
          io.write("\n--- Status ---\n")
          io.write(`Session   ${activeSession.title} (${activeSession.id})\n`)
          io.write(
            `Turns     ${activeSession.turns.length} (${activeSession.messages.length} context messages)\n`,
          )
          io.write(`Workspace ${canonical} (${trustedNow ? "trusted" : "read-only"})\n`)
          io.write(
            `Mode      ${permissionMode} (${savedRules.length} saved Always-allow rule(s))\n`,
          )
          io.write(
            `Model     ${activeConfig ? `${activeConfig.model} at ${formatDestination(activeConfig.baseURL)}` : "none"}\n`,
          )
          io.write(
            `Usage     ${activeSession.usageTotals.requests} reqs, ${activeSession.usageTotals.totalTokens} tokens` +
              (activeSession.usageTotals.costUsd !== undefined
                ? `, est. $${activeSession.usageTotals.costUsd.toFixed(6)}`
                : "") +
              "\n",
          )
          return "continue"
        }
        if (cmdName === "evidence") {
          const evFile = path.join(resolved.evidence, "evidence.jsonl")
          if (!existsSync(evFile)) {
            io.write(`No evidence log yet (${evFile}).\n`)
            return "continue"
          }
          const v = verifyEvidenceFile(evFile)
          io.write(
            v.ok
              ? `Evidence OK: ${v.entries} entries (head ${v.head.slice(0, 12)}…)\n`
              : `Evidence verification failed: ${v.reason}\n`,
          )
          return "continue"
        }
        if (cmdName === "contract") {
          try {
            const active = loadActiveContract(resolved.data, canonical)
            if (!active) {
              io.write(
                `No active IntentLock contract for ${canonical}. Create via \`bashwink contract new\`.\n`,
              )
            } else {
              io.write(`\n${renderContractSummary(active)}\n`)
            }
          } catch (err) {
            io.writeError(`${err instanceof Error ? err.message : String(err)}\n`)
          }
          return "continue"
        }
        if (cmdName === "proof") {
          handleProofCli(["show", ...(cmdArgs ? [cmdArgs] : [])], cwd, resolved.data, io)
          return "continue"
        }
        return "continue"
      }

      while (!interruptedAtPrompt) {
        let trusted = isWorkspaceTrusted(resolved.config, canonical)
        const promptLabel = activeConfig ? "bashwink> " : "bashwink (no model)> "
        let trimmed = ""

        if (io instanceof RawTerminalIO) {
          const action: ComposerAction = await runInteractiveComposer({
            raw: io.raw,
            style: io.style,
            promptLabel,
            permissionMode,
            statusSummary: buildStatusSummary(
              activeSession,
              trusted,
              activeConfig,
              io.raw.layout(),
              permissionMode,
            ),
            getStatusSummary: (layout) =>
              buildStatusSummary(activeSession, trusted, activeConfig, layout, permissionMode),
            getMetadata: () => buildComposerMetadata(trusted, activeConfig, permissionMode),
            getStatusFooter: () => buildComposerStatusFooter(canonical, env, activeSession),
            workspace: canonical,
            history: promptHistory,
            initialDraft: draftBuffer,
          })
          draftBuffer = ""
          if (action.kind === "exit") break
          if (action.kind === "cycle_mode") {
            permissionMode = setWorkspacePermissionMode(
              resolved.config,
              canonical,
              nextPermissionMode(permissionMode),
            ).mode
            draftBuffer = action.draft
            continue
          }
          if (action.kind === "clear_screen") {
            io.write("\x1b[2J\x1b[H")
            renderCliHeader(io, canonical, trusted, activeConfig, activeSession)
            continue
          }
          if (action.kind === "palette") {
            const cmdId = await openCommandPalette(io.raw, io.style, buildPaletteItems())
            if (cmdId) {
              const res = await dispatchSlashCommand(cmdId, "")
              if (res === "exit") break
            }
            continue
          }
          if (action.kind === "sessions") {
            await handleSessionBrowser()
            continue
          }
          if (action.kind === "timeline") {
            await handleTimelineRewind()
            continue
          }
          if (action.kind === "transcript") {
            await openTranscriptViewer(io.raw, io.style, activeSession)
            continue
          }
          if (action.kind === "command") {
            const res = await dispatchSlashCommand(action.name, action.args)
            if (res === "exit") break
            continue
          }
          trimmed = action.text.trim()
        } else {
          const line = await io.ask(`\n${promptLabel}`)
          if (line === null || interruptedAtPrompt) break
          trimmed = line.trim()
        }

        if (trimmed === "") {
          if (!activeConfig) {
            const res = await runInteractiveSetup(io, resolved.config, env, undefined)
            if (res.status === "saved") {
              activeConfig = res.config
              renderCliHeader(
                io,
                canonical,
                isWorkspaceTrusted(resolved.config, canonical),
                activeConfig,
                activeSession,
              )
            }
          }
          continue
        }

        if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") break
        if (trimmed === "connect") {
          const res = await dispatchSlashCommand("connect", "")
          if (res === "exit") break
          continue
        }
        if (trimmed.startsWith("/")) {
          const body = trimmed.slice(1)
          const space = body.search(/\s/)
          const cmd = (space === -1 ? body : body.slice(0, space)).toLowerCase()
          const cmdArgs = space === -1 ? "" : body.slice(space + 1).trim()
          const res = await dispatchSlashCommand(cmd, cmdArgs)
          if (res === "exit") break
          continue
        }

        if (!activeConfig) {
          io.write("\nNo model configured yet — configure a model first.\n")
          const res = await runInteractiveSetup(io, resolved.config, env, undefined)
          if (res.status !== "saved") continue
          activeConfig = res.config
          renderCliHeader(
            io,
            canonical,
            isWorkspaceTrusted(resolved.config, canonical),
            activeConfig,
            activeSession,
          )
        }

        if (!trusted && !trustPromptShown && permissionMode !== "ask") {
          trustPromptShown = true
          io.write(`\nWorkspace ${canonical} is NOT trusted yet (read-only mode).\n`)
          io.write(
            "Reads are allowed. File edits and commands require trusting this directory, and approved actions run with your user permissions (not an OS sandbox).\n",
          )
          const trustAns = await askYesNo(
            io,
            "Trust this workspace for interactive edit/command approvals? [y/N] ",
          )
          if (trustAns === null) break
          if (isYes(trustAns)) {
            const user = env["USER"] ?? env["USERNAME"] ?? "terminal-user"
            grantWorkspaceTrust(resolved.config, canonical, user)
            trusted = true
            io.write(`Trusted ${canonical}.\n`)
          } else {
            io.write(
              "Continuing in read-only mode (edits and commands will be denied). Run /trust anytime to trust this folder.\n",
            )
          }
        }

        const cred = resolveCredentialSecret(activeConfig.credential, env)
        if (!cred.ok) {
          io.writeError(
            `\nProvider at ${formatDestination(activeConfig.baseURL)} cannot authenticate (${cred.summary}).\n`,
          )
          const repair = await askYesNo(
            io,
            "Open /model setup to repair provider credentials? [y/N] ",
          )
          if (isYes(repair)) {
            const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
            if (res.status === "saved") activeConfig = res.config
          }
          continue
        }

        promptHistory = appendPromptHistory(resolved.data, trimmed, cred.secret)
        currentAbort = new AbortController()
        const turnCheckpoints: FileCheckpoint[] = []
        const checkpointedPaths = new Set<string>()

        // Live spinner & raw Ctrl+C / Escape cancel listener while task runs
        let spinnerTimer: ReturnType<typeof setInterval> | undefined
        let stopTaskCapture: (() => void) | undefined
        let spinnerActive = false
        let spinnerText = ""
        let spinnerIdx = 0
        const taskStartMs = Date.now()

        const clearSpinnerLine = () => {
          if (spinnerActive && io instanceof RawTerminalIO) {
            io.write("\r\x1b[2K")
            spinnerActive = false
          }
        }

        const startSpinnerAndCancel = () => {
          if (!(io instanceof RawTerminalIO)) return
          if (!stopTaskCapture) {
            stopTaskCapture = io.raw.beginCapture((ev) => {
              if (
                (ev.kind === "ctrl" && ev.key === "c") ||
                (ev.kind === "key" && ev.name === "escape")
              ) {
                clearSpinnerLine()
                io.write("\nCancelling current task...\n")
                currentAbort?.abort()
              }
            })
          }
          if (!spinnerTimer && spinnerText !== "") {
            spinnerTimer = setInterval(() => {
              if (!spinnerText || !(io instanceof RawTerminalIO)) return
              const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]!
              spinnerIdx += 1
              const elapsed = ((Date.now() - taskStartMs) / 1000).toFixed(1)
              io.write(
                `\r\x1b[2K${io.style.accent(frame)} ${spinnerText} ${io.style.muted(`(${elapsed}s · esc/ctrl+c cancel)`)}`,
              )
              spinnerActive = true
            }, 90)
          }
        }

        const pauseSpinnerAndCancel = () => {
          if (spinnerTimer) {
            clearInterval(spinnerTimer)
            spinnerTimer = undefined
          }
          clearSpinnerLine()
          if (stopTaskCapture) {
            stopTaskCapture()
            stopTaskCapture = undefined
          }
        }

        startSpinnerAndCancel()

        const shownDiffCallIds = new Set<string>()
        const readBurst: Array<{
          readonly tool: "read_file" | "list_files"
          readonly target: string
          readonly ok: boolean
        }> = []

        const flushReadBurst = () => {
          if (readBurst.length === 0) return
          const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
          if (readBurst.length <= 3) {
            for (const entry of readBurst) {
              const target = sanitizeTerminalText(entry.target || ".")
              if (entry.tool === "list_files") {
                const icon = entry.ok ? style.accent("✱") : style.red("✗")
                io.write(`  ${icon} ${style.muted(`List ${target}`)}\n`)
              } else {
                const icon = entry.ok ? style.muted("→") : style.yellow("✗")
                io.write(
                  `  ${icon} ${style.muted(entry.ok ? `Read ${target}` : `Read ${target} (not found)`)}\n`,
                )
              }
            }
          } else {
            const dirs = readBurst.filter((r) => r.tool === "list_files")
            const files = readBurst.filter((r) => r.tool === "read_file")
            const failed = readBurst.filter((r) => !r.ok).length
            const parts: string[] = []
            if (dirs.length > 0)
              parts.push(`listed ${dirs.length} dir${dirs.length === 1 ? "" : "s"}`)
            if (files.length > 0)
              parts.push(`read ${files.length} file${files.length === 1 ? "" : "s"}`)
            const samples = [
              ...new Set(
                readBurst.filter((r) => r.ok && r.target && r.target !== ".").map((r) => r.target),
              ),
            ].slice(0, 3)
            const sampleText =
              samples.length > 0
                ? ` (${samples.join(", ")}${readBurst.length > 3 ? ", …" : ""})`
                : ""
            const errText = failed > 0 ? ` · ${failed} unreadable` : ""
            io.write(
              `  ${style.green("✓")} ${style.muted(`Explored ${parts.join(", ")}${sampleText}${errText}`)}\n`,
            )
          }
          readBurst.length = 0
        }

        let activeContract
        try {
          activeContract = loadActiveContract(resolved.data, canonical)
        } catch (err) {
          io.writeError(
            `${err instanceof Error ? err.message : String(err)}\nRepair or remove the corrupted contract before running tasks.\n`,
          )
          currentAbort = undefined
          continue
        }
        let result: TaskResult
        try {
          result = await runTask(
            {
              workspace: canonical,
              prompt: trimmed,
              trusted,
              config: activeConfig,
              permissionMode,
              savedRules,
              history: activeSession.messages,
              budgets: parsedRunOpts.cliBudgets,
              ...(activeContract ? { contract: activeContract } : {}),
              requireContract: parsedRunOpts.requireContract,
              signal: currentAbort.signal,
            },
            {
              paths: resolved,
              env,
              ...(options.completeImpl ? { completeImpl: options.completeImpl } : {}),
              onSavePermissionRule: (rule) => {
                savedRules = saveAlwaysPermissionRule(resolved.config, canonical, rule).rules
              },
              onPermissionModeChange: (nextMode) => {
                permissionMode = setWorkspacePermissionMode(
                  resolved.config,
                  canonical,
                  nextMode,
                ).mode
                clearSpinnerLine()
                const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                io.write(
                  `  ${style.cyan("↳")} switched permission mode to ${style.bold(permissionMode)}\n`,
                )
              },
              requestWorkspaceTrust: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
                pauseSpinnerAndCancel()
                flushReadBurst()
                try {
                  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                  if (req.kind === "edit_file") {
                    const cleanPatch = sanitizeTerminalText(req.prepared.diffPreview)
                    const rendered = renderOpenCodeDiff(
                      cleanPatch,
                      {
                        path: req.prepared.relativePath,
                        create: req.prepared.create,
                        maxWidth: terminalCols(io),
                        view: "auto",
                      },
                      style,
                    )
                    shownDiffCallIds.add(req.callId)
                    io.write(`\n${rendered.join("\n")}\n`)
                    io.write(
                      `  ${style.yellow("Note:")} Workspace ${sanitizeTerminalText(canonical)} is read-only; trusting enables edits.\n`,
                    )
                    const dec = await askPermissionDecision(
                      io,
                      "Shall I edit & switch to accept-edits mode? [Y/n]",
                      {
                        allowAlways: false,
                        allowAcceptEdits: true,
                        yesMeansAcceptEdits: true,
                        defaultChoice: "accept-edits",
                        ...(currentAbort ? { signal: currentAbort.signal } : {}),
                      },
                    )
                    if (dec !== "reject") trusted = true
                    return dec
                  }
                  return "reject"
                } finally {
                  startSpinnerAndCancel()
                }
              },
              onEvent: (event: TaskEvent) => {
                if (event.type === "model_requested") {
                  spinnerText = `Waiting for ${event.model} at ${formatDestination(event.endpoint)}`
                  if (!(io instanceof RawTerminalIO) && event.step === 1) {
                    io.write(
                      `Waiting for ${event.model} at ${formatDestination(event.endpoint)}...\n`,
                    )
                  }
                  startSpinnerAndCancel()
                } else if (event.type === "guardian_review") {
                  clearSpinnerLine()
                  flushReadBurst()
                  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                  const tag =
                    event.verdict === "APPROVE"
                      ? style.green("APPROVE")
                      : event.verdict === "DENY"
                        ? style.red("DENY")
                        : style.yellow("ESCALATE")
                  const reasonSuffix = event.reason
                    ? ` (${sanitizeTerminalText(event.reason)})`
                    : ""
                  io.write(`  ${style.accent("◆")} Smart review [${tag}]${reasonSuffix}\n`)
                  startSpinnerAndCancel()
                } else if (event.type === "tool_approved") {
                  if (
                    event.tool === "edit_file" &&
                    event.relativePath &&
                    event.resolvedPath &&
                    !checkpointedPaths.has(event.relativePath)
                  ) {
                    checkpointedPaths.add(event.relativePath)
                    const cp = captureFileCheckpoint(
                      canonical,
                      event.relativePath,
                      event.resolvedPath,
                      cred.secret,
                    )
                    if (cp) turnCheckpoints.push(cp)
                  }
                  if (event.source && event.source !== "user" && event.source !== "user-always") {
                    clearSpinnerLine()
                    flushReadBurst()
                    const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                    io.write(`  ${style.muted(`↳ approved (${event.source})`)}\n`)
                    startSpinnerAndCancel()
                  }
                } else if (event.type === "tool_completed") {
                  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                  if (event.result.tool === "list_files" || event.result.tool === "read_file") {
                    const target =
                      event.result.target ?? (event.result.tool === "list_files" ? "." : "")
                    readBurst.push({
                      tool: event.result.tool,
                      target,
                      ok: event.result.status === "ok",
                    })
                    const readCount = readBurst.filter((r) => r.tool === "read_file").length
                    const dirCount = readBurst.filter((r) => r.tool === "list_files").length
                    const progressParts: string[] = []
                    if (dirCount > 0)
                      progressParts.push(`${dirCount} dir${dirCount === 1 ? "" : "s"}`)
                    if (readCount > 0)
                      progressParts.push(`${readCount} file${readCount === 1 ? "" : "s"}`)
                    spinnerText =
                      event.result.tool === "read_file"
                        ? `Reading ${sanitizeTerminalText(target)} (${progressParts.join(", ")})`
                        : `Listing ${sanitizeTerminalText(target || ".")} (${progressParts.join(", ")})`
                    startSpinnerAndCancel()
                    return
                  }

                  clearSpinnerLine()
                  flushReadBurst()
                  if (event.result.tool === "edit_file") {
                    if (
                      event.result.status === "ok" &&
                      event.result.patch &&
                      !shownDiffCallIds.has(event.result.callId)
                    ) {
                      const cleanPatch = sanitizeTerminalText(event.result.patch)
                      const rendered = renderOpenCodeDiff(
                        cleanPatch,
                        {
                          path: event.result.target ?? event.result.changedFile ?? "file",
                          create: event.result.create,
                          maxWidth: terminalCols(io),
                          view: "auto",
                        },
                        style,
                      )
                      io.write(`\n${rendered.join("\n")}\n`)
                    }
                    const icon = event.result.status === "ok" ? style.green("✓") : style.red("✗")
                    io.write(`  ${icon} ${event.result.output}\n`)
                  } else if (event.result.tool === "run_command") {
                    const shellLines = renderOpenCodeShellCard(
                      {
                        command: sanitizeTerminalText(event.result.target ?? "command"),
                        output: sanitizeTerminalText(event.result.output),
                        status: event.result.status,
                        ...(event.result.exitCode !== undefined
                          ? { exitCode: event.result.exitCode }
                          : {}),
                        ...(event.result.signal !== undefined
                          ? { signal: event.result.signal }
                          : {}),
                        maxWidth: terminalCols(io),
                      },
                      style,
                    )
                    io.write(`${shellLines.map((l) => `  ${l}`).join("\n")}\n`)
                  }
                }
              },
              confirmAction: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
                pauseSpinnerAndCancel()
                flushReadBurst()
                try {
                  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                  if (req.kind === "edit_file") {
                    const cleanPatch = sanitizeTerminalText(
                      sanitizeSecretText(req.prepared.diffPreview, cred.secret),
                    )
                    const rendered = renderOpenCodeDiff(
                      cleanPatch,
                      {
                        path: req.prepared.relativePath,
                        create: req.prepared.create,
                        maxWidth: terminalCols(io),
                        view: "auto",
                      },
                      style,
                    )
                    shownDiffCallIds.add(req.callId)
                    io.write(`\n${rendered.join("\n")}\n`)
                    if (req.integrityWarning) {
                      io.write(
                        `${style.red("TestGuard Warning:")} ${sanitizeTerminalText(sanitizeSecretText(req.integrityWarning, cred.secret))}\n`,
                      )
                    }
                    if (req.reason && req.reason !== req.integrityWarning) {
                      const prefix = req.smartDenied ? style.red("Blocked:") : style.yellow("Note:")
                      io.write(
                        `${prefix} ${sanitizeTerminalText(sanitizeSecretText(req.reason, cred.secret))}\n`,
                      )
                    }
                    return await askPermissionDecision(io, "Apply this change? [y/N]", {
                      allowAlways: req.allowAlways ?? true,
                      allowAcceptEdits: true,
                      ...(req.integrityWarning ? { integrityWarning: req.integrityWarning } : {}),
                      ...(req.suggestedSummary ? { alwaysSummary: req.suggestedSummary } : {}),
                      ...(currentAbort ? { signal: currentAbort.signal } : {}),
                    })
                  }
                  const cmdLine = sanitizeTerminalText(
                    sanitizeSecretText(
                      [req.prepared.command, ...req.prepared.args].join(" "),
                      cred.secret,
                    ),
                  )
                  io.write(`\n  ${style.yellow("┃")} ${style.bold("$")} ${style.bold(cmdLine)}\n`)
                  io.write(
                    `  ${style.yellow("┃")} ${style.muted(`Dir      ${sanitizeTerminalText(sanitizeSecretText(req.prepared.cwd, cred.secret))}`)}\n`,
                  )
                  io.write(
                    `  ${style.yellow("┃")} ${style.muted(`Warning  ${req.hostAccessWarning}`)}\n`,
                  )
                  if (req.reason) {
                    const prefix = req.smartDenied ? style.red("Blocked:") : style.yellow("Note:")
                    io.write(
                      `  ${style.yellow("┃")} ${prefix} ${sanitizeTerminalText(sanitizeSecretText(req.reason, cred.secret))}\n`,
                    )
                  }
                  io.write(`  ${style.dim("╹")}\n`)
                  return await askPermissionDecision(io, "Run this command? [y/N]", {
                    allowAlways: req.allowAlways ?? true,
                    ...(req.suggestedSummary ? { alwaysSummary: req.suggestedSummary } : {}),
                    ...(currentAbort ? { signal: currentAbort.signal } : {}),
                  })
                } finally {
                  startSpinnerAndCancel()
                }
              },
            },
          )
        } finally {
          pauseSpinnerAndCancel()
          flushReadBurst()
        }

        currentAbort = undefined
        renderTaskOutcome(result, io)
        if (
          !trusted &&
          result.actions?.some(
            (a) => a.decision === "deny" && (a.tool === "edit_file" || a.tool === "run_command"),
          )
        ) {
          const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
          io.write(
            `  ${style.yellow("Tip:")} Workspace is read-only — run ${style.bold("/trust")} in the prompt box below to allow edits and commands.\n`,
          )
        }

        const finalizedCheckpoints = finalizeTurnCheckpoints(
          createBoundaryContext(canonical, resolved, activeConfig, env, activeContract),
          turnCheckpoints,
        )
        activeSession = appendTurnToSession(activeSession, {
          userPrompt: trimmed,
          result,
          model: activeConfig.model,
          checkpoints: finalizedCheckpoints,
        })
        saveSession(resolved.data, activeSession, cred.secret)

        if (
          result.outcome === "failed" &&
          result.stopReason &&
          /(401|403|rejected authentication|cannot authenticate)/i.test(result.stopReason)
        ) {
          const repair = await askYesNo(
            io,
            "Provider rejected request. Run /setup to repair? [y/N] ",
          )
          if (isYes(repair)) {
            const prevDest = activeConfig
              ? `${activeConfig.endpointType}:${formatDestination(activeConfig.baseURL)}`
              : undefined
            const res = await runInteractiveSetup(io, resolved.config, env, activeConfig)
            if (res.status === "saved") {
              const nextDest = `${res.config.endpointType}:${formatDestination(res.config.baseURL)}`
              if (prevDest && prevDest !== nextDest && activeSession.turns.length > 0) {
                const splitSession = await askYesNo(
                  io,
                  `Destination changed (${prevDest} -> ${nextDest}). Start a fresh session instead of sharing history? [y/N] `,
                )
                if (isYes(splitSession)) {
                  activeSession = createSession(canonical, detectGitBranch(canonical))
                }
              }
              activeConfig = res.config
            }
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
