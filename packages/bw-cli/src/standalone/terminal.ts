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
import {
  probeModels,
  testProviderConnection,
  type ProbeModelsResult,
  type TestConnectionResult,
} from "./provider.ts"
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
import { DEFAULT_TASK_BUDGETS, runTask, type ApprovalRequest } from "./task-loop.ts"
import { PROVIDER_CATALOG, findProviderPreset, type ProviderPreset } from "./provider-catalog.ts"
import {
  CURSOR_SHOW,
  SYNC_END,
  SYNC_START,
  colorsEnabled,
  countDiffChanges,
  getTerminalLayout,
  nextGraphemeBoundary,
  padPlainRight,
  previousGraphemeBoundary,
  createStyle,
  renderFieldView,
  alignRight,
  ACTIVITY_CARD_INSET,
  formatTokenCount,
  renderActivityCard,
  renderActivityRow,
  renderSessionStatus,
  renderWelcomeScreen,
  renderTranscriptDiff,
  renderOpenCodeDiff,
  renderOpenCodeMarkdown,
  renderOpenCodeShellCard,
  stripAnsiSequences,
  truncatePathMiddle,
  truncatePlain,
  visibleWidth,
  wrapPlainText,
  wrapStyledLine,
  type ParsedKeyEvent,
  type SessionStatus,
  type TuiStyle,
} from "./tui-theme.ts"
import { renderTapResults } from "./tui-test-results.ts"
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
  runCancellableActivity,
  runInteractiveComposer,
  type ComposerAction,
  type ComposerTurnContext,
  type ComposerTurnOutcome,
  type HybridChoiceOption,
  type HybridChoiceOptions,
  type HybridPermissionOptions,
  type PaletteCommandItem,
} from "./tui-widgets.ts"
import type {
  ApprovalDecision,
  ConnectionTestSummary,
  CredentialConfig,
  PermissionMode,
  ProofPackManifest,
  SavedPermissionRule,
  StandaloneConfig,
  TaskBudgets,
  TaskEvent,
  TaskResult,
  ToolDispatchResult,
} from "./types.ts"

export const STANDALONE_VERSION = "0.2.0-alpha.2"

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
  askChoice?(prompt: string, options: readonly HybridChoiceOption[]): Promise<string | null>
  close(): void
}

/** Result of a single editable field: a value, or the user stepping back / cancelling. */
export type PromptOutcome =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" }

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
  readonly homeDirectory: string
  readonly isTTY = true
  readonly raw: RawTerminalSession
  readonly style: TuiStyle
  /**
   * While a turn owns the pinned composer, all transcript output has to go through the
   * composer's erase/write/re-pin path instead of landing inside the prompt rows.
   */
  private writeSink: ((text: string) => void) | undefined

  constructor(env: NodeJS.ProcessEnv) {
    this.homeDirectory = env["HOME"] ?? env["USERPROFILE"] ?? ""
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
    if (this.writeSink) {
      this.writeSink(text)
      return
    }
    this.raw.write(text)
  }

  writeError(text: string): void {
    if (this.writeSink) {
      this.writeSink(text)
      return
    }
    process.stderr.write(text)
  }

  /** Routes transcript output through the active composer turn (or back to the terminal). */
  setWriteSink(sink: ((text: string) => void) | undefined): void {
    this.writeSink = sink
  }

  async ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.askLineOutcome(prompt, signal === undefined ? {} : { signal })
    return res.kind === "value" ? res.value : null
  }

  async askSecret(prompt: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.askLineOutcome(
      prompt,
      signal === undefined ? { secret: true } : { secret: true, signal },
    )
    return res.kind === "value" ? res.value : null
  }

  /**
   * A single-line field that renders the label on its own row and the value below it, so a
   * long prompt can never push the typed text off screen or leave a duplicate row behind
   * (TUI-04). Esc reports `back` and Ctrl+C reports `cancel` so setup can offer both.
   */
  async askLineOutcome(
    prompt: string,
    opts: {
      readonly secret?: boolean
      readonly signal?: AbortSignal
      readonly backOnEscape?: boolean
    } = {},
  ): Promise<PromptOutcome> {
    const maskSecret = opts.secret === true
    const signal = opts.signal
    let buffer = ""
    let cursor = 0
    let renderedRows = 0
    let cursorRowInBlock = 0

    const render = () => {
      const style = this.style
      const cols = Math.max(20, this.raw.cols())
      const layout = this.raw.layout()
      const display = maskSecret ? "•".repeat(buffer.length) : buffer
      const hint =
        layout.rows >= 10
          ? opts.backOnEscape
            ? "  enter accepts · esc back · ctrl+c cancel"
            : "  enter accepts · ctrl+c cancel"
          : undefined
      const view = renderFieldView(prompt, display, cursor, cols, style, hint)
      let frame = SYNC_START
      if (renderedRows > 0) {
        frame += "\r"
        if (cursorRowInBlock > 0) frame += `\x1b[${cursorRowInBlock}A`
        frame += "\x1b[J"
      }
      frame += view.rows.join("\n")
      const below = view.rows.length - 1 - view.cursorRow
      if (below > 0) frame += `\x1b[${below}A`
      frame += "\r"
      if (view.cursorCol > 0) frame += `\x1b[${view.cursorCol}C`
      frame += CURSOR_SHOW + SYNC_END
      this.raw.write(frame)
      renderedRows = view.rows.length
      cursorRowInBlock = view.cursorRow
    }

    return await new Promise<PromptOutcome>((resolve) => {
      let done = false
      let cleanup = () => {}
      const onAbort = () => finish({ kind: "cancel" })
      const finish = (val: PromptOutcome) => {
        if (done) return
        done = true
        signal?.removeEventListener("abort", onAbort)
        cleanup()
        this.raw.write("\n")
        resolve(val)
      }
      if (signal?.aborted) {
        finish({ kind: "cancel" })
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      const onKey = (ev: ParsedKeyEvent) => {
        if (ev.kind === "ctrl") {
          if (ev.key === "c" || ev.key === "d") return finish({ kind: "cancel" })
          if (ev.key === "u") {
            buffer = buffer.slice(cursor)
            cursor = 0
            return render()
          }
          if (ev.key === "a") {
            cursor = 0
            return render()
          }
          if (ev.key === "e") {
            cursor = buffer.length
            return render()
          }
          return
        }
        if (ev.kind === "paste") {
          const clean = ev.text.replace(/[\r\n]+/g, "")
          buffer = buffer.slice(0, cursor) + clean + buffer.slice(cursor)
          cursor += clean.length
          return render()
        }
        if (ev.kind === "char") {
          buffer = buffer.slice(0, cursor) + ev.text + buffer.slice(cursor)
          cursor += ev.text.length
          return render()
        }
        if (ev.kind === "key") {
          if (ev.name === "escape") {
            return finish(opts.backOnEscape ? { kind: "back" } : { kind: "cancel" })
          }
          if (ev.name === "enter") return finish({ kind: "value", value: buffer })
          if (ev.name === "backspace") {
            if (cursor > 0) {
              const left = previousGraphemeBoundary(buffer, cursor)
              buffer = buffer.slice(0, left) + buffer.slice(cursor)
              cursor = left
              render()
            }
            return
          }
          if (ev.name === "delete") {
            if (cursor < buffer.length) {
              const next = nextGraphemeBoundary(buffer, cursor)
              buffer = buffer.slice(0, cursor) + buffer.slice(next)
              render()
            }
            return
          }
          if (ev.name === "left" && cursor > 0) {
            cursor = previousGraphemeBoundary(buffer, cursor)
            return render()
          }
          if (ev.name === "right" && cursor < buffer.length) {
            cursor = nextGraphemeBoundary(buffer, cursor)
            return render()
          }
          if (ev.name === "home") {
            cursor = 0
            return render()
          }
          if (ev.name === "end") {
            cursor = buffer.length
            return render()
          }
        }
      }
      cleanup = this.raw.beginCapture(onKey, render)
      render()
    })
  }

  async askChoice(
    prompt: string,
    options: readonly HybridChoiceOption[],
    choiceOptions: HybridChoiceOptions = {},
  ): Promise<string | null> {
    return await askHybridChoice(this.raw, this.style, prompt, options, choiceOptions)
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

/**
 * Review-step action bar: `y` saves, `t` runs the sample test, `b` steps back to the model
 * list, `esc` cancels. The shortcut row is a fixed, short string so it stays readable at
 * 40 columns where the review block itself is clipped (TUI-04).
 */
/** Shortcut row for the review step; exported so the compact layout stays regression-tested. */
export function reviewShortcutHint(backAvailable: boolean): string {
  return backAvailable ? "t test · y save · b back · esc cancel" : "t test · y save · esc cancel"
}

async function askReviewAction(
  raw: RawTerminalSession,
  style: TuiStyle,
  opts: { readonly prompt: string; readonly backAvailable?: boolean },
): Promise<"save" | "test" | "back" | "cancel"> {
  let typed = ""
  let renderedRows = 0
  const shortcut = reviewShortcutHint(opts.backAvailable !== false)

  const render = () => {
    const cols = raw.cols()
    const promptLine = `${opts.prompt}${typed === "" ? "" : ` ${typed}`}`
    const lines = [truncatePlain(promptLine, cols), style.dim(truncatePlain(`  ${shortcut}`, cols))]
    let frame = SYNC_START
    if (renderedRows > 0) {
      frame += "\r"
      if (renderedRows > 1) frame += `\x1b[${renderedRows - 1}A`
      frame += "\x1b[J"
    }
    frame += `${lines.join("\n")}${CURSOR_SHOW}${SYNC_END}`
    raw.write(frame)
    renderedRows = lines.length
  }

  return await new Promise<"save" | "test" | "back" | "cancel">((resolve) => {
    let done = false
    const finish = (val: "save" | "test" | "back" | "cancel") => {
      if (done) return
      done = true
      cleanup()
      raw.write("\n")
      resolve(val)
    }
    const onKey = (ev: ParsedKeyEvent) => {
      if (ev.kind === "ctrl" && (ev.key === "c" || ev.key === "d")) {
        finish("cancel")
        return
      }
      if (ev.kind === "key" && ev.name === "escape") {
        finish("cancel")
        return
      }
      if (ev.kind === "char") {
        typed += ev.text
        render()
        return
      }
      if (ev.kind === "key" && ev.name === "backspace") {
        if (typed.length > 0) {
          typed = typed.slice(0, -1)
          render()
        }
        return
      }
      if (ev.kind === "key" && ev.name === "enter") {
        const ans = typed.trim().toLowerCase()
        if (ans === "t" || ans === "test") finish("test")
        else if (ans === "b" || ans === "back") finish("back")
        else if (ans === "y" || ans === "yes" || ans === "save") finish("save")
        else finish("cancel")
      }
    }
    const cleanup = raw.beginCapture(onKey, () => render())
    render()
  })
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

/**
 * `/status` body. Connection verification is reported from the persisted config so a test run
 * earlier in the session (or a previous session) is still visible afterwards (TUI-09), and
 * chat reachability is listed apart from tool support.
 */
export function renderStatusReport(input: {
  readonly session: SessionRecord
  readonly workspace: string
  readonly trusted: boolean
  readonly permissionMode: PermissionMode
  readonly savedRules: number
  readonly config?: StandaloneConfig
}): string[] {
  const { session, config } = input
  const lines: string[] = ["--- Status ---"]
  lines.push(`Session   ${session.title} (${session.id})`)
  lines.push(`Turns     ${session.turns.length} (${session.messages.length} context messages)`)
  lines.push(`Workspace ${input.workspace} (${input.trusted ? "trusted" : "read-only"})`)
  lines.push(`Mode      ${input.permissionMode} (${input.savedRules} saved Always-allow rule(s))`)
  lines.push(
    `Model     ${config ? `${config.model} at ${formatDestination(config.baseURL)}` : "none"}`,
  )
  if (config) {
    const status = config.connectionStatus ?? "unverified"
    const at = config.lastVerifiedAt ?? config.lastTest?.at
    lines.push(
      `Connection ${status}${at === undefined ? " (never tested — run /test)" : ` (last test ${at})`}`,
    )
    if (config.lastTest) {
      const latency =
        config.lastTest.latencyMs === undefined ? "" : ` (${config.lastTest.latencyMs} ms)`
      lines.push(
        `Chat      ${config.lastTest.chatReachable ? `reachable${latency}` : "unreachable"}`,
      )
      lines.push(`Tools     ${config.lastTest.toolSupport}`)
    } else {
      lines.push("Chat      untested")
      lines.push("Tools     untested")
    }
  }
  lines.push(
    `Usage     ${session.usageTotals.requests} reqs, ${session.usageTotals.totalTokens} tokens` +
      (session.usageTotals.costUsd !== undefined
        ? `, est. $${session.usageTotals.costUsd.toFixed(6)}`
        : ""),
  )
  return lines
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
  if (!(io instanceof RawTerminalIO)) {
    renderPlainCliHeader(io, workspace, trusted, config, session)
    return
  }

  const style = io.style
  const cols = terminalCols(io) - 1
  const name = `${style.accentBold("❯~")}  ${style.bold("bashwink")}`
  const badge = style.badge(` v${STANDALONE_VERSION} `)
  const title = visibleWidth(name) + visibleWidth(badge) + 2 <= cols ? `${name}  ${badge}` : name
  const displayPath = workspaceDisplayPath(io, workspace)
  const branch = session?.gitBranch ? cleanTerminalLine(session.gitBranch) : ""
  const avail = cols - visibleWidth(title) - 3
  const branchTag =
    branch && avail >= 12 ? style.violet(`⑂ ${truncatePlain(branch, Math.floor(avail / 2))}`) : ""
  const location =
    avail >= 8
      ? style.muted(
          truncatePathMiddle(
            cleanTerminalLine(displayPath),
            avail - (branchTag ? visibleWidth(branchTag) + 3 : 0),
          ),
        )
      : ""
  const right = [location, branchTag].filter(Boolean).join(style.rule(" · "))
  io.write(`${alignRight(title, right, cols)}\n${style.rule("─".repeat(cols))}\n`)
}

function workspaceDisplayPath(io: RawTerminalIO, workspace: string): string {
  const home = io.homeDirectory
  return workspace === home
    ? "~"
    : home && workspace.startsWith(home + path.sep)
      ? `~${workspace.slice(home.length)}`
      : workspace
}

function renderPlainCliHeader(
  io: TerminalIO,
  workspace: string,
  trusted: boolean,
  config?: StandaloneConfig,
  session?: SessionRecord,
): void {
  const style = createStyle(false)
  const layout = getTerminalLayout(terminalCols(io), terminalRows(io))
  const modelLine = config
    ? `${config.providerId ? `${config.providerId} / ` : ""}${config.model} (${formatDestination(config.baseURL)})`
    : "none configured"
  const trustLine = trusted
    ? style.green(layout.isCompact ? "trusted" : "trusted (approvals follow the mode)")
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

function cleanTerminalLine(text: string): string {
  return sanitizeTerminalText(text).replace(/[\n\t]/g, " ")
}

function renderAssistantReply(io: RawTerminalIO, text: string): void {
  const style = io.style
  const rail = style.accent("┃")
  const width = terminalCols(io) - 3
  const markdown = sanitizeTerminalText(text.trim()).replace(/\t/g, "    ")
  const lines = renderOpenCodeMarkdown(markdown, width, style)
  io.write(`\n${rail}  ${style.accentBold("bashwink")}\n`)
  for (const line of lines.flatMap((line) => wrapStyledLine(line, width))) {
    io.write(`${rail}${line}\n`)
  }
}

function renderEditPreview(
  io: TerminalIO,
  patch: string,
  file: string,
  create?: boolean,
  approval = false,
): void {
  const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
  const cols = terminalCols(io) - 1
  const cleanPatch = sanitizeTerminalText(patch)
  const target = cleanTerminalLine(file)
  if (!(io instanceof RawTerminalIO)) {
    io.write(
      `\n${renderOpenCodeDiff(cleanPatch, { path: target, create, maxWidth: cols, view: "auto" }, style).join("\n")}\n`,
    )
    return
  }
  const counts = countDiffChanges(cleanPatch)
  const delta = `(${style.green(`+${counts.additions}`)} ${style.red(`-${counts.deletions}`)})`
  const row = renderActivityRow(create ? "Add" : "Edit", target, delta, cols, style)
  io.write(`${row}\n`)
  if (approval && !stripAnsiSequences(row).includes(target)) {
    for (const part of wrapPlainText(target, cols - 5)) io.write(`     ${style.muted(part)}\n`)
  }
  const changed = counts.additions + counts.deletions
  if (!approval && changed >= 4 && cols >= 48) {
    const clipped = /^\.\.\. \(/m.test(cleanPatch)
    const detail = style.muted(
      `${changed} ${clipped ? "changed lines shown" : "lines changed"} · /diff`,
    )
    const width = cols - ACTIVITY_CARD_INSET
    const fileLabel = `▫ ${truncatePathMiddle(target, width - visibleWidth(detail) - 3)}`
    const cardRow = alignRight(fileLabel, detail, width)
    io.write(`${renderActivityCard([cardRow], cols, style).join("\n")}\n`)
    return
  }
  io.write(`${renderTranscriptDiff(cleanPatch, cols, style).join("\n")}\n`)
}

function renderRunActivity(io: RawTerminalIO, run: ToolDispatchResult): void {
  const style = io.style
  const cols = terminalCols(io) - 1
  const elapsed =
    run.durationMs === undefined ? "" : style.muted(`(${(run.durationMs / 1000).toFixed(1)}s)  `)
  let status: string
  if (run.status === "denied") status = style.yellow("declined")
  else if (run.timedOut) status = style.red("timed out")
  else if (run.signal) status = style.red(`signal ${cleanTerminalLine(run.signal)}`)
  else if (run.exitCode == null) status = style.red("failed")
  else status = (run.status === "ok" ? style.green : style.red)(`exit ${run.exitCode}`)

  const row = renderActivityRow(
    "Run",
    cleanTerminalLine(run.target ?? "command"),
    elapsed + status,
    cols,
    style,
  )
  io.write(`${row}\n`)
  const text = sanitizeTerminalText(run.output)
  const results =
    run.exitCode != null && !run.signal && !run.timedOut && !run.outputTruncated
      ? renderTapResults(text, cols, style)
      : undefined
  if (results) {
    io.write(`${results.join("\n")}\n`)
    return
  }
  const output = text
    .split("\n")
    .filter((line, index) => line.trim() && !(index === 0 && line.startsWith("exitCode:")))
  for (const line of output.slice(0, 6)) {
    io.write(`     ${style.muted(truncatePlain(cleanTerminalLine(line), cols - 5))}\n`)
  }
  if (output.length > 6) {
    io.write(`     ${style.muted(`… (${output.length - 6} more lines)`)}\n`)
  }
}

/**
 * Normalizes a connection-test result into persisted config fields. Chat reachability and
 * tool support stay separate observations: a model can answer chat prompts and still fail
 * the tool-call probe, and the config must say so rather than claiming "verified".
 */
export function applyConnectionTestResult(
  res: TestConnectionResult,
  at: string = new Date().toISOString(),
): {
  readonly connectionStatus: "unverified" | "verified" | "failed"
  readonly lastVerifiedAt?: string
  readonly lastTest: ConnectionTestSummary
} {
  const toolSupport: ConnectionTestSummary["toolSupport"] =
    res.toolSupport === "supported"
      ? "supported"
      : res.toolSupport === undefined || res.toolSupport === "untested"
        ? "untested"
        : "unsupported"
  const connectionStatus: "unverified" | "verified" | "failed" = !res.ok
    ? "failed"
    : toolSupport === "supported"
      ? "verified"
      : "unverified"
  return {
    connectionStatus,
    ...(connectionStatus === "verified" ? { lastVerifiedAt: at } : {}),
    lastTest: {
      at,
      ok: res.ok,
      chatReachable: res.ok,
      toolSupport,
      ...(res.latencyMs === undefined ? {} : { latencyMs: res.latencyMs }),
    },
  }
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
  opts: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal } = {},
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

  const signal = opts.signal
  const cancelled = { status: "cancelled" as const }

  /** One editable field. Esc / "back" steps back one field, Ctrl+C cancels the wizard. */
  const promptField = async (
    promptText: string,
    fieldOpts: {
      readonly secret?: boolean
      readonly allowBack?: boolean
    } = {},
  ): Promise<PromptOutcome> => {
    if (io instanceof RawTerminalIO) {
      return await io.askLineOutcome(promptText, {
        ...(fieldOpts.secret ? { secret: true } : {}),
        ...(fieldOpts.allowBack ? { backOnEscape: true } : {}),
        ...(signal ? { signal } : {}),
      })
    }
    const answer = fieldOpts.secret
      ? await (io.askSecret?.(promptText, signal) ?? io.ask(promptText, signal))
      : await io.ask(promptText, signal)
    if (answer === null) return { kind: "cancel" }
    const clean = answer.trim().toLowerCase()
    if (clean === "cancel" || clean === "q" || clean === "quit") return { kind: "cancel" }
    if (fieldOpts.allowBack && clean === "back") return { kind: "back" }
    return { kind: "value", value: answer }
  }

  type SetupStep =
    "provider" | "endpoint" | "auth" | "auth-env" | "auth-file" | "auth-key" | "model" | "review"

  let preset: ProviderPreset | undefined
  let endpointType: "local" | "hosted" = "local"
  let baseURL: string | undefined
  let credential: CredentialConfig | undefined
  let pendingSecret: string | undefined
  let model: string | undefined
  let detectedModels: string[] = []
  let discoveryRequests = 0
  let connectionStatus: StandaloneConfig["connectionStatus"] = "unverified"
  let lastVerifiedAt: string | undefined
  let lastTest: ConnectionTestSummary | undefined
  let step: SetupStep = "provider"

  const runSampleTest = async (): Promise<void> => {
    if (!preset || !baseURL || !model || !credential) return
    const testModel = model
    const testBaseURL = baseURL
    const draft: StandaloneConfig = {
      version: 1,
      providerId: preset.id,
      endpointType,
      ...(preset.wireProtocol && preset.wireProtocol !== "openai-chat"
        ? { wireProtocol: preset.wireProtocol }
        : {}),
      baseURL: testBaseURL,
      model: testModel,
      credential,
      ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
      updatedAt: new Date().toISOString(),
    }
    const testOpts = {
      config: draft,
      env,
      ...(pendingSecret !== undefined ? { apiKeyOverride: pendingSecret } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    }
    const startedAt = new Date().toISOString()
    let testRes: TestConnectionResult | undefined
    const paintProgress = (stage: string) => {
      if (!(io instanceof RawTerminalIO)) io.write(`  ${stage}\n`)
    }
    if (io instanceof RawTerminalIO) {
      const activity = await runCancellableActivity(
        io.raw,
        io.style,
        `Testing ${testModel} at ${formatDestination(testBaseURL)}`,
        async (controller, setLabel) => {
          setLabel(`Testing ${testModel} at ${formatDestination(testBaseURL)}`)
          return await testProviderConnection({
            ...testOpts,
            signal: controller.signal,
            onProgress: (stage: string) => {
              setLabel(stage === "tool_probe" ? "Verifying tool-call capability…" : stage)
            },
          })
        },
        signal,
      )
      if (activity.status === "cancelled") {
        io.write("  Sample test cancelled; nothing saved. Back to review.\n")
        return
      }
      testRes = activity.value as TestConnectionResult | undefined
    } else {
      testRes = await testProviderConnection({
        ...testOpts,
        ...(signal === undefined ? {} : { signal }),
        onProgress: paintProgress,
      })
    }
    if (!testRes) return
    if (testRes.cancelled) {
      io.write("  Sample test cancelled; nothing saved. Back to review.\n")
      return
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
    lastTest = {
      at: startedAt,
      ok: testRes.ok,
      chatReachable: testRes.ok,
      toolSupport:
        testRes.toolSupport === "supported"
          ? "supported"
          : testRes.toolSupport === "untested"
            ? "untested"
            : "unsupported",
      ...(testRes.latencyMs === undefined ? {} : { latencyMs: testRes.latencyMs }),
    }
    printConnectionTestResult(io, testRes, testModel)
  }

  while (true) {
    if (signal?.aborted) return cancelled

    if (step === "provider") {
      const rangeHint = `1-${PROVIDER_CATALOG.length}`
      let choice: string | null
      if (io instanceof RawTerminalIO) {
        io.write("\nProviders (Hosted HTTPS & Local loopback):\n")
        const providerOpts: HybridChoiceOption[] = PROVIDER_CATALOG.map((p) => ({
          value: String(p.index),
          display: `${String(p.index).padStart(2, " ")}) ${p.name.padEnd(25, " ")} ${p.endpointType === "hosted" ? "HTTPS" : "local"}  ${p.defaultBaseURL ?? p.note}`,
        }))
        choice = await io.askChoice(
          `Select provider [${rangeHint} or id] (or 'cancel'): `,
          providerOpts,
          { inputHint: "type to filter · ↑/↓ select" },
        )
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
        choice = await io.ask(`Select provider [${rangeHint} or id] (or 'cancel'): `, signal)
      }
      if (choice === null) return cancelled
      const t = choice.trim().toLowerCase()
      if (t === "cancel" || t === "q" || t === "quit") return cancelled
      const matched = findProviderPreset(t)
      if (!matched) {
        io.write(
          `  Please enter a number ${rangeHint}, a provider id/alias (e.g. openai, anthropic, nvidia, ollama), or 'cancel'.\n`,
        )
        continue
      }
      preset = matched
      endpointType = matched.endpointType
      baseURL = undefined
      credential = undefined
      pendingSecret = undefined
      model = undefined
      detectedModels = []
      step = "endpoint"
      continue
    }

    if (step === "endpoint" && preset) {
      const promptText = preset.defaultBaseURL
        ? `Endpoint URL [Enter for ${preset.defaultBaseURL}]: `
        : endpointType === "local"
          ? "Endpoint URL (e.g. http://127.0.0.1:8080/v1): "
          : "Endpoint URL (https://...): "
      const res = await promptField(promptText, { allowBack: true })
      if (res.kind === "cancel") return cancelled
      if (res.kind === "back") {
        step = "provider"
        continue
      }
      const trimmed = res.value.trim()
      const effectiveRaw = trimmed === "" && preset.defaultBaseURL ? preset.defaultBaseURL : trimmed
      try {
        baseURL = normalizeBaseURL(effectiveRaw, endpointType)
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
        continue
      }
      step = "auth"
      continue
    }

    if (step === "auth" && preset && baseURL) {
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
      if (canKeepExisting && existingCredCheck) {
        io.write(`\nCurrent credentials: ${existingCredCheck.summary}\n`)
      }
      const envHint = preset.defaultEnvVar
        ? preset.alternateEnvVars && preset.alternateEnvVars.length > 0
          ? ` (e.g. ${preset.defaultEnvVar}; alt: ${preset.alternateEnvVars.join(", ")})`
          : ` (e.g. ${preset.defaultEnvVar})`
        : ""
      const envLabel = `1) Environment variable name${envHint}`
      const pasteLabel = `4) Enter / paste API key (saved 0600 locally)`
      const noneLabel =
        preset.endpointType === "hosted"
          ? "3) None (no credential — hosted endpoints reject this)"
          : "3) None (no key needed)"
      const authOpts: HybridChoiceOption[] = [
        ...(canKeepExisting ? [{ value: "k", display: "k) Keep existing credentials" }] : []),
        { value: "1", display: envLabel },
        { value: "2", display: "2) Key file path" },
        { value: "3", display: noneLabel },
        { value: "4", display: pasteLabel },
      ]
      // Local presets that need no key start on "None" so Enter accepts the natural default (TUI-07).
      const preferred = canKeepExisting ? "k" : preset.defaultCredentialKind === "none" ? "3" : "1"
      let mode: string | null
      if (io instanceof RawTerminalIO) {
        io.write("\nAuthentication:\n")
        mode = await io.askChoice(`Choose [1/2/3/4] (or 'cancel'): `, authOpts, {
          initialValue: preferred,
          inputHint: "1 env · 2 file · 3 none · 4 paste key",
        })
      } else {
        io.write("\nAuthentication:\n")
        if (canKeepExisting) io.write("  k) Keep existing credentials\n")
        io.write(`  ${envLabel}\n`)
        io.write("  2) Key file path\n")
        io.write(`  ${noneLabel}\n`)
        io.write(`  ${pasteLabel}\n`)
        mode = await io.ask("Choose [1/2/3/4] (or 'cancel'): ", signal)
      }
      if (mode === null) return cancelled
      // An empty answer accepts the natural default (no-key for local presets), matching the
      // arrow-key widget where Enter selects the highlighted row (TUI-07).
      const m = mode.trim().toLowerCase() === "" ? preferred : mode.trim().toLowerCase()
      if (m === "cancel") return cancelled
      if (m === "b" || m === "back") {
        step = "endpoint"
        continue
      }
      if ((m === "k" || m === "keep" || m === "") && canKeepExisting && existing) {
        credential = existing.credential
        step = "model"
        continue
      }
      if (m === "1" || m === "env") {
        step = "auth-env"
        continue
      }
      if (m === "2" || m === "file") {
        step = "auth-file"
        continue
      }
      if (m === "3" || m === "none") {
        if (preset.endpointType === "hosted") {
          // A hosted endpoint with no credential is a guaranteed 401 at the first request; the
          // repair loop then re-enters this same wizard. Ask before saving such a config.
          const proceed = await askYesNo(
            io,
            `${preset.name} is a hosted endpoint and will reject unauthenticated requests (401). Save it with no credential anyway? [y/N] `,
            signal,
          )
          if (proceed === null) return cancelled
          if (!isYes(proceed)) continue
        }
        credential = { kind: "none" }
        step = "model"
        continue
      }
      if (m === "4" || m === "key" || m === "paste") {
        step = "auth-key"
        continue
      }
      io.write("  Please enter 1, 2, 3, or 4.\n")
      continue
    }

    if (step === "auth-env" && preset) {
      const envPrompt = preset.defaultEnvVar
        ? `Environment variable name [Enter for ${preset.defaultEnvVar}]: `
        : "Environment variable name (e.g. MY_API_KEY): "
      const res = await promptField(envPrompt, { allowBack: true })
      if (res.kind === "cancel") return cancelled
      if (res.kind === "back") {
        step = "auth"
        continue
      }
      const effectiveVar =
        res.value.trim() === "" && preset.defaultEnvVar ? preset.defaultEnvVar : res.value
      try {
        credential = { kind: "env", variable: validateEnvVarName(effectiveVar) }
        step = "model"
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
      continue
    }

    if (step === "auth-file") {
      const res = await promptField("Key file path: ", { allowBack: true })
      if (res.kind === "cancel") return cancelled
      if (res.kind === "back") {
        step = "auth"
        continue
      }
      try {
        credential = { kind: "file", path: validateKeyFilePath(res.value) }
        step = "model"
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
      continue
    }

    if (step === "auth-key" && preset) {
      const res = await promptField(`Paste ${preset.name} API key (masked; Enter to go back): `, {
        secret: true,
        allowBack: true,
      })
      if (res.kind === "cancel") return cancelled
      if (res.kind === "back") {
        step = "auth"
        continue
      }
      const secretTrimmed = res.value.trim()
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
      step = "model"
      continue
    }

    if (step === "model" && preset) {
      const suggested = preset.defaultModels.filter((m) => !detectedModels.includes(m))
      const entries: Array<{ readonly id: string; readonly tag: "detected" | "suggested" }> = [
        ...detectedModels.map((id) => ({ id, tag: "detected" as const })),
        ...suggested.map((id) => ({ id, tag: "suggested" as const })),
      ]
      const modelChoices: HybridChoiceOption[] = [
        ...entries.map((entry, idx) => ({
          value: entry.id,
          display: `${idx + 1}) ${entry.id}  · ${entry.tag}`,
        })),
        { value: "f", display: `f) Fetch live models from ${baseURL}/models (sends 1 request)` },
        { value: "m", display: "m) Enter a model ID manually" },
      ]
      const modelPrompt =
        entries.length > 0
          ? `Model ID, number, or 'f' [Enter for ${entries[0]!.id}]: `
          : "Model ID or 'f' to fetch /models: "
      let rawModel: string | null
      if (io instanceof RawTerminalIO) {
        const detectedCount = detectedModels.length
        const header =
          detectedCount > 0
            ? `${preset.name} models — ${detectedCount} detected, ${suggested.length} suggested (not yet verified):`
            : `${preset.name} models — ${suggested.length} suggested by the catalog (not detected):`
        io.write(`\n${header}\n`)
        rawModel = await io.askChoice(modelPrompt, modelChoices, {
          inputHint: "type an id to filter · ↑/↓ select",
        })
      } else {
        if (entries.length > 0) {
          io.write(`\nSuggested ${preset.name} models:\n`)
          entries.forEach((entry, idx) => {
            io.write(`  ${idx + 1}) ${entry.id}  · ${entry.tag}\n`)
          })
        }
        io.write(`  f) Fetch live models from ${baseURL}/models\n`)
        io.write("  m) Enter a model ID manually\n")
        const askPrompt =
          entries.length > 0
            ? `Model ID, number, or 'f' [Enter for ${entries[0]!.id}]: `
            : "Model ID (for example gpt-4o-mini or qwen-coder, or 'f' to fetch): "
        rawModel = await io.ask(askPrompt, signal)
      }
      if (rawModel === null) return cancelled
      const trimmed = rawModel.trim()
      const lower = trimmed.toLowerCase()
      if (lower === "cancel") return cancelled
      if (lower === "b" || lower === "back") {
        step = "auth"
        continue
      }
      if (lower === "m" || lower === "manual") {
        const manual = await promptField("Model ID (manual entry): ", { allowBack: true })
        if (manual.kind === "cancel") return cancelled
        if (manual.kind === "back") continue
        try {
          model = validateModelID(manual.value.trim())
          step = "review"
        } catch (err) {
          io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
        }
        continue
      }
      if (lower === "f" || lower === "fetch") {
        const probeBase = baseURL
        if (!probeBase || !credential) continue
        const probeArgs = {
          baseURL: probeBase,
          credential,
          ...(preset.wireProtocol ? { wireProtocol: preset.wireProtocol } : {}),
          ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
          env,
          ...(pendingSecret !== undefined ? { apiKeyOverride: pendingSecret } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        }
        let probe: ProbeModelsResult | undefined
        if (io instanceof RawTerminalIO) {
          const activity = await runCancellableActivity(
            io.raw,
            io.style,
            `Discovering models at ${formatDestination(probeBase)}`,
            async (controller, setLabel) => {
              setLabel(`GET ${probeBase}/models`)
              return await probeModels({ ...probeArgs, signal: controller.signal })
            },
            signal,
          )
          if (activity.status === "cancelled") {
            io.write("  Model discovery cancelled; the model list is unchanged.\n")
            continue
          }
          probe = activity.value as ProbeModelsResult | undefined
        } else {
          io.write(`  Probing ${probeBase} /models (Ctrl+C to cancel)...\n`)
          probe = await probeModels({
            ...probeArgs,
            ...(signal === undefined ? {} : { signal }),
          })
        }
        if (!probe) continue
        const sent = probe.usedFallback ? 2 : 1
        discoveryRequests += sent
        if (probe.cancelled) {
          io.write("  Model discovery cancelled; the model list is unchanged.\n")
          continue
        }
        if (probe.ok && probe.models.length > 0) {
          if (probe.usedFallback && probe.resolvedBaseURL) {
            io.write(
              `  Note: /models responded at ${probe.resolvedBaseURL}; updating endpoint URL.\n`,
            )
            baseURL = normalizeBaseURL(probe.resolvedBaseURL, endpointType)
          }
          detectedModels = [...probe.models]
          io.write(
            `  ✓ Found ${probe.models.length} live model(s) from ${probe.probedURL} (${sent} GET /models request sent).\n`,
          )
        } else {
          io.write(
            `  ! Discovery sent ${sent} GET /models request(s) to ${probe.probedURL} and failed: ${probe.error ?? "no models listed"}. Enter a model ID directly.\n`,
          )
        }
        continue
      }
      let candidate = trimmed
      if (candidate === "" && entries.length > 0) {
        candidate = entries[0]!.id
      } else if (/^\d+$/.test(candidate) && entries.length > 0) {
        const idx = Number(candidate) - 1
        if (idx >= 0 && idx < entries.length) candidate = entries[idx]!.id
      }
      try {
        model = validateModelID(candidate)
        step = "review"
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
      }
      continue
    }

    if (step === "review" && preset && baseURL && model && credential) {
      const credCheck =
        pendingSecret !== undefined
          ? {
              ok: true,
              summary: `paste -> ${credential.kind === "file" ? credential.path : ""} (${pendingSecret.length} chars, saved 0600 on save)`,
              warning: undefined,
            }
          : resolveCredentialSecret(credential, env)
      const compact = terminalRows(io) <= 14 || terminalCols(io) < 60
      const reviewLines: string[] = compact
        ? [
            `  Provider  ${preset.name}`,
            `  Endpoint  ${truncatePlain(baseURL, Math.max(10, terminalCols(io) - 12))}`,
            `  Model     ${model}`,
            `  Status    ${connectionStatus}${lastTest?.ok ? " (chat reachable)" : ""}`,
          ]
        : [
            "  Provider    " + preset.name + ` (${preset.id})`,
            `  Type        ${endpointType}`,
            ...(preset.wireProtocol && preset.wireProtocol !== "openai-chat"
              ? [`  Protocol    ${preset.wireProtocol}`]
              : []),
            `  Endpoint    ${baseURL}`,
            `  Model       ${model}`,
            `  Credentials ${credCheck.summary}`,
            `  Status      ${connectionStatus}`,
            ...(lastTest
              ? [
                  `  Last test   ${lastTest.ok ? "chat reachable" : "failed"} · tools ${lastTest.toolSupport} · ${lastTest.at}`,
                ]
              : []),
          ]
      io.write("\nReview connection:\n")
      for (const line of reviewLines) io.write(`${line}\n`)
      io.write(
        `  Requests    ${discoveryRequests === 0 ? "0 discovery requests sent (nothing is sent until you test or save)" : `${discoveryRequests} discovery request(s) sent for GET /models`}\n`,
      )
      if (credCheck.warning) io.write(`  Warning     ${credCheck.warning}\n`)

      let action: "save" | "test" | "back" | "cancel"
      if (io instanceof RawTerminalIO) {
        action = await askReviewAction(io.raw, io.style, {
          prompt: "Save and use this model? [y/N]",
          backAvailable: true,
        })
      } else {
        const confirm = await io.ask(
          "Save and use this model? [y/N] (or 't' to run sample test): ",
          signal,
        )
        if (confirm === null) return cancelled
        const ans = confirm.trim().toLowerCase()
        if (ans === "t" || ans === "test") action = "test"
        else if (ans === "b" || ans === "back") action = "back"
        else if (isYes(confirm)) action = "save"
        else action = "cancel"
      }
      if (action === "cancel") {
        io.write("Setup cancelled; profile unchanged.\n")
        return cancelled
      }
      if (action === "back") {
        step = "model"
        continue
      }
      if (action === "test") {
        await runSampleTest()
        continue
      }
      break
    }

    // A step that lost its prerequisites (e.g. a state reset) falls back to the provider list.
    step = "provider"
  }

  if (!preset || !baseURL || !model || !credential) return cancelled

  let finalCredential = credential
  if (pendingSecret !== undefined) {
    const savedKeyPath = saveProviderKeyFile(configDirectory, preset.id, pendingSecret)
    finalCredential = { kind: "file", path: savedKeyPath }
  }
  const config: StandaloneConfig = {
    version: 1,
    providerId: preset.id,
    endpointType,
    ...(preset.wireProtocol && preset.wireProtocol !== "openai-chat"
      ? { wireProtocol: preset.wireProtocol }
      : {}),
    baseURL,
    model,
    credential: finalCredential,
    ...(preset.defaultHeaders ? { headers: preset.defaultHeaders } : {}),
    connectionStatus,
    ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
    ...(lastTest === undefined ? {} : { lastTest }),
    updatedAt: new Date().toISOString(),
  }
  saveStandaloneConfig(configDirectory, config)
  io.write(
    `Saved model configuration to ${standaloneConfigFile(configDirectory)} (status: ${connectionStatus}).\n`,
  )
  return { status: "saved", config }
}

export type ModelPickerResult =
  | { readonly status: "saved"; readonly config: StandaloneConfig }
  | { readonly status: "cancelled" }
  | { readonly status: "switch" }

/**
 * `/model` switches the model for the provider that is already configured. Endpoint,
 * credentials and headers are preserved, so changing only the model no longer restarts
 * provider setup (TUI-05). Full provider setup stays behind `/setup` and `/connect`.
 */
export async function runModelPicker(
  io: TerminalIO,
  configDirectory: string,
  env: NodeJS.ProcessEnv,
  existing: StandaloneConfig,
  opts: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<ModelPickerResult> {
  const signal = opts.signal
  const preset = existing.providerId ? findProviderPreset(existing.providerId) : undefined
  const curated = preset ? [...preset.defaultModels] : []
  let detected: string[] = []
  let discoveryRequests = 0
  io.write(`\nModel for ${preset ? `${preset.name} (${preset.id})` : "the active provider"}\n`)
  io.write(`  Endpoint ${formatDestination(existing.baseURL)} (kept unchanged)\n`)
  io.write(`  Current  ${existing.model}\n`)

  const save = (model: string): ModelPickerResult => {
    // A different model invalidates the previous verification; chat/tool status must be
    // re-probed, so the old test summary is dropped rather than carried over.
    const cleaned: StandaloneConfig = {
      version: existing.version,
      ...(existing.providerId === undefined ? {} : { providerId: existing.providerId }),
      endpointType: existing.endpointType,
      ...(existing.wireProtocol === undefined ? {} : { wireProtocol: existing.wireProtocol }),
      baseURL: existing.baseURL,
      model: validateModelID(model),
      credential: existing.credential,
      ...(existing.headers === undefined ? {} : { headers: existing.headers }),
      ...(existing.price === undefined ? {} : { price: existing.price }),
      connectionStatus: "unverified",
      updatedAt: new Date().toISOString(),
    }
    saveStandaloneConfig(configDirectory, cleaned)
    io.write(
      `Model set to ${cleaned.model} (endpoint and credentials unchanged; run /test to verify).\n`,
    )
    return { status: "saved", config: cleaned }
  }

  while (true) {
    if (signal?.aborted) return { status: "cancelled" }
    const entries: Array<{
      readonly id: string
      readonly tag: "current" | "detected" | "suggested"
    }> = []
    if (!entries.some((e) => e.id === existing.model))
      entries.push({ id: existing.model, tag: "current" })
    for (const id of detected) {
      if (!entries.some((e) => e.id === id)) entries.push({ id, tag: "detected" })
    }
    for (const id of curated) {
      if (!entries.some((e) => e.id === id)) entries.push({ id, tag: "suggested" })
    }
    const options: HybridChoiceOption[] = [
      ...entries.map((entry, idx) => ({
        value: entry.id,
        display: `${idx + 1}) ${entry.id}  · ${entry.tag}`,
      })),
      { value: "f", display: `f) Fetch models from the provider (1 GET request)` },
      { value: "m", display: "m) Enter a model ID manually" },
      { value: "s", display: "s) Switch provider (opens /setup)" },
    ]
    let answer: string | null
    if (io instanceof RawTerminalIO) {
      io.write(
        `Models — ${detected.length} detected, ${curated.filter((m) => !detected.includes(m)).length} suggested\n`,
      )
      answer = await io.askChoice("Select model [number, id, or 'f']: ", options, {
        selectHighlighted: false,
        inputHint: "type to filter · esc cancels",
      })
    } else {
      entries.forEach((entry, idx) => io.write(`  ${idx + 1}) ${entry.id}  · ${entry.tag}\n`))
      io.write("  f) Fetch models from the provider\n")
      io.write("  m) Enter a model ID manually\n")
      io.write("  s) Switch provider (opens /setup)\n")
      answer = await io.ask("Select model [number, id, or 'f'] (or 'cancel'): ", signal)
    }
    if (answer === null) return { status: "cancelled" }
    const clean = answer.trim()
    const lower = clean.toLowerCase()
    if (clean === "") return { status: "cancelled" }
    if (lower === "cancel" || lower === "c" || lower === "q") return { status: "cancelled" }
    if (lower === "s" || lower === "switch") return { status: "switch" }
    if (lower === "m" || lower === "manual") {
      const res =
        io instanceof RawTerminalIO
          ? await io.askLineOutcome("Model ID: ", signal === undefined ? {} : { signal })
          : await (async (): Promise<PromptOutcome> => {
              const value = await io.ask("Model ID: ", signal)
              return value === null ? { kind: "cancel" } : { kind: "value", value }
            })()
      if (res.kind !== "value") return { status: "cancelled" }
      try {
        return save(res.value.trim())
      } catch (err) {
        io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
        continue
      }
    }
    if (lower === "f" || lower === "fetch") {
      const probeArgs = {
        baseURL: existing.baseURL,
        credential: existing.credential,
        ...(existing.wireProtocol ? { wireProtocol: existing.wireProtocol } : {}),
        ...(existing.headers ? { headers: existing.headers } : {}),
        env,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }
      let probe: ProbeModelsResult | undefined
      if (io instanceof RawTerminalIO) {
        const activity = await runCancellableActivity(
          io.raw,
          io.style,
          `Discovering models at ${formatDestination(existing.baseURL)}`,
          async (controller, setLabel) => {
            setLabel(`GET ${existing.baseURL}/models`)
            return await probeModels({ ...probeArgs, signal: controller.signal })
          },
          signal,
        )
        if (activity.status === "cancelled") {
          io.write("  Model discovery cancelled; model unchanged.\n")
          continue
        }
        probe = activity.value as ProbeModelsResult | undefined
      } else {
        io.write(`  Probing ${existing.baseURL} /models...\n`)
        probe = await probeModels({ ...probeArgs, ...(signal === undefined ? {} : { signal }) })
      }
      if (!probe) continue
      const sent = probe.usedFallback ? 2 : 1
      discoveryRequests += sent
      if (probe.cancelled) {
        io.write("  Model discovery cancelled; model unchanged.\n")
        continue
      }
      if (probe.ok && probe.models.length > 0) {
        detected = [...probe.models]
        io.write(
          `  ✓ Found ${probe.models.length} live model(s) from ${probe.probedURL} (${sent} GET /models request sent).\n`,
        )
      } else {
        io.write(
          `  ! Discovery sent ${sent} GET /models request(s) to ${probe.probedURL} and failed: ${probe.error ?? "no models listed"}.\n`,
        )
      }
      continue
    }
    let candidate = clean
    if (/^\d+$/.test(candidate)) {
      const idx = Number(candidate) - 1
      if (idx >= 0 && idx < entries.length) candidate = entries[idx]!.id
    }
    try {
      return save(candidate)
    } catch (err) {
      io.writeError(`  ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
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
    if (io instanceof RawTerminalIO) renderAssistantReply(io, cleanMd)
    else io.write(`\n${renderOpenCodeMarkdown(cleanMd, cols, style).join("\n")}\n`)
  }
  if (io instanceof RawTerminalIO) io.write("\n")
  else io.write(`\n  ${style.dim("─".repeat(Math.min(Math.max(20, cols - 4), 72)))}\n`)
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
      return `${cleanTerminalLine(d.path)} (${style.green(`+${c.additions}`)} ${style.red(`-${c.deletions}`)})`
    })
    io.write(`  Changed   ${fileSummaries.join(", ")}\n`)
  } else {
    io.write(
      `  Changed   ${result.changedFiles.length > 0 ? result.changedFiles.join(", ") : "none"}\n`,
    )
  }
  if (result.changedTests.length > 0) {
    io.write(
      `  ${style.yellow("Tests")}     modified test files: ${result.changedTests.map(cleanTerminalLine).join(", ")} (verify independently)\n`,
    )
  }
  if (io instanceof RawTerminalIO) {
    const proof = result.proofPack
    if (proof) {
      const count = `${proof.evidenceEntries} event${proof.evidenceEntries === 1 ? "" : "s"} recorded`
      const evidence = proof.evidenceChainOk
        ? style.green(`✓ ${count} · hash chain verified`)
        : style.red(`✗ ${count} · hash chain verification failed`)
      io.write(`  ${evidence}\n`)
    }
    // An interrupted evidence write can leave a recorded command without a live completion row.
    if (result.outcome !== "uncertain") return
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
    let draftCursor = 0
    const sessionStatus = new Map<
      string,
      Pick<SessionStatus, "requests" | "requestLimit" | "context"> & { config: StandaloneConfig }
    >()

    let welcomeSessionId: string | undefined
    const requestLimit =
      parsedRunOpts.cliBudgets.maxRequests ??
      (env["BASHWINK_MAX_REQUESTS"] === "unlimited" ? undefined : DEFAULT_TASK_BUDGETS.maxRequests)

    const renderSessionEntry = (resetScreen = false) => {
      if (resetScreen && io instanceof RawTerminalIO) io.write("\x1b[2J\x1b[H")
      const trusted = isWorkspaceTrusted(resolved.config, canonical)
      renderCliHeader(io, canonical, trusted, activeConfig, activeSession)
      welcomeSessionId = undefined
      if (io instanceof RawTerminalIO && activeSession.turns.length === 0) {
        welcomeSessionId = activeSession.id
        const lines = renderWelcomeScreen(
          {
            workspace: cleanTerminalLine(workspaceDisplayPath(io, canonical)),
            model: activeConfig ? cleanTerminalLine(activeConfig.model) : undefined,
            trusted,
            mode: permissionMode,
          },
          terminalCols(io) - 1,
          terminalRows(io),
          io.style,
        )
        io.write(`${lines.join("\n")}\n`)
      }
    }

    let currentAbort: AbortController | undefined
    let interruptedAtPrompt = false
    let trustPromptShown = false
    // Setup, discovery and connection tests own their own cancel path. A SIGINT that arrives
    // while one is running must cancel that operation, not end the coding session (TUI-02).
    let interactiveOpDepth = 0
    const guardedSetup = async (
      configDir: string,
      existing?: StandaloneConfig,
    ): Promise<
      | { readonly status: "saved"; readonly config: StandaloneConfig }
      | { readonly status: "cancelled" }
    > => {
      interactiveOpDepth += 1
      try {
        return await runInteractiveSetup(io, configDir, env, existing)
      } finally {
        interactiveOpDepth -= 1
      }
    }
    const onSigint = () => {
      if (currentAbort) {
        io.write("\nCancelling current task...\n")
        currentAbort.abort()
      } else if (interactiveOpDepth > 0) {
        // The active wizard/field owns cancellation; keep the session alive.
        io.write("\n")
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
      renderSessionEntry()
      if (!activeConfig && !(io instanceof RawTerminalIO)) {
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
              renderSessionEntry(true)
              if (activeSession.turns.length > 0) renderResumedSessionContext(io, activeSession)
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
            renderSessionEntry(true)
            return
          }
          if (res.action === "select") {
            const loaded = loadSession(resolved.data, res.sessionId)
            const accepted = loaded ? await confirmCrossWorkspaceSession(loaded) : undefined
            if (accepted) {
              activeSession = accepted
              renderSessionEntry(true)
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
              renderSessionEntry(true)
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
          renderSessionEntry(true)
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
          sessionStatus.delete(activeSession.id)
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
          if (welcomeSessionId === activeSession.id) renderSessionEntry(true)
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
            if (welcomeSessionId === activeSession.id) renderSessionEntry(true)
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
              if (welcomeSessionId === activeSession.id) renderSessionEntry(true)
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
        if (cmdName === "model" || cmdName === "models") {
          if (!activeConfig) {
            const res = await guardedSetup(resolved.config)
            if (res.status === "saved") {
              activeConfig = res.config
              renderSessionEntry(welcomeSessionId === activeSession.id)
            }
            return "continue"
          }
          const picked = await runModelPicker(io, resolved.config, env, activeConfig)
          if (picked.status === "saved") {
            activeConfig = picked.config
            renderSessionEntry(welcomeSessionId === activeSession.id)
            return "continue"
          }
          if (picked.status !== "switch") return "continue"
          // "Switch provider" falls through to the full setup wizard below.
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
          const res = await guardedSetup(resolved.config, activeConfig)
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
            renderSessionEntry(welcomeSessionId === activeSession.id)
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
          if (!testRes.cancelled) {
            const outcome = applyConnectionTestResult(testRes)
            const next: StandaloneConfig = {
              version: activeConfig.version,
              ...(activeConfig.providerId === undefined
                ? {}
                : { providerId: activeConfig.providerId }),
              endpointType: activeConfig.endpointType,
              ...(activeConfig.wireProtocol === undefined
                ? {}
                : { wireProtocol: activeConfig.wireProtocol }),
              baseURL: activeConfig.baseURL,
              model: activeConfig.model,
              credential: activeConfig.credential,
              ...(activeConfig.headers === undefined ? {} : { headers: activeConfig.headers }),
              ...(activeConfig.price === undefined ? {} : { price: activeConfig.price }),
              connectionStatus: outcome.connectionStatus,
              ...(outcome.lastVerifiedAt === undefined
                ? {}
                : { lastVerifiedAt: outcome.lastVerifiedAt }),
              ...(outcome.lastTest === undefined ? {} : { lastTest: outcome.lastTest }),
              updatedAt: new Date().toISOString(),
            }
            saveStandaloneConfig(resolved.config, next)
            activeConfig = next
          }
          printConnectionTestResult(io, testRes, activeConfig.model)
          return "continue"
        }
        if (cmdName === "sessions" || cmdName === "resume" || cmdName === "continue") {
          await handleSessionBrowser()
          return "continue"
        }
        if (cmdName === "new") {
          activeSession = createSession(canonical, detectGitBranch(canonical))
          renderSessionEntry(true)
          return "continue"
        }
        if (cmdName === "clear") {
          activeSession = createSession(canonical, detectGitBranch(canonical))
          renderSessionEntry(true)
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
            sessionStatus.delete(activeSession.id)
            saveSession(resolved.data, activeSession)
            io.write(
              `Compacted ${compacted.summarizedTurns} earlier turn(s) (${compacted.beforeMessages} -> ${compacted.afterMessages} context messages).\n`,
            )
          }
          return "continue"
        }
        if (cmdName === "status") {
          io.write("\n")
          for (const line of renderStatusReport({
            session: activeSession,
            workspace: canonical,
            trusted: isWorkspaceTrusted(resolved.config, canonical),
            permissionMode,
            savedRules: savedRules.length,
            ...(activeConfig ? { config: activeConfig } : {}),
          })) {
            io.write(`${line}\n`)
          }
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

        /**
         * `/test` runs inside the composer, so it shows progress and a live cancel shortcut
         * and returns straight to editing. The result is persisted for `/status` (TUI-01,
         * TUI-09), keeping chat reachability separate from tool support.
         */
        const runChatConnectionTest = async (turn: ComposerTurnContext): Promise<void> => {
          const cfg = activeConfig
          if (!cfg) {
            turn.write("\nNo model configured yet. Run `/model` or `/connect` first.\n")
            return
          }
          turn.setActivity(`Testing ${cfg.model} at ${formatDestination(cfg.baseURL)}`)
          const testRes = await testProviderConnection({
            config: cfg,
            env,
            signal: turn.signal,
            onProgress: (stage: string) => {
              turn.setActivity(stage === "tool_probe" ? "Verifying tool-call capability…" : stage)
            },
          })
          if (testRes.cancelled) {
            turn.write("\n  Connection test cancelled; session kept, profile unchanged.\n")
            turn.setActivity(undefined)
            return
          }
          const outcome = applyConnectionTestResult(testRes)
          const next: StandaloneConfig = {
            version: cfg.version,
            ...(cfg.providerId === undefined ? {} : { providerId: cfg.providerId }),
            endpointType: cfg.endpointType,
            ...(cfg.wireProtocol === undefined ? {} : { wireProtocol: cfg.wireProtocol }),
            baseURL: cfg.baseURL,
            model: cfg.model,
            credential: cfg.credential,
            ...(cfg.headers === undefined ? {} : { headers: cfg.headers }),
            ...(cfg.price === undefined ? {} : { price: cfg.price }),
            connectionStatus: outcome.connectionStatus,
            ...(outcome.lastVerifiedAt === undefined
              ? {}
              : { lastVerifiedAt: outcome.lastVerifiedAt }),
            ...(outcome.lastTest === undefined ? {} : { lastTest: outcome.lastTest }),
            updatedAt: new Date().toISOString(),
          }
          saveStandaloneConfig(resolved.config, next)
          activeConfig = next
          printConnectionTestResult(io, testRes, cfg.model)
          io.write("  Result saved to the profile; `/status` reports it.\n")
          turn.setActivity(undefined)
        }

        /**
         * Runs one submitted prompt (or an in-place `/test`) with the composer still painted:
         * the prompt box, the activity row and cancellation all belong to the composer now.
         */
        const executeSubmittedText = async (
          text: string,
          turn: ComposerTurnContext,
        ): Promise<ComposerTurnOutcome | void> => {
          const trimmed = text.trim()
          const sink =
            io instanceof RawTerminalIO ? (chunk: string) => turn.write(chunk) : undefined
          if (io instanceof RawTerminalIO && sink) io.setWriteSink(sink)
          try {
            if (/^\/(test|ping|verify)$/i.test(trimmed)) {
              await runChatConnectionTest(turn)
              return
            }
            if (!activeConfig) {
              io.write("\nNo model configured yet — configure a model first.\n")
              turn.suspend()
              const res = await guardedSetup(resolved.config)
              turn.resume()
              if (res.status !== "saved") return { restoreDraft: text }
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
              turn.suspend()
              const trustAns = await askYesNo(
                io,
                "Trust this workspace for interactive edit/command approvals? [y/N] ",
              )
              turn.resume()
              if (trustAns === null) return
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
              turn.suspend()
              const repair = await askYesNo(
                io,
                "Open /model setup to repair provider credentials? [y/N] ",
              )
              if (isYes(repair)) {
                const res = await guardedSetup(resolved.config, activeConfig)
                if (res.status === "saved") activeConfig = res.config
              }
              turn.resume()
              return
            }

            promptHistory = appendPromptHistory(resolved.data, trimmed, cred.secret)
            currentAbort = new AbortController()
            const onTurnCancel = () => currentAbort?.abort()
            turn.signal.addEventListener("abort", onTurnCancel, { once: true })
            if (turn.signal.aborted) currentAbort.abort()
            const turnCheckpoints: FileCheckpoint[] = []
            const checkpointedPaths = new Set<string>()

            // The composer owns the activity row now: progress, elapsed time and the cancel
            // shortcut live inside the pinned block instead of a hand-rolled spinner line that
            // could overwrite the prompt (TUI-12, TUI-13).
            let spinnerText = ""
            let turnSuspended = false

            const clearSpinnerLine = () => {
              turn.setActivity(undefined)
            }

            const startSpinnerAndCancel = () => {
              if (turnSuspended) return
              turn.setActivity(cleanTerminalLine(spinnerText === "" ? "Working" : spinnerText))
            }

            const pauseSpinnerAndCancel = () => {
              turn.setActivity(undefined)
              turnSuspended = true
              turn.suspend()
            }

            const resumeTurnSurface = () => {
              if (!turnSuspended) return
              turnSuspended = false
              turn.resume()
            }

            startSpinnerAndCancel()

            const shownDiffCallIds = new Set<string>()
            const readBurst: Array<{
              readonly tool: "read_file" | "list_files"
              readonly target: string
              readonly ok: boolean
              readonly durationMs?: number
            }> = []

            const flushReadBurst = () => {
              if (readBurst.length === 0) return
              const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
              if (readBurst.length <= 3) {
                for (const entry of readBurst) {
                  const target = cleanTerminalLine(entry.target || ".")
                  if (io instanceof RawTerminalIO) {
                    const time =
                      entry.durationMs === undefined
                        ? ""
                        : style.muted(
                            entry.durationMs < 100
                              ? `(${entry.durationMs < 1 ? "<1" : Math.round(entry.durationMs)} ms)`
                              : `(${(entry.durationMs / 1000).toFixed(1)}s)`,
                          )
                    const row = renderActivityRow(
                      entry.tool === "list_files" ? "List" : "Read",
                      target,
                      [time, entry.ok ? "" : style.red("failed")].filter(Boolean).join("  "),
                      terminalCols(io) - 1,
                      style,
                    )
                    io.write(`${row}\n`)
                  } else if (entry.tool === "list_files") {
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
                    readBurst
                      .filter((r) => r.ok && r.target && r.target !== ".")
                      .map((r) => cleanTerminalLine(r.target)),
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
              return
            }
            let result: TaskResult
            let lastRequest: Pick<SessionStatus, "requestLimit" | "context"> = {}
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
                  requestWorkspaceTrust: async (
                    req: ApprovalRequest,
                  ): Promise<ApprovalDecision> => {
                    pauseSpinnerAndCancel()
                    flushReadBurst()
                    try {
                      const style = io instanceof RawTerminalIO ? io.style : createStyle(false)
                      if (req.kind === "edit_file") {
                        const cleanPatch = sanitizeSecretText(req.prepared.diffPreview, cred.secret)
                        renderEditPreview(
                          io,
                          cleanPatch,
                          sanitizeSecretText(req.prepared.relativePath, cred.secret),
                          req.prepared.create,
                          true,
                        )
                        shownDiffCallIds.add(req.callId)
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
                      resumeTurnSurface()
                      startSpinnerAndCancel()
                    }
                  },
                  onEvent: (event: TaskEvent) => {
                    if (event.type === "turn_started") {
                      lastRequest = { requestLimit: event.maxRequests }
                    } else if (event.type === "context_compacted" && io instanceof RawTerminalIO) {
                      clearSpinnerLine()
                      flushReadBurst()
                      const before = formatTokenCount(event.beforeTokens)
                      const after = formatTokenCount(event.afterTokens)
                      const reduction = Math.round(
                        (100 * (event.beforeTokens - event.afterTokens)) / event.beforeTokens,
                      )
                      const change = reduction > 0 ? `, −${reduction}%` : ""
                      const badge = `⟳  Auto-compacted context (~${before} → ~${after} tokens${change})`
                      for (const line of wrapPlainText(badge, terminalCols(io) - 3)) {
                        io.write(`  ${io.style.violet(line)}\n`)
                      }
                    } else if (event.type === "assistant_progress" && io instanceof RawTerminalIO) {
                      clearSpinnerLine()
                      flushReadBurst()
                      renderAssistantReply(io, event.text)
                    } else if (event.type === "model_requested") {
                      if (event.contextLimit > 0) {
                        lastRequest = {
                          ...lastRequest,
                          context: { tokens: event.contextTokens, limit: event.contextLimit },
                        }
                      }
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
                      if (
                        event.source &&
                        event.source !== "user" &&
                        event.source !== "user-always"
                      ) {
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
                          ...(event.result.durationMs === undefined
                            ? {}
                            : { durationMs: event.result.durationMs }),
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
                          renderEditPreview(
                            io,
                            event.result.patch,
                            event.result.target ?? event.result.changedFile ?? "file",
                            event.result.create,
                          )
                        }
                        if (event.result.status !== "ok" || !(io instanceof RawTerminalIO)) {
                          const icon =
                            event.result.status === "ok" ? style.green("✓") : style.red("✗")
                          io.write(`  ${icon} ${sanitizeTerminalText(event.result.output)}\n`)
                        }
                      } else if (event.result.tool === "run_command") {
                        if (io instanceof RawTerminalIO) {
                          renderRunActivity(io, event.result)
                          return
                        }
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
                        renderEditPreview(
                          io,
                          cleanPatch,
                          sanitizeSecretText(req.prepared.relativePath, cred.secret),
                          req.prepared.create,
                          true,
                        )
                        shownDiffCallIds.add(req.callId)
                        if (req.integrityWarning) {
                          io.write(
                            `${style.red("TestGuard Warning:")} ${sanitizeTerminalText(sanitizeSecretText(req.integrityWarning, cred.secret))}\n`,
                          )
                        }
                        if (req.reason && req.reason !== req.integrityWarning) {
                          const prefix = req.smartDenied
                            ? style.red("Blocked:")
                            : style.yellow("Note:")
                          io.write(
                            `${prefix} ${sanitizeTerminalText(sanitizeSecretText(req.reason, cred.secret))}\n`,
                          )
                        }
                        return await askPermissionDecision(io, "Apply this change? [y/N]", {
                          allowAlways: req.allowAlways ?? true,
                          allowAcceptEdits: true,
                          ...(req.integrityWarning
                            ? { integrityWarning: req.integrityWarning }
                            : {}),
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
                      io.write(
                        `\n  ${style.yellow("┃")} ${style.bold("$")} ${style.bold(cmdLine)}\n`,
                      )
                      io.write(
                        `  ${style.yellow("┃")} ${style.muted(`Dir      ${sanitizeTerminalText(sanitizeSecretText(req.prepared.cwd, cred.secret))}`)}\n`,
                      )
                      io.write(
                        `  ${style.yellow("┃")} ${style.muted(`Warning  ${req.hostAccessWarning}`)}\n`,
                      )
                      if (req.reason) {
                        const prefix = req.smartDenied
                          ? style.red("Blocked:")
                          : style.yellow("Note:")
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
                      resumeTurnSurface()
                      startSpinnerAndCancel()
                    }
                  },
                },
              )
            } finally {
              pauseSpinnerAndCancel()
              flushReadBurst()
              resumeTurnSurface()
            }

            currentAbort = undefined
            sessionStatus.set(activeSession.id, {
              ...lastRequest,
              config: activeConfig,
              requests: result.requests + (result.guardianRequests ?? 0),
            })
            renderTaskOutcome(result, io)
            if (
              !trusted &&
              result.actions?.some(
                (a) =>
                  a.decision === "deny" && (a.tool === "edit_file" || a.tool === "run_command"),
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
              turn.suspend()
              const repair = await askYesNo(
                io,
                "Provider rejected request. Run /setup to repair? [y/N] ",
              )
              if (isYes(repair)) {
                const prevDest = activeConfig
                  ? `${activeConfig.endpointType}:${formatDestination(activeConfig.baseURL)}`
                  : undefined
                const res = await guardedSetup(resolved.config, activeConfig)
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
              turn.resume()
            }
          } finally {
            if (io instanceof RawTerminalIO) io.setWriteSink(undefined)
          }
        }
        if (io instanceof RawTerminalIO) {
          const action: ComposerAction = await runInteractiveComposer({
            raw: io.raw,
            style: io.style,
            promptLabel: "❯ ",
            ...(welcomeSessionId === activeSession.id
              ? {
                  placeholder: activeConfig
                    ? " Ask Bashwink anything…"
                    : " Press Enter to set up a model",
                  beforeSubmit: (text: string) => {
                    if (text.startsWith("/") || ["exit", "quit", "connect"].includes(text)) return
                    welcomeSessionId = undefined
                    io.write("\x1b[2J\x1b[H")
                    renderCliHeader(io, canonical, trusted, activeConfig, activeSession)
                  },
                }
              : {}),
            permissionMode,
            statusSummary: "",
            renderStatus: (width) => {
              // Read the live session status: a turn that finishes while the composer stays
              // painted must update the footer instead of freezing the pre-turn numbers.
              const live = sessionStatus.get(activeSession.id)
              return renderSessionStatus(
                {
                  requests: 0,
                  ...(requestLimit === undefined ? {} : { requestLimit }),
                  ...(live?.config === activeConfig ? live : undefined),
                  model: cleanTerminalLine(activeConfig?.model ?? "No model (/model)"),
                  mode: permissionMode,
                  readOnly:
                    !isWorkspaceTrusted(resolved.config, canonical) || permissionMode === "ask",
                },
                width,
                io.style,
              )
            },
            workspace: canonical,
            history: promptHistory,
            initialDraft: draftBuffer,
            initialCursor: draftCursor,
            runTurn: (turn: ComposerTurnContext) => executeSubmittedText(turn.text, turn),
            turnCommands: ["test", "ping", "verify"],
          })
          draftBuffer = action.draft
          draftCursor = action.cursor
          if (action.kind === "exit") break
          if (action.kind === "cycle_mode") {
            permissionMode = setWorkspacePermissionMode(
              resolved.config,
              canonical,
              nextPermissionMode(permissionMode),
            ).mode
            draftBuffer = action.draft
            draftCursor = action.cursor
            if (welcomeSessionId === activeSession.id) renderSessionEntry(true)
            continue
          }
          if (action.kind === "clear_screen") {
            renderSessionEntry(true)
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
            const res = await guardedSetup(resolved.config)
            if (res.status === "saved") {
              activeConfig = res.config
              renderSessionEntry(welcomeSessionId === activeSession.id)
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
