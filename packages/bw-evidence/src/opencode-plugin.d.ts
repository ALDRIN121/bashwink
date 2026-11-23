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

  export interface PluginContext {
    readonly options?: Readonly<Record<string, unknown>>
    readonly location?: { readonly directory?: string }
    readonly tool: ToolDomain
  }

  export interface PluginDefinition {
    readonly id: string
    readonly setup: (context: PluginContext) => void | Promise<void | (() => void | Promise<void>)>
  }

  export const Plugin: {
    define(definition: PluginDefinition): PluginDefinition
  }
}
