import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { complete, ProviderRequestError } from "../../src/standalone/provider.ts"
import { BUILTIN_TOOL_DEFINITIONS } from "../../src/standalone/tools.ts"
import type { StandaloneConfig } from "../../src/standalone/types.ts"

async function startFakeServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
) {
  const requests: { url: string | undefined; headers: IncomingMessage["headers"]; body: string }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      requests.push({ url: req.url, headers: req.headers, body })
      handler(req, body, res)
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const addr = server.address() as { port: number }
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function makeConfig(baseURL: string, cred: StandaloneConfig["credential"] = { kind: "none" }): StandaloneConfig {
  return {
    version: 1,
    endpointType: "local",
    baseURL,
    model: "test-coder-1",
    credential: cred,
    updatedAt: "2026-11-25T00:00:00.000Z",
  }
}

test("provider sends exact chat-completions framing and tool schemas to configured endpoint", async () => {
  const srv = await startFakeServer((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    )
  })
  try {
    const completion = await complete({
      config: makeConfig(srv.baseURL, { kind: "env", variable: "MY_CUSTOM_KEY" }),
      messages: [{ role: "user", content: "say OK" }],
      tools: BUILTIN_TOOL_DEFINITIONS,
      env: { MY_CUSTOM_KEY: "token-abc-123", OPENAI_API_KEY: "sk-wrong-key-99999999" },
    })
    assert.equal(completion.text, "OK")
    assert.equal(completion.finishReason, "stop")
    assert.equal(completion.usage?.totalTokens, 15)
    assert.equal(srv.requests.length, 1)
    assert.equal(srv.requests[0]!.url, "/v1/chat/completions")
    assert.equal(srv.requests[0]!.headers["authorization"], "Bearer token-abc-123")
    const parsed = JSON.parse(srv.requests[0]!.body) as { model: string; tools: { function: { name: string } }[] }
    assert.equal(parsed.model, "test-coder-1")
    assert.deepEqual(
      parsed.tools.map((t) => t.function.name),
      ["list_files", "read_file", "edit_file", "run_command"],
    )
  } finally {
    await srv.close()
  }
})

test("provider missing configured key fails before making any HTTP request", async () => {
  const srv = await startFakeServer((_req, _body, res) => {
    res.writeHead(200)
    res.end("{}")
  })
  try {
    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL, { kind: "env", variable: "MY_MISSING_KEY" }),
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          env: { OPENAI_API_KEY: "sk-ignored-fallback-key" },
        }),
      (err: unknown) =>
        err instanceof ProviderRequestError &&
        err.kind === "credential_missing" &&
        err.message.includes("MY_MISSING_KEY"),
    )
    assert.equal(srv.requests.length, 0)
  } finally {
    await srv.close()
  }
})

test("provider reads key-file credential without exposing secret in errors", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-keyfile-"))
  const keyFile = path.join(dir, "api.key")
  const secret = "bw-secret-file-value-xyz789"
  writeFileSync(keyFile, `${secret}\n`)
  if (process.platform !== "win32") chmodSync(keyFile, 0o600)
  const srv = await startFakeServer((_req, _body, res) => {
    res.writeHead(401, { "content-type": "text/plain" })
    res.end(`Rejected bearer ${secret}`)
  })
  try {
    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL, { kind: "file", path: keyFile }),
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }),
      (err: unknown) =>
        err instanceof ProviderRequestError &&
        err.kind === "unauthorized" &&
        !err.message.includes(secret) &&
        err.message.includes("[REDACTED]"),
    )
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("provider handles 302 redirect, 429 rate limit, malformed JSON, timeout, oversized body, and cancel", async () => {
  const secret = "bw-no-forward-secret"
  const srv = await startFakeServer((req, body, res) => {
    const parsed = JSON.parse(body || "{}") as { messages?: { content?: string }[] }
    const mode = parsed.messages?.[0]?.content
    if (mode === "redirect") {
      res.writeHead(302, { Location: "https://evil.invalid/steal" })
      res.end()
    } else if (mode === "ratelimit") {
      res.writeHead(429)
      res.end("slow down")
    } else if (mode === "badjson") {
      res.writeHead(200)
      res.end("{not-json")
    } else if (mode === "huge") {
      res.writeHead(200)
      res.end("x".repeat(4096))
    } else if (mode === "slow") {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200)
          res.end("{}")
        }
      }, 500)
    } else {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      )
    }
  })

  try {
    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL, { kind: "env", variable: "K" }),
          messages: [{ role: "user", content: "redirect" }],
          tools: [],
          env: { K: secret },
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "redirect_refused",
    )

    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL),
          messages: [{ role: "user", content: "ratelimit" }],
          tools: [],
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "rate_limit" && e.retryable,
    )

    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL),
          messages: [{ role: "user", content: "badjson" }],
          tools: [],
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "malformed_response",
    )

    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL),
          messages: [{ role: "user", content: "huge" }],
          tools: [],
          maxResponseBytes: 512,
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "response_too_large",
    )

    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL),
          messages: [{ role: "user", content: "slow" }],
          tools: [],
          timeoutMs: 60,
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "timeout",
    )

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    await assert.rejects(
      () =>
        complete({
          config: makeConfig(srv.baseURL),
          messages: [{ role: "user", content: "slow" }],
          tools: [],
          signal: ac.signal,
        }),
      (e: unknown) => e instanceof ProviderRequestError && e.kind === "cancelled",
    )

    const badTool = await complete({
      config: makeConfig(srv.baseURL),
      messages: [{ role: "user", content: "invalid-tool-json" }],
      tools: BUILTIN_TOOL_DEFINITIONS,
    })
    assert.equal(badTool.toolCalls.length, 0)
    assert.equal(badTool.toolInputErrors.length, 1)
    assert.equal(badTool.toolInputErrors[0]!.name, "read_file")
  } finally {
    await srv.close()
  }
})
