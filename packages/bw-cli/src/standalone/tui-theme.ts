/**
 * Pure Node 22+ ANSI styling, DEC synchronized rendering, terminal width measurement,
 * and raw-mode keyboard/paste sequence parser for the standalone Bashwink TUI.
 *
 * Zero external dependencies and zero literal control bytes in source regexes.
 */

export const SYNC_START = "\x1b[?2026h"
export const SYNC_END = "\x1b[?2026l"
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[2J\x1b[H"
export const ALT_SCREEN_OFF = "\x1b[?1049l"
export const BRACKETED_PASTE_ON = "\x1b[?2004h"
export const BRACKETED_PASTE_OFF = "\x1b[?2004l"
export const CURSOR_HIDE = "\x1b[?25l"
export const CURSOR_SHOW = "\x1b[?25h"

/**
 * Escape sequence that puts the terminal back into a usable state after an abnormal exit
 * (uncaught exception, SIGTERM, or `process.exit` while a TUI surface is open). Without it
 * the terminal keeps raw mode and the alternate screen, which looks like a frozen window
 * that ignores Ctrl+C until it is closed.
 */
export function terminalRestoreSequence(inAltScreen: boolean): string {
  return `${inAltScreen ? ALT_SCREEN_OFF : ""}${CURSOR_SHOW}${BRACKETED_PASTE_OFF}`
}

export function colorsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): boolean {
  if (!isTTY) return false
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false
  if (env["TERM"] === "dumb") return false
  return true
}

function wrapAnsi(open: string, close: string, text: string, enabled: boolean): string {
  if (!enabled || text === "") return text
  return `${open}${text}${close}`
}

export interface TuiStyle {
  readonly enabled: boolean
  bold(s: string): string
  dim(s: string): string
  italic(s: string): string
  inverse(s: string): string
  accent(s: string): string
  accentBold(s: string): string
  muted(s: string): string
  green(s: string): string
  red(s: string): string
  yellow(s: string): string
  cyan(s: string): string
  blue(s: string): string
  violet(s: string): string
  rule(s: string): string
  badge(s: string): string
  promptCap(s: string): string
  selectedRow(s: string): string
  diffLine(line: string): string
}

export function createStyle(enabled: boolean): TuiStyle {
  return {
    enabled,
    bold: (s) => wrapAnsi("\x1b[1m", "\x1b[22m", s, enabled),
    dim: (s) => wrapAnsi("\x1b[2m", "\x1b[22m", s, enabled),
    italic: (s) => wrapAnsi("\x1b[3m", "\x1b[23m", s, enabled),
    inverse: (s) => wrapAnsi("\x1b[7m", "\x1b[27m", s, enabled),
    accent: (s) => wrapAnsi("\x1b[38;5;155m", "\x1b[39m", s, enabled),
    accentBold: (s) => wrapAnsi("\x1b[1;38;5;155m", "\x1b[22;39m", s, enabled),
    muted: (s) => wrapAnsi("\x1b[38;5;250m", "\x1b[39m", s, enabled),
    green: (s) => wrapAnsi("\x1b[38;5;155m", "\x1b[39m", s, enabled),
    red: (s: string) => wrapAnsi("\x1b[38;5;203m", "\x1b[39m", s, enabled),
    yellow: (s) => wrapAnsi("\x1b[38;5;221m", "\x1b[39m", s, enabled),
    cyan: (s) => wrapAnsi("\x1b[38;5;80m", "\x1b[39m", s, enabled),
    blue: (s) => wrapAnsi("\x1b[38;5;111m", "\x1b[39m", s, enabled),
    violet: (s) => wrapAnsi("\x1b[38;5;177m", "\x1b[39m", s, enabled),
    rule: (s) => wrapAnsi("\x1b[38;5;243m", "\x1b[39m", s, enabled),
    badge: (s) => wrapAnsi("\x1b[48;5;236;38;5;253m", "\x1b[49;39m", s, enabled),
    promptCap: (s) => wrapAnsi("\x1b[38;5;235m", "\x1b[39m", s, enabled),
    selectedRow: (s) => wrapAnsi("\x1b[48;5;237;38;5;255m", "\x1b[49;39m", s, enabled),
    diffLine: (line) => {
      if (!enabled) return line
      if (line.startsWith("+++") || line.startsWith("---"))
        return wrapAnsi("\x1b[1;38;5;250m", "\x1b[22;39m", line, true)
      if (line.startsWith("@@")) return wrapAnsi("\x1b[38;5;80m", "\x1b[39m", line, true)
      if (line.startsWith("+")) return wrapAnsi("\x1b[38;5;114m", "\x1b[39m", line, true)
      if (line.startsWith("-")) return wrapAnsi("\x1b[38;5;203m", "\x1b[39m", line, true)
      return line
    },
  }
}

/** Strip CSI/OSC/control ANSI sequences from a string without literal control bytes in regexes. */
export function stripAnsiSequences(text: string): string {
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
    out += text[i]
    i += 1
  }
  return out
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}

export function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return 0
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
  // Combining diacritical marks & variation selectors
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  ) {
    return 0
  }
  return isWideCodePoint(cp) ? 2 : 1
}

export function visibleWidth(text: string): number {
  const plain = stripAnsiSequences(text)
  let width = 0
  for (const ch of plain) {
    width += charDisplayWidth(ch)
  }
  return width
}

export function truncatePlain(text: string, maxCols: number): string {
  if (maxCols <= 0) return ""
  const plain = stripAnsiSequences(text)
  if (visibleWidth(plain) <= maxCols) return plain
  if (maxCols === 1) return "…"
  let width = 0
  let out = ""
  for (const ch of plain) {
    const w = charDisplayWidth(ch)
    if (width + w > maxCols - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

export function padPlainRight(text: string, cols: number): string {
  const truncated = truncatePlain(text, cols)
  const w = visibleWidth(truncated)
  return w < cols ? truncated + " ".repeat(cols - w) : truncated
}

export function alignRight(left: string, right: string, cols: number): string {
  if (!right) return left
  return `${left}${" ".repeat(Math.max(1, cols - visibleWidth(left) - visibleWidth(right)))}${right}`
}

export interface SessionStatus {
  readonly model: string
  readonly mode: string
  readonly readOnly: boolean
  readonly requests: number
  readonly requestLimit?: number
  readonly context?: { readonly tokens: number; readonly limit: number }
}

export function renderSessionStatus(status: SessionStatus, cols: number, style: TuiStyle): string {
  const sep = style.rule(cols < 100 ? " │ " : "  │  ")
  const mode = cols < 40
    ? status.mode === "accept-edits" ? "EDITS" : status.mode.toUpperCase()
    : `${status.mode.toUpperCase()} MODE`
  const access = status.readOnly ? style.yellow("Read-only") : ""
  const modeColor = status.mode === "auto" ? style.yellow
    : status.mode === "accept-edits" ? style.cyan : style.accent
  const permission = [modeColor(mode), access].filter(Boolean).join(" · ")
  const requests = `Requests ${status.requests}${status.requestLimit === undefined ? "" : `/${status.requestLimit}`}`
  const shortTokens = (tokens: number) =>
    tokens >= 1000 ? `${Number((tokens / 1000).toFixed(1))}k` : String(tokens)
  const context = status.context
  const percent = context ? Math.round((context.tokens / context.limit) * 100) : 0
  const filled = Math.min(16, Math.round(percent * 16 / 100))
  const meter = `${style.yellow("█".repeat(filled))}${style.rule("░".repeat(16 - filled))}`
  const contextText = context
    ? `Context ~${shortTokens(context.tokens)}/${shortTokens(context.limit)} target (${percent}%)` : ""
  const fullContext = context ? `${contextText}  [${meter}]` : ""
  const fullWidth = (parts: string[]) => visibleWidth(parts.join(sep))
  const availableModelWidth = cols - fullWidth(["", permission])
  if (availableModelWidth < 4) return style.yellow(truncatePlain(stripAnsiSequences(permission), cols))
  const minModelWidth = Math.min(visibleWidth(status.model), cols < 100 ? 8 : 16, availableModelWidth)
  const telemetry = [[fullContext, requests], [contextText, requests], [requests]]
    .map((parts) => parts.filter(Boolean))
    .find((parts) => fullWidth([...parts, "", permission]) + minModelWidth <= cols) ?? []
  const modelWidth = cols - fullWidth([...telemetry, "", permission])
  const model = truncatePlain(status.model, modelWidth)
  const left = [...telemetry, model, permission].join(sep)

  const hints = ["ctrl+p commands", "ctrl+o sessions", "shift+tab mode"]
  while (hints.length > 0 && visibleWidth(left) + 3 + visibleWidth(hints.join(" · ")) > cols) hints.pop()
  return alignRight(left, style.muted(hints.join(" · ")), cols)
}

export function renderActivityRow(
  action: string,
  target: string,
  detail: string,
  cols: number,
  style: TuiStyle,
): string {
  const prefix = `${style.rule("  ├─")} ▫  ${style.accentBold(padPlainRight(action, 5))}  `
  const fitTarget = action === "Run" ? truncatePlain : truncatePathMiddle
  const targetWidth = cols - visibleWidth(prefix) - (detail ? visibleWidth(detail) + 1 : 0)
  if (targetWidth < 4) {
    const separateDetail = visibleWidth(detail) <= cols - 5 ? detail : truncatePlain(detail, cols - 5)
    return `${prefix}${style.muted(fitTarget(target, cols - visibleWidth(prefix)))}${detail ? `\n     ${separateDetail}` : ""}`
  }
  return alignRight(`${prefix}${style.muted(fitTarget(target, targetWidth))}`, detail, cols)
}

/**
 * Fill a styled row cleanly to `cols` width with OpenCode's subtle raised prompt surface (`#212121` / `48;5;235`).
 */
export function paintPromptSurfaceRow(styledRow: string, cols: number, enabled: boolean): string {
  const w = visibleWidth(styledRow)
  const pad = w < cols ? " ".repeat(cols - w) : ""
  if (!enabled) return `${styledRow}${pad}`
  const safeInner = styledRow.split("\x1b[49m").join("\x1b[48;5;235m")
  return `\x1b[48;5;235m${safeInner}${pad}\x1b[49m`
}

export function wrapPlainText(text: string, maxCols: number): string[] {
  const width = Math.max(12, maxCols)
  const out: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      out.push("")
      continue
    }
    let current = ""
    let currentW = 0
    for (const ch of rawLine) {
      const cw = charDisplayWidth(ch)
      if (currentW + cw > width && current.length > 0) {
        out.push(current)
        current = ch
        currentW = cw
      } else {
        current += ch
        currentW += cw
      }
    }
    out.push(current)
  }
  return out
}

export type TerminalSizeTier = "compact" | "standard" | "wide"

export interface TerminalLayout {
  readonly cols: number
  readonly rows: number
  readonly tier: TerminalSizeTier
  readonly isCompact: boolean
  readonly isNarrow: boolean
  readonly isShort: boolean
  readonly isWide: boolean
  readonly boxWidth: number
  readonly contentWidth: number
}

/** Compute responsive terminal breakpoints modeled on adaptive CLI TUI layout tiers. */
export function getTerminalLayout(colsInput: number, rowsInput: number): TerminalLayout {
  const cols = Math.max(20, Math.floor(Number.isFinite(colsInput) ? colsInput : 100))
  const rows = Math.max(8, Math.floor(Number.isFinite(rowsInput) ? rowsInput : 30))
  const isCompact = cols < 60
  const isNarrow = cols < 72
  const isShort = rows < 22
  const isWide = cols >= 108
  const tier: TerminalSizeTier =
    cols < 60 || rows < 18 ? "compact" : cols >= 108 && rows >= 24 ? "wide" : "standard"
  const boxWidth = Math.max(24, Math.min(cols - 1, 100))
  const contentWidth = Math.max(18, boxWidth - 4)
  return {
    cols,
    rows,
    tier,
    isCompact,
    isNarrow,
    isShort,
    isWide,
    boxWidth,
    contentWidth,
  }
}

/** Preserve leading anchor & trailing filename/segment when truncating narrow paths. */
export function truncatePathMiddle(text: string, maxCols: number): string {
  const plain = stripAnsiSequences(text)
  if (maxCols <= 0) return ""
  if (visibleWidth(plain) <= maxCols) return plain
  if (maxCols <= 5) return truncatePlain(plain, maxCols)
  const chars = Array.from(plain)
  const headBudget = Math.floor((maxCols - 1) * 0.35)
  const head = truncatePlain(plain, headBudget + 1).slice(0, -1)
  const tailBudget = maxCols - visibleWidth(head) - 1
  let width = 0
  let tail = ""
  for (const ch of chars.reverse()) {
    width += charDisplayWidth(ch)
    if (width > tailBudget) break
    tail = ch + tail
  }
  return `${head}…${tail}`
}

/** Wrap a single possibly-ANSI-styled line to <= `maxCols` display cells cleanly. */
export function wrapStyledLine(line: string, maxCols: number): string[] {
  const width = Math.max(12, maxCols)
  if (line === "") return [""]
  if (visibleWidth(line) <= width) return [line]
  return wrapPlainText(stripAnsiSequences(line), width)
}

export interface WrappedComposerView {
  readonly visualRows: readonly string[]
  readonly visualCursorRow: number
  readonly visualCursorCol: number
}

/**
 * Wrap logical composer lines into physical rows fitting strictly within `maxCols`
 * so terminal resize or long inputs never desync cursor-up positioning.
 */
export function wrapComposerLines(
  bufLines: readonly { readonly line: string }[],
  cursorRow: number,
  cursorCol: number,
  firstPrefix: string,
  contPrefix: string,
  placeholder: string,
  searchingHistory: boolean,
  maxCols: number,
  formatFirstPrefix: (s: string) => string = (s) => s,
  formatContPrefix: (s: string) => string = (s) => s,
  formatPlaceholder: (s: string) => string = (s) => s,
): WrappedComposerView {
  const visualRows: string[] = []
  let visualCursorRow = 0
  let visualCursorCol = visibleWidth(firstPrefix)
  const limit = Math.max(16, maxCols)

  if (bufLines.length === 1 && bufLines[0]!.line === "" && !searchingHistory) {
    const pfxW = visibleWidth(firstPrefix)
    const msg = truncatePlain(placeholder, Math.max(6, limit - pfxW))
    visualRows.push(`${formatFirstPrefix(firstPrefix)}${formatPlaceholder(msg)}`)
    return { visualRows, visualCursorRow: 0, visualCursorCol: pfxW }
  }

  for (let i = 0; i < bufLines.length; i += 1) {
    const rawPfx = i === 0 ? firstPrefix : contPrefix
    const fmtPfx = i === 0 ? formatFirstPrefix : formatContPrefix
    const pfxW = visibleWidth(rawPfx)
    const avail = Math.max(6, limit - pfxW)
    const lineStr = bufLines[i]!.line
    const chars = Array.from(lineStr)

    if (chars.length === 0) {
      if (i === cursorRow) {
        visualCursorRow = visualRows.length
        visualCursorCol = pfxW
      }
      visualRows.push(fmtPfx(rawPfx))
      continue
    }

    let chunk = ""
    let chunkW = 0
    let segmentStartIdx = 0
    let firstSeg = true

    for (let idx = 0; idx < chars.length; idx += 1) {
      const ch = chars[idx]!
      const w = charDisplayWidth(ch)
      if (chunkW + w > avail && chunk.length > 0) {
        if (i === cursorRow && cursorCol >= segmentStartIdx && cursorCol < idx) {
          visualCursorRow = visualRows.length
          visualCursorCol = pfxW + visibleWidth(chars.slice(segmentStartIdx, cursorCol).join(""))
        }
        const segPfx = firstSeg ? fmtPfx(rawPfx) : formatContPrefix(contPrefix)
        visualRows.push(`${segPfx}${chunk}`)
        chunk = ch
        chunkW = w
        segmentStartIdx = idx
        firstSeg = false
      } else {
        chunk += ch
        chunkW += w
      }
    }

    if (i === cursorRow && cursorCol >= segmentStartIdx) {
      visualCursorRow = visualRows.length
      visualCursorCol =
        pfxW +
        visibleWidth(chars.slice(segmentStartIdx, Math.min(cursorCol, chars.length)).join(""))
    }
    const segPfx = firstSeg ? fmtPfx(rawPfx) : formatContPrefix(contPrefix)
    visualRows.push(`${segPfx}${chunk}`)
  }

  return { visualRows, visualCursorRow, visualCursorCol }
}

export interface PromptMetadataInput {
  readonly agent?: string
  readonly model: string
  readonly provider?: string
  readonly variant?: string
  readonly permissionMode?: string
  readonly trustLabel?: string
  readonly trusted?: boolean
}

/**
 * Progressive prompt metadata bar ported from OpenCode v2.3.2
 * (`packages/tui/src/component/prompt/metadata.tsx`, MIT license, Copyright (c) 2025 opencode).
 */
export function formatPromptMetadata(
  input: PromptMetadataInput,
  maxWidth: number,
  style: TuiStyle,
): string {
  const width = Math.max(12, maxWidth)
  const agent = width < 40 ? undefined : input.agent
  const provider = width < 40 ? undefined : input.provider
  const modeTag = input.permissionMode ? `mode:${input.permissionMode}` : undefined
  const candidates: Array<{
    agent?: string | undefined
    model: string
    provider?: string | undefined
    variant?: string | undefined
    mode?: string | undefined
    trust?: string | undefined
  }> = [
    {
      agent,
      model: input.model,
      provider,
      variant: input.variant,
      mode: modeTag,
      trust: input.trustLabel,
    },
    {
      agent,
      model: input.model,
      provider: provider?.split(" / ").at(-1),
      variant: input.variant,
      mode: modeTag,
      trust: input.trustLabel,
    },
    { agent, model: input.model, mode: modeTag, trust: input.trustLabel },
    { agent, model: input.model, mode: input.permissionMode },
    { agent, model: input.model },
  ]
  const plainLen = (c: (typeof candidates)[number]) =>
    [c.agent, c.model, c.provider, c.variant, c.mode, c.trust].filter(Boolean).join(" · ").length

  let chosen = candidates.find((c) => plainLen(c) <= width)
  if (!chosen) {
    const pfxLen = agent ? agent.length + 3 : 0
    chosen = {
      ...(agent ? { agent } : {}),
      model: truncatePlain(input.model, Math.max(9, width - pfxLen)),
    }
  }

  const segs: string[] = []
  if (chosen.agent) segs.push(style.cyan(chosen.agent))
  segs.push(style.bold(chosen.model))
  if (chosen.provider) segs.push(style.muted(chosen.provider))
  if (chosen.variant) segs.push(style.yellow(chosen.variant))
  if (chosen.mode) {
    const m = input.permissionMode
    if (m === "smart") segs.push(style.accentBold(chosen.mode))
    else if (m === "auto") segs.push(style.yellow(chosen.mode))
    else if (m === "accept-edits") segs.push(style.cyan(chosen.mode))
    else if (m === "ask") segs.push(style.green(chosen.mode))
    else segs.push(style.muted(chosen.mode))
  }
  if (chosen.trust)
    segs.push(input.trusted ? style.green(chosen.trust) : style.yellow(chosen.trust))
  return segs.join(style.dim(" · "))
}

export interface StatusFooterInput {
  readonly location: string
  readonly statusMessage?: string
  readonly turnsCount?: number
  readonly tokensText?: string
  readonly costText?: string
  readonly shortcuts: readonly { readonly key: string; readonly label: string }[]
}

/**
 * Two-column progressive footer statusline ported from OpenCode v2.3.2
 * (`packages/tui/src/mini/footer.width.ts` & `component/prompt/index.tsx`, MIT license).
 */
export function formatStatusFooterLine(
  input: StatusFooterInput,
  totalCols: number,
  style: TuiStyle,
): string {
  const cols = Math.max(20, totalCols)
  const hasTransient = Boolean(input.statusMessage && input.statusMessage !== "")
  const rawLeft = hasTransient ? input.statusMessage! : input.location
  const leftPlainMax = Math.max(12, Math.floor(cols * 0.48))
  const leftPlain = hasTransient
    ? truncatePlain(rawLeft, Math.min(cols - 2, leftPlainMax + 14))
    : truncatePathMiddle(rawLeft, leftPlainMax)
  const styledLeft = hasTransient ? style.yellow(leftPlain) : style.muted(leftPlain)
  const availRight = Math.max(0, cols - visibleWidth(leftPlain) - 2)
  if (availRight < 6) {
    return hasTransient
      ? style.yellow(truncatePlain(rawLeft, cols))
      : style.muted(truncatePathMiddle(rawLeft, cols))
  }

  const selected: Array<{ id: string; plain: string; styled: string }> = []
  const candidates: Array<{ id: string; plain: string; styled: string }> = []
  if (input.turnsCount !== undefined) {
    const tStr = `${input.turnsCount}t`
    candidates.push({ id: "turns", plain: tStr, styled: style.muted(tStr) })
  }
  if (input.tokensText) {
    candidates.push({
      id: "tokens",
      plain: input.tokensText,
      styled: style.muted(input.tokensText),
    })
  }
  if (input.costText) {
    candidates.push({ id: "cost", plain: input.costText, styled: style.muted(input.costText) })
  }
  for (let i = 0; i < input.shortcuts.length; i += 1) {
    const sc = input.shortcuts[i]!
    const plain = `${sc.key} ${sc.label}`
    const styled = `${style.bold(sc.key)} ${style.muted(sc.label)}`
    candidates.push({ id: `sc_${i}`, plain, styled })
  }

  const sep = " · "
  for (const cand of candidates) {
    const nextList = [...selected, cand]
    const totalPlain = nextList.map((s) => s.plain).join(sep)
    if (visibleWidth(totalPlain) <= availRight) {
      selected.push(cand)
    } else {
      break
    }
  }

  if (selected.length === 0) return styledLeft
  const rightPlainLen = visibleWidth(selected.map((s) => s.plain).join(sep))
  const gap = Math.max(2, cols - visibleWidth(leftPlain) - rightPlainLen)
  const rightStyled = selected.map((s) => s.styled).join(style.dim(sep))
  return `${styledLeft}${" ".repeat(gap)}${rightStyled}`
}

export interface DiffChangeCounts {
  readonly additions: number
  readonly deletions: number
}

interface ParsedDiffRow {
  readonly kind: "hunk" | "context" | "removed" | "added" | "note"
  readonly oldLine?: number
  readonly newLine?: number
  readonly text: string
}

/** Count added and deleted code lines in a unified patch (excluding `+++` / `---` headers). */
export function countDiffChanges(patch: string): DiffChangeCounts {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

function parsePatchRows(patch: string): ParsedDiffRow[] {
  const rows: ParsedDiffRow[] = []
  let oldNum = 1
  let newNum = 1

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (hunkMatch) {
      oldNum = Math.max(1, Number(hunkMatch[1]))
      newNum = Math.max(1, Number(hunkMatch[2]))
      rows.push({ kind: "hunk", text: raw })
      continue
    }
    const legacyLineMatch = /^@@ line (\d+) @@$/.exec(raw)
    if (legacyLineMatch) {
      oldNum = Math.max(1, Number(legacyLineMatch[1]))
      newNum = oldNum
      rows.push({ kind: "hunk", text: raw })
      continue
    }
    if (raw.startsWith("+ ")) {
      rows.push({ kind: "added", newLine: newNum, text: raw.slice(2) })
      newNum += 1
      continue
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "added", newLine: newNum, text: raw.slice(1) })
      newNum += 1
      continue
    }
    if (raw.startsWith("- ")) {
      rows.push({ kind: "removed", oldLine: oldNum, text: raw.slice(2) })
      oldNum += 1
      continue
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "removed", oldLine: oldNum, text: raw.slice(1) })
      oldNum += 1
      continue
    }
    if (raw.startsWith("  ")) {
      rows.push({ kind: "context", oldLine: oldNum, newLine: newNum, text: raw.slice(2) })
      oldNum += 1
      newNum += 1
      continue
    }
    if (raw.startsWith(" ")) {
      rows.push({ kind: "context", oldLine: oldNum, newLine: newNum, text: raw.slice(1) })
      oldNum += 1
      newNum += 1
      continue
    }
    if (raw.startsWith("...")) {
      rows.push({ kind: "note", text: raw })
    }
  }
  return rows
}

export function renderTranscriptDiff(patch: string, cols: number, style: TuiStyle): string[] {
  const indent = "     "
  const width = Math.max(8, cols - indent.length - 2)
  const border = (left: string, right: string) => `${indent}${style.rule(`${left}${"─".repeat(width)}${right}`)}`
  const lines = parsePatchRows(patch).map(({ kind, text }) => {
    const sign = kind === "added" ? "+" : kind === "removed" ? "-" : " "
    const marker = sign === "+" ? style.green(sign) : sign === "-" ? style.red(sign) : sign
    const code = text.replace(/\t/g, "    ")
    const row = kind === "hunk" || kind === "note"
      ? style.muted(` ${padPlainRight(code, width - 1)}`)
      : ` ${marker}  ${padPlainRight(code, width - 4)}`
    const background = kind === "added" ? "22" : kind === "removed" ? "52" : "235"
    return `${indent}${style.rule("│")}${wrapAnsi(`\x1b[48;5;${background}m`, "\x1b[49m", row, style.enabled)}${style.rule("│")}`
  })
  return [border("╭", "╮"), ...lines, border("╰", "╯")]
}

function highlightInlineDiffPair(
  oldText: string,
  newText: string,
  widthLimit: number,
  style: TuiStyle,
): { readonly oldRendered: string; readonly newRendered: string } {
  const a = truncatePlain(oldText, widthLimit)
  const b = truncatePlain(newText, widthLimit)
  if (!style.enabled || a === b) {
    return { oldRendered: a, newRendered: b }
  }
  const ac = Array.from(a)
  const bc = Array.from(b)
  let prefix = 0
  while (prefix < ac.length && prefix < bc.length && ac[prefix] === bc[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < ac.length - prefix &&
    suffix < bc.length - prefix &&
    ac[ac.length - 1 - suffix] === bc[bc.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const paintPair = (chars: string[], isAdd: boolean): string => {
    const head = chars.slice(0, prefix).join("")
    const mid = chars.slice(prefix, chars.length - suffix).join("")
    const tail = suffix > 0 ? chars.slice(-suffix).join("") : ""
    const baseOpen = isAdd ? "\x1b[38;5;114;48;5;22m" : "\x1b[38;5;203;48;5;52m"
    const hiOpen = isAdd ? "\x1b[1;38;5;156;48;5;28m" : "\x1b[1;38;5;217;48;5;88m"
    const reset = "\x1b[22;39;49m"
    return `${baseOpen}${head}${mid ? `${hiOpen}${mid}${baseOpen}` : ""}${tail}${reset}`
  }
  return {
    oldRendered: paintPair(ac, false),
    newRendered: paintPair(bc, true),
  }
}

export interface OpenCodeDiffOptions {
  readonly path: string
  readonly create?: boolean | undefined
  readonly maxWidth?: number | undefined
  readonly view?: "auto" | "unified" | "split" | undefined
}

/**
 * Render an OpenCode-inspired diff card (`← Edit <path>  +X -Y`) with line-numbered gutters,
 * subtle row tinting, inline changed-token highlights, and automatic split-vs-unified layout
 * modeled on OpenCode v2.3.2 (`component/patch-diff.tsx` & `routes/session/index.tsx`, MIT).
 */
export function renderOpenCodeDiff(
  patch: string,
  options: OpenCodeDiffOptions,
  style: TuiStyle,
): string[] {
  const maxWidth = Math.max(36, options.maxWidth ?? 90)
  const counts = countDiffChanges(patch)
  const rows = parsePatchRows(patch)
  const useSplit =
    options.view === "split"
      ? true
      : options.view === "unified"
        ? false
        : maxWidth >= 96 && !options.create

  const badgeParts: string[] = []
  if (counts.additions > 0) badgeParts.push(style.green(`+${counts.additions}`))
  if (counts.deletions > 0) badgeParts.push(style.red(`-${counts.deletions}`))
  const badgeStr = badgeParts.length > 0 ? `  ${badgeParts.join(" ")}` : ""
  const actionLabel = options.create ? "# Created" : "← Edit"
  const rail = style.accent("┃ ")
  const titleText = `${style.cyan(actionLabel)} ${style.bold(truncatePathMiddle(options.path, Math.max(16, maxWidth - 22)))}${badgeStr}`

  const maxLineNum = Math.max(1, ...rows.map((r) => Math.max(r.oldLine ?? 1, r.newLine ?? 1)))
  const numWidth = Math.max(2, String(maxLineNum).length)
  const out: string[] = [`${rail}${titleText}`]

  const tintLine = (
    kind: "added" | "removed" | "context",
    num: string,
    sign: string,
    code: string,
    rowW: number,
  ): string => {
    if (!style.enabled) {
      return `${rail}${num} ${sign} ${truncatePlain(code, Math.max(12, rowW - numWidth - 6))}`
    }
    if (kind === "added") {
      return `${rail}\x1b[38;5;244;48;5;22m${num}\x1b[38;5;114m + \x1b[0m\x1b[48;5;22m${code}\x1b[49m`
    }
    if (kind === "removed") {
      return `${rail}\x1b[38;5;244;48;5;52m${num}\x1b[38;5;203m - \x1b[0m\x1b[48;5;52m${code}\x1b[49m`
    }
    return `${rail}${style.dim(num)}   ${code}`
  }

  // Group contiguous removed+added runs so single pairs get inline word/token highlights
  let idx = 0
  while (idx < rows.length) {
    const row = rows[idx]!
    if (row.kind === "hunk") {
      out.push(`${rail}${style.cyan(truncatePlain(row.text, Math.max(16, maxWidth - 4)))}`)
      idx += 1
      continue
    }
    if (row.kind === "note") {
      out.push(`${rail}${style.muted(truncatePlain(row.text, Math.max(16, maxWidth - 4)))}`)
      idx += 1
      continue
    }
    if (row.kind === "context") {
      const nStr = String(row.newLine ?? row.oldLine ?? "").padStart(numWidth, " ")
      if (useSplit) {
        const halfW = Math.max(16, Math.floor((maxWidth - 7) / 2))
        const leftTxt = padPlainRight(`${nStr}   ${row.text}`, halfW)
        const rightTxt = truncatePlain(`${nStr}   ${row.text}`, halfW)
        out.push(`${rail}${style.dim(leftTxt)} ${style.dim("│")} ${rightTxt}`)
      } else {
        out.push(
          tintLine(
            "context",
            nStr,
            " ",
            truncatePlain(row.text, Math.max(12, maxWidth - numWidth - 6)),
            maxWidth,
          ),
        )
      }
      idx += 1
      continue
    }

    // Gather contiguous removed + added block
    const removedRun: ParsedDiffRow[] = []
    const addedRun: ParsedDiffRow[] = []
    while (idx < rows.length && rows[idx]!.kind === "removed") {
      removedRun.push(rows[idx]!)
      idx += 1
    }
    while (idx < rows.length && rows[idx]!.kind === "added") {
      addedRun.push(rows[idx]!)
      idx += 1
    }

    const codeAvail = useSplit
      ? Math.max(12, Math.floor((maxWidth - 9) / 2) - numWidth - 3)
      : Math.max(16, maxWidth - numWidth - 6)

    if (useSplit) {
      const pairCount = Math.max(removedRun.length, addedRun.length)
      const halfW = Math.max(16, Math.floor((maxWidth - 7) / 2))
      for (let k = 0; k < pairCount; k += 1) {
        const r = removedRun[k]
        const a = addedRun[k]
        const pairHi =
          r && a && removedRun.length === addedRun.length
            ? highlightInlineDiffPair(r.text, a.text, codeAvail, style)
            : undefined
        const leftNum = r ? String(r.oldLine ?? "").padStart(numWidth, " ") : " ".repeat(numWidth)
        const rightNum = a ? String(a.newLine ?? "").padStart(numWidth, " ") : " ".repeat(numWidth)
        const leftBody = r
          ? pairHi
            ? pairHi.oldRendered
            : style.red(truncatePlain(r.text, codeAvail))
          : ""
        const rightBody = a
          ? pairHi
            ? pairHi.newRendered
            : style.green(truncatePlain(a.text, codeAvail))
          : ""
        const leftPad = " ".repeat(
          Math.max(
            0,
            halfW -
              visibleWidth(leftNum) -
              3 -
              visibleWidth(r ? truncatePlain(r.text, codeAvail) : ""),
          ),
        )
        const leftCell = r
          ? `${style.dim(leftNum)}${style.red(" - ")}${leftBody}${leftPad}`
          : " ".repeat(halfW)
        const rightCell = a ? `${style.dim(rightNum)}${style.green(" + ")}${rightBody}` : ""
        out.push(`${rail}${leftCell} ${style.dim("│")} ${rightCell}`)
      }
      continue
    }

    // Unified view (pair 1-to-1 inline highlights when block counts match & small)
    const canPair =
      removedRun.length > 0 && removedRun.length === addedRun.length && removedRun.length <= 4
    const pairs = canPair
      ? removedRun.map((r, k) =>
          highlightInlineDiffPair(r.text, addedRun[k]!.text, codeAvail, style),
        )
      : undefined

    for (let k = 0; k < removedRun.length; k += 1) {
      const r = removedRun[k]!
      const nStr = String(r.oldLine ?? "").padStart(numWidth, " ")
      const body = pairs ? pairs[k]!.oldRendered : truncatePlain(r.text, codeAvail)
      out.push(tintLine("removed", nStr, "-", body, maxWidth))
    }
    for (let k = 0; k < addedRun.length; k += 1) {
      const a = addedRun[k]!
      const nStr = String(a.newLine ?? "").padStart(numWidth, " ")
      const body = pairs ? pairs[k]!.newRendered : truncatePlain(a.text, codeAvail)
      out.push(tintLine("added", nStr, "+", body, maxWidth))
    }
  }

  out.push(style.dim(`╹${"▀".repeat(Math.min(Math.max(20, maxWidth - 2), 76))}`))
  return out
}

export type ParsedKeyEvent =
  | { readonly kind: "char"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  | {
      readonly kind: "key"
      readonly name:
        | "enter"
        | "newline"
        | "backspace"
        | "delete"
        | "tab"
        | "shift+tab"
        | "escape"
        | "up"
        | "down"
        | "left"
        | "right"
        | "home"
        | "end"
        | "pageup"
        | "pagedown"
      readonly ctrl?: boolean
      readonly alt?: boolean
      readonly shift?: boolean
    }
  | { readonly kind: "ctrl"; readonly key: string }
  | { readonly kind: "alt"; readonly key: string }

export const MAX_BRACKETED_PASTE_BYTES = 512 * 1024

export interface KeyParserState {
  pending: string
  inPaste: boolean
  pasteBuffer: string
  pasteTruncated?: boolean
}

export function createKeyParserState(): KeyParserState {
  return { pending: "", inPaste: false, pasteBuffer: "", pasteTruncated: false }
}

function parseCsiSequence(body: string, finalChar: string): ParsedKeyEvent | undefined {
  // Kitty keyboard protocol: CSI <codepoint>[;<modifiers>] u
  if (finalChar === "u") {
    const [codeStr, modStr] = body.split(";")
    const code = Number(codeStr)
    const mod = modStr ? Number(modStr) - 1 : 0
    const shift = (mod & 1) !== 0
    const alt = (mod & 2) !== 0
    const ctrl = (mod & 4) !== 0
    if (code === 13) {
      if (shift || alt || ctrl) return { kind: "key", name: "newline", shift, alt, ctrl }
      return { kind: "key", name: "enter" }
    }
    if (code === 27) return { kind: "key", name: "escape" }
    if (code === 9) return { kind: "key", name: shift ? "shift+tab" : "tab" }
    if (code === 127) return { kind: "key", name: "backspace", ctrl, alt }
    if (code >= 97 && code <= 122) {
      const ch = String.fromCharCode(code)
      if (ctrl && !alt) return { kind: "ctrl", key: ch }
      if (alt && !ctrl) return { kind: "alt", key: ch }
    }
    return undefined
  }

  // xterm modifyOtherKeys: CSI 27;<mod>;<code> ~
  if (finalChar === "~") {
    const parts = body.split(";")
    if (parts[0] === "27" && parts.length >= 3) {
      const mod = Number(parts[1]) - 1
      const code = Number(parts[2])
      if (code === 13 && mod > 0) return { kind: "key", name: "newline" }
    }
    const num = Number(parts[0])
    const mod = parts[1] ? Number(parts[1]) - 1 : 0
    const alt = (mod & 2) !== 0
    const ctrl = (mod & 4) !== 0
    if (num === 3) return { kind: "key", name: "delete", ctrl, alt }
    if (num === 5) return { kind: "key", name: "pageup" }
    if (num === 6) return { kind: "key", name: "pagedown" }
    if (num === 1 || num === 7) return { kind: "key", name: "home" }
    if (num === 4 || num === 8) return { kind: "key", name: "end" }
    return undefined
  }

  const modPart = body.includes(";") ? Number(body.split(";")[1]) - 1 : 0
  const alt = (modPart & 2) !== 0
  const ctrl = (modPart & 4) !== 0
  switch (finalChar) {
    case "A":
      return { kind: "key", name: "up", ctrl, alt }
    case "B":
      return { kind: "key", name: "down", ctrl, alt }
    case "C":
      return { kind: "key", name: "right", ctrl, alt }
    case "D":
      return { kind: "key", name: "left", ctrl, alt }
    case "H":
      return { kind: "key", name: "home", ctrl, alt }
    case "F":
      return { kind: "key", name: "end", ctrl, alt }
    case "Z":
      return { kind: "key", name: "shift+tab" }
    default:
      return undefined
  }
}

/**
 * Incrementally parse raw terminal bytes into structured key/paste events.
 * Leaves incomplete escape prefixes in `state.pending` so callers can flush a standalone
 * `escape` after a short disambiguation timeout (e.g. 35ms).
 */
export function feedKeyParser(state: KeyParserState, chunk: string): ParsedKeyEvent[] {
  const events: ParsedKeyEvent[] = []
  let input = state.pending + chunk
  state.pending = ""

  let i = 0
  while (i < input.length) {
    if (state.inPaste) {
      const endMarker = "\x1b[201~"
      const endIdx = input.indexOf(endMarker, i)
      const ctrlCIdx = input.indexOf("\x03", i)
      if (ctrlCIdx !== -1 && (endIdx === -1 || ctrlCIdx < endIdx)) {
        state.pasteBuffer = ""
        state.pasteTruncated = false
        state.inPaste = false
        events.push({ kind: "ctrl", key: "c" })
        i = ctrlCIdx + 1
        continue
      }
      const appendPasteChunk = (slice: string) => {
        if (!slice || state.pasteBuffer.length >= MAX_BRACKETED_PASTE_BYTES) {
          if (slice) state.pasteTruncated = true
          return
        }
        const remaining = MAX_BRACKETED_PASTE_BYTES - state.pasteBuffer.length
        if (slice.length > remaining) {
          state.pasteBuffer += slice.slice(0, remaining)
          state.pasteTruncated = true
        } else {
          state.pasteBuffer += slice
        }
      }
      if (endIdx === -1) {
        // Keep a trailing prefix in case endMarker is split across chunks
        const tailKeep = Math.min(endMarker.length - 1, input.length - i)
        const safeEnd = input.length - tailKeep
        if (safeEnd > i) appendPasteChunk(input.slice(i, safeEnd))
        state.pending = input.slice(safeEnd)
        i = input.length
        break
      }
      appendPasteChunk(input.slice(i, endIdx))
      events.push({ kind: "paste", text: state.pasteBuffer })
      state.pasteBuffer = ""
      state.pasteTruncated = false
      state.inPaste = false
      i = endIdx + endMarker.length
      continue
    }

    const code = input.charCodeAt(i)
    if (code === 0x1b) {
      if (i + 1 >= input.length) {
        state.pending = input.slice(i)
        break
      }
      const next = input[i + 1]!
      if (next === "[") {
        // Bracketed paste start?
        const pasteStart = "\x1b[200~"
        if (input.startsWith(pasteStart, i)) {
          state.inPaste = true
          state.pasteBuffer = ""
          i += pasteStart.length
          continue
        }
        if (pasteStart.startsWith(input.slice(i))) {
          state.pending = input.slice(i)
          break
        }
        let j = i + 2
        while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) {
          j += 1
        }
        if (j >= input.length) {
          state.pending = input.slice(i)
          break
        }
        const body = input.slice(i + 2, j)
        const finalChar = input[j]!
        const parsed = parseCsiSequence(body, finalChar)
        if (parsed) events.push(parsed)
        i = j + 1
        continue
      }
      if (next === "O") {
        if (i + 2 >= input.length) {
          state.pending = input.slice(i)
          break
        }
        const op = input[i + 2]!
        const map: Record<string, "up" | "down" | "right" | "left" | "home" | "end"> = {
          A: "up",
          B: "down",
          C: "right",
          D: "left",
          H: "home",
          F: "end",
        }
        const mapped = map[op]
        if (mapped) events.push({ kind: "key", name: mapped })
        i += 3
        continue
      }
      if (next === "\r" || next === "\n") {
        events.push({ kind: "key", name: "newline", alt: true })
        i += 2
        continue
      }
      if (next === "\x7f" || next === "\x08") {
        events.push({ kind: "key", name: "backspace", alt: true })
        i += 2
        continue
      }
      const lower = next.toLowerCase()
      if (/^[a-z]$/.test(lower)) {
        events.push({ kind: "alt", key: lower })
        i += 2
        continue
      }
      events.push({ kind: "key", name: "escape" })
      i += 1
      continue
    }

    if (code === 0x0d || code === 0x0a) {
      // Note: Ctrl+J sends 0x0a in raw terminals ONLY when not CR; however scripted PTYs send \n (0x0a) for Enter!
      // Handle CR+LF pair cleanly as a single enter, and use Shift+Enter / Alt+Enter / Ctrl+N/O or backslash+Enter for newline,
      // while distinguishing Shift+Return via CSI u / modifyOtherKeys.
      if (code === 0x0d && input.charCodeAt(i + 1) === 0x0a) {
        i += 2
      } else {
        i += 1
      }
      events.push({ kind: "key", name: "enter" })
      continue
    }
    if (code === 0x09) {
      events.push({ kind: "key", name: "tab" })
      i += 1
      continue
    }
    if (code === 0x7f || code === 0x08) {
      events.push({ kind: "key", name: "backspace" })
      i += 1
      continue
    }
    if (code >= 0x01 && code <= 0x1a) {
      events.push({ kind: "ctrl", key: String.fromCharCode(code + 96) })
      i += 1
      continue
    }
    if (code < 0x20) {
      i += 1
      continue
    }

    // Read contiguous printable characters (or surrogate pair)
    let j = i
    while (j < input.length) {
      const c = input.charCodeAt(j)
      if (c < 0x20 || c === 0x7f) break
      j += 1
    }
    events.push({ kind: "char", text: input.slice(i, j) })
    i = j
  }

  return events
}

export function flushPendingEscape(state: KeyParserState): ParsedKeyEvent[] {
  if (state.pending === "\x1b") {
    state.pending = ""
    return [{ kind: "key", name: "escape" }]
  }
  return []
}

export function flushStuckPaste(state: KeyParserState): ParsedKeyEvent[] {
  if (!state.inPaste) return []
  const text = state.pasteBuffer + state.pending
  state.inPaste = false
  state.pasteBuffer = ""
  state.pasteTruncated = false
  state.pending = ""
  return text ? [{ kind: "paste", text }] : []
}

function wrapFormattedTokens(styled: string, maxCols: number): string[] {
  const width = Math.max(8, maxCols)
  if (visibleWidth(styled) <= width) return [styled]

  // Split into atomic tokens while tracking active SGR codes so wrapping never breaks color/bold across lines.
  const out: string[] = []
  let line = ""
  let lineW = 0
  let activeSgr = ""
  let i = 0

  const flushLine = () => {
    out.push(activeSgr ? `${line}\x1b[0m` : line)
    line = activeSgr
    lineW = 0
  }

  while (i < styled.length) {
    if (styled.charCodeAt(i) === 0x1b && styled[i + 1] === "[") {
      let j = i + 2
      while (j < styled.length && !(styled.charCodeAt(j) >= 0x40 && styled.charCodeAt(j) <= 0x7e))
        j += 1
      const seq = styled.slice(i, j < styled.length ? j + 1 : styled.length)
      line += seq
      if (seq.endsWith("m")) {
        activeSgr =
          seq === "\x1b[0m" ||
          seq === "\x1b[39m" ||
          seq === "\x1b[22m" ||
          seq === "\x1b[23m" ||
          seq === "\x1b[49m"
            ? ""
            : `${activeSgr}${seq}`
      }
      i = j < styled.length ? j + 1 : styled.length
      continue
    }

    // Consume either a space run or a non-space word up to next whitespace/escape
    if (styled[i] === " ") {
      if (lineW + 1 > width && lineW > 0) {
        flushLine()
      } else {
        line += " "
        lineW += 1
      }
      i += 1
      continue
    }

    let j = i
    let wordPlain = ""
    while (j < styled.length && styled[j] !== " " && styled.charCodeAt(j) !== 0x1b) {
      wordPlain += styled[j]
      j += 1
    }
    const wordW = visibleWidth(wordPlain)
    if (lineW > 0 && lineW + wordW > width) {
      // Trim trailing space before wrapping cleanly to next line
      while (line.endsWith(" ")) line = line.slice(0, -1)
      flushLine()
    }
    if (wordW <= width) {
      line += wordPlain
      lineW += wordW
    } else {
      for (const ch of wordPlain) {
        const cw = charDisplayWidth(ch)
        if (lineW + cw > width && lineW > 0) flushLine()
        line += ch
        lineW += cw
      }
    }
    i = j
  }
  if (line !== "" || out.length === 0) {
    out.push(activeSgr ? `${line}\x1b[0m` : line)
  }
  return out
}

/**
 * Render inline Markdown spans (`code`, **bold**, *italic*, [label](url)) cleanly using ANSI styling.
 */
export function renderInlineMarkdown(text: string, style: TuiStyle): string {
  // Replace inline code spans first so markers inside backticks stay literal.
  const codePlaceholders: string[] = []
  let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const token = `\x00CODE${codePlaceholders.length}\x00`
    codePlaceholders.push(style.cyan(code))
    return token
  })

  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (_m, label: string, url: string) => `${style.blue(label)} ${style.dim(`(${url})`)}`,
  )
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, boldText: string) => style.bold(boldText))
  out = out.replace(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_m, pre: string, it: string) => `${pre}${style.italic(it)}`,
  )
  out = out.replace(
    /(^|\s)_([^_\n]+)_(?=$|\s|[.,:;!?])/g,
    (_m, pre: string, it: string) => `${pre}${style.italic(it)}`,
  )

  for (let i = 0; i < codePlaceholders.length; i += 1) {
    out = out.split(`\x00CODE${i}\x00`).join(codePlaceholders[i]!)
  }
  return out
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cur += "|"
      i += 1
      continue
    }
    if (trimmed[i] === "|") {
      cells.push(cur.trim())
      cur = ""
      continue
    }
    cur += trimmed[i]
  }
  cells.push(cur.trim())
  return cells
}

function isTableSeparatorLine(line: string): boolean {
  const t = line.trim()
  if (!t.includes("-") || !t.includes("|")) return false
  return /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?::?-{2,}:?\s*\|?)?$/.test(t)
}

function renderMarkdownTable(
  headerCells: string[],
  bodyRows: string[][],
  maxWidth: number,
  style: TuiStyle,
): string[] {
  const colCount = Math.max(1, headerCells.length, ...bodyRows.map((r) => r.length))
  const padRow = (r: string[]) =>
    Array.from({ length: colCount }, (_, i) => renderInlineMarkdown(r[i] ?? "", style))
  const styledHeader = padRow(headerCells)
  const styledBody = bodyRows.map(padRow)

  const naturalWidths = Array.from({ length: colCount }, (_, c) =>
    Math.max(4, visibleWidth(styledHeader[c]!), ...styledBody.map((r) => visibleWidth(r[c]!))),
  )

  // Reserve 2-char indent + box borders (colCount + 1) + 2 spaces cell padding per column
  const overhead = 2 + (colCount + 1) + colCount * 2
  const availInner = Math.max(colCount * 8, maxWidth - overhead)
  const colWidths = [...naturalWidths]
  let total = colWidths.reduce((a, b) => a + b, 0)
  while (total > availInner) {
    let widestIdx = 0
    for (let i = 1; i < colWidths.length; i += 1) {
      if (colWidths[i]! > colWidths[widestIdx]!) widestIdx = i
    }
    if (colWidths[widestIdx]! <= 8) break
    colWidths[widestIdx] = colWidths[widestIdx]! - 1
    total -= 1
  }

  const hRule = (left: string, mid: string, right: string) =>
    style.dim(`  ${left}${colWidths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`)

  const renderDataRow = (cells: string[], isHeader: boolean): string[] => {
    const wrappedCols = cells.map((cell, c) => wrapFormattedTokens(cell, colWidths[c]!))
    const rowLines = Math.max(1, ...wrappedCols.map((wc) => wc.length))
    const rendered: string[] = []
    for (let lineIdx = 0; lineIdx < rowLines; lineIdx += 1) {
      const colsJoined = wrappedCols
        .map((wc, c) => {
          const piece = wc[lineIdx] ?? ""
          const vis = visibleWidth(piece)
          const pad = " ".repeat(Math.max(0, colWidths[c]! - vis))
          const content = isHeader ? style.accentBold(stripAnsiSequences(piece)) : piece
          return ` ${content}${pad} `
        })
        .join(style.dim("│"))
      rendered.push(`  ${style.dim("│")}${colsJoined}${style.dim("│")}`)
    }
    return rendered
  }

  const out: string[] = [
    hRule("┌", "┬", "┐"),
    ...renderDataRow(styledHeader, true),
    hRule("├", "┼", "┤"),
  ]
  for (let r = 0; r < styledBody.length; r += 1) {
    out.push(...renderDataRow(styledBody[r]!, false))
    if (r < styledBody.length - 1) out.push(hRule("├", "┼", "┤"))
  }
  out.push(hRule("└", "┴", "┘"))
  return out
}

/**
 * Render Markdown text cleanly for terminal output (OpenCode style):
 * - Aligned Unicode box tables with automatic column shrinking & cell wrapping
 * - Bordered fenced code blocks with language tags
 * - Styled headings, lists, blockquotes, horizontal rules, inline code, bold, italic, and links
 */
export function renderOpenCodeMarkdown(
  markdown: string,
  maxWidth: number,
  style: TuiStyle,
): string[] {
  const width = Math.max(24, maxWidth)
  const rawLines = markdown.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]!
    const trimmed = line.trim()

    if (trimmed === "") {
      if (out.length > 0 && out.at(-1) !== "") out.push("")
      i += 1
      continue
    }

    // Fenced code blocks
    const fenceMatch = /^```([^\s`]*)/.exec(trimmed)
    if (fenceMatch) {
      const lang = fenceMatch[1]?.trim() || "code"
      out.push(`  ${style.accent("┃")} ${style.muted(lang)}`)
      i += 1
      while (i < rawLines.length && !rawLines[i]!.trim().startsWith("```")) {
        const codeLines = wrapPlainText(rawLines[i]!, Math.max(16, width - 5))
        for (const cl of codeLines) {
          out.push(`  ${style.accent("┃")} ${style.cyan(cl)}`)
        }
        i += 1
      }
      if (i < rawLines.length && rawLines[i]!.trim().startsWith("```")) i += 1
      out.push(`  ${style.dim("╹")}`)
      continue
    }

    // Markdown table: current line has pipes AND next line is separator
    if (line.includes("|") && i + 1 < rawLines.length && isTableSeparatorLine(rawLines[i + 1]!)) {
      const header = splitMarkdownTableRow(line)
      i += 2
      const body: string[][] = []
      while (i < rawLines.length && rawLines[i]!.includes("|") && rawLines[i]!.trim() !== "") {
        body.push(splitMarkdownTableRow(rawLines[i]!))
        i += 1
      }
      out.push(...renderMarkdownTable(header, body, width, style))
      continue
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      if (out.length > 0 && out.at(-1) !== "") out.push("")
      const level = headingMatch[1]!.length
      const content = renderInlineMarkdown(headingMatch[2]!, style)
      const wrapped = wrapFormattedTokens(content, Math.max(16, width - 4))
      for (const w of wrapped) {
        out.push(
          `  ${level <= 2 ? style.accentBold(stripAnsiSequences(w)) : style.bold(stripAnsiSequences(w))}`,
        )
      }
      i += 1
      continue
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(`  ${style.dim("─".repeat(Math.min(Math.max(12, width - 4), 72)))}`)
      i += 1
      continue
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const body = trimmed.replace(/^>\s?/, "")
      const wrapped = wrapFormattedTokens(
        renderInlineMarkdown(body, style),
        Math.max(16, width - 6),
      )
      for (const w of wrapped) {
        out.push(`  ${style.accent("┃")} ${style.muted(stripAnsiSequences(w))}`)
      }
      i += 1
      continue
    }

    // Bullet / numbered list
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line)
    if (listMatch) {
      const indent = " ".repeat(Math.min(6, listMatch[1]!.length))
      const marker = /^\d/.test(listMatch[2]!) ? style.muted(listMatch[2]!) : style.accent("•")
      const content = renderInlineMarkdown(listMatch[3]!, style)
      const wrapped = wrapFormattedTokens(content, Math.max(16, width - 6 - indent.length))
      wrapped.forEach((w, idx) => {
        out.push(idx === 0 ? `  ${indent}${marker} ${w}` : `  ${indent}  ${w}`)
      })
      i += 1
      continue
    }

    // Regular paragraph line
    const wrapped = wrapFormattedTokens(renderInlineMarkdown(line, style), Math.max(16, width - 4))
    for (const w of wrapped) out.push(`  ${w}`)
    i += 1
  }

  while (out.length > 0 && out.at(-1) === "") out.pop()
  return out
}

/**
 * OpenCode-inspired `BlockTool` / `ShellDisplay` card for completed `run_command` executions.
 */
export function renderOpenCodeShellCard(
  opts: {
    readonly command: string
    readonly output?: string
    readonly status: "ok" | "error" | "denied"
    readonly exitCode?: number | null
    readonly signal?: string | null
    readonly maxWidth?: number
  },
  style: TuiStyle,
): string[] {
  const width = Math.max(36, opts.maxWidth ?? 90)
  const statusText =
    opts.status === "denied"
      ? style.yellow("declined")
      : opts.status === "ok"
        ? style.green(`✓ exit ${opts.exitCode ?? 0}`)
        : style.red(
            opts.signal
              ? `✗ signal ${opts.signal}`
              : `✗ exit ${opts.exitCode === null || opts.exitCode === undefined ? "error" : opts.exitCode}`,
          )
  const rail =
    opts.status === "ok"
      ? style.accent("┃")
      : opts.status === "denied"
        ? style.yellow("┃")
        : style.red("┃")
  const cmdMax = Math.max(12, width - 20)
  const cmdLine = `${rail} ${style.bold("$")} ${style.bold(truncatePlain(opts.command, cmdMax))}  ${statusText}`

  const lines = [cmdLine]
  const rawBodyLines = (opts.output ?? "")
    .split(/\r?\n/)
    .filter((l, idx) => !(idx === 0 && l.startsWith("exitCode:")))
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")
  const maxBody = 6
  const shown = rawBodyLines.slice(0, maxBody)
  for (const bl of shown) {
    lines.push(`${rail}   ${style.muted(truncatePlain(bl, Math.max(16, width - 8)))}`)
  }
  if (rawBodyLines.length > maxBody) {
    lines.push(`${rail}   ${style.dim(`… (${rawBodyLines.length - maxBody} more line(s))`)}`)
  }
  lines.push(style.dim("╹"))
  return lines
}
