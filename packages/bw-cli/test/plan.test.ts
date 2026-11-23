import { describe, expect, test } from "bun:test"
import {
  dependenciesSatisfied,
  findCycle,
  validatePlan,
  type Plan,
  type PlanTask,
} from "../src/plan.js"

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `task ${id}`,
  status: "pending",
  ...extra,
})

const plan = (tasks: PlanTask[], extra: Partial<Plan> = {}): Plan => ({
  v: 1,
  id: "plan_0123456789ab",
  objective: "do the thing",
  files: ["src/a.ts"],
  tasks,
  approval: "draft",
  risks: [],
  createdAt: "2026-11-23T00:00:00.000Z",
  ...extra,
})

describe("plan validation", () => {
  test("a well-formed plan validates", () => {
    const result = validatePlan(
      plan([task("inspect"), task("implement", { dependsOn: ["inspect"] })]),
    )
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  test("a non-object is refused without throwing", () => {
    for (const value of [null, 42, "plan", [1, 2, 3]]) {
      const result = validatePlan(value)
      expect(result.ok).toBe(false)
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })

  test("the schema version is enforced, not assumed", () => {
    const result = validatePlan({ ...plan([task("a")]), v: 2 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "v")).toBe(true)
  })

  test("an empty task list is refused", () => {
    const result = validatePlan(plan([]))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "tasks")).toBe(true)
  })

  test("duplicate task ids are refused", () => {
    const result = validatePlan(plan([task("inspect"), task("inspect")]))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes("duplicate"))).toBe(true)
  })

  test("a self-dependency is refused", () => {
    const result = validatePlan(plan([task("inspect", { dependsOn: ["inspect"] })]))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes("depend on itself"))).toBe(true)
  })

  test("an unresolved dependency is refused", () => {
    const result = validatePlan(plan([task("implement", { dependsOn: ["ghost"] })]))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes("unknown task 'ghost'"))).toBe(true)
  })

  test("a dependency cycle is refused, and named", () => {
    const result = validatePlan(
      plan([
        task("a", { dependsOn: ["b"] }),
        task("b", { dependsOn: ["c"] }),
        task("c", { dependsOn: ["a"] }),
      ]),
    )
    expect(result.ok).toBe(false)
    const issue = result.issues.find((candidate) => candidate.message.includes("cycle"))
    expect(issue).toBeDefined()
    expect(issue?.message).toContain("a")
  })

  test("an approved plan must record who and when", () => {
    // "approved" with no approver is a label, not an approval.
    const bare = validatePlan(plan([task("aa")], { approval: "approved" }))
    expect(bare.ok).toBe(false)
    expect(bare.issues.some((issue) => issue.path === "approvedBy")).toBe(true)
    expect(bare.issues.some((issue) => issue.path === "approvedAt")).toBe(true)

    const complete = validatePlan(
      plan([task("aa")], {
        approval: "approved",
        approvedBy: "aldrin",
        approvedAt: "2026-11-23T00:00:00.000Z",
      }),
    )
    expect(complete.issues).toEqual([])
    expect(complete.ok).toBe(true)
  })

  test("a one-character task id is refused", () => {
    // Finder shorthand is common in practice ("task a"), and a single character is too
    // easy to collide or misread in a log.
    const result = validatePlan(plan([task("a")]))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === "tasks[0].id")).toBe(true)
  })

  test("a skipped or failed task must say why", () => {
    const result = validatePlan(
      plan([task("a", { status: "skipped" }), task("b", { status: "failed" })]),
    )
    expect(result.ok).toBe(false)
    expect(result.issues.filter((issue) => issue.path.endsWith(".note"))).toHaveLength(2)
  })

  test("absolute and upward-traversing file paths are refused", () => {
    const absolute = validatePlan(plan([task("a")], { files: ["/etc/passwd"] }))
    expect(absolute.ok).toBe(false)
    const upward = validatePlan(plan([task("a")], { files: ["../../secrets.env"] }))
    expect(upward.ok).toBe(false)
  })

  test("a check must have an id, a description and an integer exit code", () => {
    const bad = validatePlan(
      plan([task("a", { checks: [{ id: "", description: "", expectExit: 1.5 }] })]),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.length).toBeGreaterThanOrEqual(3)
  })

  test("all problems are reported, not just the first", () => {
    // A plan read from disk should be fixed in one pass, so validation accumulates.
    const result = validatePlan({
      v: 2,
      id: "nope",
      objective: "",
      createdAt: "not a date",
      approval: "maybe",
      files: "not-an-array",
      risks: [],
      tasks: [{ id: "!", title: "", status: "unknown" }],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.length).toBeGreaterThanOrEqual(6)
  })
})

describe("dependency graph", () => {
  test("a linear chain is not a cycle", () => {
    expect(findCycle([task("a"), task("b", { dependsOn: ["a"] })])).toBeUndefined()
  })

  test("a two-node cycle is found", () => {
    const cycle = findCycle([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })])
    expect(cycle).toBeDefined()
    expect(cycle).toContain("a")
    expect(cycle).toContain("b")
  })

  test("a diamond is not a cycle", () => {
    const diamond = [
      task("root"),
      task("left", { dependsOn: ["root"] }),
      task("right", { dependsOn: ["root"] }),
      task("join", { dependsOn: ["left", "right"] }),
    ]
    expect(findCycle(diamond)).toBeUndefined()
  })

  test("dependencies are satisfied only by verified or skipped", () => {
    const tasks = [task("a", { status: "implemented" }), task("b", { dependsOn: ["a"] })]
    expect(dependenciesSatisfied(tasks[1] as PlanTask, tasks)).toBe(false)

    const verified = [task("a", { status: "verified" }), task("b", { dependsOn: ["a"] })]
    expect(dependenciesSatisfied(verified[1] as PlanTask, verified)).toBe(true)

    // A deliberately out-of-scope dependency must not block its dependents forever.
    const skipped = [task("a", { status: "skipped" }), task("b", { dependsOn: ["a"] })]
    expect(dependenciesSatisfied(skipped[1] as PlanTask, skipped)).toBe(true)
  })

  test("a missing dependency is unsatisfied, not ignored", () => {
    const tasks = [task("b", { dependsOn: ["ghost"] })]
    expect(dependenciesSatisfied(tasks[0] as PlanTask, tasks)).toBe(false)
  })

  test("a task with no dependencies is satisfied", () => {
    const tasks = [task("a")]
    expect(dependenciesSatisfied(tasks[0] as PlanTask, tasks)).toBe(true)
  })
})
