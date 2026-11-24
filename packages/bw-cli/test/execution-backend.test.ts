import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type ExecutionBackend,
  localBackend,
  runWithBackend,
  selectBackend,
} from "../src/execution-backend.js"

const request = {
  command: process.execPath,
  args: ["-e", "process.exit(7)"],
  cwd: process.cwd(),
  env: {},
}

test("local reports direct host execution and propagates the runtime exit", async () => {
  expect(selectBackend("local").capabilities).toEqual(localBackend.capabilities)
  expect(localBackend.capabilities.filesystemIsolation).toBe(false)
  expect(localBackend.capabilities.networkIsolation).toBe(false)
  expect(localBackend.capabilities.processIsolation).toBe(false)
  expect(await runWithBackend(localBackend, request)).toMatchObject({
    exitCode: 7,
    outcome: "exited",
  })
})

test("an unavailable sandbox backend is refused without selecting local", () => {
  expect(() => selectBackend("docker")).toThrow(/docker.*unavailable/)
  expect(() => selectBackend("typo")).toThrow(/typo.*unavailable/)
})

test("startup validation rejects a missing executable", async () => {
  const result = await runWithBackend(localBackend, { ...request, command: request.cwd })
  expect(result).toMatchObject({ exitCode: 1, outcome: "startup-failed" })
  expect(result.detail).toContain("executable")
})

test("terminates and disposes a mock backend when the run is cancelled", async () => {
  const calls: string[] = []
  const abort = new AbortController()
  const completion = Promise.withResolvers<number>()
  const backend: ExecutionBackend = {
    capabilities: localBackend.capabilities,
    prepare() {
      calls.push("prepare")
      return {
        execute() {
          calls.push("execute")
          abort.abort()
          return completion.promise
        },
        cancel() {
          calls.push("cancel")
          completion.resolve(143)
        },
        sync() {
          calls.push("sync")
        },
        dispose() {
          calls.push("dispose")
        },
      }
    },
  }
  const result = await runWithBackend(backend, request, { signal: abort.signal })
  expect(result).toMatchObject({ outcome: "cancelled", exitCode: 130 })
  expect(calls).toEqual(["prepare", "execute", "cancel", "dispose"])
})

test("an expired deadline terminates and reaps a real managed child", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bw-process-"))
  const pidFile = path.join(directory, "pid")
  try {
    const result = await runWithBackend(
      localBackend,
      {
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 100)`,
        ],
        cwd: directory,
        env: {},
      },
      { timeoutMs: 700 },
    )
    expect(result).toMatchObject({ outcome: "timed-out", exitCode: 124 })
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("bounded cancellation reaps an owned process that handles and ignores TERM", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bw-process-term-"))
  try {
    const result = await runWithBackend(
      localBackend,
      {
        ...request,
        cwd: directory,
        args: [
          "-e",
          `
          const fs = require("node:fs");
          process.on("SIGTERM", () => fs.writeFileSync("term", "ignored"));
          fs.writeFileSync("pid", String(process.pid));
          setInterval(() => {}, 100);
        `,
        ],
      },
      { timeoutMs: 700 },
    )
    expect(result).toMatchObject({ outcome: "timed-out", exitCode: 124 })
    expect(readFileSync(path.join(directory, "term"), "utf8")).toBe("ignored")
    const pid = Number(readFileSync(path.join(directory, "pid"), "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
