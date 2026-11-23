import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Store } from "../src/store.js"
import { applyWrite, canVerify, fingerprintWrite, reconcile, resume } from "../src/resume.js"
import type { Plan } from "../src/plan.js"

const NOW = "2026-11-23T00:00:00.000Z"

const plan = (): Plan => ({
  v: 1,
  id: "plan_cccccccccccc",
  objective: "resume me",
  files: [],
  approval: "draft",
  risks: [],
  createdAt: NOW,
  tasks: [
    { id: "work", title: "work", status: "pending", checks: [{ id: "c1", description: "check" }] },
  ],
})

function withStore(run: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-resume-"))
  const store = new Store({ file: path.join(dir, "db.sqlite") })
  try {
    store.savePlan(plan())
    run(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("fingerprintWrite", () => {
  test("identical content and path give identical fingerprints", () => {
    // This is what makes resume idempotent: the second run can recognise its own write.
    expect(fingerprintWrite("a.ts", "x")).toBe(fingerprintWrite("a.ts", "x"))
  })

  test("a different path or a different byte is a different write", () => {
    expect(fingerprintWrite("a.ts", "x")).not.toBe(fingerprintWrite("b.ts", "x"))
    expect(fingerprintWrite("a.ts", "x")).not.toBe(fingerprintWrite("a.ts", "y"))
  })

  test("the path is not confusable with the content", () => {
    // Concatenating without a separator would make ("ab","c") collide with ("a","bc").
    expect(fingerprintWrite("ab", "c")).not.toBe(fingerprintWrite("a", "bc"))
  })
})

describe("applyWrite", () => {
  test("applies once and reports the fingerprint", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      const result = applyWrite({ store, taskId: "work", file: target, content: "hello\n" })
      expect(result.applied).toBe(true)
      expect(result.reason).toBe("applied")
      expect(readFileSync(target, "utf8")).toBe("hello\n")
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  test("an identical re-apply is skipped, and the writer is not called twice", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      let writes = 0
      const write = (file: string, content: string) => {
        writes += 1
        writeFileSync(file, content, "utf8")
      }
      const first = applyWrite({ store, taskId: "work", file: target, content: "hi\n", write })
      const second = applyWrite({ store, taskId: "work", file: target, content: "hi\n", write })
      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)
      expect(second.reason).toBe("skipped_already_applied")
      // The count is the real assertion: the bookkeeping could lie, the writer cannot.
      expect(writes).toBe(1)
    })
  })

  test("a file already holding the intended bytes is not rewritten", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      writeFileSync(target, "already\n")
      const result = applyWrite({ store, taskId: "work", file: target, content: "already\n" })
      expect(result.applied).toBe(false)
      expect(result.reason).toBe("skipped_identical_on_disk")
    })
  })

  test("a genuinely different edit is not skipped", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      applyWrite({ store, taskId: "work", file: target, content: "one\n" })
      const second = applyWrite({ store, taskId: "work", file: target, content: "two\n" })
      // Fingerprinting content, not just the path, is what makes this correct.
      expect(second.applied).toBe(true)
      expect(readFileSync(target, "utf8")).toBe("two\n")
    })
  })

  test("a failing writer leaves a retryable attempt, not a claimed success", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      expect(() =>
        applyWrite({
          store,
          taskId: "work",
          file: target,
          content: "x\n",
          write: () => {
            throw new Error("EACCES")
          },
        }),
      ).toThrow("EACCES")
      // Not applied, so a resume will genuinely try again.
      expect(store.alreadyApplied("work", "write_file", fingerprintWrite(target, "x\n"))).toBe(
        false,
      )
      expect(existsSync(target)).toBe(false)
    })
  })

  test("force overrides both skip paths", () => {
    withStore((store, dir) => {
      const target = path.join(dir, "out.txt")
      writeFileSync(target, "same\n")
      applyWrite({ store, taskId: "work", file: target, content: "same\n" })
      const forced = applyWrite({
        store,
        taskId: "work",
        file: target,
        content: "same\n",
        force: true,
      })
      expect(forced.applied).toBe(true)
    })
  })
})

describe("reconcile", () => {
  test("an in-progress task is reported as interrupted, not as progress", () => {
    withStore((store) => {
      store.transition("work", "ready")
      store.transition("work", "in_progress")
      const report = reconcile(store, plan().id)
      expect(report.found).toBe(true)
      expect(report.tasks).toEqual([{ id: "work", from: "in_progress" }])
      expect(report.limitations.some((line) => line.includes("outcome is unknown"))).toBe(true)
    })
  })

  test("an unfinished attempt and a run with no exit are both found", () => {
    withStore((store) => {
      store.startAttempt("work", "write_file", "fp")
      store.startRun("run_x", plan().id)
      const report = reconcile(store, plan().id)
      expect(report.attempts).toHaveLength(1)
      expect(report.runs).toHaveLength(1)
    })
  })

  test("a clean store reports nothing to reconcile", () => {
    withStore((store) => {
      const report = reconcile(store, plan().id)
      expect(report.found).toBe(false)
      expect(report.limitations).toEqual([])
    })
  })
})

describe("resume", () => {
  test("reopens an interrupted task into in_progress and never into verified", () => {
    withStore((store) => {
      store.transition("work", "ready")
      store.transition("work", "in_progress")
      const result = resume({ store, planId: plan().id })
      expect(result.reopened).toEqual([{ id: "work", to: "in_progress" }])
      expect(store.taskStatus("work")).toBe("in_progress")
      expect(result.mustRecheck).toContain("work")
    })
  })

  test("abandons unfinished attempts so they are not mistaken for applied", () => {
    withStore((store) => {
      const id = store.startAttempt("work", "write_file", "fp")
      const result = resume({ store, planId: plan().id })
      expect(result.abandonedAttempts).toEqual([id])
      expect(store.interruptedAttempts()).toHaveLength(0)
      expect(store.alreadyApplied("work", "write_file", "fp")).toBe(false)
    })
  })

  test("closes runs that never recorded an exit code", () => {
    withStore((store) => {
      store.startRun("run_y", plan().id)
      const result = resume({ store, planId: plan().id })
      expect(result.interruptedRuns).toEqual(["run_y"])
      expect(store.interruptedRuns()).toHaveLength(0)
    })
  })

  test("resume is a no-op on a clean store, not an error", () => {
    withStore((store) => {
      const result = resume({ store, planId: plan().id })
      expect(result.reopened).toEqual([])
      expect(result.abandonedAttempts).toEqual([])
    })
  })

  test("the transition history shows the interruption rather than hiding it", () => {
    withStore((store) => {
      store.transition("work", "ready")
      store.transition("work", "in_progress")
      resume({ store, planId: plan().id })
      const history = store.transitions("work").map((entry) => `${entry.from}->${entry.to}`)
      // A reader can see that the run was interrupted and resumed, which is the evidence.
      expect(history).toContain("in_progress->interrupted")
      expect(history).toContain("interrupted->in_progress")
    })
  })
})

describe("canVerify", () => {
  test("a task needing a recheck cannot be verified even with passing observations", () => {
    withStore((store) => {
      store.observe("work", { checkId: "c1", status: "pass", exitCode: 0 })
      // The observation is stale: it predates the interruption.
      const guard = canVerify(store, "work", ["work"])
      expect(guard.ok).toBe(false)
      expect(guard.reason).toContain("re-run")
    })
  })

  test("without a recheck requirement the ordinary guard applies", () => {
    withStore((store) => {
      expect(canVerify(store, "work", []).ok).toBe(false)
      store.observe("work", { checkId: "c1", status: "pass", exitCode: 0 })
      expect(canVerify(store, "work", []).ok).toBe(true)
    })
  })
})
