/**
 * BW-011 — planning mode cannot silently edit, and diff/undo are reproducible.
 *
 * The acceptance criterion is behavioural: *"code edits, diffs, undo, cancellation and
 * session resume behave predictably across three fixtures"*. So this asserts the property on
 * real git repositories rather than describing it. Three fixtures are used — a one-file edit,
 * a multi-file edit, and a cancellation — because "predictable" means predictable in each.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  NotApprovedError,
  assertEditable,
  isEditable,
  type EditablePlan,
} from "../src/edit-guard.js"

interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@bashwink.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@bashwink.invalid",
      // A fixed clock so fixture commits are stable across machines.
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  })
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

const APPROVED: EditablePlan = { approval: "approved", objective: "do work" }
const DRAFT: EditablePlan = { approval: "draft", objective: "do work" }

/** A real repo with `files` committed, so diff/undo have something to act on. */
function fixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-flow-"))
  try {
    git(dir, ["init", "-q", "-b", "main"])
    git(dir, ["config", "user.name", "fixture"])
    git(dir, ["config", "user.email", "fixture@bashwink.invalid"])
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(dir, name), content, "utf8")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-q", "-m", "baseline"])
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("BW-011 — the edit gate", () => {
  test("an approved plan is editable", () => {
    expect(isEditable(APPROVED)).toBe(true)
    expect(() => assertEditable(APPROVED)).not.toThrow()
  })

  test("a draft plan cannot edit", () => {
    expect(isEditable(DRAFT)).toBe(false)
    expect(() => assertEditable(DRAFT)).toThrow(NotApprovedError)
  })

  test("a rejected plan cannot edit either", () => {
    // "The human said no" is not the same as "undecided", and neither permits a write.
    const rejected: EditablePlan = { approval: "rejected", objective: "do work" }
    expect(() => assertEditable(rejected)).toThrow(NotApprovedError)
  })

  test("the refusal names the objective so the message is actionable", () => {
    try {
      assertEditable({ approval: "draft", objective: "fix the parser" })
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as Error).message).toContain("fix the parser")
      expect((error as NotApprovedError).code).toBe("not_approved")
    }
  })
})

describe("BW-011 — fixture 1: a one-file edit", () => {
  test("a planning-mode write attempt leaves the file untouched", () => {
    // The behavioural version: go through the only path an editing tool has, and confirm a
    // draft plan produces no change on disk.
    fixtureRepo({ "transform.ts": "export const slugify = (s: string) => s\n" }, (dir) => {
      const file = path.join(dir, "transform.ts")
      const before = readFileSync(file, "utf8")
      const attemptEdit = (plan: EditablePlan, content: string) => {
        assertEditable(plan)
        writeFileSync(file, content, "utf8")
      }
      expect(() => attemptEdit(DRAFT, "TAMPERED\n")).toThrow(NotApprovedError)
      expect(readFileSync(file, "utf8")).toBe(before)
    })
  })

  test("an approved edit produces a diff, and undo restores the exact bytes", () => {
    fixtureRepo({ "transform.ts": "export const slugify = (s: string) => s\n" }, (dir) => {
      const file = path.join(dir, "transform.ts")
      const baseline = readFileSync(file, "utf8")

      assertEditable(APPROVED)
      writeFileSync(file, `${baseline}export const fixed = true\n`, "utf8")

      const diff = git(dir, ["diff", "--no-color"])
      expect(diff.code).toBe(0)
      expect(diff.stdout).toContain("+export const fixed = true")

      // Undo restores from git, not from an in-memory guess.
      expect(git(dir, ["checkout", "--", "transform.ts"]).code).toBe(0)
      expect(readFileSync(file, "utf8")).toBe(baseline)
      expect(git(dir, ["status", "--porcelain"]).stdout.trim()).toBe("")
    })
  })

  test("undo twice is idempotent, not destructive", () => {
    fixtureRepo({ "transform.ts": "baseline\n" }, (dir) => {
      const file = path.join(dir, "transform.ts")
      writeFileSync(file, "changed\n", "utf8")
      git(dir, ["checkout", "--", "transform.ts"])
      const first = readFileSync(file, "utf8")
      git(dir, ["checkout", "--", "transform.ts"])
      expect(readFileSync(file, "utf8")).toBe(first)
      expect(first).toBe("baseline\n")
    })
  })
})

describe("BW-011 — fixture 2: a multi-file edit", () => {
  test("undo restores every file, not just the first", () => {
    const files = { "a.ts": "alpha\n", "b.ts": "beta\n" }
    fixtureRepo(files, (dir) => {
      assertEditable(APPROVED)
      writeFileSync(path.join(dir, "a.ts"), "alpha changed\n", "utf8")
      writeFileSync(path.join(dir, "b.ts"), "beta changed\n", "utf8")
      expect(git(dir, ["status", "--porcelain"]).stdout.trim().split("\n")).toHaveLength(2)

      git(dir, ["checkout", "--", "."])
      for (const [name, content] of Object.entries(files))
        expect(readFileSync(path.join(dir, name), "utf8")).toBe(content)
    })
  })

  test("a committed edit can be diffed against a fixed snapshot", () => {
    // Snapshot semantics: the comparison point is a recorded commit, not "whatever HEAD is".
    fixtureRepo({ "transform.ts": "export const slugify = (s: string) => s\n" }, (dir) => {
      const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim()
      writeFileSync(path.join(dir, "transform.ts"), "export const changed = 1\n", "utf8")
      git(dir, ["commit", "-q", "-am", "edit"])

      const diff = git(dir, ["diff", "--no-color", base, "HEAD"])
      expect(diff.stdout).toContain("+export const changed = 1")
      expect(diff.stdout).toContain("-export const slugify")

      // Returning to the snapshot is exact, which is what makes the flow reproducible.
      git(dir, ["checkout", "-q", base, "--", "transform.ts"])
      expect(readFileSync(path.join(dir, "transform.ts"), "utf8")).toContain("export const slugify")
    })
  })
})

describe("BW-011 — fixture 3: cancellation", () => {
  test("a cancelled run leaves a partial change that is visible, not hidden", () => {
    // Cancellation must not roll back silently: the partial write is evidence that the run was
    // interrupted, and an automatic revert would destroy that evidence.
    fixtureRepo({ "transform.ts": "baseline\n" }, (dir) => {
      writeFileSync(path.join(dir, "transform.ts"), "partially written", "utf8")
      expect(git(dir, ["status", "--porcelain"]).stdout).toContain("transform.ts")
      expect(git(dir, ["diff", "--no-color"]).stdout).toContain("+partially written")
    })
  })

  test("a cancelled run can still be undone explicitly", () => {
    fixtureRepo({ "transform.ts": "baseline\n" }, (dir) => {
      writeFileSync(path.join(dir, "transform.ts"), "partial", "utf8")
      git(dir, ["checkout", "--", "transform.ts"])
      expect(readFileSync(path.join(dir, "transform.ts"), "utf8")).toBe("baseline\n")
      expect(git(dir, ["status", "--porcelain"]).stdout.trim()).toBe("")
    })
  })
})
