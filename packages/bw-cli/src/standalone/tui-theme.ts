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

export function colorsEnabled(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
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
    accent: (s) => wrapAnsi("\x1b[38;5;75m", "\x1b[39m", s, enabled),
    accentBold: (s) => wrapAnsi("\x1b[1;38;5;75m", "\x1b[22;39m", s, enabled),
    muted: (s) => wrapAnsi("\x1b[38;5;244m", "\x1b[39m", s, enabled),
    green: (s) => wrapAnsi("\x1b[38;5;114m", "\x1b[39m", s, enabled),
    red: (s) => wrapAnsi("\x1b[38;5;203m", "\x1b[39m", s, enabled),
    yellow: (s) => wrapAnsi("\x1b[38;5;221m", "\x1b[39m", s, enabled),
    cyan: (s) => wrapAnsi("\x1b[38;5;80m", "\x1b[39m", s, enabled),
    blue: (s) => wrapAnsi("\x1b[38;5;111m", "\x1b[39m", s, enabled),
    selectedRow: (s) => wrapAnsi("\x1b[48;5;237;38;5;255m", "\x1b[49;39m", s, enabled),
    diffLine: (line) => {
      if (!enabled) return line
      if (line.startsWith("+++") || line.startsWith("---")) return wrapAnsi("\x1b[1;38;5;250m", "\x1b[22;39m", line, true)
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
        while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1
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
  const keepHead = Math.max(2, Math.floor((maxCols - 1) * 0.35))
  const keepTail = Math.max(3, maxCols - 1 - keepHead)
  return `${chars.slice(0, keepHead).join("")}…${chars.slice(-keepTail).join("")}`
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
      visualCursorCol = pfxW + visibleWidth(chars.slice(segmentStartIdx, Math.min(cursorCol, chars.length)).join(""))
    }
    const segPfx = firstSeg ? fmtPfx(rawPfx) : formatContPrefix(contPrefix)
    visualRows.push(`${segPfx}${chunk}`)
  }

  return { visualRows, visualCursorRow, visualCursorCol }
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

export interface KeyParserState {
  pending: string
  inPaste: boolean
  pasteBuffer: string
}

export function createKeyParserState(): KeyParserState {
  return { pending: "", inPaste: false, pasteBuffer: "" }
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
      if (endIdx === -1) {
        // Keep a trailing prefix in case endMarker is split across chunks
        const tailKeep = Math.min(endMarker.length - 1, input.length - i)
        const safeEnd = input.length - tailKeep
        if (safeEnd > i) state.pasteBuffer += input.slice(i, safeEnd)
        state.pending = input.slice(safeEnd)
        i = input.length
        break
      }
      state.pasteBuffer += input.slice(i, endIdx)
      events.push({ kind: "paste", text: state.pasteBuffer })
      state.pasteBuffer = ""
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
