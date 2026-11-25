import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  inspectLegacyOpenAiProviders,
  loadStandaloneConfig,
  normalizeBaseURL,
  saveStandaloneConfig,
  standaloneConfigFile,
} from "../../src/standalone/config.ts"
import {
  PROVIDER_CATALOG,
  findProviderPreset,
} from "../../src/standalone/provider-catalog.ts"
import { sanitizeTerminalText, runInteractiveSetup, type TerminalIO } from "../../src/standalone/terminal.ts"
import type { StandaloneConfig } from "../../src/standalone/types.ts"

function scriptedIO(answers: (string | null)[]): { io: TerminalIO; stdout: () => string; stderr: () => string } {
  let out = ""
  let err = ""
  let idx = 0
  return {
    io: {
      isTTY: true,
      write: (t) => {
        out += t
      },
      writeError: (t) => {
        err += t
      },
      ask: async () => (idx < answers.length ? answers[idx++]! : null),
      close: () => undefined,
    },
    stdout: () => out,
    stderr: () => err,
  }
}

test("normalizeBaseURL enforces HTTPS for hosted endpoints and allows loopback HTTP for local", () => {
  assert.equal(normalizeBaseURL("https://api.example.com/v1/", "hosted"), "https://api.example.com/v1")
  assert.equal(normalizeBaseURL("http://127.0.0.1:8080/v1/chat/completions", "local"), "http://127.0.0.1:8080/v1")
  assert.throws(() => normalizeBaseURL("http://api.example.com/v1", "hosted"), /must use https/)
  assert.throws(() => normalizeBaseURL("http://192.168.1.5:8080/v1", "local"), /loopback/)
  assert.throws(() => normalizeBaseURL("https://user:pass@api.example.com/v1", "hosted"), /credentials/)
})

test("setup cancel writes no partial profile, OpenCode-ported catalog preset works, and reconfigure cancel preserves config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-setup-cancel-"))
  try {
    assert.ok(PROVIDER_CATALOG.length >= 8)
    assert.equal(findProviderPreset("openai")?.defaultBaseURL, "https://api.openai.com/v1")
    assert.equal(findProviderPreset("ollama")?.defaultBaseURL, "http://127.0.0.1:11434/v1")
    assert.equal(findProviderPreset("10")?.id, "custom-local")

    // 1. Cancelled first-time setup writes nothing (provider 10 = custom-local, cred 3 = none, confirm 'n')
    const first = scriptedIO(["10", "http://127.0.0.1:8080/v1", "qwen-1", "3", "n"])
    const r1 = await runInteractiveSetup(first.io, dir, {})
    assert.equal(r1.status, "cancelled")
    assert.equal(existsSync(standaloneConfigFile(dir)), false)

    // 2. Saved setup succeeds atomically via custom local preset
    const second = scriptedIO(["10", "http://127.0.0.1:8080/v1", "qwen-1", "3", "y"])
    const r2 = await runInteractiveSetup(second.io, dir, {})
    assert.equal(r2.status, "saved")
    const loaded = loadStandaloneConfig(dir)
    assert.equal(loaded.status, "ok")
    assert.equal(loaded.config.model, "qwen-1")
    assert.equal(loaded.config.providerId, "custom-local")

    // 3. Cancelled reconfigure via `bashwink setup` preserves existing working profile
    const third = scriptedIO(["10", "http://127.0.0.1:9999/v1", "other-model", "3", null])
    const r3 = await runInteractiveSetup(third.io, dir, {}, loaded.config)
    assert.equal(r3.status, "cancelled")
    const after = loadStandaloneConfig(dir)
    assert.equal(after.status, "ok")
    assert.equal(after.config.baseURL, "http://127.0.0.1:8080/v1")
    assert.equal(after.config.model, "qwen-1")

    // 4. OpenCode catalog preset (provider 1 = OpenAI, Enter for default URL, model '1', env cred '1', Enter for OPENAI_API_KEY)
    const fourth = scriptedIO(["1", "", "1", "1", "", "y"])
    const r4 = await runInteractiveSetup(fourth.io, dir, {})
    assert.equal(r4.status, "saved")
    const presetLoaded = loadStandaloneConfig(dir)
    assert.equal(presetLoaded.status, "ok")
    assert.equal(presetLoaded.config.providerId, "openai")
    assert.equal(presetLoaded.config.baseURL, "https://api.openai.com/v1")
    assert.equal(presetLoaded.config.model, "gpt-4o-mini")
    assert.deepEqual(presetLoaded.config.credential, { kind: "env", variable: "OPENAI_API_KEY" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("legacy opencode.json is preserved untouched and only offered for opt-in preview", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-legacy-import-"))
  try {
    const legacy = {
      providers: {
        custom: {
          env: ["CUSTOM_API_KEY"],
          settings: { baseURL: "https://llm.example.com/v1" },
          models: { "coder-m1": {} },
        },
      },
    }
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(legacy))
    // Loading standalone config still reports missing until user explicitly imports/configures!
    assert.equal(loadStandaloneConfig(dir).status, "missing")
    const candidates = inspectLegacyOpenAiProviders(dir)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]!.model, "coder-m1")
    assert.deepEqual(candidates[0]!.credential, { kind: "env", variable: "CUSTOM_API_KEY" })

    const cfg: StandaloneConfig = {
      version: 1,
      endpointType: "local",
      baseURL: "http://127.0.0.1:8080/v1",
      model: "m1",
      credential: { kind: "none" },
      updatedAt: new Date().toISOString(),
    }
    saveStandaloneConfig(dir, cfg)
    // Legacy file stays intact
    assert.equal(JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8")).providers.custom.models["coder-m1"] !== undefined, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sanitizeTerminalText strips ANSI escape sequences and unsafe control bytes", () => {
  const hostile = "safe \x1b]2;spoofed-title\x07\x1b[31mred\x1b[0m\x00\x07\nnext"
  assert.equal(sanitizeTerminalText(hostile), "safe red\nnext")
})
