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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

/** Plugin id that must be registered before any policy plugin (ADR-002). */
export const EVIDENCE_PLUGIN_ID = "bashwink-evidence"

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
 * Write the plugin directory contents for a run.
 *
 * Each plugin is a **symlink to its real package directory**.
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
export function stagePlugins(root: string, specs: readonly PluginSpec[]): StagedPlugin[] {
  const pluginRoot = path.join(root, "plugin")
  // Removing first is what actually disables a plugin (ADR-002 constraint 2).
  rmSync(pluginRoot, { recursive: true, force: true })
  mkdirSync(pluginRoot, { recursive: true })

  const staged: StagedPlugin[] = []
  for (const spec of planPlugins(specs)) {
    const target = path.join(pluginRoot, spec.id)
    const entry = path.join(spec.directory, "src", "index.ts")
    if (!existsSync(entry))
      throw new Error(`plugin '${spec.id}' has no entry at ${entry}; cannot stage it`)
    symlinkSync(spec.directory, target, "dir")
    staged.push({ id: spec.id, path: target, entry })
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
