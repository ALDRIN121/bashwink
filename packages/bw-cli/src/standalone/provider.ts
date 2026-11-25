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

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { readonly status?: number; readonly retryable?: boolean } = {},
  ) {
    super(message)
    this.name = "ProviderRequestError"
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

function scrubSecret(text: string, secret?: string): string {
  let out = String(redact(text))
  if (secret && secret.length >= 4) {
    out = out.split(secret).join("[REDACTED]")
  }
  return out
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.rawArguments ?? JSON.stringify(call.input),
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

function parseUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const u = raw as Record<string, unknown>
  const inputTokens =
    typeof u["prompt_tokens"] === "number" && Number.isFinite(u["prompt_tokens"])
      ? u["prompt_tokens"]
      : undefined
  const outputTokens =
    typeof u["completion_tokens"] === "number" && Number.isFinite(u["completion_tokens"])
      ? u["completion_tokens"]
      : undefined
  const totalTokens =
    typeof u["total_tokens"] === "number" && Number.isFinite(u["total_tokens"])
      ? u["total_tokens"]
      : inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  endpoint: string,
): Promise<string> {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
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
  readonly maxOutputTokens?: number
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

function buildEndpointURL(baseURL: string, protocol: WireProtocol): string {
  const trimmed = baseURL.replace(/\/+$/, "")
  if (protocol === "anthropic-messages") {
    if (trimmed.endsWith("/v1/messages")) return trimmed
    if (trimmed.endsWith("/v1")) return `${trimmed}/messages`
    return `${trimmed}/v1/messages`
  }
  return `${trimmed}/chat/completions`
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
  const baseInput =
    typeof u["input_tokens"] === "number" && Number.isFinite(u["input_tokens"]) ? u["input_tokens"] : undefined
  const cacheRead =
    typeof u["cache_read_input_tokens"] === "number" && Number.isFinite(u["cache_read_input_tokens"])
      ? u["cache_read_input_tokens"]
      : 0
  const cacheCreate =
    typeof u["cache_creation_input_tokens"] === "number" && Number.isFinite(u["cache_creation_input_tokens"])
      ? u["cache_creation_input_tokens"]
      : 0
  const inputTokens = baseInput !== undefined ? baseInput + cacheRead + cacheCreate : undefined
  const outputTokens =
    typeof u["output_tokens"] === "number" && Number.isFinite(u["output_tokens"]) ? u["output_tokens"] : undefined
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function parseAnthropicPayload(payload: Record<string, unknown>, baseURL: string): ProviderCompletion {
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
      const id = typeof tcObj["id"] === "string" && tcObj["id"] !== "" ? tcObj["id"] : `call_${i + 1}`
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

export async function complete(req: CompleteRequest): Promise<ProviderCompletion> {
  const protocol: WireProtocol = req.config.wireProtocol ?? "openai-chat"
  const endpoint = buildEndpointURL(req.config.baseURL, protocol)
  const cred = resolveCredentialSecret(req.config.credential, req.env ?? process.env)
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

  const headers: Record<string, string> = {
    ...req.config.headers,
    "Content-Type": "application/json",
    "User-Agent": "bashwink-standalone/0.2.0-alpha.1",
  }
  if (protocol === "anthropic-messages") {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "anthropic-version")) {
      headers["anthropic-version"] = "2023-06-01"
    }
    if (cred.secret) {
      headers["x-api-key"] = cred.secret
    }
  } else if (cred.secret) {
    headers["Authorization"] = `Bearer ${cred.secret}`
  }

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
            stream: false,
          })
        })()
      : JSON.stringify({
          model: req.config.model,
          messages: toWireMessages(req.messages),
          ...(req.tools.length > 0 ? { tools: toWireTools(req.tools) } : {}),
          ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
          stream: false,
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

    const rawText = await readBoundedText(response, maxResponseBytes, req.config.baseURL)
    if (!response.ok) {
      const safeSnippet = scrubSecret(rawText.slice(0, 400).replace(/\s+/g, " ").trim(), cred.secret)
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
          { status: 429, retryable: true },
        )
      }
      throw new ProviderRequestError(
        "http_error",
        `Provider at ${req.config.baseURL} returned HTTP ${response.status}: ${safeSnippet}`,
        { status: response.status, retryable: response.status >= 500 },
      )
    }

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
