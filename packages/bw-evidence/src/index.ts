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
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { EvidenceRecorder, onToolAfter, onToolBefore, verify, type ModelRef } from "./recorder.js"
import {
  evaluate,
  parseLaunchPolicy,
  parsePolicy,
  physicalPath,
  type ScopePolicy,
} from "./scope.js"
import { acknowledge, readLease } from "./readiness.js"

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
 * Read the scope policy the wrapper staged before this run.
 *
 * Read once at setup: the policy describes the task the run was started for, and re-reading it
 * per call would let a mid-run file write change the fence. A policy that fails to parse is
 * treated as **enforcing with no paths**, i.e. everything refused — a malformed fence must fail
 * closed, never open.
 */
function scopePolicyOf(evidenceDir: string): ScopePolicy | undefined {
  const required = process.env["BASHWINK_SCOPE_FILE"]
  const file = required ?? path.join(evidenceDir, "..", "scope.json")
  const denyAll: ScopePolicy = {
    mode: "enforce",
    allowedPaths: [],
    readPaths: [],
    allowShell: false,
  }
  try {
    if (required === undefined && !existsSync(file)) return undefined
    const document: unknown = JSON.parse(readFileSync(file, "utf8"))
    const parser = required === undefined ? parsePolicy : parseLaunchPolicy
    return parser(document) ?? denyAll
  } catch {
    return denyAll
  }
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
      const lease = readLease()
      if (lease === undefined && process.env["BASHWINK_EVIDENCE_EXPECTED"] === "0") return
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

      // --- BW-059 ScopeFence -------------------------------------------------
      //
      // Registered *after* the evidence hook on purpose. Upstream runs hooks in registration
      // order, so the attempt is recorded before it is refused — a denial that leaves no trace
      // is indistinguishable from a tool the model never asked for.
      //
      // Throwing here is the enforcement: `execute.before` is the one tool hook whose failure
      // rejects the call before the tool body runs (packages/core/src/plugin/hooks.ts).
      const policy = scopePolicyOf(path.dirname(recorder.file))
      if (
        lease !== undefined &&
        (policy?.mode !== "enforce" || policy.workspace !== lease.workspace)
      )
        throw new Error("missing or malformed Bashwink execution policy")
      if (policy !== undefined && policy.mode === "enforce") {
        log(`scope fence active: ${policy.allowedPaths.join(",") || "(no paths)"}`)
        if (policy.workspace !== undefined) {
          await ctx.permission.hook("evaluate", (event) => {
            if (event.effect === "deny") return
            if (event.action === "shell" || event.action === "edit") event.effect = "ask"
          })
        }
        const scopeFile = process.env["BASHWINK_SCOPE_FILE"]
        if (scopeFile !== undefined) {
          // The direct TUI shell action does not go through the model tool hook. This
          // upstream hook can amend the invocation but has no refusal error channel.
          await ctx.shell.hook("create.before", (invocation) => {
            const verdict = evaluate(policy, {
              tool: "shell",
              input: { command: invocation.command, workdir: invocation.cwd },
              cwd: ctx.location?.directory ?? process.cwd(),
            })
            if (verdict.allow) return
            invocation.command = ""
            invocation.env = {}
            invocation.shell = path.join(scopeFile, "shell-disabled")
            try {
              recorder.record(
                "denied",
                { id: crypto.randomUUID(), tool: "shell", sessionID: "" },
                { status: "error", note: `DENIED shell launch: ${verdict.reason}` },
              )
            } catch {
              // A recording failure must not restore the original shell launch.
            }
          })
        }
        await ctx.tool.hook("execute.before", (event) => {
          let verdict
          try {
            verdict = evaluate(policy, {
              tool: event.tool,
              input: event.input,
              cwd: ctx.location?.directory ?? process.cwd(),
            })
          } catch (error) {
            // A policy that cannot evaluate must not silently allow the call.
            log(
              `scope evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            )
            throw new Error(
              "bashwink scope fence: the policy could not be evaluated; refusing the call",
            )
          }
          if (verdict.allow) {
            if (verdict.unconstrained === true)
              // A separate phase, not `denied`: this call ran. Conflating "was refused" with
              // "ran without a path bound" would make the denial count meaningless.
              recorder.record(
                "unconstrained",
                { id: `${event.id}_unconstrained`, tool: event.tool, sessionID: event.sessionID },
                { status: "completed", note: verdict.note ?? "shell command is not path-bounded" },
              )
            return
          }
          try {
            recorder.record(
              "denied",
              { id: event.id, tool: event.tool, sessionID: event.sessionID },
              { status: "error", note: `DENIED ${verdict.reason}` },
            )
          } catch (error) {
            log(
              `could not record denial: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          throw new Error(`bashwink scope fence: ${verdict.reason}`)
        })
      }

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

      // Attribute every call to the model that actually served it.
      //
      // The wrapper knows which model it *asked* for; only the runtime knows which one
      // served a step, and the two differ whenever a session switches models. So the plugin
      // listens to the runtime's own events and keeps a per-session map. A failure here must
      // never break the agent: attribution is best-effort, and an unattributed call is
      // recorded as such rather than guessed.
      const current = new Map<string, ModelRef>()
      const noteModel = (sessionID: string, model: ModelRef, source: string) => {
        const previous = current.get(sessionID)
        const changed =
          previous === undefined ||
          previous.id !== model.id ||
          previous.providerID !== model.providerID
        current.set(sessionID, model)
        const changedNow = recorder.setModel(sessionID, model)
        if (changed && changedNow)
          recorder.recordModel({
            sessionID,
            model,
            source,
            ...(previous === undefined ? {} : { previous }),
          })
        log(`model ${sessionID} ${model.providerID}/${model.id} (${source})`)
      }
      void (async () => {
        try {
          const events = ctx.event?.subscribe?.()
          if (events === undefined) return
          for await (const event of events) {
            try {
              const data = event.data as
                | {
                    sessionID?: string
                    model?: { id?: string; providerID?: string; variant?: string }
                  }
                | undefined
              if (data?.sessionID === undefined || data.model?.id === undefined) continue
              if (data.model.providerID === undefined) continue
              const model: ModelRef = {
                id: data.model.id,
                providerID: data.model.providerID,
                ...(data.model.variant === undefined ? {} : { variant: data.model.variant }),
              }
              if (event.type === "session.step.started") noteModel(data.sessionID, model, "step")
              else if (event.type === "session.model.selected")
                noteModel(data.sessionID, model, "switch")
            } catch (error) {
              log(
                `event handling failed: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
        } catch (error) {
          // A runtime without a subscribe surface, or a closed stream, is not a failure of
          // the run: the log simply carries no model attribution.
          log(
            `event subscription unavailable: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })()

      // Only now is the plugin actually usable. The wrapper looks for this entry by run id
      // and fails the run loudly when it is absent, so a load failure cannot masquerade as a
      // session that simply called no tools.
      const boot = recorder.recordBoot({
        plugin: "bashwink-evidence",
        pid: process.pid,
        cwd: process.cwd(),
        ...(process.env["BASHWINK_RUN_ID"] === undefined
          ? {}
          : { runID: process.env["BASHWINK_RUN_ID"] }),
        ...(ctx.location?.directory === undefined ? {} : { location: ctx.location.directory }),
      })
      log(`boot #${boot.seq}; hooks registered`)
      if (
        lease !== undefined &&
        ctx.location?.directory !== undefined &&
        physicalPath(ctx.location.directory) === lease.workspace
      )
        return acknowledge(lease)
    },
  })
}

/** Default export, picked up when OpenCode loads the package as a plugin. */
export default create()

export { EvidenceRecorder, verify }
export * from "./recorder.js"
export { physicalPath, type ScopePolicy } from "./scope.js"
