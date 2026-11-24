import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const capability = "a".repeat(64)
const routes = [
  {
    id: "0",
    provider: "fixture",
    model: "chat",
    protocol: "openai-chat",
    context: 32768,
    output: 4096,
  },
  {
    id: "1",
    provider: "fixture",
    model: "test/responses",
    protocol: "openai-responses",
    context: 16384,
    output: 2048,
  },
  {
    id: "2",
    provider: "fixture",
    model: "messages",
    protocol: "anthropic-messages",
    context: 8192,
    output: 1024,
  },
]

function withGuest(
  run: (
    runGuest: (mode: string, request: object) => ReturnType<typeof Bun.spawnSync>,
    config: string,
  ) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "bw-guest-project-"))
  try {
    const workspace = path.join(root, "workspace")
    const state = path.join(root, "state")
    mkdirSync(workspace)
    mkdirSync(state)
    run(
      (mode, request) =>
        Bun.spawnSync({
          cmd: [
            process.execPath,
            path.join(import.meta.dir, "vm-project-guest.ts"),
            mode,
            workspace,
            state,
          ],
          stdin: Buffer.from(JSON.stringify({ token: "fixture-project-1", files: {}, ...request })),
        }),
      path.join(state, "bw-relay.json"),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("relay restore configures only local routes and keeps the run capability out of snapshots", () => {
  withGuest((runGuest, config) => {
    const relay = { capability, defaultModel: "fixture/test/responses", routes }
    const restored = runGuest("restore", { relay })
    expect(restored.exitCode).toBe(0)
    expect(existsSync(config)).toBe(true)
    const runtime = JSON.parse(readFileSync(config, "utf8"))
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(runtime.model).toBe("fixture/test/responses")
    expect(runtime.providers.fixture.settings.apiKey).toBe(capability)
    expect(runtime.providers.fixture.models).toEqual({
      chat: {
        modelID: "chat",
        package: "@opencode/ai/providers/openai/chat",
        settings: { baseURL: "http://127.0.0.1:8118/relay/0" },
        limit: { context: 32768, output: 4096 },
      },
      "test/responses": {
        modelID: "test/responses",
        package: "@opencode/ai/providers/openai/responses",
        settings: { baseURL: "http://127.0.0.1:8118/relay/1" },
        limit: { context: 16384, output: 2048 },
      },
      messages: {
        modelID: "messages",
        package: "@opencode/ai/providers/anthropic",
        settings: { baseURL: "http://127.0.0.1:8118/relay/2" },
        limit: { context: 8192, output: 1024 },
      },
    })
    const snapshot = runGuest("snapshot", { relay })
    expect(snapshot.exitCode).toBe(0)
    expect(JSON.parse(snapshot.stdout.toString().slice(4096)).state).toEqual({})
  })
})

test("relay restore rejects malformed routes before launching a runtime", () => {
  for (const relay of [
    { capability, defaultModel: "fixture/unlisted", routes },
    { capability, defaultModel: "fixture/chat", routes: [...routes, { ...routes[0], id: "99" }] },
    { capability, defaultModel: "fixture/chat", routes: [routes[0], { ...routes[1], id: "0" }] },
    {
      capability,
      defaultModel: "fixture/chat",
      routes: [{ ...routes[0], baseURL: "https://example.invalid" }],
    },
  ]) {
    withGuest((runGuest, config) => {
      const restored = runGuest("restore", { relay })
      expect(restored.exitCode).not.toBe(0)
      expect(restored.stderr.toString()).not.toContain(capability)
      expect(existsSync(config)).toBe(false)
    })
  }
})

test("relay restore permits two models on the same provider route", () => {
  withGuest((runGuest, config) => {
    const shared = [{ ...routes[0] }, { ...routes[0], model: "another-chat" }]
    const restored = runGuest("restore", {
      relay: { capability, defaultModel: "fixture/chat", routes: shared },
    })
    expect(restored.exitCode).toBe(0)
    const runtime = JSON.parse(readFileSync(config, "utf8"))
    expect(runtime.providers.fixture.models["another-chat"].settings.baseURL).toBe(
      "http://127.0.0.1:8118/relay/0",
    )
  })
})
