/**
 * Locating the pinned OpenCode runtime.
 *
 * ADR-003: `bashwink` is a thin launcher that execs the pinned runtime rather than forking
 * it. That makes *resolution* the load-bearing part — if this guesses wrong, the user runs a
 * different agent than the one the wrapper tested. So resolution is explicit and ordered,
 * and a failure says exactly what to install.
 *
 * Task 4: in packaged mode the runtime comes from the local build manifest and nowhere else. The
 * `PATH` walk below still exists for source checkouts, where there is no manifest to verify
 * against, but it is *unreachable* from a packaged build — see `resolveRuntime`.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { EngineManifestError, resolveEngineFromManifest } from "./engine-manifest"

/** The one version Bashwink is tested against. Bumped only with a re-run of upstream-compat. */
export const PINNED_RUNTIME_VERSION = "2.3.2"

export class RuntimeNotFoundError extends Error {
  readonly code = "runtime_not_found"
  constructor(message: string) {
    super(message)
    this.name = "RuntimeNotFoundError"
  }
}

export interface RuntimeLocation {
  readonly command: string
  /** How it was found, for `bashwink doctor` to report honestly. */
  readonly source: "env" | "bundled" | "package" | "path" | "manifest"
  readonly version: string
  /** Present only when `source` is `manifest`: the verified artifact digest. */
  readonly sha256?: string
  /** Present only when `source` is `manifest`: the manifest that authorized it. */
  readonly manifestPath?: string
}

/** Candidate executable names, in order. `opencode2` is the packaged second alias. */
const BINARIES = ["opencode", "opencode2"] as const

function isExecutable(file: string): boolean {
  try {
    readFileSync(file)
  } catch {
    return false
  }
  return existsSync(file)
}

/**
 * Walk up from `start` looking for the installed package's bin directory.
 *
 * Deliberately not `require.resolve`: the package ships per-platform optional binaries
 * resolved by a postinstall step, so module resolution does not describe where the working
 * executable actually is.
 */
function fromNodeModules(start: string): string | undefined {
  let directory = start
  for (let depth = 0; depth < 12; depth += 1) {
    for (const binary of BINARIES) {
      const candidate = path.join(directory, "node_modules", ".bin", binary)
      if (isExecutable(candidate)) return candidate
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function fromPath(): string | undefined {
  const entries = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)
  for (const entry of entries)
    for (const binary of BINARIES) {
      const candidate = path.join(entry, binary)
      if (isExecutable(candidate)) return candidate
    }
  return undefined
}

export interface ResolveOptions {
  /** Repo/cwd to search upward from. */
  readonly cwd?: string
  /** The runtime shipped beside a release bundle, preferred over discovery. */
  readonly bundled?: string
  /** Release builds never fall back to `node_modules` or `PATH`: only the pinned runtime. */
  readonly bundledOnly?: boolean
  /**
   * Packaged execution: the engine manifest that authorizes the runtime.
   *
   * Set by the launcher from the install root. When this is present, resolution is a verification
   * of that manifest and nothing else — there is no fallback, because every fallback is a way for
   * a different `opencode` to run.
   */
  readonly engineManifest?: string
  /** Root the manifest's engine must live inside. Defaults to the manifest's directory. */
  readonly engineRoot?: string
}

/**
 * Resolve the runtime in a documented order:
 *   1. the local build manifest, in packaged mode — verified, and the only accepted answer
 *   2. `BASHWINK_OPENCODE_BIN` — explicit override, source checkouts only
 *   3. `node_modules/.bin/opencode` at or above the working directory
 *   4. `opencode` on `PATH`
 *
 * Steps 2–4 are unreachable once `engineManifest` is set, and equally unreachable when
 * `bundledOnly` is true. A packaged install that cannot verify its engine stops; it does not
 * borrow one from the machine it happens to be running on.
 *
 * Throws a message a user can act on instead of a bare ENOENT.
 */
export function resolveRuntime(options: ResolveOptions = {}): RuntimeLocation {
  if (options.engineManifest !== undefined) {
    try {
      const engine = resolveEngineFromManifest(options.engineManifest, {
        root: options.engineRoot ?? path.dirname(options.engineManifest),
      })
      return {
        command: engine.command,
        source: "manifest",
        version: PINNED_RUNTIME_VERSION,
        sha256: engine.sha256,
        manifestPath: engine.manifestPath,
      }
    } catch (error) {
      if (error instanceof EngineManifestError)
        throw new RuntimeNotFoundError(
          `the local engine could not be verified, so Bashwink will not start:\n  ${error.message}`,
        )
      throw error
    }
  }

  const override = options.bundledOnly === true ? undefined : process.env["BASHWINK_OPENCODE_BIN"]
  if (override) {
    if (!isExecutable(override))
      throw new RuntimeNotFoundError(
        `BASHWINK_OPENCODE_BIN points at '${override}', which is not an executable file`,
      )
    return { command: override, source: "env", version: PINNED_RUNTIME_VERSION }
  }

  if (options.bundled !== undefined && isExecutable(options.bundled))
    return { command: options.bundled, source: "bundled", version: PINNED_RUNTIME_VERSION }
  if (options.bundledOnly === true)
    throw new RuntimeNotFoundError(
      "the pinned OpenCode runtime that ships with this release is missing. Reinstall Bashwink from the release archive.",
    )

  const local = fromNodeModules(options.cwd ?? process.cwd())
  if (local) return { command: local, source: "package", version: PINNED_RUNTIME_VERSION }

  const global = fromPath()
  if (global) return { command: global, source: "path", version: PINNED_RUNTIME_VERSION }

  throw new RuntimeNotFoundError(
    `no OpenCode runtime found (looked for ${BINARIES.join("/")} in node_modules/.bin and on PATH).\n` +
      `Install the pinned runtime this build was tested against:\n` +
      `    bun add @opencode/cli@${PINNED_RUNTIME_VERSION}\n` +
      `or point BASHWINK_OPENCODE_BIN at an existing binary.`,
  )
}
