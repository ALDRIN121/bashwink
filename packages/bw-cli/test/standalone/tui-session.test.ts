import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { paths } from "../../src/paths.ts"
import {
  createBoundaryContext,
  grantWorkspaceTrust,
} from "../../src/standalone/security.ts"
import {
  appendPromptHistory,
  appendTurnToSession,
  captureFileCheckpoint,
  compactSessionMessages,
  createSession,
  deleteSession,
  forkSession,
  listSessions,
  listWorkspaceFiles,
  loadPromptHistory,
  loadSession,
  restoreTurnCheckpoints,
  rewindSessionToTurn,
  saveSession,
} from "../../src/standalone/session.ts"
import {
  createKeyParserState,
  feedKeyParser,
  flushPendingEscape,
  getTerminalLayout,
  stripAnsiSequences,
  truncatePathMiddle,
  truncatePlain,
  visibleWidth,
  wrapComposerLines,
  wrapPlainText,
  wrapStyledLine,
} from "../../src/standalone/tui-theme.ts"
import { findSlashCommand, fuzzyFilter, SLASH_COMMANDS } from "../../src/standalone/tui-widgets.ts"
import type { StandaloneConfig, TaskResult } from "../../src/standalone/types.ts"

test("key parser handles arrows, ctrl chords, Kitty shift+enter, bracketed paste, and standalone escape", () => {
  const st = createKeyParserState()
  assert.deepEqual(feedKeyParser(st, "\x1b[A\x1b[B\x1b[13;2u\x10\x0f\x12\x14"), [
    { kind: "key", name: "up", ctrl: false, alt: false },
    { kind: "key", name: "down", ctrl: false, alt: false },
    { kind: "key", name: "newline", shift: true, alt: false, ctrl: false },
    { kind: "ctrl", key: "p" },
    { kind: "ctrl", key: "o" },
    { kind: "ctrl", key: "r" },
    { kind: "ctrl", key: "t" },
  ])
  assert.deepEqual(feedKeyParser(st, "\x1b[200~line1\nline2\x1b[201~"), [
    { kind: "paste", text: "line1\nline2" },
  ])
  assert.deepEqual(feedKeyParser(st, "\x1b"), [])
  assert.deepEqual(flushPendingEscape(st), [{ kind: "key", name: "escape" }])
})

test("ANSI width, stripping, truncation, wrapping, and fuzzy filter helpers", () => {
  assert.equal(stripAnsiSequences("\x1b[38;5;75mhello\x1b[39m"), "hello")
  assert.equal(visibleWidth("\x1b[1mabc\x1b[22m"), 3)
  assert.equal(truncatePlain("abcdef", 4), "abc…")
  assert.deepEqual(wrapPlainText("abcdefghijklmnop", 12), ["abcdefghijkl", "mnop"])

  const hits = fuzzyFilter("timel", SLASH_COMMANDS, (c) => `${c.name} ${c.description}`)
  assert.equal(hits[0]?.name, "timeline")
  assert.equal(findSlashCommand("rewind")?.name, "timeline")
  assert.equal(findSlashCommand("resume")?.name, "sessions")
})

test("session persistence, secret redaction, fork, rewind with checkpoints, compact, and history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bw-session-test-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  const otherWs = path.join(root, "other")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(otherWs, { recursive: true })

  try {
    const resolved = paths({ BASHWINK_HOME: home })
    const secret = "sk-secret-value-123456"
    const config: StandaloneConfig = {
      version: 1,
      endpointType: "local",
      baseURL: "http://127.0.0.1:8080/v1",
      model: "test-model",
      credential: { kind: "none" },
      updatedAt: "2026-11-26T00:00:00.000Z",
    }

    writeFileSync(path.join(ws, "app.ts"), "const x = 1;\n", "utf8")
    const cp1 = captureFileCheckpoint(ws, "app.ts", path.join(ws, "app.ts"))
    assert.ok(cp1 && cp1.existedBefore)
    writeFileSync(path.join(ws, "app.ts"), "const x = 2;\n", "utf8")

    const cp2 = captureFileCheckpoint(ws, "created.ts", path.join(ws, "created.ts"))
    assert.ok(cp2 && !cp2.existedBefore)
    writeFileSync(path.join(ws, "created.ts"), "export const y = 3;\n", "utf8")

    let ses = createSession(ws, "main")
    const res1: TaskResult = {
      runId: "run-1",
      outcome: "completed",
      finalText: `Updated app.ts using ${secret}`,
      changedFiles: ["app.ts"],
      changedTests: [],
      commands: [],
      messages: [
        { role: "user", content: "update x to 2" },
        { role: "assistant", content: `Updated app.ts using ${secret}` },
      ],
      requests: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
      evidenceFile: "ev",
      runRecordFile: "rr",
    }
    ses = appendTurnToSession(ses, {
      userPrompt: "update x to 2",
      result: res1,
      model: "test-model",
      checkpoints: cp1 ? [cp1] : [],
    })

    const res2: TaskResult = {
      runId: "run-2",
      outcome: "completed",
      finalText: "Created created.ts",
      changedFiles: ["created.ts"],
      changedTests: [],
      commands: [],
      messages: [
        { role: "user", content: "create file" },
        { role: "assistant", content: "Created created.ts" },
      ],
      requests: 1,
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18, costUsd: 0.002 },
      evidenceFile: "ev",
      runRecordFile: "rr",
    }
    ses = appendTurnToSession(ses, {
      userPrompt: "create file",
      result: res2,
      model: "test-model",
      checkpoints: cp2 ? [cp2] : [],
    })

    const res3: TaskResult = {
      runId: "run-3",
      outcome: "completed",
      finalText: "Explained code",
      changedFiles: [],
      changedTests: [],
      commands: [],
      messages: [
        { role: "user", content: "explain" },
        { role: "assistant", content: "Explained code" },
      ],
      requests: 1,
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      evidenceFile: "ev",
      runRecordFile: "rr",
    }
    ses = appendTurnToSession(ses, {
      userPrompt: "explain",
      result: res3,
      model: "test-model",
      checkpoints: [],
    })

    const savedFile = saveSession(resolved.data, ses, secret)
    assert.equal(readFileSync(savedFile, "utf8").includes(secret), false, "Secret must be scrubbed from saved session")

    const loaded = loadSession(resolved.data, ses.id)
    assert.ok(loaded)
    assert.equal(loaded.turns.length, 3)
    assert.equal(loaded.messages.length, 6)

    // Fork at turn 2
    const forked = forkSession(loaded, 2)
    assert.equal(forked.turns.length, 2)
    assert.equal(forked.messages.length, 4)
    assert.equal(forked.parentSessionId, loaded.id)
    saveSession(resolved.data, forked)

    // Other workspace session filtering
    const otherSes = createSession(otherWs)
    saveSession(resolved.data, otherSes)
    assert.equal(listSessions(resolved.data, { workspace: ws }).length, 2)
    assert.equal(listSessions(resolved.data).length, 3)

    // Compact turns
    const compacted = compactSessionMessages(loaded, 2)
    assert.equal(compacted.summarizedTurns, 1)
    assert.equal(compacted.afterMessages, 5)

    // Rewind to turn index 1 (before turn 2 & 3) without trust -> restore must skip writes
    const untrustedBoundary = createBoundaryContext(ws, resolved, config, {})
    const rw = rewindSessionToTurn(loaded, 1)
    assert.equal(rw.updated.turns.length, 1)
    assert.equal(rw.promptToRestore, "create file")
    const skippedRes = restoreTurnCheckpoints(untrustedBoundary, rw.revertedTurns)
    assert.equal(skippedRes.skipped.length, 1)
    assert.equal(existsSync(path.join(ws, "created.ts")), true)

    // Grant trust -> restore removes created.ts and leaves app.ts at turn 1 state
    grantWorkspaceTrust(resolved.config, ws, "tester")
    const trustedBoundary = createBoundaryContext(ws, resolved, config, {})
    const restoredRes = restoreTurnCheckpoints(trustedBoundary, rw.revertedTurns)
    assert.deepEqual(restoredRes.removed, ["created.ts"])
    assert.equal(existsSync(path.join(ws, "created.ts")), false)

    // Rewind to turn 0 restores app.ts back to original bytes
    const rw0 = rewindSessionToTurn(loaded, 0)
    const restored0 = restoreTurnCheckpoints(trustedBoundary, rw0.revertedTurns)
    assert.ok(restored0.restored.includes("app.ts"))
    assert.equal(readFileSync(path.join(ws, "app.ts"), "utf8"), "const x = 1;\n")

    // Delete session
    assert.equal(deleteSession(resolved.data, forked.id), true)
    assert.equal(loadSession(resolved.data, forked.id), undefined)

    // Prompt history & workspace file listing
    appendPromptHistory(resolved.data, "first prompt")
    appendPromptHistory(resolved.data, "first prompt")
    appendPromptHistory(resolved.data, "second prompt")
    assert.deepEqual(loadPromptHistory(resolved.data), ["first prompt", "second prompt"])

    const files = listWorkspaceFiles(ws)
    assert.deepEqual(files, ["app.ts"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

type PtyStep =
  | { readonly wait: string; readonly delay?: number; readonly send?: string }
  | { readonly resize: readonly [number, number]; readonly delay?: number }
  | { readonly delay?: number; readonly send: string }

async function runPtyDriver(
  ws: string,
  home: string,
  rows: number,
  cols: number,
  steps: readonly PtyStep[],
): Promise<{ exitCode: number; output: string }> {
  const binPath = path.resolve("packages/bw-cli/src/standalone/bin.ts")
  const driver = `
import fcntl, json, os, pty, select, struct, sys, termios, time
spec = json.load(sys.stdin)
m, s = pty.openpty()
fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(s, termios.TIOCSCTTY, 0)
    os.dup2(s, 0); os.dup2(s, 1); os.dup2(s, 2)
    os.close(m); os.close(s)
    os.chdir(spec["cwd"])
    os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
os.close(s)
buf = bytearray(); cur = 0
def pump(t):
    end = time.monotonic() + t
    while time.monotonic() < end:
        r, _, _ = select.select([m], [], [], 0.05)
        if r:
            try: d = os.read(m, 4096)
            except OSError: return False
            if not d: return False
            buf.extend(d); return True
    return True
def wait_for(sub, t=12.0):
    global cur
    end = time.monotonic() + t
    tgt = sub.encode("utf-8")
    while time.monotonic() < end:
        idx = buf.find(tgt, cur)
        if idx != -1: cur = idx + len(tgt); return
        if not pump(0.1): break
    raise RuntimeError(f"Timeout waiting for {sub!r}. Output:\\n{buf.decode('utf-8', 'replace')}")
for step in spec["steps"]:
    if "wait" in step: wait_for(step["wait"])
    if "delay" in step: time.sleep(step["delay"])
    if "resize" in step:
        r, c = step["resize"]
        fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    if "send" in step: os.write(m, step["send"].encode("utf-8"))
end = time.monotonic() + 10.0
code = None
while time.monotonic() < end:
    pump(0.05)
    wp, st = os.waitpid(pid, os.WNOHANG)
    if wp == pid:
        code = os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st)
        break
os.close(m)
sys.stdout.write(json.dumps({"exitCode": code, "output": buf.decode("utf-8", "replace")}))
`
  const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", ["-c", driver], { stdio: ["pipe", "pipe", "pipe"] })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => outChunks.push(d))
    child.stderr.on("data", (d: Buffer) => errChunks.push(d))
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      })
    })
    child.stdin.end(
      JSON.stringify({
        argv: [process.execPath, "--disable-warning=ExperimentalWarning", "--experimental-strip-types", binPath],
        cwd: ws,
        rows,
        cols,
        env: { ...process.env, BASHWINK_HOME: home, TERM: "xterm-256color" },
        steps,
      }),
    )
  })
  assert.equal(res.status, 0, res.stderr)
  return JSON.parse(res.stdout) as { exitCode: number; output: string }
}

test("real PTY interactive TUI supports multi-turn history, Ctrl+P palette, Ctrl+O sessions, Esc Esc rewind, and Ctrl+T transcript", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-tui-pty-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(path.join(ws, "note.txt"), "initial\n", "utf8")

  const seenMessages: unknown[][] = []
  let reqNum = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      reqNum += 1
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown[] }
      seenMessages.push(body.messages)
      res.writeHead(200, { "content-type": "application/json" })
      if (reqNum === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "edit-1",
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({ path: "note.txt", oldText: "initial", newText: "updated" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
        return
      }
      if (reqNum === 2) {
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "TURN_ONE_DONE" } }],
            usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "TURN_TWO_DONE" } }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      )
    })
  })

  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const addr = server.address() as { port: number }

    const resolved = paths({ BASHWINK_HOME: home })
    mkdirSync(resolved.config, { recursive: true })
    writeFileSync(
      path.join(resolved.config, "standalone.json"),
      JSON.stringify({
        version: 1,
        providerId: "custom-local",
        endpointType: "local",
        baseURL: `http://127.0.0.1:${addr.port}/v1`,
        model: "pty-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      }),
      "utf8",
    )
    grantWorkspaceTrust(resolved.config, ws, "pty-tester")

    const steps = [
      { wait: "bashwink> ", send: "change note\r" },
      { wait: "Apply this change? [y/N]", send: "y\r" },
      { wait: "TURN_ONE_DONE" },
      { wait: "bashwink> ", send: "follow up\r" },
      { wait: "TURN_TWO_DONE" },
      // Open Command Palette (Ctrl+P) -> select status via typing 'status' + Enter
      { wait: "bashwink> ", send: "\x10" },
      { wait: "Bashwink Command Palette", delay: 0.05, send: "status\r" },
      { wait: "--- Status ---" },
      // Open Transcript Viewer (Ctrl+T) -> close with 'q'
      { wait: "bashwink> ", send: "\x14" },
      { wait: "Transcript", delay: 0.05, send: "q" },
      // Open Session Browser (Ctrl+O) -> close with Esc
      { wait: "bashwink> ", send: "\x0f" },
      { wait: "Sessions", delay: 0.05, send: "\x1b" },
      // Double-tap Escape -> Timeline & Rewind -> press 'r' to restore files+chat back to turn 1!
      { wait: "bashwink> ", delay: 0.05, send: "\x1b" },
      { delay: 0.08, send: "\x1b" },
      { wait: "Turn 2 Snapshot", delay: 0.05, send: "\x1b[A" }, // move up to Turn 1
      { wait: "Turn 1 Snapshot", delay: 0.05, send: "r" },
      { wait: "Rewound 2 turn(s); restored 1 file(s)" },
      { wait: "bashwink> ", send: "\x03" }, // clear restored draft from composer
      { delay: 0.05, send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 30, 100, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    // Verify multi-turn conversation history was carried into Turn 2 request!
    assert.ok(seenMessages[2]!.length > seenMessages[0]!.length, "Expected Turn 2 to include Turn 1 history")
    // Verify rewind restored note.txt back to "initial\n"!
    assert.equal(readFileSync(path.join(ws, "note.txt"), "utf8"), "initial\n")
  } finally {
    await new Promise((r) => server.close(() => r(undefined)))
    rmSync(root, { recursive: true, force: true })
  }
})

test("responsive layout tiers, middle path truncation, styled wrapping, and composer cursor wrapping", () => {
  const compact = getTerminalLayout(46, 16)
  assert.equal(compact.tier, "compact")
  assert.equal(compact.isCompact, true)
  assert.equal(compact.isNarrow, true)
  assert.equal(compact.isShort, true)
  assert.equal(compact.isWide, false)
  assert.equal(compact.boxWidth, 45)

  const standard = getTerminalLayout(80, 24)
  assert.equal(standard.tier, "standard")
  assert.equal(standard.isCompact, false)
  assert.equal(standard.isShort, false)
  assert.equal(standard.boxWidth, 79)

  const wide = getTerminalLayout(130, 36)
  assert.equal(wide.tier, "wide")
  assert.equal(wide.isWide, true)
  assert.equal(wide.boxWidth, 100)

  const shortened = truncatePathMiddle("/workspace/very/deep/nested/project/bashwink", 24)
  assert.ok(visibleWidth(shortened) <= 24)
  assert.ok(shortened.endsWith("bashwink"))

  const wrappedStyled = wrapStyledLine("\x1b[32mhello world from a long line\x1b[39m", 14)
  assert.ok(wrappedStyled.length >= 2)
  assert.ok(wrappedStyled.every((l) => visibleWidth(l) <= 14))

  const view = wrapComposerLines(
    [{ line: "abcdefghijklmnopqrstuvwxyz" }],
    0,
    22,
    "bw> ",
    "  │ ",
    "placeholder",
    false,
    18,
  )
  assert.equal(view.visualRows.length, 2)
  assert.ok(view.visualRows.every((r) => visibleWidth(r) <= 18))
  assert.equal(view.visualCursorRow, 1)
  assert.equal(view.visualCursorCol, 4 + (22 - 14))
})

test("real PTY auto-adjusts composer and modals live across wide -> narrow -> wide window resizes", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-resize-pty-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })

  try {
    const resolved = paths({ BASHWINK_HOME: home })
    mkdirSync(resolved.config, { recursive: true })
    writeFileSync(
      path.join(resolved.config, "standalone.json"),
      JSON.stringify({
        version: 1,
        providerId: "custom-local",
        endpointType: "local",
        baseURL: "http://127.0.0.1:11434/v1",
        model: "resize-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      }),
      "utf8",
    )

    const steps = [
      { wait: "[120×32]" },
      { wait: "Ask Bashwink to inspect, edit, or test" },
      // Shrink live to compact pane (48x16) -> composer immediately switches to compact placeholder
      { resize: [16, 48] as const, delay: 0.08 },
      { wait: "Ask Bashwink (/ cmd, @ file)" },
      // Open Command Palette while narrow -> compact hint bar renders without wrapping
      { send: "\x10", delay: 0.05 },
      { wait: "Type filter · Esc" },
      // Resize palette live back to wide (110x28) -> palette expands to full hint bar
      { resize: [28, 110] as const, delay: 0.08 },
      { wait: "(Bashwink Command Palette)" },
      { send: "\x1b", delay: 0.05 },
      { wait: "bashwink> ", send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 32, 120, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
