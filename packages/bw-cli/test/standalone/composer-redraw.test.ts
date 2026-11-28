import assert from "node:assert/strict"
import test from "node:test"
import type { ParsedKeyEvent } from "../../src/standalone/tui-theme.ts"
import { createStyle, getTerminalLayout } from "../../src/standalone/tui-theme.ts"
import type { RawTerminalSession } from "../../src/standalone/tui-widgets.ts"
import { runInteractiveComposer } from "../../src/standalone/tui-widgets.ts"

/**
 * Headless screen model for the inline composer. It interprets the ANSI subset the
 * composer emits (`\r`, `\n`, CUU/CUD/CUF/CUB, ED, EL) into a character grid, so the
 * redraw protocol is asserted deterministically without a PTY and on every platform.
 */
class Screen {
  readonly cols: number
  readonly rows: number
  private readonly cells: string[][]
  private row = 0
  private col = 0

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "))
  }

  write(text: string): void {
    let i = 0
    while (i < text.length) {
      const ch = text[i]!
      if (ch === "\x1b") {
        i = this.escape(text, i)
        continue
      }
      if (ch === "\r") this.col = 0
      else if (ch === "\n") this.lineFeed()
      else if (ch >= " ") this.put(ch)
      i += 1
    }
  }

  lines(): string[] {
    return this.cells.map((row) => row.join("").replace(/\s+$/, ""))
  }

  /** Seeds already-rendered output above the composer, like a conversation transcript. */
  place(row: number, text: string): void {
    for (let i = 0; i < text.length; i += 1) this.cells[row]![i] = text[i]!
  }

  cursorTo(row: number): void {
    this.row = row
    this.col = 0
  }

  cursorRow(): number {
    return this.row + 1
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0
      this.lineFeed()
    }
    this.cells[this.row]![this.col] = ch
    this.col += 1
  }

  private lineFeed(count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.row += 1
      if (this.row >= this.rows) {
        this.cells.shift()
        this.cells.push(Array.from({ length: this.cols }, () => " "))
        this.row = this.rows - 1
      }
    }
    this.col = 0
  }

  private escape(text: string, start: number): number {
    const next = text[start + 1]
    if (next === "[") {
      let end = start + 2
      while (end < text.length) {
        const code = text.charCodeAt(end)
        if (code >= 0x40 && code <= 0x7e) break
        end += 1
      }
      this.csi(text[end] ?? "", text.slice(start + 2, end))
      return end + 1
    }
    if (next === "]") {
      let end = start + 2
      while (end < text.length && text[end] !== "\x07") end += 1
      return end + 1
    }
    return start + 2
  }

  private csi(final: string, params: string): void {
    const n = Number.parseInt(params === "" ? "1" : params, 10) || 1
    if (final === "A") this.row = Math.max(0, this.row - n)
    else if (final === "B") this.row = Math.min(this.rows - 1, this.row + n)
    else if (final === "C") this.col = Math.min(this.cols - 1, this.col + n)
    else if (final === "D") this.col = Math.max(0, this.col - n)
    else if (final === "J") this.eraseDisplay(params === "2")
    else if (final === "K") this.eraseLine()
  }

  private eraseDisplay(all: boolean): void {
    if (all) {
      for (const row of this.cells) row.fill(" ")
      return
    }
    for (let c = this.col; c < this.cols; c += 1) this.cells[this.row]![c] = " "
    for (let r = this.row + 1; r < this.rows; r += 1) this.cells[r]!.fill(" ")
  }

  private eraseLine(): void {
    for (let c = this.col; c < this.cols; c += 1) this.cells[this.row]![c] = " "
  }
}

type KeyName = Extract<ParsedKeyEvent, { kind: "key" }>["name"]

function startComposer(screen: Screen, history: readonly string[] = []) {
  let onKey: ((ev: ParsedKeyEvent) => void) | undefined
  const raw = {
    isTTY: true,
    cols: () => screen.cols,
    rows: () => screen.rows,
    cursorRow: () => screen.cursorRow(),
    layout: () => getTerminalLayout(screen.cols, screen.rows),
    write: (text: string) => screen.write(text),
    beginCapture: (handler: (ev: ParsedKeyEvent) => void) => {
      onKey = handler
      return () => {}
    },
    onDispose: () => () => {},
  } as unknown as RawTerminalSession

  const settled = runInteractiveComposer({
    raw,
    style: createStyle(false),
    promptLabel: "bashwink> ",
    statusSummary: "ready",
    workspace: process.cwd(),
    history,
  })

  return {
    paste(text: string): void {
      onKey!({ kind: "paste", text })
    },
    type(text: string): void {
      for (const ch of text) onKey!({ kind: "char", text: ch })
    },
    press(...names: KeyName[]): void {
      for (const name of names) onKey!({ kind: "key", name })
    },
    ctrlC(): void {
      onKey!({ kind: "ctrl", key: "c" })
    },
    result(): Promise<string> {
      return settled.then((action) => action.kind)
    },
    submit(): Promise<string> {
      onKey!({ kind: "key", name: "enter" })
      return settled.then((action) => action.kind)
    },
  }
}

const promptLines = (screen: Screen): string[] =>
  screen.lines().filter((line) => line.includes("bashwink> "))

test("shrinking the slash menu erases the old prompt line instead of stacking it (#112)", async () => {
  const screen = new Screen(100, 30)
  const composer = startComposer(screen)

  composer.type("/connec")
  assert.equal(promptLines(screen).length, 1, "one prompt while the menu is open")
  assert.match(promptLines(screen)[0]!, /bashwink> \/connec$/)

  // "t" narrows the suggestion list, so the composer block shrinks by several rows.
  composer.type("t")
  const prompts = promptLines(screen).map((line) => line.trimStart())
  assert.deepEqual(prompts, ["┃ bashwink> /connect"], "the /connec row must be cleared")
  assert.ok(
    !promptLines(screen).some((line) => line.endsWith("bashwink> /connec")),
    "the stale prompt line is still on screen",
  )

  assert.equal(await composer.submit(), "command")
})

test("growth and shrinkage of the menu never erases output above the prompt", async () => {
  const screen = new Screen(100, 30)
  const conversation = ["conversation line 1", "conversation line 2", "conversation line 3"]
  conversation.forEach((line, index) => screen.place(index, line))
  screen.cursorTo(conversation.length)

  const composer = startComposer(screen)
  composer.type("/connec")
  composer.type("t")
  composer.press("backspace", "backspace", "backspace")
  composer.type("ect")

  assert.equal(promptLines(screen).length, 1, "one prompt line after menu growth and shrinkage")
  assert.match(promptLines(screen)[0]!, /bashwink> \/connect$/)

  const rendered = screen.lines()
  const indexes = conversation.map((line) => rendered.indexOf(line))
  assert.ok(
    indexes.every((index) => index >= 0),
    `conversation lines were erased: ${JSON.stringify(rendered)}`,
  )
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b),
    indexes,
    "conversation order preserved",
  )

  assert.equal(await composer.submit(), "command")
})

test("a long draft stays within the bottom composer on a short terminal", async () => {
  const screen = new Screen(40, 8)
  screen.place(0, "previous assistant reply")
  screen.cursorTo(1)
  const composer = startComposer(screen)
  composer.paste(Array.from({ length: 20 }, (_, i) => `draft ${i + 1}`).join("\n"))

  assert.equal(screen.lines()[0], "previous assistant reply")
  assert.match(screen.lines()[5]!, /draft 20/)
  assert.equal(screen.lines()[7], "ready")

  composer.ctrlC()
  assert.match(screen.lines()[5]!, /bashwink>$/)
  assert.equal(screen.lines()[0], "previous assistant reply")
  composer.ctrlC()
  assert.equal(await composer.result(), "exit")
})

test(
  "Ctrl+C on an empty prompt leaves the composer instead of printing a hint",
  { timeout: 2000 },
  async () => {
    const screen = new Screen(100, 30)
    const composer = startComposer(screen)
    composer.ctrlC()
    assert.equal(await composer.result(), "exit")
  },
)
