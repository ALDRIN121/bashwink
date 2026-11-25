import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

test("Milestone A: fresh process with dummy OPENAI_API_KEY must require Bashwink setup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bw-standalone-repro-"))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  mkdirSync(home)
  mkdirSync(project)
  try {
    const entry = path.resolve("packages/bw-cli/src/standalone/bin.ts")
    const result = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      cwd: project,
      env: {
        HOME: home,
        USERPROFILE: home,
        PATH: process.env["PATH"] ?? "",
        OPENAI_API_KEY: "sk-dummy-1234567890abcdef12345678",
      },
      encoding: "utf8",
      timeout: 10000,
    })
    assert.equal(
      result.status,
      0,
      `Expected clean first-run non-TTY setup message, got status ${result.status}: ${result.stderr}`,
    )
    assert.match(result.stdout + result.stderr, /setup|endpoint|model/i)
    assert.doesNotMatch(result.stdout + result.stderr, /OpenAI|GPT-/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
