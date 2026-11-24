/**
 * Release-build policy (v0.1.0-alpha.1).
 *
 * A release bundle is compiled with `--define __BASHWINK_RELEASE__=true`. That constant is
 * fixed at build time: no environment variable, flag or file can turn a development bundle
 * into a release bundle or the reverse.
 *
 * Release rules, enforced here and in `main.ts` rather than described in prose:
 *
 *   1. The default execution mode is the isolated VM. Nothing falls back to the host.
 *   2. Any failure to bring the VM up stops the launch before a model request or a tool call,
 *      prints a cause and a way out, and is recorded.
 *   3. Host execution exists only as the separate `--unsafe-local` mode, and only after a
 *      typed acknowledgment on an interactive terminal. `BASHWINK_BACKEND` cannot select it.
 *   4. The host must be a macOS build this release names as qualified.
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"

declare const __BASHWINK_RELEASE__: boolean | undefined
declare const __BASHWINK_ASSET_MANIFEST_SHA256__: string | undefined
declare const __BASHWINK_QUALIFIED_HOSTS__: string | undefined
declare const __BASHWINK_GUEST__: boolean | undefined
declare const __BASHWINK_STANDARD__: boolean | undefined

/** True only in a bundle built by the release script. */
export const RELEASE_BUILD: boolean =
  typeof __BASHWINK_RELEASE__ !== "undefined" && __BASHWINK_RELEASE__ === true

/**
 * True only in the npm "standard" bundle: native, permission-controlled execution is the default, the VM
 * backend is not installed, and no environment variable can select a different backend or provider path.
 */
export const STANDARD_BUILD: boolean =
  typeof __BASHWINK_STANDARD__ !== "undefined" && __BASHWINK_STANDARD__ === true

/**
 * True only in the bundle that runs inside the VM guest. The guest's own boundary is the VM,
 * so its terminal banner says so instead of calling the guest a host.
 */
export const GUEST_BUILD: boolean =
  typeof __BASHWINK_GUEST__ !== "undefined" && __BASHWINK_GUEST__ === true

/** SHA-256 of `offline-vm.json` that this exact bundle was built against. */
export function expectedAssetManifestDigest(): string | undefined {
  return typeof __BASHWINK_ASSET_MANIFEST_SHA256__ === "string"
    ? __BASHWINK_ASSET_MANIFEST_SHA256__
    : undefined
}

export type ExecutionMode =
  "isolated-vm" | "standard-native" | "unrestricted-host" | "development-host"

export const UNRESTRICTED_FLAG = "--unsafe-local"

export interface ModeDescription {
  readonly mode: ExecutionMode
  /** One line, printed before the terminal UI starts. */
  readonly banner: string
  /** The same sentence without its "Execution mode:" label, for a labelled list. */
  readonly text: string
  /** Short form for a terminal title or a status line. */
  readonly short: string
}

export function describeMode(mode: ExecutionMode, detail?: string): ModeDescription {
  const make = (short: string, text: string): ModeDescription => ({
    mode,
    short,
    text,
    banner: `Execution mode: ${text}`,
  })
  switch (mode) {
    case "isolated-vm":
      return make(
        "ISOLATED VM",
        "ISOLATED VM — the agent works on a copy of this project inside a network-less virtual " +
          "machine" +
          (detail === undefined ? "." : ` (${detail}).`),
      )
    case "standard-native":
      return make(
        "STANDARD",
        "STANDARD — native, permission-controlled. Commands you approve run on this computer as you; this is " +
          "NOT an operating-system sandbox. Risky actions ask first and denials are enforced.",
      )
    case "unrestricted-host":
      return make(
        "UNRESTRICTED HOST",
        "UNRESTRICTED HOST ACCESS — NOT ISOLATED. Approved commands run as you, with your " +
          "files, network and credentials.",
      )
    case "development-host":
      return make(
        "DEVELOPMENT HOST",
        "DEVELOPMENT HOST (source build) — NOT ISOLATED. Approved commands run as you, with " +
          "your files, network and credentials.",
      )
  }
}

/** The text the user must read before host execution is available. */
export const UNRESTRICTED_WARNING = [
  "UNRESTRICTED MODE gives the agent the same access you have on this Mac.",
  "",
  "  - Commands you approve run directly on this machine, not in a virtual machine.",
  "  - They can read and change any file you can, including outside this project.",
  "  - They can use the network and read credentials in your environment and home directory.",
  "  - Detached background processes are not guaranteed to be stopped when Bashwink exits.",
  "  - Project content, prompts and tool output are sent to your configured model provider.",
  "",
  "Existing approvals and hard denials still apply: shell and network calls ask first,",
  "and writes outside the approved scope are refused. They are guard rails, not a sandbox.",
  "A prompt-injected instruction that you approve will run with your full access.",
  "",
  "Use this mode only in a project and on a machine you trust.",
].join("\n")

export const UNRESTRICTED_PHRASE = "I accept host access"

export class AcknowledgmentError extends Error {
  readonly code = "acknowledgment_required"
  constructor(message: string) {
    super(message)
    this.name = "AcknowledgmentError"
  }
}

export interface AcknowledgmentIO {
  readonly interactive: boolean
  write(text: string): void
  /** Reads one line, or `null` at end of input. */
  readLine(prompt: string): string | null
}

/**
 * Obtain the typed acknowledgment. There is no flag, variable or saved answer that skips it:
 * the user types the phrase on a terminal each time host execution is requested.
 */
export function acknowledgeUnrestricted(io: AcknowledgmentIO): void {
  if (!io.interactive)
    throw new AcknowledgmentError(
      `${UNRESTRICTED_FLAG} needs a typed acknowledgment of host-access risks, which requires an ` +
        "interactive terminal. Nothing was started. Run it from a terminal, or use plain " +
        "`bashwink` for the isolated VM.",
    )
  io.write(`${UNRESTRICTED_WARNING}\n\n`)
  const answer = io.readLine(`To continue, type exactly "${UNRESTRICTED_PHRASE}": `)
  if (answer === null || answer.trim() !== UNRESTRICTED_PHRASE)
    throw new AcknowledgmentError(
      "host-access acknowledgment was not given. Nothing was started. Plain `bashwink` uses the isolated VM.",
    )
}

// ---------------------------------------------------------------------------------------
// Host qualification
// ---------------------------------------------------------------------------------------

export interface HostFacts {
  readonly platform: string
  readonly arch: string
  /** `sw_vers -productVersion`, e.g. `27.0.1`. */
  readonly osVersion: string | undefined
  /** `sysctl kern.osversion`, e.g. `26A434`. */
  readonly osBuild: string | undefined
}

export interface QualifiedHost {
  readonly version: string
  readonly build: string
}

export interface HostVerdict {
  readonly supported: boolean
  /** Safe to print. */
  readonly reason: string
}

export function parseQualifiedHosts(raw: string | undefined): QualifiedHost[] {
  if (raw === undefined) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error("qualified host list must be an array")
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>
    if (typeof record["version"] !== "string" || typeof record["build"] !== "string")
      throw new Error("qualified host entries need a version and a build")
    return { version: record["version"], build: record["build"] }
  })
}

export function builtInQualifiedHosts(): QualifiedHost[] {
  return parseQualifiedHosts(
    typeof __BASHWINK_QUALIFIED_HOSTS__ === "string" ? __BASHWINK_QUALIFIED_HOSTS__ : undefined,
  )
}

export function judgeHost(facts: HostFacts, qualified: readonly QualifiedHost[]): HostVerdict {
  if (facts.platform !== "darwin" || facts.arch !== "arm64")
    return {
      supported: false,
      reason:
        `this VM release supports macOS on Apple Silicon only (found ${facts.platform}/${facts.arch}). ` +
        "Linux, Windows and Intel Macs are unsupported; the isolated VM cannot start here.",
    }
  if (facts.osVersion === undefined || facts.osBuild === undefined)
    return {
      supported: false,
      reason: "could not read the macOS version and build, so qualification cannot be checked",
    }
  if (!qualified.some((host) => host.version === facts.osVersion && host.build === facts.osBuild))
    return {
      supported: false,
      reason:
        `macOS ${facts.osVersion} (${facts.osBuild}) is not a qualified host for this release. ` +
        (qualified.length === 0
          ? "This build names no qualified macOS builds."
          : `Qualified: ${qualified.map((host) => `${host.version} (${host.build})`).join(", ")}.`),
    }
  return { supported: true, reason: `macOS ${facts.osVersion} (${facts.osBuild}) arm64` }
}

export function readHostFacts(): HostFacts {
  const read = (command: string, args: string[]) => {
    try {
      const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "ignore" })
      const text = result.exitCode === 0 ? result.stdout.toString().trim() : ""
      return text === "" ? undefined : text
    } catch {
      return undefined
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: read("/usr/bin/sw_vers", ["-productVersion"]),
    osBuild: read("/usr/sbin/sysctl", ["-n", "kern.osversion"]),
  }
}

// ---------------------------------------------------------------------------------------
// Startup failure record
// ---------------------------------------------------------------------------------------

export type StartupFailureCode =
  | "unsupported-host"
  | "vm-assets-missing"
  | "vm-assets-corrupt"
  | "vm-init-failed"
  | "provider-unavailable"
  | "workspace-not-approved"
  | "no-terminal"
  | "unsupported-invocation"
  | "sandbox-unavailable"
  | "acknowledgment-required"

/** Thrown for any failure that must stop a launch before a model request or a tool call. */
export class StartupError extends Error {
  constructor(
    readonly code: StartupFailureCode,
    message: string,
  ) {
    super(message)
    this.name = "StartupError"
  }
}

export interface StartupFailure {
  readonly code: StartupFailureCode
  readonly mode: ExecutionMode
  readonly message: string
}

export const STARTUP_FAILURE_LOG = "startup-failures.jsonl"

/**
 * Append a failure record. The message is operator text without credentials or prompt
 * content. Recording must never be the reason a launch error goes unreported, so a write
 * failure returns `false` instead of throwing.
 */
export function recordStartupFailure(
  dataDirectory: string,
  failure: StartupFailure,
  now: () => Date = () => new Date(),
): boolean {
  try {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const file = path.join(dataDirectory, STARTUP_FAILURE_LOG)
    const fd = openSync(file, "a", 0o600)
    try {
      appendFileSync(
        fd,
        JSON.stringify({
          version: 1,
          at: now().toISOString(),
          code: failure.code,
          mode: failure.mode,
          message: failure.message.slice(0, 500),
        }) + "\n",
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}
