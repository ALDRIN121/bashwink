/**
 * BW-091 — `bashwink auth` and `bashwink model` as a user actually meets them.
 *
 * These spawn the real entrypoint, because the acceptance criteria are about exit codes and
 * text a script or a human consumes. The important negative controls are here: a provider
 * that cannot authenticate must exit nonzero, `--key` must be refused, and no command may
 * print a credential value even when one is set.
 *
 * A persistent BASHWINK_HOME is used across calls inside one test — that is the whole point
 * of `auth add` → `model use` → `run`, and a per-call temp home would test nothing.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CLI = path.join(import.meta.dir, "..", "src", "bin.ts")
const REPO = path.join(import.meta.dir, "..", "..", "..")

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** A throwaway BASHWINK_HOME that several calls can share. */
function sandbox(): {
  home: string
  cli: (args: readonly string[], env?: Record<string, string>) => Run
  done: () => void
} {
  const home = mkdtempSync(path.join(tmpdir(), "bw-auth-"))
  return {
    home,
    cli(args, env = {}) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, CLI, ...args],
        env: { ...process.env, BASHWINK_HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
        cwd: REPO,
      })
      return {
        code: result.exitCode ?? -1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    },
    done() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function readConfig(home: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(home, "opencode.json"), "utf8"))
}

const ADD = [
  "auth",
  "add",
  "cc",
  "--name",
  "CommandCode",
  "--base-url",
  "https://api.example.test/provider/v1",
  "--env",
  "BW_TEST_PROVIDER_KEY",
  "--model",
  "claude-sonnet-5:anthropic:200000:8192",
  "--model",
  "gpt-6.1-sol:openai:200000:8192",
]

describe("BW-091 — auth add", () => {
  test("writes a provider the runtime can read, with per-model protocols", () => {
    const box = sandbox()
    try {
      const run = box.cli(ADD, { BW_TEST_PROVIDER_KEY: "placeholder" })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("added provider 'cc'")

      const config = readConfig(box.home)
      const provider = config.providers.cc
      // Mixed protocols: no provider-level package, one per model.
      expect(provider.package).toBeUndefined()
      expect(provider.models["claude-sonnet-5"].package).toBe("@opencode/ai/providers/anthropic")
      expect(provider.models["gpt-6.1-sol"].package).toBe("@opencode/ai/providers/openai/chat")
      expect(provider.limit).toBeUndefined()
      expect(provider.models["claude-sonnet-5"].limit).toEqual({ context: 200000, output: 8192 })
      expect(provider.env).toEqual(["BW_TEST_PROVIDER_KEY"])
      // The map key is the id; an `id` field would be an unknown key the runtime rejects.
      expect(provider.id).toBeUndefined()
    } finally {
      box.done()
    }
  })

  test("a uniform-protocol declaration keeps the package at provider level", () => {
    const box = sandbox()
    try {
      const run = box.cli([
        "auth",
        "add",
        "one",
        "--base-url",
        "https://x.test/v1",
        "--env",
        "BW_TEST_ONE",
        "--model",
        "m1",
        "--model",
        "m2",
        "--anthropic",
      ])
      expect(run.code).toBe(0)
      const provider = readConfig(box.home).providers.one
      expect(provider.package).toBe("@opencode/ai/providers/anthropic")
      expect(provider.models.m1.package).toBeUndefined()
    } finally {
      box.done()
    }
  })

  test("refuses --key outright and does not write it to disk", () => {
    const box = sandbox()
    try {
      const run = box.cli([
        "auth",
        "add",
        "leaky",
        "--base-url",
        "https://x.test/v1",
        "--key",
        "sk-do-not-store-me",
        "--model",
        "m",
      ])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/refusing --key/)
      expect(run.stderr).toMatch(/git add -A/)
      // Nothing written, so the secret cannot have reached the config.
      expect(() => readConfig(box.home)).toThrow()
    } finally {
      box.done()
    }
  })

  test("a key file is referenced, never copied", () => {
    const box = sandbox()
    const keys = mkdtempSync(path.join(tmpdir(), "bw-keys-"))
    try {
      const keyFile = path.join(keys, "provider.key")
      writeFileSync(keyFile, "the-real-key-value", { mode: 0o600 })
      const run = box.cli([
        "auth",
        "add",
        "filey",
        "--base-url",
        "https://x.test/v1",
        "--key-file",
        keyFile,
        "--model",
        "m",
      ])
      expect(run.code).toBe(0)
      const raw = readFileSync(path.join(box.home, "opencode.json"), "utf8")
      expect(raw).toContain(`{file:${keyFile}}`)
      // The value must not be in the config, only a reference to the file that holds it.
      expect(raw).not.toContain("the-real-key-value")
    } finally {
      box.done()
      rmSync(keys, { recursive: true, force: true })
    }
  })

  test("rejects a path-traversal provider id", () => {
    const box = sandbox()
    try {
      const run = box.cli([
        "auth",
        "add",
        "../../escape",
        "--base-url",
        "https://x.test/v1",
        "--env",
        "K",
        "--model",
        "m",
      ])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/invalid/)
    } finally {
      box.done()
    }
  })

  test("rejects a duplicate provider rather than silently overwriting", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const second = box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      expect(second.code).toBe(1)
      expect(second.stderr).toMatch(/already configured/)
    } finally {
      box.done()
    }
  })

  test("requires a credential route and at least one model", () => {
    const box = sandbox()
    try {
      expect(
        box.cli(["auth", "add", "nokey", "--base-url", "https://x.test/v1", "--model", "m"]).code,
      ).toBe(2)
      expect(
        box.cli(["auth", "add", "nomodel", "--base-url", "https://x.test/v1", "--env", "K"]).code,
      ).toBe(2)
    } finally {
      box.done()
    }
  })

  test("rejects an unknown protocol rather than defaulting silently", () => {
    const box = sandbox()
    try {
      const run = box.cli([
        "auth",
        "add",
        "badproto",
        "--base-url",
        "https://x.test/v1",
        "--env",
        "K",
        "--model",
        "m:gemini",
      ])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/expected anthropic, openai or openai-responses/)
    } finally {
      box.done()
    }
  })
})

describe("BW-091 — auth status and check", () => {
  test("status exits 0 when every provider can authenticate", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["auth", "status"], { BW_TEST_PROVIDER_KEY: "present-value" })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("✓ cc")
      expect(run.stdout).toContain("COMMANDCODE".length > 0 ? "BW_TEST_PROVIDER_KEY" : "")
      expect(run.stdout).toContain("anthropic, openai")
    } finally {
      box.done()
    }
  })

  test("status exits nonzero when a declared variable is missing, and names it", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["auth", "status"], { BW_TEST_PROVIDER_KEY: "" })
      expect(run.code).toBe(1)
      expect(run.stdout).toContain("✗ cc")
      expect(run.stdout).toContain("BW_TEST_PROVIDER_KEY is not set")
      expect(run.stderr).toMatch(/cannot authenticate/)
    } finally {
      box.done()
    }
  })

  test("status never prints the credential value", () => {
    const box = sandbox()
    const secret = "sk-live-SENTINELVALUE-that-must-not-appear"
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["auth", "status"], { BW_TEST_PROVIDER_KEY: secret })
      expect(`${run.stdout}${run.stderr}`).not.toContain(secret)
      expect(`${run.stdout}${run.stderr}`).not.toContain("SENTINELVALUE")
      // It still reports presence and a length, which is the useful part.
      expect(run.stdout).toContain(String(secret.length))
    } finally {
      box.done()
    }
  })

  test("check exits 1 with an actionable fix for a missing variable", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["auth", "check", "cc"], { BW_TEST_PROVIDER_KEY: "" })
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/export BW_TEST_PROVIDER_KEY=/)
    } finally {
      box.done()
    }
  })

  test("check on an unconfigured provider is a refusal, not a crash", () => {
    const box = sandbox()
    try {
      const run = box.cli(["auth", "check", "nope"])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/not configured/)
    } finally {
      box.done()
    }
  })

  test("an empty install says so and suggests the next command", () => {
    const box = sandbox()
    try {
      const run = box.cli(["auth", "status"])
      expect(run.code).toBe(0)
      expect(run.stdout).toMatch(/no providers configured/)
      expect(run.stdout).toContain("bashwink auth add")
    } finally {
      box.done()
    }
  })

  test("a corrupt config is reported, not silently ignored", () => {
    const box = sandbox()
    try {
      box.cli(["init"])
      writeFileSync(path.join(box.home, "opencode.json"), "{oops", "utf8")
      const run = box.cli(["auth", "status"])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/not valid JSON/)
    } finally {
      box.done()
    }
  })

  test("remove clears the provider and repoints a default model at what remains", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      box.cli([
        "auth",
        "add",
        "other",
        "--base-url",
        "https://y.test/v1",
        "--env",
        "BW_TEST_OTHER",
        "--model",
        "m9",
      ])
      box.cli(["model", "use", "cc/claude-sonnet-5"])
      const removed = box.cli(["auth", "remove", "cc"])
      expect(removed.code).toBe(0)
      const config = readConfig(box.home)
      expect(config.providers.cc).toBeUndefined()
      // A default pointing at a removed provider would break every later run.
      expect(config.model).toBe("other/m9")
    } finally {
      box.done()
    }
  })
})

describe("BW-091 — model selection", () => {
  test("list marks the default and shows transport per model", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      box.cli(["model", "use", "cc/gpt-6.1-sol"])
      const run = box.cli(["model", "list"])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("* cc/gpt-6.1-sol  [openai]")
      expect(run.stdout).toContain("  cc/claude-sonnet-5  [anthropic]")
      // The list is explicitly not the runtime's live catalogue, and says how to get that.
      expect(run.stdout).toContain("bashwink models")
    } finally {
      box.done()
    }
  })

  test("use refuses a provider that is not configured", () => {
    const box = sandbox()
    try {
      const run = box.cli(["model", "use", "ghost/model"])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/provider 'ghost' is not configured/)
    } finally {
      box.done()
    }
  })

  test("use refuses a model the provider does not declare, and lists what it does", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["model", "use", "cc/typo-model"])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/not declared under 'cc'/)
      expect(run.stderr).toContain("claude-sonnet-5")
    } finally {
      box.done()
    }
  })

  test("use requires a qualified reference", () => {
    const box = sandbox()
    try {
      const run = box.cli(["model", "use", "bare-model"])
      expect(run.code).toBe(1)
      expect(run.stderr).toMatch(/must be 'provider\/model'/)
    } finally {
      box.done()
    }
  })

  test("current reports the default, and its absence honestly", () => {
    const box = sandbox()
    try {
      expect(box.cli(["model", "current"]).stdout.trim()).toBe("no default model configured")
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      box.cli(["model", "use", "cc/claude-sonnet-5"])
      expect(box.cli(["model", "current"]).stdout.trim()).toBe("cc/claude-sonnet-5")
    } finally {
      box.done()
    }
  })

  test("an unknown subcommand is a usage error, not a forwarded runtime call", () => {
    const box = sandbox()
    try {
      const run = box.cli(["model", "delete"])
      expect(run.code).toBe(2)
      expect(run.stderr).toMatch(/unknown model subcommand/)
    } finally {
      box.done()
    }
  })
})

describe("BW-091 — pre-flight blocks a doomed run before it starts", () => {
  /**
   * A stub runtime, because the pre-flight runs *after* runtime resolution.
   *
   * That ordering is deliberate: a missing runtime is an install problem and should be
   * reported as one, ahead of any credential complaint. But it means these tests cannot rely
   * on "there is no runtime here" — CI does have one on PATH on macOS runners and not on
   * Linux, so an unruntime-ed test passed locally and failed with exit 127 in CI on both
   * legs. A stub makes the precondition explicit and platform-independent.
   */
  function stubRuntime(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "bw-stub-runtime-"))
    const binary = path.join(dir, "opencode")
    // If this ever executes, the pre-flight failed to refuse and the test must say so.
    writeFileSync(binary, "#!/bin/sh\necho 'STUB RUNTIME EXECUTED' >&2\nexit 42\n", "utf8")
    chmodSync(binary, 0o755)
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test("an explicit --model on a provider with no credential fails with the variable name", () => {
    const box = sandbox()
    const stub = stubRuntime()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["run", "--model", "cc/claude-sonnet-5", "hello"], {
        BW_TEST_PROVIDER_KEY: "",
        BASHWINK_OPENCODE_BIN: path.join(stub.dir, "opencode"),
      })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain("BW_TEST_PROVIDER_KEY is not set")
      expect(run.stderr).toMatch(/export BW_TEST_PROVIDER_KEY=/)
      // The runtime's own message must not be what the user sees instead.
      expect(run.stderr).not.toContain("Invalid 'Authorization' header")
      // And the refusal happened before spawning.
      expect(run.stderr).not.toContain("STUB RUNTIME EXECUTED")
    } finally {
      box.done()
      stub.cleanup()
    }
  })

  test("--model=value form is recognised too", () => {
    const box = sandbox()
    const stub = stubRuntime()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const run = box.cli(["run", "--model=cc/claude-sonnet-5", "hi"], {
        BW_TEST_PROVIDER_KEY: "",
        BASHWINK_OPENCODE_BIN: path.join(stub.dir, "opencode"),
      })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain("BW_TEST_PROVIDER_KEY")
      expect(run.stderr).not.toContain("STUB RUNTIME EXECUTED")
    } finally {
      box.done()
      stub.cleanup()
    }
  })

  test("a model outside the config is not pre-flighted, so the runtime still decides", () => {
    const box = sandbox()
    const stub = stubRuntime()
    try {
      // No provider configured: the check must stay silent rather than inventing a credential
      // requirement for the runtime's built-in catalogue. The stub proves the call reached the
      // runtime instead of being refused — asserting only "no auth error" would also pass if
      // the wrapper had failed for an unrelated reason.
      const run = box.cli(["run", "--model", "opencode/tidepool-alpha-free", "hi"], {
        BASHWINK_OPENCODE_BIN: path.join(stub.dir, "opencode"),
      })
      expect(run.stderr).not.toContain("cannot authenticate")
      expect(run.stderr).toContain("STUB RUNTIME EXECUTED")
      expect(run.code).toBe(42)
    } finally {
      box.done()
      stub.cleanup()
    }
  })
})

describe("BW-091 — config file handling", () => {
  test("the config is written as readable JSON a human can edit", () => {
    const box = sandbox()
    try {
      box.cli(ADD, { BW_TEST_PROVIDER_KEY: "x" })
      const raw = readFileSync(path.join(box.home, "opencode.json"), "utf8")
      expect(raw.endsWith("\n")).toBe(true)
      expect(raw).toContain('\n  "providers": {')
      // Round-trips, which is the property that matters.
      expect(() => JSON.parse(raw)).not.toThrow()
    } finally {
      box.done()
    }
  })
})
