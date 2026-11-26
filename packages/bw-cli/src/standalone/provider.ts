/**
 * Standalone multi-protocol provider transport supporting OpenAI-compatible `/chat/completions`
 * and Anthropic-compatible `/v1/messages` endpoints.
 *
 * Uses Node 22 built-in `fetch` directly against the user-saved endpoint. Redirects are disabled
 * (`redirect: "manual"`) so credentials can never be forwarded to a different host, and secrets
 * are scrubbed from error messages.
 */

import { redact } from "../../../bw-evidence/src/recorder.ts"
import { resolveCredentialSecret } from "./config.ts"
import type {
  ChatMessage,
  CredentialConfig,
  FinishReason,
  ModelUsage,
  ProviderCompletion,
  StandaloneConfig,
  ToolCall,
  ToolDefinition,
  ToolInputError,
  WireProtocol,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type ProviderErrorKind =
  | "credential_missing"
  | "unauthorized"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "redirect_refused"
  | "response_too_large"
  | "malformed_response"
  | "http_error"
  | "network_error"

export class ProviderRequestError extends Error {
  readonly kind: ProviderErrorKind
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      readonly status?: number
      readonly retryable?: boolean
      readonly retryAfterMs?: number
    } = {},
  ) {
    super(message)
    this.name = "ProviderRequestError"
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    this.retryable = options.retryable ?? false
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.round(Number(trimmed) * 1000)
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined
  }
  const ts = Date.parse(trimmed)
  if (Number.isFinite(ts)) {
    return Math.min(Math.max(0, ts - Date.now()), 60_000)
  }
  return undefined
}

function scrubSecret(text: string, secret?: string): string {
  let out = String(redact(text))
  if (secret && secret.length >= 4) {
    out = out.split(secret).join("[REDACTED]")
  }
  return out
}

export function safeWireToolArguments(call: ToolCall): string {
  if (call.rawArguments !== undefined) {
    const trimmed = call.rawArguments.trim()
    if (trimmed === "") return "{}"
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return call.rawArguments
      }
    } catch {
      // Malformed JSON arguments (e.g. ToolInputError replay) must not break next wire request.
    }
  }
  return JSON.stringify(call.input ?? {})
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: safeWireToolArguments(call),
        },
      }))
      return {
        role: "assistant",
        content: msg.content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.callId,
        name: msg.name,
        content: msg.content,
      }
    }
    return { role: msg.role, content: msg.content }
  })
}

function toWireTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

function normalizeFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
      return "stop"
    case "tool_calls":
      return "tool_calls"
    case "length":
      return "length"
    case "content_filter":
      return "content_filter"
    case "error":
      return "error"
    default:
      return "unknown"
  }
}

function parseNonNegativeIntToken(raw: unknown): {
  readonly value?: number
  readonly invalid: boolean
} {
  if (raw === undefined || raw === null) return { invalid: false }
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { value: raw, invalid: false }
  }
  return { invalid: true }
}

function parseUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const u = raw as Record<string, unknown>
  const inCheck = parseNonNegativeIntToken(u["prompt_tokens"])
  const outCheck = parseNonNegativeIntToken(u["completion_tokens"])
  const totCheck = parseNonNegativeIntToken(u["total_tokens"])
  let usageInvalid = inCheck.invalid || outCheck.invalid || totCheck.invalid
  const inputTokens = inCheck.value
  const outputTokens = outCheck.value
  let totalTokens = totCheck.value

  if (
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined &&
    totalTokens < inputTokens + outputTokens
  ) {
    usageInvalid = true
    totalTokens = inputTokens + outputTokens
  } else if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens
  }

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    !usageInvalid
  ) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usageInvalid ? { usageInvalid: true } : {}),
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  endpoint: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined)
      throw new ProviderRequestError("cancelled", "Model request was cancelled.")
    }
    signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new ProviderRequestError("cancelled", "Model request was cancelled.")
      }
      if (value) {
        received += value.byteLength
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new ProviderRequestError(
            "response_too_large",
            `Provider response from ${endpoint} exceeded ${maxBytes} bytes.`,
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")
}

export interface CompleteRequest {
  readonly config: StandaloneConfig
  readonly messages: readonly ChatMessage[]
  readonly tools: readonly ToolDefinition[]
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
  readonly apiKeyOverride?: string
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly stream?: boolean
  readonly onDelta?: (delta: string) => void
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

function buildEndpointURL(baseURL: string, protocol: WireProtocol): string {
  const u = new URL(baseURL)
  const cleanPath = u.pathname.replace(/\/+$/, "")
  if (protocol === "anthropic-messages") {
    if (cleanPath.endsWith("/v1/messages")) u.pathname = cleanPath
    else if (cleanPath.endsWith("/v1")) u.pathname = `${cleanPath}/messages`
    else u.pathname = `${cleanPath}/v1/messages`
  } else {
    u.pathname = `${cleanPath}/chat/completions`
  }
  return u.toString()
}

function toAnthropicMessages(messages: readonly ChatMessage[]): {
  readonly system?: string
  readonly messages: unknown[]
} {
  const systemParts: string[] = []
  const wire: Array<{ role: "user" | "assistant"; content: unknown }> = []

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content.trim() !== "") systemParts.push(msg.content)
      continue
    }
    if (msg.role === "user") {
      wire.push({ role: "user", content: msg.content })
      continue
    }
    if (msg.role === "assistant") {
      const blocks: unknown[] = []
      if (msg.content !== "") {
        blocks.push({ type: "text", text: msg.content })
      }
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })
        }
      }
      wire.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      })
      continue
    }
    const resultBlock = {
      type: "tool_result",
      tool_use_id: msg.callId,
      content: msg.content,
    }
    const prev = wire.at(-1)
    if (prev && prev.role === "user" && Array.isArray(prev.content)) {
      prev.content.push(resultBlock)
    } else {
      wire.push({ role: "user", content: [resultBlock] })
    }
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: wire,
  }
}

function toAnthropicTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

function normalizeAnthropicStopReason(raw: unknown): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "tool_use":
      return "tool_calls"
    case "max_tokens":
      return "length"
    case "refusal":
      return "content_filter"
    default:
      return "unknown"
  }
}

function parseAnthropicUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const u = raw as Record<string, unknown>
  const baseCheck = parseNonNegativeIntToken(u["input_tokens"])
  const cacheReadCheck = parseNonNegativeIntToken(u["cache_read_input_tokens"])
  const cacheCreateCheck = parseNonNegativeIntToken(u["cache_creation_input_tokens"])
  const outCheck = parseNonNegativeIntToken(u["output_tokens"])
  const usageInvalid =
    baseCheck.invalid || cacheReadCheck.invalid || cacheCreateCheck.invalid || outCheck.invalid
  const inputTokens =
    baseCheck.value !== undefined
      ? baseCheck.value + (cacheReadCheck.value ?? 0) + (cacheCreateCheck.value ?? 0)
      : undefined
  const outputTokens = outCheck.value
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    !usageInvalid
  ) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usageInvalid ? { usageInvalid: true } : {}),
  }
}

function parseAnthropicPayload(
  payload: Record<string, unknown>,
  baseURL: string,
): ProviderCompletion {
  const blocks = payload["content"]
  if (!Array.isArray(blocks)) {
    throw new ProviderRequestError(
      "malformed_response",
      `Provider at ${baseURL} returned an Anthropic response without a content array.`,
    )
  }

  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  const toolInputErrors: ToolInputError[] = []

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (typeof block !== "object" || block === null) continue
    const b = block as Record<string, unknown>
    if (b["type"] === "text" && typeof b["text"] === "string") {
      textParts.push(b["text"])
      continue
    }
    if (b["type"] === "tool_use") {
      const id = typeof b["id"] === "string" && b["id"] !== "" ? b["id"] : `toolu_${i + 1}`
      const name = typeof b["name"] === "string" ? b["name"] : ""
      if (name === "") {
        throw new ProviderRequestError(
          "malformed_response",
          `Provider tool call '${id}' has an empty tool name.`,
        )
      }
      const rawInput = b["input"]
      if (typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
        toolCalls.push({
          id,
          name,
          input: rawInput as Record<string, unknown>,
          rawArguments: JSON.stringify(rawInput),
        })
      } else {
        toolInputErrors.push({
          id,
          name,
          raw: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? null),
        })
      }
    }
  }

  const finishReason = normalizeAnthropicStopReason(payload["stop_reason"])
  const usage = parseAnthropicUsage(payload["usage"])

  return {
    text: textParts.join(""),
    toolCalls,
    toolInputErrors,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  }
}

function parseOpenAIPayload(payload: Record<string, unknown>, baseURL: string): ProviderCompletion {
  const choices = payload["choices"]
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderRequestError(
      "malformed_response",
      `Provider at ${baseURL} returned no completion choices.`,
    )
  }
  const choice = choices[0] as Record<string, unknown>
  const msg = choice["message"]
  if (typeof msg !== "object" || msg === null) {
    throw new ProviderRequestError(
      "malformed_response",
      `Provider at ${baseURL} returned a choice without a message.`,
    )
  }
  const msgObj = msg as Record<string, unknown>
  const text = typeof msgObj["content"] === "string" ? msgObj["content"] : ""
  const finishReason = normalizeFinishReason(choice["finish_reason"])
  const usage = parseUsage(payload["usage"])

  const toolCalls: ToolCall[] = []
  const toolInputErrors: ToolInputError[] = []
  const rawToolCalls = msgObj["tool_calls"]
  if (rawToolCalls !== undefined && rawToolCalls !== null) {
    if (!Array.isArray(rawToolCalls)) {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider at ${baseURL} returned non-array tool_calls.`,
      )
    }
    for (let i = 0; i < rawToolCalls.length; i += 1) {
      const tc = rawToolCalls[i]
      if (typeof tc !== "object" || tc === null) {
        throw new ProviderRequestError(
          "malformed_response",
          `Provider returned malformed tool call at index ${i}.`,
        )
      }
      const tcObj = tc as Record<string, unknown>
      const id =
        typeof tcObj["id"] === "string" && tcObj["id"] !== "" ? tcObj["id"] : `call_${i + 1}`
      const fn = tcObj["function"]
      if (typeof fn !== "object" || fn === null) {
        throw new ProviderRequestError(
          "malformed_response",
          `Provider tool call '${id}' is missing function metadata.`,
        )
      }
      const fnObj = fn as Record<string, unknown>
      const name = typeof fnObj["name"] === "string" ? fnObj["name"] : ""
      if (name === "") {
        throw new ProviderRequestError(
          "malformed_response",
          `Provider tool call '${id}' has an empty tool name.`,
        )
      }
      const rawArgs =
        typeof fnObj["arguments"] === "string"
          ? fnObj["arguments"]
          : fnObj["arguments"] === undefined
            ? "{}"
            : JSON.stringify(fnObj["arguments"])
      try {
        const parsedArgs = rawArgs.trim() === "" ? {} : (JSON.parse(rawArgs) as unknown)
        if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
          toolInputErrors.push({ id, name, raw: rawArgs })
        } else {
          toolCalls.push({
            id,
            name,
            input: parsedArgs as Record<string, unknown>,
            rawArguments: rawArgs,
          })
        }
      } catch {
        toolInputErrors.push({ id, name, raw: rawArgs })
      }
    }
  }

  return {
    text,
    toolCalls,
    toolInputErrors,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  }
}

function buildAuthHeaders(
  protocol: WireProtocol,
  customHeaders: Readonly<Record<string, string>> | undefined,
  secret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...customHeaders,
    "Content-Type": "application/json",
    "User-Agent": "bashwink-standalone/0.2.0-alpha.2",
  }
  if (protocol === "anthropic-messages") {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "anthropic-version")) {
      headers["anthropic-version"] = "2023-06-01"
    }
    if (secret) {
      headers["x-api-key"] = secret
    }
  } else if (secret) {
    headers["Authorization"] = `Bearer ${secret}`
  }
  return headers
}

function resolveRequestSecret(
  credential: CredentialConfig,
  env: NodeJS.ProcessEnv,
  override?: string,
): { readonly ok: boolean; readonly secret?: string; readonly summary: string } {
  if (override !== undefined) {
    const trimmed = override.trim()
    if (trimmed === "") return { ok: false, summary: "provided API key is empty" }
    return { ok: true, secret: trimmed, summary: `in-memory key (${trimmed.length} chars)` }
  }
  return resolveCredentialSecret(credential, env)
}

async function* readSSEEvents(
  response: Response,
  maxBytes: number,
  endpoint: string,
  signal?: AbortSignal,
): AsyncGenerator<{ readonly event?: string; readonly data: string }> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let buffer = ""
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined)
      throw new ProviderRequestError("cancelled", "Model request was cancelled.")
    }
    signal.addEventListener("abort", onAbort, { once: true })
  }
  const emitBlock = (rawBlock: string) => {
    const lines = rawBlock.split(/\r?\n/)
    let eventName: string | undefined
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith(":")) continue
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return undefined
    return { ...(eventName !== undefined ? { event: eventName } : {}), data: dataLines.join("\n") }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new ProviderRequestError("cancelled", "Model request was cancelled.")
      }
      if (value) {
        received += value.byteLength
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new ProviderRequestError(
            "response_too_large",
            `Provider response from ${endpoint} exceeded ${maxBytes} bytes.`,
          )
        }
        buffer += decoder.decode(value, { stream: true })
        while (true) {
          const sepMatch = /\r?\n\r?\n/.exec(buffer)
          if (!sepMatch) break
          const block = buffer.slice(0, sepMatch.index)
          buffer = buffer.slice(sepMatch.index + sepMatch[0].length)
          const parsed = emitBlock(block)
          if (parsed) yield parsed
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== "") {
      const parsed = emitBlock(buffer)
      if (parsed) yield parsed
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

async function parseOpenAISSE(
  response: Response,
  maxBytes: number,
  endpoint: string,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ProviderCompletion> {
  const textParts: string[] = []
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let finishReason: FinishReason = "unknown"
  let usage: ModelUsage | undefined
  let sawEvent = false
  let sawDone = false
  let sawFinishReason = false

  for await (const ev of readSSEEvents(response, maxBytes, endpoint, signal)) {
    if (ev.data === "[DONE]") {
      sawDone = true
      break
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider at ${endpoint} emitted invalid JSON in stream chunk.`,
      )
    }
    sawEvent = true
    if (chunk["error"] !== undefined && chunk["error"] !== null) {
      const errObj = chunk["error"] as Record<string, unknown>
      const msg =
        typeof errObj === "object" && typeof errObj["message"] === "string"
          ? errObj["message"]
          : "stream error"
      throw new ProviderRequestError(
        "http_error",
        `Provider at ${endpoint} streamed error: ${msg}`,
        {
          retryable: true,
        },
      )
    }
    if (chunk["usage"]) {
      const parsedUsage = parseUsage(chunk["usage"])
      if (parsedUsage) usage = parsedUsage
    }
    const choices = chunk["choices"]
    if (!Array.isArray(choices) || choices.length === 0) continue
    const ch = choices[0] as Record<string, unknown>
    if (ch["finish_reason"] !== undefined && ch["finish_reason"] !== null) {
      finishReason = normalizeFinishReason(ch["finish_reason"])
      sawFinishReason = true
    }
    const delta = ch["delta"]
    if (typeof delta === "object" && delta !== null) {
      const d = delta as Record<string, unknown>
      if (typeof d["content"] === "string" && d["content"].length > 0) {
        textParts.push(d["content"])
        onDelta?.(d["content"])
      }
      const tcList = d["tool_calls"]
      if (Array.isArray(tcList)) {
        for (let i = 0; i < tcList.length; i += 1) {
          const item = tcList[i] as Record<string, unknown>
          const idx = typeof item["index"] === "number" ? item["index"] : i
          const existing = toolAcc.get(idx) ?? { id: `call_${idx + 1}`, name: "", args: "" }
          if (typeof item["id"] === "string" && item["id"] !== "") existing.id = item["id"]
          const fn = item["function"] as Record<string, unknown> | undefined
          if (fn) {
            if (typeof fn["name"] === "string" && fn["name"] !== "") existing.name += fn["name"]
            if (typeof fn["arguments"] === "string") existing.args += fn["arguments"]
          }
          toolAcc.set(idx, existing)
        }
      }
    }
  }

  if (!sawEvent || (!sawDone && !sawFinishReason) || (toolAcc.size > 0 && !sawFinishReason)) {
    throw new ProviderRequestError(
      "malformed_response",
      `Provider at ${endpoint} ended stream prematurely without terminal completion.`,
    )
  }

  const toolCalls: ToolCall[] = []
  const toolInputErrors: ToolInputError[] = []
  for (const [, tc] of [...toolAcc.entries()].sort(([a], [b]) => a - b)) {
    if (tc.name === "") {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider streamed tool call '${tc.id}' with an empty tool name.`,
      )
    }
    const rawArgs = tc.args === "" ? "{}" : tc.args
    try {
      const parsedArgs = rawArgs.trim() === "" ? {} : (JSON.parse(rawArgs) as unknown)
      if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
        toolInputErrors.push({ id: tc.id, name: tc.name, raw: rawArgs })
      } else {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          input: parsedArgs as Record<string, unknown>,
          rawArguments: rawArgs,
        })
      }
    } catch {
      toolInputErrors.push({ id: tc.id, name: tc.name, raw: rawArgs })
    }
  }

  return {
    text: textParts.join(""),
    toolCalls,
    toolInputErrors,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  }
}

async function parseAnthropicSSE(
  response: Response,
  maxBytes: number,
  endpoint: string,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ProviderCompletion> {
  const textParts: string[] = []
  const toolBlocks = new Map<number, { id: string; name: string; jsonText: string }>()
  let finishReason: FinishReason = "unknown"
  let usage: ModelUsage | undefined
  let sawEvent = false
  let sawMessageStop = false

  for await (const ev of readSSEEvents(response, maxBytes, endpoint, signal)) {
    if (!ev.data || ev.data === "[DONE]") continue
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider at ${endpoint} emitted invalid JSON in Anthropic stream.`,
      )
    }
    sawEvent = true
    const type = typeof chunk["type"] === "string" ? chunk["type"] : ev.event
    if (type === "error" || (chunk["error"] !== undefined && chunk["error"] !== null)) {
      const errObj = chunk["error"] as Record<string, unknown> | undefined
      const msg =
        errObj && typeof errObj["message"] === "string"
          ? errObj["message"]
          : "Anthropic stream error"
      throw new ProviderRequestError(
        "http_error",
        `Provider at ${endpoint} streamed error: ${msg}`,
        {
          retryable: true,
        },
      )
    }
    if (type === "message_stop") {
      sawMessageStop = true
      continue
    }
    if (
      type === "message_start" &&
      typeof chunk["message"] === "object" &&
      chunk["message"] !== null
    ) {
      const msg = chunk["message"] as Record<string, unknown>
      if (msg["usage"]) usage = parseAnthropicUsage(msg["usage"])
    } else if (type === "content_block_start") {
      const idx = typeof chunk["index"] === "number" ? chunk["index"] : 0
      const cb = chunk["content_block"] as Record<string, unknown> | undefined
      if (cb && cb["type"] === "tool_use") {
        toolBlocks.set(idx, {
          id: typeof cb["id"] === "string" && cb["id"] !== "" ? cb["id"] : `toolu_${idx + 1}`,
          name: typeof cb["name"] === "string" ? cb["name"] : "",
          jsonText:
            typeof cb["input"] === "object" &&
            cb["input"] !== null &&
            Object.keys(cb["input"]).length > 0
              ? JSON.stringify(cb["input"])
              : "",
        })
      }
    } else if (type === "content_block_delta") {
      const idx = typeof chunk["index"] === "number" ? chunk["index"] : 0
      const delta = chunk["delta"] as Record<string, unknown> | undefined
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        textParts.push(delta["text"])
        onDelta?.(delta["text"])
      } else if (
        delta?.["type"] === "input_json_delta" &&
        typeof delta["partial_json"] === "string"
      ) {
        const blk = toolBlocks.get(idx)
        if (blk) blk.jsonText += delta["partial_json"]
      }
    } else if (type === "message_delta") {
      const delta = chunk["delta"] as Record<string, unknown> | undefined
      if (delta && delta["stop_reason"] !== undefined) {
        finishReason = normalizeAnthropicStopReason(delta["stop_reason"])
      }
      if (chunk["usage"]) {
        const deltaUsage = parseAnthropicUsage(chunk["usage"])
        if (deltaUsage) {
          const mergedIn = deltaUsage.inputTokens ?? usage?.inputTokens
          const mergedOut = deltaUsage.outputTokens ?? usage?.outputTokens
          const mergedInvalid = Boolean(usage?.usageInvalid || deltaUsage.usageInvalid)
          usage = {
            ...(mergedIn !== undefined ? { inputTokens: mergedIn } : {}),
            ...(mergedOut !== undefined ? { outputTokens: mergedOut } : {}),
            ...(mergedIn !== undefined && mergedOut !== undefined
              ? { totalTokens: mergedIn + mergedOut }
              : {}),
            ...(mergedInvalid ? { usageInvalid: true } : {}),
          }
        }
      }
    }
  }

  if (
    !sawEvent ||
    (!sawMessageStop && finishReason === "unknown") ||
    (toolBlocks.size > 0 && finishReason === "unknown")
  ) {
    throw new ProviderRequestError(
      "malformed_response",
      `Provider at ${endpoint} ended Anthropic stream prematurely without terminal completion.`,
    )
  }

  const toolCalls: ToolCall[] = []
  const toolInputErrors: ToolInputError[] = []
  for (const [, blk] of [...toolBlocks.entries()].sort(([a], [b]) => a - b)) {
    if (blk.name === "") {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider streamed Anthropic tool call '${blk.id}' with empty name.`,
      )
    }
    const raw = blk.jsonText.trim() === "" ? "{}" : blk.jsonText
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        toolInputErrors.push({ id: blk.id, name: blk.name, raw })
      } else {
        toolCalls.push({
          id: blk.id,
          name: blk.name,
          input: parsed as Record<string, unknown>,
          rawArguments: raw,
        })
      }
    } catch {
      toolInputErrors.push({ id: blk.id, name: blk.name, raw })
    }
  }

  return {
    text: textParts.join(""),
    toolCalls,
    toolInputErrors,
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  }
}

export async function complete(req: CompleteRequest): Promise<ProviderCompletion> {
  const protocol: WireProtocol = req.config.wireProtocol ?? "openai-chat"
  const endpoint = buildEndpointURL(req.config.baseURL, protocol)
  const cred = resolveRequestSecret(
    req.config.credential,
    req.env ?? process.env,
    req.apiKeyOverride,
  )
  if (!cred.ok) {
    throw new ProviderRequestError(
      "credential_missing",
      `Saved endpoint ${req.config.baseURL} cannot authenticate (${cred.summary}). Run \`bashwink setup\` to fix the credential reference.`,
    )
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onParentAbort = () => controller.abort()
  if (req.signal) {
    if (req.signal.aborted) {
      clearTimeout(timer)
      throw new ProviderRequestError("cancelled", "Model request was cancelled.")
    }
    req.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  const headers = buildAuthHeaders(protocol, req.config.headers, cred.secret)
  const wantStream = req.stream === true || req.onDelta !== undefined

  const body =
    protocol === "anthropic-messages"
      ? (() => {
          const converted = toAnthropicMessages(req.messages)
          return JSON.stringify({
            model: req.config.model,
            ...(converted.system ? { system: converted.system } : {}),
            messages: converted.messages,
            ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
            max_tokens: req.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            stream: wantStream,
          })
        })()
      : JSON.stringify({
          model: req.config.model,
          messages: toWireMessages(req.messages),
          ...(req.tools.length > 0 ? { tools: toWireTools(req.tools) } : {}),
          ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: wantStream,
        })

  const fetchFn = req.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    req.signal?.removeEventListener("abort", onParentAbort)
    if (req.signal?.aborted) {
      throw new ProviderRequestError("cancelled", "Model request was cancelled.")
    }
    if (timedOut) {
      throw new ProviderRequestError(
        "timeout",
        `Model request to ${req.config.baseURL} timed out after ${timeoutMs} ms.`,
        { retryable: true },
      )
    }
    const detail = scrubSecret(error instanceof Error ? error.message : String(error), cred.secret)
    throw new ProviderRequestError(
      "network_error",
      `Could not reach ${req.config.baseURL}: ${detail}`,
      { retryable: true },
    )
  }

  try {
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(unknown)"
      throw new ProviderRequestError(
        "redirect_refused",
        `Refused HTTP ${response.status} redirect from ${req.config.baseURL} to ${location}; credentials are never forwarded on redirects.`,
        { status: response.status },
      )
    }

    if (!response.ok) {
      const rawText = await readBoundedText(
        response,
        maxResponseBytes,
        req.config.baseURL,
        controller.signal,
      )
      const safeSnippet = scrubSecret(
        rawText.slice(0, 400).replace(/\s+/g, " ").trim(),
        cred.secret,
      )
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRequestError(
          "unauthorized",
          `Provider at ${req.config.baseURL} rejected authentication (${response.status}): ${safeSnippet || "check credential"}. Run \`bashwink setup\` to update credentials or model.`,
          { status: response.status },
        )
      }
      if (response.status === 429) {
        throw new ProviderRequestError(
          "rate_limit",
          `Provider at ${req.config.baseURL} rate-limited the request (HTTP 429): ${safeSnippet}`,
          { status: 429, retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
        )
      }
      const isRetryable = response.status === 408 || response.status >= 500
      throw new ProviderRequestError(
        "http_error",
        `Provider at ${req.config.baseURL} returned HTTP ${response.status}: ${safeSnippet}`,
        {
          status: response.status,
          retryable: isRetryable,
          ...(isRetryable && retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      )
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (wantStream && contentType.includes("text/event-stream")) {
      return protocol === "anthropic-messages"
        ? await parseAnthropicSSE(
            response,
            maxResponseBytes,
            req.config.baseURL,
            req.onDelta,
            controller.signal,
          )
        : await parseOpenAISSE(
            response,
            maxResponseBytes,
            req.config.baseURL,
            req.onDelta,
            controller.signal,
          )
    }

    const rawText = await readBoundedText(
      response,
      maxResponseBytes,
      req.config.baseURL,
      controller.signal,
    )
    let json: unknown
    try {
      json = JSON.parse(rawText)
    } catch {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider at ${req.config.baseURL} returned invalid JSON.`,
      )
    }
    if (typeof json !== "object" || json === null) {
      throw new ProviderRequestError(
        "malformed_response",
        `Provider at ${req.config.baseURL} returned a non-object JSON payload.`,
      )
    }
    const payload = json as Record<string, unknown>
    return protocol === "anthropic-messages"
      ? parseAnthropicPayload(payload, req.config.baseURL)
      : parseOpenAIPayload(payload, req.config.baseURL)
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error
    if (req.signal?.aborted) {
      throw new ProviderRequestError("cancelled", "Model request was cancelled.")
    }
    if (timedOut) {
      throw new ProviderRequestError(
        "timeout",
        `Model response from ${req.config.baseURL} timed out after ${timeoutMs} ms.`,
        { retryable: true },
      )
    }
    const detail = scrubSecret(error instanceof Error ? error.message : String(error), cred.secret)
    throw new ProviderRequestError(
      "network_error",
      `Failed reading response from ${req.config.baseURL}: ${detail}`,
      { retryable: true },
    )
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener("abort", onParentAbort)
  }
}

export interface ProbeModelsRequest {
  readonly baseURL: string
  readonly credential: CredentialConfig
  readonly wireProtocol?: WireProtocol
  readonly headers?: Readonly<Record<string, string>>
  readonly env?: NodeJS.ProcessEnv
  readonly apiKeyOverride?: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

export interface ProbeModelsResult {
  readonly ok: boolean
  readonly models: readonly string[]
  readonly probedURL: string
  readonly resolvedBaseURL?: string
  readonly usedFallback?: boolean
  readonly cancelled?: boolean
  readonly error?: string
}

function buildModelsCandidates(
  baseURL: string,
  protocol: WireProtocol,
): ReadonlyArray<{ readonly base: string; readonly url: string; readonly isFallback: boolean }> {
  const parsed = new URL(baseURL)
  const cleanPath = parsed.pathname.replace(/\/+$/, "")
  const out: Array<{ base: string; url: string; isFallback: boolean }> = []
  const push = (basePath: string, isFallback: boolean) => {
    const bp = basePath.replace(/\/+$/, "")
    const baseStr = `${parsed.origin}${bp}${parsed.search}`

    const probeObj = new URL(parsed.origin)
    probeObj.pathname =
      protocol === "anthropic-messages"
        ? bp.endsWith("/v1")
          ? `${bp}/models`
          : `${bp}/v1/models`
        : `${bp}/models`
    probeObj.search = parsed.search
    const urlStr = probeObj.toString()
    if (!out.some((x) => x.url === urlStr)) out.push({ base: baseStr, url: urlStr, isFallback })
  }

  push(cleanPath, false)
  if (cleanPath.endsWith("/v1")) {
    push(cleanPath.slice(0, -3), true)
  } else {
    push(`${cleanPath}/v1`, true)
  }
  return out
}

function extractModelIdsFromPayload(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return []
  const obj = payload as Record<string, unknown>
  const rawList = Array.isArray(obj["data"])
    ? (obj["data"] as unknown[])
    : Array.isArray(obj["models"])
      ? (obj["models"] as unknown[])
      : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    let id = ""
    if (typeof item === "string") {
      id = item.trim()
    } else if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>
      const cand = rec["id"] ?? rec["model"] ?? rec["name"]
      if (typeof cand === "string") id = cand.trim()
    }
    if (id !== "" && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * Hermes-style `GET /models` probe with same-origin `base±/v1` fallback, redirect refusal,
 * and immediate AbortSignal propagation.
 */
export async function probeModels(req: ProbeModelsRequest): Promise<ProbeModelsResult> {
  const protocol: WireProtocol = req.wireProtocol ?? "openai-chat"
  const candidates = buildModelsCandidates(req.baseURL, protocol)
  const defaultProbed = candidates[0]?.url ?? `${req.baseURL.replace(/\/+$/, "")}/models`
  if (req.signal?.aborted) {
    return {
      ok: false,
      models: [],
      probedURL: defaultProbed,
      cancelled: true,
      error: "Model discovery cancelled by user.",
    }
  }
  const cred = resolveRequestSecret(req.credential, req.env ?? process.env, req.apiKeyOverride)
  if (!cred.ok) {
    return {
      ok: false,
      models: [],
      probedURL: defaultProbed,
      error: `Cannot authenticate (${cred.summary}).`,
    }
  }

  const headers = buildAuthHeaders(protocol, req.headers, cred.secret)
  delete headers["Content-Type"]
  const fetchFn = req.fetchImpl ?? fetch
  const timeoutMs = req.timeoutMs ?? 6_000
  const maxResponseBytes = req.maxResponseBytes ?? 2 * 1024 * 1024
  const deadline = Date.now() + timeoutMs
  let lastError: string | undefined

  for (const candidate of candidates) {
    if (req.signal?.aborted) {
      return {
        ok: false,
        models: [],
        probedURL: candidate.url,
        cancelled: true,
        error: "Model discovery cancelled by user.",
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      lastError ??= `Model discovery timed out after ${timeoutMs} ms.`
      break
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, remainingMs)
    const onParentAbort = () => controller.abort()
    req.signal?.addEventListener("abort", onParentAbort, { once: true })
    try {
      const response = await fetchFn(candidate.url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "(unknown)"
        lastError = `Refused HTTP ${response.status} redirect to ${location}.`
        continue
      }
      const rawText = await readBoundedText(
        response,
        maxResponseBytes,
        candidate.url,
        controller.signal,
      )
      if (!response.ok) {
        const snippet = scrubSecret(rawText.slice(0, 200).replace(/\s+/g, " ").trim(), cred.secret)
        lastError = `HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`
        if (response.status === 401 || response.status === 403) {
          return { ok: false, models: [], probedURL: candidate.url, error: lastError }
        }
        continue
      }
      const json = JSON.parse(rawText) as unknown
      const models = extractModelIdsFromPayload(json)
      return {
        ok: true,
        models,
        probedURL: candidate.url,
        resolvedBaseURL: candidate.base,
        usedFallback: candidate.isFallback,
      }
    } catch (error) {
      if (req.signal?.aborted) {
        return {
          ok: false,
          models: [],
          probedURL: candidate.url,
          cancelled: true,
          error: "Model discovery cancelled by user.",
        }
      }
      lastError = timedOut
        ? `Model discovery timed out at ${candidate.url} after ${timeoutMs} ms.`
        : scrubSecret(error instanceof Error ? error.message : String(error), cred.secret)
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener("abort", onParentAbort)
    }
  }

  return {
    ok: false,
    models: [],
    probedURL: defaultProbed,
    ...(lastError ? { error: lastError } : {}),
  }
}

export interface TestConnectionRequest {
  readonly config: StandaloneConfig
  readonly env?: NodeJS.ProcessEnv
  readonly apiKeyOverride?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly onProgress?: (stage: string) => void
  readonly checkToolCapability?: boolean
  readonly fetchImpl?: typeof fetch
}

export type ToolSupportStatus = "supported" | "accepted_text_only" | "unsupported" | "untested"

export interface TestConnectionResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly replySnippet?: string
  readonly finishReason?: FinishReason
  readonly usage?: ModelUsage
  readonly discoveredModelsCount?: number
  readonly modelListedInCatalog?: boolean
  readonly probedURL?: string
  readonly toolSupport?: ToolSupportStatus
  readonly cancelled?: boolean
  readonly errorKind?: ProviderErrorKind
  readonly error?: string
}

const PROBE_TOOL_DEF: ToolDefinition = {
  name: "bw_connection_probe",
  description: "Harmless read-only echo probe used during setup to verify tool-call capability.",
  parameters: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    additionalProperties: false,
  },
}

/**
 * Verify provider authentication, `/models` visibility (best-effort), usable sample completion,
 * and tool-call schema compatibility within an overall bounded deadline and AbortSignal.
 */
export async function testProviderConnection(
  req: TestConnectionRequest,
): Promise<TestConnectionResult> {
  const started = Date.now()
  const totalBudgetMs = Math.max(200, req.timeoutMs ?? 15_000)
  const deadline = started + totalBudgetMs

  if (req.signal?.aborted) {
    return {
      ok: false,
      latencyMs: 0,
      cancelled: true,
      errorKind: "cancelled",
      error: "Connection test cancelled by user.",
    }
  }

  const probeTimeout = Math.min(4_000, Math.max(150, Math.floor(totalBudgetMs * 0.4)))
  req.onProgress?.(
    `Probing /models catalog at ${req.config.baseURL} (timeout ${probeTimeout} ms)...`,
  )
  const probe = await probeModels({
    baseURL: req.config.baseURL,
    credential: req.config.credential,
    ...(req.config.wireProtocol ? { wireProtocol: req.config.wireProtocol } : {}),
    ...(req.config.headers ? { headers: req.config.headers } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.apiKeyOverride !== undefined ? { apiKeyOverride: req.apiKeyOverride } : {}),
    timeoutMs: probeTimeout,
    ...(req.signal ? { signal: req.signal } : {}),
    ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
  })

  if (probe.cancelled || req.signal?.aborted) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      cancelled: true,
      errorKind: "cancelled",
      error: "Connection test cancelled by user.",
    }
  }

  const remainingMs = deadline - Date.now()
  if (remainingMs <= 50) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      errorKind: "timeout",
      error: `Connection test timed out after ${totalBudgetMs} ms during /models discovery at ${req.config.baseURL}.`,
      ...(probe.ok
        ? {
            discoveredModelsCount: probe.models.length,
            modelListedInCatalog: probe.models.includes(req.config.model),
            probedURL: probe.probedURL,
          }
        : {}),
    }
  }

  const checkTools = req.checkToolCapability !== false
  req.onProgress?.(`Testing sample completion (${remainingMs} ms remaining)...`)

  const runTextSample = async (timeoutMs: number) =>
    await complete({
      config: req.config,
      messages: [{ role: "user", content: "Reply with OK." }],
      tools: [],
      ...(req.env ? { env: req.env } : {}),
      ...(req.apiKeyOverride !== undefined ? { apiKeyOverride: req.apiKeyOverride } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      maxOutputTokens: 32,
      timeoutMs,
      ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
    })

  const runToolProbe = async (timeoutMs: number): Promise<ToolSupportStatus> => {
    req.onProgress?.("tool_probe")
    const probePrompt: ChatMessage = {
      role: "user",
      content: `Call the '${PROBE_TOOL_DEF.name}' tool once with {"ok":true} and nothing else.`,
    }
    let toolReply: ProviderCompletion
    try {
      toolReply = await complete({
        config: req.config,
        messages: [probePrompt],
        tools: [PROBE_TOOL_DEF],
        ...(req.env ? { env: req.env } : {}),
        ...(req.apiKeyOverride !== undefined ? { apiKeyOverride: req.apiKeyOverride } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        maxOutputTokens: 64,
        timeoutMs,
        ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
      })
    } catch (err) {
      if (
        err instanceof ProviderRequestError &&
        err.kind === "http_error" &&
        (err.status === 400 || err.status === 422)
      ) {
        return "unsupported"
      }
      throw err
    }
    const matchingCall = toolReply.toolCalls.find(
      (c) =>
        c.name === PROBE_TOOL_DEF.name &&
        typeof c.input === "object" &&
        c.input !== null &&
        c.input["ok"] === true,
    )
    if (!matchingCall) {
      return "accepted_text_only"
    }
    const afterProbeRem = deadline - Date.now()
    if (afterProbeRem <= 50) return "supported"
    try {
      const followUp = await complete({
        config: req.config,
        messages: [
          probePrompt,
          { role: "assistant", content: toolReply.text, toolCalls: [matchingCall] },
          {
            role: "tool",
            callId: matchingCall.id,
            name: matchingCall.name,
            content: '{"acknowledged":true}',
          },
        ],
        tools: [PROBE_TOOL_DEF],
        ...(req.env ? { env: req.env } : {}),
        ...(req.apiKeyOverride !== undefined ? { apiKeyOverride: req.apiKeyOverride } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        maxOutputTokens: 32,
        timeoutMs: afterProbeRem,
        ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
      })
      return followUp.finishReason === "stop" || followUp.finishReason === "tool_calls"
        ? "supported"
        : "accepted_text_only"
    } catch {
      return "accepted_text_only"
    }
  }

  let toolSupport: ToolSupportStatus = checkTools ? "accepted_text_only" : "untested"
  try {
    const completion = await runTextSample(remainingMs)
    if (checkTools) {
      const toolRem = deadline - Date.now()
      if (toolRem > 50) {
        toolSupport = await runToolProbe(toolRem)
      }
    }

    const snippet = completion.text.trim().replace(/\s+/g, " ").slice(0, 80)
    const catalogMeta = probe.ok
      ? {
          discoveredModelsCount: probe.models.length,
          modelListedInCatalog: probe.models.includes(req.config.model),
          probedURL: probe.probedURL,
        }
      : {}

    if (completion.finishReason === "error") {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        ...(snippet ? { replySnippet: snippet } : {}),
        finishReason: completion.finishReason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        toolSupport,
        ...catalogMeta,
        errorKind: "malformed_response",
        error: "Provider returned finish_reason='error' on sample request.",
      }
    }
    if (completion.finishReason === "content_filter") {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        ...(snippet ? { replySnippet: snippet } : {}),
        finishReason: completion.finishReason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        toolSupport,
        ...catalogMeta,
        errorKind: "malformed_response",
        error: "Provider filtered the sample response (finish_reason='content_filter').",
      }
    }
    if (completion.finishReason === "length") {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        ...(snippet ? { replySnippet: snippet } : {}),
        finishReason: completion.finishReason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        toolSupport,
        ...catalogMeta,
        errorKind: "malformed_response",
        error:
          "Sample response was truncated (finish_reason='length') and cannot confirm usable output.",
      }
    }
    if (completion.toolInputErrors.length > 0) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        ...(snippet ? { replySnippet: snippet } : {}),
        finishReason: completion.finishReason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        toolSupport,
        ...catalogMeta,
        errorKind: "malformed_response",
        error: "Provider returned malformed tool-call arguments during connection probe.",
      }
    }
    if (snippet === "" && completion.toolCalls.length === 0) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        finishReason: completion.finishReason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        toolSupport,
        ...catalogMeta,
        errorKind: "malformed_response",
        error: "Provider returned an empty response with no usable text or tool call.",
      }
    }

    return {
      ok: true,
      latencyMs: Date.now() - started,
      replySnippet: snippet || `[tool:${completion.toolCalls[0]!.name}]`,
      finishReason: completion.finishReason,
      ...(completion.usage ? { usage: completion.usage } : {}),
      toolSupport,
      ...catalogMeta,
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = error instanceof ProviderRequestError && error.kind === "cancelled"
    return {
      ok: false,
      latencyMs,
      ...(probe.ok
        ? {
            discoveredModelsCount: probe.models.length,
            modelListedInCatalog: probe.models.includes(req.config.model),
            probedURL: probe.probedURL,
          }
        : {}),
      ...(cancelled ? { cancelled: true } : {}),
      ...(error instanceof ProviderRequestError ? { errorKind: error.kind } : {}),
      error: message,
    }
  }
}
