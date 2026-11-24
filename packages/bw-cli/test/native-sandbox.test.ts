import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

test("the sandbox probe rejects extra arguments and never executes a project launcher", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "bw-native-"))
  try {
    const sentinel = path.join(cwd, "state")
    const result = Bun.spawnSync([process.execPath, cli, "sandbox", "probe", "extra"], {
      cwd,
      env: {
        ...process.env,
        BASHWINK_HOME: sentinel,
        BASHWINK_OPENCODE_BIN: path.join(cwd, "missing-runtime"),
      },
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("usage: bashwink sandbox probe")
    expect(readdirSync(cwd)).toEqual([])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("a required native coding run still refuses unavailable admission", () => {
  const result = Bun.spawnSync([process.execPath, cli, "run", "local test prompt"], {
    env: { ...process.env, BASHWINK_BACKEND: "native" },
  })
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain("native coding sessions are not qualified")
  expect(result.stdout.toString()).toBe("")
})

test("offline coding requires a valid fixture port before runtime resolution", () => {
  const result = Bun.spawnSync(
    [process.execPath, cli, "sandbox", "offline", "https://example.invalid"],
    {
      env: { ...process.env, BASHWINK_OPENCODE_BIN: "/missing" },
    },
  )
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain("usage: bashwink sandbox offline <mock-port>")
})

test("offline continuation requires an existing stage before attempting runtime launch", () => {
  const result = Bun.spawnSync([
    process.execPath,
    cli,
    "sandbox",
    "offline",
    "12345",
    "--stage",
    "/private/tmp/bashwink-offline-missing",
    "--continue",
  ])
  expect(result.exitCode).toBe(3)
  expect(result.stderr.toString()).toContain("offline stage is missing or unrecognized")
})

test("staged export requires a recognized stage before reading any destination", () => {
  const result = Bun.spawnSync([
    process.execPath,
    cli,
    "sandbox",
    "export",
    "/private/tmp/bashwink-offline-missing",
  ])
  expect(result.exitCode).toBe(3)
  expect(result.stderr.toString()).toContain("offline stage is missing or unrecognized")
})
