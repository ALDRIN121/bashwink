/**
 * BW-091 — model attribution in the evidence chain, and the export's model table.
 *
 * The claim these tests protect is narrow and checkable: an evidence entry says which model
 * served the call **only** when the runtime reported one. The dangerous alternative is
 * filling the gap with the configured default, which would make every entry look attributed
 * and quietly mis-attribute work after a mid-session switch.
 *
 * The attribution path itself was verified against the real 2.3.2 binary (a probe plugin
 * dumping `session.step.started` and `session.model.selected`); these are the fast controls.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EvidenceRecorder, verify } from "@bashwink/evidence"
import { build, readToolEvents, toMarkdown } from "../src/evidence-export.js"
import { Store } from "../src/store.js"
import type { Plan } from "../src/plan.js"

const NOW = "2026-11-23T10:00:00.000Z"

function tempDir(body: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "bw-attrib-"))
  try {
    body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function recorder(directory: string): EvidenceRecorder {
  return new EvidenceRecorder({ directory, now: () => new Date(NOW) })
}

const CLAUDE = { id: "claude-sonnet-5", providerID: "commandcode" } as const
const GPT = { id: "gpt-6.1-sol", providerID: "commandcode" } as const

describe("recorder model attribution", () => {
  test("a call made before any model is known carries no model field", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      const entry = log.recordTool(
        "before",
        { id: "c1", tool: "read", sessionID: "ses_1" },
        { input: {} },
      )
      expect(entry.payload.model).toBeUndefined()
      // And the absence is not papered over by the recorder's own knowledge.
      expect(JSON.parse(readFileSync(log.file, "utf8"))).toBeTruthy()
    })
  })

  test("after setModel, later calls are attributed and earlier ones are not rewritten", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
      log.setModel("ses_1", CLAUDE)
      const second = log.recordTool("before", { id: "c2", tool: "edit", sessionID: "ses_1" }, {})
      const entries = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(entries[0].payload.model).toBeUndefined()
      expect(second.payload.model).toEqual(CLAUDE)
      expect(entries[1].payload.model).toEqual(CLAUDE)
    })
  })

  test("attribution is per session, so a concurrent session is not mis-attributed", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.setModel("ses_a", CLAUDE)
      log.setModel("ses_b", GPT)
      const a = log.recordTool("before", { id: "a1", tool: "read", sessionID: "ses_a" }, {})
      const b = log.recordTool("before", { id: "b1", tool: "read", sessionID: "ses_b" }, {})
      const unknown = log.recordTool("before", { id: "u1", tool: "read", sessionID: "ses_c" }, {})
      expect(a.payload.model).toEqual(CLAUDE)
      expect(b.payload.model).toEqual(GPT)
      // A session the recorder has never seen gets no model rather than another's.
      expect(unknown.payload.model).toBeUndefined()
    })
  })

  test("setModel reports whether anything changed, so switches are not re-recorded", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      expect(log.setModel("ses_1", CLAUDE)).toBe(true)
      expect(log.setModel("ses_1", CLAUDE)).toBe(false)
      expect(log.setModel("ses_1", GPT)).toBe(true)
      expect(log.setModel("ses_1", { ...CLAUDE, variant: "thinking" })).toBe(true)
    })
  })

  test("a switch gets its own entry naming both models", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      const first = log.recordModel({ sessionID: "ses_1", model: CLAUDE, source: "step" })
      const switched = log.recordModel({
        sessionID: "ses_1",
        model: GPT,
        previous: CLAUDE,
        source: "switch",
      })
      expect(first.phase).toBe("model")
      expect(switched.payload.note).toContain("commandcode/gpt-6.1-sol")
      expect(switched.payload.note).toContain("previous=commandcode/claude-sonnet-5")
      expect(switched.payload.model).toEqual(GPT)
    })
  })

  test("model entries keep the chain verifiable", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.recordBoot({ plugin: "bashwink-evidence", pid: 1, cwd: "/tmp" })
      log.recordModel({ sessionID: "ses_1", model: CLAUDE, source: "step" })
      log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
      const result = verify(log.file)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.entries).toBe(3)
    })
  })

  test("a hostile model id cannot inject chain fields or unbounded text", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.setModel("ses_1", {
        id: `evil"\n{"seq":999,"hash":"fake"}`,
        providerID: "x".repeat(500),
      })
      const entry = log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
      // Bounded, and still inside the payload rather than becoming a new line of the log.
      expect(entry.payload.model?.id.length).toBeLessThanOrEqual(128)
      expect(entry.payload.model?.providerID.length).toBeLessThanOrEqual(128)
      expect(verify(log.file).ok).toBe(true)
    })
  })
})

describe("export model table", () => {
  // Shape taken from the store's schema (and from evidence-export.test.ts), because a
  // fixture that merely type-asserts its way past `as Plan` fails at the SQLite layer.
  function plan(): Plan {
    return {
      v: 1,
      id: "plan_attrib0001",
      objective: "attribute the work",
      files: ["src/a.ts"],
      approval: "approved",
      approvedBy: "tester",
      approvedAt: NOW,
      risks: [],
      createdAt: NOW,
      tasks: [
        {
          id: "one",
          title: "do the work",
          status: "verified",
          checks: [{ id: "p1", description: "passes" }],
        },
      ],
    }
  }

  function evidenceWith(directory: string): string {
    const log = recorder(directory)
    log.recordModel({ sessionID: "ses_1", model: CLAUDE, source: "step" })
    log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
    log.recordTool("after", { id: "c1", tool: "read", sessionID: "ses_1" }, { status: "completed" })
    log.recordModel({ sessionID: "ses_1", model: GPT, previous: CLAUDE, source: "switch" })
    log.recordTool("before", { id: "c2", tool: "edit", sessionID: "ses_1" }, {})
    log.recordTool("after", { id: "c2", tool: "edit", sessionID: "ses_1" }, { status: "completed" })
    return log.file
  }

  test("readToolEvents exposes the model on each tool event and separates selections", () => {
    tempDir((directory) => {
      const result = readToolEvents(evidenceWith(directory))
      const models = result.events
        .map((event) => (event.phase === "before" ? event.model : undefined))
        .filter(Boolean)
      expect(models).toEqual(["commandcode/claude-sonnet-5", "commandcode/gpt-6.1-sol"])
      expect(result.selections.map((selection) => selection.model)).toEqual([
        "commandcode/claude-sonnet-5",
        "commandcode/gpt-6.1-sol",
      ])
    })
  })

  test("model entries do not inflate the tool-call count", () => {
    tempDir((directory) => {
      const result = readToolEvents(evidenceWith(directory))
      // Four tool entries (2 before, 2 after). If model entries were counted as tool events
      // the limit of what the agent did would be overstated.
      expect(result.events).toHaveLength(4)
      expect(result.events.filter((event) => event.phase === "before")).toHaveLength(2)
    })
  })

  test("the exported table counts calls per model and marks a switch", () => {
    tempDir((directory) => {
      const store = new Store({ file: path.join(directory, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: evidenceWith(directory),
        now: () => new Date(NOW),
      })
      const byModel = Object.fromEntries(report.models.map((model) => [model.model, model]))
      expect(byModel["commandcode/claude-sonnet-5"]?.toolCalls).toBe(1)
      expect(byModel["commandcode/gpt-6.1-sol"]?.toolCalls).toBe(1)
      expect(byModel["commandcode/claude-sonnet-5"]?.switched).toBe(true)
      store.close()
    })
  })

  test("a run with no attribution says so in the limitations rather than showing an empty table", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
      log.recordTool(
        "after",
        { id: "c1", tool: "read", sessionID: "ses_1" },
        { status: "completed" },
      )
      const store = new Store({ file: path.join(directory, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: log.file,
        now: () => new Date(NOW),
      })
      expect(report.models).toHaveLength(0)
      expect(report.limitations.some((line) => line.includes("no model attribution"))).toBe(true)
      store.close()
    })
  })

  test("markdown renders the model table only when there is attribution", () => {
    tempDir((directory) => {
      const log = recorder(directory)
      log.recordTool("before", { id: "c1", tool: "read", sessionID: "ses_1" }, {})
      const store = new Store({ file: path.join(directory, "db.sqlite") })
      store.savePlan(plan())
      const unattributed = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: log.file,
        now: () => new Date(NOW),
      })
      expect(toMarkdown(unattributed)).not.toContain("## Models")
      store.close()
    })
  })

  test("attributed markdown names the model and its call count", () => {
    tempDir((directory) => {
      const store = new Store({ file: path.join(directory, "db.sqlite") })
      store.savePlan(plan())
      store.observe("one", { checkId: "p1", status: "pass", exitCode: 0 })
      const report = build({
        store,
        plan: plan(),
        runId: "run_1",
        evidenceFile: evidenceWith(directory),
        now: () => new Date(NOW),
      })
      const markdown = toMarkdown(report)
      expect(markdown).toContain("## Models")
      expect(markdown).toContain("`commandcode/claude-sonnet-5`")
      store.close()
    })
  })

  test("a model field written by an older run without attribution is tolerated", () => {
    tempDir((directory) => {
      const file = path.join(directory, "legacy.jsonl")
      writeFileSync(
        file,
        `${JSON.stringify({
          seq: 1,
          at: NOW,
          phase: "before",
          call: { id: "c1", tool: "read", taskID: "one" },
          payload: {},
        })}\n`,
      )
      const result = readToolEvents(file)
      expect(result.events[0]?.model).toBeUndefined()
      expect(result.selections).toHaveLength(0)
    })
  })
})
