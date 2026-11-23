/**
 * Version and help text.
 *
 * The version is read from `package.json` at runtime rather than duplicated in source, so a
 * release bump cannot leave `bashwink --version` behind. `BASHWINK_BUILD` lets CI stamp a
 * commit without rewriting a tracked file.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PINNED_RUNTIME_VERSION } from "./runtime.js"

const here = path.dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
      version?: string
    }
    return manifest.version ?? "0.0.0-unknown"
  } catch {
    return "0.0.0-unknown"
  }
}

export const VERSION = readVersion()

/** Set by CI to tie a binary to a commit without mutating package.json. */
export const BUILD = process.env["BASHWINK_BUILD"] ?? "local"

export function versionLine(): string {
  return `bashwink ${VERSION} (opencode ${PINNED_RUNTIME_VERSION}, build ${BUILD})`
}

const HELP = `bashwink — an evidence-first coding agent

USAGE
  bashwink [opencode arguments]        run the agent (arguments are forwarded unchanged)
  bashwink <command> [options]

COMMANDS
  doctor                    check preconditions and report what is missing
  init                      create Bashwink's config and data directories
  trust <dir>               trust a workspace so shell/write actions are permitted there
  trust --list              show trusted workspaces
  trust --revoke <dir>      remove a workspace's trust
  plan new <objective>      create a plan with a task graph
  plan show [--json]        render the current plan
  plan approve --by <name>  approve the current plan (required before edits)
  plan task <id> <status>   transition a task through the state machine
  evidence export [--json]  export what actually ran, including checks that did not run
  resume [--status]         reconcile a killed run and resume its tasks

VERSION AND PATHS
  --version, -v             print the Bashwink version and the pinned runtime
  --help, -h                print this help

  Config:  ${pathsHelp("config")}
  Data:    ${pathsHelp("data")}
  Override everything at once with BASHWINK_HOME=/some/dir

ENVIRONMENT
  BASHWINK_HOME             relocate all config/data/cache/state under one directory
  BASHWINK_OPENCODE_BIN     use this OpenCode binary instead of resolving one
  BASHWINK_EVIDENCE_DIR     where the tool-event log is written

  Bashwink sets OPENCODE_CONFIG_DIR and XDG_* for the child runtime, so a real OpenCode
  install on the same machine is never modified.

EXIT CODES
  0   success
  1   a check failed (doctor) or a command was refused
  2   usage error
  127 the pinned OpenCode runtime could not be found
`

/** Resolved lazily so `--help` never fails because a path could not be computed. */
function pathsHelp(kind: "config" | "data"): string {
  try {
    // Imported here to avoid a cycle: paths.ts does not import help.ts, but keep it lazy.
    const { paths } = require("./paths.js") as typeof import("./paths.js")
    return paths()[kind]
  } catch {
    return "~/.config/bashwink"
  }
}

export function renderHelp(): string {
  return HELP
}
