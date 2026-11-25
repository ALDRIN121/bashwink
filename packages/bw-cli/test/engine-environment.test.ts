/**
 * The engine Bashwink ships must not make network contacts of its own.
 *
 * Bashwink owns the model catalog: the engine boots from the pinned snapshot compiled into the
 * binary, and catalog changes arrive as Bashwink updates. Upstream also refreshes that catalog from
 * models.opencode.ai on a timer, and carries an updater that reaches its own release channel. Those
 * are not features of this product, and leaving them on would make the shipped install phone home
 * for things it does not need.
 *
 * Tested by execution: a fake engine records the environment it is actually handed, and the
 * assertions are made against that recording. A test that inspected the source or called the helper
 * that builds the environment would still pass if the wiring were dropped — which is exactly the
 * bug this caught. `OPENCODE_DISABLE_MODELS_FETCH` was set in the sandbox and VM backends but not in
 * the standard native path, the one the npm launcher and source install use.
 */
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

interface Probe {
  readonly exitCode: number
  readonly stderr: string
  readonly env: Record<string, string> | undefined
  readonly cleanup: () => void
}

/**
 * Run a standalone session against a fake engine that dumps its environment.
 *
 * The fake answers `--version` and `serve` and writes the environment on the serve call, because
 * the engine's environment is finalized at the serve launch. It advertises a non-loopback-free
 * endpoint on purpose: the run cannot get past readiness with a fake server, and that is fine —
 * the environment has already been recorded by then, which is the only thing under test here.
 */
function envSeenByEngine(extraEnv: Record<string, string> = {}): Probe {
  const root = mkdtempSync(path.join(tmpdir(), "bw-engine-env-"))
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const dump = path.join(root, "engine-env.txt")
  const fake = path.join(root, "opencode")
  Bun.spawnSync(["mkdir", "-p", home, workspace])
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do [ "$a" = "--version" ] && { echo 2.3.2; exit 0; }; done',
      'case " $* " in',
      `  *" serve "*) env > ${JSON.stringify(dump)}; echo "server listening on http://127.0.0.1:47999"; sleep 5; exit 0 ;;`,
      "esac",
      'echo "unsupported: $*" >&2',
      "exit 1",
    ].join("\n"),
  )
  chmodSync(fake, 0o755)
  const result = Bun.spawnSync([process.execPath, cli, "run", "--standalone", "--auto", "say OK"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: root,
      BASHWINK_HOME: home,
      BASHWINK_OPENCODE_BIN: fake,
      ...extraEnv,
    },
    timeout: 30_000,
  })
  let env: Record<string, string> | undefined
  if (existsSync(dump)) {
    env = {}
    for (const line of readFileSync(dump, "utf8").split("\n")) {
      const at = line.indexOf("=")
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return {
    exitCode: result.exitCode ?? -1,
    stderr: result.stderr.toString(),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("the engine is started with its autonomous catalog refresh and updater disabled", () => {
  const probe = envSeenByEngine()
  try {
    expect(probe.env, `engine never started: ${probe.stderr.slice(0, 300)}`).toBeDefined()
    // Absent would mean the upstream default, which is an active network refresh.
    expect(probe.env!["OPENCODE_DISABLE_MODELS_FETCH"]).toBe("1")
    expect(probe.env!["OPENCODE_DISABLE_AUTOUPDATE"]).toBe("1")
    expect(probe.env!["OPENCODE_DISABLE_FREE_MODELS"]).toBe("1")
  } finally {
    probe.cleanup()
  }
})

test("an inherited setting cannot re-enable the upstream catalog fetch or free gateway", () => {
  // The product decides this, not the ambient shell. An inherited 0 would otherwise silently
  // restore the refresh or free-model gateway the previous test proves is off.
  const probe = envSeenByEngine({
    OPENCODE_DISABLE_MODELS_FETCH: "0",
    OPENCODE_DISABLE_FREE_MODELS: "0",
  })
  try {
    expect(probe.env, `engine never started: ${probe.stderr.slice(0, 300)}`).toBeDefined()
    expect(probe.env!["OPENCODE_DISABLE_MODELS_FETCH"]).toBe("1")
    expect(probe.env!["OPENCODE_DISABLE_FREE_MODELS"]).toBe("1")
  } finally {
    probe.cleanup()
  }
})

test("no upstream account credential is handed to the engine", () => {
  const probe = envSeenByEngine({
    OPENCODE_API_KEY: "not-a-real-key",
    OPENCODE_SESSION_TOKEN: "not-a-real-token",
  })
  try {
    expect(probe.env, `engine never started: ${probe.stderr.slice(0, 300)}`).toBeDefined()
    // Upstream account/session concepts. Bashwink routes credentials to the provider the user
    // selected, so these must not survive into the engine's environment.
    expect(probe.env!["OPENCODE_API_KEY"]).toBeUndefined()
    expect(probe.env!["OPENCODE_SESSION_TOKEN"]).toBeUndefined()
  } finally {
    probe.cleanup()
  }
})
