import { describe, expect, test } from "bun:test"
import {
  InvalidTransitionError,
  TERMINAL,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isTaskStatus,
  type TaskStatus,
} from "../src/status.js"

const ALL: TaskStatus[] = [
  "pending",
  "ready",
  "in_progress",
  "implemented",
  "verified",
  "failed",
  "skipped",
  "interrupted",
]

describe("status", () => {
  test("every status has a transition entry", () => {
    // A missing entry would make `TRANSITIONS[from].includes` throw at runtime, so the map is
    // total by construction and this asserts it stays that way.
    for (const status of ALL) expect(TRANSITIONS[status]).toBeDefined()
  })

  test("pending cannot jump to verified", () => {
    // The single most important refusal in the model: a task cannot be claimed as proven
    // before it has been implemented.
    const check = canTransition("pending", "verified")
    expect(check.ok).toBe(false)
    expect(check.reason).toContain("illegal transition")
  })

  test("pending cannot jump to implemented either", () => {
    expect(canTransition("pending", "implemented").ok).toBe(false)
  })

  test("the only route into verified is from implemented", () => {
    const sources = ALL.filter((status) => TRANSITIONS[status].includes("verified"))
    expect(sources).toEqual(["implemented"])
  })

  test("verified is terminal", () => {
    expect(TRANSITIONS.verified).toEqual([])
    expect(TERMINAL).toEqual(["verified"])
    for (const status of ALL) {
      const check = canTransition("verified", status)
      expect(check.ok).toBe(false)
      // A self-transition is refused as a no-op before the terminal rule applies, so accept
      // either reason; both mean the status cannot move.
      if (status === "verified") expect(check.reason).toContain("already")
      else expect(check.reason).toContain("terminal")
    }
  })

  test("interrupted can resume but never verify directly", () => {
    expect(canTransition("interrupted", "in_progress").ok).toBe(true)
    expect(canTransition("interrupted", "ready").ok).toBe(true)
    expect(canTransition("interrupted", "failed").ok).toBe(true)
    // A process that died cannot have observed a check pass.
    expect(canTransition("interrupted", "verified").ok).toBe(false)
  })

  test("in_progress cannot verify without being implemented", () => {
    expect(canTransition("in_progress", "verified").ok).toBe(false)
  })

  test("a no-op transition is refused with a readable reason", () => {
    const check = canTransition("ready", "ready")
    expect(check.ok).toBe(false)
    expect(check.reason).toContain("already")
  })

  test("unknown statuses are refused rather than throwing", () => {
    expect(canTransition("nonsense" as TaskStatus, "ready").ok).toBe(false)
    expect(canTransition("ready", "nonsense" as TaskStatus).ok).toBe(false)
    expect(isTaskStatus("ready")).toBe(true)
    expect(isTaskStatus("nonsense")).toBe(false)
    expect(isTaskStatus(undefined)).toBe(false)
  })

  test("assertTransition throws a typed error carrying both statuses", () => {
    expect(() => assertTransition("pending", "verified")).toThrow(InvalidTransitionError)
    try {
      assertTransition("pending", "verified")
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError)
      const typed = error as InvalidTransitionError
      expect(typed.code).toBe("invalid_transition")
      expect(typed.from).toBe("pending")
      expect(typed.to).toBe("verified")
    }
  })

  test("every legal transition is accepted", () => {
    for (const from of ALL)
      for (const to of TRANSITIONS[from]) {
        const check = canTransition(from, to)
        expect(check.ok).toBe(true)
        expect(check.reason).toBeUndefined()
      }
  })

  test("every illegal transition is refused", () => {
    for (const from of ALL)
      for (const to of ALL)
        if (from !== to && !TRANSITIONS[from].includes(to)) {
          const check = canTransition(from, to)
          expect(check.ok).toBe(false)
          expect(typeof check.reason).toBe("string")
        }
  })
})
