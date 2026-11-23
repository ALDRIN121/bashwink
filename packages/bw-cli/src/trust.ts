/**
 * Workspace trust and the default-deny approval policy (BW-010).
 *
 * The threat model is simple and worth stating plainly: an agent reads untrusted input — a
 * README, an issue body, a dependency's postinstall output — and that input can ask it to run
 * a shell command or write a file. If trust is implicit, the agent obeys. So:
 *
 *   - An **unknown workspace is untrusted**, and trust must be granted by a human, per
 *     absolute path, and is recorded persistently.
 *   - Untrusted workspaces get a policy that denies shell execution and writes by default.
 *     Not "asks the model nicely" — `evaluateCall()` returns a deny the caller must honour.
 *   - Trust is bound to the resolved real path, so `../trusted-repo` symlinks do not inherit
 *     another workspace's grant.
 *
 * Deliberately dependency-free and pure so the rules are exhaustively testable, and so the
 * policy can be evaluated in a plugin hook without I/O.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"

/** What a call wants to do. Kept coarse on purpose — a fine taxonomy invites gaps. */
export type Action = "read" | "write" | "shell" | "network"

export type Decision = "allow" | "deny" | "ask"

export interface TrustRecord {
  /** Real (symlink-resolved) absolute path. */
  readonly directory: string
  readonly trustedAt: string
  /** Who granted it — a person, or `non-interactive:approved-flag`. */
  readonly grantedBy: string
}

export interface TrustFile {
  readonly v: 1
  readonly workspaces: readonly TrustRecord[]
}

export const TRUST_FILE_VERSION = 1

/**
 * Default policy for an untrusted workspace.
 *
 * Reads are allowed because exploring a repository is how an agent forms a plan, and reading
 * is what the QA fixtures rely on. Writes, shell and network are denied. This is the
 * "defaults cannot silently grant dangerous shell/write actions" requirement, expressed as
 * data so it can be asserted rather than described.
 */
export const UNTRUSTED_POLICY: Readonly<Record<Action, Decision>> = {
  read: "allow",
  write: "deny",
  shell: "deny",
  network: "deny",
}

/** Policy for a workspace a human has explicitly trusted. */
export const TRUSTED_POLICY: Readonly<Record<Action, Decision>> = {
  read: "allow",
  write: "allow",
  shell: "ask",
  network: "ask",
}

/**
 * Resolve a workspace to a canonical path.
 *
 * `realpathSync` collapses `..` and symlinks, which is the only way trust can be keyed
 * safely. When the directory does not exist yet the *parent* is resolved instead, so a
 * pre-created workspace cannot smuggle a symlinked ancestor past the check.
 */
export function canonicalWorkspace(directory: string): string {
  const absolute = path.resolve(directory)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

export function emptyTrustFile(): TrustFile {
  return { v: TRUST_FILE_VERSION, workspaces: [] }
}

export function parseTrustFile(raw: string): TrustFile {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("trust file must be a JSON object")
  const value = parsed as Record<string, unknown>
  if (value.v !== TRUST_FILE_VERSION)
    throw new Error(
      `unsupported trust file version ${String(value.v)}; expected ${TRUST_FILE_VERSION}`,
    )
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
  return {
    v: TRUST_FILE_VERSION,
    workspaces: workspaces.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const record = entry as Record<string, unknown>
      if (typeof record.directory !== "string" || typeof record.trustedAt !== "string") return []
      return [
        {
          directory: record.directory,
          trustedAt: record.trustedAt,
          grantedBy: typeof record.grantedBy === "string" ? record.grantedBy : "unknown",
        },
      ]
    }),
  }
}

/** Read the trust file, tolerating absence but not corruption. */
export function readTrust(file: string): TrustFile {
  if (!existsSync(file)) return emptyTrustFile()
  return parseTrustFile(readFileSync(file, "utf8"))
}

export function writeTrust(file: string, trust: TrustFile): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(trust, null, 2)}\n`, "utf8")
}

export function grantTrust(
  trust: TrustFile,
  directory: string,
  grantedBy: string,
  at: string,
): TrustFile {
  const canonical = canonicalWorkspace(directory)
  const without = trust.workspaces.filter((record) => record.directory !== canonical)
  return {
    v: TRUST_FILE_VERSION,
    workspaces: [...without, { directory: canonical, trustedAt: at, grantedBy }],
  }
}

export function revokeTrust(trust: TrustFile, directory: string): TrustFile {
  const canonical = canonicalWorkspace(directory)
  return {
    v: TRUST_FILE_VERSION,
    workspaces: trust.workspaces.filter((record) => record.directory !== canonical),
  }
}

export function isTrusted(trust: TrustFile, directory: string): boolean {
  const canonical = canonicalWorkspace(directory)
  return trust.workspaces.some((record) => record.directory === canonical)
}

/**
 * The policy for a workspace.
 *
 * Untrusted is the default and the only way to get `allow` on write/shell is a persisted,
 * human-granted record.
 */
export function policyFor(trust: TrustFile, directory: string): Readonly<Record<Action, Decision>> {
  return isTrusted(trust, directory) ? TRUSTED_POLICY : UNTRUSTED_POLICY
}

export interface CallContext {
  readonly trust: TrustFile
  readonly directory: string
  readonly action: Action
  /**
   * An explicit non-interactive approval (e.g. `--approve` on the command line). Absent by
   * default: nothing in the codebase infers consent.
   */
  readonly approved?: boolean
}

export interface Evaluation {
  readonly decision: Decision
  /** Always populated, and always safe to print — this ends up in an evidence log. */
  readonly reason: string
}

/**
 * Decide one call.
 *
 * Order matters: an explicit approval overrides a policy `ask` (because a human already
 * answered), but it never overrides a hard `deny` — otherwise `--approve` becomes a bypass
 * for the very default the policy exists to enforce.
 */
export function evaluateCall(context: CallContext): Evaluation {
  const policy = policyFor(context.trust, context.directory)
  const decision = policy[context.action]
  const trusted = isTrusted(context.trust, context.directory)
  const workspace = canonicalWorkspace(context.directory)

  if (decision === "deny")
    return {
      decision: "deny",
      reason: `workspace ${workspace} is not trusted; '${context.action}' is denied by the default policy. Run \`bashwink trust ${workspace}\` to allow it.`,
    }
  if (decision === "ask" && context.approved === true)
    return {
      decision: "allow",
      reason: `'${context.action}' in ${workspace} was explicitly approved for this invocation`,
    }
  if (decision === "ask")
    return {
      decision: "ask",
      reason: `'${context.action}' in ${trusted ? "trusted" : "untrusted"} workspace ${workspace} requires explicit approval`,
    }
  return { decision: "allow", reason: `'${context.action}' in ${workspace} is allowed by policy` }
}
