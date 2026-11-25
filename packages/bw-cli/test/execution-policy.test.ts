import { expect, test } from "bun:test"
import { posixTest } from "./platform.js"
import { Database } from "bun:sqlite"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { standaloneArguments } from "../src/execution-policy.js"

const cli = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

test("TUI prompt and session options preserve the attested working directory", () => {
  for (const args of [
    ["--prompt", "hello"],
    ["-s", "ses_fixture"],
    ["--session", "ses_fixture"],
  ])
    expect(standaloneArguments(args)).toEqual(["--standalone", ...args])
  expect(() => standaloneArguments(["--prompt", "hello", ".."])).toThrow("intended workspace")
  expect(() => standaloneArguments(["--", ".."])).toThrow("intended workspace")
})

test("interactive model options preserve workspace and private-server admission", () => {
  for (const args of [
    ["--model", "fixture/model"],
    ["-m", "fixture/model"],
  ])
    expect(standaloneArguments(args)).toEqual(["--standalone", ...args])
  expect(() => standaloneArguments(["--model", "fixture/model", ".."])).toThrow(
    "intended workspace",
  )
  expect(() => standaloneArguments(["-m", "fixture/model", "serve"])).toThrow("service command")
  expect(() => standaloneArguments(["--model", "--", ".."])).toThrow("missing value")
})

async function withRuntime(
  check: (
    run: (
      args: string[],
      env?: Record<string, string>,
    ) => Promise<Bun.SyncSubprocess<"pipe", "pipe">>,
    root: string,
  ) => Promise<void>,
) {
  const root = mkdtempSync(path.join(tmpdir(), "bw-launch-policy-"))
  const runtime = path.join(root, "runtime")
  writeFileSync(runtime, "#!/bin/sh\nprintf '%s\\n' \"$@\" > received\ntouch ran\n", {
    mode: 0o700,
  })
  try {
    await check(
      async (args, env) =>
        Bun.spawnSync([process.execPath, cli, ...args], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            BASHWINK_HOME: path.join(root, "state"),
            BASHWINK_OPENCODE_BIN: runtime,
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      root,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

posixTest("a failed private server gets no prompt arguments or client launch", async () => {
  await withRuntime(async (run, root) => {
    const result = await run(["run", "hello"])
    expect(result.exitCode).toBe(3)
    expect(readFileSync(path.join(root, "received"), "utf8").trim().split("\n")).toEqual([
      "serve",
      "--stdio",
      "--port",
      "0",
    ])
  })
})

test("refuses external and persistent dispatch before launching the binary", async () => {
  await withRuntime(async (run, root) => {
    for (const args of [
      ["run", "--server=http://127.0.0.1:1", "hello"],
      ["--standalone", "serve"],
      ["--no-standalone", "run", "hello"],
      ["run", "--worktree=other", "hello"],
      ["run", "-w", "hello"],
    ]) {
      const result = await run(args)
      expect(result.exitCode).toBe(2)
      expect(existsSync(path.join(root, "ran"))).toBe(false)
    }
  })
})

test("refuses an untrusted evidence-off run before dispatch", async () => {
  await withRuntime(async (run, root) => {
    const result = await run(["run", "hello"], { BASHWINK_EVIDENCE: "off" })
    expect(result.exitCode).toBe(3)
    expect(existsSync(path.join(root, "ran"))).toBe(false)
  })
})

test("a malformed trust file prevents launch", async () => {
  await withRuntime(async (run, root) => {
    mkdirSync(path.join(root, "state"))
    writeFileSync(path.join(root, "state", "trust.json"), "not json")
    const result = await run(["run", "hello"])
    expect(result.exitCode).toBe(3)
    expect(existsSync(path.join(root, "ran"))).toBe(false)
  })
})

test("unavailable backend is rejected before the runtime can start", async () => {
  await withRuntime(async (run, root) => {
    const result = await run(["run", "hello"], { BASHWINK_BACKEND: "docker" })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("execution backend 'docker' is unavailable")
    expect(existsSync(path.join(root, "ran"))).toBe(false)
  })
})

test("runtime completion records the backend and its lifecycle outcome", async () => {
  await withRuntime(async (run) => {
    const result = await run(["run", "hello"], { BASHWINK_BACKEND: "local" })
    expect(result.exitCode).toBe(3)
    const status = await run(["evidence", "status", "--json"])
    expect(JSON.parse(status.stdout.toString())).toEqual([
      expect.objectContaining({
        evidence: "missing",
        execution: expect.objectContaining({
          backend: expect.objectContaining({ mode: "local", processIsolation: false }),
          outcome: "readiness-failed",
          exitCode: 3,
        }),
      }),
    ])
  })
})

test("a path-restricted approved contract does not grant the general shell", async () => {
  await withRuntime(async (run, root) => {
    for (const args of [
      ["trust", ".", "--by", "fixture"],
      ["plan", "new", "fixture work"],
      ["contract", "new", "--allow", "src"],
      ["contract", "approve", "--by", "fixture"],
    ]) {
      const result = await run(args)
      expect(result.exitCode).toBe(0)
    }
    await run(["run", "--auto", "hello"])
    const scopes = path.join(root, "state", "data", "scopes")
    const files = readdirSync(scopes)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(path.join(scopes, files[0]!), "utf8"))).toMatchObject({
      origin: "contract",
      allowShell: false,
    })
  })
})

test("evidence-off is refused even in a trusted workspace", async () => {
  await withRuntime(async (run, root) => {
    expect((await run(["trust", ".", "--by", "fixture"])).exitCode).toBe(0)
    await run(["run", "hello"])
    const plugin = path.join(root, "state", "plugin", "bashwink-evidence")
    expect(existsSync(plugin)).toBe(true)
    expect((await run(["run", "hello"], { BASHWINK_EVIDENCE: "off" })).exitCode).toBe(3)
    expect(existsSync(plugin)).toBe(true)
  })
})

test("persisted automation blocks OpenCode startup without changing the database", async () => {
  await withRuntime(async (run, root) => {
    const data = path.join(root, "state", "opencode")
    mkdirSync(data, { recursive: true })
    const db = new Database(path.join(data, "opencode.db"))
    try {
      db.exec(
        "CREATE TABLE automation(id TEXT PRIMARY KEY); INSERT INTO automation VALUES ('fixture')",
      )
      const result = await run(["run", "hello"])
      expect(result.exitCode).toBe(3)
      expect(result.stderr.toString()).toContain("database contains saved automations")
      expect(existsSync(path.join(root, "ran"))).toBe(false)
      expect(db.query("SELECT id FROM automation").get()).toEqual({ id: "fixture" })
    } finally {
      db.close()
    }
  })
})

test("untrusted project TUI plugin directories block the local client", async () => {
  await withRuntime(async (run, root) => {
    mkdirSync(path.join(root, ".opencode", "plugins"), { recursive: true })
    const result = await run(["--standalone"])
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString()).toContain(
      "could not admit untrusted project TUI configuration",
    )
    expect(existsSync(path.join(root, "ran"))).toBe(false)
  })
})
