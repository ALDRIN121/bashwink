import assert from "node:assert/strict"
import { createServer } from "node:http"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { paths } from "../../src/paths.ts"
import { captureWorkspaceBaseline } from "../../src/standalone/baseline.ts"
import {
  classifyEndpoint,
  expandHomeCredentialPath,
  normalizeBaseURL,
  parseStandaloneConfig,
} from "../../src/standalone/config.ts"
import {
  ContractStoreError,
  createStandaloneContract,
  evaluateContractGate,
  loadActiveContract,
} from "../../src/standalone/contract-store.ts"
import { buildProofPack, verifyProofPack } from "../../src/standalone/proof.ts"
import {
  complete,
  ProviderRequestError,
  safeWireToolArguments,
} from "../../src/standalone/provider.ts"
import {
  createBoundaryContext,
  createStandaloneRecorder,
  grantWorkspaceTrust,
  matchesPermissionRule,
  purgeExpiredArtifacts,
} from "../../src/standalone/security.ts"
import {
  appendPromptHistory,
  appendTurnToSession,
  captureFileCheckpoint,
  compactSessionMessages,
  createSession,
  finalizeTurnCheckpoints,
  forkSession,
  listSessionSummaries,
  loadPromptHistory,
  loadSession,
  restoreTurnCheckpoints,
  rewindSessionToTurn,
  saveSession,
} from "../../src/standalone/session.ts"
import { runTask } from "../../src/standalone/task-loop.ts"
import { inspectTestEdit } from "../../src/standalone/test-guard.ts"
import {
  executeListFiles,
  executeReadFile,
  prepareEditFile,
  prepareRunCommand,
} from "../../src/standalone/tools.ts"
import {
  colorsEnabled,
  createKeyParserState,
  feedKeyParser,
  flushStuckPaste,
  MAX_BRACKETED_PASTE_BYTES,
} from "../../src/standalone/tui-theme.ts"
import type { StandaloneConfig, TaskEvent } from "../../src/standalone/types.ts"

function tempFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bw-audit-reg-"))
  const home = path.join(root, "home")
  const workspace = path.join(root, "ws")
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BASHWINK_HOME: home,
    HOME: home,
    USERPROFILE: home,
  }
  const resolved = paths(env)
  grantWorkspaceTrust(resolved.config, workspace, "tester")
  const config: StandaloneConfig = {
    version: 1,
    endpointType: "hosted",
    baseURL: "https://api.example.test/v1",
    model: "test-model",
    credential: { kind: "env", variable: "TEST_API_KEY" },
    connectionStatus: "verified",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  }
  return {
    root,
    home,
    workspace,
    env: { ...env, TEST_API_KEY: "tok-test-999999999999999999" },
    paths: resolved,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("Audit #7: key parser escapes stuck bracketed paste on Ctrl+C and caps oversized paste", () => {
  const state = createKeyParserState()
  const stuckEvents = feedKeyParser(state, "\x1b[200~hello world\x03after")
  assert.equal(
    stuckEvents.some((e) => e.kind === "ctrl" && e.key === "c"),
    true,
  )
  assert.equal(state.inPaste, false)

  const big = createKeyParserState()
  feedKeyParser(big, `\x1b[200~${"x".repeat(MAX_BRACKETED_PASTE_BYTES + 2048)}`)
  assert.equal(big.inPaste, true)
  assert.equal(big.pasteBuffer.length, MAX_BRACKETED_PASTE_BYTES)
  assert.equal(big.pasteTruncated, true)
  const flushed = flushStuckPaste(big)
  assert.equal(flushed.length, 1)
  assert.equal(big.inPaste, false)
})

test("Audit #10-#14: URL query preservation, local loopback HTTPS, home key expansion, SSE streaming, safeWireToolArguments", async () => {
  assert.equal(
    normalizeBaseURL(
      "https://my-resource.openai.azure.com/openai/deployments/gpt4?api-version=2025-01-01",
      "hosted",
    ),
    "https://my-resource.openai.azure.com/openai/deployments/gpt4?api-version=2025-01-01",
  )
  assert.throws(() => normalizeBaseURL("https://example.test/v1#frag", "hosted"), /fragment/i)
  assert.equal(classifyEndpoint("https://127.0.0.1:8443/v1"), "loopback")
  assert.equal(classifyEndpoint("https://api.openai.com/v1"), "remote")
  assert.throws(() => normalizeBaseURL("https://192.168.1.5:8443/v1", "local"), /loopback/i)

  const expanded = expandHomeCredentialPath("~/.keys/test.key", { HOME: "/tmp/fakehome" })
  assert.equal(expanded, path.join("/tmp/fakehome", ".keys/test.key"))

  const parsed = parseStandaloneConfig(
    JSON.stringify({
      version: 1,
      endpointType: "hosted",
      baseURL: "https://api.example.test/v1?v=1",
      model: "test-model",
      credential: { kind: "none" },
      connectionStatus: "verified",
      lastVerifiedAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
    }),
  )
  assert.equal(parsed.connectionStatus, "verified")
  assert.equal(
    safeWireToolArguments({ id: "c1", name: "read_file", input: {}, rawArguments: '{"bad' }),
    "{}",
  )

  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n')
    res.write(
      'data: {"choices":[{"delta":{"content":"there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
    )
    res.write("data: [DONE]\n\n")
    res.end()
  })
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
  const addr = srv.address() as { port: number }
  try {
    const res = await complete({
      config: {
        version: 1,
        endpointType: "local",
        baseURL: `http://127.0.0.1:${addr.port}/v1`,
        model: "sse-model",
        credential: { kind: "none" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
      messages: [{ role: "user", content: "say hi" }],
      tools: [],
      stream: true,
    })
    assert.equal(res.text, "Hi there")
    assert.equal(res.finishReason, "stop")
    assert.equal(res.usage?.totalTokens, 15)
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

test("Audit #18-#26, #43, #44, #46: ProofPack linkage & stale order, TestGuard extensions, ContractStoreError, requireCleanBase fail-closed", () => {
  const f = tempFixture()
  try {
    assert.equal(
      inspectTestEdit("test/a.test.ts", "assert.equal(x, 2)", 'test.skip("skip", () => {})').some(
        (x) => x.kind === "skipped_test",
      ),
      true,
    )
    assert.equal(
      inspectTestEdit(
        "package.json",
        '"test": "node --test"',
        '"test": "node --test || true"',
      ).some((x) => x.kind === "script_weakened"),
      true,
    )
    assert.equal(
      inspectTestEdit("test/b.test.ts", "assert.equal(sum(1, 2), 3)", "assert.ok(true)").some(
        (x) => x.kind === "weakened_assertion",
      ),
      true,
    )

    // Corrupted revision / index fails closed with ContractStoreError
    const createdBad = createStandaloneContract(f.paths.data, f.workspace, {
      objective: "test",
      allowedPaths: ["src/**"],
      criteria: [{ id: "k0", statement: "ok" }],
    })
    writeFileSync(
      path.join(f.paths.data, "contracts", `${createdBad.id}.r1.json`),
      "{corrupted-json",
    )
    assert.throws(() => loadActiveContract(f.paths.data, f.workspace), ContractStoreError)
    writeFileSync(path.join(f.paths.data, "contracts", "active.json"), "{bad-index-json")
    assert.throws(() => loadActiveContract(f.paths.data, f.workspace), ContractStoreError)

    const f2 = tempFixture()
    try {
      const nonGitBaseline = captureWorkspaceBaseline(f2.workspace)
      const contract = createStandaloneContract(f2.paths.data, f2.workspace, {
        objective: "fix sum",
        allowedPaths: ["src/**"],
        criteria: [{ id: "k1", statement: "tests pass", command: "npm test" }],
        constraints: { requireCleanBase: true },
      })
      const gate = evaluateContractGate(contract, true, f2.workspace, nonGitBaseline)
      assert.equal(gate.ok, false)

      const recorder = createStandaloneRecorder(f2.paths.evidence, "run-proof")
      const ref = { id: "cmd1", tool: "run_command", sessionID: "run-proof" }
      recorder.recordTool("before", ref, { input: { command: "npm", args: ["test"] } })
      const afterEntry = recorder.recordTool("after", ref, {
        status: "completed",
        exit: 0,
        output: "ok",
      })
      const evidenceFile = path.join(f2.paths.evidence, "evidence.jsonl")
      const packStale = buildProofPack({
        runId: "run-proof",
        outcome: "completed",
        finalText: "done",
        workspace: f2.workspace,
        baseline: nonGitBaseline,
        changedFiles: ["src/a.ts"],
        changedTests: [],
        lastMutationOrder: 2,
        commands: [
          {
            command: "npm",
            args: ["test"],
            cwd: f2.workspace,
            decision: "approved",
            exitCode: 0,
            signal: null,
            timedOut: false,
            actionOrder: 1,
            evidenceSeq: afterEntry.seq,
            evidenceHash: afterEntry.hash,
          },
        ],
        testIntegrity: [],
        contract,
        evidenceFile,
      })
      assert.equal(packStale.claimStatus, "done_unverified")
      assert.equal(verifyProofPack(packStale).ok, true)
      assert.equal(verifyProofPack({ ...packStale, claimStatus: "verified" }).ok, false)

      const packFiltered = buildProofPack({
        runId: "run-proof",
        outcome: "completed",
        finalText: "done",
        workspace: f2.workspace,
        baseline: nonGitBaseline,
        changedFiles: [],
        changedTests: [],
        lastMutationOrder: 0,
        commands: [
          {
            command: "npm",
            args: ["test", "--", "--test-name-pattern=onlyone"],
            cwd: f2.workspace,
            decision: "approved",
            exitCode: 0,
            signal: null,
            timedOut: false,
            actionOrder: 3,
            evidenceSeq: afterEntry.seq,
            evidenceHash: afterEntry.hash,
          },
        ],
        testIntegrity: [],
        contract,
        evidenceFile,
      })
      assert.equal(packFiltered.claimStatus, "done_unverified")
    } finally {
      f2.cleanup()
    }
  } finally {
    f.cleanup()
  }
})

test("Audit #22, #38, #41, #42, #76-#82: BFS listing, bounded read_file, edit no-op/CRLF/line cap, relative command & Windows shim guards", () => {
  const f = tempFixture()
  try {
    writeFileSync(path.join(f.workspace, ".gitignore"), "*.log\nsecret-dir/\n", "utf8")
    mkdirSync(path.join(f.workspace, "a", "nested"), { recursive: true })
    mkdirSync(path.join(f.workspace, "secret-dir"), { recursive: true })
    writeFileSync(path.join(f.workspace, "root.ts"), "1\n", "utf8")
    writeFileSync(path.join(f.workspace, "ignore.log"), "noise\n", "utf8")
    writeFileSync(path.join(f.workspace, "secret-dir", "hidden.ts"), "nope\n", "utf8")
    writeFileSync(path.join(f.workspace, "a", "nested", "deep.ts"), "2\n", "utf8")

    const boundary = createBoundaryContext(f.workspace, f.paths, f.config, f.env)
    const listed = executeListFiles(boundary, { maxEntries: 50 })
    assert.equal(listed.ok, true)
    assert.equal(listed.output.includes("root.ts"), true)
    assert.equal(listed.output.includes("ignore.log"), false)
    assert.equal(listed.output.includes("secret-dir/hidden.ts"), false)

    const noop = prepareEditFile(boundary, { path: "root.ts", oldText: "1\n", newText: "1\n" })
    assert.equal(noop.ok, false)
    const missingCreate = prepareEditFile(boundary, {
      path: "new.ts",
      oldText: "",
      newText: "hi\n",
    })
    assert.equal(missingCreate.ok, false)

    writeFileSync(path.join(f.workspace, "mixed.txt"), "line1\r\nline2\nline3\n", "utf8")
    const mixedEdit = prepareEditFile(boundary, {
      path: "mixed.txt",
      oldText: "line1",
      newText: "LINE1",
    })
    assert.equal(mixedEdit.ok, true)
    if (mixedEdit.ok) {
      assert.equal(mixedEdit.prepared.updatedRawText, "LINE1\r\nline2\nline3\n")
    }

    const badRange = executeReadFile(boundary, { path: "mixed.txt", startLine: 5, endLine: 2 })
    assert.equal(badRange.ok, false)

    const longLines = Array.from({ length: 450 }, (_, i) => `row-${i + 1}`).join("\n")
    writeFileSync(path.join(f.workspace, "big.txt"), longLines, "utf8")
    const cappedRead = executeReadFile(boundary, { path: "big.txt", startLine: 1, endLine: 450 })
    assert.equal(cappedRead.ok, true)
    assert.match(cappedRead.output, /startLine: 401/)

    const batchBad = prepareRunCommand(boundary, { command: "tool.cmd", args: ["ok&calc"] }, f.env)
    assert.equal(batchBad.ok, false)
    assert.equal(
      matchesPermissionRule(
        [{ tool: "run_command", pattern: "git status *", grantedAt: "2026-01-01T00:00:00.000Z" }],
        "run_command",
        "git.exe status -s",
      ),
      true,
    )
  } finally {
    f.cleanup()
  }
})

test("Audit #29-#37, #49, #84, #86: Session schema check, checkpoint sensitive omit & mode preserve, compaction archive rewind, fork requests & TTL prompt history purge", () => {
  const f = tempFixture()
  try {
    mkdirSync(path.join(f.paths.data, "sessions"), { recursive: true })
    writeFileSync(
      path.join(f.paths.data, "sessions", "corrupt.json"),
      '{"version":1,"id":"corrupt","workspace":"/tmp"}',
    )
    assert.equal(loadSession(f.paths.data, "corrupt"), undefined)

    const envFile = path.join(f.workspace, ".env")
    const fakeEnvSecret = "sk-" + "testsecretvalue1234567890123"
    writeFileSync(envFile, `API_KEY=${fakeEnvSecret}\n`, "utf8")
    const sensitiveCp = captureFileCheckpoint(f.workspace, ".env", envFile, fakeEnvSecret)
    assert.equal(sensitiveCp?.omittedReason, "sensitive_content_omitted")
    assert.equal(sensitiveCp?.contentBase64, undefined)

    const shFile = path.join(f.workspace, "run.sh")
    writeFileSync(shFile, "#!/bin/sh\necho v1\n", "utf8")
    if (process.platform !== "win32") chmodSync(shFile, 0o755)
    const boundary = createBoundaryContext(f.workspace, f.paths, f.config, f.env)
    const cpSh = captureFileCheckpoint(f.workspace, "run.sh", shFile)
    assert.ok(cpSh)
    writeFileSync(shFile, "#!/bin/sh\necho v2\n", "utf8")
    const finalizedCps = finalizeTurnCheckpoints(boundary, [cpSh])

    let ses = createSession(f.workspace, "main")
    for (let i = 1; i <= 3; i += 1) {
      ses = appendTurnToSession(ses, {
        userPrompt: `turn ${i}`,
        result: {
          runId: `r-${i}`,
          outcome: "completed",
          finalText: `answer ${i}`,
          changedFiles: i === 1 ? ["run.sh"] : [],
          changedTests: [],
          commands: [],
          messages: [
            { role: "user", content: `turn ${i}` },
            { role: "assistant", content: `answer ${i}` },
          ],
          requests: 2,
          guardianRequests: 1,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          evidenceFile: "ev",
          runRecordFile: "rr",
        },
        model: "m",
        checkpoints: i === 1 ? finalizedCps : [],
      })
    }
    const compacted = compactSessionMessages(ses, 1)
    assert.equal(compacted.summarizedTurns, 2)
    const rw = rewindSessionToTurn(compacted.updated, 0)
    assert.equal(rw.updated.turns.length, 0)
    assert.equal(rw.updated.messages.length, 0)

    const forked = forkSession(compacted.updated, 2)
    assert.equal(forked.usageTotals.requests, 4)
    assert.equal(forked.usageTotals.guardianRequests, 2)
    assert.equal(forked.messages.length, 4)
    saveSession(f.paths.data, compacted.updated)
    assert.equal(listSessionSummaries(f.paths.data, { workspace: f.workspace }).length, 1)

    writeFileSync(shFile, "#!/bin/sh\necho external-edit\n", "utf8")
    const externalConflict = restoreTurnCheckpoints(boundary, rw.revertedTurns)
    assert.equal(
      externalConflict.skipped.some((s) => s.reason === "modified_externally_since_turn"),
      true,
    )

    const fakeHistSecret = "sk-" + "mysecretkeyvalue1234567890"
    const hist = appendPromptHistory(f.paths.data, `use ${fakeHistSecret}`, fakeHistSecret)
    assert.equal(hist[0]!.includes(fakeHistSecret), false)
    const futureMs = Date.now() + 10 * 86_400_000
    const purged = purgeExpiredArtifacts(f.paths.data, 1, futureMs, { includePromptHistory: true })
    assert.equal(purged.clearedPromptHistory, true)
    assert.deepEqual(loadPromptHistory(f.paths.data), [])
  } finally {
    f.cleanup()
  }
})

test("Audit #25, #47, #60-#69, #71, #74: retries, post-response budget stop, content_filter fail, shell mutation tracking, alternating loop breaker", async () => {
  const f = tempFixture()
  try {
    const cfRes = await runTask(
      { workspace: f.workspace, prompt: "say unsafe", trusted: true, config: f.config },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => ({
          text: "",
          finishReason: "content_filter",
          toolCalls: [],
          toolInputErrors: [],
        }),
      },
    )
    assert.equal(cfRes.outcome, "failed")
    assert.match(cfRes.stopReason ?? "", /content_filter/i)

    let tries = 0
    const retryEvents: TaskEvent[] = []
    const retryRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "hello",
        trusted: true,
        config: f.config,
        budgets: { maxTransientRetries: 1 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        onEvent: (e) => retryEvents.push(e),
        completeImpl: async () => {
          tries += 1
          if (tries === 1) {
            throw new ProviderRequestError("rate_limit", "rate limited", {
              retryable: true,
              retryAfterMs: 10,
            })
          }
          return { text: "recovered", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(retryRes.outcome, "completed")
    assert.equal(
      retryEvents.some((e) => e.type === "model_retrying"),
      true,
    )

    let toolDispatched = false
    const totalStop = await runTask(
      {
        workspace: f.workspace,
        prompt: "check",
        trusted: true,
        config: f.config,
        budgets: { maxTotalTokens: 100 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => ({
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "r1", name: "list_files", input: {} }],
          toolInputErrors: [],
          usage: { inputTokens: 80, outputTokens: 25, totalTokens: 105 },
        }),
        onEvent: (ev) => {
          if (ev.type === "tool_completed") toolDispatched = true
        },
      },
    )
    assert.equal(totalStop.outcome, "budget_stopped")
    assert.equal(toolDispatched, false)

    let shellStep = 0
    const mutRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "touch file via node",
        trusted: true,
        config: f.config,
        permissionMode: "manual",
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          shellStep += 1
          if (shellStep === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "m1",
                  name: "run_command",
                  input: {
                    command: process.execPath,
                    args: ["-e", "require('fs').writeFileSync('created-by-cmd.txt', 'ok')"],
                  },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "created", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(mutRes.outcome, "completed")
    assert.equal(mutRes.changedFiles.includes("created-by-cmd.txt"), true)
    assert.ok((mutRes.commands[0]?.actionOrder ?? 0) >= 1)

    writeFileSync(path.join(f.workspace, "a.txt"), "A\n", "utf8")
    writeFileSync(path.join(f.workspace, "b.txt"), "B\n", "utf8")
    let cycleStep = 0
    const cycleRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "read forever",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 10 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          cycleStep += 1
          const target = cycleStep % 2 === 1 ? "a.txt" : "b.txt"
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: `cy-${cycleStep}`, name: "read_file", input: { path: target } }],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(cycleRes.outcome, "budget_stopped")
    assert.match(cycleRes.stopReason ?? "", /alternating|repeated/i)
  } finally {
    f.cleanup()
  }
})

test("Audit #57: colorsEnabled respects NO_COLOR and TERM=dumb deterministically", () => {
  assert.equal(colorsEnabled({ NO_COLOR: "1", TERM: "xterm-256color" }, true), false)
  assert.equal(colorsEnabled({ TERM: "dumb" }, true), false)
  assert.equal(colorsEnabled({ TERM: "xterm-256color" }, true), true)

  const root = mkdtempSync(path.join(tmpdir(), "bw-nocolor-"))
  try {
    const res = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.resolve("packages/bw-cli/src/standalone/bin.ts"),
        "doctor",
      ],
      {
        cwd: root,
        env: { ...process.env, BASHWINK_HOME: root, NO_COLOR: "1", TERM: "dumb" },
        encoding: "utf8",
      },
    )
    assert.equal((res.stdout + res.stderr).includes("\x1b[48;5;"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Audit #40: standalone CLI refuses --sandbox with exit 3 rather than silently running unsandboxed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bw-sandbox-refuse-"))
  try {
    const res = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.resolve("packages/bw-cli/src/standalone/bin.ts"),
        "--sandbox",
      ],
      {
        cwd: root,
        env: { ...process.env, BASHWINK_HOME: root },
        encoding: "utf8",
      },
    )
    assert.equal(res.status, 3)
    assert.match(res.stderr, /not included|refusing/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
