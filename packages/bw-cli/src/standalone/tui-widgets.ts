/**
 * Interactive raw-mode terminal UI widgets and overlays for standalone Bashwink:
 * - Synchronized inline prompt composer with `/` slash-command and `@` file autocomplete
 * - Persistent prompt history (`Up`/`Down`) and incremental reverse search (`Ctrl+R`)
 * - OpenCode-style Command Palette (`Ctrl+P`)
 * - Claude/OpenCode-style Session Browser & Switcher (`Ctrl+O`, `/sessions`, `/resume`)
 * - Timeline & Checkpoint Rewind Navigator (`Esc Esc`, `/timeline`, `/rewind`)
 * - Scrollable Transcript & Message Navigator (`Ctrl+T`, `/transcript`), Diff & Help overlays
 * - Hybrid arrow-key + line-compatible choice/confirmation prompts for `/model` & tool approvals
 *
 * Pure Node 22+ built-ins only; zero external dependencies.
 */

import path from "node:path"
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  CURSOR_HIDE,
  CURSOR_SHOW,
  SYNC_END,
  SYNC_START,
  createKeyParserState,
  feedKeyParser,
  flushPendingEscape,
  formatPromptMetadata,
  formatStatusFooterLine,
  getTerminalLayout,
  padPlainRight,
  truncatePlain,
  visibleWidth,
  wrapComposerLines,
  wrapPlainText,
  wrapStyledLine,
  type KeyParserState,
  type ParsedKeyEvent,
  type PromptMetadataInput,
  type StatusFooterInput,
  type TerminalLayout,
  type TuiStyle,
} from "./tui-theme.ts"
import { listWorkspaceFiles, type SessionRecord, type SessionTurn } from "./session.ts"

export interface SlashCommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly category: "Session" | "Navigation" | "Model" | "Workspace" | "System"
  readonly shortcut?: string
  readonly argumentHint?: string
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "sessions",
    aliases: ["resume", "continue"],
    description: "Browse, search, preview, rename, fork, or resume sessions",
    category: "Session",
    shortcut: "ctrl+o",
  },
  {
    name: "new",
    aliases: [],
    description: "Start a fresh session in this workspace",
    category: "Session",
  },
  {
    name: "clear",
    aliases: [],
    description: "Clear current conversation and reset screen",
    category: "Session",
  },
  {
    name: "fork",
    aliases: [],
    description: "Fork current session into a new branch",
    category: "Session",
  },
  {
    name: "rename",
    aliases: [],
    description: "Rename current session",
    category: "Session",
    argumentHint: "[title]",
  },
  {
    name: "timeline",
    aliases: ["rewind", "checkpoint", "undo"],
    description: "Navigate turns, rewind conversation/files, or fork from a turn",
    category: "Navigation",
    shortcut: "esc esc",
  },
  {
    name: "transcript",
    aliases: [],
    description: "Open scrollable full transcript & turn navigator",
    category: "Navigation",
    shortcut: "ctrl+t",
  },
  {
    name: "diff",
    aliases: [],
    description: "Inspect modified files & command outcomes in this session",
    category: "Navigation",
  },
  {
    name: "compact",
    aliases: [],
    description: "Compact older turns into a local context summary",
    category: "Session",
  },
  {
    name: "model",
    aliases: ["models"],
    description: "Select provider & model (zero outbound requests on setup)",
    category: "Model",
  },
  {
    name: "connect",
    aliases: ["setup"],
    description: "Configure or repair provider endpoint & credentials",
    category: "Model",
  },
  {
    name: "test",
    aliases: ["ping", "verify"],
    description: "Probe /models and run a sample test message on saved model",
    category: "Model",
  },
  {
    name: "trust",
    aliases: [],
    description: "Trust current workspace for interactive edit/command approvals",
    category: "Workspace",
  },
  {
    name: "status",
    aliases: [],
    description: "Show session, model, trust, usage, and evidence status",
    category: "Workspace",
  },
  {
    name: "evidence",
    aliases: [],
    description: "Verify hash-chained evidence.jsonl log",
    category: "Workspace",
  },
  {
    name: "help",
    aliases: ["?"],
    description: "Show interactive keyboard shortcuts & commands",
    category: "System",
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit Bashwink cleanly",
    category: "System",
    shortcut: "ctrl+d",
  },
]

export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  const clean = name.trim().toLowerCase()
  return SLASH_COMMANDS.find((c) => c.name === clean || c.aliases.includes(clean))
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (q === "") return 1
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx !== -1) {
    return 1000 - idx * 4 - (t.length - q.length) * 0.1
  }
  let qi = 0
  let score = 0
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1
      streak += 1
      score += 10 + streak * 5
    } else {
      streak = 0
    }
  }
  return qi === q.length ? score : -1
}

export function fuzzyFilter<T>(query: string, items: readonly T[], toSearchText: (item: T) => string): T[] {
  const clean = query.trim()
  if (clean === "") return [...items]
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(clean, toSearchText(item))
    if (score >= 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}

export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 30) return `${days}d ago`
  return iso.slice(0, 10)
}

export interface TerminalResizeInfo {
  readonly cols: number
  readonly rows: number
  readonly prevCols: number
  readonly prevRows: number
}

/**
 * Raw-mode multiplexer around `process.stdin`, `process.stdout` resize, `SIGWINCH`, and `SIGCONT`.
 * Restores cooked mode whenever idle/closed so child processes and terminal state stay clean.
 */
export class RawTerminalSession {
  readonly isTTY: boolean
  private readonly parserState: KeyParserState = createKeyParserState()
  private keyListener: ((ev: ParsedKeyEvent) => void) | undefined
  private resizeListener: ((info: TerminalResizeInfo) => void) | undefined
  private escTimer: ReturnType<typeof setTimeout> | undefined
  private rawActive = false
  private attached = false
  private lastCols: number
  private lastRows: number

  constructor() {
    this.isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    const size = this.readTerminalSize()
    this.lastCols = size.cols
    this.lastRows = size.rows
  }

  private readTerminalSize(): { cols: number; rows: number } {
    const rawCols = process.stdout.columns
    const rawRows = process.stdout.rows
    const cols = typeof rawCols === "number" && Number.isFinite(rawCols) && rawCols > 0 ? Math.max(20, rawCols) : 100
    const rows = typeof rawRows === "number" && Number.isFinite(rawRows) && rawRows > 0 ? Math.max(8, rawRows) : 30
    return { cols, rows }
  }

  cols(): number {
    return this.readTerminalSize().cols
  }

  rows(): number {
    return this.readTerminalSize().rows
  }

  layout(): TerminalLayout {
    const { cols, rows } = this.readTerminalSize()
    return getTerminalLayout(cols, rows)
  }

  write(text: string): void {
    process.stdout.write(text)
  }

  private ensureAttached(): void {
    if (this.attached) return
    this.attached = true
    process.stdin.on("data", this.onData)
    process.stdout.on("resize", this.onResize)
    process.on("SIGWINCH", this.onResize)
    process.on("SIGCONT", this.onResume)
  }

  private readonly onResize = (): void => {
    const next = this.readTerminalSize()
    if (next.cols === this.lastCols && next.rows === this.lastRows) return
    const info: TerminalResizeInfo = {
      cols: next.cols,
      rows: next.rows,
      prevCols: this.lastCols,
      prevRows: this.lastRows,
    }
    this.lastCols = next.cols
    this.lastRows = next.rows
    this.resizeListener?.(info)
  }

  private readonly onResume = (): void => {
    const next = this.readTerminalSize()
    const info: TerminalResizeInfo = {
      cols: next.cols,
      rows: next.rows,
      prevCols: this.lastCols,
      prevRows: this.lastRows,
    }
    this.lastCols = next.cols
    this.lastRows = next.rows
    this.resizeListener?.(info)
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    if (this.escTimer) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    const events = feedKeyParser(this.parserState, str)
    for (const ev of events) {
      this.keyListener?.(ev)
    }
    if (this.parserState.pending === "\x1b") {
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined
        const flushed = flushPendingEscape(this.parserState)
        for (const ev of flushed) {
          this.keyListener?.(ev)
        }
      }, 35)
    }
  }

  beginCapture(
    onKey: (ev: ParsedKeyEvent) => void,
    onResize?: (info: TerminalResizeInfo) => void,
  ): () => void {
    this.ensureAttached()
    const cur = this.readTerminalSize()
    this.lastCols = cur.cols
    this.lastRows = cur.rows
    this.keyListener = onKey
    this.resizeListener = onResize
    if (this.isTTY && !this.rawActive) {
      try {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        this.rawActive = true
        this.write(BRACKETED_PASTE_ON)
      } catch {
        // Ignore if stdin closed
      }
    }
    return () => {
      if (this.keyListener === onKey) this.keyListener = undefined
      if (this.resizeListener === onResize) this.resizeListener = undefined
      if (this.escTimer) {
        clearTimeout(this.escTimer)
        this.escTimer = undefined
      }
      this.endCapture()
    }
  }

  endCapture(): void {
    if (this.isTTY && this.rawActive) {
      try {
        this.write(BRACKETED_PASTE_OFF)
        process.stdin.setRawMode(false)
      } catch {
        // Ignore if stdin already closed
      }
      this.rawActive = false
    }
  }

  dispose(): void {
    this.endCapture()
    if (this.attached) {
      process.stdin.off("data", this.onData)
      process.stdout.off("resize", this.onResize)
      process.off("SIGWINCH", this.onResize)
      process.off("SIGCONT", this.onResume)
      this.attached = false
    }
    if (this.isTTY) {
      try {
        process.stdin.pause()
      } catch {
        // Ignore
      }
    }
  }
}

export type ComposerAction =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "command"; readonly name: string; readonly args: string; readonly raw: string }
  | { readonly kind: "palette" }
  | { readonly kind: "sessions" }
  | { readonly kind: "timeline" }
  | { readonly kind: "transcript" }
  | { readonly kind: "clear_screen" }
  | { readonly kind: "exit" }

export interface ComposerOptions {
  readonly raw: RawTerminalSession
  readonly style: TuiStyle
  readonly promptLabel: string
  readonly statusSummary: string
  readonly getStatusSummary?: (layout: TerminalLayout) => string
  readonly getMetadata?: (layout: TerminalLayout) => PromptMetadataInput
  readonly getStatusFooter?: (layout: TerminalLayout) => Omit<StatusFooterInput, "statusMessage">
  readonly workspace: string
  readonly history: readonly string[]
  readonly initialDraft?: string
}

interface AutocompleteItem {
  readonly insertText: string
  readonly label: string
  readonly detail: string
  readonly isCommand: boolean
}

function splitLinesWithOffsets(text: string): { line: string; start: number; end: number }[] {
  const lines = text.split("\n")
  const out: { line: string; start: number; end: number }[] = []
  let pos = 0
  for (const line of lines) {
    out.push({ line, start: pos, end: pos + line.length })
    pos += line.length + 1
  }
  return out
}

function cursorRowCol(text: string, cursor: number): { row: number; col: number; lines: { line: string; start: number; end: number }[] } {
  const lines = splitLinesWithOffsets(text)
  for (let r = 0; r < lines.length; r += 1) {
    const info = lines[r]!
    if (cursor <= info.end || r === lines.length - 1) {
      return { row: r, col: Math.max(0, cursor - info.start), lines }
    }
  }
  return { row: 0, col: 0, lines }
}

function wordBoundaryLeft(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(text[i - 1]!)) i -= 1
  while (i > 0 && !/\s/.test(text[i - 1]!)) i -= 1
  return i
}

function wordBoundaryRight(text: string, cursor: number): number {
  let i = cursor
  while (i < text.length && /\s/.test(text[i]!)) i += 1
  while (i < text.length && !/\s/.test(text[i]!)) i += 1
  return i
}

/**
 * Smooth inline prompt composer supporting multi-line editing, `/` command popup,
 * `@` file mention popup, `Up`/`Down` prompt history, `Ctrl+R` incremental search,
 * `Esc Esc` rewind trigger, `Ctrl+P` palette, `Ctrl+O` sessions, and `Ctrl+T` transcript.
 */
export async function runInteractiveComposer(opts: ComposerOptions): Promise<ComposerAction> {
  const { raw, style } = opts
  let buffer = opts.initialDraft ?? ""
  let cursor = buffer.length
  let historyIndex = -1
  let savedDraft = ""

  // Ctrl+R reverse search state
  let searchingHistory = false
  let searchQuery = ""
  let searchSkip = 0

  // Autocomplete state
  let autoDismissedFor: string | undefined
  let autoIndex = 0
  let workspaceFilesCache: string[] | undefined

  // Double-Esc rewind arming
  let escArmedUntil = 0
  let statusMessage = ""
  let renderedTotalLines = 0
  let renderedCursorRow = 0
  let renderedCursorVisualCol = 0
  let lastPaintedCols = raw.cols()
  let lastPaintedRows: string[] = []

  const getAutocomplete = (maxItems = 7): { mode: "slash" | "file"; tokenStart: number; items: AutocompleteItem[] } | undefined => {
    if (searchingHistory) return undefined
    const beforeCursor = buffer.slice(0, cursor)
    if (autoDismissedFor === buffer) return undefined

    // 1. Slash command menu at start of single-line input before first whitespace
    if (beforeCursor.startsWith("/") && !/\s/.test(beforeCursor) && !buffer.includes("\n")) {
      const needle = beforeCursor.slice(1)
      const matched = fuzzyFilter(needle, SLASH_COMMANDS, (c) => `${c.name} ${c.aliases.join(" ")} ${c.description}`)
      if (matched.length === 0) return undefined
      return {
        mode: "slash",
        tokenStart: 0,
        items: matched.slice(0, maxItems).map((c) => ({
          insertText: `/${c.name}`,
          label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
          detail: `${c.description}${c.shortcut ? ` [${c.shortcut}]` : ""}`,
          isCommand: true,
        })),
      }
    }

    // 2. `@` file mention autocomplete
    const atMatch = /(?:^|\s)@([^\s]*)$/.exec(beforeCursor)
    if (atMatch) {
      if (!workspaceFilesCache) workspaceFilesCache = listWorkspaceFiles(opts.workspace, 300)
      const needle = atMatch[1] ?? ""
      const tokenStart = beforeCursor.length - needle.length - 1
      const matched = fuzzyFilter(needle, workspaceFilesCache, (f) => f)
      if (matched.length === 0) return undefined
      return {
        mode: "file",
        tokenStart,
        items: matched.slice(0, maxItems).map((f) => ({
          insertText: `@${f} `,
          label: `@${f}`,
          detail: "workspace file",
          isCommand: false,
        })),
      }
    }

    return undefined
  }

  const findHistoryMatch = (): { match: string | undefined; total: number } => {
    const q = searchQuery.toLowerCase()
    const matches: string[] = []
    for (let i = opts.history.length - 1; i >= 0; i -= 1) {
      const entry = opts.history[i]!
      if (q === "" || entry.toLowerCase().includes(q)) {
        if (!matches.includes(entry)) matches.push(entry)
      }
    }
    if (matches.length === 0) return { match: undefined, total: 0 }
    const idx = searchSkip % matches.length
    return { match: matches[idx], total: matches.length }
  }

  const physicalRowsAboveCursor = (colsNow: number): number => {
    if (renderedTotalLines === 0) return 0
    if (colsNow >= lastPaintedCols || lastPaintedRows.length === 0) {
      return renderedCursorRow
    }
    // Account for terminal soft-reflow when width narrowed before clearing
    let rowsAbove = 0
    for (let i = 0; i < renderedCursorRow && i < lastPaintedRows.length; i += 1) {
      const w = Math.max(1, visibleWidth(lastPaintedRows[i]!))
      rowsAbove += Math.max(1, Math.ceil(w / colsNow))
    }
    rowsAbove += Math.floor(renderedCursorVisualCol / Math.max(1, colsNow))
    return rowsAbove
  }

  const clearRenderedBlock = () => {
    if (renderedTotalLines === 0) return
    const upRows = physicalRowsAboveCursor(raw.cols())
    let seq = "\r"
    if (upRows > 0) seq += `\x1b[${upRows}A`
    seq += "\x1b[J"
    raw.write(seq)
    renderedTotalLines = 0
    renderedCursorRow = 0
    renderedCursorVisualCol = 0
    lastPaintedRows = []
  }

  const render = (firstPaint = false, reflowFromCols?: number) => {
    const layout = raw.layout()
    const cols = layout.cols
    const rows = layout.rows
    const railPlain = "┃ "
    const railStyled = style.accent(railPlain)
    const firstPrefix = `${railPlain}${opts.promptLabel}`
    const contPrefix = `${railPlain}${" ".repeat(Math.max(0, opts.promptLabel.length - 2))}│ `
    const { row: curRow, col: curCol, lines: bufLines } = cursorRowCol(buffer, cursor)

    const placeholder =
      layout.isCompact || layout.isShort
        ? "Ask Bashwink (/ cmd, @ file)"
        : "Ask Bashwink to inspect, edit, or test… (type / for commands, @ for files)"

    const wrapped = wrapComposerLines(
      bufLines,
      curRow,
      curCol,
      firstPrefix,
      contPrefix,
      placeholder,
      searchingHistory,
      cols,
      (s) => `${railStyled}${style.accentBold(s.slice(railPlain.length))}`,
      (s) => `${railStyled}${style.dim(s.slice(railPlain.length))}`,
      (s) => style.muted(s),
    )

    const outLines: string[] = []
    if (!layout.isShort && rows >= 14) {
      outLines.push(railStyled)
    }

    const promptLinesStart = outLines.length
    outLines.push(...wrapped.visualRows)

    const maxAuto = Math.max(2, Math.min(7, rows - wrapped.visualRows.length - 5))
    const auto = getAutocomplete(maxAuto)
    if (!auto && !searchingHistory && opts.getMetadata && rows >= 14) {
      const meta = formatPromptMetadata(opts.getMetadata(layout), Math.max(14, cols - 4), style)
      outLines.push(`${railStyled}${meta}`)
    }

    outLines.push(style.dim(`╹${"▀".repeat(Math.max(10, cols - 1))}`))

    if (auto) {
      if (autoIndex >= auto.items.length) autoIndex = Math.max(0, auto.items.length - 1)
      const autoHint =
        layout.isCompact
          ? auto.mode === "slash"
            ? "  Commands (Tab/Enter):"
            : "  Files (Tab/Enter):"
          : auto.mode === "slash"
            ? "  Commands (Tab complete · Enter run · Esc dismiss):"
            : "  Files (Tab/Enter insert · Esc dismiss):"
      outLines.push(style.dim(truncatePlain(autoHint, cols)))
      for (let i = 0; i < auto.items.length; i += 1) {
        const item = auto.items[i]!
        const selected = i === autoIndex
        const pointer = selected ? style.accentBold("❯ ") : "  "
        if (cols < 44) {
          const rowStr = `  ${pointer}${truncatePlain(item.label, Math.max(8, cols - 5))}`
          outLines.push(selected ? style.selectedRow(padPlainRight(rowStr, cols)) : style.muted(rowStr))
        } else {
          const leftW = Math.min(26, Math.floor(cols * 0.35))
          const left = padPlainRight(item.label, leftW)
          const rightMax = Math.max(8, cols - visibleWidth(left) - 6)
          const rowStr = `  ${pointer}${left}  ${truncatePlain(item.detail, rightMax)}`
          outLines.push(selected ? style.selectedRow(padPlainRight(rowStr, cols)) : style.muted(rowStr))
        }
      }
    } else if (searchingHistory) {
      const { match, total } = findHistoryMatch()
      const matchDisplay = match
        ? truncatePlain(match.replace(/\n/g, " ↵ "), Math.max(12, cols - (layout.isCompact ? 22 : 38)))
        : style.red("no match")
      const label = layout.isCompact ? "(search)" : "(reverse-i-search)"
      const countTag = total > 1 && !layout.isCompact ? style.dim(`  (${total} matches · ctrl+r next)`) : ""
      outLines.push(truncatePlain(`${style.cyan(label)} '${searchQuery}': ${matchDisplay}${countTag}`, cols))
    }

    if (opts.getStatusFooter) {
      const footerData = opts.getStatusFooter(layout)
      outLines.push(
        formatStatusFooterLine(
          {
            ...footerData,
            ...(statusMessage !== "" ? { statusMessage } : {}),
          },
          cols,
          style,
        ),
      )
    } else {
      const baseStatus = opts.getStatusSummary ? opts.getStatusSummary(layout) : opts.statusSummary
      const footerMsg =
        statusMessage !== ""
          ? style.yellow(truncatePlain(statusMessage, cols))
          : style.muted(truncatePlain(baseStatus, cols))
      outLines.push(footerMsg)
    }

    const targetCursorRow = promptLinesStart + wrapped.visualCursorRow
    const targetCursorCol = Math.min(Math.max(0, cols - 1), wrapped.visualCursorCol)

    let frame = SYNC_START
    if (!firstPaint && renderedTotalLines > 0) {
      const upRows = reflowFromCols !== undefined ? physicalRowsAboveCursor(cols) : renderedCursorRow
      frame += "\r"
      if (upRows > 0) frame += `\x1b[${upRows}A`
      frame += "\x1b[J"
    }
    frame += outLines.join("\n")
    // Move cursor back up from bottom line to active input cursor
    const linesFromBottom = outLines.length - 1 - targetCursorRow
    if (linesFromBottom > 0) frame += `\x1b[${linesFromBottom}A`
    frame += `\r`
    if (targetCursorCol > 0) frame += `\x1b[${targetCursorCol}C`
    frame += CURSOR_SHOW + SYNC_END

    raw.write(frame)
    renderedTotalLines = outLines.length
    renderedCursorRow = targetCursorRow
    renderedCursorVisualCol = targetCursorCol
    lastPaintedCols = cols
    lastPaintedRows = outLines
  }

  const commitFinalPromptLine = (submittedText: string) => {
    clearRenderedBlock()
    const cols = raw.cols()
    const preview = submittedText
      .split("\n")
      .map((l, idx) => `${style.accent("┃ ")}${idx === 0 ? `${opts.promptLabel}${l}` : `  ${l}`}`)
      .join("\n")
    raw.write(`${preview}\n${style.dim(`╹${"▀".repeat(Math.min(Math.max(15, cols - 1), 79))}`)}\n`)
  }

  return await new Promise<ComposerAction>((resolve) => {
    let settled = false
    const finish = (action: ComposerAction, commitText?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (commitText !== undefined) commitFinalPromptLine(commitText)
      else clearRenderedBlock()
      resolve(action)
    }

    const applyAutocomplete = (item: AutocompleteItem, mode: "slash" | "file", tokenStart: number, runIfSlash: boolean) => {
      if (mode === "slash") {
        if (runIfSlash) {
          const cmdName = item.insertText.slice(1)
          finish({ kind: "command", name: cmdName, args: "", raw: item.insertText }, item.insertText)
          return
        }
        buffer = `${item.insertText} `
        cursor = buffer.length
        autoDismissedFor = buffer
      } else {
        buffer = buffer.slice(0, tokenStart) + item.insertText + buffer.slice(cursor)
        cursor = tokenStart + item.insertText.length
        autoIndex = 0
      }
      render()
    }

    const submitCurrent = () => {
      const trimmed = buffer.trim()
      if (trimmed === "") {
        finish({ kind: "submit", text: "" })
        return
      }
      if (trimmed.startsWith("/")) {
        const withoutSlash = trimmed.slice(1)
        const spaceIdx = withoutSlash.search(/\s/)
        const cmdName = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase()
        const cmdArgs = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim()
        const matched = findSlashCommand(cmdName)
        if (matched) {
          finish({ kind: "command", name: matched.name, args: cmdArgs, raw: trimmed }, trimmed)
          return
        }
      }
      finish({ kind: "submit", text: trimmed }, trimmed)
    }

    const onKey = (ev: ParsedKeyEvent) => {
      statusMessage = ""

      if (ev.kind === "ctrl") {
        if (ev.key === "d") {
          if (buffer === "") {
            finish({ kind: "exit" })
            return
          }
          // Delete char at cursor if non-empty
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1)
            render()
          }
          return
        }
        if (ev.key === "c") {
          if (searchingHistory) {
            searchingHistory = false
            searchQuery = ""
            render()
            return
          }
          if (buffer !== "") {
            buffer = ""
            cursor = 0
            historyIndex = -1
            autoDismissedFor = undefined
            statusMessage = "Cleared input (press Ctrl+D or /exit to quit)"
            render()
            return
          }
          statusMessage = "Press Ctrl+D or type /exit to quit"
          render()
          return
        }
        if (ev.key === "l") {
          finish({ kind: "clear_screen" })
          return
        }
        if (ev.key === "p") {
          finish({ kind: "palette" })
          return
        }
        if (ev.key === "o") {
          finish({ kind: "sessions" })
          return
        }
        if (ev.key === "t") {
          finish({ kind: "transcript" })
          return
        }
        if (ev.key === "r") {
          if (!searchingHistory) {
            searchingHistory = true
            searchQuery = ""
            searchSkip = 0
          } else {
            searchSkip += 1
          }
          render()
          return
        }
        if (ev.key === "a") {
          const info = cursorRowCol(buffer, cursor)
          cursor = info.lines[info.row]!.start
          render()
          return
        }
        if (ev.key === "e") {
          const info = cursorRowCol(buffer, cursor)
          cursor = info.lines[info.row]!.end
          render()
          return
        }
        if (ev.key === "u") {
          const info = cursorRowCol(buffer, cursor)
          const start = info.lines[info.row]!.start
          buffer = buffer.slice(0, start) + buffer.slice(cursor)
          cursor = start
          render()
          return
        }
        if (ev.key === "k") {
          const info = cursorRowCol(buffer, cursor)
          const end = info.lines[info.row]!.end
          buffer = buffer.slice(0, cursor) + buffer.slice(end)
          render()
          return
        }
        if (ev.key === "w") {
          const left = wordBoundaryLeft(buffer, cursor)
          buffer = buffer.slice(0, left) + buffer.slice(cursor)
          cursor = left
          render()
          return
        }
        if (ev.key === "j") {
          buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor)
          cursor += 1
          render()
          return
        }
        return
      }

      if (ev.kind === "alt") {
        if (ev.key === "b") {
          cursor = wordBoundaryLeft(buffer, cursor)
          render()
          return
        }
        if (ev.key === "f") {
          cursor = wordBoundaryRight(buffer, cursor)
          render()
          return
        }
        if (ev.key === "p") {
          finish({ kind: "palette" })
          return
        }
        return
      }

      if (ev.kind === "paste") {
        const cleanPaste = ev.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        if (searchingHistory) {
          searchQuery += cleanPaste.replace(/\n/g, " ")
          searchSkip = 0
        } else {
          buffer = buffer.slice(0, cursor) + cleanPaste + buffer.slice(cursor)
          cursor += cleanPaste.length
          autoDismissedFor = undefined
        }
        render()
        return
      }

      if (ev.kind === "char") {
        escArmedUntil = 0
        if (searchingHistory) {
          searchQuery += ev.text
          searchSkip = 0
        } else {
          buffer = buffer.slice(0, cursor) + ev.text + buffer.slice(cursor)
          cursor += ev.text.length
          autoDismissedFor = undefined
          autoIndex = 0
        }
        render()
        return
      }

      // ev.kind === "key"
      if (searchingHistory) {
        if (ev.name === "escape" || ev.name === "tab") {
          const { match } = findHistoryMatch()
          searchingHistory = false
          if (match !== undefined) {
            buffer = match
            cursor = buffer.length
          }
          render()
          return
        }
        if (ev.name === "enter") {
          const { match } = findHistoryMatch()
          searchingHistory = false
          if (match !== undefined) {
            buffer = match
            cursor = buffer.length
          }
          submitCurrent()
          return
        }
        if (ev.name === "backspace") {
          if (searchQuery.length > 0) {
            searchQuery = searchQuery.slice(0, -1)
            searchSkip = 0
          } else {
            searchingHistory = false
          }
          render()
          return
        }
        return
      }

      const auto = getAutocomplete()
      if (ev.name === "escape") {
        if (auto) {
          autoDismissedFor = buffer
          render()
          return
        }
        const now = Date.now()
        if (now <= escArmedUntil) {
          escArmedUntil = 0
          finish({ kind: "timeline" })
          return
        }
        escArmedUntil = now + 700
        statusMessage = "Press Esc again to open Timeline & Rewind"
        render()
        return
      }

      escArmedUntil = 0

      if (auto) {
        if (ev.name === "up") {
          autoIndex = (autoIndex - 1 + auto.items.length) % auto.items.length
          render()
          return
        }
        if (ev.name === "down") {
          autoIndex = (autoIndex + 1) % auto.items.length
          render()
          return
        }
        if (ev.name === "tab") {
          const picked = auto.items[autoIndex]
          if (picked) applyAutocomplete(picked, auto.mode, auto.tokenStart, false)
          return
        }
        if (ev.name === "enter") {
          const picked = auto.items[autoIndex]
          if (picked) {
            applyAutocomplete(picked, auto.mode, auto.tokenStart, auto.mode === "slash")
            return
          }
        }
      }

      switch (ev.name) {
        case "newline":
          buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor)
          cursor += 1
          render()
          return
        case "enter":
          submitCurrent()
          return
        case "backspace":
          if (ev.alt || ev.ctrl) {
            const left = wordBoundaryLeft(buffer, cursor)
            buffer = buffer.slice(0, left) + buffer.slice(cursor)
            cursor = left
          } else if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor)
            cursor -= 1
            autoDismissedFor = undefined
          }
          render()
          return
        case "delete":
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1)
            autoDismissedFor = undefined
            render()
          }
          return
        case "left":
          if (ev.alt || ev.ctrl) cursor = wordBoundaryLeft(buffer, cursor)
          else if (cursor > 0) cursor -= 1
          render()
          return
        case "right":
          if (ev.alt || ev.ctrl) cursor = wordBoundaryRight(buffer, cursor)
          else if (cursor < buffer.length) cursor += 1
          render()
          return
        case "home": {
          const info = cursorRowCol(buffer, cursor)
          cursor = info.lines[info.row]!.start
          render()
          return
        }
        case "end": {
          const info = cursorRowCol(buffer, cursor)
          cursor = info.lines[info.row]!.end
          render()
          return
        }
        case "up": {
          const info = cursorRowCol(buffer, cursor)
          if (info.row > 0) {
            const prev = info.lines[info.row - 1]!
            cursor = prev.start + Math.min(info.col, prev.line.length)
            render()
            return
          }
          if (opts.history.length > 0) {
            if (historyIndex === -1) {
              savedDraft = buffer
              historyIndex = opts.history.length - 1
            } else if (historyIndex > 0) {
              historyIndex -= 1
            }
            buffer = opts.history[historyIndex] ?? ""
            cursor = buffer.length
            autoDismissedFor = buffer
            render()
          }
          return
        }
        case "down": {
          const info = cursorRowCol(buffer, cursor)
          if (info.row < info.lines.length - 1) {
            const next = info.lines[info.row + 1]!
            cursor = next.start + Math.min(info.col, next.line.length)
            render()
            return
          }
          if (historyIndex !== -1) {
            if (historyIndex < opts.history.length - 1) {
              historyIndex += 1
              buffer = opts.history[historyIndex] ?? ""
            } else {
              historyIndex = -1
              buffer = savedDraft
            }
            cursor = buffer.length
            autoDismissedFor = buffer
            render()
          }
          return
        }
        case "pageup":
          finish({ kind: "transcript" })
          return
        default:
          return
      }
    }

    const cleanup = raw.beginCapture(onKey, (info) => render(false, info.prevCols))
    raw.write("\n")
    render(true)
  })
}

export interface HybridChoiceOption {
  readonly value: string
  readonly display: string
}

/**
 * Renders a prompt with interactive arrow-key selection AND accepts direct typed input
 * (e.g. `10\n`, `openai\n`, `cancel\n`) for seamless human & scripted PTY compatibility.
 */
export async function askHybridChoice(
  raw: RawTerminalSession,
  style: TuiStyle,
  promptText: string,
  options: readonly HybridChoiceOption[],
): Promise<string | null> {
  if (!raw.isTTY || options.length === 0) return null
  let selected = 0
  let scrollTop = 0
  let typed = ""
  let renderedRows = 0
  let lastCols = raw.cols()

  const getMaxVisible = () => Math.min(options.length, Math.max(4, raw.rows() - 5))

  const render = (first = false, reflowFromCols?: number) => {
    const cols = raw.cols()
    const maxVisible = getMaxVisible()
    if (selected < scrollTop) scrollTop = selected
    if (selected >= scrollTop + maxVisible) scrollTop = selected - maxVisible + 1
    scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, options.length - maxVisible)))
    const end = Math.min(options.length, scrollTop + maxVisible)

    const lines: string[] = []
    for (let i = scrollTop; i < end; i += 1) {
      const opt = options[i]!
      const active = typed === "" && i === selected
      const prefix = active ? style.accentBold("❯ ") : "  "
      const body = truncatePlain(opt.display, Math.max(10, cols - 3))
      const line = `${prefix}${body}`
      lines.push(active ? style.selectedRow(padPlainRight(line, Math.min(cols, 84))) : line)
    }
    if (options.length > maxVisible) {
      const hint = `  Showing ${scrollTop + 1}-${end} of ${options.length} (↑/↓ scroll, or type number/id)`
      lines.push(style.dim(truncatePlain(hint, cols)))
    }
    lines.push(truncatePlain(`${promptText}${typed}`, Math.max(16, cols)))
    let frame = SYNC_START
    if (!first && renderedRows > 0) {
      const prevRows =
        reflowFromCols !== undefined && cols < lastCols
          ? Math.max(renderedRows - 1, Math.ceil((renderedRows - 1) * (lastCols / Math.max(1, cols))))
          : renderedRows - 1
      frame += "\r"
      if (prevRows > 0) frame += `\x1b[${prevRows}A`
      frame += "\x1b[J"
    }
    frame += lines.join("\n") + CURSOR_SHOW + SYNC_END
    raw.write(frame)
    renderedRows = lines.length
    lastCols = cols
  }

  return await new Promise<string | null>((resolve) => {
    let done = false
    const finish = (val: string | null) => {
      if (done) return
      done = true
      cleanup()
      raw.write("\n")
      resolve(val)
    }
    const onKey = (ev: ParsedKeyEvent) => {
      if (ev.kind === "ctrl" && (ev.key === "c" || ev.key === "d")) {
        finish(null)
        return
      }
      if (ev.kind === "char") {
        typed += ev.text
        render()
        return
      }
      if (ev.kind === "paste") {
        typed += ev.text.replace(/[\r\n]+/g, "")
        render()
        return
      }
      if (ev.kind === "key") {
        if (ev.name === "escape") {
          finish(null)
          return
        }
        if (ev.name === "up" && typed === "") {
          selected = (selected - 1 + options.length) % options.length
          render()
          return
        }
        if (ev.name === "down" && typed === "") {
          selected = (selected + 1) % options.length
          render()
          return
        }
        if (ev.name === "pageup" && typed === "") {
          selected = Math.max(0, selected - Math.max(1, getMaxVisible() - 1))
          render()
          return
        }
        if (ev.name === "pagedown" && typed === "") {
          selected = Math.min(options.length - 1, selected + Math.max(1, getMaxVisible() - 1))
          render()
          return
        }
        if (ev.name === "backspace") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1)
            render()
          }
          return
        }
        if (ev.name === "enter") {
          if (typed !== "") finish(typed)
          else finish(options[selected]?.value ?? "")
        }
      }
    }
    const cleanup = raw.beginCapture(onKey, (info) => render(false, info.prevCols))
    render(true)
  })
}

/**
 * Interactive `[y/N]` confirmation supporting `y`/`n` typing, `Left`/`Right`/`Tab` toggle, and `Enter`.
 */
export async function askHybridConfirm(
  raw: RawTerminalSession,
  style: TuiStyle,
  promptText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let typed = ""
  let highlighted: "no" | "yes" = "no"
  let rendered = false

  const render = () => {
    const layout = raw.layout()
    const yesTag = highlighted === "yes" && typed === "" ? style.selectedRow(" Yes (y) ") : style.green("Yes (y)")
    const noTag = highlighted === "no" && typed === "" ? style.selectedRow(" No (n) ") : style.muted("No (n)")
    const hint = style.dim(`  [${yesTag}${style.dim(" / ")}${noTag}${style.dim("]")}] `)
    const safePrompt = truncatePlain(promptText, Math.max(12, layout.cols - (typed === "" ? 24 : typed.length + 2)))
    const line = `${safePrompt}${typed === "" ? hint : ` ${typed}`}`
    raw.write(`${SYNC_START}${rendered ? "\r\x1b[2K" : ""}${line}${CURSOR_SHOW}${SYNC_END}`)
    rendered = true
  }

  return await new Promise<string | null>((resolve) => {
    let done = false
    const onAbort = () => finish(null)
    const finish = (val: string | null) => {
      if (done) return
      done = true
      signal?.removeEventListener("abort", onAbort)
      cleanup()
      raw.write("\n")
      resolve(val)
    }
    if (signal?.aborted) {
      finish(null)
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    const onKey = (ev: ParsedKeyEvent) => {
      if (ev.kind === "ctrl" && (ev.key === "c" || ev.key === "d")) {
        finish(null)
        return
      }
      if (ev.kind === "char") {
        typed += ev.text
        render()
        return
      }
      if (ev.kind === "key") {
        if (ev.name === "escape") {
          finish("n")
          return
        }
        if ((ev.name === "left" || ev.name === "right" || ev.name === "tab") && typed === "") {
          highlighted = highlighted === "no" ? "yes" : "no"
          render()
          return
        }
        if (ev.name === "backspace") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1)
            render()
          }
          return
        }
        if (ev.name === "enter") {
          if (typed !== "") finish(typed)
          else finish(highlighted === "yes" ? "y" : "n")
        }
      }
    }
    const cleanup = raw.beginCapture(onKey, () => render())
    render()
  })
}

export interface PaletteCommandItem {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly description: string
  readonly shortcut?: string
}

/** OpenCode-style `Ctrl+P` fuzzy command palette modal. */
export async function openCommandPalette(
  raw: RawTerminalSession,
  style: TuiStyle,
  items: readonly PaletteCommandItem[],
): Promise<string | undefined> {
  let query = ""
  let selected = 0
  let scrollTop = 0

  const getFiltered = () =>
    fuzzyFilter(query, items, (i) => `${i.title} ${i.category} ${i.description} ${i.id}`)

  const render = () => {
    const layout = raw.layout()
    const cols = layout.cols
    const rows = layout.rows
    const filtered = getFiltered()
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1)
    const listHeight = Math.max(3, rows - (layout.isShort ? 6 : 7))
    if (selected < scrollTop) scrollTop = selected
    if (selected >= scrollTop + listHeight) scrollTop = selected - listHeight + 1

    const lines: string[] = []
    lines.push(
      truncatePlain(
        style.accentBold("  Commands") + (layout.isCompact ? "" : style.muted("  (Bashwink Command Palette)")),
        cols,
      ),
    )
    lines.push(`  ${style.accent(">")} ${truncatePlain(query, Math.max(8, cols - 6))}${style.inverse(" ")}`)
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))

    if (filtered.length === 0) {
      lines.push(style.muted(truncatePlain("  No matching commands", cols)))
    } else {
      const visible = filtered.slice(scrollTop, scrollTop + listHeight)
      for (let i = 0; i < visible.length; i += 1) {
        const idx = scrollTop + i
        const item = visible[i]!
        const active = idx === selected
        const showBadge = cols >= 54 && item.shortcut
        const badge = showBadge ? `[${item.shortcut}]` : ""
        let rowStr: string
        if (layout.isCompact) {
          const title = padPlainRight(item.title, Math.min(18, Math.floor(cols * 0.4)))
          const descSpace = Math.max(6, cols - visibleWidth(title) - (showBadge ? badge.length + 7 : 6))
          rowStr = `  ${active ? "❯" : " "} ${title} ${truncatePlain(item.description, descSpace)}`
        } else {
          const cat = padPlainRight(item.category, 11)
          const title = padPlainRight(item.title, Math.min(28, Math.floor(cols * 0.3)))
          const descSpace = Math.max(8, cols - 48 - badge.length)
          rowStr = `  ${active ? "❯" : " "} ${cat} ${title} ${truncatePlain(item.description, descSpace)}`
        }
        const rightPad = badge ? Math.max(1, cols - visibleWidth(rowStr) - badge.length - 2) : 0
        const full = badge ? `${rowStr}${" ".repeat(rightPad)}${badge}` : truncatePlain(rowStr, cols)
        lines.push(active ? style.selectedRow(padPlainRight(full, cols)) : full)
      }
    }

    while (lines.length < rows - 2) lines.push("")
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    const paletteHint = layout.isCompact
      ? "  ↑/↓ · Enter · Type filter · Esc"
      : "  ↑/↓ navigate · Enter run · Type to filter · Esc close"
    lines.push(style.muted(truncatePlain(paletteHint, cols)))

    raw.write(`${SYNC_START}\x1b[H\x1b[2J${lines.join("\n")}${CURSOR_HIDE}${SYNC_END}`)
  }

  raw.write(ALT_SCREEN_ON)
  return await new Promise<string | undefined>((resolve) => {
    let done = false
    const finish = (id?: string) => {
      if (done) return
      done = true
      cleanup()
      raw.write(ALT_SCREEN_OFF + CURSOR_SHOW)
      resolve(id)
    }

    const onKey = (ev: ParsedKeyEvent) => {
      if (ev.kind === "ctrl" && (ev.key === "c" || ev.key === "p")) {
        finish(undefined)
        return
      }
      if (ev.kind === "ctrl" && ev.key === "n") {
        const len = getFiltered().length
        if (len > 0) selected = (selected + 1) % len
        render()
        return
      }
      if (ev.kind === "ctrl" && ev.key === "p") {
        finish(undefined)
        return
      }
      if (ev.kind === "char") {
        query += ev.text
        selected = 0
        scrollTop = 0
        render()
        return
      }
      if (ev.kind === "key") {
        const filtered = getFiltered()
        if (ev.name === "escape") {
          if (query !== "") {
            query = ""
            selected = 0
            scrollTop = 0
            render()
          } else {
            finish(undefined)
          }
          return
        }
        if (ev.name === "backspace") {
          if (query.length > 0) {
            query = query.slice(0, -1)
            selected = 0
            scrollTop = 0
            render()
          }
          return
        }
        if (ev.name === "up" && filtered.length > 0) {
          selected = (selected - 1 + filtered.length) % filtered.length
          render()
          return
        }
        if (ev.name === "down" && filtered.length > 0) {
          selected = (selected + 1) % filtered.length
          render()
          return
        }
        if (ev.name === "pageup" && filtered.length > 0) {
          selected = Math.max(0, selected - 8)
          render()
          return
        }
        if (ev.name === "pagedown" && filtered.length > 0) {
          selected = Math.min(filtered.length - 1, selected + 8)
          render()
          return
        }
        if (ev.name === "enter" && filtered[selected]) {
          finish(filtered[selected]!.id)
        }
      }
    }

    const cleanup = raw.beginCapture(onKey, render)
    render()
  })
}

export type SessionBrowserResult =
  | { readonly action: "cancel" }
  | { readonly action: "select"; readonly sessionId: string }
  | { readonly action: "new" }
  | { readonly action: "fork"; readonly sessionId: string }
  | { readonly action: "rename"; readonly sessionId: string; readonly title: string }
  | { readonly action: "delete"; readonly sessionId: string }

/**
 * Interactive Session Browser & Switcher inspired by OpenCode's `DialogSessionList`
 * and Claude Code's `/resume` picker.
 */
export async function openSessionBrowser(
  raw: RawTerminalSession,
  style: TuiStyle,
  opts: {
    readonly sessions: readonly SessionRecord[]
    readonly activeSessionId: string
    readonly currentWorkspace: string
  },
): Promise<SessionBrowserResult> {
  let sessions = [...opts.sessions]
  let query = ""
  let allProjects = false
  let showPreview = false
  let selected = 0
  let scrollTop = 0
  let confirmDeleteId: string | undefined
  let renamingId: string | undefined
  let renameDraft = ""

  const visibleList = (): SessionRecord[] => {
    const scoped = allProjects
      ? sessions
      : sessions.filter((s) => path.resolve(s.workspace) === path.resolve(opts.currentWorkspace))
    return fuzzyFilter(
      query,
      scoped,
      (s) =>
        `${s.title} ${s.workspace} ${s.gitBranch ?? ""} ${s.turns.map((t) => t.userPrompt).join(" ")}`,
    )
  }

  const render = () => {
    const layout = raw.layout()
    const cols = layout.cols
    const rows = layout.rows
    const list = visibleList()
    if (selected >= list.length) selected = Math.max(0, list.length - 1)
    const activeItem = list[selected]
    const showPreviewHere = showPreview && activeItem !== undefined && rows >= 18 && cols >= 52
    const previewLinesCount = showPreviewHere ? Math.min(9, Math.max(5, Math.floor(rows * 0.35))) : 0
    const listHeight = Math.max(2, Math.floor((rows - 6 - previewLinesCount) / 2))
    if (selected < scrollTop) scrollTop = selected
    if (selected >= scrollTop + listHeight) scrollTop = selected - listHeight + 1

    const lines: string[] = []
    const scopeLabel = allProjects ? "All projects" : `Workspace: ${path.basename(opts.currentWorkspace)}`
    lines.push(
      truncatePlain(
        style.accentBold("  Sessions") + style.muted(`  · ${scopeLabel} (${list.length})`),
        cols,
      ),
    )
    if (renamingId) {
      lines.push(truncatePlain(`  ${style.yellow("Rename:")} ${renameDraft}`, Math.max(12, cols - 2)) + style.inverse(" "))
    } else {
      lines.push(truncatePlain(`  ${style.accent("/")} ${query || style.muted("Type to search sessions…")}`, cols))
    }
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))

    if (list.length === 0) {
      lines.push(
        style.muted(
          truncatePlain(
            layout.isCompact
              ? "  No sessions. Ctrl+A all · Ctrl+N new"
              : "  No matching sessions found. Press Ctrl+A for all projects or Ctrl+N for a new session.",
            cols,
          ),
        ),
      )
    } else {
      const slice = list.slice(scrollTop, scrollTop + listHeight)
      for (let i = 0; i < slice.length; i += 1) {
        const s = slice[i]!
        const isSel = scrollTop + i === selected
        const isCurrent = s.id === opts.activeSessionId
        const isDeleting = confirmDeleteId === s.id
        const marker = isDeleting ? "!" : isCurrent ? "●" : s.pinned ? "★" : " "
        const titleStr = isDeleting ? "Press Ctrl+D again to confirm delete" : s.title
        const metaParts = [
          formatRelativeTime(s.updatedAt),
          `${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}`,
          ...(s.gitBranch ? [s.gitBranch] : []),
          ...(allProjects ? [path.basename(s.workspace)] : []),
        ]
        const primary = `  ${isSel ? "❯" : " "} ${marker} ${truncatePlain(titleStr, Math.max(14, cols - 10))}`
        const secondary = `      ${truncatePlain(metaParts.join(" · "), Math.max(14, cols - 10))}`
        if (isDeleting && isSel) {
          lines.push(style.red(padPlainRight(primary, cols)))
          lines.push(style.muted(secondary))
        } else if (isSel) {
          lines.push(style.selectedRow(padPlainRight(primary, cols)))
          lines.push(style.accent(secondary))
        } else {
          lines.push(isCurrent ? style.green(primary) : primary)
          lines.push(style.muted(secondary))
        }
      }
    }

    if (showPreviewHere && activeItem) {
      lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
      lines.push(style.cyan(`  Preview: ${truncatePlain(activeItem.title, Math.max(12, cols - 14))}`))
      const previewLines: string[] = []
      for (const turn of activeItem.turns.slice(-3)) {
        previewLines.push(
          `  ${style.bold("User:")} ${truncatePlain(turn.userPrompt.replace(/\n/g, " "), Math.max(12, cols - 10))}`,
        )
        if (turn.assistantText) {
          previewLines.push(`  ${style.muted("Asst:")} ${truncatePlain(turn.assistantText.replace(/\n/g, " "), cols - 10)}`)
        }
      }
      if (previewLines.length === 0) previewLines.push(style.muted("  (empty session — no turns yet)"))
      lines.push(...previewLines.slice(0, previewLinesCount - 2))
    }

    while (lines.length < rows - 2) lines.push("")
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    lines.push(
      style.muted(
        renamingId
          ? "  Enter save name · Esc cancel rename"
          : "  Enter resume · Space preview · ctrl+a scope · ctrl+r rename · ctrl+f fork · ctrl+n new · ctrl+d delete · Esc close",
      ),
    )

    raw.write(`${SYNC_START}\x1b[H\x1b[2J${lines.join("\n")}${CURSOR_HIDE}${SYNC_END}`)
  }

  raw.write(ALT_SCREEN_ON)
  return await new Promise<SessionBrowserResult>((resolve) => {
    let done = false
    const finish = (res: SessionBrowserResult) => {
      if (done) return
      done = true
      cleanup()
      raw.write(ALT_SCREEN_OFF + CURSOR_SHOW)
      resolve(res)
    }

    const onKey = (ev: ParsedKeyEvent) => {
      const list = visibleList()
      const current = list[selected]

      if (renamingId) {
        if (ev.kind === "ctrl" && ev.key === "c") {
          renamingId = undefined
          render()
          return
        }
        if (ev.kind === "char") {
          renameDraft += ev.text
          render()
          return
        }
        if (ev.kind === "key") {
          if (ev.name === "escape") {
            renamingId = undefined
            render()
            return
          }
          if (ev.name === "backspace") {
            renameDraft = renameDraft.slice(0, -1)
            render()
            return
          }
          if (ev.name === "enter") {
            const title = renameDraft.trim()
            const targetId = renamingId
            renamingId = undefined
            if (title) {
              finish({ action: "rename", sessionId: targetId, title })
              return
            }
            render()
          }
        }
        return
      }

      if (ev.kind === "ctrl") {
        if (ev.key !== "d") confirmDeleteId = undefined
        if (ev.key === "c" || ev.key === "o") {
          finish({ action: "cancel" })
          return
        }
        if (ev.key === "a") {
          allProjects = !allProjects
          selected = 0
          scrollTop = 0
          render()
          return
        }
        if (ev.key === "n") {
          finish({ action: "new" })
          return
        }
        if (ev.key === "f" && current) {
          finish({ action: "fork", sessionId: current.id })
          return
        }
        if (ev.key === "r" && current) {
          renamingId = current.id
          renameDraft = current.title
          render()
          return
        }
        if (ev.key === "d" && current) {
          if (confirmDeleteId !== current.id) {
            confirmDeleteId = current.id
            render()
            return
          }
          finish({ action: "delete", sessionId: current.id })
          return
        }
        return
      }

      if (ev.kind === "char") {
        confirmDeleteId = undefined
        if (ev.text === " " && query === "") {
          showPreview = !showPreview
          render()
          return
        }
        query += ev.text
        selected = 0
        scrollTop = 0
        render()
        return
      }

      if (ev.kind === "key") {
        if (ev.name === "escape") {
          if (query !== "") {
            query = ""
            selected = 0
            scrollTop = 0
            render()
          } else {
            finish({ action: "cancel" })
          }
          return
        }
        if (ev.name === "backspace") {
          confirmDeleteId = undefined
          if (query.length > 0) {
            query = query.slice(0, -1)
            selected = 0
            scrollTop = 0
            render()
          }
          return
        }
        if (ev.name === "up" && list.length > 0) {
          confirmDeleteId = undefined
          selected = (selected - 1 + list.length) % list.length
          render()
          return
        }
        if (ev.name === "down" && list.length > 0) {
          confirmDeleteId = undefined
          selected = (selected + 1) % list.length
          render()
          return
        }
        if (ev.name === "enter" && current) {
          finish({ action: "select", sessionId: current.id })
        }
      }
    }

    const cleanup = raw.beginCapture(onKey, render)
    render()
  })
}

export type TimelineResult =
  | { readonly action: "close" }
  | { readonly action: "inspect"; readonly turnIndex: number }
  | { readonly action: "fork"; readonly turnIndex: number }
  | { readonly action: "rewind_conversation"; readonly turnIndex: number }
  | { readonly action: "rewind_all"; readonly turnIndex: number }

/**
 * Interactive Turn Timeline, Checkpoint Rewind (`Esc Esc` / `/rewind`) & Fork navigator.
 */
export async function openTimelineRewind(
  raw: RawTerminalSession,
  style: TuiStyle,
  session: SessionRecord,
): Promise<TimelineResult> {
  const turns = session.turns
  let selected = Math.max(0, turns.length - 1)
  let scrollTop = 0

  const render = () => {
    const layout = raw.layout()
    const cols = layout.cols
    const rows = layout.rows
    const showDetail = rows >= 18 && turns.length > 0
    const detailRows = showDetail ? 7 : 0
    const listHeight = Math.max(2, Math.floor((rows - 5 - detailRows) / 2))
    if (selected < scrollTop) scrollTop = selected
    if (selected >= scrollTop + listHeight) scrollTop = selected - listHeight + 1

    const lines: string[] = []
    lines.push(
      truncatePlain(
        style.accentBold("  Timeline & Rewind") +
          style.muted(`  · ${truncatePlain(session.title, Math.max(12, cols - 28))} (${turns.length} turns)`),
        cols,
      ),
    )
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))

    if (turns.length === 0) {
      lines.push(style.muted("  No turns recorded in this session yet."))
    } else {
      const visible = turns.slice(scrollTop, scrollTop + listHeight)
      for (let i = 0; i < visible.length; i += 1) {
        const idx = scrollTop + i
        const turn: SessionTurn = visible[i]!
        const isSel = idx === selected
        const tag = `[${idx + 1}]`
        const cpTag = turn.checkpoints.length > 0 ? ` · ${turn.checkpoints.length} file checkpoint(s)` : ""
        const title = `  ${isSel ? "❯" : " "} ${tag} ${truncatePlain(turn.userPrompt.replace(/\n/g, " "), Math.max(14, cols - 14))}`
        const sub = `      ${turn.outcome} · ${formatRelativeTime(turn.createdAt)} · ${turn.changedFiles.length} edited · ${turn.commands.length} cmd(s)${cpTag}`
        if (isSel) {
          lines.push(style.selectedRow(padPlainRight(title, cols)))
          lines.push(style.accent(truncatePlain(sub, cols)))
        } else {
          lines.push(title)
          lines.push(style.muted(truncatePlain(sub, cols)))
        }
      }

      const activeTurn = turns[selected]
      if (showDetail && activeTurn) {
        lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
        lines.push(style.cyan(truncatePlain(`  Turn ${selected + 1} Snapshot (${activeTurn.runId})`, cols)))
        lines.push(`  Prompt:    ${truncatePlain(activeTurn.userPrompt.replace(/\n/g, " "), Math.max(12, cols - 14))}`)
        lines.push(`  Response:  ${truncatePlain((activeTurn.assistantText || "(no text)").replace(/\n/g, " "), Math.max(12, cols - 14))}`)
        lines.push(`  Changed:   ${truncatePlain(activeTurn.changedFiles.length > 0 ? activeTurn.changedFiles.join(", ") : "none", Math.max(12, cols - 14))}`)
        lines.push(
          truncatePlain(
            `  Restore:   ${activeTurn.checkpoints.length > 0 ? `${activeTurn.checkpoints.length} pre-edit file snapshot(s) ready` : "conversation only (no file edits in this turn)"}`,
            cols,
          ),
        )
      }
    }

    while (lines.length < rows - 2) lines.push("")
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    const timelineHint =
      cols >= 106
        ? "  ↑/↓ or j/k select · Enter inspect in transcript · f fork here · c rewind chat · r restore files+chat · Esc close"
        : cols >= 68
          ? "  ↑/↓ select · Enter inspect · f fork · c/r rewind · Esc close"
          : "  ↑/↓ · Enter view · f fork · c/r rewind · Esc"
    lines.push(style.muted(truncatePlain(timelineHint, cols)))

    raw.write(`${SYNC_START}\x1b[H\x1b[2J${lines.join("\n")}${CURSOR_HIDE}${SYNC_END}`)
  }

  raw.write(ALT_SCREEN_ON)
  return await new Promise<TimelineResult>((resolve) => {
    let done = false
    const finish = (res: TimelineResult) => {
      if (done) return
      done = true
      cleanup()
      raw.write(ALT_SCREEN_OFF + CURSOR_SHOW)
      resolve(res)
    }

    const onKey = (ev: ParsedKeyEvent) => {
      if (ev.kind === "ctrl" && ev.key === "c") {
        finish({ action: "close" })
        return
      }
      if (ev.kind === "char") {
        if (ev.text === "j" && turns.length > 0) {
          selected = Math.min(turns.length - 1, selected + 1)
          render()
          return
        }
        if (ev.text === "k" && turns.length > 0) {
          selected = Math.max(0, selected - 1)
          render()
          return
        }
        if (ev.text === "f" && turns.length > 0) {
          finish({ action: "fork", turnIndex: selected })
          return
        }
        if (ev.text === "c" && turns.length > 0) {
          finish({ action: "rewind_conversation", turnIndex: selected })
          return
        }
        if (ev.text === "r" && turns.length > 0) {
          finish({ action: "rewind_all", turnIndex: selected })
          return
        }
        if (ev.text === "q") {
          finish({ action: "close" })
          return
        }
        return
      }
      if (ev.kind === "key") {
        if (ev.name === "escape") {
          finish({ action: "close" })
          return
        }
        if (ev.name === "up" && turns.length > 0) {
          selected = Math.max(0, selected - 1)
          render()
          return
        }
        if (ev.name === "down" && turns.length > 0) {
          selected = Math.min(turns.length - 1, selected + 1)
          render()
          return
        }
        if (ev.name === "home" && turns.length > 0) {
          selected = 0
          render()
          return
        }
        if (ev.name === "end" && turns.length > 0) {
          selected = turns.length - 1
          render()
          return
        }
        if (ev.name === "enter" && turns.length > 0) {
          finish({ action: "inspect", turnIndex: selected })
        }
      }
    }

    const cleanup = raw.beginCapture(onKey, render)
    render()
  })
}

/**
 * Scrollable full-transcript & turn-anchor navigator (`Ctrl+T`, `/transcript`, `PgUp`).
 */
export async function openTranscriptViewer(
  raw: RawTerminalSession,
  style: TuiStyle,
  session: SessionRecord,
  initialTurnIndex?: number,
): Promise<void> {
  let expandDetails = true
  let searchMode = false
  let searchQuery = ""
  let scrollTop = 0
  let turnAnchors: number[] = []

  const buildLines = (cols: number): string[] => {
    const out: string[] = []
    turnAnchors = []
    const contentWidth = Math.max(24, cols - 4)
    if (session.turns.length === 0) {
      out.push(style.muted("  No turns recorded in this session yet."))
      return out
    }
    for (let i = 0; i < session.turns.length; i += 1) {
      const turn = session.turns[i]!
      turnAnchors.push(out.length)
      out.push(
        style.accentBold(`  ── Turn ${i + 1} · ${turn.outcome} · ${formatRelativeTime(turn.createdAt)} · ${turn.model} ──`),
      )
      out.push(style.bold("  User:"))
      for (const l of wrapPlainText(turn.userPrompt, contentWidth)) {
        out.push(`    ${l}`)
      }
      if (expandDetails && (turn.actions.length > 0 || turn.commands.length > 0 || turn.changedFiles.length > 0)) {
        out.push(style.cyan("  Actions:"))
        for (const a of turn.actions) {
          const exitInfo = a.exitCode !== undefined && a.exitCode !== null ? ` (exit ${a.exitCode})` : ""
          out.push(style.muted(`    [${a.decision}] ${a.tool}: ${truncatePlain(a.summary, contentWidth - 20)}${exitInfo}`))
        }
      }
      if (turn.assistantText.trim() !== "") {
        out.push(style.green("  Assistant:"))
        for (const l of wrapPlainText(turn.assistantText, contentWidth)) {
          out.push(`    ${l}`)
        }
      }
      if (turn.stopReason) {
        out.push(style.yellow(`  Note: ${truncatePlain(turn.stopReason, contentWidth - 8)}`))
      }
      out.push("")
    }
    return out
  }

  let initializedScroll = false
  const render = () => {
    const cols = raw.cols()
    const rows = raw.rows()
    const body = buildLines(cols)
    const viewportHeight = Math.max(4, rows - 5)
    const maxScroll = Math.max(0, body.length - viewportHeight)
    if (!initializedScroll) {
      initializedScroll = true
      if (initialTurnIndex !== undefined && turnAnchors[initialTurnIndex] !== undefined) {
        scrollTop = Math.min(maxScroll, turnAnchors[initialTurnIndex]!)
      } else {
        scrollTop = maxScroll
      }
    }
    scrollTop = Math.max(0, Math.min(scrollTop, maxScroll))

    const lines: string[] = []
    const pct = maxScroll === 0 ? 100 : Math.round((scrollTop / maxScroll) * 100)
    lines.push(
      truncatePlain(
        style.accentBold("  Transcript") +
          style.muted(`  · ${truncatePlain(session.title, Math.max(12, cols - 30))} · ${pct}%`),
        cols,
      ),
    )
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    const slice = body.slice(scrollTop, scrollTop + viewportHeight)
    lines.push(...slice)
    while (lines.length < rows - 2) lines.push("")
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    if (searchMode) {
      lines.push(
        truncatePlain(
          style.cyan("  Search: ") + `${searchQuery}${style.inverse(" ")}` + style.muted("  (Enter jump · Esc cancel)"),
          cols,
        ),
      )
    } else {
      const txHint =
        cols >= 108
          ? `  ↑/↓ j/k scroll · PgUp/PgDn page · n/p next/prev turn · g/G top/end · e ${expandDetails ? "collapse" : "expand"} tools · / search · q/Esc close`
          : cols >= 70
            ? `  ↑/↓ scroll · PgUp/PgDn · n/p turn · e ${expandDetails ? "less" : "more"} · / search · Esc close`
            : "  ↑/↓ · n/p turn · / find · Esc close"
      lines.push(style.muted(truncatePlain(txHint, cols)))
    }

    raw.write(`${SYNC_START}\x1b[H\x1b[2J${lines.join("\n")}${CURSOR_HIDE}${SYNC_END}`)
  }

  raw.write(ALT_SCREEN_ON)
  return await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      cleanup()
      raw.write(ALT_SCREEN_OFF + CURSOR_SHOW)
      resolve()
    }

    const onKey = (ev: ParsedKeyEvent) => {
      const cols = raw.cols()
      const rows = raw.rows()
      const body = buildLines(cols)
      const viewportHeight = Math.max(4, rows - 5)
      const maxScroll = Math.max(0, body.length - viewportHeight)

      if (searchMode) {
        if (ev.kind === "char") {
          searchQuery += ev.text
          render()
          return
        }
        if (ev.kind === "key") {
          if (ev.name === "escape") {
            searchMode = false
            render()
            return
          }
          if (ev.name === "backspace") {
            searchQuery = searchQuery.slice(0, -1)
            render()
            return
          }
          if (ev.name === "enter") {
            const q = searchQuery.trim().toLowerCase()
            if (q) {
              const found = body.findIndex((l, idx) => idx > scrollTop && l.toLowerCase().includes(q))
              const wrapFound = found !== -1 ? found : body.findIndex((l) => l.toLowerCase().includes(q))
              if (wrapFound !== -1) scrollTop = Math.min(maxScroll, wrapFound)
            }
            searchMode = false
            render()
          }
        }
        return
      }

      if (ev.kind === "ctrl") {
        if (ev.key === "c" || ev.key === "t") {
          finish()
          return
        }
        if (ev.key === "u") {
          scrollTop = Math.max(0, scrollTop - Math.max(1, Math.floor(viewportHeight / 2)))
          render()
          return
        }
        if (ev.key === "d") {
          scrollTop = Math.min(maxScroll, scrollTop + Math.max(1, Math.floor(viewportHeight / 2)))
          render()
          return
        }
        if (ev.key === "e") {
          expandDetails = !expandDetails
          render()
        }
        return
      }

      if (ev.kind === "char") {
        if (ev.text === "q") {
          finish()
          return
        }
        if (ev.text === "j") {
          scrollTop = Math.min(maxScroll, scrollTop + 1)
          render()
          return
        }
        if (ev.text === "k") {
          scrollTop = Math.max(0, scrollTop - 1)
          render()
          return
        }
        if (ev.text === "g") {
          scrollTop = 0
          render()
          return
        }
        if (ev.text === "G") {
          scrollTop = maxScroll
          render()
          return
        }
        if (ev.text === "e") {
          expandDetails = !expandDetails
          render()
          return
        }
        if (ev.text === "/") {
          searchMode = true
          searchQuery = ""
          render()
          return
        }
        if (ev.text === "n") {
          const next = turnAnchors.find((a) => a > scrollTop)
          if (next !== undefined) scrollTop = Math.min(maxScroll, next)
          render()
          return
        }
        if (ev.text === "p") {
          const prev = [...turnAnchors].reverse().find((a) => a < scrollTop)
          if (prev !== undefined) scrollTop = prev
          render()
          return
        }
        if (ev.text === " ") {
          scrollTop = Math.min(maxScroll, scrollTop + viewportHeight)
          render()
          return
        }
        return
      }

      if (ev.kind === "key") {
        if (ev.name === "escape") {
          finish()
          return
        }
        if (ev.name === "up") {
          scrollTop = Math.max(0, scrollTop - 1)
          render()
          return
        }
        if (ev.name === "down") {
          scrollTop = Math.min(maxScroll, scrollTop + 1)
          render()
          return
        }
        if (ev.name === "pageup") {
          scrollTop = Math.max(0, scrollTop - viewportHeight)
          render()
          return
        }
        if (ev.name === "pagedown") {
          scrollTop = Math.min(maxScroll, scrollTop + viewportHeight)
          render()
          return
        }
        if (ev.name === "home") {
          scrollTop = 0
          render()
          return
        }
        if (ev.name === "end") {
          scrollTop = maxScroll
          render()
        }
      }
    }

    const cleanup = raw.beginCapture(onKey, render)
    render()
  })
}

/** Generic scrollable text modal used by `/diff` and `/help`. */
export async function openScrollableModal(
  raw: RawTerminalSession,
  style: TuiStyle,
  title: string,
  bodyLines: readonly string[],
): Promise<void> {
  let scrollTop = 0
  const getWrappedLines = (cols: number) => bodyLines.flatMap((l) => wrapStyledLine(l, Math.max(16, cols - 2)))
  const render = () => {
    const layout = raw.layout()
    const cols = layout.cols
    const rows = layout.rows
    const wrapped = getWrappedLines(cols)
    const viewportHeight = Math.max(4, rows - 5)
    const maxScroll = Math.max(0, wrapped.length - viewportHeight)
    scrollTop = Math.max(0, Math.min(scrollTop, maxScroll))
    const lines: string[] = [
      style.accentBold(truncatePlain(`  ${title}`, cols)),
      style.dim("  " + "─".repeat(Math.max(10, cols - 4))),
      ...wrapped.slice(scrollTop, scrollTop + viewportHeight),
    ]
    while (lines.length < rows - 2) lines.push("")
    lines.push(style.dim("  " + "─".repeat(Math.max(10, cols - 4))))
    const hint = layout.isCompact
      ? "  ↑/↓ · PgUp/Dn · q/Esc"
      : "  ↑/↓ j/k scroll · PgUp/PgDn page · g/G top/end · q/Esc close"
    lines.push(style.muted(truncatePlain(hint, cols)))
    raw.write(`${SYNC_START}\x1b[H\x1b[2J${lines.join("\n")}${CURSOR_HIDE}${SYNC_END}`)
  }

  raw.write(ALT_SCREEN_ON)
  return await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      cleanup()
      raw.write(ALT_SCREEN_OFF + CURSOR_SHOW)
      resolve()
    }
    const onKey = (ev: ParsedKeyEvent) => {
      const cols = raw.cols()
      const rows = raw.rows()
      const wrapped = getWrappedLines(cols)
      const viewportHeight = Math.max(4, rows - 5)
      const maxScroll = Math.max(0, wrapped.length - viewportHeight)
      if (ev.kind === "ctrl" && ev.key === "c") return finish()
      if (ev.kind === "char") {
        if (ev.text === "q") return finish()
        if (ev.text === "j") scrollTop = Math.min(maxScroll, scrollTop + 1)
        else if (ev.text === "k") scrollTop = Math.max(0, scrollTop - 1)
        else if (ev.text === "g") scrollTop = 0
        else if (ev.text === "G") scrollTop = maxScroll
        render()
        return
      }
      if (ev.kind === "key") {
        if (ev.name === "escape") return finish()
        if (ev.name === "up") scrollTop = Math.max(0, scrollTop - 1)
        else if (ev.name === "down") scrollTop = Math.min(maxScroll, scrollTop + 1)
        else if (ev.name === "pageup") scrollTop = Math.max(0, scrollTop - viewportHeight)
        else if (ev.name === "pagedown") scrollTop = Math.min(maxScroll, scrollTop + viewportHeight)
        else if (ev.name === "home") scrollTop = 0
        else if (ev.name === "end") scrollTop = maxScroll
        render()
      }
    }
    const cleanup = raw.beginCapture(onKey, render)
    render()
  })
}
