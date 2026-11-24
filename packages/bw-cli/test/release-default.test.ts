import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

let directory: string
let entry: string
let marker: string

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "bw-release-default-"))
  entry = path.join(directory, "bashwink.js")
  marker = path.join(directory, "runtime-started")
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      path.join(import.meta.dir, "../src/bin.ts"),
      "--target=bun",
      "--define",
      "__BASHWINK_RELEASE__=true",
      "--outfile",
      entry,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(build.exitCode).toBe(0)
  const runtime = path.join(directory, "runtime")
  writeFileSync(runtime, `#!/bin/sh\necho started > "$BW_TEST_MARKER"\n`, { mode: 0o700 })
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

function run(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, entry, ...args],
    env: {
      PATH: process.env.PATH!,
      HOME: directory,
      BASHWINK_HOME: path.join(directory, "state"),
      BASHWINK_OPENCODE_BIN: path.join(directory, "runtime"),
      BW_TEST_MARKER: marker,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
    cwd: directory,
  })
}

test("release entry refuses missing VM and never dispatches to a host runtime", () => {
  for (const args of [[], ["run", "test"], ["--continue"]]) {
    const result = run(args, { BASHWINK_BACKEND: "local" })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString()).toContain("VM")
    expect(existsSync(marker)).toBe(false)
  }
})

test("release unrestricted mode requires interactive acknowledgment", () => {
  const result = run(["--unsafe-local"])
  expect(result.exitCode).toBe(3)
  expect(result.stderr.toString()).toContain("acknowledgment")
  expect(existsSync(marker)).toBe(false)
})
