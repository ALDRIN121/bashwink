/**
 * BW-055 — TaskContract validation and criterion lifecycle.
 *
 * The acceptance criteria are:
 *   - schema round-trip and invalid transitions tested;
 *   - criterion statuses cannot disappear when contract revisions change.
 *
 * The second is a storage property, so its strongest tests are in `contract-store.test.ts`.
 * This file covers the pure rules: what a contract must say, and which status moves are legal.
 */

import { describe, expect, test } from "bun:test"
import {
  CRITERION_TRANSITIONS,
  ContractInvalidError,
  assertCriterionTransition,
  canChangeCriterion,
  contractId,
  deriveContract,
  validateContract,
  validateForExecution,
  type TaskContract,
} from "../src/contract.js"
import type { Plan } from "../src/plan.js"

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
          {
            id: "file-exists",
            description: "the target file exists",
            command: "test -f src/greeting.ts",
          },
        ],
      },
      {
        id: "implement",
        title: "implement",
        status: "pending",
        dependsOn: ["inspect"],
        files: ["src/greeting.ts"],
        checks: [
          {
            id: "diff-present",
            description: "the tree differs from HEAD",
            command: "! git diff --quiet",
          },
        ],
      },
    ],
  }
}

function derived(): TaskContract {
  return deriveContract(plan(), {
    createdAt,
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
  })
}

describe("BW-055 — the derived contract", () => {
  test("turns every declared check into a required criterion", () => {
    const contract = derived()
    expect(contract.criteria.map((criterion) => criterion.id)).toEqual([
      "inspect.file-exists",
      "implement.diff-present",
    ])
    expect(contract.criteria.every((criterion) => criterion.required)).toBe(true)
    expect(contract.approval).toBe("draft")
    expect(contract.revision).toBe(1)
  })

  test("passes its own validation against the plan", () => {
    expect(validateContract(derived(), plan())).toEqual({ ok: true, issues: [] })
  })

  test("is refused when the plan declares no checks, because nothing could prove it", () => {
    const base = plan()
    const empty: Plan = { ...base, tasks: base.tasks.map((task) => ({ ...task, checks: [] })) }
    expect(() => deriveContract(empty, { createdAt })).toThrow(ContractInvalidError)
  })

  test("ids are deterministic for the same plan, objective and timestamp", () => {
    expect(contractId("plan_1", "do the thing", createdAt)).toBe(
      contractId("plan_1", "do the thing", createdAt),
    )
    expect(contractId("plan_1", "do the thing", createdAt)).not.toBe(
      contractId("plan_1", "do another thing", createdAt),
    )
  })
})

describe("BW-055 — validation refuses contracts that cannot be audited", () => {
  function issuePaths(contract: unknown): string[] {
    return validateContract(contract).issues.map((issue) => issue.path)
  }

  test("an empty objective", () => {
    expect(issuePaths({ ...derived(), objective: "  " })).toContain("objective")
  })

  test("no criteria at all", () => {
    expect(issuePaths({ ...derived(), criteria: [] })).toContain("criteria")
  })

  test("duplicate criterion ids", () => {
    const contract = derived()
    const criteria = [...contract.criteria, { ...contract.criteria[0]! }]
    expect(issuePaths({ ...contract, criteria })).toContain("criteria[2].id")
  })

  test("a criterion that cites a task or check the plan does not declare", () => {
    const contract = derived()
    const criteria = [{ ...contract.criteria[0]!, check: "not-a-real-check" }]
    const result = validateContract({ ...contract, criteria }, plan())
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.path).toBe("criteria[0].check")
  })

  test("absolute and escaping paths", () => {
    expect(issuePaths({ ...derived(), allowedPaths: ["/etc/passwd"] })).toContain("allowedPaths[0]")
    expect(issuePaths({ ...derived(), allowedPaths: ["../outside"] })).toContain("allowedPaths[0]")
    expect(issuePaths({ ...derived(), allowedPaths: ["src\\greeting.ts"] })).toContain(
      "allowedPaths[0]",
    )
    // A Windows drive is absolute even with forward slashes, and would escape the workspace there.
    for (const drive of ["C:/Windows/system.ini", "d:/other", "C:"])
      expect(issuePaths({ ...derived(), allowedPaths: [drive] })).toContain("allowedPaths[0]")
  })

  test("the same path allowed and forbidden", () => {
    const contract = derived()
    const result = validateContract({
      ...contract,
      allowedPaths: ["src/greeting.ts"],
      forbiddenPaths: ["src/greeting.ts"],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "forbiddenPaths")).toBe(true)
  })

  test("a command that is both allowed and forbidden", () => {
    const contract = derived()
    const result = validateContract({
      ...contract,
      constraints: { allowedCommands: ["git"], forbiddenCommands: ["git"] },
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "constraints.forbiddenCommands")).toBe(true)
  })

  test("approval without an approver or timestamp", () => {
    const contract = derived()
    expect(issuePaths({ ...contract, approval: "approved" })).toContain("approvedBy")
  })

  test("a revision after the first must state why", () => {
    expect(issuePaths({ ...derived(), revision: 2 })).toContain("reason")
  })

  test("a malformed base commit", () => {
    expect(issuePaths({ ...derived(), baseCommit: "HEAD" })).toContain("baseCommit")
  })
})

describe("BW-055 — criterion transitions", () => {
  test("the matrix is total and every status is represented", () => {
    expect(Object.keys(CRITERION_TRANSITIONS).sort()).toEqual(
      ["dropped", "failed", "not_run", "passed", "pending"].sort(),
    )
  })

  test("dropped is terminal", () => {
    for (const to of Object.keys(CRITERION_TRANSITIONS) as (keyof typeof CRITERION_TRANSITIONS)[])
      expect(canChangeCriterion("dropped", to)).toBe(false)
  })

  test("passed cannot silently return to pending", () => {
    expect(canChangeCriterion("passed", "pending")).toBe(false)
    expect(() => assertCriterionTransition("passed", "pending")).toThrow()
  })

  test("new evidence can overturn a pass", () => {
    expect(canChangeCriterion("passed", "failed")).toBe(true)
  })

  test("an illegal transition names both ends", () => {
    try {
      assertCriterionTransition("dropped", "passed")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as Error).message).toContain("dropped")
      expect((error as Error).message).toContain("passed")
    }
  })
})

describe("BW-055 — validation before execution", () => {
  test("a draft contract cannot start work", () => {
    const result = validateForExecution(derived(), plan(), "inspect")
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "approval")).toBe(true)
  })

  test("an approved contract covering the task can start work", () => {
    const contract: TaskContract = {
      ...derived(),
      approval: "approved",
      approvedBy: "Aldrin",
      approvedAt: createdAt,
    }
    expect(validateForExecution(contract, plan(), "inspect")).toEqual({ ok: true, issues: [] })
  })

  test("a task the contract does not cover cannot start", () => {
    const base = derived()
    const contract: TaskContract = {
      ...base,
      approval: "approved",
      approvedBy: "Aldrin",
      approvedAt: createdAt,
      criteria: base.criteria.filter((criterion) => criterion.task === "inspect"),
    }
    const result = validateForExecution(contract, plan(), "implement")
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes("no criterion covers"))).toBe(true)
  })
})
