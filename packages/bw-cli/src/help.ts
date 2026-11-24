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

/**
 * Read the version, from the closest build manifest that exists.
 *
 * Two layouts: the source checkout (a sibling `package.json`) and a built bundle (a
 * `version.json` written by `scripts/build_alpha.sh`, because a single-file bundle has no
 * package manifest beside it). Neither is a hardcoded constant, so a release bump cannot
 * leave `--version` behind.
 */
function readVersion(): string {
  const manifest = path.join(here, "..", "package.json")
  const stamped = path.join(here, "version.json")
  for (const file of [stamped, manifest]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string }
      if (parsed.version !== undefined) return parsed.version
    } catch {
      continue
    }
  }
  return "0.0.0-unknown"
}

export const VERSION = readVersion()

/** Set by CI to tie a binary to a commit without mutating package.json. */
export const BUILD = process.env["BASHWINK_BUILD"] ?? "local"

export function versionLine(): string {
  return `bashwink ${VERSION} (opencode ${PINNED_RUNTIME_VERSION}, build ${BUILD})`
}

const HELP = `bashwink — an evidence-first coding agent

USAGE
  bashwink [opencode arguments]        run the agent using a private local OpenCode server
  bashwink <command> [options]

COMMANDS
  backend                   print the selected execution backend capabilities
  sandbox probe             run disposable native OS controls without starting an agent
  sandbox offline <port>    open a disposable macOS TUI with the local mock
  sandbox offline <port> --stage-file
                            stage this directory's task.txt with shell disabled
  sandbox offline <port> --stage <path> (--continue | --session <id>)
                            reopen a saved file-only offline stage
  sandbox export <path>     preview staged task.txt and ask before applying
  doctor                    check preconditions and report what is missing
  init                      create Bashwink's config and data directories
  trust <dir>               trust a workspace so shell/write actions are permitted there
  trust --list              show trusted workspaces
  trust --revoke <dir>      remove a workspace's trust
  plan new <objective>      create a plan with a task graph
  plan show [--json]        render the current plan
  plan approve --by <name>  approve the current plan (required before edits)
  plan task <id> <status>   transition a task through the state machine
  auth status               providers, their credential route and whether it resolves
  auth add <id> ...         add an OpenAI/Anthropic-compatible provider (no key stored)
  auth check <id>           can this provider authenticate right now? (exit 1 if not)
  auth remove <id>          remove a provider and any default model pointing at it
  model list                models the config declares, with the default marked
  model use <provider>/<m>  set the default model for every run
  model current             print the default model
  evidence export [--json]  export what actually ran, including checks that did not run
  evidence status [--json]  per-run record: did the evidence plugin initialise?
  contract new              create the task contract from the current plan
  contract show [--json]    what was agreed before work started
  contract approve --by X   approve the contract (required before work starts)
  contract revise --file F  amend the contract as a new, numbered revision
  contract status [--json]  acceptance criteria and the evidence behind each
  resume [--status]         reconcile a killed run and resume its tasks

VERSION AND PATHS
  --version, -v             print the Bashwink version and the pinned runtime
  --help, -h                print this help

  Config:  ${pathsHelp("config")}
  Data:    ${pathsHelp("data")}
  Override everything at once with BASHWINK_HOME=/some/dir
  BASHWINK_BACKEND=local    select direct host execution (current default, unrestricted host access)
  BASHWINK_BACKEND=native   require native coding isolation (currently refuses admission)
  BASHWINK_TIMEOUT_MS      optional positive runtime deadline in milliseconds

PROVIDERS AND MODELS
  Inference, streaming and tool calls are the pinned runtime's job; Bashwink configures it.
  A provider is declared once in the config the runtime reads, and the key is never stored:

    bashwink auth add commandcode --name CommandCode \
      --base-url https://api.commandcode.ai/provider/v1 \
      --env COMMANDCODE_API_KEY \
      --model claude-sonnet-5:anthropic:200000:8192 \
      --model gpt-6.1-sol:openai:200000:8192
    bashwink model use commandcode/claude-sonnet-5
    bashwink run --auto "fix the failing test"

  Models of different wire protocols on one provider get a per-model package; the protocol
  suffix above (":anthropic", ":openai") is how you declare that. Getting it wrong produces
  an endpoint-shape error on the first request, not at startup, which is why it is explicit.

  --model overrides the default for one run; --session continues a session, including
  across a model switch. No key is ever written by Bashwink: --env names the variable the
  runtime reads and --key-file names a 0600 file it substitutes at run time.

ENVIRONMENT
  BASHWINK_HOME             relocate all config/data/cache/state under one directory
  BASHWINK_PLUGIN_DIR       stage this evidence plugin directory instead of resolving one
  BASHWINK_OPENCODE_BIN     use this OpenCode binary instead of resolving one
  BASHWINK_EVIDENCE_DIR     where the tool-event log is written
  The policy and evidence plugin must be ready before OpenCode can receive prompts.
  BASHWINK_DEBUG=1          print what the wrapper staged before running

  Bashwink sets OPENCODE_CONFIG_DIR and XDG_* for the child runtime, so a real OpenCode
  install on the same machine is never modified.

EXIT CODES
  0   success
  1   a check failed (doctor) or a command was refused
  2   usage error
  3   policy readiness failed or evidence is missing
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
