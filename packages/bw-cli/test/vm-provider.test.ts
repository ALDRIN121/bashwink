import { expect, test } from "bun:test"
import { vmProviderSelection } from "../src/vm-provider.js"
import type { RuntimeConfig } from "../src/providers.js"

const secret = "synthetic-host-provider-value"
const env = { FIXTURE_KEY: secret }

function config(
  endpoint = "https://api.commandcode.ai/provider/v1",
  model = "first",
): RuntimeConfig {
  return {
    model: "example/" + model,
    providers: {
      example: {
        env: ["FIXTURE_KEY"],
        settings: { baseURL: endpoint },
        package: "@opencode/ai/providers/openai/chat",
        models: {
          first: {},
          second: { package: "@opencode/ai/providers/anthropic" },
        },
      },
    },
  }
}

test("VM provider selection separates route credentials from guest model configuration", () => {
  const run = vmProviderSelection(config(), "example", env)
  expect(run.routes.map((route) => route.credential)).toEqual([secret, secret])
  expect(JSON.stringify(run.guest)).not.toContain(secret)
  expect(JSON.stringify(run.guest)).not.toContain("FIXTURE_KEY")
  expect(run.guest.defaultModel).toBe("example-openai-chat/first")
  const switched = vmProviderSelection(config(undefined, "second"), "example", env)
  expect(switched.guest.defaultModel).toBe("example-anthropic-messages/second")
  expect(switched.binding).toBe(run.binding)
  expect(switched.guest.capability).not.toBe(run.guest.capability)
  expect(run.maxRequests).toBe(8)
})

test("VM provider selection rejects redirects and unapproved endpoint variants before reading a key", () => {
  for (const url of [
    "http://api.commandcode.ai/provider/v1",
    "https://api.commandcode.ai.example.invalid/provider/v1",
    "https://127.0.0.1/v1",
    "https://api.commandcode.ai/provider/v1?redirect=true",
    "https://user@api.commandcode.ai/provider/v1",
  ])
    expect(() => vmProviderSelection(config(url), "example", {})).toThrow("destination")
  expect(() => vmProviderSelection(config(), "example", {})).toThrow("credential")
  expect(() => vmProviderSelection(config(undefined, "unknown"), "example", env)).toThrow("model")
  expect(() =>
    vmProviderSelection(config(), "example", { ...env, BASHWINK_VM_MAX_REQUESTS: "99" }),
  ).toThrow("BASHWINK_VM_MAX_REQUESTS")
})
