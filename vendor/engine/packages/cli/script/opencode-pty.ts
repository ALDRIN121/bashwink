import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Locate the PTY helper to embed in a CLI build.
 *
 * Upstream resolved this through `@opencode/pty` and its eight platform packages, via an eager
 * `createRequire` at module load. That eager require is the reason the build fails outright when
 * the registry package is absent — it throws before any function here is called. Bashwink builds
 * the helper from `vendor/engine/packages/process-daemon`, so this resolves a local artifact and
 * never touches the registry.
 *
 * A target with no local helper returns `undefined`, which is the build script's contract for
 * "no asset for this target". The caller must treat that as "this target cannot be built", not as
 * "ship without a PTY".
 */

export type OpencodePtyAsset = {
  readonly source: string
  readonly version: string
  readonly sha256: string
}

type Target = {
  readonly platform: string
  readonly arch: string
  readonly libc?: "glibc" | "musl"
}

export async function resolveOpencodePty(target: Target): Promise<OpencodePtyAsset | undefined> {
  if (target.platform !== "darwin" && target.platform !== "linux" && target.platform !== "win32") return undefined
  if (target.arch !== "arm64" && target.arch !== "x64") return undefined

  // Kept from upstream purely for error text: Linux package names mapped `glibc` to `gnu`, so a
  // reader searching for that string finds an explanation instead of silence.
  const suffix = [target.platform, target.arch, target.platform === "linux" ? (target.libc ?? "glibc") : undefined]
    .filter(Boolean)
    .map((value) => (value === "glibc" ? "gnu" : value))
    .join("-")

  const explicit = process.env.OPENCODE_PTY_BIN
  if (explicit && (target.platform !== process.platform || target.arch !== process.arch))
    throw new Error("OPENCODE_PTY_BIN can only be embedded in a build for the current platform and architecture")

  // An explicit binary wins; otherwise the local artifact directory. The file name is derived
  // from the target, not the host, so a cross-target build cannot quietly pick up the host's
  // helper.
  const source = explicit ? path.resolve(explicit) : localArtifact(target)
  if (!source) return undefined

  let bytes: Buffer
  try {
    bytes = await readFile(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `PTY helper for ${suffix} not found at ${source}. Build it from ` +
          `vendor/engine/packages/process-daemon (cargo build --locked --release) and set ` +
          `BASHWINK_PTY_DIR, or set OPENCODE_PTY_BIN for a current-platform build. ` +
          `The @opencode/pty registry package is not used.`,
      )
    throw error
  }

  return {
    source,
    version: explicit ? "local" : await readLocalVersion(path.dirname(source)),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function localArtifact(target: Target): string | undefined {
  const dir = process.env.BASHWINK_PTY_DIR
  if (!dir || dir.trim() === "") return undefined
  const name = target.platform === "win32" ? "opencode-pty.exe" : "opencode-pty"
  return path.join(path.resolve(dir), name)
}

async function readLocalVersion(dir: string): Promise<string> {
  try {
    const raw = await readFile(path.join(dir, "version.txt"), "utf8")
    const version = raw.trim()
    return version === "" ? "unknown" : version
  } catch {
    // "unknown" is honest. Inventing a version would make an unattributable artifact look pinned.
    return "unknown"
  }
}
