/**
 * Bashwink's own config/home paths, and the plugin staging directory.
 *
 * Two separate concerns live here because they share the same root:
 *
 * 1. **Path isolation.** Bashwink must not read or write a real OpenCode install's config.
 *    OpenCode resolves roots from `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
 *    `XDG_STATE_HOME`, so a scratch `HOME` alone is not enough to isolate a run — all four
 *    have to be set, which `environmentFor()` does.
 *
 * 2. **Plugin staging.** ADR-002 constraint 2: OpenCode loads *every* entry in the plugin
 *    directory, so the config's `plugins` array does not control enablement or order.
 *    `stagePlugins()` therefore writes the directory contents itself, and `planPlugins()`
 *    returns the ordered list so a test can assert the security-critical ordering rather
 *    than trusting directory-discovery order.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

/** Plugin id that must be registered before any policy plugin (ADR-002). */
export const EVIDENCE_PLUGIN_ID = "bashwink-evidence"

/**
 * Raised when a plugin directory exists but the runtime would not find an entry for it.
 *
 * This is deliberately an error rather than a warning: a staged directory the runtime cannot
 * resolve is dropped by OpenCode's discovery with no log line at all, so staging is the last
 * point where the failure can still be made loud.
 */
export class PluginEntryError extends Error {
  readonly code = "plugin_entry_not_found"
  constructor(message: string) {
    super(message)
    this.name = "PluginEntryError"
  }
}

/**
 * Locate the evidence plugin directory, in the order that works for both layouts.
 *
 * This used to be `<repo>/packages/bw-evidence`, computed from the CLI module's location.
 * That is correct in the source checkout and wrong the moment the CLI is installed as a
 * package: `node_modules/@bashwink/cli/src` three levels up is `node_modules`, so staging
 * looked for `node_modules/packages/bw-evidence`, found nothing, and — because a missing
 * directory produced no staged plugin — the run proceeded with no recorder at all. The
 * failure was invisible except as evidence that never appeared, which is the exact class of
 * silent failure BW-014 exists to remove.
 *
 * So resolution is explicit and ordered, and a miss throws with the paths it tried.
 */
export function resolvePluginDirectory(
  candidates: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment["BASHWINK_PLUGIN_DIR"]
  if (override !== undefined) {
    const directory = path.resolve(override)
    if (!existsSync(directory))
      throw new PluginEntryError(
        `BASHWINK_PLUGIN_DIR points at '${override}', which does not exist`,
      )
    return directory
  }
  for (const candidate of candidates) {
    const directory = path.resolve(candidate)
    if (existsSync(path.join(directory, "package.json"))) return directory
  }
  throw new PluginEntryError(
    "the evidence plugin directory could not be found.\n" +
      `looked in:\n${candidates.map((candidate) => `    ${path.resolve(candidate)}`).join("\n")}\n` +
      "run `bashwink doctor` to re-check the install, or set BASHWINK_PLUGIN_DIR.",
  )
}

export interface PluginSpec {
  readonly id: string
  /** Absolute path to the plugin directory that gets linked/copied into staging. */
  readonly directory: string
  /**
   * Registration order. Lower runs first. The evidence recorder must be lowest so it still
   * sees a call that a later policy plugin denies (ADR-002 constraint 1).
   */
  readonly order: number
}

/**
 * Order a plugin list for staging.
 *
 * Evidence is forced first regardless of what the caller passed: a caller that gets this
 * wrong produces an audit blind spot rather than an error, so it is not left to the caller.
 * Ties keep the caller's order via a stable sort.
 */
export function planPlugins(specs: readonly PluginSpec[]): PluginSpec[] {
  const sorted = [...specs].sort((a, b) => a.order - b.order)
  const evidence = sorted.filter((spec) => spec.id === EVIDENCE_PLUGIN_ID)
  const rest = sorted.filter((spec) => spec.id !== EVIDENCE_PLUGIN_ID)
  return [...evidence, ...rest]
}

/**
 * Write the config the child runtime reads.
 *
 * Two things this has to get right:
 *   - `plugins` is written in explicit order (evidence first) as documentation of intent, but
 *     ADR-002 established that discovery ignores it, so `stagePlugins` owns the real ordering.
 *   - A freshly-created config must not clobber an existing one wholesale: a user's providers
 *     and models belong in their own file, so only Bashwink-managed keys are written.
 */
export function writeConfig(root: string, pluginIds: readonly string[]): string {
  const file = path.join(root, "opencode.json")
  let existing: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    } catch {
      // A corrupt user config is their problem to fix, but losing it silently is worse:
      // the caller is told by the thrown error from the JSON parse above, so this branch
      // only guards against a non-object root.
      existing = {}
    }
  }
  const config = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    plugins: pluginIds.map((id) => `./plugin/${id}`),
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return file
}

export interface StagedPlugin {
  readonly id: string
  /** Directory written into the staging root. */
  readonly path: string
  /** The entry file OpenCode's `exports` resolution will find. */
  readonly entry: string
}

/**
 * Resolve the entry file the way OpenCode's `Host.resolve` does.
 *
 * The runtime's rules, read from the pinned source (`packages/plugin/src/host.ts`):
 *   1. If the directory's `package.json` has a string `name` **and** an `exports` field, the
 *      plugin is resolved through its exports map — subpath `server` first, then `"."`.
 *   2. Otherwise it falls back to conventional root file names: `server.*`, then `index.*`.
 *   3. The resolved file must live inside the plugin directory (`FSUtil.contains`).
 *
 * Getting this wrong is not a cosmetic bug. In the probe that motivated this function, a
 * directory whose entry lived at `src/index.ts` without an `exports` map was accepted by
 * `stagePlugins` and then **silently dropped by the runtime**: no warning, no error, an exit
 * code of 0, and an empty evidence log. Staging now refuses that directory instead.
 */
export function resolvePluginEntry(directory: string): string {
  let stats
  try {
    stats = statSync(directory)
  } catch {
    throw new PluginEntryError(`plugin directory '${directory}' does not exist`)
  }
  if (!stats.isDirectory())
    throw new PluginEntryError(`plugin path '${directory}' is not a directory`)

  const manifest = readManifest(directory)
  // The runtime prefers a `server` subpath and falls back to the package root.
  const target =
    manifest?.exports === undefined
      ? undefined
      : (exportTarget(manifest.exports, "./server") ?? exportTarget(manifest.exports, "."))
  if (manifest?.name !== undefined && manifest.exports !== undefined && target !== undefined) {
    const candidate = path.resolve(directory, target)
    return assertInside(directory, candidate, `exports${target.startsWith(".") ? " target" : ""}`)
  }

  for (const name of CONVENTIONAL_ENTRIES) {
    const candidate = path.join(directory, name)
    if (isFile(candidate)) return candidate
  }

  throw new PluginEntryError(
    `plugin '${directory}' has no resolvable server entry. ` +
      `OpenCode drops such a directory without logging anything. ` +
      `Add an exports map ('.': './src/index.ts') or a conventional ${CONVENTIONAL_ENTRIES.join("/")} file at the package root.`,
  )
}

/** Root-level file names OpenCode falls back to when there is no usable exports map. */
const CONVENTIONAL_ENTRIES = [
  "server.ts",
  "server.tsx",
  "server.js",
  "server.mjs",
  "server.cjs",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
  "index.cjs",
] as const

interface Manifest {
  readonly name?: string
  readonly exports?: unknown
}

/** Read only the two fields resolution cares about. A malformed manifest counts as absent. */
function readManifest(directory: string): Manifest | undefined {
  const file = path.join(directory, "package.json")
  if (!isFile(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
      ...(record["exports"] === undefined ? {} : { exports: record["exports"] }),
    }
  } catch {
    return undefined
  }
}

/**
 * The `"."` target of an exports map, as a relative path.
 *
 * Handles the shapes that occur in practice: a bare string, a conditions object
 * (`import`/`default`/`require`), an array of fallbacks, and the `{ ".": ... }` subpath form.
 */
function exportTarget(exports: unknown, subpath: "./server" | "."): string | undefined {
  const fromConditions = (value: unknown): string | undefined => {
    if (typeof value === "string") return value
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = fromConditions(item)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>
      for (const key of ["import", "default", "require", "node", "browser", "types"])
        if (record[key] !== undefined) {
          const found = fromConditions(record[key])
          if (found !== undefined) return found
        }
    }
    return undefined
  }

  // A bare string or array is shorthand for the root export only.
  if (typeof exports === "string" || Array.isArray(exports))
    return subpath === "." ? fromConditions(exports) : undefined
  if (typeof exports === "object" && exports !== null) {
    const record = exports as Record<string, unknown>
    if (record[subpath] !== undefined) return fromConditions(record[subpath])
    // An exports map made only of subpaths does not export anything else: no guessing.
    if (Object.keys(record).some((key) => key.startsWith("."))) return undefined
    // A bare conditions object (`{ import: … }`) is shorthand for the root export.
    return subpath === "." ? fromConditions(exports) : undefined
  }
  return undefined
}

/** Refuse an entry that escapes its package, which the runtime also refuses. */
function assertInside(directory: string, candidate: string, label: string): string {
  if (!isFile(candidate))
    throw new PluginEntryError(`plugin entry '${candidate}' (${label}) does not exist`)
  const root = realpathSync(directory)
  const real = realpathSync(candidate)
  const relative = path.relative(root, real)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new PluginEntryError(
      `plugin entry '${candidate}' resolves outside its package directory '${directory}'; the runtime refuses that`,
    )
  return candidate
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a plugin must be staged as a **copy** instead of a symlink.
 *
 *   - Under a `node_modules` directory (an npm install): OpenCode's JSX transform for terminal-UI
 *     plugins skips files whose path contains `node_modules`, so the plugin's `.tsx` falls to the plain
 *     transpiler and fails with "Cannot find package '@opentui/solid'". Measured on the npm-installed
 *     package: identical files fail under `…/node_modules/bashwink/lib/evidence` and load from a copy
 *     at a path without that segment. The runtime resolves a symlink to its real path, so a link does not help.
 *   - On Windows: creating a symlink needs a privilege ordinary users do not have.
 */
export function mustCopyPlugin(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return true
  let real = directory
  try {
    real = realpathSync(directory)
  } catch {
    // an unresolvable directory is reported by resolvePluginEntry
  }
  return real.split(/[\\/]+/).includes("node_modules")
}

/** What a staged copy leaves out: dependencies (the host provides `@opencode/plugin`; its loader refuses a second copy) and tooling. */
const NOT_COPIED = new Set(["node_modules", ".turbo", ".git"])

function copyPlugin(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => !NOT_COPIED.has(path.basename(entry)),
  })
}

/** Put `built` (a finished directory) at `target`, replacing what is there with as small a gap as the file system allows. */
function publishDirectory(built: string, target: string): void {
  let displaced: string | undefined
  try {
    if (existsSync(target) || isLink(target)) {
      displaced = `${target}.old-${process.pid}`
      renameSync(target, displaced)
    }
    renameSync(built, target)
  } finally {
    if (displaced !== undefined) rmSync(displaced, { recursive: true, force: true })
  }
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Write the plugin directory contents for a run.
 *
 * Each plugin is, by default, a **symlink to its real package directory**; a package that cannot
 * be loaded through a link (see `mustCopyPlugin`) is staged as a fresh copy on every run, so it cannot
 * be stale after an upgrade.
 *
 * Two earlier attempts were wrong, and both failed *silently*:
 *   - `exports: { ".": "<absolute path>" }` — an `exports` target must be a relative
 *     specifier (`./…`), so the runtime skipped the plugin with no error at all.
 *   - a re-export shim with a `../../..` specifier — correct in principle, but it broke
 *     whenever the staging root and the package lived on different real paths (`/tmp` is a
 *     symlink to `/private/tmp` on macOS), and again with no error.
 *
 * A symlink is the honest model anyway: the staged plugin *is* the package, so it cannot drift
 * from it, and its own dependencies (`@opencode/plugin`) resolve from the real location. It
 * also keeps ADR-002's rule intact — deleting the directory is a real uninstall.
 */
export function stagePlugins(
  root: string,
  specs: readonly PluginSpec[],
  options: {
    readonly preserveExisting?: boolean
    /** Test hook: pretend to be another platform when deciding link or copy. */
    readonly platform?: NodeJS.Platform
  } = {},
): StagedPlugin[] {
  const pluginRoot = path.join(root, "plugin")
  // Removing first is what actually disables a plugin (ADR-002 constraint 2).
  if (!options.preserveExisting) rmSync(pluginRoot, { recursive: true, force: true })
  mkdirSync(pluginRoot, { recursive: true })

  const staged: StagedPlugin[] = []
  for (const spec of planPlugins(specs)) {
    const target = path.join(pluginRoot, spec.id)
    // Resolve exactly as the runtime will. A directory that resolves to nothing is dropped
    // by OpenCode's discovery with no log line, so it must fail here instead.
    const entry = resolvePluginEntry(spec.directory)
    const copy = mustCopyPlugin(spec.directory, options.platform)
    // OpenCode watches the staging directory. Build the replacement completely first and
    // only touch the requested slot.
    if (options.preserveExisting || copy) {
      const temporary = mkdtempSync(path.join(root, ".plugin-stage-"))
      try {
        const built = path.join(temporary, spec.id)
        if (copy) copyPlugin(spec.directory, built)
        else symlinkSync(spec.directory, built, "dir")
        if (options.preserveExisting) publishDirectory(built, target)
        else renameSync(built, target)
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    } else symlinkSync(spec.directory, target, "dir")
    staged.push({
      id: spec.id,
      path: target,
      entry: copy ? path.join(target, path.relative(spec.directory, entry)) : entry,
    })
  }
  return staged
}

/** Ids currently on disk, in discovery-independent (sorted) order. */
export function stagedPluginIds(root: string): string[] {
  const pluginRoot = path.join(root, "plugin")
  try {
    return readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export interface Paths {
  readonly config: string
  readonly data: string
  readonly cache: string
  readonly state: string
  /** SQLite plan/task store. */
  readonly database: string
  /** Evidence JSONL directory. */
  readonly evidence: string
}

/**
 * Resolve Bashwink's directories.
 *
 * `BASHWINK_HOME` takes priority so a test or a user can relocate everything at once; it is
 * documented in `--help` because a hidden env var that changes where state lives is a
 * support burden.
 */
export function paths(environment: NodeJS.ProcessEnv = process.env): Paths {
  const override = environment["BASHWINK_HOME"]
  if (override) {
    const root = path.resolve(override)
    return {
      config: root,
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      state: path.join(root, "state"),
      database: path.join(root, "data", "bashwink.sqlite"),
      evidence: path.join(root, "data", "evidence"),
    }
  }
  const xdg = {
    config: environment["XDG_CONFIG_HOME"] ?? path.join(environment["HOME"] ?? ".", ".config"),
    data: environment["XDG_DATA_HOME"] ?? path.join(environment["HOME"] ?? ".", ".local", "share"),
    cache: environment["XDG_CACHE_HOME"] ?? path.join(environment["HOME"] ?? ".", ".cache"),
    state:
      environment["XDG_STATE_HOME"] ?? path.join(environment["HOME"] ?? ".", ".local", "state"),
  }
  const data = path.join(xdg.data, "bashwink")
  return {
    config: path.join(xdg.config, "bashwink"),
    data,
    cache: path.join(xdg.cache, "bashwink"),
    state: path.join(xdg.state, "bashwink"),
    database: path.join(data, "bashwink.sqlite"),
    evidence: path.join(data, "evidence"),
  }
}

/**
 * Environment for the child runtime.
 *
 * All four XDG roots are set, because leaving one unset silently points the child at the real
 * user config — which is how a "sandboxed" run edits the developer's own OpenCode settings.
 */
export function environmentFor(
  resolved: Paths,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const child: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) child[key] = value
  child["OPENCODE_CONFIG_DIR"] = resolved.config
  child["XDG_CONFIG_HOME"] = path.dirname(resolved.config)
  child["XDG_DATA_HOME"] = path.dirname(resolved.data)
  child["XDG_CACHE_HOME"] = path.dirname(resolved.cache)
  child["XDG_STATE_HOME"] = path.dirname(resolved.state)
  child["BASHWINK_EVIDENCE_DIR"] = resolved.evidence
  return child
}

/** Create every directory Bashwink needs. Idempotent. */
export function ensurePaths(resolved: Paths): void {
  for (const directory of [
    resolved.config,
    resolved.data,
    resolved.cache,
    resolved.state,
    resolved.evidence,
  ])
    mkdirSync(directory, { recursive: true })
}
