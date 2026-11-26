import assert from "node:assert/strict"
import { createServer } from "node:http"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
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
import {
  buildProofPack,
  matchesCriterionCommand,
  verifyProofPack,
} from "../../src/standalone/proof.ts"
import {
  complete,
  probeModels,
  ProviderRequestError,
  safeWireToolArguments,
  testProviderConnection,
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
  listWorkspaceFiles,
  loadPromptHistory,
  loadSession,
  restoreTurnCheckpoints,
  rewindSessionToTurn,
  saveSession,
  withFileLock,
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

  const fakeHome = path.resolve(tmpdir(), "bw-fakehome-test")
  const expanded = expandHomeCredentialPath("~/.keys/test.key", {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  })
  assert.equal(expanded, path.join(fakeHome, ".keys", "test.key"))

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

test("Issues #89, #90, #91: same-size Git mutation detection, strict ProofPack command matching & before-receipt binding", async () => {
  const f = tempFixture()
  try {
    const runGit = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: f.workspace, encoding: "utf8" })
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
    }
    runGit(["init"])
    runGit(["config", "user.email", "test@bashwink.local"])
    runGit(["config", "user.name", "Test User"])
    writeFileSync(path.join(f.workspace, "app.txt"), "init\n", "utf8")
    runGit(["add", "app.txt"])
    runGit(["commit", "-m", "init"])
    // Make app.txt dirty before task starts, and create an untracked file of known byte length.
    writeFileSync(path.join(f.workspace, "app.txt"), "aaaa\n", "utf8")
    writeFileSync(path.join(f.workspace, "scratch.txt"), "1111\n", "utf8")

    let step = 0
    const mutRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "modify dirty tracked and untracked files with identical byte sizes",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 5 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          step += 1
          if (step === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "m1",
                  name: "run_command",
                  input: {
                    command: process.execPath,
                    args: [
                      "-e",
                      "const fs = require('fs'); fs.writeFileSync('app.txt', 'bbbb\\n'); fs.writeFileSync('scratch.txt', '2222\\n'); console.log('tests 0');",
                    ],
                  },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "done", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(mutRes.outcome, "completed")
    assert.equal(mutRes.changedFiles.includes("app.txt"), true)
    assert.equal(mutRes.changedFiles.includes("scratch.txt"), true)
    assert.equal(mutRes.commands[0]?.zeroTestsDetected, true)

    // #90: Subdirectory cwd and positional test filters must not match `npm test` / `node --test`
    const subDir = path.join(f.workspace, "empty-sub")
    mkdirSync(subDir, { recursive: true })
    assert.equal(
      matchesCriterionCommand(
        "npm test",
        {
          command: "npm",
          args: ["test", "--", "only.test.js"],
          cwd: f.workspace,
          decision: "approved",
          exitCode: 0,
          signal: null,
          timedOut: false,
          actionOrder: 1,
        },
        f.workspace,
      ),
      false,
    )
    assert.equal(
      matchesCriterionCommand(
        "node --test",
        {
          command: "node",
          args: ["--test"],
          cwd: subDir,
          decision: "approved",
          exitCode: 0,
          signal: null,
          timedOut: false,
          actionOrder: 1,
        },
        f.workspace,
      ),
      false,
    )

    // #90 zeroTestsDetected + #91 before-receipt cross-verification
    const evidenceFile = path.join(f.paths.evidence, "evidence.jsonl")
    const baseline = captureWorkspaceBaseline(f.workspace)
    const contract = createStandaloneContract(f.paths.data, f.workspace, {
      objective: "pass tests",
      allowedPaths: ["app.txt"],
      criteria: [{ id: "t1", statement: "tests pass", command: "npm test" }],
    })
    const recorder = createStandaloneRecorder(f.paths.evidence, "run-91")
    const fakeRef = { id: "spoof-1", tool: "run_command", sessionID: "run-91" }
    recorder.recordTool("before", fakeRef, {
      input: { command: "node", args: ["--version"], resolvedCwd: f.workspace },
    })
    const spoofAfter = recorder.recordTool("after", fakeRef, {
      status: "completed",
      exit: 0,
      output: "v22.13.0",
    })

    const spoofPack = buildProofPack({
      runId: "run-91",
      outcome: "completed",
      finalText: "done",
      workspace: f.workspace,
      baseline,
      changedFiles: [],
      changedTests: [],
      lastMutationOrder: 0,
      commands: [
        {
          command: "npm",
          args: ["test"],
          cwd: f.workspace,
          decision: "approved",
          exitCode: 0,
          signal: null,
          timedOut: false,
          actionOrder: 1,
          evidenceSeq: spoofAfter.seq,
          evidenceHash: spoofAfter.hash,
        },
      ],
      testIntegrity: [],
      contract,
      evidenceFile,
    })
    assert.equal(verifyProofPack(spoofPack).ok, false)

    const okRef = { id: "real-1", tool: "run_command", sessionID: "run-91" }
    recorder.recordTool("before", okRef, {
      input: { command: "npm", args: ["test"], resolvedCwd: f.workspace },
    })
    const zeroAfter = recorder.recordTool("after", okRef, {
      status: "completed",
      exit: 0,
      output: "0 tests",
    })
    const zeroPack = buildProofPack({
      runId: "run-91",
      outcome: "completed",
      finalText: "done",
      workspace: f.workspace,
      baseline,
      changedFiles: [],
      changedTests: [],
      lastMutationOrder: 0,
      commands: [
        {
          command: "npm",
          args: ["test"],
          cwd: f.workspace,
          decision: "approved",
          exitCode: 0,
          signal: null,
          timedOut: false,
          actionOrder: 1,
          zeroTestsDetected: true,
          evidenceSeq: zeroAfter.seq,
          evidenceHash: zeroAfter.hash,
        },
      ],
      testIntegrity: [],
      contract,
      evidenceFile,
    })
    assert.notEqual(zeroPack.claimStatus, "verified")
    assert.notEqual(zeroPack.criteria[0]?.status, "passed")
  } finally {
    f.cleanup()
  }
})

test("Issues #92, #93, #105, #106, #107: budget bounds, incomplete SSE/finishReason fail-closed, no-op loop, guardian invalidation & Retry-After", async () => {
  const f = tempFixture()
  try {
    writeFileSync(path.join(f.workspace, "target.txt"), "before\n", "utf8")

    // #92a: pre-request maxInputTokens check aborts before step 1
    let req1Called = 0
    const preInRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "oversized input relative to cap",
        trusted: true,
        config: f.config,
        budgets: { maxInputTokens: 20 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          req1Called += 1
          return { text: "ok", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(preInRes.outcome, "budget_stopped")
    assert.equal(req1Called, 0)

    // #92b: final reply exceeding maxCostUsd must return budget_stopped, NOT completed
    const overCostFinal = await runTask(
      {
        workspace: f.workspace,
        prompt: "hi",
        trusted: true,
        config: { ...f.config, price: { inputUsdPer1M: 1000, outputUsdPer1M: 1000 } },
        budgets: { maxCostUsd: 0.5 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => ({
          text: "expensive final answer",
          finishReason: "stop",
          toolCalls: [],
          toolInputErrors: [],
          usage: { inputTokens: 400, outputTokens: 200, costUsd: 0.6 },
        }),
      },
    )
    assert.equal(overCostFinal.outcome, "budget_stopped")

    // #93a: finishReason="unknown" with tool call must fail closed before writing file
    const unknownRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "try write with unknown finishReason",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 2 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => ({
          text: "",
          finishReason: "unknown",
          toolCalls: [
            {
              id: "u1",
              name: "edit_file",
              input: { path: "target.txt", old_string: "before", new_string: "corrupt" },
            },
          ],
          toolInputErrors: [],
        }),
      },
    )
    assert.equal(unknownRes.outcome, "failed")
    assert.match(unknownRes.stopReason ?? "", /non-terminal|unknown/i)
    assert.equal(readFileSync(path.join(f.workspace, "target.txt"), "utf8"), "before\n")

    // #93b: truncated OpenAI SSE stream without [DONE] or finish_reason & streamed error fail
    const sseServer = createServer((req, res) => {
      if (req.url?.includes("/truncated-openai")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        res.end()
        return
      }
      if (req.url?.includes("/error-openai")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"error":{"message":"stream crashed"}}\n\n')
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }
      if (req.url?.includes("/truncated-anthropic")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        )
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve))
    try {
      const addr = sseServer.address() as { port: number }
      await assert.rejects(
        () =>
          complete({
            config: {
              ...f.config,
              endpointType: "local",
              baseURL: `http://127.0.0.1:${addr.port}/truncated-openai`,
            },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: true,
            env: f.env,
          }),
        /prematurely|terminal completion|incomplete/i,
      )
      await assert.rejects(
        () =>
          complete({
            config: {
              ...f.config,
              endpointType: "local",
              baseURL: `http://127.0.0.1:${addr.port}/error-openai`,
            },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: true,
            env: f.env,
          }),
        /stream crashed/i,
      )
      await assert.rejects(
        () =>
          complete({
            config: {
              ...f.config,
              endpointType: "local",
              wireProtocol: "anthropic-messages",
              baseURL: `http://127.0.0.1:${addr.port}/truncated-anthropic`,
            },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: true,
            env: f.env,
          }),
        /prematurely|terminal completion|incomplete|message_stop/i,
      )
    } finally {
      await new Promise<void>((resolve) => sseServer.close(() => resolve()))
    }

    // #105: identical exit-0 command repeated without mutation trips noProgressStreak
    let noopStep = 0
    const noopRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "repeat identical exit-0 check",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 10 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          noopStep += 1
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `noop-${noopStep}`,
                name: "run_command",
                input: { command: process.execPath, args: ["-e", "process.exit(0)"] },
              },
            ],
            toolInputErrors: [],
          }
        },
      },
    )
    assert.equal(noopRes.outcome, "budget_stopped")
    assert.match(noopRes.stopReason ?? "", /without workspace mutation|no[- ]progress/i)

    // #106: Guardian cache is invalidated when workspace mutates
    writeFileSync(
      path.join(f.workspace, "mutator.js"),
      "require('fs').writeFileSync('g.txt', 'mut\\n');\n",
      "utf8",
    )
    let guardCalls = 0
    let gStep = 0
    const gRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "run identical mutating script twice",
        trusted: true,
        config: f.config,
        permissionMode: "smart",
        budgets: { maxRequests: 6 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async (req) => {
          if (
            req.messages.some(
              (m) =>
                m.role === "system" &&
                typeof m.content === "string" &&
                m.content.includes("runtime security reviewer"),
            )
          ) {
            guardCalls += 1
            return { text: "APPROVE", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
          }
          gStep += 1
          if (gStep <= 2) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `g-${gStep}`,
                  name: "run_command",
                  input: {
                    command: process.execPath,
                    args: ["mutator.js"],
                  },
                },
              ],
              toolInputErrors: [],
            }
          }
          return { text: "done", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(gRes.outcome, "completed")
    assert.equal(guardCalls, 2)

    // #107: retryAfterMs=0 retries immediately; retryAfterMs beyond maxElapsedMs stops cleanly instead of shortening
    let retryZeroStep = 0
    const retryZeroRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "retry 0s",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 3, maxElapsedMs: 5000 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          retryZeroStep += 1
          if (retryZeroStep === 1) {
            throw new ProviderRequestError("rate_limit", "429 retry now", {
              status: 429,
              retryable: true,
              retryAfterMs: 0,
            })
          }
          return { text: "recovered", finishReason: "stop", toolCalls: [], toolInputErrors: [] }
        },
      },
    )
    assert.equal(retryZeroRes.outcome, "completed")

    let retryTooLongCalls = 0
    const retryTooLongRes = await runTask(
      {
        workspace: f.workspace,
        prompt: "retry 120s",
        trusted: true,
        config: f.config,
        budgets: { maxRequests: 3, maxElapsedMs: 250 },
      },
      {
        paths: f.paths,
        env: f.env,
        confirmAction: async () => "once",
        completeImpl: async () => {
          retryTooLongCalls += 1
          throw new ProviderRequestError("rate_limit", "429 slow down", {
            status: 429,
            retryable: true,
            retryAfterMs: 120_000,
          })
        },
      },
    )
    assert.equal(retryTooLongRes.outcome, "budget_stopped")
    assert.equal(retryTooLongCalls, 1)
  } finally {
    f.cleanup()
  }
})

test("Issues #95, #96, #97, #98, #103: fail-closed locks, transactional rewind conflicts, binary secret omission, fork history & schema validation", () => {
  const f = tempFixture()
  try {
    // #95: Live-PID lock aged past stale threshold is NOT stolen; throws timeout and never runs unlocked
    const lockPath = path.join(f.root, "test.lock")
    writeFileSync(lockPath, `${process.pid}:other-holder\n${Date.now() - 60_000}\n`, "utf8")
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)
    let ranUnlocked = false
    assert.throws(
      () =>
        withFileLock(
          lockPath,
          () => {
            ranUnlocked = true
          },
          80,
        ),
      /Timed out/i,
    )
    assert.equal(ranUnlocked, false)

    // Dead PID lock is reclaimed cleanly
    writeFileSync(lockPath, `9999999:dead-holder\n${Date.now()}\n`, "utf8")
    let ranAfterReclaim = false
    withFileLock(
      lockPath,
      () => {
        ranAfterReclaim = true
      },
      500,
    )
    assert.equal(ranAfterReclaim, true)

    // #96: Multi-file rewind leaves ALL files untouched when any file has an external conflict or deletion
    const boundary = createBoundaryContext(f.workspace, f.paths, f.config, f.env)
    const aPath = path.join(f.workspace, "a.txt")
    const bPath = path.join(f.workspace, "b.txt")
    writeFileSync(aPath, "orig-a\n", "utf8")
    writeFileSync(bPath, "orig-b\n", "utf8")
    const cpA = captureFileCheckpoint(f.workspace, "a.txt", aPath)
    const cpB = captureFileCheckpoint(f.workspace, "b.txt", bPath)
    assert.ok(cpA && cpB)
    writeFileSync(aPath, "turn1-a\n", "utf8")
    writeFileSync(bPath, "turn1-b\n", "utf8")
    const finalized = finalizeTurnCheckpoints(boundary, [cpA, cpB])

    let turnToRevertSes = createSession(f.workspace)
    turnToRevertSes = appendTurnToSession(turnToRevertSes, {
      userPrompt: "edit a and b",
      result: {
        runId: "r-96",
        outcome: "completed",
        finalText: "ok",
        changedFiles: ["a.txt", "b.txt"],
        changedTests: [],
        commands: [],
        messages: [
          { role: "user", content: "edit a and b" },
          { role: "assistant", content: "ok" },
        ],
        requests: 1,
        guardianRequests: 0,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        evidenceFile: "ev",
        runRecordFile: "rr",
      },
      model: "m",
      checkpoints: finalized,
    })

    // Mutate b.txt externally -> conflict on b.txt must leave BOTH a.txt and b.txt untouched!
    writeFileSync(bPath, "external-b\n", "utf8")
    const r1 = restoreTurnCheckpoints(boundary, turnToRevertSes.turns)
    assert.equal(r1.skipped.length, 1)
    assert.equal(r1.restored.length, 0)
    assert.equal(readFileSync(aPath, "utf8"), "turn1-a\n")
    assert.equal(readFileSync(bPath, "utf8"), "external-b\n")

    // External deletion of b.txt -> conflict deleted_externally_since_turn leaves a.txt untouched too!
    rmSync(bPath)
    const r2 = restoreTurnCheckpoints(boundary, turnToRevertSes.turns)
    assert.equal(r2.skipped.length, 1)
    assert.match(r2.skipped[0]!.reason, /deleted_externally_since_turn/)
    assert.equal(existsSync(bPath), false)
    assert.equal(readFileSync(aPath, "utf8"), "turn1-a\n")

    // #97: NUL binary / UTF-16 file containing synthetic credential must be omitted without raw base64 secret leak
    const synAntKey = ["sk-", "ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz123456"].join("")
    const secretBinPath = path.join(f.workspace, "secret-utf16.bin")
    writeFileSync(
      secretBinPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(synAntKey, "utf16le")]),
    )
    const secretCp = captureFileCheckpoint(f.workspace, "secret-utf16.bin", secretBinPath)
    assert.ok(secretCp)
    assert.ok(secretCp.omittedReason)
    assert.equal(secretCp.contentBase64, undefined)

    // #98: Full forkSession preserves historyArchive so rewinding forked session recovers older turns
    let s = createSession(f.workspace)
    for (let i = 1; i <= 4; i += 1) {
      s = appendTurnToSession(s, {
        userPrompt: `turn ${i}`,
        result: {
          runId: `r-${i}`,
          outcome: "completed",
          finalText: `reply ${i}`,
          changedFiles: [],
          changedTests: [],
          commands: [],
          messages: [
            { role: "user", content: `turn ${i}` },
            { role: "assistant", content: `reply ${i}` },
          ],
          requests: 1,
          guardianRequests: 0,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          evidenceFile: "ev",
          runRecordFile: "rr",
        },
        model: "m",
        checkpoints: [],
      })
    }
    const compacted = compactSessionMessages(s, 2)
    assert.ok((compacted.updated.historyArchive?.messages.length ?? 0) > 0)
    const fullFork = forkSession(compacted.updated)
    assert.deepEqual(fullFork.historyArchive, compacted.updated.historyArchive)
    const rewoundFork = rewindSessionToTurn(fullFork, 1)
    assert.ok(
      rewoundFork.updated.messages.some((m) => m.role === "assistant" && m.content === "reply 1"),
    )

    // #103: Reject turns missing nested usage / changedFiles array
    const badSess = createSession(f.workspace)
    const badJson = {
      ...badSess,
      turns: [
        {
          id: "t1",
          timestamp: badSess.createdAt,
          userPrompt: "hi",
          assistantText: "ok",
          outcome: "completed",
          requests: 1,
          changedFiles: [123],
        },
      ],
    }
    mkdirSync(path.join(f.paths.data, "sessions"), { recursive: true })
    writeFileSync(
      path.join(f.paths.data, "sessions", `${badSess.id}.json`),
      JSON.stringify(badJson),
      "utf8",
    )
    assert.equal(loadSession(f.paths.data, badSess.id), undefined)
  } finally {
    f.cleanup()
  }
})

test("Issues #99, #100, #101, #104: streaming UTF-8 boundaries, provider tool probe, single probeModels deadline, and full .gitignore negation/nested support", async () => {
  const f = tempFixture()
  try {
    const boundary = createBoundaryContext(f.workspace, f.paths, f.config, f.env)
    // #99: Multi-byte UTF-8 across 16 KiB boundary and exact EOF newline behavior
    const boundaryText = `${"a".repeat(16382)}€😀\nend\n`
    writeFileSync(path.join(f.workspace, "utf8-boundary.txt"), boundaryText, "utf8")
    const utf8Res = executeReadFile(boundary, {
      path: "utf8-boundary.txt",
      startLine: 1,
      endLine: 2,
    })
    assert.equal(utf8Res.ok, true)
    assert.equal((utf8Res.output as string).includes("\uFFFD"), false)
    assert.equal((utf8Res.output as string).includes("€😀"), true)

    writeFileSync(path.join(f.workspace, "two-lines.txt"), "one\ntwo\n", "utf8")
    const exactRes = executeReadFile(boundary, {
      path: "two-lines.txt",
      startLine: 1,
      endLine: 2,
    })
    assert.equal(exactRes.ok, true)
    assert.equal((exactRes.output as string).includes("startLine: 3"), false)
    const pastEofRes = executeReadFile(boundary, {
      path: "two-lines.txt",
      startLine: 3,
      endLine: 5,
    })
    assert.equal(pastEofRes.ok, false)

    // #104: Nested .gitignore, !negation, anchored rules, and tracked overrides
    const runGit = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: f.workspace, encoding: "utf8" })
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
    }
    runGit(["init"])
    runGit(["config", "user.email", "test@bashwink.local"])
    runGit(["config", "user.name", "Test User"])
    writeFileSync(path.join(f.workspace, ".gitignore"), "*.log\n!keep.log\n/rootonly.dat\n", "utf8")
    writeFileSync(path.join(f.workspace, "tracked.log"), "tracked\n", "utf8")
    runGit(["add", "-f", ".gitignore", "tracked.log"])
    runGit(["commit", "-m", "gitignore-base"])
    writeFileSync(path.join(f.workspace, "drop.log"), "drop\n", "utf8")
    writeFileSync(path.join(f.workspace, "keep.log"), "keep\n", "utf8")
    writeFileSync(path.join(f.workspace, "rootonly.dat"), "ignored\n", "utf8")
    mkdirSync(path.join(f.workspace, "sub"), { recursive: true })
    writeFileSync(path.join(f.workspace, "sub/.gitignore"), "*.tmp\n!important.tmp\n", "utf8")
    writeFileSync(path.join(f.workspace, "sub/rootonly.dat"), "kept\n", "utf8")
    writeFileSync(path.join(f.workspace, "sub/skip.tmp"), "skip\n", "utf8")
    writeFileSync(path.join(f.workspace, "sub/important.tmp"), "keep\n", "utf8")

    const listed = listWorkspaceFiles(f.workspace)
    assert.equal(listed.includes("tracked.log"), true)
    assert.equal(listed.includes("keep.log"), true)
    assert.equal(listed.includes("drop.log"), false)
    assert.equal(listed.includes("rootonly.dat"), false)
    assert.equal(listed.includes("sub/rootonly.dat"), true)
    assert.equal(listed.includes("sub/important.tmp"), true)
    assert.equal(listed.includes("sub/skip.tmp"), false)

    const toolList = executeListFiles(boundary, {})
    assert.equal(toolList.ok, true)
    const listedLines = (toolList.output as string).split("\n")
    assert.equal(listedLines.includes("keep.log"), true)
    assert.equal(listedLines.includes("drop.log"), false)
    assert.equal(listedLines.includes("sub/important.tmp"), true)
    assert.equal(listedLines.includes("sub/skip.tmp"), false)

    // #100 & #101: toolSupport distinction (text-only vs unsupported vs supported) and single probeModels deadline
    const srv = createServer((req, res) => {
      if (req.url === "/slow/models" || req.url === "/slow/v1/models") {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end('{"data":[{"id":"m1"}]}')
          }
        }, 300)
        return
      }
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end('{"data":[{"id":"test-model"}]}')
        return
      }
      let body = ""
      req.on("data", (c) => (body += String(c)))
      req.on("end", () => {
        const parsed = body ? (JSON.parse(body) as { tools?: unknown[] }) : {}
        if (req.url?.startsWith("/textonly/") && parsed.tools && parsed.tools.length > 0) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: "cannot call" } },
              ],
            }),
          )
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
          }),
        )
      })
    })
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
    try {
      const addr = srv.address() as { port: number }
      const textOnlyRes = await testProviderConnection({
        config: {
          ...f.config,
          endpointType: "local",
          baseURL: `http://127.0.0.1:${addr.port}/textonly/v1`,
        },
        env: f.env,
      })
      assert.equal(textOnlyRes.ok, true)
      assert.equal(textOnlyRes.toolSupport, "accepted_text_only")

      const t0 = Date.now()
      const slowProbe = await probeModels({
        baseURL: `http://127.0.0.1:${addr.port}/slow`,
        credential: { kind: "none" },
        timeoutMs: 160,
      })
      const elapsed = Date.now() - t0
      assert.equal(slowProbe.ok, false)
      assert.ok(elapsed < 450, `Expected single deadline across fallbacks, got ${elapsed}ms`)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  } finally {
    f.cleanup()
  }
})
