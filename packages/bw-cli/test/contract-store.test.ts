/**
 * BW-055 — persisted contracts and the criterion lifecycle.
 *
 * The headline acceptance test is at the bottom: a criterion status must not disappear when
 * a contract is revised. Everything above it exists so that guarantee has something real to
 * guarantee — a round-tripping schema, explicit revision sequencing, and evidence that can
 * only move a status by existing.
 */

import { describe, expect, test } from "bun:test"
import { Store } from "../src/store.js"
import type { Plan } from "../src/plan.js"
import {
  ContractGateError,
  ContractRevisionError,
  type ContractCriterion,
  type TaskContract,
  deriveContract,
} from "../src/contract.js"

const createdAt = "2026-01-02T03:04:05.678Z"

function plan(): Plan {
  return {
    v: 1,
    id: "plan_abcdef123456",
    objective: "fix the greeting",
    files: ["src/greeting.ts"],
    approval: "approved",
    approvedBy: "Aldrin",
    approvedAt: createdAt,
    createdAt,
    risks: [],
    tasks: [
      {
        id: "inspect",
        title: "inspect",
        status: "pending",
        files: ["src/greeting.ts"],
        checks: [
          { id: "file-exists", description: "the target file exists", command: "test -f src" },
        ],
      },
      {
        id: "implement",
        title: "implement",
        status: "pending",
        checks: [{ id: "diff-present", description: "the tree differs from HEAD" }],
      },
    ],
  }
}

function setup(): { store: Store; contract: TaskContract } {
  const store = new Store({ file: ":memory:", now: () => new Date(createdAt) })
  const p = plan()
  store.savePlan(p)
  return { store, contract: deriveContract(p, { createdAt }) }
}

function revision(contract: TaskContract, overrides: Partial<TaskContract>): TaskContract {
  return {
    ...contract,
    ...overrides,
    revision: contract.revision + 1,
    reason: overrides.reason ?? "a change",
    approval: "draft",
  }
}

function criterion(overrides: Partial<ContractCriterion> = {}): ContractCriterion {
  return {
    id: "inspect.file-exists",
    statement: "the target file exists",
    required: true,
    task: "inspect",
    check: "file-exists",
    ...overrides,
  }
}

describe("BW-055 — schema and round-trip", () => {
  test("migration v2 creates the contract tables", () => {
    const { store } = setup()
    expect(store.schemaVersion()).toBe(2)
    const tables = (
      store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((row) => row.name)
    for (const table of ["contract", "contract_revision", "criterion", "criterion_evidence"])
      expect(tables).toContain(table)
  })

  test("a saved contract reads back with the same definition", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    const read = store.contract(contract.id)
    expect(read).toBeDefined()
    expect(read?.id).toBe(contract.id)
    expect(read?.planId).toBe(contract.planId)
    expect(read?.objective).toBe(contract.objective)
    expect(read?.baseCommit ?? null).toBeNull()
    expect(read?.allowedPaths).toEqual(contract.allowedPaths)
    expect(read?.forbiddenPaths).toEqual([])
    expect(read?.criteria.map((c) => [c.id, c.statement, c.task, c.check])).toEqual(
      contract.criteria.map((c) => [c.id, c.statement, c.task, c.check]),
    )
    expect(store.contractForPlan(contract.planId)?.id).toBe(contract.id)
  })

  test("revision 1 is recorded as an immutable snapshot", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    const revisions = store.revisions(contract.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]?.revision).toBe(1)
    expect(revisions[0]?.criteria.map((entry) => entry.id)).toEqual(
      contract.criteria.map((entry) => entry.id),
    )
  })

  test("approval changes the flag without inventing a revision", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    const approved = store.approveContract(contract.id, "Aldrin", createdAt)
    expect(approved.approval).toBe("approved")
    expect(approved.approvedBy).toBe("Aldrin")
    expect(store.revisions(contract.id)).toHaveLength(1)
    expect(store.contract(contract.id)?.revision).toBe(1)
  })
})

describe("BW-055 — revision sequencing", () => {
  test("a revision must increment by exactly one", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    expect(() => store.saveContract({ ...contract, revision: 3, reason: "skip" })).toThrow(
      ContractRevisionError,
    )
    expect(() => store.saveContract({ ...contract, revision: 2, reason: "next" })).not.toThrow()
  })

  test("a new contract must start at revision 1", () => {
    const { store, contract } = setup()
    expect(() => store.saveContract({ ...contract, revision: 2, reason: "no history" })).toThrow(
      ContractRevisionError,
    )
  })

  test("the revision reason is stored with the snapshot", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    store.saveContract(revision(contract, { reason: "tighten the allow-list" }))
    expect(store.revisions(contract.id)[1]?.reason).toBe("tighten the allow-list")
  })
})

describe("BW-055 — criterion lifecycle", () => {
  test("passed cannot be set without a passing observation", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    expect(() => store.setCriterionStatus(contract.id, "inspect.file-exists", "passed")).toThrow(
      /without a passing observation/,
    )
  })

  test("an observation links to the criterion and moves its status", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    const observationId = store.observe("inspect", {
      checkId: "file-exists",
      status: "pass",
      exitCode: 0,
      detail: "test -f src/greeting.ts",
    })
    const row = store.criteria(contract.id).find((entry) => entry.id === "inspect.file-exists")
    expect(row?.status).toBe("passed")
    const evidence = store.criterionEvidence(contract.id, "inspect.file-exists")
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.status).toBe("pass")
    expect(evidence[0]?.exitCode).toBe(0)
    expect(evidence[0]?.observationId).toBe(observationId)
  })

  test("new evidence can overturn a pass, and both observations remain", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    store.observe("inspect", { checkId: "file-exists", status: "pass", exitCode: 0 })
    store.observe("inspect", { checkId: "file-exists", status: "fail", exitCode: 7 })
    const row = store.criteria(contract.id).find((entry) => entry.id === "inspect.file-exists")
    expect(row?.status).toBe("failed")
    expect(store.criterionEvidence(contract.id, "inspect.file-exists")).toHaveLength(2)
  })

  test("dropping a criterion requires a reason and is terminal", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    expect(() => store.setCriterionStatus(contract.id, "inspect.file-exists", "dropped")).toThrow(
      /without a reason/,
    )
    store.setCriterionStatus(contract.id, "inspect.file-exists", "dropped", {
      reason: "no longer in scope",
    })
    expect(() => store.setCriterionStatus(contract.id, "inspect.file-exists", "passed")).toThrow(
      /dropped/,
    )
  })

  test("a status an evidence row cannot support is refused", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    // An `inspect` observation must not mark the `implement` criterion.
    store.observe("inspect", { checkId: "file-exists", status: "pass", exitCode: 0 })
    const implement = store
      .criteria(contract.id)
      .find((entry) => entry.id === "implement.diff-present")
    expect(implement?.status).toBe("pending")
    expect(store.criterionEvidence(contract.id, "implement.diff-present")).toHaveLength(0)
  })
})

describe("BW-055 — the store, not only the CLI, enforces the execution gate", () => {
  test("starting a task under a draft contract is refused", () => {
    const { store, contract } = setup()
    store.transition("inspect", "ready")
    store.saveContract(contract)
    expect(() => store.transition("inspect", "in_progress")).toThrow(ContractGateError)
    // The refusal did not move the task.
    expect(store.taskStatus("inspect")).toBe("ready")
  })

  test("approval unlocks the transition", () => {
    const { store, contract } = setup()
    store.transition("inspect", "ready")
    store.saveContract(contract)
    store.approveContract(contract.id, "Aldrin")
    expect(store.transition("inspect", "in_progress")).toBe("in_progress")
  })

  test("a task the contract does not cover is refused", () => {
    const { store, contract } = setup()
    store.transition("implement", "ready")
    store.saveContract({
      ...contract,
      approval: "approved",
      approvedBy: "Aldrin",
      approvedAt: createdAt,
      criteria: contract.criteria.filter((criterion) => criterion.task === "inspect"),
    })
    expect(() => store.transition("implement", "in_progress")).toThrow(/no criterion/)
  })
})

describe("BW-055 — a criterion cannot disappear when the contract is revised", () => {
  test("removing a criterion marks it dropped and keeps its evidence", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    store.observe("inspect", { checkId: "file-exists", status: "pass", exitCode: 0 })

    // Revision 2 keeps only the implement criterion.
    store.saveContract(
      revision(contract, {
        reason: "drop the inspect criterion; review covers it",
        criteria: [
          criterion({
            id: "implement.diff-present",
            statement: "changed",
            task: "implement",
            check: "diff-present",
          }),
        ],
      }),
    )

    const rows = store.criteria(contract.id)
    expect(rows).toHaveLength(2)
    const dropped = rows.find((row) => row.id === "inspect.file-exists")
    expect(dropped?.status).toBe("dropped")
    expect(dropped?.droppedInRevision).toBe(2)
    expect(dropped?.statusReason).toContain("drop the inspect criterion")
    // The evidence that made it pass is still readable.
    expect(store.criterionEvidence(contract.id, "inspect.file-exists")).toHaveLength(1)

    // Revision 1's snapshot still lists it; revision 2's does not.
    expect(store.revisions(contract.id)[0]?.criteria.map((entry) => entry.id)).toContain(
      "inspect.file-exists",
    )
    expect(store.revisions(contract.id)[1]?.criteria.map((entry) => entry.id)).not.toContain(
      "inspect.file-exists",
    )
  })

  test("an existing criterion cannot be re-pointed at a different check", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    expect(() =>
      store.saveContract(
        revision(contract, {
          reason: "move it",
          criteria: contract.criteria.map((entry) =>
            entry.id === "inspect.file-exists" ? { ...entry, check: "diff-present" } : entry,
          ),
        }),
      ),
    ).toThrow(/cannot change its task\/check/)
  })

  test("a dropped criterion id cannot be re-added", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    store.saveContract(
      revision(contract, {
        criteria: [
          criterion({ id: "implement.diff-present", task: "implement", check: "diff-present" }),
        ],
      }),
    )
    const current = store.contract(contract.id)!
    expect(() =>
      store.saveContract(
        revision(current, {
          reason: "put it back",
          criteria: [...contract.criteria],
        }),
      ),
    ).toThrow(/cannot be re-added/)
  })

  test("later observations do not resurrect a dropped criterion", () => {
    const { store, contract } = setup()
    store.saveContract(contract)
    store.saveContract(
      revision(contract, {
        criteria: [
          criterion({ id: "implement.diff-present", task: "implement", check: "diff-present" }),
        ],
      }),
    )
    store.observe("inspect", { checkId: "file-exists", status: "pass", exitCode: 0 })
    const row = store.criteria(contract.id).find((entry) => entry.id === "inspect.file-exists")
    expect(row?.status).toBe("dropped")
    expect(store.criterionEvidence(contract.id, "inspect.file-exists")).toHaveLength(0)
  })
})
