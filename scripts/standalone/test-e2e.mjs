#!/usr/bin/env node
/**
 * Real interactive PTY end-to-end tests against the installed `bashwink` CLI:
 *  1) Onboarding reproducer with dummy OPENAI_API_KEY + foreign CLI configs + decoy server
 *     (0 requests before task submission, cancel setup leaves no config, save local endpoint,
 *      1 request to chosen endpoint, 0 to decoy, survive terminal resize, /exit)
 *  2) Reload persistence + `bashwink setup` cancel preserves profile
 *  3) Real Git repo red-to-green coding task (read -> diff -> approved edit -> approved test run),
 *     independent test re-run, `bashwink evidence verify`
 *  4) Declined edit leaves file untouched, failing test/command reports actual non-zero exit code,
 *     and Ctrl+C cancels cleanly without orphaned child process.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildStandalone, runNpm } from "./build.mjs";

const EGRESS_PROBE_SOURCE = `
import { appendFileSync } from "node:fs";
import net from "node:net";

const logFile = process.env.BW_EGRESS_LOG;
const blockAll = process.env.BW_EGRESS_BLOCK_BEFORE_SUBMIT === "1";

function record(kind, target) {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ kind, target, at: Date.now() }) + "\\n", "utf8");
}

const origFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || String(input);
  record("fetch", url);
  if (blockAll) {
    throw new Error("EGRESS_BLOCKED fetch " + url);
  }
  return await origFetch.call(this, input, init);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let target = "unknown";
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const second = Array.isArray(args[0]) ? args[0][1] : args[1];
  if (typeof first === "object" && first !== null) {
    const o = first;
    target = o.path ? "unix:" + o.path : (o.host || "127.0.0.1") + ":" + String(o.port ?? "");
  } else if (typeof first === "number") {
    const host = typeof second === "string" ? second : "127.0.0.1";
    target = host + ":" + String(first);
  } else if (typeof first === "string") {
    target = "unix:" + first;
  }
  record("socket_connect", target);
  if (blockAll) {
    const err = new Error("EGRESS_BLOCKED connect " + target);
    queueMicrotask(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
`;

const PTY_DRIVER_PY = `
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

spec = json.load(sys.stdin)
argv = spec["argv"]
cwd = spec["cwd"]
env = spec["env"]
steps = spec.get("steps", [])

master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))

pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    os.close(master_fd)
    os.close(slave_fd)
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)

os.close(slave_fd)
buf = bytearray()
cursor = 0

def pump(timeout_sec):
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        r, _, _ = select.select([master_fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                return False
            if not chunk:
                return False
            buf.extend(chunk)
            return True
    return True

def wait_for(substr, timeout_sec=15.0):
    global cursor
    deadline = time.monotonic() + timeout_sec
    target = substr.encode("utf-8")
    while time.monotonic() < deadline:
        idx = buf.find(target, cursor)
        if idx != -1:
            cursor = idx + len(target)
            return True
        if not pump(0.1):
            break
    idx = buf.find(target, cursor)
    if idx != -1:
        cursor = idx + len(target)
        return True
    raise RuntimeError(f"Timed out waiting for {substr!r}. Transcript so far:\\n{buf.decode('utf-8', 'replace')}")

for step in steps:
    if "wait" in step:
        wait_for(step["wait"], step.get("timeout", 15.0))
    if "resize" in step:
        rows, cols = step["resize"]
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    if "delay" in step:
        time.sleep(step["delay"])
    if "send" in step:
        os.write(master_fd, step["send"].encode("utf-8"))

# Drain until child exits (up to 15s)
deadline = time.monotonic() + 15.0
exit_code = None
while time.monotonic() < deadline:
    pump(0.05)
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_code = 128 + os.WTERMSIG(status)
        break

while True:
    r, _, _ = select.select([master_fd], [], [], 0.05)
    if not r:
        break
    try:
        chunk = os.read(master_fd, 4096)
        if not chunk:
            break
        buf.extend(chunk)
    except OSError:
        break

if exit_code is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    exit_code = -1

os.close(master_fd)
sys.stdout.write(json.dumps({"exitCode": exit_code, "output": buf.decode("utf-8", "replace")}))
`;

async function runPtySession(argv, cwd, env, steps) {
  const pythonCandidates = ["/usr/bin/python3", "python3"];
  let pyBin = "python3";
  for (const c of pythonCandidates) {
    const chk = spawnSync(c, ["-c", "import pty, termios"], { encoding: "utf8" });
    if (chk.status === 0) {
      pyBin = c;
      break;
    }
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(pyBin, ["-c", PTY_DRIVER_PY], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => outChunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`PTY driver failed (status ${code}):\n${stderr}\n${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Invalid PTY driver JSON: ${err.message}\n${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify({ argv, cwd, env, steps }));
  });
}

function findGit() {
  for (const candidate of ["git", "/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  throw new Error("git is required for e2e coding repo fixture");
}

async function startMockServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(entry);
      handler(entry, res, requests);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function completionJson({ text = "", finishReason = "stop", toolCalls = [] }) {
  return JSON.stringify({
    choices: [
      {
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}

async function main() {
  const built = buildStandalone();
  if (process.platform === "win32") {
    const psScript = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "test-windows-terminal.ps1");
    const winRes = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript, "-Tarball", built.tarballPath],
      { stdio: "inherit" },
    );
    if (winRes.status !== 0) {
      throw new Error(`Windows native terminal E2E failed with exit ${winRes.status}`);
    }
    return;
  }

  const root = mkdtempSync(path.join(tmpdir(), "bw-e2e-"));
  const prefix = path.join(root, "npm-prefix");
  const home = path.join(root, "home");
  const plainDir = path.join(root, "plain-folder");
  const gitRepo = path.join(root, "git-repo");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(plainDir, { recursive: true });
  mkdirSync(gitRepo, { recursive: true });

  const decoy = await startMockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(completionJson({ text: "SHOULD NEVER REACH DECOY" }));
  });

  let scenario = "simple";
  let turn = 0;
  let cancelAbortTimer;
  const target = await startMockServer((req, res) => {
    turn += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (scenario === "simple") {
      res.end(completionJson({ text: "Hello from target local endpoint." }));
      return;
    }
    if (scenario === "fix") {
      if (turn === 1) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              { id: "r1", name: "read_file", input: { path: "sum.js" } },
              { id: "r2", name: "read_file", input: { path: "sum.test.js" } },
            ],
          }),
        );
        return;
      }
      if (turn === 2) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "e1",
                name: "edit_file",
                input: { path: "sum.js", oldText: "a - b", newText: "a + b" },
              },
            ],
          }),
        );
        return;
      }
      if (turn === 3) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "c1",
                name: "run_command",
                input: { command: process.execPath, args: ["--test", "sum.test.js"] },
              },
            ],
          }),
        );
        return;
      }
      const cmdMsg = req.body.messages.findLast((m) => m.role === "tool");
      assert.ok(cmdMsg && cmdMsg.content.includes("exitCode: 0"), `Expected exitCode 0, got: ${cmdMsg?.content}`);
      res.end(completionJson({ text: "Fixed sum.js and verified node --test sum.test.js passed." }));
      return;
    }
    if (scenario === "decline_edit") {
      if (turn === 1) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "ed1",
                name: "edit_file",
                input: { path: "sum.js", oldText: "a + b", newText: "a * b" },
              },
            ],
          }),
        );
        return;
      }
      res.end(completionJson({ text: "Edit was declined; sum.js left unchanged." }));
      return;
    }
    if (scenario === "fail_cmd") {
      if (turn === 1) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "fc1",
                name: "run_command",
                input: { command: process.execPath, args: ["-e", "console.log('intentional-fail'); process.exit(9)"] },
              },
            ],
          }),
        );
        return;
      }
      res.end(completionJson({ text: "Observed command failed with exit code 9." }));
      return;
    }
    if (scenario === "cancel_cmd") {
      if (turn === 1) {
        res.end(
          completionJson({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "cc1",
                name: "run_command",
                input: { command: process.execPath, args: ["-e", "console.log('RUNNING'); setInterval(() => {}, 1000)"] },
              },
            ],
          }),
        );
        return;
      }
      res.end(completionJson({ text: "Should not reach after cancel" }));
    }
    if (scenario === "slow_http") {
      // Never respond quickly so client aborts via Ctrl+C
      cancelAbortTimer = setTimeout(() => {
        if (!res.writableEnded) res.end(completionJson({ text: "late" }));
      }, 10000);
      res.on("close", () => clearTimeout(cancelAbortTimer));
    }
  });

  try {
    const binDir = path.join(prefix, "bin");
    const env = {
      PATH: [binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: home,
      TERM: "xterm-256color",
      TMPDIR: root,
      BASHWINK_HOME: path.join(home, ".bashwink"),
      // Ambient dummy secrets + decoy legacy CLI configs that must NEVER auto-select a provider
      OPENAI_API_KEY: "sk-dummy-1234567890abcdef12345678",
      ANTHROPIC_API_KEY: "sk-ant-dummy-1234567890abcdef",
      CMD_API_KEY: "cmd-dummy-key",
      npm_config_prefix: prefix,
    };

    // Seed foreign CLI configs
    mkdirSync(path.join(home, ".opencode"), { recursive: true });
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(path.join(home, ".hermes"), { recursive: true });
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    const foreignFiles = {
      [path.join(home, ".opencode", "config.json")]: '{"provider":"openai","model":"gpt-4o"}\n',
      [path.join(home, ".config", "opencode", "opencode.json")]: `{"provider":{"decoy":{"options":{"baseURL":"${decoy.url}"}}}}\n`,
      [path.join(home, ".hermes", "config.json")]: '{"provider":"openai"}\n',
      [path.join(home, ".pi", "agent", "settings.json")]: '{"defaultProvider":"openai"}\n',
    };
    for (const [f, body] of Object.entries(foreignFiles)) writeFileSync(f, body, "utf8");

    const inst = runNpm(["install", "-g", built.tarballPath, "--ignore-scripts"], { env });
    assert.equal(inst.status, 0, inst.stderr);
    const bashwinkBin = path.join(binDir, "bashwink");
    assert.ok(existsSync(bashwinkBin));

    // Write process-level network/socket egress probe (catches ANY host — not only our 2 mock servers)
    const probePath = path.join(root, "egress-probe.mjs");
    writeFileSync(probePath, EGRESS_PROBE_SOURCE, "utf8");
    const probeImportFlag = `--import=${pathToFileURL(probePath).href}`;
    const readEgressLog = (logFile) => {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };

    // Negative control: verify the egress probe catches an outbound request to an external host (e.g. api.openai.com)
    const negLog = path.join(root, "egress-neg.jsonl");
    const negCheck = spawnSync(
      process.execPath,
      [
        probeImportFlag,
        "-e",
        'fetch("https://api.openai.com/v1/chat/completions").catch(() => process.exit(42))',
      ],
      {
        env: { ...env, BW_EGRESS_LOG: negLog, BW_EGRESS_BLOCK_BEFORE_SUBMIT: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(negCheck.status, 42, "Negative control must fail at egress probe");
    const negEntries = readEgressLog(negLog);
    assert.ok(
      negEntries.some((e) => e.kind === "fetch" && String(e.target).includes("api.openai.com")),
      `Expected probe to catch external api.openai.com attempt, got ${JSON.stringify(negEntries)}`,
    );

    // --- 1. Onboarding reproducer in plain non-Git directory ---
    // Launches directly into CLI shell with first message prompting /model -> cancel setup leaves 0 files & 0 requests
    const cancelLog = path.join(root, "egress-cancel.jsonl");
    const cancelRes = await runPtySession(
      [bashwinkBin],
      plainDir,
      { ...env, NODE_OPTIONS: probeImportFlag, BW_EGRESS_LOG: cancelLog, BW_EGRESS_BLOCK_BEFORE_SUBMIT: "1" },
      [
        { wait: "Model    none configured" },
        { wait: "Type /model or /connect (or press Enter) to select a provider and model." },
        { wait: "bashwink (no model)> ", send: "/model\n" },
        { wait: "OpenAI" },
        { wait: "Ollama (local)" },
        { wait: "Select provider [1-10 or id] (or 'cancel'):", send: "cancel\n" },
        { wait: "bashwink (no model)> ", send: "/exit\n" },
      ],
    );
    assert.equal(cancelRes.exitCode, 0, cancelRes.output);
    assert.equal(decoy.requests.length, 0);
    assert.equal(target.requests.length, 0);
    assert.deepEqual(readEgressLog(cancelLog), [], "Cancelled setup must attempt 0 outbound connections");
    assert.equal(
      existsSync(path.join(env.BASHWINK_HOME, "standalone.json")),
      false,
      "Cancelled setup must leave zero partial profile",
    );

    // Configure via /model multi-provider menu -> save -> resize -> exit WITHOUT submitting task -> 0 requests to ANY host
    const preSubmitLog = path.join(root, "egress-pre-submit.jsonl");
    const preSubmitRes = await runPtySession(
      [bashwinkBin],
      plainDir,
      { ...env, NODE_OPTIONS: probeImportFlag, BW_EGRESS_LOG: preSubmitLog, BW_EGRESS_BLOCK_BEFORE_SUBMIT: "1" },
      [
        { wait: "bashwink (no model)> ", send: "\n" },
        { wait: "Select provider [1-10 or id] (or 'cancel'):", send: "10\n" },
        { wait: "Endpoint URL", send: `${target.url}\n` },
        { wait: "Model ID", send: "local-test-model\n" },
        { wait: "Choose [1/2/3] (or 'cancel'):", send: "3\n" },
        { wait: "Save and use this model? [y/N]", send: "y\n" },
        { resize: [24, 80], wait: "bashwink> ", delay: 0.05 },
        { send: "/exit\n" },
      ],
    );
    assert.equal(preSubmitRes.exitCode, 0, preSubmitRes.output);
    assert.deepEqual(readEgressLog(preSubmitLog), [], "Launch + setup + save must make 0 outbound connections to ANY host");

    // Relaunch with saved profile & submit 1 prompt -> verify ONLY 1 connection to selected target host
    scenario = "simple";
    turn = 0;
    const targetAddrHostPort = `127.0.0.1:${new URL(target.url).port}`;
    const submitLog = path.join(root, "egress-submit.jsonl");
    const onboardRes = await runPtySession(
      [bashwinkBin],
      plainDir,
      { ...env, NODE_OPTIONS: probeImportFlag, BW_EGRESS_LOG: submitLog },
      [
        { wait: `custom-local / local-test-model (${targetAddrHostPort}` },
        { wait: "bashwink> ", send: "Say hello\n" },
        { wait: "Trust this workspace for interactive edit/command approvals? [y/N]", send: "n\n" },
        { wait: "Hello from target local endpoint." },
        { wait: "bashwink> ", send: "/exit\n" },
      ],
    );
    assert.equal(onboardRes.exitCode, 0, onboardRes.output);
    assert.equal(decoy.requests.length, 0, "Must send 0 requests to decoy/OPENAI_API_KEY");
    assert.equal(target.requests.length, 1, "Must send exact 1 request for simple task");
    const submitEvents = readEgressLog(submitLog);
    const externalFetches = submitEvents.filter((e) => e.kind === "fetch" && !String(e.target).startsWith(target.url));
    const externalSockets = submitEvents.filter((e) => e.kind === "socket_connect" && e.target !== targetAddrHostPort);
    assert.deepEqual(externalFetches, [], `Unexpected fetch to non-selected URL: ${JSON.stringify(externalFetches)}`);
    assert.deepEqual(externalSockets, [], `Unexpected socket connect to non-selected host: ${JSON.stringify(externalSockets)}`);
    for (const [f, body] of Object.entries(foreignFiles)) {
      assert.equal(readFileSync(f, "utf8"), body, `Foreign config modified: ${f}`);
    }

    // --- 2. Relaunch shows saved config + `bashwink setup` cancel preserves it (with egress blocked) ---
    const persistLog = path.join(root, "egress-persist.jsonl");
    const persistRes = await runPtySession(
      [bashwinkBin],
      plainDir,
      { ...env, NODE_OPTIONS: probeImportFlag, BW_EGRESS_LOG: persistLog, BW_EGRESS_BLOCK_BEFORE_SUBMIT: "1" },
      [
        { wait: `custom-local / local-test-model (${targetAddrHostPort}` },
        { wait: "bashwink> ", send: "/exit\n" },
      ],
    );
    assert.equal(persistRes.exitCode, 0, persistRes.output);
    assert.deepEqual(readEgressLog(persistLog), [], "Relaunch must attempt 0 outbound connections");
    assert.equal(target.requests.length, 1, "Launch must make 0 outbound requests");

    const setupCancelLog = path.join(root, "egress-setup-cancel.jsonl");
    const setupCancelRes = await runPtySession(
      [bashwinkBin, "setup"],
      plainDir,
      { ...env, NODE_OPTIONS: probeImportFlag, BW_EGRESS_LOG: setupCancelLog, BW_EGRESS_BLOCK_BEFORE_SUBMIT: "1" },
      [{ wait: "Select provider [1-10 or id] (or 'cancel'):", send: "cancel\n" }],
    );
    assert.equal(setupCancelRes.exitCode, 0);
    assert.deepEqual(readEgressLog(setupCancelLog), [], "`bashwink setup` cancel must make 0 outbound connections");
    const saved = JSON.parse(readFileSync(path.join(env.BASHWINK_HOME, "standalone.json"), "utf8"));
    assert.equal(saved.model, "local-test-model");
    assert.equal(saved.baseURL, target.url);

    // --- 3. Real Git coding fixture: failing test -> read -> diff -> approved fix -> approved test -> independent check ---
    const git = findGit();
    writeFileSync(
      path.join(gitRepo, "sum.js"),
      "export function sum(a, b) {\n  return a - b;\n}\n",
      "utf8",
    );
    writeFileSync(
      path.join(gitRepo, "sum.test.js"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("adds", () => { assert.equal(sum(2, 3), 5); });\n',
      "utf8",
    );
    assert.equal(spawnSync(git, ["init"], { cwd: gitRepo }).status, 0);
    assert.equal(spawnSync(git, ["config", "user.email", "t@example.com"], { cwd: gitRepo }).status, 0);
    assert.equal(spawnSync(git, ["config", "user.name", "Tester"], { cwd: gitRepo }).status, 0);
    assert.equal(spawnSync(git, ["add", "."], { cwd: gitRepo }).status, 0);
    assert.equal(spawnSync(git, ["commit", "-m", "initial broken sum"], { cwd: gitRepo }).status, 0);

    // Confirm test genuinely fails BEFORE running Bashwink
    const preTest = spawnSync(process.execPath, ["--test", "sum.test.js"], { cwd: gitRepo, encoding: "utf8" });
    assert.notEqual(preTest.status, 0, "Expected failing test before Bashwink run");

    scenario = "fix";
    turn = 0;
    const fixRes = await runPtySession([bashwinkBin], gitRepo, env, [
      { wait: "bashwink> ", send: "fix the failing test\n" },
      { wait: "Trust this workspace for interactive edit/command approvals? [y/N]", send: "y\n" },
      { wait: "Apply this change? [y/N]", send: "y\n" },
      { wait: "not an OS sandbox" },
      { wait: "Run this command? [y/N]", send: "y\n" },
      { wait: "Outcome   completed" },
      { wait: "bashwink> ", send: "/exit\n" },
    ]);
    assert.equal(fixRes.exitCode, 0, fixRes.output);
    assert.match(fixRes.output, /Changed\s+sum\.js/);
    assert.match(fixRes.output, /exited 0/);

    // Independently re-run test outside Bashwink
    const postTest = spawnSync(process.execPath, ["--test", "sum.test.js"], { cwd: gitRepo, encoding: "utf8" });
    assert.equal(postTest.status, 0, `Independent test re-run failed:\n${postTest.stdout}\n${postTest.stderr}`);

    // Verify hash-chained evidence log via CLI
    const evVerify = spawnSync(bashwinkBin, ["evidence", "verify"], { cwd: gitRepo, env, encoding: "utf8" });
    assert.equal(evVerify.status, 0, evVerify.stderr);
    assert.match(evVerify.stdout, /Evidence OK:/);

    // --- 4. Declined edit, failing command, and Ctrl+C cancellation ---
    const fixedBody = readFileSync(path.join(gitRepo, "sum.js"), "utf8");
    scenario = "decline_edit";
    turn = 0;
    const declRes = await runPtySession([bashwinkBin], gitRepo, env, [
      { wait: "> ", send: "change sum\n" },
      { wait: "Apply this change? [y/N]", send: "n\n" },
      { wait: "Outcome   completed" },
      { wait: "> ", send: "/exit\n" },
    ]);
    assert.equal(declRes.exitCode, 0, declRes.output);
    assert.equal(readFileSync(path.join(gitRepo, "sum.js"), "utf8"), fixedBody, "Declined edit must not change file");
    assert.match(declRes.output, /Changed\s+none/);

    scenario = "fail_cmd";
    turn = 0;
    const failCmdRes = await runPtySession([bashwinkBin], gitRepo, env, [
      { wait: "> ", send: "run failing cmd\n" },
      { wait: "Run this command? [y/N]", send: "y\n" },
      { wait: "exited 9" },
      { wait: "> ", send: "/exit\n" },
    ]);
    assert.equal(failCmdRes.exitCode, 0, failCmdRes.output);
    assert.match(failCmdRes.output, /exited 9/);

    scenario = "cancel_cmd";
    turn = 0;
    const cancelTaskRes = await runPtySession([bashwinkBin], gitRepo, env, [
      { wait: "> ", send: "run slow command\n" },
      { wait: "Run this command? [y/N]", send: "y\n" },
      { delay: 0.25, send: "\x03" },
      { wait: "Outcome   cancelled" },
      { wait: "> ", send: "/exit\n" },
    ]);
    assert.equal(cancelTaskRes.exitCode, 0, cancelTaskRes.output);
    assert.match(cancelTaskRes.output, /Outcome\s+cancelled/);

    // Verify run records exist cleanly on disk and latest shows cancelled
    const runsDir = path.join(env.BASHWINK_HOME, "data", "runs");
    const runFiles = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
    assert.ok(runFiles.length >= 4);
    const records = runFiles.map((f) => JSON.parse(readFileSync(path.join(runsDir, f), "utf8")));
    assert.ok(records.some((r) => r.outcome === "cancelled"), "Expected a persisted cancelled run record");

    process.stdout.write(
      `PASS: real PTY E2E verified (0 requests with dummy keys, cancel safe, 1 request to selected local endpoint, Git red->green fix, decline, exit 9, Ctrl+C cancel).\n`,
    );
  } finally {
    await decoy.close();
    await target.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`test-e2e FAILED: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
