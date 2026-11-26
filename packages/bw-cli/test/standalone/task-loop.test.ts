import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { paths } from "../../src/paths.ts"
import { grantWorkspaceTrust, verifyEvidenceFile } from "../../src/standalone/security.ts"
import { pendingCalls, runTask, stepMessages } from "../../src/standalone/task-loop.ts"
import type { ProviderCompletion, StandaloneConfig, TaskEvent } from "../../src/standalone/types.ts"

function setupFixture(opts: { trusted?: boolean; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "bw-loop-test-"))
  const home = path.join(root, "profile")
  const workspace = path.join(root, "workspace")
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(workspace, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, "utf8")
  }
  const resolved = paths({ BASHWINK_HOME: home })
  if (opts.trusted !== false) {
    grantWorkspaceTrust(resolved.config, workspace, "tester")
  }
  const config: StandaloneConfig = {
    version: 1,
    endpointType: "local",
    baseURL: "http://127.0.0.1:8080/v1",
    model: "script-model",
    credential: { kind: "env", variable: "TEST_PROVIDER_KEY" },
    updatedAt: "2026-11-25T00:00:00.000Z",
    price: { inputUsdPer1M: 1, outputUsdPer1M: 2 },
  }
  return {
    root,
    home,
    workspace,
    paths: resolved,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// --- Ported OpenCode loop.ts (`c0ad18b`) + Pi (`b882d08`) unit cases ---
test("ported pendingCalls & stepMessages: skips providerExecuted, replays invalid JSON, stops on length", () => {
  const normal: ProviderCompletion = {
    text: "",
    finishReason: "tool_calls",
    toolCalls: [
      { id: "call-1", name: "read_file", input: { path: "a.txt" } },
      { id: "call-2", name: "hosted_search", input: {}, providerExecuted: true },
    ],
    toolInputErrors: [{ id: "call-3", name: "read_file", raw: '{"path":"a' }],
  }
  const calls = pendingCalls(normal)
  assert.deepEqual(
    calls.map((c) => c.call.id),
    ["call-1", "call-3"],
  )
  assert.match(calls[1]!.error ?? "", /Invalid tool arguments/)

  const msgs = stepMessages(normal, calls, [
    { callId: "call-1", tool: "read_file", status: "ok", output: "hello" },
    { callId: "call-3", tool: "read_file", status: "error", output: "bad" },
  ])
  assert.equal(msgs[0]!.role, "assistant")
  if (msgs[0]!.role === "assistant") {
    assert.equal(msgs[0]!.toolCalls?.length, 2)
    assert.deepEqual(msgs[0]!.toolCalls?.[1]!.input, {})
  }
  assert.equal(msgs[1]!.role, "tool")
  assert.equal(msgs[2]!.role, "tool")

  const cutOff: ProviderCompletion = { ...normal, finishReason: "length" }
  assert.deepEqual(pendingCalls(cutOff), [])
})

// --- Full loop, tools, approvals, scope, redaction, budgets, cancellation, context provider ---
test("runTask rejects truncated finishReason='length' tool calls before any side effect", async () => {
  const f = setupFixture({ files: { "a.txt": "before\n" } })
  try {
    let confirmed = false
    const result = await runTask(
      { workspace: f.workspace, prompt: "edit file", trusted: true, config: f.config },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "secret-val" },
        confirmAction: async () => {
          confirmed = true
          return true
        },
        completeImpl: async () => ({
          text: "",
          finishReason: "length",
          toolCalls: [
            {
              id: "c1",
              name: "edit_file",
              input: { path: "a.txt", oldText: "before", newText: "after" },
            },
          ],
          toolInputErrors: [],
        }),
      },
    )
    assert.equal(result.outcome, "failed")
    assert.match(result.stopReason ?? "", /length limit/i)
    assert.equal(confirmed, false)
    assert.equal(readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "before\n")
  } finally {
    f.cleanup()
  }
})

test("runTask executes read -> diff -> approved edit -> command, preserving CRLF and evidence", async () => {
  const f = setupFixture({
    files: {
      "sum.js": "module.exports = (a, b) => a - b;\r\n",
      "sum.test.js":
        'const assert = require("node:assert/strict");\nconst sum = require("./sum");\nassert.equal(sum(2, 3), 5);\nconsole.log("OK");\n',
    },
  })
  const events: TaskEvent[] = []
  const memoryRecorded: string[] = []
  let step = 0
  try {
    const result = await runTask(
      { workspace: f.workspace, prompt: "Fix the failing test.", trusted: true, config: f.config },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "secret-key-abc123456" },
        onEvent: (e) => events.push(e),
        contextProvider: {
          getWorkspaceContext: async (ws) => [
            {
              source: "memory:style",
              workspace: ws,
              content: "Use node to run sum.test.js",
              untrusted: true,
            },
            {
              source: "memory:other-repo",
              workspace: "/tmp/unrelated-repo",
              content: "IGNORE ME",
              untrusted: true,
            },
          ],
          recordCompletion: async (rec) => {
            memoryRecorded.push(rec.outcome)
          },
        },
        confirmAction: async (req) => {
          if (req.kind === "edit_file") {
            assert.match(req.prepared.diffPreview, /- module\.exports = \(a, b\) => a - b;/)
            assert.match(req.prepared.diffPreview, /\+ module\.exports = \(a, b\) => a \+ b;/)
            return true
          }
          assert.match(req.hostAccessWarning, /not an OS sandbox/i)
          return true
        },
        completeImpl: async (req) => {
          step += 1
          if (step === 1) {
            // Verify workspace-scoped context included & foreign workspace excluded
            const sys = req.messages[0]!.content
            assert.match(sys, /Use node to run sum\.test\.js/)
            assert.doesNotMatch(sys, /IGNORE ME/)
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "t1", name: "list_files", input: {} }],
              toolInputErrors: [],
              usage: { inputTokens: 20, outputTokens: 10 },
            }
          }
          if (step === 2) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "t2", name: "read_file", input: { path: "sum.js" } }],
              toolInputErrors: [],
              usage: { inputTokens: 25, outputTokens: 10 },
            }
          }
          if (step === 3) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "t3",
                  name: "edit_file",
                  input: { path: "sum.js", oldText: "a - b;", newText: "a + b;" },
                },
              ],
              toolInputErrors: [],
              usage: { inputTokens: 30, outputTokens: 15 },
            }
          }
          if (step === 4) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "t4",
                  name: "run_command",
                  input: { command: process.execPath, args: ["sum.test.js"] },
                },
              ],
              toolInputErrors: [],
              usage: { inputTokens: 35, outputTokens: 12 },
            }
          }
          return {
            text: "Fixed sum.js and verified sum.test.js passes.",
            finishReason: "stop",
            toolCalls: [],
            toolInputErrors: [],
            usage: { inputTokens: 40, outputTokens: 8 },
          }
        },
      },
    )

    assert.equal(result.outcome, "completed")
    assert.deepEqual(result.changedFiles, ["sum.js"])
    assert.deepEqual(result.changedTests, [])
    assert.equal(result.commands.length, 1)
    assert.equal(result.commands[0]!.exitCode, 0)
    assert.equal(
      readFileSync(path.join(f.workspace, "sum.js"), "utf8"),
      "module.exports = (a, b) => a + b;\r\n",
    )
    assert.deepEqual(memoryRecorded, ["completed"])
    assert.ok(events.some((e) => e.type === "task_finished"))
    const verified = verifyEvidenceFile(result.evidenceFile)
    assert.equal(verified.ok, true)
    assert.ok(verified.entries >= 8)
    const evText = readFileSync(result.evidenceFile, "utf8")
    assert.doesNotMatch(evText, /secret-key-abc123456/)
  } finally {
    f.cleanup()
  }
})

test("declined edit leaves file untouched, untrusted workspace blocks writes/commands, symlink escape & .git blocked", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "bw-outside-"))
  writeFileSync(path.join(outside, "secret.txt"), "topsecret")
  const f = setupFixture({
    trusted: false,
    files: { "a.txt": "original\n", ".git/HEAD": "ref: refs/heads/main\n" },
  })
  symlinkSync(outside, path.join(f.workspace, "escape-link"))

  let step = 0
  try {
    // Untrusted workspace blocks edit_file & run_command even before confirmation prompt
    const untrustedRes = await runTask(
      { workspace: f.workspace, prompt: "try write", trusted: false, config: f.config },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          step += 1
          if (step === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "c1",
                  name: "edit_file",
                  input: { path: "a.txt", oldText: "original", newText: "pwned" },
                },
                {
                  id: "c2",
                  name: "run_command",
                  input: { command: process.execPath, args: ["-e", "1"] },
                },
                { id: "c3", name: "read_file", input: { path: "escape-link/secret.txt" } },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "blocked", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(untrustedRes.changedFiles.length, 0)
    assert.equal(readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "original\n")

    // Now trust workspace, verify decline leaves file intact & .git edit denied & env secrets scrubbed
    grantWorkspaceTrust(f.paths.config, f.workspace, "tester")
    let tStep = 0
    const trustedRes = await runTask(
      { workspace: f.workspace, prompt: "test boundaries", trusted: true, config: f.config },
      {
        paths: f.paths,
        env: {
          ...process.env,
          TEST_PROVIDER_KEY: "secret-should-not-leak",
          OPENAI_API_KEY: "sk-leak-9999999999999999",
        },
        confirmAction: async (req) => {
          if (req.kind === "edit_file") return false // decline edit!
          return true // approve command checking env
        },
        completeImpl: async (req) => {
          tStep += 1
          if (tStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "d1",
                  name: "edit_file",
                  input: { path: "a.txt", oldText: "original", newText: "changed" },
                },
                {
                  id: "d2",
                  name: "edit_file",
                  input: { path: ".git/HEAD", oldText: "main", newText: "evil" },
                },
                {
                  id: "d3",
                  name: "run_command",
                  input: {
                    command: process.execPath,
                    args: [
                      "-e",
                      "console.log(JSON.stringify({t:process.env.TEST_PROVIDER_KEY||'',o:process.env.OPENAI_API_KEY||''})); process.exit(7)",
                    ],
                  },
                },
              ],
              toolInputErrors: [],
            }
          }
          const cmdToolMsg = req.messages.find((m) => m.role === "tool" && m.callId === "d3")
          assert.ok(cmdToolMsg && cmdToolMsg.role === "tool")
          assert.match(cmdToolMsg.content, /exitCode: 7/)
          assert.match(cmdToolMsg.content, /"t":"","o":""/)
          return {
            text: "observed decline and exit 7",
            finishReason: "stop",
            toolCalls: [],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(trustedRes.changedFiles.length, 0)
    assert.equal(readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "original\n")
    assert.equal(
      readFileSync(path.join(f.workspace, ".git/HEAD"), "utf8"),
      "ref: refs/heads/main\n",
    )
    assert.equal(trustedRes.commands[0]!.exitCode, 7)
  } finally {
    f.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test("runTask enforces maxRequests, maxCostUsd (with and without price), and repeated-failure stop", async () => {
  const f = setupFixture({ files: { "a.txt": "hello\n" } })
  try {
    // 1. maxRequests stop
    let reqCalls = 0
    const reqStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "loop",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 2 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          reqCalls += 1
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: `r-${reqCalls}`, name: "list_files", input: {} }],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(reqStop.outcome, "budget_stopped")
    assert.equal(reqStop.requests, 2)
    assert.match(reqStop.stopReason ?? "", /request limit/i)

    // 2. maxCostUsd rejected immediately when config has no declared price (0 outbound requests)
    const { price: _droppedPrice, ...noPriceConfig } = f.config
    void _droppedPrice
    let noPriceRequests = 0
    const noPriceStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "cost",
        trusted: true,
        config: noPriceConfig,
        budgets: { maxCostUsd: 0.01 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          noPriceRequests += 1
          return { text: "never", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(noPriceStop.outcome, "budget_stopped")
    assert.equal(noPriceRequests, 0)
    assert.match(noPriceStop.stopReason ?? "", /declares no price/i)

    // 3. maxCostUsd stops before next request when accumulated cost reaches budget
    let costCalls = 0
    const costStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "cost",
        trusted: true,
        config: f.config,
        budgets: { maxCostUsd: 0.005 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          costCalls += 1
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: `c-${costCalls}`, name: "list_files", input: {} }],
            toolInputErrors: [],
            usage: { inputTokens: 1000, outputTokens: 2000, costUsd: 0.006 },
          }
        },
      },
    )
    assert.equal(costStop.outcome, "budget_stopped")
    assert.equal(costCalls, 1)
    assert.match(costStop.stopReason ?? "", /cost budget/i)

    // 4. 3 identical consecutive failures stop the loop
    let failStep = 0
    const failStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "repeat fail",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 10, repeatedFailureLimit: 3 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          failStep += 1
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: `f-${failStep}`, name: "read_file", input: { path: "does-not-exist.txt" } },
            ],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(failStop.outcome, "budget_stopped")
    assert.equal(failStop.requests, 3)
    assert.match(failStop.stopReason ?? "", /3 consecutive identical tool failures/i)
  } finally {
    f.cleanup()
  }
})

test("cost-cap regression: accounts for input cost and remaining output allowance before every request", async () => {
  const f = setupFixture({ files: { "a.txt": "hello\n" } })
  try {
    // Regression 1: Previously ignored input cost + worst-case output allowance caused overrun before request 1.
    // Prompt + system + tools ~= 900 tokens; at $10/1M input that's ~$0.009 + 200 * $20/1M ($0.004) = ~$0.013 > $0.010.
    const highInputConfig: StandaloneConfig = {
      ...f.config,
      price: { inputUsdPer1M: 10, outputUsdPer1M: 20 },
    }
    let req1Calls = 0
    const stopBeforeReq1 = await runTask(
      {
        workspace: f.workspace,
        prompt: "inspect this codebase carefully",
        trusted: true,
        config: highInputConfig,
        budgets: { maxOutputTokens: 200, maxCostUsd: 0.01 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async () => {
          req1Calls += 1
          return { text: "overran", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(stopBeforeReq1.outcome, "budget_stopped")
    assert.equal(req1Calls, 0)
    assert.match(stopBeforeReq1.stopReason ?? "", /cost budget/i)

    // Regression 2 (EX-05): Remaining cost after step 1 + step 2 input cost fits a REDUCED output cap (< 80),
    // so step 2 runs with the affordable cap rather than prematurely aborting; then stops when budget is too small for 1 token.
    const stepSeenMaxOutput: (number | undefined)[] = []
    let stepCalls = 0
    const multiStepConfig: StandaloneConfig = {
      ...f.config,
      price: { inputUsdPer1M: 2, outputUsdPer1M: 10 },
    }
    const multiStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "stepped budget",
        trusted: true,
        config: multiStepConfig,
        budgets: { maxOutputTokens: 300, maxCostUsd: 0.008 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async (req) => {
          stepCalls += 1
          stepSeenMaxOutput.push(req.maxOutputTokens)
          if (stepCalls === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: `s-${stepCalls}`, name: "list_files", input: {} }],
              toolInputErrors: [],
              usage: { inputTokens: 1650, outputTokens: 220, costUsd: 0.0055 },
            }
          }
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: `s-${stepCalls}`, name: "list_files", input: {} }],
            toolInputErrors: [],
            usage: { inputTokens: 1650, outputTokens: 25, costUsd: 0.0025 },
          }
        },
      },
    )
    assert.equal(stepCalls, 2)
    assert.equal(stepSeenMaxOutput[0], 300)
    assert.ok((stepSeenMaxOutput[1] ?? 999) > 0 && (stepSeenMaxOutput[1] ?? 999) < 80)
    assert.equal(multiStop.outcome, "budget_stopped")

    // Regression 3: When step 2 DOES fit within maxCostUsd using REMAINING allowance (40 left out of 100),
    // it receives remaining allowance (40, not 100) rather than over-reserving total 100.
    const shrunkMaxOutput: (number | undefined)[] = []
    let fitStep = 0
    const fitConfig: StandaloneConfig = {
      ...f.config,
      price: { inputUsdPer1M: 1, outputUsdPer1M: 100 },
    }
    // 100 * $100/1M = $0.010; with budget $0.012:
    // step 1: $0.001 input + $0.010 (100 out) = $0.011 <= $0.012 -> runs with maxOutputTokens=100; actual output=60 ($0.0061 spent)
    // step 2 remaining out = 40 ($0.0040); $0.0061 + ~$0.0011 + $0.0040 = $0.0112 <= $0.012 -> runs with maxOutputTokens=40!
    const fitRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "shrunk remaining allowance",
        trusted: true,
        config: fitConfig,
        budgets: { maxOutputTokens: 100, maxCostUsd: 0.012 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async (req) => {
          fitStep += 1
          shrunkMaxOutput.push(req.maxOutputTokens)
          if (fitStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "f1", name: "list_files", input: {} }],
              toolInputErrors: [],
              usage: { inputTokens: 100, outputTokens: 60, costUsd: 0.0061 },
            }
          }
          return {
            text: "finished inside budget",
            finishReason: "stop",
            toolCalls: [],
            toolInputErrors: [],
            usage: { inputTokens: 150, outputTokens: 20, costUsd: 0.00215 },
          }
        },
      },
    )
    assert.equal(fitRes.outcome, "completed")
    assert.deepEqual(shrunkMaxOutput, [100, 40])
  } finally {
    f.cleanup()
  }
})

test("run_command kills timed-out child process tree and rejects missing executable", async () => {
  const f = setupFixture({ files: { "ok.txt": "1\n" } })
  let step = 0
  try {
    const res = await runTask(
      {
        workspace: f.workspace,
        prompt: "timeout test",
        trusted: true,
        config: f.config,
        budgets: { commandTimeoutMs: 120 },
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => true,
        completeImpl: async (req) => {
          step += 1
          if (step === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "to-1",
                  name: "run_command",
                  input: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
                },
                {
                  id: "missing-1",
                  name: "run_command",
                  input: { command: "bashwink-nonexistent-binary-xyz" },
                },
              ],
              toolInputErrors: [],
            }
          }
          const toMsg = req.messages.find((m) => m.role === "tool" && m.callId === "to-1")
          const missMsg = req.messages.find((m) => m.role === "tool" && m.callId === "missing-1")
          assert.ok(toMsg && toMsg.role === "tool")
          assert.match(toMsg.content, /\(timed out\)/)
          assert.ok(missMsg && missMsg.role === "tool")
          assert.match(missMsg.content, /executable not found/i)
          return { text: "done", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(res.outcome, "completed")
    assert.equal(res.commands.length, 1)
    assert.equal(res.commands[0]!.timedOut, true)
  } finally {
    f.cleanup()
  }
})

test("permission modes: always rule reuse, accept-edits, Hermes smart guardian + breaker, Claude auto, and untrusted floor", async () => {
  const f = setupFixture({ files: { "a.txt": "hello\n", "b.txt": "world\n" } })
  try {
    // 1) "always" decision saves rule and skips confirmAction for second edit
    const saved: Array<{ tool: "edit_file" | "run_command"; pattern: string }> = []
    let promptCount = 0
    let step = 0
    const alwaysRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "edit two files",
        trusted: true,
        config: f.config,
        permissionMode: "manual",
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        onSavePermissionRule: (r) => saved.push({ tool: r.tool, pattern: r.pattern }),
        confirmAction: async () => {
          promptCount += 1
          return "always"
        },
        completeImpl: async () => {
          step += 1
          if (step === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "e1",
                  name: "edit_file",
                  input: { path: "a.txt", oldText: "hello", newText: "hi" },
                },
                {
                  id: "e2",
                  name: "edit_file",
                  input: { path: "b.txt", oldText: "world", newText: "earth" },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "edited both", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(alwaysRes.outcome, "completed")
    assert.equal(promptCount, 1)
    assert.deepEqual(saved, [{ tool: "edit_file", pattern: "*" }])
    assert.equal(readFileSync(path.join(f.workspace, "a.txt"), "utf8"), "hi\n")
    assert.equal(readFileSync(path.join(f.workspace, "b.txt"), "utf8"), "earth\n")

    // 2) accept-edits auto-approves edits without confirmAction, still asks for run_command
    const promptedKinds: string[] = []
    let aeStep = 0
    const aeRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "accept-edits",
        trusted: true,
        config: f.config,
        permissionMode: "accept-edits",
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async (req) => {
          promptedKinds.push(req.kind)
          return false
        },
        completeImpl: async () => {
          aeStep += 1
          if (aeStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "ae1",
                  name: "edit_file",
                  input: { path: "a.txt", oldText: "hi", newText: "yo" },
                },
                {
                  id: "ae2",
                  name: "run_command",
                  input: { command: process.execPath, args: ["--version"] },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "done", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(aeRes.outcome, "completed")
    assert.deepEqual(promptedKinds, ["run_command"])

    // 3) smart mode (Hermes Guardian): APPROVE runs without prompt; DENY blocks allowAlways even if caller returns "always"; 3 denials trip breaker
    let smartCall = 0
    let guardianQueries = 0
    const escalatedReqs: Array<{ allowAlways?: boolean; smartDenied?: boolean; reason?: string }> =
      []
    const smartRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "smart mode",
        trusted: true,
        config: f.config,
        permissionMode: "smart",
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        onSavePermissionRule: () => {
          assert.fail("Must NOT save permanent rule after smart DENY override")
        },
        confirmAction: async (req) => {
          escalatedReqs.push({
            ...(req.allowAlways !== undefined ? { allowAlways: req.allowAlways } : {}),
            ...(req.smartDenied !== undefined ? { smartDenied: req.smartDenied } : {}),
            ...(req.reason ? { reason: req.reason } : {}),
          })
          // Try returning "always" after DENY; runtime must refuse persistence & treat as one-shot/reject
          return req.smartDenied ? "always" : "once"
        },
        completeImpl: async (req) => {
          const isGuardian =
            req.messages[0]?.role === "system" &&
            req.messages[0].content.includes("<action_request>")
          if (isGuardian) {
            guardianQueries += 1
            const payload = req.messages[1]!.content as string
            assert.ok(payload.includes("<action_request>"))
            if (payload.includes("--version"))
              return {
                text: "APPROVE: harmless version check",
                finishReason: "stop",
                toolCalls: [],
                toolInputErrors: [],
              }
            return {
              text: "DENY: risky action",
              finishReason: "stop",
              toolCalls: [],
              toolInputErrors: [],
            }
          }
          smartCall += 1
          if (smartCall === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "s1",
                  name: "run_command",
                  input: { command: process.execPath, args: ["--version"] },
                },
                {
                  id: "s2",
                  name: "run_command",
                  input: { command: process.execPath, args: ["remote-1.js"] },
                },
                {
                  id: "s3",
                  name: "run_command",
                  input: { command: process.execPath, args: ["remote-2.js"] },
                },
                {
                  id: "s4",
                  name: "run_command",
                  input: { command: process.execPath, args: ["remote-3.js"] },
                },
                {
                  id: "s5",
                  name: "run_command",
                  input: { command: process.execPath, args: ["remote-4.js"] },
                },
              ],
              toolInputErrors: [],
            }
          }
          return {
            text: "smart finished",
            finishReason: "stop",
            toolCalls: [],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(smartRes.outcome, "completed")
    assert.equal(guardianQueries, 4) // s1 approve + s2,s3,s4 deny -> s5 breaker skips guardian LLM!
    assert.equal(escalatedReqs.length, 4)
    assert.equal(escalatedReqs[0]!.allowAlways, false)
    assert.equal(escalatedReqs[0]!.smartDenied, true)
    assert.match(escalatedReqs[3]!.reason ?? "", /breaker|consecutive denials|paused/i)

    // 4) auto mode: hard-blocked command (rm -rf /) NEVER auto-runs, nor skips prompt; untrusted workspace STILL denies in auto mode
    let autoPrompts: Array<{ allowAlways?: boolean; cmd?: string }> = []
    let autoStep = 0
    const autoRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "auto danger check",
        trusted: true,
        config: f.config,
        permissionMode: "auto",
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async (req) => {
          autoPrompts.push({
            ...(req.allowAlways !== undefined ? { allowAlways: req.allowAlways } : {}),
            ...(req.kind === "run_command"
              ? { cmd: [req.prepared.command, ...req.prepared.args].join(" ") }
              : {}),
          })
          return false
        },
        completeImpl: async () => {
          autoStep += 1
          if (autoStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "a1", name: "run_command", input: { command: "git", args: ["status"] } },
                {
                  id: "a2",
                  name: "run_command",
                  input: { command: process.execPath, args: ["-e", "process.exit(0)"] },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "checked", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(autoRes.outcome, "completed")
    assert.equal(autoPrompts.length, 1)
    assert.equal(autoPrompts[0]!.cmd, `${process.execPath} -e process.exit(0)`)
    assert.equal(autoPrompts[0]!.allowAlways, false)

    // Untrusted workspace MUST deny edit_file and run_command even in auto mode!
    const untrustedDir = mkdtempSync(path.join(tmpdir(), "bw-untrusted-auto-"))
    try {
      writeFileSync(path.join(untrustedDir, "u.txt"), "hi\n", "utf8")
      let uStep = 0
      const uRes = await runTask(
        {
          workspace: untrustedDir,
          prompt: "edit",
          trusted: false,
          config: f.config,
          permissionMode: "auto",
        },
        {
          paths: f.paths,
          env: { ...process.env, TEST_PROVIDER_KEY: "k" },
          confirmAction: async () => {
            assert.fail("Untrusted workspace must deny before confirmAction")
          },
          completeImpl: async () => {
            uStep += 1
            if (uStep === 1) {
              return {
                text: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "u1",
                    name: "edit_file",
                    input: { path: "u.txt", oldText: "hi", newText: "x" },
                  },
                ],
                toolInputErrors: [],
              }
            }
            return { text: "denied", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
          },
        },
      )
      assert.equal(uRes.changedFiles.length, 0)
      assert.equal(uRes.actions?.[0]?.decision, "deny")
    } finally {
      rmSync(untrustedDir, { recursive: true, force: true })
    }

    // 5) ask mode strictly denies edits & commands even when workspace IS trusted & rules exist
    let askStep = 0
    const askRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "ask only",
        trusted: true,
        config: f.config,
        permissionMode: "ask",
        savedRules: [{ tool: "edit_file", pattern: "*", grantedAt: "" }],
      },
      {
        paths: f.paths,
        env: { ...process.env, TEST_PROVIDER_KEY: "k" },
        confirmAction: async () => {
          assert.fail("ask mode must never reach confirmAction")
        },
        requestWorkspaceTrust: async () => {
          assert.fail("ask mode must never requestWorkspaceTrust")
        },
        completeImpl: async () => {
          askStep += 1
          if (askStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "ak1",
                  name: "edit_file",
                  input: { path: "a.txt", oldText: "yo", newText: "no" },
                },
                { id: "ak2", name: "run_command", input: { command: "ls", args: [] } },
              ],
              toolInputErrors: [],
            }
          }
          return {
            text: "read-only answer",
            finishReason: "stop",
            toolCalls: [],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(askRes.outcome, "completed")
    assert.equal(
      askRes.actions?.every((a) => a.decision === "deny" && a.approvalSource === "ask"),
      true,
    )

    // 6) interactive trust unlock + accept-edits promotion
    const untrustedUnlockDir = mkdtempSync(path.join(tmpdir(), "bw-unlock-edits-"))
    try {
      writeFileSync(path.join(untrustedUnlockDir, "n.txt"), "v1\n", "utf8")
      const changedModes: string[] = []
      let uStep = 0
      const unlockRes = await runTask(
        {
          workspace: untrustedUnlockDir,
          prompt: "write",
          trusted: false,
          config: f.config,
          permissionMode: "manual",
        },
        {
          paths: f.paths,
          env: { ...process.env, TEST_PROVIDER_KEY: "k" },
          onPermissionModeChange: (m) => changedModes.push(m),
          requestWorkspaceTrust: async () => "accept-edits",
          confirmAction: async () => {
            assert.fail("Second edit after switching to accept-edits should auto-apply cleanly")
          },
          completeImpl: async () => {
            uStep += 1
            if (uStep === 1) {
              return {
                text: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "ul1",
                    name: "edit_file",
                    input: { path: "n.txt", oldText: "v1", newText: "v2" },
                  },
                  {
                    id: "ul2",
                    name: "edit_file",
                    input: { path: "n.txt", oldText: "v2", newText: "v3" },
                  },
                ],
                toolInputErrors: [],
              }
            }
            return { text: "done", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
          },
        },
      )
      assert.equal(unlockRes.outcome, "completed")
      assert.deepEqual(changedModes, ["accept-edits"])
      assert.equal(readFileSync(path.join(untrustedUnlockDir, "n.txt"), "utf8"), "v3\n")
    } finally {
      rmSync(untrustedUnlockDir, { recursive: true, force: true })
    }
  } finally {
    f.cleanup()
  }
})
