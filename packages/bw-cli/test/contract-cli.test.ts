/**
 * BW-055 end-to-end: the contract as a person uses it.
 *
 * Unit tests prove the rules; this proves the CLI refuses to start work under a draft, keeps
 * acceptance criteria and their evidence in step, and cannot lose a criterion by revision.
 * Every assertion here is on real subprocess output in a throwaway BASHWINK_HOME.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CLI = path.join(import.meta.dir, "..", "src", "bin.ts")

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface Session {
  readonly run: (args: readonly string[]) => Run
  readonly cleanup: () => void
}

/** One throwaway BASHWINK_HOME shared by a sequence of commands, as a person would use it. */
function session(): Session {
  const home = mkdtempSync(path.join(tmpdir(), "bw-contract-"))
  return {
    run: (args) => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, CLI, ...args],
        env: { ...process.env, BASHWINK_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        cwd: path.join(import.meta.dir, "..", "..", ".."),
      })
      return {
        code: result.exitCode ?? -1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function json<T>(text: string): T {
  return JSON.parse(text) as T
}

describe("BW-055 — contract CLI", () => {
  test("a derived contract is draft, and starting work is refused until it is approved", () => {
    const { run, cleanup } = session()
    try {
      expect(run(["plan", "new", "fix the greeting", "--files=README.md"]).code).toBe(0)
      expect(run(["plan", "task", "inspect", "ready"]).code).toBe(0)

      const created = run(["contract", "new"])
      expect(created.code).toBe(0)
      expect(created.stdout).toContain("revision 1 (draft)")
      expect(created.stdout).toContain("3 required")

      const duplicate = run(["contract", "new"])
      expect(duplicate.code).toBe(1)
      expect(duplicate.stderr).toContain("already exists for this plan")

      const refused = run(["plan", "task", "inspect", "in_progress"])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("does not allow it")
      expect(refused.stderr).toContain("approve it before starting work")

      expect(run(["contract", "approve", "--by", "Aldrin"]).code).toBe(0)
      const started = run(["plan", "task", "inspect", "in_progress"])
      expect(started.code).toBe(0)
      expect(started.stdout).toContain("in_progress")
    } finally {
      cleanup()
    }
  })

  test("an observation moves the matching criterion and links the evidence", () => {
    const { run, cleanup } = session()
    try {
      run(["plan", "new", "fix the greeting", "--files=README.md"])
      run(["plan", "task", "inspect", "ready"])
      run(["contract", "new"])
      run(["contract", "approve", "--by", "Aldrin"])

      expect(
        run(["plan", "observe", "inspect", "inspect-files-exist", "pass", "--exit", "0"]).code,
      ).toBe(0)
      const status = json<{
        required: number
        passed: number
        criteria: {
          id: string
          status: string
          evidence: { status: string; observationId?: number }[]
        }[]
      }>(run(["contract", "status", "--json"]).stdout)

      const criterion = status.criteria.find((row) => row.id === "inspect.inspect-files-exist")
      expect(criterion?.status).toBe("passed")
      expect(criterion?.evidence).toHaveLength(1)
      expect(criterion?.evidence[0]?.observationId).toBeGreaterThan(0)
      expect(status.passed).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("a revision that drops a criterion keeps it as dropped, with its reason", () => {
    const { run, cleanup } = session()
    const spec = path.join(mkdtempSync(path.join(tmpdir(), "bw-spec-")), "revision.json")
    try {
      run(["plan", "new", "fix the greeting", "--files=README.md"])
      run(["contract", "new"])
      run(["plan", "observe", "inspect", "inspect-files-exist", "pass", "--exit", "0"])

      writeFileSync(
        spec,
        JSON.stringify({
          objective: "fix the greeting",
          allowedPaths: ["README.md"],
          criteria: [
            {
              id: "implement.implement-diff-present",
              statement: "the working tree differs from HEAD",
              required: true,
              task: "implement",
              check: "implement-diff-present",
            },
            {
              id: "verify.verify-tests-pass",
              statement: "the evidence suite passes",
              required: true,
              task: "verify",
              check: "verify-tests-pass",
            },
          ],
        }),
        "utf8",
      )
      const revised = run([
        "contract",
        "revise",
        "--file",
        spec,
        "--reason",
        "inspect is covered by review",
      ])
      expect(revised.code).toBe(0)
      expect(revised.stdout).toContain("1 dropped (kept, not deleted)")
      expect(revised.stdout).toContain("approval reset to draft")

      const status = json<{
        revision: number
        approval: string
        criteria: { id: string; status: string; statusReason?: string; evidence: unknown[] }[]
      }>(run(["contract", "status", "--json"]).stdout)
      expect(status.revision).toBe(2)
      expect(status.approval).toBe("draft")
      const dropped = status.criteria.find((row) => row.id === "inspect.inspect-files-exist")
      expect(dropped?.status).toBe("dropped")
      expect(dropped?.statusReason).toContain("inspect is covered by review")
      // The evidence that made it pass is still there: a drop is a decision, not a deletion.
      expect(dropped?.evidence).toHaveLength(1)

      const show = json<{ revisions: { revision: number; criteria: { id: string }[] }[] }>(
        run(["contract", "show", "--json"]).stdout,
      )
      expect(show.revisions).toHaveLength(2)
      expect(show.revisions[0]?.criteria.map((c) => c.id)).toContain("inspect.inspect-files-exist")
      expect(show.revisions[1]?.criteria.map((c) => c.id)).not.toContain(
        "inspect.inspect-files-exist",
      )
    } finally {
      rmSync(path.dirname(spec), { recursive: true, force: true })
      cleanup()
    }
  })

  test("a spec that cites an undeclared check is refused with the reason", () => {
    const { run, cleanup } = session()
    const dir = mkdtempSync(path.join(tmpdir(), "bw-spec-"))
    try {
      run(["plan", "new", "fix the greeting", "--files=README.md"])
      const spec = path.join(dir, "bad.json")
      writeFileSync(
        spec,
        JSON.stringify({
          criteria: [
            {
              id: "inspect.invented",
              statement: "invented",
              required: true,
              task: "inspect",
              check: "not-a-declared-check",
            },
          ],
        }),
        "utf8",
      )
      const result = run(["contract", "new", "--file", spec])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("declares no check 'not-a-declared-check'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup()
    }
  })
})
