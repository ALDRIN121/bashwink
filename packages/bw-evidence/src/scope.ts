/**
 * BW-059 — ScopeFence: the allowedPaths policy, evaluated at the tool boundary.
 *
 * Why this module exists rather than a prompt: a TaskContract's `allowedPaths` was recorded and
 * displayed, and nothing enforced it. The model could write anywhere the runtime's permission
 * prompts allowed. A contract the agent can ignore is documentation, not a boundary.
 *
 * The enforcement point is the plugin's `execute.before` hook, which upstream treats as the one
 * hook whose failure **rejects the call before it runs** (`packages/core/src/plugin/hooks.ts`:
 * "Only tool execute.before may fail: a Tool.Error rejects the call before it runs"). That is
 * the earliest place a write can be stopped, and it is why this is a plugin rather than a
 * wrapper-side check on the finished diff.
 *
 * Two properties this design refuses to trade away:
 *
 *  1. **Symlinks are resolved, not string-matched.** `workspace/link -> /etc` then a write to
 *     `link/passwd` is lexically "inside the workspace" and physically `/etc/passwd`. Containing
 *     by prefix would allow it. Every target is resolved through `realpath` of its deepest
 *     existing ancestor before the containment test.
 *  2. **Shell is not claimed to be bounded.** A shell string can write anywhere through an
 *     interpreter (`python3 -c "open('/etc/passwd','w')"`), and no parser fixes that. So shell
 *     calls have their obvious escapes rejected and every one is recorded as unconstrained.
 *     A real boundary needs an OS sandbox (BW-031); this is a guardrail that is honest about
 *     being one.
 */

import { lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

export type ScopeMode = "off" | "enforce"

export interface ScopePolicy {
  readonly mode: ScopeMode
  readonly workspace?: string
  readonly forbiddenPaths?: readonly string[]
  /** Roots a **write** may touch. Each is resolved to a real path at load time. */
  readonly allowedPaths: readonly string[]
  /**
   * Roots a **read** may touch, and the only place a shell command may run.
   *
   * Wider than `allowedPaths` by design. Narrowing writes is the point of a scope fence;
   * narrowing reads to the same set would stop the agent from seeing the repository it is
   * supposed to change, and narrowing the shell's working directory to it made even
   * `python3 -m pytest` impossible — both observed when this policy was first run against a
   * real model, which answered by repeatedly retrying a command it was not allowed to run.
   */
  readonly readPaths: readonly string[]
  /**
   * Whether the shell tool may run at all.
   *
   * Not a path setting: it is the acknowledged escape hatch. When false, every shell call is
   * refused, which makes the scope a genuine (if blunt) boundary for a task that only needs
   * file edits.
   */
  readonly allowShell: boolean
  /**
   * Why this policy exists, so a refusal can name its cause and its fix.
   *
   * A refusal that cannot say why is a dead end: the first real interactive session on an
   * untrusted workspace told the user "outside this task's allowed paths ()" and "this
   * contract allows file edits only" when there was no contract at all. The model could only
   * report that its permissions were wrong, not that `bashwink trust` was the missing step.
   */
  readonly origin?: "trust" | "contract"
}

/** Tools that mutate one file. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"])
/** Tools that only read one file. */
const READ_TOOLS = new Set(["read", "glob", "grep"])
const SEARCH_TOOLS = new Set(["glob", "grep"])
const SESSION_TOOLS = new Set(["todowrite", "question"])
/** Tools whose input is a patch document containing several targets. */
const PATCH_TOOLS = new Set(["patch", "apply_patch"])
const SHELL_TOOLS = new Set(["shell", "bash"])

export type ScopeVerdict =
  | { readonly allow: true; readonly unconstrained?: boolean; readonly note?: string }
  | {
      readonly allow: false
      readonly reason: string
      readonly target?: string
      /** Which rule refused it, so the audit says more than "no". */
      readonly rule?:
        | "write-scope"
        | "read-scope"
        | "shell-scope"
        | "shell-disabled"
        | "invalid-input"
        | "unsupported-tool"
    }

export interface ScopeInput {
  readonly tool: string
  readonly input: unknown
  /** The runtime's resolved workspace root for this call. */
  readonly cwd: string
}

/**
 * Resolve a path to its physical location, following symlinks, without requiring it to exist.
 *
 * `realpathSync` throws on a missing file, and a write to a new file is the normal case. So the
 * deepest existing ancestor is resolved and the remaining segments are re-joined: that catches a
 * symlinked directory (`link -> /etc`) while still accepting `src/new.ts`.
 */
export function physicalPath(target: string): string {
  let probe = path.resolve(target)
  const tail: string[] = []
  // Bound the walk: a filesystem cannot have more components than this, and a pathological
  // path must not spin.
  for (let depth = 0; depth < 4096; depth += 1) {
    try {
      lstatSync(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(probe)
      if (parent === probe) throw error
      tail.push(path.basename(probe))
      probe = parent
      continue
    }
    const real = realpathSync(probe)
    return tail.length === 0 ? real : path.join(real, ...tail.reverse())
  }
  throw new Error("path resolution exceeded its depth limit")
}

/** True when `target` is `root` or inside it. Separator-aware, so `/a/bc` is not inside `/a/b`. */
export function contains(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedTarget = path.resolve(target)
  if (normalizedTarget === normalizedRoot) return true
  const relative = path.relative(normalizedRoot, normalizedTarget)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Build a policy from the contract's declared paths.
 *
 * Roots are resolved once, at load time. A root that does not exist yet is still accepted (a
 * task may create its output directory), but it is resolved physically so a later symlink at
 * that location cannot silently re-point the boundary.
 */
export function makePolicy(input: {
  readonly mode: ScopeMode
  readonly allowedPaths: readonly string[]
  /** Defaults to the workspace root, which is what a run always has. */
  readonly readPaths?: readonly string[]
  readonly allowShell?: boolean
  readonly origin?: "trust" | "contract"
  readonly cwd: string
}): ScopePolicy {
  return {
    mode: input.mode,
    allowedPaths: input.allowedPaths.map((entry) => physicalPath(path.resolve(input.cwd, entry))),
    readPaths: (input.readPaths ?? [input.cwd]).map((entry) =>
      physicalPath(path.resolve(input.cwd, entry)),
    ),
    allowShell: input.allowShell ?? true,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
}

/** Read a policy document, refusing anything it cannot fully understand. */
export function parsePolicy(document: unknown): ScopePolicy | undefined {
  if (typeof document !== "object" || document === null) return undefined
  const record = document as Record<string, unknown>
  const mode = record["mode"]
  if (mode !== "off" && mode !== "enforce") return undefined
  const forbidden = record["forbiddenPaths"]
  if (
    forbidden !== undefined &&
    (!Array.isArray(forbidden) || forbidden.some((entry) => typeof entry !== "string"))
  )
    return undefined
  const workspace = record["workspace"]
  if (workspace !== undefined && (typeof workspace !== "string" || !path.isAbsolute(workspace)))
    return undefined
  const raw = record["allowedPaths"]
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) return undefined
  const allowShell = record["allowShell"]
  if (allowShell !== undefined && typeof allowShell !== "boolean") return undefined
  const rawRead = record["readPaths"]
  if (
    rawRead !== undefined &&
    (!Array.isArray(rawRead) || rawRead.some((e) => typeof e !== "string"))
  )
    return undefined
  const origin = record["origin"]
  if (origin !== undefined && origin !== "trust" && origin !== "contract") return undefined
  return {
    mode,
    allowedPaths: raw as string[],
    ...(workspace === undefined ? {} : { workspace }),
    ...(forbidden === undefined ? {} : { forbiddenPaths: forbidden as string[] }),
    readPaths: (rawRead as string[] | undefined) ?? (raw as string[]),
    allowShell: allowShell ?? true,
    ...(origin === undefined ? {} : { origin }),
  }
}

/** Launcher documents carry every authority explicitly. Legacy plugin documents retain defaults. */
export function parseLaunchPolicy(document: unknown): ScopePolicy | undefined {
  const policy = parsePolicy(document)
  if (
    policy?.mode !== "enforce" ||
    policy.workspace === undefined ||
    policy.forbiddenPaths === undefined
  )
    return undefined
  const fields = document as Record<string, unknown>
  if (typeof fields["allowShell"] !== "boolean" || !Array.isArray(fields["readPaths"]))
    return undefined
  return [...policy.allowedPaths, ...policy.readPaths, ...policy.forbiddenPaths].every(
    path.isAbsolute,
  )
    ? policy
    : undefined
}

/** Extract the file targets a patch document would touch. */
export function patchTargets(patchText: string): string[] {
  const targets: string[] = []
  // The patch grammar the runtime uses marks each operation with a `*** <Op> File: <path>` line.
  const pattern = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/
  for (const line of patchText.split("\n")) {
    const target = line.trim().match(pattern)?.[1]?.trim()
    if (target !== undefined && target !== "") targets.push(target)
  }
  return targets
}

/**
 * Path-like tokens in a shell command, best effort.
 *
 * Not a shell parser, and not trying to be: quotes, substitutions and heredocs defeat tokenising,
 * and an interpreter can open any path from a string that looks innocent. This exists to catch
 * the obvious `cat /etc/passwd` and `../..` cases so they are *denied* rather than merely
 * recorded, and its limits are stated in the evidence as `unconstrained`.
 */
export function shellPathTokens(command: string): string[] {
  const tokens = command.match(/(?:[^\s"'`;&|<>()]+)/g) ?? []
  return tokens.filter(
    (token) =>
      token.includes("/") &&
      !token.startsWith("-") &&
      !/^[a-z]+:\/\//i.test(token) && // URLs are not filesystem paths
      !token.includes("$"), // a substituted path is unknowable here; recorded, not judged
  )
}

function targetOfFileTool(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ["path", "filePath", "file_path", "file"]) {
    const value = record[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

/** Match the pinned OpenCode FileAccess expansion before physical resolution. */
function toolPath(cwd: string, input: string): string {
  if (input === "~") return physicalPath(homedir())
  if (input.startsWith("~/")) return physicalPath(path.resolve(homedir(), `./${input.slice(2)}`))
  return physicalPath(path.resolve(cwd, input))
}

function invalidInput(reason: string): ScopeVerdict {
  return { allow: false, rule: "invalid-input", reason }
}

function canWrite(policy: ScopePolicy, target: string): boolean {
  return (
    policy.allowedPaths.some((root) => contains(root, target)) &&
    (policy.workspace === undefined || contains(policy.workspace, target)) &&
    !policy.forbiddenPaths?.some((root) => contains(root, target))
  )
}

/** Refuse malformed calls and paths that cannot be resolved safely. */
export function evaluate(policy: ScopePolicy, input: ScopeInput): ScopeVerdict {
  if (policy.mode === "off") return { allow: true }
  try {
    const cwd = physicalPath(input.cwd)
    if (policy.workspace !== undefined && cwd !== policy.workspace)
      return invalidInput("the runtime workspace does not match the approved launch workspace")
    return evaluateCall(policy, { ...input, cwd })
  } catch {
    return invalidInput("the requested path could not be resolved safely")
  }
}

function evaluateCall(policy: ScopePolicy, input: ScopeInput): ScopeVerdict {
  const cwd = input.cwd

  if (WRITE_TOOLS.has(input.tool)) {
    const raw = targetOfFileTool(input.input)
    if (raw === undefined) return invalidInput("a file path is required")
    const target = toolPath(cwd, raw)
    if (canWrite(policy, target)) return { allow: true }
    return {
      allow: false,
      rule: "write-scope",
      target,
      reason:
        policy.origin === "trust"
          ? `this workspace is not trusted, so no file may be written. '${raw}' would have ` +
            `written ${target}. Run \`bashwink trust ${cwd}\` to allow edits here.`
          : policy.allowedPaths.length === 0
            ? `no file writes are permitted here: the workspace is not trusted, or the task's ` +
              `contract allows no paths. '${raw}' would have written ${target}.`
            : `'${raw}' resolves to ${target}, which is outside this task's allowed paths ` +
              `(${policy.allowedPaths.join(", ")}).`,
    }
  }

  if (READ_TOOLS.has(input.tool)) {
    const record = input.input as Record<string, unknown> | undefined
    const raw =
      targetOfFileTool(input.input) ??
      (SEARCH_TOOLS.has(input.tool) && record?.["path"] === undefined ? "." : undefined)
    if (raw === undefined) return invalidInput("a readable path is required")
    const target = toolPath(cwd, raw)
    if (policy.readPaths.some((root) => contains(root, target))) return { allow: true }
    return {
      allow: false,
      rule: "read-scope",
      target,
      reason:
        policy.origin === "trust"
          ? `this workspace is not trusted, so reads are refused. Run ` +
            `\`bashwink trust ${cwd}\` to allow them.`
          : policy.readPaths.length === 0
            ? `no reads are permitted here.`
            : `'${raw}' resolves to ${target}, which is outside this run's readable roots ` +
              `(${policy.readPaths.join(", ")}).`,
    }
  }

  if (PATCH_TOOLS.has(input.tool)) {
    const record = input.input as Record<string, unknown> | undefined
    const text = typeof record?.["patchText"] === "string" ? (record["patchText"] as string) : ""
    const targets = patchTargets(text)
    if (targets.length === 0) return invalidInput("the patch has no recognizable file targets")
    for (const raw of targets) {
      const target = toolPath(cwd, raw)
      if (!canWrite(policy, target))
        return {
          allow: false,
          rule: "write-scope",
          target,
          reason:
            `the patch modifies ${raw} (${target}), which is outside this task's allowed paths ` +
            `(${policy.allowedPaths.join(", ")}).`,
        }
    }
    return { allow: true }
  }

  if (SHELL_TOOLS.has(input.tool)) {
    if (!policy.allowShell)
      return {
        allow: false,
        rule: "shell-disabled",
        reason:
          policy.origin === "trust"
            ? `this workspace is not trusted, so shell commands are refused. Run ` +
              `\`bashwink trust ${cwd}\` to allow them.`
            : "shell is disabled by this task’s execution policy; permitted file tools remain available.",
      }
    const record = input.input as Record<string, unknown> | undefined
    const command = typeof record?.["command"] === "string" ? (record["command"] as string) : ""
    if (command.trim() === "") return invalidInput("a shell command is required")
    const workdir = record?.["workdir"] ?? cwd
    if (typeof workdir !== "string" || workdir === "")
      return invalidInput("invalid shell working directory")

    // A `workdir` outside the fence is a direct escape.
    const resolvedWorkdir = toolPath(cwd, workdir)
    if (!policy.readPaths.some((root) => contains(root, resolvedWorkdir)))
      return {
        allow: false,
        rule: "shell-scope",
        target: resolvedWorkdir,
        reason: `the command's working directory ${resolvedWorkdir} is outside this run's readable roots.`,
      }

    // Checked against the readable roots, not the writable ones: a command may reasonably read
    // or execute anything in the repository. Whether it *writes* through an interpreter cannot
    // be decided from the string, which is why an allowed shell call is marked unconstrained
    // rather than being described as safe.
    for (const token of shellPathTokens(command)) {
      const target = toolPath(resolvedWorkdir, token)
      if (!policy.readPaths.some((root) => contains(root, target)))
        return {
          allow: false,
          rule: "shell-scope",
          target,
          reason:
            `the command references ${token} (${target}), which is outside this run's readable ` +
            `roots (${policy.readPaths.join(", ")}).`,
        }
    }

    // Allowed, but the caller must record that a shell command is not a bounded operation.
    return {
      allow: true,
      unconstrained: true,
      note: "shell commands are not path-bounded; only their obvious path arguments were checked",
    }
  }

  if (policy.readPaths.length > 0 && SESSION_TOOLS.has(input.tool)) return { allow: true }
  return {
    allow: false,
    rule: "unsupported-tool",
    reason: `tool '${input.tool}' has no execution policy`,
  }
}
