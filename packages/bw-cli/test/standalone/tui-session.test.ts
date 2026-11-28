import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { paths } from "../../src/paths.ts"
import { createBoundaryContext, grantWorkspaceTrust } from "../../src/standalone/security.ts"
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
  countDiffChanges,
  createKeyParserState,
  createStyle,
  feedKeyParser,
  flushPendingEscape,
  formatPromptMetadata,
  formatStatusFooterLine,
  getTerminalLayout,
  renderActivityRow,
  renderOpenCodeDiff,
  renderOpenCodeMarkdown,
  renderOpenCodeShellCard,
  renderSessionStatus,
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
    assert.equal(
      readFileSync(savedFile, "utf8").includes(secret),
      false,
      "Secret must be scrubbed from saved session",
    )

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
  | { readonly signal: string; readonly delay?: number }

async function runPtyDriver(
  ws: string,
  home: string,
  rows: number,
  cols: number,
  steps: readonly PtyStep[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; output: string }> {
  const binPath = path.resolve("packages/bw-cli/src/standalone/bin.ts")
  const driver = `
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
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
    if "signal" in step: os.kill(pid, getattr(signal, step["signal"]))
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
  const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
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
      const baseEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "NO_COLOR" && k !== "FORCE_COLOR") baseEnv[k] = v
      }
      for (const [k, v] of Object.entries(envOverrides)) {
        if (v === undefined) delete baseEnv[k]
        else baseEnv[k] = v
      }
      baseEnv["BASHWINK_HOME"] = home
      baseEnv["TERM"] = envOverrides["TERM"] ?? "xterm-256color"
      child.stdin.end(
        JSON.stringify({
          argv: [
            process.execPath,
            "--disable-warning=ExperimentalWarning",
            "--experimental-strip-types",
            binPath,
          ],
          cwd: ws,
          rows,
          cols,
          env: baseEnv,
          steps,
        }),
      )
    },
  )
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
                        arguments: JSON.stringify({
                          path: "note.txt",
                          oldText: "initial",
                          newText: "updated",
                        }),
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
            choices: [
              { finish_reason: "stop", message: { role: "assistant", content: "TURN_ONE_DONE" } },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: "TURN_TWO_DONE" } },
          ],
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
      { wait: "❯ ", send: "change note\r" },
      { wait: "approved (accept-edits)" },
      { wait: "Edit " },
      { wait: "+1" },
      { wait: "TURN_ONE_DONE" },
      // Inspect `/diff` modal to verify line-numbered diff card persists in session turn
      { wait: "❯ ", send: "/diff\r" },
      { wait: "Session Changes" },
      { wait: "note.txt", delay: 0.05, send: "q" },
      { wait: "❯ ", send: "follow up\r" },
      { wait: "TURN_TWO_DONE" },
      // Open Command Palette (Ctrl+P) -> select status via typing 'status' + Enter
      { wait: "❯ ", send: "\x10" },
      { wait: "Bashwink Command Palette", delay: 0.05, send: "status\r" },
      { wait: "--- Status ---" },
      // Open Transcript Viewer (Ctrl+T) -> close with 'q'
      { wait: "❯ ", send: "\x14" },
      { wait: "Transcript", delay: 0.05, send: "q" },
      // Open Session Browser (Ctrl+O) -> close with Esc
      { wait: "❯ ", send: "\x0f" },
      { wait: "Sessions", delay: 0.05, send: "\x1b" },
      // Double-tap Escape -> Timeline & Rewind -> press 'r' to restore files+chat back to turn 1!
      { wait: "❯ ", delay: 0.05, send: "\x1b" },
      { delay: 0.08, send: "\x1b" },
      { wait: "Turn 2 Snapshot", delay: 0.05, send: "\x1b[A" }, // move up to Turn 1
      { wait: "Turn 1 Snapshot", delay: 0.05, send: "r" },
      { wait: "Rewound 2 turn(s); restored 1 file(s)" },
      { wait: "❯ ", send: "\x03" }, // clear restored draft from composer
      { delay: 0.05, send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 30, 100, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    // Verify multi-turn conversation history was carried into Turn 2 request!
    assert.ok(
      seenMessages[2]!.length > seenMessages[0]!.length,
      "Expected Turn 2 to include Turn 1 history",
    )
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

  const plainStyle = createStyle(false)
  const wideMeta = formatPromptMetadata(
    {
      agent: "build",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      trustLabel: "trusted",
      trusted: true,
    },
    80,
    plainStyle,
  )
  assert.equal(wideMeta, "build · claude-sonnet-4-6 · anthropic · trusted")

  const narrowMeta = formatPromptMetadata(
    {
      agent: "build",
      model: "very-long-model-name-identifier",
      provider: "openrouter",
      trustLabel: "trusted",
    },
    26,
    plainStyle,
  )
  assert.ok(visibleWidth(narrowMeta) <= 26)

  const wideFooter = formatStatusFooterLine(
    {
      location: "~/bashwink (main)",
      turnsCount: 2,
      tokensText: "1.4k tok",
      costText: "$0.0042",
      shortcuts: [
        { key: "ctrl+p", label: "commands" },
        { key: "ctrl+o", label: "sessions" },
      ],
    },
    100,
    plainStyle,
  )
  assert.equal(visibleWidth(wideFooter), 100)
  assert.ok(wideFooter.startsWith("~/bashwink (main)"))
  assert.ok(wideFooter.endsWith("ctrl+o sessions"))

  const tightFooter = formatStatusFooterLine(
    {
      location: "~/workspace/some/very/deep/project (main)",
      statusMessage: "Esc×2 to rewind",
      turnsCount: 3,
      tokensText: "5.2k tok",
      shortcuts: [{ key: "ctrl+p", label: "commands" }],
    },
    42,
    plainStyle,
  )
  assert.ok(visibleWidth(tightFooter) <= 42)
  assert.ok(tightFooter.includes("Esc×2 to rewind"))

  const sessionStatus = renderSessionStatus({
    model: "accounts/fireworks/models/deepseek-v3p2-custom-endpoint-v12345",
    mode: "ask",
    readOnly: true,
    requests: 4,
    requestLimit: 20,
    context: { tokens: 25_000, limit: 96_000 },
  }, 79, plainStyle)
  assert.match(sessionStatus, /Context ~25k\/96k target \(26%\).*Requests 4\/20.*ASK MODE · Read-only/)
  assert.ok(visibleWidth(sessionStatus) <= 79)
  const editRow = renderActivityRow("Edit", "一個目錄/更長目錄/較長資料夾/auth.ts", "(+1 -1)", 38, plainStyle)
  assert.ok(editRow.includes("auth.ts"))
  assert.ok(visibleWidth(editRow) <= 38)

  const samplePatch = [
    "--- src/math.ts",
    "+++ src/math.ts",
    "@@ -4,3 +4,3 @@",
    "  export function sum(a: number, b: number) {",
    "-   return a - b;",
    "+   return a + b;",
    "  }",
  ].join("\n")
  assert.deepEqual(countDiffChanges(samplePatch), { additions: 1, deletions: 1 })

  const unified = renderOpenCodeDiff(
    samplePatch,
    { path: "src/math.ts", maxWidth: 80, view: "unified" },
    plainStyle,
  )
  assert.ok(unified[0]!.includes("← Edit"))
  assert.ok(unified[0]!.includes("+1 -1"))
  assert.ok(unified.some((l) => l.includes("5 -   return a - b;")))
  assert.ok(unified.some((l) => l.includes("5 +   return a + b;")))
  assert.ok(unified.at(-1)!.startsWith("╹"))

  const split = renderOpenCodeDiff(
    samplePatch,
    { path: "src/math.ts", maxWidth: 120, view: "split" },
    createStyle(true),
  )
  assert.ok(split.some((l) => l.includes("│") && l.includes(" - ") && l.includes(" + ")))

  const created = renderOpenCodeDiff(
    "+++ src/new.ts (new file)\n@@ -0,0 +1,2 @@\n+ const a = 1;\n+ export { a };",
    { path: "src/new.ts", create: true, maxWidth: 130 },
    plainStyle,
  )
  assert.ok(created[0]!.includes("# Created"))
  assert.ok(created[0]!.includes("+2"))
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
      { wait: "v0.2.0-alpha.2" },
      { wait: "┃ " },
      { wait: "❯ " },
      { wait: "resize-model" },
      { wait: "commands" },
      // Shrink live to compact pane (48x16) -> composer and model remain visible
      { resize: [16, 48] as const, delay: 0.08 },
      { wait: "❯ " },
      { wait: "resize-model" },
      // Open Command Palette while narrow -> compact hint bar renders without wrapping
      { send: "\x10", delay: 0.05 },
      { wait: "Type filter · Esc" },
      // Resize palette live back to wide (110x28) -> palette expands to full hint bar
      { resize: [28, 110] as const, delay: 0.08 },
      { wait: "(Bashwink Command Palette)" },
      { send: "\x1b", delay: 0.05 },
      { wait: "\x1b[?1049l" },
      { wait: "❯ ", send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 32, 120, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("real PTY bottom-pinned composer, Shift+Tab mode cycling, Always allow persistence, and clean /exit", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-opencode-box-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(path.join(ws, "one.txt"), "old1\n", "utf8")
  writeFileSync(path.join(ws, "two.txt"), "old2\n", "utf8")

  let turn = 0
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += String(c)))
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string }> }
      const hasToolMsg = (body.messages ?? []).some((m) => m.role === "tool")
      res.writeHead(200, { "content-type": "application/json" })
      if (!hasToolMsg) {
        turn += 1
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: `e_${turn}_1`,
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "one.txt",
                          oldText: "old1",
                          newText: "new1",
                        }),
                      },
                    },
                    {
                      id: `e_${turn}_2`,
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "two.txt",
                          oldText: "old2",
                          newText: "new2",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Both files updated." },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = (srv.address() as { port: number }).port

  try {
    const resolved = paths({ BASHWINK_HOME: home })
    mkdirSync(resolved.config, { recursive: true })
    writeFileSync(
      path.join(resolved.config, "standalone.json"),
      JSON.stringify({
        version: 1,
        providerId: "custom-local",
        endpointType: "local",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "box-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      }),
      "utf8",
    )
    grantWorkspaceTrust(resolved.config, ws, "tester")

    const steps = [
      { wait: "❯ " },
      { wait: "ACCEPT-EDITS MODE" },
      { wait: "shift+tab" },
      // Shift+Tab cycles mode while preserving draft text: accept-edits -> smart -> auto -> manual -> ask -> accept-edits
      { send: "draft text\x1b[Z" },
      { wait: "SMART MODE" },
      { send: "\x1b[Z" },
      { wait: "AUTO MODE" },
      { send: "\x1b[Z" },
      { wait: "MANUAL MODE" },
      { send: "\x1b[Z" },
      { wait: "ASK MODE" },
      { send: "\x1b[Z" },
      { wait: "ACCEPT-EDITS MODE" },
      { send: "\x03" }, // Clear "draft text"
      { wait: "Cleared input", send: "/mode manual\r" },
      { wait: "Permission mode set to 'manual'." },
      { wait: "❯ ", send: "update both files\r" },
      { wait: "Apply this change? [y/N]" },
      { wait: "Always allow (a)" },
      { send: "a\r" }, // Save Always allow for edit_file -> second edit auto-approves without prompting!
      { wait: "Both files updated." },
      { wait: "❯ ", send: "/mode ask\r" },
      { wait: "Permission mode set to 'ask'." },
      { wait: "ASK MODE", send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 30, 110, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    assert.ok(parsed.output.includes("\x1b[38;5;243m" + "─".repeat(109)))
    assert.equal(readFileSync(path.join(ws, "one.txt"), "utf8"), "new1\n")
    assert.equal(readFileSync(path.join(ws, "two.txt"), "utf8"), "new2\n")
    // Verify confirmation widget appeared only ONCE across the two edits, and second edit used the saved rule
    assert.equal(parsed.output.split("Always allow (a)").length - 1, 1)
    assert.ok(parsed.output.includes("approved (rule)"))
    // Verify clean /exit clears the composer.
    const tailAfterGoodbye = parsed.output.split("Both files updated.")[1] ?? ""
    const strippedTail = stripAnsiSequences(tailAfterGoodbye).trimEnd()
    assert.ok(!strippedTail.endsWith("─"))
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("OpenCode markdown table/code renderer, shell card, grouped read burst, and auto-mode unified diff in PTY", async (t) => {
  const plain = createStyle(false)
  const mdLines = renderOpenCodeMarkdown(
    [
      "## Workspace Folders",
      "",
      "| Folder | Summary |",
      "|---|---|",
      "| `read_file` | Reads a file safely without touching `_private_var` markers. |",
      "| `bw-cli` | Standalone TypeScript CLI with **evidence** logging. |",
      "",
      "```ts",
      "export const ok = true;",
      "```",
    ].join("\n"),
    64,
    plain,
  )
  const mdJoined = mdLines.join("\n")
  assert.ok(mdJoined.includes("Workspace Folders"))
  assert.ok(!mdJoined.includes("## "))
  assert.ok(mdJoined.includes("┌"))
  assert.ok(mdJoined.includes("└"))
  assert.ok(mdJoined.includes("read_file"))
  assert.ok(mdJoined.includes("_private_var"))
  assert.ok(mdJoined.includes("┃ ts"))
  assert.ok(mdLines.every((l) => visibleWidth(l) <= 64))

  const shellCard = renderOpenCodeShellCard(
    {
      command: "npm test",
      output: "exitCode: 0\npass 1\npass 2",
      status: "ok",
      exitCode: 0,
      maxWidth: 80,
    },
    plain,
  ).join("\n")
  assert.ok(shellCard.includes("$ npm test"))
  assert.ok(shellCard.includes("✓ exit 0"))
  assert.ok(shellCard.includes("pass 1"))

  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-job-ui-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    writeFileSync(path.join(ws, name), `${name}: old-value\n`, "utf8")
  }

  let step = 0
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += String(c)))
    req.on("end", () => {
      req.resume()
      step += 1
      res.writeHead(200, { "content-type": "application/json" })
      if (step === 1) {
        // Burst of 5 read/list calls -> must collapse cleanly into grouped summary instead of 5 spam lines
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "l1",
                      type: "function",
                      function: { name: "list_files", arguments: "{}" },
                    },
                    {
                      id: "r1",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
                    },
                    {
                      id: "r2",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) },
                    },
                    {
                      id: "r3",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "c.txt" }) },
                    },
                    {
                      id: "r4",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "d.txt" }) },
                    },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      if (step === 2) {
        // Edit in auto mode and show the applied unified diff in the transcript.
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "ed1",
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "a.txt",
                          oldText: "old-value",
                          newText: "new-value",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "## Done\n\n| File | Status |\n|---|---|\n| `a.txt` | updated cleanly |",
              },
            },
          ],
        }),
      )
    })
  })

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = (srv.address() as { port: number }).port

  try {
    const resolved = paths({ BASHWINK_HOME: home })
    mkdirSync(resolved.config, { recursive: true })
    writeFileSync(
      path.join(resolved.config, "standalone.json"),
      JSON.stringify({
        version: 1,
        providerId: "custom-local",
        endpointType: "local",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "ui-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      }),
      "utf8",
    )
    grantWorkspaceTrust(resolved.config, ws, "tester")

    const steps = [
      { wait: "❯ ", send: "/mode auto\r" },
      { wait: "Permission mode set to 'auto'." },
      { wait: "❯ ", send: "inspect and update\r" },
      { wait: "Outcome   completed" },
      { wait: "❯ ", send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 36, 130, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    const clean = stripAnsiSequences(parsed.output)
    assert.ok(clean.includes("Explored listed 1 dir, read 4 files"))
    assert.ok(!clean.includes("→ read_file -> ok"))
    assert.match(clean, /Edit\s+a\.txt\s+\(\+1 -1\)/)
    assert.ok(clean.includes("-  a.txt: old-value") && clean.includes("+  a.txt: new-value"))
    assert.match(clean, /events recorded · hash chain verified/)
    assert.match(clean, /Context ~.*Requests 3\/20/)
    assert.ok(clean.includes("│"))
    // Markdown table rendered via Unicode box drawing
    assert.ok(clean.includes("┌") && clean.includes("File") && clean.includes("updated cleanly"))
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("real PTY untrusted session unlocks & switches to accept-edits on bare Enter at Shall I edit prompt", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-untrusted-enter-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })

  let turn = 0
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += String(c)))
    req.on("end", () => {
      req.resume()
      turn += 1
      res.writeHead(200, { "content-type": "application/json" })
      if (turn === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "c_new_1",
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "hello.py",
                          create: true,
                          newText: "print('hi')\n",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: "Created hello.py." } },
          ],
        }),
      )
    })
  })

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = (srv.address() as { port: number }).port

  try {
    const resolved = paths({ BASHWINK_HOME: home })
    mkdirSync(resolved.config, { recursive: true })
    writeFileSync(
      path.join(resolved.config, "standalone.json"),
      JSON.stringify({
        version: 1,
        providerId: "custom-local",
        endpointType: "local",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "unlock-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      }),
      "utf8",
    )

    // Deliberately DO NOT pre-trust workspace; decline startup trust via Enter -> inline edit unlock accepts on bare Enter!
    const steps = [
      { wait: "❯ ", send: "create hello.py\r" },
      { wait: "Trust this workspace for interactive edit/command approvals? [y/N]", send: "\r" },
      { wait: "Continuing in read-only mode" },
      { wait: "Shall I edit & switch to accept-edits mode? [Y/n]", delay: 0.05, send: "\r" },
      { wait: "Created hello.py." },
      { wait: "ACCEPT-EDITS MODE" },
      { send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 32, 120, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    assert.equal(readFileSync(path.join(ws, "hello.py"), "utf8"), "print('hi')\n")
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test("SIGTERM ends the prompt and the transcript viewer instead of wedging the terminal", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-tui-signal-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })

  try {
    // At the prompt: dispose() used to remove the key listener without settling the composer,
    // so the process stayed alive with a dead prompt and Ctrl+C did nothing.
    const prompt = await runPtyDriver(ws, home, 30, 100, [
      { wait: "❯ " },
      { signal: "SIGTERM" },
    ])
    assert.equal(prompt.exitCode, 130, prompt.output)
    assert.ok(prompt.output.includes("Interrupted."), prompt.output)
    assert.ok(
      prompt.output.includes("\x1b[?25h\x1b[?2004l"),
      "the terminal must be restored before exit",
    )

    // Inside a full-screen overlay: the alternate screen must be left behind.
    const viewer = await runPtyDriver(ws, home, 30, 100, [
      { wait: "❯ " },
      { send: "/transcript\r" },
      { wait: "Transcript" },
      { signal: "SIGTERM" },
    ])
    assert.equal(viewer.exitCode, 130, viewer.output)
    assert.ok(viewer.output.includes("\x1b[?1049l"), "the alternate screen must be left")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("setup asks before saving a hosted provider with no credential", async (t) => {
  const pyCheck = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" })
  if (pyCheck.status !== 0) {
    t.skip("python3 pty module unavailable")
    return
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-tui-setup-"))
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })

  try {
    const steps = [
      { wait: "❯ ", delay: 0.05, send: "\r" },
      { wait: "Select provider", delay: 0.05, send: "12\r" },
      { wait: "Endpoint URL", delay: 0.05, send: "\r" },
      { wait: "Authentication:", delay: 0.05, send: "3\r" },
      { wait: "will reject unauthenticated requests", delay: 0.05, send: "n\r" },
      { wait: "Authentication:", delay: 0.05, send: "cancel\r" },
      { wait: "❯ ", delay: 0.05, send: "/exit\r" },
    ]
    const parsed = await runPtyDriver(ws, home, 31, 120, steps)
    assert.equal(parsed.exitCode, 0, parsed.output)
    assert.ok(
      parsed.output.includes("hosted endpoints reject this"),
      "the hosted auth menu must not offer a silent no-credential save",
    )
    assert.ok(
      parsed.output.includes("will reject unauthenticated requests"),
      "declining the warning must not save the config",
    )
    assert.ok(!existsSync(path.join(paths({ BASHWINK_HOME: home }).config, "standalone.json")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
