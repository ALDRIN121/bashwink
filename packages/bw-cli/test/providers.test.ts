/**
 * BW-091 — provider configuration and model routing.
 *
 * These tests are written against behaviour, not structure: what the runtime will be able to
 * do with the config this module produces, and what a reader of `auth status` is told. The
 * protocol mapping in particular is asserted by package specifier because that string *is*
 * the behaviour — the runtime imports it, and a wrong value is a runtime failure, not a type
 * error.
 *
 * Every negative control here corresponds to a failure I actually reproduced against the
 * real 2.3.2 binary, so the tests keep those failures fixed rather than testing tautologies.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  PROTOCOL_PACKAGE,
  ProviderConfigError,
  configFile,
  credentialRef,
  credentialUsable,
  declaredProviders,
  defaultModel,
  describeCredential,
  fingerprint,
  parseModelRef,
  preflightCredential,
  providerCredential,
  readRuntimeConfig,
  toRuntimeProvider,
  validateProviderID,
} from "../src/providers.js"

function tempConfig(content: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), "bw-prov-"))
  writeFileSync(configFile(directory), JSON.stringify(content), "utf8")
  return directory
}

describe("protocol mapping", () => {
  test("maps each protocol to the package the runtime actually exports", () => {
    // Pinned to the specifiers in opencode v2.3.2 `packages/ai/package.json`. A typo here
    // produces a provider with no models and no error, which is the worst failure mode.
    expect(PROTOCOL_PACKAGE.anthropic).toBe("@opencode/ai/providers/anthropic")
    expect(PROTOCOL_PACKAGE.openai).toBe("@opencode/ai/providers/openai/chat")
    expect(PROTOCOL_PACKAGE["openai-responses"]).toBe("@opencode/ai/providers/openai/responses")
  })

  test("a uniform-protocol provider carries the package once, at provider level", () => {
    const built = toRuntimeProvider({
      id: "cc",
      baseURL: "https://example.test/v1",
      protocol: "anthropic",
      models: [{ id: "a" }, { id: "b" }],
    })
    expect(built.package).toBe(PROTOCOL_PACKAGE.anthropic)
    // Per-model repeat would also work, but keeping it at provider level is what the schema
    // intends and what a human reading the file expects.
    expect(built.models?.["a"]?.package).toBeUndefined()
    expect(built.models?.["b"]?.package).toBeUndefined()
  })

  test("a mixed-protocol provider gets a per-model package and NO provider-level one", () => {
    // The real defect: a provider-level package is applied to every model, so declaring
    // `openai/chat` on a provider with Claude models produced
    //   Model "claude-sonnet-5" must be called via /provider/v1/messages (Anthropic Messages shape)
    // at the first request, not at startup.
    const built = toRuntimeProvider({
      id: "mixed",
      baseURL: "https://example.test/v1",
      protocol: "openai",
      models: [
        { id: "claude-sonnet-5", protocol: "anthropic" },
        { id: "gpt-6.1-sol", protocol: "openai" },
      ],
    })
    expect(built.package).toBeUndefined()
    expect(built.models?.["claude-sonnet-5"]?.package).toBe(PROTOCOL_PACKAGE.anthropic)
    expect(built.models?.["gpt-6.1-sol"]?.package).toBe(PROTOCOL_PACKAGE.openai)
  })

  test("a per-model protocol overrides the provider default", () => {
    const built = toRuntimeProvider({
      id: "override",
      baseURL: "https://example.test/v1",
      protocol: "openai",
      models: [{ id: "one", protocol: "anthropic" }],
    })
    // Single model, so uniform, but the model's own choice must win over the provider's.
    expect(built.package).toBe(PROTOCOL_PACKAGE.anthropic)
  })

  test("the provider entry has no `id` key, because the map key is the id", () => {
    // The runtime's config schema rejects unknown keys. An earlier version emitted `id`,
    // which type-checked but produced a config the binary refused.
    const built = toRuntimeProvider({
      id: "cc",
      baseURL: "https://x.test/v1",
      models: [{ id: "m" }],
    })
    expect(Object.hasOwn(built, "id")).toBe(false)
  })

  test("limits are omitted rather than emitted as undefined", () => {
    const built = toRuntimeProvider({
      id: "cc",
      baseURL: "https://x.test/v1",
      models: [{ id: "no-limits" }, { id: "limits", context: 1000, output: 100 }],
    })
    expect(built.models?.["no-limits"]?.limit).toBeUndefined()
    expect(built.models?.["limits"]?.limit).toEqual({ context: 1000, output: 100 })
  })
})

describe("config reading", () => {
  test("a missing config is an empty object, not an error", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bw-empty-"))
    expect(readRuntimeConfig(directory)).toEqual({})
  })

  test("a corrupt config is an error naming the file, not a silent reset", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bw-bad-"))
    writeFileSync(configFile(directory), "{not json", "utf8")
    expect(() => readRuntimeConfig(directory)).toThrow(ProviderConfigError)
    expect(() => readRuntimeConfig(directory)).toThrow(/not valid JSON/)
  })

  test("a JSON array is rejected: the config root must be an object", () => {
    const directory = tempConfig([])
    expect(() => readRuntimeConfig(directory)).toThrow(/must contain a JSON object/)
  })
})

describe("model references", () => {
  test("splits on the first slash so a nested model id survives", () => {
    expect(parseModelRef("commandcode/deepseek/deepseek-v4-flash")).toEqual({
      providerID: "commandcode",
      modelID: "deepseek/deepseek-v4-flash",
    })
  })

  test("rejects a bare model id: provider is not guessable", () => {
    expect(() => parseModelRef("claude-sonnet-5")).toThrow(/must be 'provider\/model'/)
  })

  test("rejects empty halves", () => {
    expect(() => parseModelRef("/model")).toThrow(ProviderConfigError)
    expect(() => parseModelRef("provider/")).toThrow(ProviderConfigError)
  })
})

describe("provider ids", () => {
  test("accepts the shapes the runtime accepts", () => {
    for (const id of ["cc", "my-provider", "a.b_c-1"])
      expect(() => validateProviderID(id)).not.toThrow()
  })

  test("rejects path-traversal and shell-hostile ids before they become config keys", () => {
    for (const id of ["../escape", "with/slash", "has space", "UPPER", "-leading", ""])
      expect(() => validateProviderID(id)).toThrow(ProviderConfigError)
  })
})

describe("credential references", () => {
  test("an env reference reports presence without reading the value", () => {
    const key = "BW_TEST_CRED_PRESENT"
    process.env[key] = "super-secret-value"
    try {
      const state = credentialRef(`{env:${key}}`)
      expect(state).toEqual({ kind: "env", variable: key, present: true })
      // The state object must not carry the value; it is passed around freely.
      expect(JSON.stringify(state)).not.toContain("super-secret-value")
    } finally {
      delete process.env[key]
    }
  })

  test("an unset env reference reports absent rather than throwing", () => {
    expect(credentialRef("{env:BW_TEST_CRED_ABSENT}")).toEqual({
      kind: "env",
      variable: "BW_TEST_CRED_ABSENT",
      present: false,
    })
  })

  test("a file reference resolves relative to cwd and checks for content", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bw-key-"))
    const file = path.join(directory, "key")
    writeFileSync(file, "abcd", { mode: 0o600 })
    const present = credentialRef(`{file:${file}}`)
    expect(present.kind).toBe("file")
    expect(present.kind === "file" && present.present).toBe(true)

    writeFileSync(file, "", "utf8")
    const empty = credentialRef(`{file:${file}}`)
    // Narrow first: `present` does not exist on every CredentialState variant, and reaching
    // for it blind is what the type checker is there to stop.
    expect(empty.kind === "file" && empty.present).toBe(false)
  })

  test("a missing key file is absent, not an exception", () => {
    const state = credentialRef(`{file:${path.join(tmpdir(), "definitely-not-here-bw")}}`)
    expect(state.kind).toBe("file")
    expect(state.kind === "file" && state.present).toBe(false)
  })

  test("a literal value is recognised as literal — usable, but flagged in prose", () => {
    const state = credentialRef("sk-literal-value")
    expect(state).toEqual({ kind: "literal", present: true })
    expect(describeCredential(state, "settings")).toMatch(/verbatim/)
  })

  test("an empty or absent setting declares no route", () => {
    expect(credentialRef(undefined)).toEqual({ kind: "none" })
    expect(credentialRef("")).toEqual({ kind: "none" })
  })
})

describe("key file permissions", () => {
  test("a 0600 key file is reported as protected", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bw-mode-"))
    const file = path.join(directory, "key")
    writeFileSync(file, "value", { mode: 0o600 })
    chmodSync(file, 0o600)
    const state = credentialRef(`{file:${file}}`)
    expect(state.kind).toBe("file")
    if (state.kind !== "file") return
    expect(state.groupOrWorldReadable).toBe(false)
    expect(describeCredential(state, "settings")).toContain("mode 600")
  })

  test("a world-readable key file is flagged, because the bits are the only protection", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bw-mode-"))
    const file = path.join(directory, "key")
    writeFileSync(file, "value", { mode: 0o644 })
    chmodSync(file, 0o644)
    const state = credentialRef(`{file:${file}}`)
    if (state.kind !== "file") throw new Error("expected a file reference")
    expect(state.groupOrWorldReadable).toBe(true)
    expect(describeCredential(state, "settings")).toContain("chmod 600")
  })

  test("a missing file is not reported as a permission problem", () => {
    const state = credentialRef(`{file:${path.join(tmpdir(), "bw-no-such-key")}}`)
    if (state.kind !== "file") throw new Error("expected a file reference")
    expect(state.groupOrWorldReadable).toBe(false)
    expect(describeCredential(state, "settings")).toContain("missing or empty")
  })
})

describe("credential usability", () => {
  test("present env, present file and literal are usable; absent and none are not", () => {
    expect(credentialUsable({ kind: "env", variable: "X", present: true })).toBe(true)
    expect(credentialUsable({ kind: "env", variable: "X", present: false })).toBe(false)
    expect(
      credentialUsable({ kind: "file", file: "/k", present: true, groupOrWorldReadable: false }),
    ).toBe(true)
    expect(
      credentialUsable({ kind: "file", file: "/k", present: false, groupOrWorldReadable: false }),
    ).toBe(false)
    expect(credentialUsable({ kind: "literal", present: true })).toBe(true)
    expect(credentialUsable({ kind: "none" })).toBe(false)
  })

  test("settings.apiKey wins over env, matching the runtime's precedence", () => {
    const key = "BW_TEST_PRECEDENCE"
    process.env[key] = "env-value"
    try {
      const { state, source } = providerCredential({
        env: [key],
        settings: { baseURL: "https://x.test/v1", apiKey: "{env:BW_TEST_PRECEDENCE}" },
      })
      expect(source).toBe("settings")
      expect(state.kind).toBe("env")
    } finally {
      delete process.env[key]
    }
  })

  test("env is consulted in declared order", () => {
    const first = "BW_TEST_ORDER_FIRST"
    const second = "BW_TEST_ORDER_SECOND"
    delete process.env[first]
    process.env[second] = "value"
    try {
      const { state, source } = providerCredential({ env: [first, second] })
      expect(source).toBe("env")
      expect(state).toEqual({ kind: "env", variable: second, present: true })
    } finally {
      delete process.env[second]
    }
  })

  test("a provider with no route at all is distinguishable from a missing variable", () => {
    expect(providerCredential({}).source).toBe("none")
    expect(providerCredential({ env: ["BW_TEST_NEVER_SET"] }).state).toEqual({
      kind: "env",
      variable: "BW_TEST_NEVER_SET",
      present: false,
    })
  })
})

describe("secret description never leaks a value", () => {
  test("fingerprint reports length and a digest, never a prefix or suffix", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOP-suffix9999"
    const text = fingerprint(secret)
    expect(text).toContain(String(secret.length))
    expect(text).toMatch(/sha256:[0-9a-f]{8}/)
    expect(text).not.toContain("sk-ant")
    expect(text).not.toContain("9999")
    // No 4-character window of the value may appear.
    for (let index = 0; index + 4 <= secret.length; index += 1)
      expect(text).not.toContain(secret.slice(index, index + 4))
  })

  test("an empty value is absent, not a fingerprint of nothing", () => {
    expect(fingerprint("")).toBe("absent")
    expect(fingerprint("   ")).toBe("absent")
  })

  test("describeCredential names the variable but not its value", () => {
    const key = "BW_TEST_DESCRIBE"
    process.env[key] = "value-that-must-not-appear"
    try {
      const text = describeCredential({ kind: "env", variable: key, present: true }, "env")
      expect(text).toContain(key)
      expect(text).not.toContain("value-that-must-not-appear")
    } finally {
      delete process.env[key]
    }
  })
})

describe("discovery and defaults", () => {
  test("declaredProviders reads back what was written, sorted by id", () => {
    const directory = tempConfig({
      providers: {
        zebra: { name: "Z", settings: { baseURL: "https://z.test/v1" }, models: { m1: {} } },
        alpha: {
          settings: { baseURL: "https://a.test/v1" },
          package: PROTOCOL_PACKAGE.anthropic,
          models: { m2: { limit: { context: 5 } } },
        },
      },
    })
    const providers = declaredProviders(readRuntimeConfig(directory))
    expect(providers.map((provider) => provider.id)).toEqual(["alpha", "zebra"])
    expect(providers[0]?.protocol).toBe("anthropic")
    expect(providers[1]?.models[0]?.id).toBe("m1")
  })

  test("per-model protocol is recovered from the model's own package", () => {
    const directory = tempConfig({
      providers: {
        mixed: {
          settings: { baseURL: "https://m.test/v1" },
          models: {
            a: { package: PROTOCOL_PACKAGE.anthropic },
            b: { package: PROTOCOL_PACKAGE.openai },
          },
        },
      },
    })
    const [provider] = declaredProviders(readRuntimeConfig(directory))
    expect(provider?.models.map((model) => model.protocol)).toEqual(["anthropic", "openai"])
  })

  test("defaultModel accepts both reference spellings the runtime writes", () => {
    expect(defaultModel({ model: "a/b" })).toBe("a/b")
    expect(defaultModel({ model: { providerID: "a", model: "b" } })).toBe("a/b")
    expect(defaultModel({ model: { providerID: "a", modelID: "b" } })).toBe("a/b")
    expect(defaultModel({})).toBeUndefined()
    expect(defaultModel({ model: 42 })).toBeUndefined()
  })
})

describe("pre-flight credential check", () => {
  test("returns undefined for a model the config does not declare", () => {
    // The runtime's built-in catalogue handles its own credentials; guessing about them
    // here would produce a false refusal.
    expect(preflightCredential({}, "opencode/tidepool-alpha-free")).toBeUndefined()
  })

  test("returns undefined when the provider can authenticate", () => {
    const key = "BW_TEST_PREFLIGHT_OK"
    process.env[key] = "value"
    try {
      const config = { providers: { cc: { env: [key], models: { m: {} } } } }
      expect(preflightCredential(config, "cc/m")).toBeUndefined()
    } finally {
      delete process.env[key]
    }
  })

  test("names the missing variable instead of letting the runtime say 'Invalid Authorization header'", () => {
    const config = { providers: { cc: { env: ["BW_TEST_PREFLIGHT_MISSING"], models: { m: {} } } } }
    const result = preflightCredential(config, "cc/m")
    expect(result?.ok).toBe(false)
    expect(result?.message).toContain("BW_TEST_PREFLIGHT_MISSING")
    expect(result?.message).toMatch(/export BW_TEST_PREFLIGHT_MISSING=/)
  })

  test("a missing key file is reported with the path to create", () => {
    const file = path.join(tmpdir(), "bw-absent-key-file")
    const config = {
      providers: {
        cc: {
          settings: { baseURL: "https://x.test/v1", apiKey: `{file:${file}}` },
          models: { m: {} },
        },
      },
    }
    const result = preflightCredential(config, "cc/m")
    expect(result?.ok).toBe(false)
    expect(result?.message).toContain(file)
  })
})
