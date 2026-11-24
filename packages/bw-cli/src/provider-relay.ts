import { timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import { once } from "node:events"
import { chmodSync, lstatSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { request as requestHttps } from "node:https"
import { isIP } from "node:net"
import { dirname } from "node:path"
import { checkServerIdentity } from "node:tls"

const guestAuthority = "127.0.0.1:8118"
const requestLimit = 4 * 1024 * 1024
const responseLimit = 16 * 1024 * 1024
const streamFrameLimit = 4 * 1024 * 1024
const concurrentLimit = 2

const suffix = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
} as const

type Protocol = keyof typeof suffix
type Payload = Record<string, unknown>

export interface ProviderRelayRoute {
  readonly id: string
  readonly protocol: Protocol
  readonly endpoint: URL
  readonly credential: string
  readonly models: readonly string[]
  readonly maxOutputTokens: number
}

export interface ProviderRelayOptions {
  readonly socketPath: string
  readonly capability: string
  readonly routes: readonly ProviderRelayRoute[]
  readonly maxRequests?: number
  readonly timeoutMs?: number
}

interface UpstreamRequest {
  readonly endpoint: URL
  readonly address: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
  readonly signal: AbortSignal
}

interface UpstreamResponse {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: AsyncIterable<Uint8Array>
  cancel(): void
}

/** Dependencies set by host code for offline tests. */
export interface ProviderRelayDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>
  readonly request?: (request: UpstreamRequest) => Promise<UpstreamResponse>
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number)
    return (
      a > 0 &&
      a < 224 &&
      ![10, 127].includes(a) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) &&
      !(a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6 || address.includes("%")) return false
  const [first = "", second = ""] = new URL(`http://[${address}]/`).hostname.slice(1, -1).split(":")
  const block = parseInt(first, 16)
  return (
    block >= 0x2000 &&
    block < 0x4000 &&
    block !== 0x2002 &&
    block !== 0x3fff &&
    !(block === 0x2001 && (second === "" || parseInt(second, 16) <= 0x1ff || second === "db8"))
  )
}

function requestUpstream(input: UpstreamRequest): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const hostname = input.endpoint.hostname
    const outgoing = requestHttps(
      {
        hostname: input.address,
        servername: hostname,
        port: 443,
        path: input.endpoint.pathname,
        method: "POST",
        headers: input.headers,
        agent: false,
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
        signal: input.signal,
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 502,
          contentType: response.headers["content-type"],
          body: response,
          cancel() {
            response.destroy()
            outgoing.destroy()
          },
        }),
    )
    outgoing.on("error", reject)
    outgoing.end(input.body)
  })
}

function object(value: unknown): Payload | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : undefined
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  )
}

function allowedKeys(record: Payload, allowed: readonly string[]) {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function contentAllowed(value: unknown, protocol: Protocol, nested = false): boolean {
  if (typeof value === "string") return true
  if (!Array.isArray(value)) return false
  return value.every((item: unknown) => {
    const part = object(item)
    if (part === undefined) return false
    if (protocol === "openai-responses") {
      return (
        ["input_text", "output_text"].includes(String(part["type"])) &&
        typeof part["text"] === "string" &&
        allowedKeys(part, ["type", "text", "annotations"]) &&
        (part["annotations"] === undefined ||
          (Array.isArray(part["annotations"]) && part["annotations"].length === 0))
      )
    }
    if (part["type"] === "text")
      return (
        typeof part["text"] === "string" &&
        allowedKeys(
          part,
          protocol === "anthropic-messages" ? ["type", "text", "cache_control"] : ["type", "text"],
        )
      )
    if (protocol !== "anthropic-messages" || nested) return false
    switch (part["type"]) {
      case "tool_use":
        return allowedKeys(part, ["type", "id", "name", "input", "cache_control"])
      case "tool_result":
        return (
          allowedKeys(part, ["type", "tool_use_id", "content", "is_error", "cache_control"]) &&
          contentAllowed(part["content"], protocol, true)
        )
      case "thinking":
        return allowedKeys(part, ["type", "thinking", "signature"])
      case "redacted_thinking":
        return allowedKeys(part, ["type", "data"])
      default:
        return false
    }
  })
}

function messagesAllowed(value: unknown, protocol: Protocol): boolean {
  if (protocol === "openai-responses" && typeof value === "string") return true
  if (!Array.isArray(value)) return false
  return value.every((item: unknown) => {
    const message = object(item)
    if (message === undefined) return false
    if (protocol === "openai-responses") {
      // Replay inlined content without permitting references to stored provider records.
      delete message["id"]
      if (message["type"] === "function_call")
        return allowedKeys(message, ["type", "call_id", "name", "arguments", "namespace"])
      if (message["type"] === "function_call_output")
        return (
          contentAllowed(message["output"], protocol) &&
          allowedKeys(message, ["type", "call_id", "output"])
        )
      if (message["type"] === "reasoning") {
        const summary = message["summary"]
        return (
          allowedKeys(message, ["type", "summary", "encrypted_content"]) &&
          typeof message["encrypted_content"] === "string" &&
          Array.isArray(summary) &&
          summary.every((entry: unknown) => {
            const part = object(entry)
            return (
              part !== undefined &&
              part["type"] === "summary_text" &&
              typeof part["text"] === "string" &&
              allowedKeys(part, ["type", "text"])
            )
          })
        )
      }
      if (message["type"] !== undefined && message["type"] !== "message") return false
      return (
        ["developer", "system", "user", "assistant"].includes(String(message["role"])) &&
        allowedKeys(message, ["type", "role", "content", "status", "phase"]) &&
        contentAllowed(message["content"], protocol)
      )
    }
    if (protocol === "anthropic-messages")
      return (
        ["user", "assistant"].includes(String(message["role"])) &&
        allowedKeys(message, ["role", "content"]) &&
        contentAllowed(message["content"], protocol)
      )
    if (
      !["developer", "system", "user", "assistant", "tool"].includes(String(message["role"])) ||
      !allowedKeys(message, [
        "role",
        "content",
        "name",
        "tool_call_id",
        "tool_calls",
        "reasoning_content",
      ]) ||
      (message["reasoning_content"] !== undefined &&
        typeof message["reasoning_content"] !== "string")
    )
      return false
    const calls = message["tool_calls"]
    if (
      calls !== undefined &&
      (!Array.isArray(calls) ||
        calls.some((item: unknown) => {
          const call = object(item)
          const fn = object(call?.["function"])
          return (
            call === undefined ||
            fn === undefined ||
            call["type"] !== "function" ||
            !allowedKeys(call, ["type", "id", "function"]) ||
            !allowedKeys(fn, ["name", "arguments"])
          )
        }))
    )
      return false
    return (
      (calls !== undefined && message["content"] == null) ||
      contentAllowed(message["content"], protocol)
    )
  })
}

function functionTools(value: unknown, protocol: Protocol): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((item: unknown) => {
    const tool = object(item)
    if (tool === undefined) return false
    if (protocol === "anthropic-messages")
      return (
        (tool["type"] === undefined || tool["type"] === "custom") &&
        allowedKeys(tool, [
          "type",
          "name",
          "description",
          "input_schema",
          "cache_control",
          "strict",
        ])
      )
    if (tool["type"] !== "function") return false
    if (protocol === "openai-responses")
      return allowedKeys(tool, ["type", "name", "description", "parameters", "strict"])
    const fn = object(tool["function"])
    return (
      fn !== undefined &&
      allowedKeys(tool, ["type", "function"]) &&
      allowedKeys(fn, ["name", "description", "parameters", "strict"])
    )
  })
}

function localToolChoice(value: unknown, protocol: Protocol): boolean {
  if (value === undefined) return true
  if (typeof value === "string")
    return protocol !== "anthropic-messages" && ["auto", "none", "required"].includes(value)
  const choice = object(value)
  if (choice === undefined) return false
  const type = choice["type"]
  if (protocol === "anthropic-messages") {
    if (type === "tool")
      return (
        typeof choice["name"] === "string" &&
        allowedKeys(choice, ["type", "name", "disable_parallel_tool_use"])
      )
    return (
      ["auto", "any", "none"].includes(String(type)) &&
      allowedKeys(choice, ["type", "disable_parallel_tool_use"])
    )
  }
  if (protocol === "openai-responses") {
    if (type === "function")
      return typeof choice["name"] === "string" && allowedKeys(choice, ["type", "name"])
    const tools = choice["tools"]
    return (
      type === "allowed_tools" &&
      allowedKeys(choice, ["type", "mode", "tools"]) &&
      ["auto", "none", "required"].includes(String(choice["mode"])) &&
      Array.isArray(tools) &&
      tools.every(
        (tool: unknown) => object(tool)?.["type"] === "function" && localToolChoice(tool, protocol),
      )
    )
  }
  const fn = object(choice["function"])
  return (
    type === "function" &&
    fn !== undefined &&
    typeof fn["name"] === "string" &&
    allowedKeys(choice, ["type", "function"]) &&
    allowedKeys(fn, ["name"])
  )
}

function normalizeBody(body: Payload, route: ProviderRelayRoute): boolean {
  const protocol = route.protocol
  if (body["stream"] !== undefined && typeof body["stream"] !== "boolean") return false
  if (!functionTools(body["tools"], protocol) || !localToolChoice(body["tool_choice"], protocol))
    return false
  const common = ["model", "stream", "tools", "tool_choice", "temperature", "top_p"]
  let tokenField: string
  switch (protocol) {
    case "openai-chat":
      if (
        !allowedKeys(body, [
          ...common,
          "messages",
          "max_tokens",
          "max_completion_tokens",
          "stream_options",
          "stop",
          "frequency_penalty",
          "presence_penalty",
          "parallel_tool_calls",
          "reasoning_effort",
          "verbosity",
          "seed",
          "store",
          "prompt_cache_key",
        ])
      )
        return false
      if (!messagesAllowed(body["messages"], protocol)) return false
      if (body["max_completion_tokens"] !== undefined && body["max_tokens"] !== undefined)
        return false
      tokenField =
        body["max_completion_tokens"] !== undefined ||
        (body["max_tokens"] === undefined && route.endpoint.hostname === "api.openai.com")
          ? "max_completion_tokens"
          : "max_tokens"
      delete body["prompt_cache_key"]
      delete body["store"]
      if (route.endpoint.hostname === "api.openai.com") body["store"] = false
      delete body["stream_options"]
      if (body["stream"] === true) body["stream_options"] = { include_usage: true }
      break
    case "openai-responses":
      if (
        !allowedKeys(body, [
          ...common,
          "input",
          "max_output_tokens",
          "instructions",
          "parallel_tool_calls",
          "reasoning",
          "text",
          "store",
          "include",
          "prompt_cache_key",
          "frequency_penalty",
          "presence_penalty",
          "truncation",
        ])
      )
        return false
      if (!messagesAllowed(body["input"], protocol)) return false
      if (
        body["include"] !== undefined &&
        (!Array.isArray(body["include"]) ||
          body["include"].some((value: unknown) => value !== "reasoning.encrypted_content"))
      )
        return false
      tokenField = "max_output_tokens"
      delete body["prompt_cache_key"]
      body["store"] = false
      break
    case "anthropic-messages":
      if (
        !allowedKeys(body, [
          ...common,
          "messages",
          "system",
          "max_tokens",
          "top_k",
          "stop_sequences",
          "thinking",
          "output_config",
          "cache_control",
        ])
      )
        return false
      if (!messagesAllowed(body["messages"], protocol)) return false
      if (body["system"] !== undefined && !contentAllowed(body["system"], protocol, true))
        return false
      tokenField = "max_tokens"
  }
  const limit = body[tokenField] ?? route.maxOutputTokens
  if (!integer(limit, 1, route.maxOutputTokens)) return false
  body[tokenField] = limit
  return true
}

interface Counter {
  requests: number
  inputTokens: number
  outputTokens: number
}

function countUsage(record: Payload, usage: Counter): void {
  const response = object(record["response"])
  const message = object(record["message"])
  const counts = object(record["usage"] ?? response?.["usage"] ?? message?.["usage"])
  if (counts === undefined) return
  const input = counts["input_tokens"] ?? counts["prompt_tokens"]
  const output = counts["output_tokens"] ?? counts["completion_tokens"]
  if (integer(input, 0, Number.MAX_SAFE_INTEGER))
    usage.inputTokens = Math.max(usage.inputTokens, input)
  if (integer(output, 0, Number.MAX_SAFE_INTEGER))
    usage.outputTokens = Math.max(usage.outputTokens, output)
}

function addCounts(target: Counter, current: Counter) {
  target.inputTokens = Math.min(Number.MAX_SAFE_INTEGER, target.inputTokens + current.inputTokens)
  target.outputTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    target.outputTokens + current.outputTokens,
  )
}

function upstreamData(value: string, usage: Counter, credential: string) {
  const payload = object(JSON.parse(value))
  if (
    payload === undefined ||
    payload["error"] != null ||
    ["error", "response.failed"].includes(String(payload["type"]))
  )
    throw new Error("invalid provider response")
  if (value.includes(credential) || JSON.stringify(payload).includes(credential))
    throw new Error("invalid provider response")
  countUsage(payload, usage)
}

async function copyResponse(
  upstream: UpstreamResponse,
  response: ServerResponse,
  signal: AbortSignal,
  stream: boolean,
  usage: Counter,
  credential: string,
) {
  const expected = stream ? "text/event-stream" : "application/json"
  if (
    upstream.status !== 200 ||
    upstream.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== expected
  )
    throw new Error("invalid provider response")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let size = 0
  let pending = ""
  response.setHeader("content-type", expected)
  response.setHeader("connection", "close")
  for await (const chunk of upstream.body) {
    signal.throwIfAborted()
    size += chunk.byteLength
    if (size > responseLimit) throw new Error("provider response too large")
    pending += decoder.decode(chunk, { stream: true })
    if (!stream) continue
    for (
      let delimiter = /\r?\n\r?\n/.exec(pending);
      delimiter !== null;
      delimiter = /\r?\n\r?\n/.exec(pending)
    ) {
      if (delimiter.index > streamFrameLimit) throw new Error("provider event too large")
      const frame = pending.slice(0, delimiter.index)
      if (frame.includes(credential)) throw new Error("invalid provider response")
      pending = pending.slice(delimiter.index + delimiter[0].length)
      const lines = frame.split(/\r?\n/)
      if (lines.some((line) => /^event:\s*(error|response\.failed)\s*$/.test(line)))
        throw new Error("provider stream error")
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data.length > 0 && data !== "[DONE]") upstreamData(data, usage, credential)
      if (!response.write(frame + delimiter[0])) await once(response, "drain", { signal })
    }
    if (pending.length > streamFrameLimit) throw new Error("provider event too large")
  }
  pending += decoder.decode()
  if (stream) {
    if (pending.trim() !== "" || !response.headersSent)
      throw new Error("incomplete provider stream")
    response.end()
  } else {
    upstreamData(pending, usage, credential)
    response.end(pending)
  }
}

function safeError(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  if (!response.destroyed)
    response
      .writeHead(status, { "content-type": "application/json", connection: "close" })
      .end(JSON.stringify({ error: { message } }))
}

function authenticated(
  headers: IncomingMessage["headers"],
  capability: Buffer,
  protocol: Protocol,
) {
  const authorization = headers["authorization"]
  const apiKey = headers["x-api-key"]
  const value =
    protocol === "anthropic-messages" && authorization === undefined
      ? apiKey
      : apiKey === undefined && authorization?.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined
  if (typeof value !== "string") return false
  const presented = Buffer.from(value)
  return presented.length === capability.length && timingSafeEqual(presented, capability)
}

function validHeaders(request: IncomingMessage) {
  const seen = new Set<string>()
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase() ?? ""
    if (
      seen.has(name) ||
      name === "forwarded" ||
      name === "via" ||
      name === "upgrade" ||
      name === "trailer" ||
      name === "content-encoding" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("proxy-")
    )
      return false
    seen.add(name)
  }
  return (
    request.headers.host === guestAuthority &&
    (request.headers.origin === undefined ||
      request.headers.origin === `http://${guestAuthority}`) &&
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  )
}

async function readRequest(request: IncomingMessage, signal: AbortSignal) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted()
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > requestLimit) return undefined
    chunks.push(bytes)
  }
  return object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))),
  )
}

function untilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
    void value.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

export async function startProviderRelay(
  options: ProviderRelayOptions,
  dependencies: ProviderRelayDependencies = {},
) {
  const maxRequests = options.maxRequests ?? 40
  const timeoutMs = options.timeoutMs ?? 120_000
  if (
    !integer(maxRequests, 1, 1000) ||
    !integer(timeoutMs, 1, 600_000) ||
    !/^[a-zA-Z0-9_-]{43,128}$/.test(options.capability) ||
    options.routes.length === 0 ||
    options.routes.length > 8
  )
    throw new Error("invalid provider relay configuration")
  const directory = lstatSync(dirname(options.socketPath))
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error("provider relay socket requires a private host directory")
  const capability = Buffer.from(options.capability)
  const resolve =
    dependencies.resolve ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true })).map(({ address }) => address))
  const dispatch = dependencies.request ?? requestUpstream
  const pins = new Map<string, Promise<string>>()
  const routes = new Map<string, { route: ProviderRelayRoute; counters: Map<string, Counter> }>()
  for (const configured of options.routes) {
    const endpoint = new URL(configured.endpoint.href)
    const requestPath = `/relay/${configured.id}${suffix[configured.protocol]}`
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(configured.id) ||
      !Object.hasOwn(suffix, configured.protocol) ||
      routes.has(requestPath) ||
      endpoint.protocol !== "https:" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.pathname.endsWith(suffix[configured.protocol]) ||
      isIP(endpoint.hostname) !== 0 ||
      !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(endpoint.hostname) ||
      !/^[!-~]{1,4096}$/.test(configured.credential) ||
      configured.credential === options.capability ||
      !integer(configured.maxOutputTokens, 1, 256_000) ||
      configured.models.length === 0 ||
      configured.models.length > 32 ||
      configured.models.some((model) => !/^[a-zA-Z0-9._:/-]{1,200}$/.test(model))
    )
      throw new Error("invalid provider relay route")
    routes.set(requestPath, {
      route: { ...configured, endpoint },
      counters: new Map(
        configured.models.map((model) => [model, { requests: 0, inputTokens: 0, outputTokens: 0 }]),
      ),
    })
  }

  const total: Counter = { requests: 0, inputTokens: 0, outputTokens: 0 }
  const lifetime = new AbortController()
  let concurrent = 0
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5_000, requestTimeout: 15_000 },
    async (request, response) => {
      const entry = routes.get(request.url ?? "")
      if (request.method !== "POST" || entry === undefined)
        return safeError(response, 404, "unknown provider route")
      if (!validHeaders(request)) return safeError(response, 400, "invalid provider headers")
      const { route, counters } = entry
      if (!authenticated(request.headers, capability, route.protocol))
        return safeError(response, 401, "invalid provider capability")
      if (total.requests >= maxRequests || concurrent >= concurrentLimit)
        return safeError(response, 429, "provider request budget exhausted")
      if (Number(request.headers["content-length"]) > requestLimit)
        return safeError(response, 413, "provider request too large")
      request.socket.setTimeout(0)
      concurrent++
      let upstream: UpstreamResponse | undefined
      const client = new AbortController()
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([lifetime.signal, client.signal, timeout])
      const disconnect = () => client.abort()
      const cancel = () => {
        if (!request.complete) request.destroy()
        upstream?.cancel()
      }
      response.once("close", disconnect)
      signal.addEventListener("abort", cancel, { once: true })
      try {
        let body: Payload | undefined
        try {
          body = await readRequest(request, signal)
        } catch {
          return safeError(response, 400, "invalid provider request body")
        }
        if (body === undefined) return safeError(response, 400, "invalid provider request body")
        const model = body["model"]
        const counter = typeof model === "string" ? counters.get(model) : undefined
        if (counter === undefined || !normalizeBody(body, route))
          return safeError(response, 400, "provider model or parameters denied")
        if (total.requests >= maxRequests)
          return safeError(response, 429, "provider request budget exhausted")
        total.requests++
        counter.requests++
        const hostname = route.endpoint.hostname
        let pinned = pins.get(hostname)
        if (pinned === undefined) {
          pinned = resolve(hostname).then((addresses) => {
            if (addresses.length === 0 || !addresses.every(publicAddress))
              throw new Error("provider address denied")
            return addresses.find((value) => isIP(value) === 4) ?? addresses[0]!
          })
          pins.set(hostname, pinned)
        }
        const address = await untilAborted(pinned, signal)
        signal.throwIfAborted()
        const data = Buffer.from(JSON.stringify(body))
        const headers: Record<string, string> = {
          host: route.endpoint.host,
          "content-type": "application/json",
          "content-length": String(data.length),
          accept: body["stream"] === true ? "text/event-stream" : "application/json",
          "accept-encoding": "identity",
          connection: "close",
        }
        if (route.protocol === "anthropic-messages") {
          headers["x-api-key"] = route.credential
          headers["anthropic-version"] = "2023-06-01"
        } else {
          headers["authorization"] = `Bearer ${route.credential}`
        }
        const result = await untilAborted(
          dispatch({
            endpoint: new URL(route.endpoint),
            address,
            headers,
            body: data,
            signal,
          }).then((result) => {
            if (signal.aborted) result.cancel()
            return result
          }),
          signal,
        )
        upstream = result
        if (result.status === 401 || result.status === 403) {
          safeError(response, result.status, "provider authentication or access denied")
          return
        }
        if (result.status === 429) {
          safeError(response, 429, "provider rate limit reached")
          return
        }
        const usage: Counter = { requests: 0, inputTokens: 0, outputTokens: 0 }
        try {
          await untilAborted(
            copyResponse(
              result,
              response,
              signal,
              body["stream"] === true,
              usage,
              route.credential,
            ),
            signal,
          )
        } finally {
          addCounts(counter, usage)
          addCounts(total, usage)
        }
      } catch {
        safeError(
          response,
          timeout.aborted ? 504 : 502,
          timeout.aborted ? "provider request timed out" : "provider request failed",
        )
      } finally {
        concurrent--
        upstream?.cancel()
        signal.removeEventListener("abort", cancel)
        response.removeListener("close", disconnect)
      }
    },
  )
  server.on("connect", (_request, socket) => socket.destroy())
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.on("checkContinue", (_request, response) =>
    safeError(response, 417, "provider expectation denied"),
  )
  server.on("checkExpectation", (_request, response) =>
    safeError(response, 417, "provider expectation denied"),
  )
  server.maxConnections = 8
  server.setTimeout(15_000, (socket) => socket.destroy())
  try {
    server.listen(options.socketPath)
    await once(server, "listening")
    chmodSync(options.socketPath, 0o600)
  } catch {
    server.close()
    throw new Error("could not bind the private provider relay socket")
  }
  return {
    stop() {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      server.close()
      server.closeAllConnections()
    },
    usage: {
      get requests() {
        return total.requests
      },
      get inputTokens() {
        return total.inputTokens
      },
      get outputTokens() {
        return total.outputTokens
      },
      get models() {
        return [...routes.values()].flatMap(({ route, counters }) =>
          [...counters].map(([model, count]) => ({ routeId: route.id, model, ...count })),
        )
      },
    },
  }
}
