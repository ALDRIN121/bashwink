/**
 * Regression: the standard (npm) bundle must start from a valid engine manifest.
 *
 * Before Task 4's standard-build wiring, a standard bundle required `BASHWINK_OPENCODE_BIN` and
 * exited **127** when the launcher supplied a manifest instead. The launcher is npm's entry point,
 * so that made a locally built engine unusable through the supported install path — the engine
 * built, verified, and then could not be launched.
 *
 * Every test here goes through `release/npm/bin/bashwink.js` as npm would run it, with a real
 * `STANDARD_BUILD` bundle in `lib/`, and with `BASHWINK_OPENCODE_BIN` explicitly unset. Driving
 * `main()` directly would bypass the launcher, which is the half that supplies the manifest.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

const REPO = path.resolve(import.meta.dir, "../../..")

let pkg: string
let manifestPath: string
let enginePath: string
let launcher: string

/** Build a STANDARD bundle and a package layout the launcher understands. */
function buildStandardBundle(outfile: string) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      path.join(REPO, "packages/bw-cli/src/bin.ts"),
      "--target=bun",
      "--define",
      "__BASHWINK_STANDARD__=true",
      "--outfile",
      outfile,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(`standard bundle build failed: ${result.stderr.toString().slice(0, 800)}`)
}

/** A launcher that prints the environment it would hand the runtime, then exits 0. */
function stubRuntime(): string {
  const file = path.join(pkg, "lib/bashwink.js")
  writeFileSync(
    file,
    [
      'console.log("BASHWINK_ENGINE_MANIFEST=" + (process.env.BASHWINK_ENGINE_MANIFEST || "(unset)"))',
      'console.log("BASHWINK_OPENCODE_BIN=" + (process.env.BASHWINK_OPENCODE_BIN || "(unset)"))',
      "process.exit(0)",
    ].join("\n"),
  )
  return file
}

beforeAll(() => {
  pkg = mkdtempSync(path.join(tmpdir(), "bw-standard-"))
  mkdirSync(path.join(pkg, "bin"), { recursive: true })
  mkdirSync(path.join(pkg, "lib"), { recursive: true })
  cpSync(path.join(REPO, "release/npm/bin/bashwink.js"), path.join(pkg, "bin/bashwink.js"))

  // Bun has to be findable the way the launcher looks for it.
  const bunDir = path.join(pkg, "node_modules/@oven/bun-darwin-aarch64/bin")
  mkdirSync(bunDir, { recursive: true })
  cpSync(process.execPath, path.join(bunDir, "bun"))

  // A tiny "engine" standing in for the 196 MB artifact. The digest is what matters here; the
  // real artifact is exercised by engine-manifest.probe.ts.
  enginePath = path.join(pkg, "opencode")
  writeFileSync(enginePath, "#!/bin/sh\necho engine\n")
  chmodSync(enginePath, 0o755)
  const digest = createHash("sha256").update(readFileSync(enginePath)).digest("hex")

  manifestPath = path.join(pkg, "engine-manifest.json")
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        target: `${process.platform}-${process.arch}`,
        opencodeTarget: `${process.platform}-${process.arch}`,
        platform: { os: process.platform, arch: process.arch },
        sourcePins: { engine: "c0ad18b", ptyHelper: "03d848f" },
        engine: {
          name: "opencode",
          sha256: digest,
          bytes: 18,
          path: "opencode",
          ffmpegMarkers: [],
        },
        pty: { name: "opencode-pty", sha256: "9a82", bytes: 1, source: "local-build" },
        toolchains: {
          rust: null,
          cargo: null,
          bun: null,
          zigPtyHelper: null,
          zigOpentui: null,
        },
        notices: { inventory: null, sha256: null },
      },
      null,
      2,
    ),
  )

  launcher = path.join(pkg, "bin/bashwink.js")
})

afterAll(() => {
  rmSync(pkg, { recursive: true, force: true })
})

function runLauncher(env: Record<string, string | undefined> = {}) {
  const child = Bun.spawnSync({
    cmd: [process.execPath, launcher, "run", "--standalone", "say OK"],
    env: {
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
      // The whole point: the legacy variable must be absent.
      BASHWINK_OPENCODE_BIN: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

describe("standard build wiring", () => {
  test("the launcher supplies the manifest and never sets BASHWINK_OPENCODE_BIN", () => {
    stubRuntime()
    const result = runLauncher()
    expect(result.code).toBe(0)
    // The launcher realpaths the manifest (macOS /var -> /private/var), which is correct; compare
    // on the resolved path rather than the temporary-directory spelling.
    expect(result.stdout).toContain("BASHWINK_ENGINE_MANIFEST=")
    expect(result.stdout).toContain("engine-manifest.json")
    expect(result.stdout).toContain("BASHWINK_OPENCODE_BIN=(unset)")
  })

  test("REGRESSION: a standard bundle with a manifest and no BASHWINK_OPENCODE_BIN does not exit 127", () => {
    buildStandardBundle(path.join(pkg, "lib/bashwink.js"))
    const result = runLauncher()
    // 127 was the pre-Task-4 behaviour: "the pinned runtime was not provided".
    expect(result.code).not.toBe(127)
    expect(result.stderr).not.toContain("the pinned OpenCode runtime was not provided")
  })
})

describe("a missing or tampered manifest stops before any model request", () => {
  test("a tampered engine is refused, and the model is never reached", () => {
    buildStandardBundle(path.join(pkg, "lib/bashwink.js"))
    writeFileSync(enginePath, "#!/bin/sh\necho TAMPERED\n")
    chmodSync(enginePath, 0o755)
    const result = runLauncher()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/digest|verif/i)
    // No provider call can have happened: the refusal is local and precedes resolution.
    expect(result.stdout).not.toContain("model request")
  })

  test("a missing manifest is refused rather than falling back to a runtime", () => {
    // Restore the engine digest first, so the only fault is the absent manifest.
    writeFileSync(enginePath, "#!/bin/sh\necho engine\n")
    chmodSync(enginePath, 0o755)
    rmSync(manifestPath)
    const result = runLauncher()
    // With no manifest and no npm @opencode/cli-* package installed, the launcher must stop. It must
    // not search PATH, and it must not invent a manifest path.
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain("BASHWINK_ENGINE_MANIFEST=")
    expect(result.stderr).toMatch(/required runtime package is missing|not found|no OpenCode runtime/i)
  })
})
