/**
 * Integration probe: the real resolver against the real packaged artifacts (Task 4).
 *
 * Not a unit test with fixtures — this drives `resolveRuntime` exactly as `main.ts` does in a
 * release build (`{ engineManifest }`), against the actual 196 MB engine and the actual manifest
 * produced by `scripts/build_local_engine.py`. Digest verification therefore runs over the real
 * artifact, which is the only way to know the check works on 196 MB rather than on a 40-byte
 * fixture.
 *
 * It exists as a separate probe rather than a bun test because the release CLI gates on an
 * interactive TTY acknowledgment before it ever resolves a runtime, so the matrix cannot be driven
 * through the packaged entry point non-interactively. Reaching the resolver directly is the honest
 * way to exercise it; pretending the gated CLI covered it would not be.
 *
 * Usage: bun run packages/bw-cli/test/engine-manifest.probe.ts <packaged-dir>
 */

import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { resolveRuntime, RuntimeNotFoundError } from "../src/runtime"

const base = process.argv[2]
if (!base) {
  console.error("usage: bun run engine-manifest.probe.ts <packaged-dir>")
  process.exit(2)
  // `process.exit` does not narrow for the type checker, so state the invariant.
  throw new Error("unreachable: a packaged directory is required")
}
// Narrowed copy: `base` is module-scoped and captured by a closure below, which loses the guard.
const packagedDir: string = base

interface Row {
  readonly name: string
  readonly expect: "resolve" | "refuse"
  readonly command?: string
  readonly sha256?: string
}

const rows: Row[] = []

function caseFrom(name: string, expect: "resolve" | "refuse", mutate?: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-probe-"))
  try {
    cpSync(packagedDir, dir, { recursive: true })
    if (mutate) mutate(dir)
    const manifestPath = path.join(dir, "engine-manifest.json")
    try {
      const runtime = resolveRuntime({ engineManifest: manifestPath })
      const ok = expect === "resolve"
      rows.push({ name, expect, command: path.relative(dir, runtime.command) || runtime.command })
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`)
      console.log(
        `        resolved: source=${runtime.source} command=${path.relative(dir, runtime.command)}`,
      )
      console.log(`        sha256:   ${runtime.sha256}`)
      return ok
    } catch (error) {
      if (!(error instanceof RuntimeNotFoundError)) throw error
      const ok = expect === "refuse"
      rows.push({ name, expect })
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`)
      const message = error.message.replace(/\n\s*/g, " ")
      console.log(`        refused:  ${message.slice(0, 150)}`)
      return ok
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`probe root: ${base}\n`)
const results: boolean[] = []

results.push(caseFrom("1. valid manifest — control", "resolve"))

results.push(
  caseFrom("2. missing engine binary", "refuse", (dir) => rmSync(path.join(dir, "opencode"))),
)

results.push(
  caseFrom("3. modified engine binary", "refuse", (dir) => {
    writeFileSync(path.join(dir, "opencode"), "#!/bin/sh\necho tampered\n")
  }),
)

results.push(
  caseFrom("4. no manifest at all", "refuse", (dir) =>
    rmSync(path.join(dir, "engine-manifest.json")),
  ),
)

results.push(
  caseFrom("5. wrong-platform manifest", "refuse", (dir) => {
    const file = path.join(dir, "engine-manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.target = "linux-x64"
    manifest.opencodeTarget = "linux-x64"
    manifest.platform = { os: "linux", arch: "x64" }
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }),
)

results.push(
  caseFrom("6. path escaping the package directory", "refuse", (dir) => {
    const file = path.join(dir, "engine-manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.engine.path = "../../elsewhere/opencode"
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }),
)

results.push(
  caseFrom("7. symlink to a binary outside the directory", "refuse", (dir) => {
    const file = path.join(dir, "engine-manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    const outside = mkdtempSync(path.join(tmpdir(), "bw-probe-outside-"))
    const target = path.join(outside, "opencode")
    copyFileSync(path.join(dir, "opencode"), target)
    // Digest still correct; only the location is wrong, so only containment can refuse it.
    require("node:fs").symlinkSync(target, path.join(dir, "linked"))
    manifest.engine.path = "linked"
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }),
)

results.push(
  caseFrom("8. manifest with a null digest", "refuse", (dir) => {
    const file = path.join(dir, "engine-manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.engine.sha256 = null
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }),
)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} probe cases behaved as required`)
process.exit(passed === results.length ? 0 : 1)
