import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  parsePrivateEndpoint,
  matchesReadiness,
  startPrivateServer,
} from "../src/private-server.js"

test("only a bare HTTP address on the owned IPv4 loopback listener is accepted", () => {
  expect(parsePrivateEndpoint('{"url":"http://127.0.0.1:32123"}')).toBe("http://127.0.0.1:32123")
  for (const url of [
    "http://localhost:32123",
    "http://127.0.0.1:32123/admin",
    "http://user@127.0.0.1:32123",
    "https://127.0.0.1:32123",
    "http://127.0.0.1",
  ]) {
    expect(() => parsePrivateEndpoint(JSON.stringify({ url }))).toThrow()
  }
})

test("waits for a transient SQLite lock then refuses a migratable schedule before spawning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bw-readiness-lock-"))
  const data = path.join(root, "opencode")
  mkdirSync(data)
  const writer = new Database(path.join(data, "opencode.db"))
  try {
    writer.exec(
      "CREATE TABLE schedule(id TEXT); INSERT INTO schedule VALUES ('fixture'); BEGIN EXCLUSIVE;",
    )
    const launch = startPrivateServer(
      path.join(root, "unused"),
      { XDG_DATA_HOME: root },
      {
        runId: "run_fixture",
        workspace: root,
        scopesDirectory: root,
        pluginDirectory: root,
        logFile: path.join(root, "log"),
      },
      new AbortController().signal,
    )
    const outcome = launch.catch((error: unknown) => error)
    await Bun.sleep(125)
    writer.exec("COMMIT")
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("database contains saved automations or schedules"),
    })
    expect(readdirSync(root)).toEqual(["opencode"])
  } finally {
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("an acknowledgement is only valid for the exact launch, server pid and workspace", () => {
  const expected = { v: 1, runId: "run_new", nonce: "fresh", pid: 321, workspace: "/approved" }
  expect(matchesReadiness(expected, expected)).toBe(true)
  for (const wrong of [
    { ...expected, nonce: "old" },
    { ...expected, pid: 320 },
    { ...expected, workspace: "/other" },
    { ...expected, runId: "run_previous" },
    { ...expected, v: 0 },
    { runId: expected.runId },
    null,
  ])
    expect(matchesReadiness(wrong, expected)).toBe(false)
})

test("readiness distinguishes a malformed endpoint without exposing raw stdout", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bw-readiness-endpoint-"))
  const runtime = path.join(root, "fixture")
  writeFileSync(runtime, '#!/bin/sh\nprintf "raw endpoint must not be included\\n"\n', {
    mode: 0o700,
  })
  const signal = new AbortController().signal
  try {
    const server = await startPrivateServer(
      runtime,
      { XDG_DATA_HOME: root },
      {
        runId: "run_fixture",
        workspace: root,
        scopesDirectory: root,
        pluginDirectory: root,
        logFile: path.join(root, "log"),
      },
      signal,
    )
    try {
      const error = await server.ready(signal).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(
        "owned server advertised a malformed or non-loopback endpoint",
      )
      expect(String(error)).not.toContain("raw endpoint must not be included")
    } finally {
      await server.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
