import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Local replacement for the `@opencode/pty` registry package.
 *
 * Upstream resolves the PTY helper through `@opencode/pty`, which ships eight platform-specific
 * packages and a `binaryPath` export. Bashwink builds the helper from the vendored
 * `packages/process-daemon` source instead, so the registry package must not be required — but
 * two call sites still need the same information it provided:
 *
 *   - the CLI build needs a source path, a version and a SHA-256 to embed;
 *   - the core binding needs a path to the helper for the packaged runtime.
 *
 * This module supplies both from a local artifact, and fails loudly rather than falling back to
 * a registry package or a bare `opencode-pty` on PATH. Falling back would mean a build that
 * appears to work while silently depending on something the migration is meant to remove.
 */

export type PtyAsset = {
  readonly source: string
  readonly version: string
  readonly sha256: string
}

/** Name of the helper binary, by platform. Windows only launches executables with an extension. */
export function ptyBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "opencode-pty.exe" : "opencode-pty"
}

/**
 * The local artifact directory, when Bashwink supplies one.
 *
 * `BASHWINK_PTY_DIR` points at a directory holding `opencode-pty` (or `opencode-pty.exe`). It is
 * the single seam the build and the packaged launcher both use, so a build cannot embed one
 * helper while the runtime launches another.
 */
export function localPtyDirectory(): string | undefined {
  const dir = process.env.BASHWINK_PTY_DIR
  return dir && dir.trim() !== "" ? path.resolve(dir) : undefined
}

/**
 * Resolve the helper for embedding into a build.
 *
 * Returns `undefined` when there is no local artifact and no explicit override, which is the
 * signal to the caller that a target cannot be built. It does not throw "not found here, try the
 * registry": that is exactly the fallback this migration removes.
 */
export async function resolveLocalPty(
  target: { readonly platform: string; readonly arch: string },
  options: { readonly require?: boolean } = {},
): Promise<PtyAsset | undefined> {
  // An explicit binary wins, and may only be embedded in a build for its own platform — the same
  // restriction upstream applies, because a cross-platform embed would ship the wrong executable.
  const explicit = process.env.OPENCODE_PTY_BIN
  if (explicit) {
    if (target.platform !== process.platform || target.arch !== process.arch)
      throw new Error(
        "OPENCODE_PTY_BIN can only be embedded in a build for the current platform and architecture",
      )
    return describe(path.resolve(explicit), "local")
  }

  const dir = localPtyDirectory()
  if (!dir) {
    if (options.require)
      throw new Error(
        "No local PTY helper. Build it from vendor/engine/packages/process-daemon and set " +
          "BASHWINK_PTY_DIR, or pass OPENCODE_PTY_BIN for a current-platform build. " +
          "The @opencode/pty registry package is not used.",
      )
    return undefined
  }

  const candidate = path.join(dir, ptyBinaryName(target.platform as NodeJS.Platform))
  return describe(candidate, await readLocalVersion(dir))
}

async function readLocalVersion(dir: string): Promise<string> {
  // The version travels with the artifact so an embedded helper is attributable. A missing
  // version file is not fatal — "unknown" is honest, and inventing one would not be.
  try {
    const raw = await readFile(path.join(dir, "version.txt"), "utf8")
    const version = raw.trim()
    return version === "" ? "unknown" : version
  } catch {
    return "unknown"
  }
}

async function describe(source: string, version: string): Promise<PtyAsset> {
  let bytes: Buffer
  try {
    bytes = await readFile(source)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT")
      throw new Error(
        `PTY helper not found at ${source}. Build it from vendor/engine/packages/process-daemon ` +
          "and set BASHWINK_PTY_DIR; a missing helper must not fall back to PATH or the registry.",
      )
    throw error
  }
  return {
    source,
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

/**
 * Path for the packaged runtime to launch.
 *
 * Mirrors the shape upstream's `binaryPath` export had, but resolves locally and never returns a
 * bare command name that would be satisfied by anything on PATH.
 */
export const binaryPath: string | undefined = (() => {
  const dir = localPtyDirectory()
  if (dir) return path.join(dir, ptyBinaryName())
  const explicit = process.env.OPENCODE_PTY_BIN
  return explicit ? path.resolve(explicit) : undefined
})()
