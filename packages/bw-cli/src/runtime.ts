/**
 * Locating the pinned OpenCode runtime.
 *
 * ADR-003: `bashwink` is a thin launcher that execs the pinned runtime rather than forking
 * it. That makes *resolution* the load-bearing part — if this guesses wrong, the user runs a
 * different agent than the one the wrapper tested. So resolution is explicit and ordered,
 * and a failure says exactly what to install.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

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
  readonly source: "env" | "bundled" | "package" | "path"
  readonly version: string
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
}

/**
 * Resolve the runtime in a documented order:
 *   1. `BASHWINK_OPENCODE_BIN` — explicit override (used by tests and by `doctor`)
 *   2. `node_modules/.bin/opencode` at or above the working directory
 *   3. `opencode` on `PATH`
 *
 * Throws a message a user can act on instead of a bare ENOENT.
 */
export function resolveRuntime(options: ResolveOptions = {}): RuntimeLocation {
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
