import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SCHEMA_VERSION, SchemaTooNewError, Store } from "../src/store.js"
import type { Plan } from "../src/plan.js"

const plan = (): Plan => ({
  v: 1,
  id: "plan_aaaaaaaaaaaa",
  objective: "survive a restart",
  files: ["src/a.ts"],
  approval: "draft",
  risks: [],
  createdAt: "2026-11-23T00:00:00.000Z",
  tasks: [
    {
      id: "inspect",
      title: "inspect",
      status: "pending",
      checks: [{ id: "c1", description: "check one" }],
    },
    { id: "implement", title: "implement", status: "pending" },
  ],
})

function withTempFile(run: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-store-"))
  try {
    run(path.join(dir, "bashwink.sqlite"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("store migrations", () => {
  test("a fresh database migrates to the current version", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
      store.close()
    })
  })

  test("migrating twice is a no-op, not a failure", () => {
    withTempFile((file) => {
      const first = new Store({ file })
      expect(first.migrate()).toBe(SCHEMA_VERSION)
      first.close()
      // A second start on the same file must be safe — this is every restart.
      const second = new Store({ file })
      expect(second.schemaVersion()).toBe(SCHEMA_VERSION)
      second.close()
    })
  })

  test("a newer schema is refused instead of silently downgraded", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
      // Reopening must fail loudly: an old binary writing a new schema is how data is lost.
      expect(() => new Store({ file })).toThrow(SchemaTooNewError)
      store.close()
    })
  })

  test("the documented rollback returns the file to v0 and is re-runnable", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
      expect(store.rollback()).toBe(0)
      // Everything the rollback drops is gone, and re-migrating recreates it.
      expect(store.plan("plan_aaaaaaaaaaaa")).toBeUndefined()
      expect(store.migrate()).toBe(SCHEMA_VERSION)
      expect(store.plan("plan_aaaaaaaaaaaa")).toBeUndefined()
      store.close()
    })
  })
})

describe("store durability", () => {
  test("a saved plan and its task statuses survive a restart", () => {
    withTempFile((file) => {
      const first = new Store({ file })
      first.savePlan(plan())
      first.transition("inspect", "ready", "dependencies satisfied")
      first.close()

      // A brand-new process would do exactly this.
      const second = new Store({ file })
      const restored = second.plan("plan_aaaaaaaaaaaa")
      expect(restored?.objective).toBe("survive a restart")
      expect(restored?.tasks).toHaveLength(2)
      expect(second.taskStatus("inspect")).toBe("ready")
      second.close()
    })
  })

  test("a transition is recorded, not just applied", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.transition("inspect", "ready", "deps done")
      store.transition("inspect", "in_progress")
      const history = store.transitions("inspect")
      expect(history).toHaveLength(2)
      expect(history[0]?.from).toBe("pending")
      expect(history[0]?.to).toBe("ready")
      expect(history[0]?.reason).toBe("deps done")
      expect(history[1]?.to).toBe("in_progress")
      store.close()
    })
  })

  test("an illegal transition leaves the stored status untouched", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      expect(() => store.transition("inspect", "verified")).toThrow()
      // The refused transition must not have partially applied.
      expect(store.taskStatus("inspect")).toBe("pending")
      expect(store.transitions("inspect")).toHaveLength(0)
      store.close()
    })
  })

  test("transitioning an unknown task is an error, not a silent insert", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      expect(() => store.transition("ghost", "ready")).toThrow()
      store.close()
    })
  })
})

describe("check observations", () => {
  test("verification is refused when a declared check never ran", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.transition("inspect", "ready")
      store.transition("inspect", "in_progress")
      store.transition("inspect", "implemented")
      const guard = store.checksPassed("inspect")
      expect(guard.ok).toBe(false)
      expect(guard.reason).toContain("never run")
      store.close()
    })
  })

  test("a failing observation blocks verification", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.observe("inspect", { checkId: "c1", status: "fail", exitCode: 1 })
      const guard = store.checksPassed("inspect")
      expect(guard.ok).toBe(false)
      expect(guard.reason).toContain("fail")
      store.close()
    })
  })

  test("a passing observation permits verification", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.observe("inspect", { checkId: "c1", status: "pass", exitCode: 0 })
      expect(store.checksPassed("inspect").ok).toBe(true)
      store.transition("inspect", "ready")
      store.transition("inspect", "in_progress")
      store.transition("inspect", "implemented")
      expect(store.transition("inspect", "verified")).toBe("verified")
      store.close()
    })
  })

  test("the last observation wins, and the history is preserved", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.observe("inspect", { checkId: "c1", status: "fail", exitCode: 1 })
      store.observe("inspect", { checkId: "c1", status: "pass", exitCode: 0 })
      const observations = store.observations("inspect")
      expect(observations).toHaveLength(2)
      expect(observations.at(-1)?.status).toBe("pass")
      expect(store.checksPassed("inspect").ok).toBe(true)
      store.close()
    })
  })

  test("a task that declares no checks cannot be verified", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      // "implement" has no checks, so nothing could ever prove it.
      const guard = store.checksPassed("implement")
      expect(guard.ok).toBe(false)
      expect(guard.reason).toContain("no checks")
      store.close()
    })
  })

  test("not_run is preserved distinctly from fail", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.observe("inspect", { checkId: "c1", status: "not_run" })
      const guard = store.checksPassed("inspect")
      expect(guard.ok).toBe(false)
      // The distinction matters: BW-015's export must not read this as a failure.
      expect(guard.reason).toContain("not_run")
      expect(store.observations("inspect")[0]?.status).toBe("not_run")
      store.close()
    })
  })
})

describe("attempt tracking (BW-019)", () => {
  test("an unfinished attempt is reported and is not 'applied'", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      const id = store.startAttempt("inspect", "write_file", "abc123")
      expect(store.interruptedAttempts()).toHaveLength(1)
      expect(store.alreadyApplied("inspect", "write_file", "abc123")).toBe(false)
      store.finishAttempt(id, "abandoned")
      expect(store.interruptedAttempts()).toHaveLength(0)
      expect(store.alreadyApplied("inspect", "write_file", "abc123")).toBe(false)
      store.close()
    })
  })

  test("an applied attempt is matched by fingerprint, not by operation name", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      const id = store.startAttempt("inspect", "write_file", "abc123")
      store.finishAttempt(id, "applied")
      expect(store.alreadyApplied("inspect", "write_file", "abc123")).toBe(true)
      // A different content hash is a different write, and must not be skipped.
      expect(store.alreadyApplied("inspect", "write_file", "def456")).toBe(false)
      store.close()
    })
  })

  test("a failed attempt is retried rather than treated as applied", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      const id = store.startAttempt("inspect", "write_file", "abc123")
      store.finishAttempt(id, "failed", "EACCES")
      expect(store.alreadyApplied("inspect", "write_file", "abc123")).toBe(false)
      store.close()
    })
  })
})

describe("runs", () => {
  test("a run with no exit code is reported as interrupted", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.startRun("run_1", plan().id)
      expect(store.interruptedRuns()).toHaveLength(1)
      store.endRun("run_1", 0)
      expect(store.interruptedRuns()).toHaveLength(0)
      store.close()
    })
  })

  test("a run killed by a signal is marked interrupted", () => {
    withTempFile((file) => {
      const store = new Store({ file })
      store.savePlan(plan())
      store.startRun("run_2", plan().id)
      store.endRun("run_2", -1, true)
      const row = store.db.query("SELECT interrupted FROM run WHERE id = ?").get("run_2") as {
        interrupted: number
      }
      expect(row.interrupted).toBe(1)
      store.close()
    })
  })
})
