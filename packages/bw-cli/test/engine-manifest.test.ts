/**
 * Tests for manifest-driven engine resolution (Task 4).
 *
 * The behaviour under test is a *refusal* set, so most of these tests assert that resolution
 * throws. A test that only proved "a good manifest works" would pass for a resolver that also
 * happily used a lookalike `opencode` from `PATH`, which is the specific failure Task 4 exists to
 * prevent.
 *
 * Written before `engine-manifest.ts` existed; the first run failed with a module-not-found error
 * for the resolver, which is recorded in the Task 4 notes rather than described as a passing run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  EngineManifestError,
  loadEngineManifest,
  resolveEngineFromManifest,
  type EngineManifest,
} from "../src/engine-manifest"

let root: string

/** A real file with a real digest, so the hash check passes for the honest case. */
function writeBinary(directory: string, name = "opencode", contents = "#!/bin/sh\necho engine\n"): string {
  const file = path.join(directory, name)
  writeFileSync(file, contents)
  chmodSync(file, 0o755)
  return file
}

function sha256(file: string): string {
  return createHash("sha256").update(require("node:fs").readFileSync(file)).digest("hex")
}

function manifestFor(binary: string, overrides: Partial<EngineManifest> = {}): EngineManifest {
  const stat = require("node:fs").statSync(binary)
  return {
    schemaVersion: 1,
    target: "darwin-arm64",
    opencodeTarget: "darwin-arm64",
    platform: { os: "darwin", arch: "arm64" },
    sourcePins: { engine: "c0ad18b402eb2827fc1ee71c171b1177b3fc02d1", ptyHelper: "03d848f" },
    engine: {
      name: path.basename(binary),
      sha256: sha256(binary),
      bytes: stat.size,
      path: path.relative(root, binary),
      ffmpegMarkers: [],
    },
    pty: { name: "opencode-pty", sha256: "9a82311b", bytes: 2714352, source: "local-build" },
    toolchains: {
      rust: "rustc 1.98.1",
      cargo: "cargo 1.98.1",
      bun: "1.4.4",
      zigPtyHelper: "0.16.0",
      zigOpentui: "0.17.0",
      paths: {},
    },
    notices: { inventory: null, sha256: null },
    buildInputs: { opentui: "libopentui.dylib" },
    ...overrides,
  } as EngineManifest
}

function writeManifest(manifest: EngineManifest): string {
  const file = path.join(root, "engine-manifest.json")
  writeFileSync(file, JSON.stringify(manifest, null, 2))
  return file
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-engine-manifest-")))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("a correct manifest", () => {
  test("resolves the engine path it names, and reports the manifest as its source", () => {
    const binary = writeBinary(root)
    const manifestPath = writeManifest(manifestFor(binary))
    const resolved = resolveEngineFromManifest(manifestPath, { root })
    expect(resolved.command).toBe(binary)
    expect(resolved.source).toBe("manifest")
    expect(resolved.sha256).toBe(sha256(binary))
    expect(resolved.engineSource).toBe("local-build")
  })
})

describe("refusals — every one must fail closed", () => {
  test("a missing engine binary is refused, not resolved to something else", () => {
    const binary = writeBinary(root)
    const manifest = manifestFor(binary)
    const manifestPath = writeManifest(manifest)
    rmSync(binary)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(EngineManifestError)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/missing/i)
  })

  test("a modified binary is refused by digest, and the message names both digests", () => {
    const binary = writeBinary(root)
    const manifestPath = writeManifest(manifestFor(binary))
    writeFileSync(binary, "#!/bin/sh\necho tampered\n")
    let error: unknown
    try {
      resolveEngineFromManifest(manifestPath, { root })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EngineManifestError)
    const message = (error as Error).message
    expect(message).toMatch(/digest|sha256/i)
    expect(message).toContain(sha256(binary))
  })

  test("a manifest for another platform is refused on this host", () => {
    const binary = writeBinary(root)
    const manifest = manifestFor(binary, {
      target: "linux-x64",
      opencodeTarget: "linux-x64",
      platform: { os: "linux", arch: "x64" },
    })
    const manifestPath = writeManifest(manifest)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/platform|target/i)
  })

  test("a binary outside the manifest root is refused even with a correct digest", () => {
    // The digest is honest; the location is not. A digest check alone would accept this, so the
    // containment check has to be independent of it.
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-engine-outside-")))
    const binary = writeBinary(outside)
    const manifest = manifestFor(binary)
    const manifestPath = writeManifest(manifest)
    try {
      expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/outside|escape/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a path that escapes via .. is refused", () => {
    const binary = writeBinary(root)
    const manifest = manifestFor(binary)
    manifest.engine.path = path.join("..", "..", "elsewhere", "opencode")
    const manifestPath = writeManifest(manifest)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/outside|escape|missing/i)
  })

  test("a symlink pointing outside the root is refused after resolution", () => {
    // A string check on the path passes here; only realpath containment catches it.
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-engine-link-")))
    const target = writeBinary(outside)
    const link = path.join(root, "linked-opencode")
    symlinkSync(target, link)
    const manifest = manifestFor(target)
    manifest.engine.path = path.basename(link)
    const manifestPath = writeManifest(manifest)
    try {
      expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/outside|escape/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a manifest with no digest cannot be verified and is refused", () => {
    const binary = writeBinary(root)
    const manifest = manifestFor(binary)
    ;(manifest.engine as { sha256: string | null }).sha256 = null
    const manifestPath = writeManifest(manifest)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/digest|sha256|verif/i)
  })

  test("a malformed manifest is refused with a legible message, not a stack trace", () => {
    const file = path.join(root, "broken-manifest.json")
    writeFileSync(file, "{not json")
    expect(() => loadEngineManifest(file)).toThrow(EngineManifestError)
    expect(() => loadEngineManifest(file)).toThrow(/manifest/i)
  })

  test("an unsupported schema version is refused rather than guessed at", () => {
    const binary = writeBinary(root)
    const manifest = manifestFor(binary)
    ;(manifest as { schemaVersion: number }).schemaVersion = 99
    const manifestPath = writeManifest(manifest)
    expect(() => resolveEngineFromManifest(manifestPath, { root })).toThrow(/schema/i)
  })
})

describe("the lookalike on PATH must never be chosen", () => {
  test("an engine on PATH is ignored when the manifest is present and valid", () => {
    const lookalikeDir = mkdtempSync(path.join(tmpdir(), "bw-lookalike-"))
    const lookalike = writeBinary(lookalikeDir, "opencode", "#!/bin/sh\necho LOOKALIKE\n")
    const originalPath = process.env["PATH"]
    process.env["PATH"] = `${lookalikeDir}${path.delimiter}${originalPath ?? ""}`
    try {
      const binary = writeBinary(root, "opencode", "#!/bin/sh\necho real\n")
      const manifestPath = writeManifest(manifestFor(binary))
      const resolved = resolveEngineFromManifest(manifestPath, { root })
      expect(resolved.command).toBe(binary)
      expect(resolved.command).not.toBe(lookalike)
    } finally {
      process.env["PATH"] = originalPath
      rmSync(lookalikeDir, { recursive: true, force: true })
    }
  })

  test("with no manifest, packaged mode refuses instead of falling back to PATH", () => {
    const lookalikeDir = mkdtempSync(path.join(tmpdir(), "bw-lookalike2-"))
    writeBinary(lookalikeDir, "opencode", "#!/bin/sh\necho LOOKALIKE\n")
    const originalPath = process.env["PATH"]
    process.env["PATH"] = `${lookalikeDir}${path.delimiter}${originalPath ?? ""}`
    const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-no-manifest-")))
    try {
      expect(() =>
        resolveEngineFromManifest(path.join(empty, "engine-manifest.json"), { root: empty }),
      ).toThrow(EngineManifestError)
      expect(() =>
        resolveEngineFromManifest(path.join(empty, "engine-manifest.json"), { root: empty }),
      ).toThrow(/manifest/i)
    } finally {
      process.env["PATH"] = originalPath
      rmSync(lookalikeDir, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
