import { expect } from "bun:test"
import { posixTest } from "./platform.js"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startProviderRelay } from "../src/provider-relay.js"
import type { ProviderRelayDependencies } from "../src/provider-relay.js"

const capability = "A".repeat(43)
const credential = "host-provider-secret"
const guestPath = "/relay/chat/chat/completions"
const valid = { model: "allowed-model", messages: [{ role: "user", content: "hello" }] }

function post(
  socketPath: string,
  options: { path?: string; headers?: Record<string, string>; body?: object } = {},
) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const body = JSON.stringify(options.body ?? valid)
    const outgoing = request(
      {
        socketPath,
        path: options.path ?? guestPath,
        method: "POST",
        headers: {
          host: "127.0.0.1:8118",
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...options.headers,
        },
      },
      async (response) => {
        try {
          const chunks = []
          for await (const chunk of response) chunks.push(chunk)
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() })
        } catch (error) {
          reject(error)
        }
      },
    )
    // The server may answer an oversized request and close before the client finishes writing it; Linux then
    // reports EPIPE on the write while the response is still on its way. Give the response a moment to arrive.
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET")
        setTimeout(() => reject(error), 500)
      else reject(error)
    })
    outgoing.end(body)
  })
}

async function fixture(
  dependencies: ProviderRelayDependencies,
  check: (socket: string, relay: Awaited<ReturnType<typeof startProviderRelay>>) => Promise<void>,
  timeoutMs = 120_000,
) {
  const directory = mkdtempSync(join(tmpdir(), "bw-pr-"))
  const socketPath = join(directory, "r.sock")
  try {
    const relay = await startProviderRelay(
      {
        socketPath,
        capability,
        routes: [
          {
            id: "chat",
            endpoint: new URL("https://api.example.com/v1/chat/completions"),
            credential,
            protocol: "openai-chat",
            models: ["allowed-model"],
            maxOutputTokens: 20,
          },
          {
            id: "responses",
            endpoint: new URL("https://api.example.com/v1/responses"),
            credential,
            protocol: "openai-responses",
            models: ["allowed-model"],
            maxOutputTokens: 20,
          },
          {
            id: "messages",
            endpoint: new URL("https://api.example.com/v1/messages"),
            credential,
            protocol: "anthropic-messages",
            models: ["allowed-model"],
            maxOutputTokens: 20,
          },
        ],
        maxRequests: 2,
        timeoutMs,
      },
      dependencies,
    )
    try {
      await check(socketPath, relay)
    } finally {
      relay.stop()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function* text(value: string) {
  yield Buffer.from(value)
}

const resolvePublic = async () => ["8.8.8.8"]

posixTest(
  "validates requests before selecting the pinned host and applying the host credential",
  async () => {
    const dispatched: Parameters<NonNullable<ProviderRelayDependencies["request"]>>[0][] = []
    await fixture(
      {
        resolve: resolvePublic,
        async request(request) {
          dispatched.push(request)
          return {
            status: 200,
            contentType: "application/json",
            body: text('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'),
            cancel() {},
          }
        },
      },
      async (socket, relay) => {
        expect(statSync(socket).mode & 0o777).toBe(0o600)
        expect(
          (await post(socket, { headers: { authorization: `Bearer ${credential}` } })).status,
        ).toBe(401)
        expect((await post(socket, { headers: { host: "other" } })).status).toBe(400)
        expect(
          (await post(socket, { headers: { origin: "https://unrelated.invalid" } })).status,
        ).toBe(400)
        expect((await post(socket, { headers: { forwarded: "host=other" } })).status).toBe(400)
        expect((await post(socket, { path: `${guestPath}?extra=1` })).status).toBe(404)
        expect((await post(socket, { body: { ...valid, model: "unknown" } })).status).toBe(400)
        expect((await post(socket, { body: { ...valid, max_tokens: 21 } })).status).toBe(400)
        expect(
          (await post(socket, { body: { ...valid, tools: [{ type: "web_search" }] } })).status,
        ).toBe(400)
        expect(
          (
            await post(socket, {
              body: {
                ...valid,
                messages: [
                  {
                    role: "user",
                    content: [{ type: "image_url", image_url: { url: "https://example.com" } }],
                  },
                ],
              },
            })
          ).status,
        ).toBe(400)
        expect(dispatched).toHaveLength(0)
        expect((await post(socket)).status).toBe(200)
        expect(dispatched[0]?.endpoint.href).toBe("https://api.example.com/v1/chat/completions")
        expect(dispatched[0]?.address).toBe("8.8.8.8")
        expect(dispatched[0]?.headers["authorization"]).toBe(`Bearer ${credential}`)
        expect(dispatched[0]?.body.toString()).not.toContain(capability)
        expect(JSON.parse(dispatched[0]!.body.toString()).max_tokens).toBe(20)
        expect(relay.usage.models.filter((entry) => entry.requests > 0)).toEqual([
          {
            routeId: "chat",
            model: "allowed-model",
            requests: 1,
            inputTokens: 3,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        ])
      },
    )
  },
)

posixTest("refuses oversized requests before dispatch", async () => {
  await fixture(
    {
      resolve: resolvePublic,
      async request() {
        throw new Error("unexpected dispatch")
      },
    },
    async (socket) => {
      const result = await post(socket, {
        body: { ...valid, messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] },
      })
      expect(result.status).toBe(413)
    },
  )
})

posixTest("rejects a capability from another run and revokes access after shutdown", async () => {
  let dispatches = 0
  await fixture(
    {
      resolve: resolvePublic,
      async request() {
        dispatches++
        return { status: 200, contentType: "application/json", body: text("{}"), cancel() {} }
      },
    },
    async (socket, relay) => {
      expect(
        (await post(socket, { headers: { authorization: `Bearer ${"B".repeat(43)}` } })).status,
      ).toBe(401)
      expect(dispatches).toBe(0)
      expect((await post(socket)).status).toBe(200)
      relay.stop()
      await Bun.sleep(25)
      await expect(post(socket)).rejects.toThrow()
      expect(dispatches).toBe(1)
    },
  )
})

posixTest("refuses oversized provider responses", async () => {
  await fixture(
    {
      resolve: resolvePublic,
      async request() {
        return {
          status: 200,
          contentType: "application/json",
          body: text("x".repeat(16 * 1024 * 1024 + 1)),
          cancel() {},
        }
      },
    },
    async (socket) => {
      expect((await post(socket)).status).toBe(502)
    },
  )
})

posixTest("aborts a stalled provider request at the configured deadline", async () => {
  let aborted = false
  await fixture(
    {
      resolve: resolvePublic,
      async request(input) {
        return await new Promise((_, reject) =>
          input.signal.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new Error("cancelled"))
            },
            { once: true },
          ),
        )
      },
    },
    async (socket) => {
      expect((await post(socket)).status).toBe(504)
      expect(aborted).toBe(true)
    },
    100,
  )
})

posixTest("cancels the upstream when a streaming client disconnects", async () => {
  let aborted = false
  let cancelled = false
  await fixture(
    {
      resolve: resolvePublic,
      async request(input) {
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true },
        )
        return {
          status: 200,
          contentType: "text/event-stream",
          body: (async function* () {
            yield Buffer.from('data: {"choices":[]}\n\n')
            await new Promise<void>((resolve) =>
              input.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          })(),
          cancel() {
            cancelled = true
          },
        }
      },
    },
    async (socket) => {
      const body = JSON.stringify({ ...valid, stream: true })
      await new Promise<void>((resolve, reject) => {
        const outgoing = request(
          {
            socketPath: socket,
            path: guestPath,
            method: "POST",
            headers: {
              host: "127.0.0.1:8118",
              authorization: `Bearer ${capability}`,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            },
          },
          (response) =>
            response.once("data", () => {
              response.destroy()
              resolve()
            }),
        )
        outgoing.on("error", reject)
        outgoing.end(body)
      })
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) await Bun.sleep(10)
      expect(aborted).toBe(true)
      expect(cancelled).toBe(true)
    },
  )
})

posixTest(
  "fails an interrupted upstream stream without reporting successful completion",
  async () => {
    let cancelled = false
    await fixture(
      {
        resolve: resolvePublic,
        async request() {
          return {
            status: 200,
            contentType: "text/event-stream",
            body: (async function* () {
              yield Buffer.from('data: {"choices":[]}\n\n')
              throw new Error("synthetic upstream interruption")
            })(),
            cancel() {
              cancelled = true
            },
          }
        },
      },
      async (socket) => {
        await expect(post(socket, { body: { ...valid, stream: true } })).rejects.toThrow()
        expect(cancelled).toBe(true)
      },
    )
  },
)

posixTest(
  "reports malformed and upstream server responses without exposing their bodies",
  async () => {
    let count = 0
    await fixture(
      {
        resolve: resolvePublic,
        async request() {
          return {
            status: ++count === 1 ? 200 : 503,
            contentType: "application/json",
            body: text(credential),
            cancel() {},
          }
        },
      },
      async (socket) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await post(socket)
          expect(result.status).toBe(502)
          expect(result.body).not.toContain(credential)
        }
      },
    )
  },
)

posixTest(
  "rejects a DNS result containing a nonpublic address without dispatching credentials",
  async () => {
    await fixture(
      {
        resolve: async () => ["8.8.8.8", "127.0.0.1"],
        async request() {
          throw new Error("unexpected upstream dispatch")
        },
      },
      async (socket) => {
        const result = await post(socket)
        expect(result.status).toBe(502)
        expect(result.body).not.toContain("unexpected upstream dispatch")
      },
    )
  },
)

posixTest(
  "suppresses upstream failures and limits dispatches, including failed requests",
  async () => {
    let calls = 0
    await fixture(
      {
        resolve: resolvePublic,
        async request() {
          calls++
          return { status: 307, contentType: "text/html", body: text(credential), cancel() {} }
        },
      },
      async (socket, relay) => {
        const refused = await post(socket)
        expect(refused.status).toBe(502)
        expect(refused.body).not.toContain(credential)
        expect((await post(socket)).status).toBe(502)
        expect((await post(socket)).status).toBe(429)
        expect(calls).toBe(2)
        expect(relay.usage.requests).toBe(2)
      },
    )
  },
)

posixTest(
  "reports upstream authentication and rate-limit statuses without upstream bodies",
  async () => {
    let calls = 0
    await fixture(
      {
        resolve: resolvePublic,
        async request() {
          return {
            status: ++calls === 1 ? 401 : 429,
            contentType: "application/json",
            body: text(credential),
            cancel() {},
          }
        },
      },
      async (socket) => {
        const auth = await post(socket)
        const rate = await post(socket)
        expect(auth.status).toBe(401)
        expect(rate.status).toBe(429)
        expect(auth.body + rate.body).not.toContain(credential)
      },
    )
  },
)

posixTest(
  "passes split stream chunks through and counts numeric final usage only once",
  async () => {
    await fixture(
      {
        resolve: resolvePublic,
        async request() {
          return {
            status: 200,
            contentType: "text/event-stream; charset=utf-8",
            body: (async function* () {
              yield Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":5,')
              yield Buffer.from('"completion_tokens":7}}\n\ndata: [DONE]\n\n')
            })(),
            cancel() {},
          }
        },
      },
      async (socket, relay) => {
        const result = await post(socket, { body: { ...valid, stream: true } })
        expect(result.status).toBe(200)
        expect(result.body).toContain("data: [DONE]")
        expect(relay.usage.inputTokens).toBe(5)
        expect(relay.usage.outputTokens).toBe(7)
      },
    )
  },
)

posixTest("attributes Anthropic cache input usage separately across stream events", async () => {
  await fixture(
    {
      resolve: resolvePublic,
      async request() {
        return {
          status: 200,
          contentType: "text/event-stream",
          body: text(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":80,"cache_creation_input_tokens":9}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
          ),
          cancel() {},
        }
      },
    },
    async (socket, relay) => {
      const result = await post(socket, {
        path: "/relay/messages/messages",
        body: {
          model: "allowed-model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      })
      expect(result.status).toBe(200)
      expect(relay.usage.inputTokens).toBe(2)
      expect(relay.usage.outputTokens).toBe(7)
      expect(relay.usage.cacheReadInputTokens).toBe(80)
      expect(relay.usage.cacheWriteInputTokens).toBe(9)
    },
  )
})

posixTest("does not return a provider credential reflected in a successful response", async () => {
  await fixture(
    {
      resolve: resolvePublic,
      async request() {
        return {
          status: 200,
          contentType: "application/json",
          body: text(JSON.stringify({ result: credential })),
          cancel() {},
        }
      },
    },
    async (socket) => {
      const result = await post(socket)
      expect(result.status).toBe(502)
      expect(result.body).not.toContain(credential)
    },
  )
})

posixTest(
  "keeps the first vetted address across routes and strips account-backed Responses options",
  async () => {
    let resolutions = 0
    const dispatched: Parameters<NonNullable<ProviderRelayDependencies["request"]>>[0][] = []
    await fixture(
      {
        async resolve() {
          return [++resolutions === 1 ? "8.8.8.8" : "127.0.0.1"]
        },
        async request(request) {
          dispatched.push(request)
          return {
            status: 200,
            contentType: "application/json",
            body: text('{"error":null,"usage":{"input_tokens":3,"output_tokens":2}}'),
            cancel() {},
          }
        },
      },
      async (socket) => {
        const responses = {
          path: "/relay/responses/responses",
          body: { model: "allowed-model", input: "hello", store: true },
        }
        expect(
          (
            await post(socket, {
              ...responses,
              body: { ...responses.body, previous_response_id: "resp_other" },
            })
          ).status,
        ).toBe(400)
        expect(
          (
            await post(socket, {
              ...responses,
              body: { ...responses.body, tool_choice: { type: "web_search" } },
            })
          ).status,
        ).toBe(400)
        expect((await post(socket, responses)).status).toBe(200)
        expect(JSON.parse(dispatched[0]!.body.toString()).store).toBe(false)
        expect((await post(socket)).status).toBe(200)
        expect(resolutions).toBe(1)
        expect(dispatched.map(({ address }) => address)).toEqual(["8.8.8.8", "8.8.8.8"])
      },
    )
  },
)

posixTest("rejects Anthropic hosted tools and uses the host-owned Messages headers", async () => {
  let observed: Readonly<Record<string, string>> | undefined
  await fixture(
    {
      resolve: resolvePublic,
      async request({ headers }) {
        observed = headers
        return {
          status: 200,
          contentType: "application/json",
          body: text('{"usage":{"input_tokens":3,"output_tokens":2}}'),
          cancel() {},
        }
      },
    },
    async (socket) => {
      const platform = {
        path: "/relay/messages/messages",
        headers: { authorization: "", "x-api-key": capability, "anthropic-version": "2000-01-01" },
      }
      expect(
        (
          await post(socket, {
            ...platform,
            headers: { ...platform.headers, "x-api-key": capability },
            body: { ...valid, tools: [{ type: "web_search_20250305", name: "web_search" }] },
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await post(socket, {
            path: platform.path,
            body: { ...valid, tools: [{ type: "web_search_20250305", name: "web_search" }] },
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await post(socket, {
            path: platform.path,
            headers: { "anthropic-version": "2000-01-01" },
          })
        ).status,
      ).toBe(200)
      expect(observed?.["anthropic-version"]).toBe("2023-06-01")
      expect(observed?.["x-api-key"]).toBe(credential)
      expect(observed?.["authorization"]).toBeUndefined()
    },
  )
})
