import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Store } from "../src/store.js"
import {
  build,
  digestFile,
  readToolEvents,
  reportChecks,
  toJson,
  toMarkdown,
} from "../src/evidence-export.js"
import type { Plan } from "../src/plan.js"

const NOW = "2026-11-23T00:00:00.000Z"

const plan = (): Plan => ({
  v: 1,
  id: "plan_bbbbbbbbbbbb",
  objective: "prove the export",
  files: ["src/a.ts"],
  approval: "approved",
  approvedBy: "aldrin",
  approvedAt: NOW,
  risks: [],
  createdAt: NOW,
  tasks: [
    {
      id: "one",
      title: "passing task",
      status: "verified",
      checks: [
        { id: "p1", description: "passes" },
        { id: "f1", description: "fails" },
        { id: "n1", description: "never ran" },
      ],
    },
  ],
})

function tempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-export-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("reportChecks", () => {
  test("a declared check with no observation is not_run, never fail", () => {
    // The single most important distinction in this module: a check that never executed must
    // not be summarised as a failure, or the report accuses the code of a defect it never saw.
    const reports = reportChecks([{ id: "c1", description: "check" }], [])
    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe("not_run")
  })

  test("pass, fail and not_run stay distinct", () => {
    const reports = reportChecks(
      [
        { id: "a", description: "a" },
        { id: "b", description: "b" },
        { id: "c", description: "c" },
      ],
      [
        { checkId: "a", status: "pass", exitCode: 0, at: NOW },
        { checkId: "b", status: "fail", exitCode: 1, at: NOW },
        { checkId: "c", status: "not_run", at: NOW },
      ],
    )
    expect(reports.map((report) => report.outcome)).toEqual(["pass", "fail", "not_run"])
    expect(reports[0]?.exitCode).toBe(0)
    expect(reports[1]?.exitCode).toBe(1)
    expect(reports[2]?.exitCode).toBeUndefined()
  })

  test("the last observation wins", () => {
    const reports = reportChecks(
      [{ id: "a", description: "a" }],
      [
        { checkId: "a", status: "fail", exitCode: 1, at: NOW },
        { checkId: "a", status: "pass", exitCode: 0, at: NOW },
      ],
    )
    expect(reports[0]?.outcome).toBe("pass")
  })

  test("an observation for an undeclared check is not reported", () => {
    // Otherwise the export could show a passing check that does not prove the task.
    const reports = reportChecks(
      [{ id: "a", description: "a" }],
      [{ checkId: "ghost", status: "pass", at: NOW }],
    )
    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe("not_run")
  })

  test("a very long detail is bounded, and says so", () => {
    const reports = reportChecks(
      [{ id: "a", description: "a" }],
      [{ checkId: "a", status: "fail", at: NOW, detail: "x".repeat(2000) }],
    )
    expect(reports[0]?.detail?.length).toBeLessThan(600)
    expect(reports[0]?.detail?.endsWith("…")).toBe(true)
  })
})

describe("readToolEvents", () => {
  test("a missing log is reported as a limitation, not as zero activity that passed", () => {
    tempDir((dir) => {
      const result = readToolEvents(path.join(dir, "absent.jsonl"))
      expect(result.events).toEqual([])
      expect(result.limitations[0]).toContain("no evidence log")
    })
  })

  test("entries are read back with their task association", () => {
    tempDir((dir) => {
      const file = path.join(dir, "evidence.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({
            seq: 1,
            at: NOW,
            phase: "before",
            call: { id: "call_1", tool: "shell", taskID: "inspect" },
            payload: { input: "ls" },
          }),
          JSON.stringify({
            seq: 2,
            at: NOW,
            phase: "after",
            call: { id: "call_1", tool: "shell", taskID: "inspect" },
            payload: { status: "completed", exit: 0 },
          }),
        ].join("\n"),
      )
      const result = readToolEvents(file)
      expect(result.events).toHaveLength(2)
      expect(result.events[0]?.taskId).toBe("inspect")
      expect(result.events[1]?.status).toBe("completed")
      expect(result.events[1]?.exit).toBe(0)
      expect(result.limitations).toEqual([])
    })
  })

  test("an unassigned event is listed and the gap is stated", () => {
    tempDir((dir) => {
      const file = path.join(dir, "evidence.jsonl")
      writeFileSync(
        file,
        JSON.stringify({
          seq: 1,
          at: NOW,
          phase: "before",
          call: { id: "call_1", tool: "shell" },
          payload: {},
        }),
      )
      const result = readToolEvents(file)
      expect(result.events[0]?.taskId).toBeUndefined()
      // A wrong association would be worse than an admitted gap, so the gap is reported.
      expect(result.limitations.some((line) => line.includes("unassigned"))).toBe(true)
    })
  })

  test("an unparseable line is counted as a limitation rather than skipped silently", () => {
    tempDir((dir) => {
      const file = path.join(dir, "evidence.jsonl")
      writeFileSync(
        file,
        `${JSON.stringify({ seq: 1, at: NOW, phase: "before", call: { id: "a", tool: "t" } })}\nnot json\n`,
      )
      const result = readToolEvents(file)
      expect(result.events).toHaveLength(1)
      expect(result.limitations.some((line) => line.includes("not parseable"))).toBe(true)
    })
  })
})

describe("build", () => {
  test("a verified task with an unrun check is reported as a contradiction", () => {
    // This is the guard against a stored status lying about its own evidence.
    tempDir((dir) => {
      const store = new Store({ file: path.join(dir, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      store.observe("one", { checkId: "f1", status: "fail", exitCode: 1 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: path.join(dir, "absent.jsonl"),
        now: () => new Date(NOW),
      })
      expect(report.verdict).toBe("fail")
      expect(report.summary.failed).toBe(1)
      expect(report.summary.notRun).toBe(1)
      expect(
        report.limitations.some(
          (line) => line.includes("contradiction") || line.includes("disagree"),
        ),
      ).toBe(true)
      store.close()
    })
  })

  test("an incomplete run is not a pass", () => {
    tempDir((dir) => {
      const store = new Store({ file: path.join(dir, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: path.join(dir, "absent.jsonl"),
        now: () => new Date(NOW),
      })
      // Never ran, so not "pass" and not "fail".
      expect(report.verdict).toBe("incomplete")
      expect(report.limitations.some((line) => line.includes("never executed"))).toBe(true)
      store.close()
    })
  })

  test("a fully verified run is a pass", () => {
    tempDir((dir) => {
      const store = new Store({ file: path.join(dir, "db.sqlite") })
      const single: Plan = {
        ...plan(),
        tasks: [
          { id: "one", title: "t", status: "verified", checks: [{ id: "p1", description: "p" }] },
        ],
      }
      store.savePlan(single)
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      const report = build({
        store,
        plan: single,
        runId: "run_1",
        evidenceFile: path.join(dir, "absent.jsonl"),
        now: () => new Date(NOW),
      })
      expect(report.verdict).toBe("pass")
      expect(report.summary.verified).toBe(1)
      store.close()
    })
  })
})

describe("rendering", () => {
  test("markdown distinguishes not_run from fail visually", () => {
    tempDir((dir) => {
      const store = new Store({ file: path.join(dir, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      store.observe("one", { checkId: "f1", status: "fail", exitCode: 1 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: path.join(dir, "absent.jsonl"),
        now: () => new Date(NOW),
      })
      const markdown = toMarkdown(report)
      expect(markdown).toContain("✅ pass")
      expect(markdown).toContain("❌ fail")
      expect(markdown).toContain("⬜ not_run")
      expect(markdown).toContain("`fail`")
      store.close()
    })
  })

  test("json is stable and parseable", () => {
    tempDir((dir) => {
      const store = new Store({ file: path.join(dir, "db.sqlite") })
      store.savePlan(plan())
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: path.join(dir, "absent.jsonl"),
        now: () => new Date(NOW),
      })
      const json = toJson(report)
      expect(json.endsWith("\n")).toBe(true)
      expect(JSON.parse(json).v).toBe(1)
      store.close()
    })
  })
})

describe("digestFile", () => {
  test("digests a real file and admits absence", () => {
    tempDir((dir) => {
      const file = path.join(dir, "raw.txt")
      writeFileSync(file, "raw process output\n")
      const digest = digestFile(file)
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      // Recomputable by a reviewer with sha256sum, which is the point of exposing it.
      expect(digestFile(path.join(dir, "nope"))).toBeUndefined()
    })
  })
})
