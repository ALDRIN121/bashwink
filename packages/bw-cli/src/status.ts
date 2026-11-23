/**
 * Task and plan state machine.
 *
 * A plan is a set of tasks with declared dependencies; a task moves through a fixed set of
 * states. The point of this module is that an *invalid* transition is rejected loudly rather
 * than quietly recorded, because the whole product claim is "exact evidence, not model
 * claims" — a task that goes from `pending` straight to `verified` without observations is a
 * fabricated result, and the data model is the only place that can refuse it.
 *
 * Designed to be storage-agnostic: `store.ts` persists these, `plan.ts` renders them, and
 * this file has no I/O at all so the rules can be tested exhaustively and cheaply.
 */

/** State of a single task. Ordered roughly by lifecycle, not by enum value. */
export type TaskStatus =
  /** Declared, dependencies not yet satisfied. */
  | "pending"
  /** Dependencies satisfied, eligible to run. */
  | "ready"
  /** An agent is actively working on it. */
  | "in_progress"
  /** Work finished; the declared checks have NOT yet been run. */
  | "implemented"
  /** Every declared check ran and passed, with recorded evidence. */
  | "verified"
  /** A check ran and failed. Evidence of the failure is the point of the state. */
  | "failed"
  /** Deliberately not attempted (out of scope, superseded, blocked by a human decision). */
  | "skipped"
  /** Was in progress when the process died; outcome genuinely unknown. */
  | "interrupted"

/**
 * Allowed transitions, as a total map so a missing status is a type error rather than a
 * silent "no transitions defined".
 *
 * The deliberate omissions are the interesting part:
 *   - `pending -> verified` is forbidden. Nothing can be verified before it is implemented;
 *     a shortcut here is exactly how a demo becomes a fabricated success.
 *   - `implemented -> verified` is the ONLY route into `verified`, and the store requires a
 *     passed check observation for every declared check before it will accept it.
 *   - `verified` is terminal, so a later failure has to be a new task rather than rewriting
 *     history. Evidence that a task passed should not be editable in place.
 *   - `interrupted` can go to `ready` or `in_progress` (resume) or `failed` (abandon), but
 *     never directly to `verified`: a process that died cannot have observed a check pass.
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "skipped"],
  ready: ["in_progress", "skipped"],
  in_progress: ["implemented", "failed", "interrupted", "skipped"],
  implemented: ["verified", "failed", "interrupted"],
  verified: [],
  failed: ["ready", "in_progress", "skipped"],
  skipped: ["ready"],
  interrupted: ["ready", "in_progress", "failed", "skipped"],
}

/** Statuses from which no further transition is possible. */
export const TERMINAL: readonly TaskStatus[] = ["verified"]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && Object.hasOwn(TRANSITIONS, value)
}

export interface TransitionCheck {
  readonly ok: boolean
  readonly reason?: string
}

/**
 * Decide whether `from -> to` is legal.
 *
 * Returns a reason on refusal so callers (CLI, MCP tools, an agent) can tell the user what
 * happened instead of a bare boolean.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): TransitionCheck {
  if (!isTaskStatus(from)) return { ok: false, reason: `unknown current status '${from}'` }
  if (!isTaskStatus(to)) return { ok: false, reason: `unknown target status '${to}'` }
  if (from === to) return { ok: false, reason: `task is already '${from}'` }
  const allowed = TRANSITIONS[from]
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason:
        allowed.length === 0
          ? `'${from}' is terminal; no transition to '${to}' is possible`
          : `illegal transition '${from}' -> '${to}'; allowed: ${allowed.join(", ")}`,
    }
  }
  return { ok: true }
}

/** Thrown by `assertTransition` so a caller cannot ignore the refusal by dropping a boolean. */
export class InvalidTransitionError extends Error {
  readonly code = "invalid_transition"
  readonly from: TaskStatus
  readonly to: TaskStatus

  constructor(from: TaskStatus, to: TaskStatus, reason: string) {
    super(`${reason}: ${from} -> ${to}`)
    this.name = "InvalidTransitionError"
    this.from = from
    this.to = to
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const check = canTransition(from, to)
  if (!check.ok) throw new InvalidTransitionError(from, to, check.reason ?? "illegal transition")
}
