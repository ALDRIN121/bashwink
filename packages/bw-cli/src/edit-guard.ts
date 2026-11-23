/**
 * The edit gate (BW-011).
 *
 * The acceptance criterion is behavioural: *"build agent can edit and plan agent cannot make
 * ordinary file edits"*. That property has to hold in runtime code, not in a prompt, so every
 * editing path in Bashwink calls `assertEditable()` first.
 *
 * A planning agent has no route to a write that does not pass through a human approval,
 * because a plan in `draft` or `rejected` state throws here. `rejected` is refused for the
 * same reason as `draft`: the human said no, which is not the same as being undecided.
 */

export class NotApprovedError extends Error {
  readonly code = "not_approved"
  constructor(objective: string) {
    super(`plan '${objective}' is not approved; editing is blocked until a human approves it`)
    this.name = "NotApprovedError"
  }
}

export interface EditablePlan {
  readonly approval: "draft" | "approved" | "rejected"
  readonly objective: string
}

/** The single gate every editing path must call. */
export function assertEditable(plan: EditablePlan): void {
  if (plan.approval !== "approved") throw new NotApprovedError(plan.objective)
}

/** True when edits are permitted, for callers that want to branch instead of throw. */
export function isEditable(plan: EditablePlan): boolean {
  return plan.approval === "approved"
}
