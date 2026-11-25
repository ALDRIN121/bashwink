/**
 * Core plain TypeScript data types for standalone Bashwink.
 *
 * Intentionally contains zero terminal, HTTP, or OpenCode runtime imports so a future chat
 * interface or opt-in memory engine can share this exact task/event/context contract.
 */

export type CredentialConfig =
  | { readonly kind: "none" }
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "file"; readonly path: string }

export interface ModelPrice {
  readonly inputUsdPer1M: number
  readonly outputUsdPer1M: number
}

export interface StandaloneConfig {
  readonly version: 1
  readonly endpointType: "local" | "hosted"
  readonly baseURL: string
  readonly model: string
  readonly credential: CredentialConfig
  readonly updatedAt: string
  readonly price?: ModelPrice
}

export interface SystemMessage {
  readonly role: "system"
  readonly content: string
}

export interface UserMessage {
  readonly role: "user"
  readonly content: string
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly rawArguments?: string
  readonly providerExecuted?: boolean
}

export interface ToolInputError {
  readonly id: string
  readonly name: string
  readonly raw: string
}

export interface AssistantMessage {
  readonly role: "assistant"
  readonly content: string
  readonly toolCalls?: readonly ToolCall[]
}

export interface ToolMessage {
  readonly role: "tool"
  readonly callId: string
  readonly name: string
  readonly content: string
  readonly isError?: boolean
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown"

export interface ProviderCompletion {
  readonly text: string
  readonly toolCalls: readonly ToolCall[]
  readonly toolInputErrors: readonly ToolInputError[]
  readonly finishReason: FinishReason
  readonly usage?: ModelUsage
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface ToolDispatchResult {
  readonly callId: string
  readonly tool: string
  readonly status: "ok" | "error" | "denied"
  readonly output: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly changedFile?: string
}

export interface WorkspaceContextChunk {
  readonly source: string
  readonly workspace: string
  readonly content: string
  readonly untrusted: true
}

export interface RunActionRecord {
  readonly callId: string
  readonly tool: string
  readonly summary: string
  readonly decision: "allow" | "approve" | "deny" | "error"
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly target?: string
}

export interface CommandOutcomeRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly decision: "approved" | "denied"
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
}

export interface RunSummaryRecord {
  readonly version: 1
  readonly runId: string
  readonly startedAt: string
  readonly endedAt: string
  readonly workspace: string
  readonly trusted: boolean
  readonly endpoint: string
  readonly model: string
  readonly prompt: string
  readonly outcome: "completed" | "failed" | "cancelled" | "uncertain" | "budget_stopped"
  readonly stopReason?: string
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly actions: readonly RunActionRecord[]
  readonly requests: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
    readonly costUsd?: number
  }
  readonly evidenceFile: string
}

/**
 * Optional workspace-scoped context provider (future memory engine integration point).
 * Returned chunks remain untrusted input and never override local approval/scope rules.
 */
export interface ContextProvider {
  getWorkspaceContext(
    workspace: string,
    taskPrompt: string,
  ): Promise<readonly WorkspaceContextChunk[]>
  recordCompletion?(record: RunSummaryRecord): Promise<void>
}

export interface TaskBudgets {
  readonly maxRequests: number
  readonly maxOutputTokens?: number
  readonly maxCostUsd?: number
  readonly commandTimeoutMs: number
  readonly repeatedFailureLimit: number
}

export type TaskEvent =
  | { readonly type: "task_started"; readonly runId: string; readonly workspace: string }
  | { readonly type: "turn_started"; readonly step: number; readonly maxRequests: number }
  | { readonly type: "model_requested"; readonly step: number; readonly model: string; readonly endpoint: string }
  | { readonly type: "model_responded"; readonly step: number; readonly finishReason: FinishReason; readonly usage?: ModelUsage }
  | { readonly type: "tool_proposed"; readonly callId: string; readonly tool: string; readonly summary: string; readonly preview?: string }
  | { readonly type: "tool_approved"; readonly callId: string; readonly tool: string }
  | { readonly type: "tool_denied"; readonly callId: string; readonly tool: string; readonly reason: string }
  | { readonly type: "tool_completed"; readonly result: ToolDispatchResult }
  | { readonly type: "assistant_text"; readonly text: string }
  | { readonly type: "task_finished"; readonly result: TaskResult }

export interface TaskInput {
  readonly workspace: string
  readonly prompt: string
  readonly trusted: boolean
  readonly config: StandaloneConfig
  readonly budgets?: Partial<TaskBudgets>
  readonly signal?: AbortSignal
}

export interface TaskResult {
  readonly runId: string
  readonly outcome: RunSummaryRecord["outcome"]
  readonly finalText: string
  readonly stopReason?: string
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly requests: number
  readonly usage: RunSummaryRecord["usage"]
  readonly evidenceFile: string
  readonly runRecordFile: string
}
