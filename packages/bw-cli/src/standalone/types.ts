import type { TaskContract } from "../contract.ts"
export type { TaskContract }

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

export type WireProtocol = "openai-chat" | "anthropic-messages"

export interface ModelPrice {
  readonly inputUsdPer1M: number
  readonly outputUsdPer1M: number
}

export interface StandaloneConfig {
  readonly version: 1
  readonly providerId?: string
  readonly endpointType: "local" | "hosted"
  readonly wireProtocol?: WireProtocol
  readonly baseURL: string
  readonly model: string
  readonly credential: CredentialConfig
  readonly headers?: Readonly<Record<string, string>>
  readonly updatedAt: string
  readonly price?: ModelPrice
  readonly connectionStatus?: "unverified" | "verified" | "failed"
  readonly lastVerifiedAt?: string
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
  readonly usageInvalid?: boolean
  readonly usageIncomplete?: boolean
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
  readonly target?: string
  readonly patch?: string
  readonly create?: boolean
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly changedFile?: string
  readonly durationMs?: number
  readonly timedOut?: boolean
}

export type UntrustedTrustZone =
  "workspace_doc" | "tool_output" | "context_provider" | "git_history"

export type ClaimStatus =
  "verified" | "done_unverified" | "inconclusive" | "failed" | "cancelled" | "budget_stopped"

export type ProofCheckStatus = "passed" | "failed" | "not_run"

export interface WorkspaceBaseline {
  readonly capturedAt: string
  readonly gitHead: string | null
  readonly gitBranch: string | null
  readonly dirtyFiles: readonly string[]
  readonly protectedTestHashes: Readonly<Record<string, string>>
  readonly mode: "git" | "filesystem"
  readonly partial?: boolean
  readonly partialReason?: string
  readonly gitError?: string
}

export interface TestIntegrityFinding {
  readonly kind:
    | "deleted_test"
    | "skipped_test"
    | "only_test"
    | "weakened_assertion"
    | "script_weakened"
    | "protected_file_tampered"
  readonly path: string
  readonly detail: string
  readonly removedCount?: number
  readonly severity: "block_auto"
}

export interface ProofCheckRecord {
  readonly id: string
  readonly name: string
  readonly kind: "test" | "command" | "criterion"
  readonly status: ProofCheckStatus
  readonly command?: string
  readonly cwd?: string
  readonly exitCode?: number | null
  readonly outputDigest?: string
  readonly evidenceSeq?: number
  readonly evidenceHash?: string
  readonly superseded?: boolean
  readonly stale?: boolean
}

export interface CriterionOutcomeRecord {
  readonly id: string
  readonly statement: string
  readonly required: boolean
  readonly status: "passed" | "failed" | "not_run" | "dropped"
  readonly checkId?: string
  readonly reason?: string
}

export interface ProofPackManifest {
  readonly version: 1
  readonly runId: string
  readonly workspace?: string
  readonly baseline?: WorkspaceBaseline
  readonly checks: readonly ProofCheckRecord[]
  readonly criteria: readonly CriterionOutcomeRecord[]
  readonly testIntegrity: readonly TestIntegrityFinding[]
  readonly verified: boolean
  readonly claimStatus: ClaimStatus
  readonly unverifiedReasons: readonly string[]
  readonly unobservableMutations?: boolean
  readonly evidenceFile: string
  readonly evidenceEntries: number
  readonly evidenceChainOk: boolean
}

export interface WorkspaceContextChunk {
  readonly source: string
  readonly workspace: string
  readonly content: string
  readonly untrusted: true
  readonly trustZone?: UntrustedTrustZone
}

export type PermissionMode = "accept-edits" | "smart" | "auto" | "manual" | "ask"

export type ApprovalDecision = "once" | "always" | "accept-edits" | "reject"

export interface SavedPermissionRule {
  readonly tool: "edit_file" | "run_command"
  readonly pattern: string
  readonly grantedAt: string
}

export interface RunActionRecord {
  readonly callId: string
  readonly tool: string
  readonly summary: string
  readonly decision: "allow" | "approve" | "deny" | "error"
  readonly approvalSource?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly target?: string
  readonly evidenceSeq?: number
  readonly evidenceHash?: string
}

export interface CommandOutcomeRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly decision: "approved" | "denied"
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly zeroTestsDetected?: boolean
  readonly outputDigest?: string
  readonly evidenceSeq?: number
  readonly evidenceHash?: string
  readonly actionOrder?: number
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
  readonly claimStatus?: ClaimStatus
  readonly stopReason?: string
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly diffPreviews?: readonly DiffPreviewRecord[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly actions: readonly RunActionRecord[]
  readonly requests: number
  readonly guardianRequests?: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
    readonly costUsd?: number
    readonly estimatedCostUsd?: number
    readonly costEstimated?: boolean
  }
  readonly contractId?: string
  readonly contractRevision?: number
  readonly baseline?: WorkspaceBaseline
  readonly proofPack?: ProofPackManifest
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
  readonly maxTotalTokens?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxCostUsd?: number
  readonly maxElapsedMs?: number
  readonly maxGuardianRequests?: number
  readonly maxToolCalls?: number
  readonly maxToolCallsPerResponse?: number
  readonly requestTimeoutMs?: number
  readonly maxTransientRetries?: number
  readonly commandTimeoutMs: number
  readonly repeatedFailureLimit: number
}

export type TaskEvent =
  | { readonly type: "task_started"; readonly runId: string; readonly workspace: string }
  | { readonly type: "turn_started"; readonly step: number; readonly maxRequests: number }
  | {
      readonly type: "model_requested"
      readonly step: number
      readonly model: string
      readonly endpoint: string
      readonly contextTokens: number
      readonly contextLimit: number
    }
  | { readonly type: "context_compacted" }
  | { readonly type: "assistant_progress"; readonly text: string }
  | { readonly type: "model_delta"; readonly text: string }
  | {
      readonly type: "model_retrying"
      readonly step: number
      readonly attempt: number
      readonly delayMs: number
      readonly reason: string
    }
  | {
      readonly type: "model_responded"
      readonly step: number
      readonly finishReason: FinishReason
      readonly usage?: ModelUsage
    }
  | {
      readonly type: "tool_proposed"
      readonly callId: string
      readonly tool: string
      readonly summary: string
      readonly preview?: string
      readonly integrityWarning?: string
    }
  | {
      readonly type: "guardian_review"
      readonly callId: string
      readonly tool: string
      readonly verdict: "APPROVE" | "DENY" | "ESCALATE"
      readonly reason?: string
    }
  | {
      readonly type: "test_guard_triggered"
      readonly callId: string
      readonly path: string
      readonly findings: readonly TestIntegrityFinding[]
    }
  | {
      readonly type: "tool_approved"
      readonly callId: string
      readonly tool: string
      readonly source?: string
      readonly relativePath?: string
      readonly resolvedPath?: string
    }
  | {
      readonly type: "tool_denied"
      readonly callId: string
      readonly tool: string
      readonly reason: string
    }
  | { readonly type: "tool_completed"; readonly result: ToolDispatchResult }
  | { readonly type: "assistant_text"; readonly text: string }
  | { readonly type: "task_finished"; readonly result: TaskResult }

export interface TaskInput {
  readonly workspace: string
  readonly prompt: string
  readonly trusted: boolean
  readonly config: StandaloneConfig
  readonly permissionMode?: PermissionMode
  readonly savedRules?: readonly SavedPermissionRule[]
  readonly history?: readonly ChatMessage[]
  readonly budgets?: Partial<TaskBudgets>
  readonly contract?: TaskContract
  readonly requireContract?: boolean
  readonly signal?: AbortSignal
}

export interface DiffPreviewRecord {
  readonly path: string
  readonly patch: string
  readonly create?: boolean
}

export interface TaskResult {
  readonly runId: string
  readonly outcome: RunSummaryRecord["outcome"]
  readonly claimStatus?: ClaimStatus
  readonly finalText: string
  readonly stopReason?: string
  readonly changedFiles: readonly string[]
  readonly changedTests: readonly string[]
  readonly diffPreviews?: readonly DiffPreviewRecord[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly actions?: readonly RunActionRecord[]
  readonly messages?: readonly ChatMessage[]
  readonly requests: number
  readonly guardianRequests?: number
  readonly usage: RunSummaryRecord["usage"]
  readonly proofPack?: ProofPackManifest
  readonly proofSummary?: string
  readonly evidenceFile: string
  readonly runRecordFile: string
}
