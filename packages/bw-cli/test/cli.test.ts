/**
 * End-to-end CLI tests.
 *
 * These spawn the real entrypoint as a subprocess and assert on stdout, stderr and the exit
 * code. A unit test cannot prove that `--version` exits 0 or that the dispatcher forwards an
 * unknown argument, and those are exactly the acceptance criteria for BW-008.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CLI = path.join(import.meta.dir, "..", "src", "bin.ts")

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the CLI in a throwaway BASHWINK_HOME so no test touches the developer's real state. */
function cli(args: readonly string[], env: Record<string, string> = {}): Run {
  const home = mkdtempSync(path.join(tmpdir(), "bw-cli-"))
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, CLI, ...args],
      env: { ...process.env, BASHWINK_HOME: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(import.meta.dir, "..", "..", ".."),
    })
    return {
      code: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("BW-008 — executable, version and help", () => {
  test("--version exits 0 and names Bashwink, not OpenCode", () => {
    const run = cli(["--version"])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("bashwink ")
    // ADR-003: the product name is Bashwink's. Upstream appears only as attribution.
    expect(run.stdout.trim().split("\n")[0]).toMatch(/^bashwink \d+\.\d+\.\d+/)
  })

  test("-v is the same as --version", () => {
    expect(cli(["-v"]).stdout).toBe(cli(["--version"]).stdout)
  })

  test("--help exits 0 and documents the commands", () => {
    const run = cli(["--help"])
    expect(run.code).toBe(0)
    for (const command of ["doctor", "trust", "plan", "evidence", "resume", "--version"])
      expect(run.stdout).toContain(command)
  })

  test("-h is the same as --help", () => {
    // The help text embeds the resolved config path, and each run uses its own throwaway
    // BASHWINK_HOME, so the paths legitimately differ. Compare the text with those lines
    // removed rather than asserting byte equality across two different homes.
    const strip = (text: string) => text.replace(/^\s+(Config|Data):.*$/gm, "")
    expect(strip(cli(["-h"]).stdout)).toBe(strip(cli(["--help"]).stdout))
  })

  test("no arguments prints help rather than hanging or failing", () => {
    const run = cli([])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("USAGE")
  })

  test("help explains exit codes and environment overrides", () => {
    const run = cli(["--help"])
    expect(run.stdout).toContain("BASHWINK_HOME")
    expect(run.stdout).toContain("EXIT CODES")
    expect(run.stdout).toContain("127")
  })

  test("an unknown argument is forwarded to the runtime, not rejected", () => {
    // ADR-003: forward everything except the flags the wrapper owns, so a new upstream flag
    // works without a wrapper release. With no runtime installed this exits 127, which is the
    // documented "runtime not found" code — proving we tried to delegate.
    const run = cli(["--definitely-not-a-wrapper-flag"], { BASHWINK_OPENCODE_BIN: "" })
    expect(run.stderr).toContain("no OpenCode runtime found")
    expect(run.code).toBe(127)
  })
})

describe("BW-009 — doctor", () => {
  test("doctor runs and reports a missing runtime as a failure with a fix", () => {
    const run = cli(["doctor"], { BASHWINK_OPENCODE_BIN: "" })
    // The runtime genuinely is not installed in this repo, so this must be a failure.
    expect(run.code).toBe(1)
    expect(run.stdout).toContain("OpenCode runtime")
    expect(run.stdout).toContain("fix:")
    expect(run.stdout).toContain("failure")
  })

  test("doctor never prints a credential value", () => {
    // Planted sentinel: if any part of it appears in the output, doctor leaks.
    const secret = "sk-ant-SENTINELVALUE0123456789abcdef"
    const run = cli(["doctor"], { ANTHROPIC_API_KEY: secret })
    expect(run.stdout).not.toContain("SENTINELVALUE")
    expect(run.stdout).not.toContain("sk-ant-")
    // It should still say a credential is present, and how many.
    expect(run.stdout).toContain("present")
    expect(run.stdout).toContain("values not printed")
  })

  test("doctor does not echo ANTHROPIC_API_KEY's value anywhere in stdout or stderr", () => {
    const secret = "totally-secret-value-abcdef123456"
    const run = cli(["doctor"], { OPENAI_API_KEY: secret })
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret)
  })
})

describe("BW-010 — workspace trust", () => {
  test("trust requires attribution", () => {
    const run = cli(["trust", "."])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain("--by")
  })

  test("trust with attribution records the grant", () => {
    const granted = cli(["trust", ".", "--by", "tester"])
    expect(granted.code).toBe(0)
    expect(granted.stdout).toContain("trusted")
  })

  test("an unknown workspace starts untrusted, and doctor says so", () => {
    const run = cli(["doctor"], { BASHWINK_OPENCODE_BIN: "" })
    expect(run.stdout).toContain("is NOT trusted")
  })
})

describe("BW-012/013 — plan and task lifecycle", () => {
  test("plan new creates an inspectable plan that is not approved", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-plan-"))
    try {
      const env = { BASHWINK_HOME: home }
      const created = cli(["plan", "new", "fix the bug", "--files=src/a.ts"], env)
      expect(created.code).toBe(0)
      expect(created.stdout).toContain("draft")

      const shown = cli(["plan", "show"], env)
      expect(shown.code).toBe(0)
      expect(shown.stdout).toContain("fix the bug")
      // Editing is blocked until a human approves; the plan says so out loud.
      expect(shown.stdout).toContain("not approved")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("approval requires a name and then records it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-appr-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "objective"], env)

      const refused = cli(["plan", "approve"], env)
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain("--by")

      const approved = cli(["plan", "approve", "--by", "aldrin"], env)
      expect(approved.code).toBe(0)
      expect(approved.stdout).toContain("approved by aldrin")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an illegal transition is refused with a nonzero exit", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-trans-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "objective"], env)
      const refused = cli(["plan", "task", "inspect", "verified"], env)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("illegal transition")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("verification is refused while a declared check has no observation", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-verif-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "objective"], env)
      cli(["plan", "task", "inspect", "ready"], env)
      cli(["plan", "task", "inspect", "in_progress"], env)
      cli(["plan", "task", "inspect", "implemented"], env)

      const refused = cli(["plan", "task", "inspect", "verified"], env)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("never run")

      // Record the observation, and only then is verification allowed.
      expect(cli(["plan", "observe", "inspect", "inspect-files-exist", "pass"], env).code).toBe(0)
      expect(cli(["plan", "task", "inspect", "verified"], env).code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an observation for an undeclared check is refused", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-obsv-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "objective"], env)
      const refused = cli(["plan", "observe", "inspect", "made-up-check", "pass"], env)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("declares no check")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("plan show --json emits parseable JSON", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-json-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "json objective"], env)
      const run = cli(["plan", "show", "--json"], env)
      const parsed = JSON.parse(run.stdout) as { v: number; tasks: unknown[] }
      expect(parsed.v).toBe(1)
      expect(parsed.tasks.length).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("BW-015 — evidence export", () => {
  test("export refuses without a plan instead of inventing one", () => {
    const run = cli(["evidence", "export"])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("no plan")
  })

  test("export reports checks that never ran as not_run", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-exp-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "export objective"], env)
      const run = cli(["evidence", "export"], env)
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("⬜ not_run")
      expect(run.stdout).toContain("incomplete")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("export --json is machine readable", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-expj-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "export objective"], env)
      const run = cli(["evidence", "export", "--json"], env)
      const parsed = JSON.parse(run.stdout) as { verdict: string; summary: { notRun: number } }
      expect(parsed.verdict).toBe("incomplete")
      expect(parsed.summary.notRun).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("BW-019 — resume", () => {
  test("resume on a clean store reports nothing to do, not success", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-res-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "resume objective"], env)
      const run = cli(["resume"], env)
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("nothing to resume")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("resume --status reports an in-flight task as interrupted", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bw-cli-res2-"))
    try {
      const env = { BASHWINK_HOME: home }
      cli(["plan", "new", "resume objective"], env)
      cli(["plan", "task", "inspect", "ready"], env)
      cli(["plan", "task", "inspect", "in_progress"], env)
      const status = cli(["resume", "--status"], env)
      expect(status.code).toBe(0)
      expect(status.stdout).toContain("inspect(in_progress)")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
