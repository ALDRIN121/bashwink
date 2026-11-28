import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  createStyle,
  getTerminalLayout,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  renderActivityLine,
  renderFieldView,
  visibleWidth,
  type ParsedKeyEvent,
} from "../../src/standalone/tui-theme.ts"
import {
  askHybridChoice,
  runInteractiveComposer,
  type ComposerTurnContext,
  type RawTerminalSession,
} from "../../src/standalone/tui-widgets.ts"
import {
  applyConnectionTestResult,
  renderStatusReport,
  reviewShortcutHint,
  runInteractiveSetup,
  runModelPicker,
  type TerminalIO,
} from "../../src/standalone/terminal.ts"
import {
  loadStandaloneConfig,
  saveStandaloneConfig,
  standaloneConfigFile,
} from "../../src/standalone/config.ts"
import { createSession } from "../../src/standalone/session.ts"
import type { StandaloneConfig } from "../../src/standalone/types.ts"

/**
 * Minimal screen model (same protocol as composer-redraw.test.ts): interprets the ANSI
 * subset the widgets emit so redraws can be asserted without a PTY.
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
    if (text[start + 1] !== "[") return start + 1
    let i = start + 2
    while (i < text.length && !(text[i]! >= "@" && text[i]! <= "~")) i += 1
    const final = text[i] ?? ""
    const params = text.slice(start + 2, i)
    if (final === "J") {
      const whole = params === "2"
      const fromRow = whole ? 0 : this.row
      for (let r = fromRow; r < this.rows; r += 1) {
        const from = whole ? 0 : r === this.row ? this.col : 0
        for (let c = from; c < this.cols; c += 1) this.cells[r]![c] = " "
      }
    } else if (final === "K") {
      for (let c = this.col; c < this.cols; c += 1) this.cells[this.row]![c] = " "
    } else if (final === "A") {
      this.row = Math.max(0, this.row - Math.max(1, Number(params || "1")))
    } else if (final === "B") {
      this.row = Math.min(this.rows - 1, this.row + Math.max(1, Number(params || "1")))
    } else if (final === "C") {
      this.col = Math.min(this.cols - 1, this.col + Math.max(1, Number(params || "1")))
    } else if (final === "D") {
      this.col = Math.max(0, this.col - Math.max(1, Number(params || "1")))
    }
    return i + 1
  }
}

type KeyName = Extract<ParsedKeyEvent, { kind: "key" }>["name"]

interface Harness {
  raw: RawTerminalSession
  key(ev: ParsedKeyEvent): void
  type(text: string): void
  press(...names: KeyName[]): void
  ctrl(key: string): void
  paste(text: string): void
  dispose(): void
}

function makeRaw(screen: Screen): Harness {
  let onKey: ((ev: ParsedKeyEvent) => void) | undefined
  let onResize:
    ((info: { cols: number; rows: number; prevCols: number; prevRows: number }) => void) | undefined
  const disposeListeners = new Set<() => void>()
  const raw = {
    isTTY: true,
    cols: () => screen.cols,
    rows: () => screen.rows,
    cursorRow: () => screen.cursorRow(),
    layout: () => getTerminalLayout(screen.cols, screen.rows),
    write: (text: string) => screen.write(text),
    beginCapture: (
      handler: (ev: ParsedKeyEvent) => void,
      resize?: (info: { cols: number; rows: number; prevCols: number; prevRows: number }) => void,
    ) => {
      const previous = { onKey, onResize }
      onKey = handler
      onResize = resize
      return () => {
        onKey = previous.onKey
        onResize = previous.onResize
      }
    },
    onDispose: (fn: () => void) => {
      disposeListeners.add(fn)
      return () => disposeListeners.delete(fn)
    },
  } as unknown as RawTerminalSession
  return {
    raw,
    key: (ev) => onKey?.(ev),
    type: (text) => {
      for (const ch of text) onKey?.({ kind: "char", text: ch })
    },
    press: (...names) => {
      for (const name of names) onKey?.({ kind: "key", name })
    },
    ctrl: (key) => onKey?.({ kind: "ctrl", key }),
    paste: (text) => onKey?.({ kind: "paste", text }),
    dispose: () => {
      for (const fn of disposeListeners) fn()
      disposeListeners.clear()
    },
  }
}

function startComposer(
  screen: Screen,
  extra: {
    readonly history?: readonly string[]
    readonly runTurn?: (ctx: ComposerTurnContext) => Promise<void | { restoreDraft?: string }>
    readonly initialDraft?: string
    readonly initialCursor?: number
    readonly workspace?: string
  } = {},
) {
  const harness = makeRaw(screen)
  const settled = runInteractiveComposer({
    raw: harness.raw,
    style: createStyle(false),
    promptLabel: "❯ ",
    statusSummary: "ready",
    workspace: extra.workspace ?? process.cwd(),
    history: extra.history ?? [],
    ...(extra.runTurn ? { runTurn: extra.runTurn } : {}),
    ...(extra.initialDraft === undefined ? {} : { initialDraft: extra.initialDraft }),
    ...(extra.initialCursor === undefined ? {} : { initialCursor: extra.initialCursor }),
  })
  return { harness, settled }
}

/** Resolves once the pending promise has had a chance to run its microtasks. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const promptRows = (screen: Screen): string[] =>
  screen.lines().filter((line) => line.includes("┃ ❯"))

test("TUI-10: Backspace removes a whole emoji grapheme instead of half a surrogate pair", () => {
  assert.equal(previousGraphemeBoundary("再😊", 3), 1)
  assert.equal(previousGraphemeBoundary("再😊", 1), 0)
  assert.equal(previousGraphemeBoundary("a👨‍👩‍👧b", 9), 1, "ZWJ family is one grapheme")
  assert.equal(previousGraphemeBoundary("e\u0301x", 3), 2, "combining accent stays with its base")
  assert.equal(nextGraphemeBoundary("再😊", 1), 3)
})

test("TUI-10: the composer deletes the emoji without corrupting surrounding text", async () => {
  const screen = new Screen(80, 24)
  const { harness, settled } = startComposer(screen)
  harness.paste("再😊")
  harness.press("backspace")
  const row = promptRows(screen)[0]!
  assert.match(row, /再$/)
  assert.ok(!row.includes("\uFFFD"), `lone surrogate left on screen: ${JSON.stringify(row)}`)
  harness.ctrl("c")
  harness.ctrl("c")
  assert.equal((await settled).kind, "exit")
})

test("TUI-11: the match counter keeps every suggestion reachable on a short terminal", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "bw-mentions-"))
  try {
    for (const name of ["qa-first.txt", "qa-second.txt", "qa-third.txt"]) {
      writeFileSync(path.join(ws, name), "x\n", "utf8")
    }
    // 40x8: the draft leaves room for a single suggestion row, so the counter is what proves
    // the other matches are still reachable (Down moves through all of them).
    const screen = new Screen(40, 8)
    const { harness, settled } = startComposer(screen, { workspace: ws })
    harness.paste("line one\nline two\nline three\n@qa")
    assert.match(screen.lines().join("\n"), /1\/3/, "the menu must report the full match count")
    harness.press("down", "down")
    assert.match(screen.lines().join("\n"), /3\/3/, "Down must reach the last match")
    harness.ctrl("c")
    harness.ctrl("c")
    await settled
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test("TUI-11: Tab inserts the selected suggestion from the full match list", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "bw-mentions-wide-"))
  try {
    for (const name of ["qa-first.txt", "qa-second.txt", "qa-third.txt"]) {
      writeFileSync(path.join(ws, name), "x\n", "utf8")
    }
    const screen = new Screen(80, 20)
    const { harness, settled } = startComposer(screen, { workspace: ws })
    harness.type("@qa")
    // All three matches are listed (reachable), regardless of fuzzy ranking order.
    const menu = screen.lines().join("\n")
    for (const name of ["qa-first.txt", "qa-second.txt", "qa-third.txt"]) {
      assert.ok(menu.includes(`@${name}`), `${name} missing from the suggestion list`)
    }
    harness.press("down", "down", "tab")
    assert.match(promptRows(screen).join("\n"), /@qa-(first|second|third)\.txt/)
    harness.ctrl("c")
    harness.ctrl("c")
    await settled
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test("TUI-03: every dismissal action carries the draft and cursor back to the caller", async () => {
  const actions: Array<{ kind: string; draft: string; cursor: number }> = []
  const run = async (trigger: (h: Harness) => void): Promise<{ draft: string; cursor: number }> => {
    const screen = new Screen(100, 30)
    const { harness, settled } = startComposer(screen)
    harness.paste("keep this draft")
    harness.press("left", "left", "left")
    trigger(harness)
    const action = await settled
    void actions
    return { draft: action.draft, cursor: action.cursor }
  }
  const expected = { draft: "keep this draft", cursor: "keep this draft".length - 3 }
  assert.deepEqual(await run((h) => h.ctrl("p")), expected)
  assert.deepEqual(await run((h) => h.ctrl("o")), expected)
  assert.deepEqual(await run((h) => h.ctrl("t")), expected)
  assert.deepEqual(await run((h) => h.ctrl("l")), expected)
  assert.deepEqual(await run((h) => h.press("pageup")), expected)
})

test("TUI-03: a draft survives an overlay round-trip when re-entered", async () => {
  const screen = new Screen(100, 30)
  const first = startComposer(screen)
  first.harness.paste("half-written prompt")
  first.harness.press("left", "left")
  first.harness.ctrl("p")
  const action = await first.settled
  assert.equal(action.kind, "palette")

  const second = startComposer(screen, {
    initialDraft: action.draft,
    initialCursor: action.cursor,
  })
  const row = promptRows(screen).join("\n")
  assert.match(row, /half-written prompt/)
  // The cursor came back inside the word (2 chars from the end), so typing lands there.
  second.harness.type("!")
  assert.match(promptRows(screen).join("\n"), /half-written prom!pt/)
  second.harness.ctrl("c")
  second.harness.ctrl("c")
  await second.settled
})

test("TUI-13: the composer stays painted, busy, and non-submittable while a turn runs", async () => {
  const screen = new Screen(80, 24)
  let release: (() => void) | undefined
  let activitySeen: string | undefined
  const { harness, settled } = startComposer(screen, {
    runTurn: async (ctx) => {
      ctx.setActivity("Waiting for test-model at 127.0.0.1:9/v1")
      ctx.write("assistant: working on it\n")
      await new Promise<void>((resolve) => {
        release = resolve
      })
      activitySeen = undefined
      ctx.write("assistant: done\n")
    },
  })

  harness.type("hi")
  harness.press("enter")
  await flush()

  const busyScreen = screen.lines().join("\n")
  assert.match(busyScreen, /Waiting for test-model/, "the activity row must name the model")
  assert.match(busyScreen, /esc\/ctrl\+c cancel/, "the cancel shortcut must stay visible")
  assert.ok(promptRows(screen).length >= 1, "the prompt box must still be painted")
  assert.match(busyScreen, /assistant: working on it/, "output must appear above the prompt")

  // A second submit while busy is ignored: no new prompt row is committed.
  harness.type("second")
  harness.press("enter")
  await flush()
  assert.ok(!screen.lines().join("\n").includes("┃ ❯ second"))

  release?.()
  await flush()
  assert.match(screen.lines().join("\n"), /assistant: done/)

  // Editable again: typing lands in the composer after the turn.
  harness.type("next draft")
  assert.match(promptRows(screen).join("\n"), /next draft/)
  void activitySeen

  harness.ctrl("c")
  harness.ctrl("c")
  const action = await settled
  assert.equal(action.kind, "exit")
})

test("TUI-13: cancelling a turn aborts it and returns to editing without exiting", async () => {
  const screen = new Screen(80, 24)
  let aborted = false
  const { harness, settled } = startComposer(screen, {
    runTurn: async (ctx) => {
      ctx.setActivity("Waiting for slow-model")
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true
          resolve()
        })
      })
    },
  })
  harness.type("hi")
  harness.press("enter")
  await flush()
  harness.press("escape")
  await flush()
  assert.equal(aborted, true, "Esc must abort the running turn")
  harness.type("after cancel")
  assert.match(promptRows(screen).join("\n"), /after cancel/)
  harness.ctrl("c")
  harness.ctrl("c")
  await settled
})

test("TUI-13: a cancelled first prompt restores the draft instead of losing it", async () => {
  const screen = new Screen(80, 24)
  const { harness, settled } = startComposer(screen, {
    runTurn: async () => ({ restoreDraft: "hi" }),
  })
  harness.type("hi")
  harness.press("enter")
  await flush()
  assert.match(promptRows(screen).join("\n"), /hi/, "the first prompt must come back")
  harness.ctrl("c")
  harness.ctrl("c")
  await settled
})

test("TUI-12: the activity line keeps the cancel shortcut inside the width at 50/40/80 cols", () => {
  const style = createStyle(false)
  for (const cols of [80, 50, 40]) {
    const row = renderActivityLine(
      "Waiting for a-very-long-model-name at 127.0.0.1:11434/v1",
      12300,
      cols,
      style,
    )
    assert.ok(visibleWidth(row) <= cols, `${cols} cols overflow: ${visibleWidth(row)}`)
    assert.match(row, /esc/, `cancel hint missing at ${cols} cols: ${row}`)
    assert.match(row, /12\.3s/)
  }
})

test("TUI-04: the field view keeps the typed value on its own visible row at 40 cols", () => {
  const style = createStyle(false)
  const url = "http://127.0.0.1:11434/v1/very/long/path/that/keeps/going"
  const view = renderFieldView("Endpoint URL (https://...): ", url, url.length, 40, style)
  assert.equal(view.rows.length, 2, "label row + value row, no wrapping")
  assert.ok(!view.rows[0]!.includes("127.0.0.1"), "the label row must not carry the value")
  assert.match(view.rows[1]!, /going$/, "the tail of the value must stay visible")
  assert.ok(view.cursorCol <= 40)
  for (const row of view.rows) assert.ok(visibleWidth(row) <= 40)
})

/** Scripted non-TTY IO used for wizard and picker flows. */
function scriptedIO(answers: (string | null)[]): { io: TerminalIO; out: () => string } {
  let out = ""
  let idx = 0
  return {
    io: {
      isTTY: true,
      write: (t: string) => {
        out += t
      },
      writeError: (t: string) => {
        out += t
      },
      ask: async () => (idx < answers.length ? answers[idx++]! : null),
      close: () => undefined,
    },
    out: () => out,
  }
}

function mockModelsFetch(models: string[]): typeof fetch {
  return (async (input: string | URL | { url: string }) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
}

test("TUI-06/TUI-07: the provider picker filters live and defaults local presets to no key", async () => {
  const screen = new Screen(55, 16)
  const harness = makeRaw(screen)
  const style = createStyle(false)
  const options = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    display: `${String(i + 1).padStart(2, " ")} ${i === 3 ? "Ollama" : `Provider ${i + 1}`}`,
  }))
  const settled = askHybridChoice(
    harness.raw,
    style,
    "Select provider [1-12 or id] (or 'cancel'): ",
    options,
    {
      initialValue: "3",
    },
  )
  harness.type("oll")
  const filtered = screen.lines().join("\n")
  assert.match(filtered, /1 of 12 shown/, "typing must narrow the list")
  assert.match(filtered, /Ollama/)
  assert.ok(!/Provider 1\b/.test(filtered), "non-matching rows must disappear")
  harness.press("enter")
  assert.equal(await settled, "oll")

  // initialValue: Enter on an untouched list accepts the preset's default (Ollama -> none = 3).
  const screen2 = new Screen(55, 16)
  const harness2 = makeRaw(screen2)
  const settled2 = askHybridChoice(
    harness2.raw,
    createStyle(false),
    "Choose [1/2/3/4] (or 'cancel'): ",
    [
      { value: "1", display: "1) Environment variable name" },
      { value: "2", display: "2) Key file path" },
      { value: "3", display: "3) None (no key needed)" },
      { value: "4", display: "4) Enter / paste API key" },
    ],
    { initialValue: "3" },
  )
  harness2.press("enter")
  assert.equal(await settled2, "3", "the no-key option must be the default for local providers")
})

test("TUI-05: /model switches only the model and keeps endpoint + credentials", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-model-picker-"))
  try {
    const existing: StandaloneConfig = {
      version: 1,
      providerId: "ollama",
      endpointType: "local",
      baseURL: "http://127.0.0.1:2244/v1",
      model: "qwen2.5-coder",
      credential: { kind: "none" },
      updatedAt: "2026-11-28T00:00:00.000Z",
    }
    saveStandaloneConfig(dir, existing)
    // Pick entry 2 from the curated list; no endpoint or credential questions are asked.
    const scripted = scriptedIO(["2"])
    const res = await runModelPicker(scripted.io, dir, {}, existing)
    assert.equal(res.status, "saved")
    const loaded = loadStandaloneConfig(dir)
    assert.equal(loaded.status, "ok")
    if (loaded.status !== "ok") return
    assert.notEqual(loaded.config.model, existing.model, "the chosen model must be applied")
    assert.equal(loaded.config.baseURL, "http://127.0.0.1:2244/v1", "endpoint must be preserved")
    assert.deepEqual(loaded.config.credential, { kind: "none" })
    assert.equal(loaded.config.connectionStatus, "unverified")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI-08/TUI-09: discovery labels detected vs suggested models and /test result persists", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-wizard-tags-"))
  try {
    // ollama -> default endpoint -> auth default (none) -> fetch -> pick detected #1 -> save
    const scripted = scriptedIO(["ollama", "", "3", "f", "1", "y"])
    const res = await runInteractiveSetup(scripted.io, dir, {}, undefined, {
      fetchImpl: mockModelsFetch(["live-alpha", "live-beta"]),
    })
    assert.equal(res.status, "saved")
    const out = scripted.out()
    assert.match(out, /· detected/, "discovered models must be labelled detected")
    assert.match(out, /· suggested/, "catalog models must be labelled suggested")
    assert.match(out, /Found 2 live model\(s\) from .*\(1 GET \/models request sent\)/)
    assert.match(out, /1 discovery request\(s\) sent for GET \/models/)

    const loaded = loadStandaloneConfig(dir)
    assert.equal(loaded.status, "ok")
    if (loaded.status !== "ok") return
    assert.equal(loaded.config.model, "live-alpha")
    assert.deepEqual(loaded.config.credential, { kind: "none" })

    // applyConnectionTestResult is the single source of the persisted verification state.
    const verified = applyConnectionTestResult(
      { ok: true, latencyMs: 42, toolSupport: "supported" },
      "2026-11-28T10:00:00.000Z",
    )
    assert.equal(verified.connectionStatus, "verified")
    assert.equal(verified.lastVerifiedAt, "2026-11-28T10:00:00.000Z")
    assert.equal(verified.lastTest.toolSupport, "supported")
    assert.equal(verified.lastTest.chatReachable, true)

    const chatOnly = applyConnectionTestResult({
      ok: true,
      latencyMs: 11,
      toolSupport: "unsupported",
    })
    assert.equal(chatOnly.connectionStatus, "unverified", "chat-only must not claim verification")
    assert.equal(chatOnly.lastTest.chatReachable, true)
    assert.equal(chatOnly.lastTest.toolSupport, "unsupported")

    const failed = applyConnectionTestResult({ ok: false, latencyMs: 5, errorKind: "timeout" })
    assert.equal(failed.connectionStatus, "failed")
    assert.equal(failed.lastTest.chatReachable, false)

    const report = renderStatusReport({
      session: createSession(dir, undefined),
      workspace: dir,
      trusted: true,
      permissionMode: "accept-edits",
      savedRules: 0,
      config: {
        ...loaded.config,
        connectionStatus: verified.connectionStatus,
        ...(verified.lastVerifiedAt === undefined
          ? {}
          : { lastVerifiedAt: verified.lastVerifiedAt }),
        lastTest: verified.lastTest,
      },
    }).join("\n")
    assert.match(report, /Connection verified \(last test 2026-11-28T10:00:00\.000Z\)/)
    assert.match(report, /Chat\s+reachable \(42 ms\)/)
    assert.match(report, /Tools\s+supported/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI-04/TUI-02: cancelling setup at any step writes no partial profile and offers back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-wizard-back-"))
  try {
    // Endpoint -> Esc back to provider list -> cancel from the first step.
    const scripted = scriptedIO(["ollama", "back", "cancel"])
    const res = await runInteractiveSetup(scripted.io, dir, {})
    assert.equal(res.status, "cancelled")
    assert.equal(existsSync(standaloneConfigFile(dir)), false)
    assert.equal(
      scripted.out().split("Hosted providers (HTTPS").length - 1,
      2,
      "back must repaint the provider list instead of cancelling",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI-04: the review step lists the test/back/cancel shortcuts", () => {
  assert.match(reviewShortcutHint(true), /t test · y save · b back · esc cancel/)
  assert.match(reviewShortcutHint(false), /t test · y save · esc cancel/)
  assert.ok(visibleWidth(reviewShortcutHint(true)) + 2 <= 40, "the hint must fit a 40-column pane")
})
