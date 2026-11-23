/**
 * Turning the runtime's log into a cause a user can act on.
 *
 * Observed twice while testing the alpha: a previous session (or its orphaned service) holds the
 * managed port, the TUI dies during start-up, and the wrapper reports
 * "evidence plugin did not initialise" — technically true, actively misleading. The real cause
 * is three hundred lines up in the runtime's log.
 *
 * This module reads that log. It invents nothing: every classification below corresponds to a
 * message the pinned 2.3.2 binary actually emitted, and an unmatched log yields `undefined` so
 * the caller keeps its existing, honest "no diagnosis" message.
 */

import { existsSync, readFileSync } from "node:fs"

export type RuntimeFailureKind =
  /** The managed service port is held, usually by an orphan from a killed session. */
  | "service-port-in-use"
  /** A server failed to start for some other reason. */
  | "server-start-failed"

export interface RuntimeFailure {
  readonly kind: RuntimeFailureKind
  /** The runtime's own sentence, verbatim, so the reader can search for it. */
  readonly detail: string
  /** PID holding the port, when the runtime named one. */
  readonly holderPID?: number
  /** What to do about it. */
  readonly advice: string
}

/** How much of the log to read. The failure is near the end; older lines are noise. */
const TAIL_BYTES = 64 * 1024

/**
 * Find the most recent infrastructure failure in a runtime log.
 *
 * Reads the tail only, because these logs grow to megabytes and the interesting failure is the
 * last thing that happened. Returns `undefined` for a log that does not exist or shows no known
 * failure — including a log full of ordinary model errors, which are the agent's business.
 */
export function findRuntimeFailure(logFile: string): RuntimeFailure | undefined {
  if (!existsSync(logFile)) return undefined
  let text: string
  try {
    const buffer = readFileSync(logFile)
    text = buffer.subarray(Math.max(0, buffer.length - TAIL_BYTES)).toString("utf8")
  } catch {
    return undefined
  }

  // `Managed service port <port> on <host> is already in use by PID <pid>`
  //
  // Every match is collected and the last is used: one log holds many runs, and the failure that
  // just happened is the one the reader needs. `String.match` would return the first, which
  // describes a launch from hours ago.
  const ports = [
    ...text.matchAll(/Managed service port (\d+) on \S+ is already in use by PID (\d+)/g),
  ]
  const last = ports.at(-1)
  if (last !== undefined && last[1] !== undefined && last[2] !== undefined)
    return {
      kind: "service-port-in-use",
      detail: `managed service port ${last[1]} is already in use by pid ${last[2]}`,
      holderPID: Number(last[2]),
      advice:
        `a previous session is still holding the runtime's service.\n` +
        `  Exit it (Ctrl-C twice) and launch again, or clear the orphan:\n` +
        `      kill ${last[2]}`,
    }

  // Any other server-start failure, so the reader is not told "evidence missing" when the
  // runtime never got far enough to want evidence.
  if (/Failed to start server|ServeError|Server process exited with code/.test(text)) {
    const line = text
      .split("\n")
      .reverse()
      .find((candidate) =>
        /Failed to start server|ServeError|Server process exited/.test(candidate),
      )
    return {
      kind: "server-start-failed",
      detail: (line ?? "server failed to start").slice(0, 300),
      advice:
        "the runtime's local server could not start. Its log above names the reason;\n" +
        "  a port conflict is the usual one, and `bashwink doctor` reports the runtime it resolved.",
    }
  }

  return undefined
}

/** Render a failure as the explanation of a run. */
export function renderRuntimeFailure(failure: RuntimeFailure): string {
  return [`the runtime could not start: ${failure.detail}`, "", `  ${failure.advice}`].join("\n")
}
