/**
 * Minimal ambient types for the OpenCode plugin contract Bashwink depends on.
 *
 * Bashwink does not vendor OpenCode: the plugin is loaded by an external agent binary.
 * These declarations exist so `tsc --noEmit` can check Bashwink's own code on a machine
 * that has no OpenCode install, while still failing if we call the API with the wrong
 * shape.
 *
 * Source of truth: opencode v2.3.2, `packages/plugin/src/promise/tool.ts`
 * (`execute.before` / `execute.after`) and `packages/plugin/src/promise/plugin.ts`.
 *
 * Keep this file intentionally narrow: widening it hides real integration mistakes.
 */

declare module "@opencode/plugin" {
  export interface ToolExecuteBefore {
    readonly id: string
    tool: string
    readonly sessionID: string
    readonly agent?: string
    readonly messageID?: string
    input?: unknown
  }

  export interface ToolExecuteAfter {
    readonly id: string
    readonly tool: string
    readonly sessionID: string
    readonly agent?: string
    readonly messageID?: string
    readonly input?: unknown
    readonly status: "completed" | "error"
    readonly result?: { readonly output?: unknown }
    readonly error?: { readonly message?: string } | string
  }

  export interface ToolDomain {
    hook(
      name: "execute.before",
      callback: (event: ToolExecuteBefore) => void | Promise<void>,
    ): Promise<unknown>
    hook(
      name: "execute.after",
      callback: (event: ToolExecuteAfter) => void | Promise<void>,
    ): Promise<unknown>
  }

  /**
   * One runtime event, as `event.subscribe()` yields it.
   *
   * Only the fields Bashwink reads are declared. Verified against OpenCode v2.3.2 by
   * loading a probe plugin into the real binary and dumping the event stream — the shapes
   * below are observed output, not an inference from the type definitions.
   *
   *   session.step.started      { sessionID, agent, model: { id, providerID, variant } }
   *   session.model.selected    { sessionID, model: { id, providerID, variant }, previous? }
   */
  export interface RuntimeEvent {
    readonly id?: string
    readonly type: string
    readonly data?: {
      readonly sessionID?: string
      readonly model?: {
        readonly id?: string
        readonly providerID?: string
        readonly variant?: string
      }
      readonly previous?: {
        readonly id?: string
        readonly providerID?: string
        readonly variant?: string
      }
    }
  }

  export interface EventDomain {
    subscribe(options?: { readonly types?: readonly string[] }): AsyncIterable<RuntimeEvent>
  }

  export interface PluginContext {
    readonly options?: Readonly<Record<string, unknown>>
    readonly location?: { readonly directory?: string }
    readonly tool: ToolDomain
    readonly shell: {
      hook(
        name: "create.before",
        callback: (event: {
          command: string
          cwd: string
          shell: string
          env: Record<string, string | undefined>
        }) => void,
      ): Promise<unknown>
    }
    readonly permission: {
      hook(
        name: "evaluate",
        callback: (event: { readonly action: string; effect: "allow" | "deny" | "ask" }) => void,
      ): Promise<unknown>
    }
    /**
     * Absent on older runtimes. The recorder treats absence as "no model attribution"
     * rather than failing the run, so the plugin stays loadable across a runtime bump.
     */
    readonly event?: EventDomain
  }

  export interface PluginDefinition {
    readonly id: string
    readonly setup: (context: PluginContext) => void | Promise<void | (() => void | Promise<void>)>
  }

  export const Plugin: {
    define(definition: PluginDefinition): PluginDefinition
  }
}
