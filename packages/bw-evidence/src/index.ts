/**
 * Bashwink evidence plugin — the OpenCode integration surface.
 *
 * This module is the only file that imports `@opencode/plugin`. Keeping the import at
 * one edge means the recorder itself stays testable with no OpenCode install, and a
 * change to the upstream plugin contract has exactly one place to be adapted.
 *
 * Verified against OpenCode v2.3.2 (`packages/plugin/src/promise/tool.ts`):
 *   tool.hook("execute.before", e => ...)  // mutable input, may throw Tool.Error to deny
 *   tool.hook("execute.after",  e => ...)  // status completed|error, id/tool/sessionID
 */

import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import path from "node:path"
import { EvidenceRecorder, onToolAfter, onToolBefore, verify } from "./recorder.js"

export interface EvidencePluginOptions {
  /** Where to write `evidence.jsonl`. Default: `<cwd>/.bashwink/evidence`. */
  readonly directory?: string
  /** Character cap for verbatim payloads. Default 2000. */
  readonly maxText?: number
  /** Log every hook firing to stderr; useful when validating the seam. */
  readonly debug?: boolean
  /**
   * File holding the task id currently being worked on (BW-016).
   *
   * Read on every tool call rather than captured at setup: the CLI changes the active task
   * while the plugin is already loaded, and the background service keeps the plugin alive
   * across tasks. A value read once at setup would silently attribute every later call to the
   * first task — worse than leaving them unassigned.
   */
  readonly activeTaskFile?: string
}

function directory(options: EvidencePluginOptions, cwd?: string): string {
  if (options.directory) return options.directory
  const fromEnv = process.env["BASHWINK_EVIDENCE_DIR"]
  if (fromEnv) return fromEnv
  // `process.cwd()` is the server's directory, which is the user's home when the
  // background service started there — not the project being worked on. The plugin
  // context carries the real project directory, so prefer it.
  return `${cwd ?? process.cwd()}/.bashwink/evidence`
}

/**
 * Read the active task id, if any.
 *
 * Returns `undefined` on absence *and* on a corrupt file: an unreadable task file must
 * produce unassigned evidence, never a guessed attribution.
 */
function activeTask(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  try {
    const value = readFileSync(file, "utf8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

/** Default location of the active-task marker, next to the evidence log. */
function activeTaskFileOf(options: EvidencePluginOptions, evidenceDir: string): string {
  return options.activeTaskFile ?? path.join(evidenceDir, "..", "active-task")
}

/**
 * Create the plugin value.
 *
 * Exported separately from the default export so tests can build a plugin against an
 * explicit directory without mutating the process environment.
 */
export function create(options: EvidencePluginOptions = {}) {
  return Plugin.define({
    id: "bashwink-evidence",
    async setup(ctx) {
      const recorder = new EvidenceRecorder({
        directory: directory(options, ctx.location?.directory),
        ...(options.maxText === undefined ? {} : { maxText: options.maxText }),
      })
      const log = (message: string) => {
        if (options.debug) console.error(`[bashwink-evidence] ${message}`)
      }
      log(`recording to ${recorder.file}`)
      const taskFile = activeTaskFileOf(options, recorder.file.replace(/\/[^/]+$/, ""))

      // `execute.before` runs before the tool body; the event is mutable, so a policy
      // plugin could deny here by throwing. The recorder never mutates tool input.
      await ctx.tool.hook("execute.before", (event) => {
        try {
          const taskID = activeTask(taskFile)
          const entry = onToolBefore(recorder, {
            id: event.id,
            tool: event.tool,
            sessionID: event.sessionID,
            input: event.input,
            ...(taskID === undefined ? {} : { taskID }),
          })
          log(`before #${entry.seq} ${event.tool} (${event.id})`)
        } catch (error) {
          // Evidence collection must never break the agent's actual work.
          log(`before hook failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

      await ctx.tool.hook("execute.after", (event) => {
        try {
          const taskID = activeTask(taskFile)
          const entry = onToolAfter(recorder, {
            id: event.id,
            tool: event.tool,
            sessionID: event.sessionID,
            ...(event.agent === undefined ? {} : { agent: event.agent }),
            ...(event.messageID === undefined ? {} : { messageID: event.messageID }),
            ...(taskID === undefined ? {} : { taskID }),
            input: event.input,
            status: event.status,
            ...(event.status === "completed"
              ? { output: event.result?.output }
              : event.error === undefined
                ? {}
                : { error: event.error }),
          })
          log(`after #${entry.seq} ${event.tool} -> ${event.status}`)
        } catch (error) {
          log(`after hook failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    },
  })
}

/** Default export, picked up when OpenCode loads the package as a plugin. */
export default create()

export { EvidenceRecorder, verify }
export * from "./recorder.js"
