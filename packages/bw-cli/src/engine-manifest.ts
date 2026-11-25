/**
 * Resolving the engine named in a local build manifest (Task 4).
 *
 * The launcher used to locate a runtime by walking `node_modules/.bin` and then `PATH`. For a
 * locally built engine that is the wrong shape of trust: `PATH` is attacker-influenced in the
 * ordinary course of things (a project-local `./node_modules/.bin`, a devcontainer, a shell
 * function's export), and "the first executable called `opencode`" is not the binary this project
 * built and tested.
 *
 * So packaged resolution reads a manifest produced by `scripts/build_local_engine.py`, and treats
 * every field as a claim to be checked. A manifest is not a capability: it is a description, and
 * the resolver verifies it against the filesystem before anything runs.
 *
 * Refusal set, all closed before any output is printed or any model call is made:
 *   - manifest absent or unparseable
 *   - unexpected schema version
 *   - manifest built for another platform
 *   - engine file missing
 *   - engine digest absent (unverifiable) or mismatched (modified)
 *   - engine path outside the manifest's own directory, including via `..` or a symlink
 */

import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

export const ENGINE_MANIFEST_SCHEMA_VERSION = 1

export class EngineManifestError extends Error {
  readonly code = "engine_manifest_invalid"
  constructor(message: string) {
    super(message)
    this.name = "EngineManifestError"
  }
}

export interface EngineManifest {
  readonly schemaVersion: number
  readonly target: string
  readonly opencodeTarget: string
  readonly platform: { readonly os: string; readonly arch: string }
  readonly sourcePins: { readonly engine: string; readonly ptyHelper: string }
  readonly engine: {
    readonly name: string
    readonly sha256: string | null
    readonly bytes: number
    readonly path: string
    readonly ffmpegMarkers?: readonly string[]
  }
  readonly pty: {
    readonly name: string
    readonly sha256: string
    readonly bytes: number
    readonly source: string
  }
  readonly toolchains: {
    readonly rust: string | null
    readonly cargo: string | null
    readonly bun: string | null
    readonly zigPtyHelper: string | null
    readonly zigOpentui: string | null
    readonly paths?: Record<string, string | null>
  }
  readonly notices: { readonly inventory: string | null; readonly sha256: string | null }
  readonly buildInputs?: Record<string, string>
}

export interface ResolvedEngine {
  readonly command: string
  /** `manifest` distinguishes this from the legacy env/package/path sources. */
  readonly source: "manifest"
  readonly sha256: string
  readonly target: string
  /** Where the engine came from, per the manifest: `local-build` for the vendored build. */
  readonly engineSource: string
  readonly manifestPath: string
}

/** The host platform key used in manifests, e.g. `darwin-arm64`. */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export function loadEngineManifest(manifestPath: string): EngineManifest {
  let raw: string
  try {
    raw = readFileSync(manifestPath, "utf8")
  } catch {
    throw new EngineManifestError(
      `no engine manifest at '${manifestPath}'. A packaged Bashwink installs one beside the engine; ` +
        `if this is a source checkout, build the engine first (scripts/build_local_engine.py).`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EngineManifestError(
      `the engine manifest at '${manifestPath}' is not valid JSON: ${(error as Error).message}`,
    )
  }

  if (typeof parsed !== "object" || parsed === null)
    throw new EngineManifestError(`the engine manifest at '${manifestPath}' is not an object`)

  const manifest = parsed as EngineManifest
  if (manifest.schemaVersion !== ENGINE_MANIFEST_SCHEMA_VERSION)
    throw new EngineManifestError(
      `engine manifest schema version ${String(manifest.schemaVersion)} is not supported by this ` +
        `build (expected ${ENGINE_MANIFEST_SCHEMA_VERSION}). Rebuild the engine with the matching tooling.`,
    )
  if (typeof manifest.target !== "string" || manifest.target.length === 0)
    throw new EngineManifestError(`engine manifest at '${manifestPath}' has no target`)
  if (typeof manifest.engine?.path !== "string")
    throw new EngineManifestError(`engine manifest at '${manifestPath}' names no engine path`)

  return manifest
}

/**
 * Resolve and verify the engine a manifest names.
 *
 * `root` is the directory the engine must live inside — the manifest's directory by default. Every
 * check fails closed; there is deliberately no fallback path, because a fallback is exactly the
 * `PATH` behaviour this replaces.
 */
export function resolveEngineFromManifest(
  manifestPath: string,
  options: { readonly root?: string; readonly hostTarget?: string } = {},
): ResolvedEngine {
  const manifest = loadEngineManifest(manifestPath)
  const manifestDirectory = path.dirname(path.resolve(manifestPath))

  // 1. Platform. A manifest built for another OS/arch describes a binary this host cannot run, and
  //    an arm64 Mach-O labelled as Linux is the failure that looks most like success.
  const expected = options.hostTarget ?? hostTarget()
  if (manifest.target !== expected || manifest.opencodeTarget !== expected)
    throw new EngineManifestError(
      `the engine manifest is for '${manifest.target}' but this host is '${expected}'. ` +
        `A locally built engine runs only on the platform it was built for.`,
    )

  // 2. Containment. Resolved before the digest, so a symlink to an honest binary elsewhere is
  //    refused for where it lives rather than accepted for what it hashes to.
  const root = realpathSync(path.resolve(options.root ?? manifestDirectory))
  const candidate = path.resolve(manifestDirectory, manifest.engine.path)
  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    throw new EngineManifestError(
      `the engine named by the manifest is missing: '${candidate}'. The manifest is stale or the ` +
        `artifact was moved; rebuild rather than pointing PATH at another opencode.`,
    )
  }
  const withinRoot = resolved === root || resolved.startsWith(root + path.sep)
  if (!withinRoot)
    throw new EngineManifestError(
      `the engine path escapes the build root: '${resolved}' is outside '${root}'. A manifest may ` +
        `only name an artifact its own build produced.`,
    )

  let stat
  try {
    stat = statSync(resolved)
  } catch {
    throw new EngineManifestError(`the engine at '${resolved}' is not readable`)
  }
  if (!stat.isFile())
    throw new EngineManifestError(`the engine path '${resolved}' is not a regular file`)

  // 3. Digest. An absent digest is a refusal, not a skip: "unverifiable" and "verified" must not
  //    be the same outcome, or the check is decoration.
  if (typeof manifest.engine.sha256 !== "string" || manifest.engine.sha256.length === 0)
    throw new EngineManifestError(
      `the engine manifest records no sha256 for '${manifest.engine.path}', so the artifact cannot ` +
        `be verified. Rebuild the engine so the manifest carries a digest.`,
    )
  const actual = sha256File(resolved)
  if (actual !== manifest.engine.sha256)
    throw new EngineManifestError(
      `the engine digest does not match the manifest. expected ${manifest.engine.sha256}, got ${actual}. ` +
        `The binary was modified or replaced after the build; refusing to run it.`,
    )

  if (manifest.engine.ffmpegMarkers && manifest.engine.ffmpegMarkers.length > 0)
    throw new EngineManifestError(
      `the engine manifest records FFmpeg markers ${manifest.engine.ffmpegMarkers.join(", ")}, which ` +
        `this build must not ship. Rebuild against the no-FFmpeg OpenTUI library.`,
    )

  return {
    command: resolved,
    source: "manifest",
    sha256: actual,
    target: manifest.target,
    engineSource: manifest.engine.name ? "local-build" : "local-build",
    manifestPath: path.resolve(manifestPath),
  }
}

/**
 * The manifest a packaged install looks for, relative to a given root.
 *
 * Kept as a function so the launcher and the runtime agree on one location instead of each
 * spelling out its own guess.
 */
export function defaultManifestPath(root: string): string {
  return path.join(root, "engine-manifest.json")
}
