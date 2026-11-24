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
import { RELEASE_BUILD, STANDARD_BUILD } from "./release.js"

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
  sandbox offline <port> --stage-file
                            stage this directory's task.txt with shell disabled
  sandbox offline <port> --stage <path> (--continue | --session <id>)
                            reopen a saved file-only offline stage
  sandbox export <path>     preview staged task.txt and ask before applying
  sandbox recover-export <path>
                            reconcile an approved interrupted export from its original directory
  sandbox recover <path>    retire a closed, attested native activation
  sandbox vm-review [files...]
                            preview and apply selected changes from a stopped VM project
  sandbox vm-recover        finish an interrupted, approved VM project apply
  sandbox vm-verify         run protected tests against a fresh copy of the host project
  sandbox stages [--purge]  list (or remove) the VM stage directories this installation recorded
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

const RELEASE_HELP = `bashwink — an evidence-first coding agent (alpha, macOS Apple Silicon)

USAGE
  bashwink                  start a coding session in an isolated VM on a copy of the
                            Git project in the current directory
  bashwink --continue       resume this project's most recent saved session
  bashwink --session <id>   resume a specific saved session
  bashwink --unsafe-local   run on this Mac with your access (asks you to acknowledge the risks)
  bashwink <command> [options]

Plain \`bashwink\` never runs the agent on the host. If the VM cannot start it says why and
stops before any model request.

COMMANDS
  doctor                    check the host, the VM image and the provider
  auth add <id> ...         declare a provider (the key stays in a private file or variable)
  auth status | check <id> | remove <id>
  model list | use <provider>/<model> | current
  sandbox vm-review [files...]
                            review the agent's changes as a diff; type apply to write them
  sandbox vm-recover        finish an interrupted apply
  sandbox vm-verify         run the protected tests against your project in a fresh VM
  sandbox stages [--purge]  list (or remove) the VM stage directories this installation recorded
  trust <dir> --by <name> | trust --list | trust --revoke <dir>
  plan ... | contract ... | evidence ... | resume    task plan and evidence tools
  --version, -v | --help, -h

PROVIDER SETUP
  bashwink auth add commandcode --base-url https://api.commandcode.ai/provider/v1 \\
    --key-file ~/.config/bashwink-commandcode.key \\
    --model claude-sonnet-5:anthropic --model gpt-6.1-sol:openai
  bashwink model use commandcode/claude-sonnet-5

LIMITS
  Staged: tracked top-level .ts, .js and .txt files of a Git checkout root (at most 64,
  256 KiB each). The VM has no network. Sessions last about 30 minutes. Model requests per
  session: 8 by default, BASHWINK_VM_MAX_REQUESTS=<1-40> to change.

ENVIRONMENT
  BASHWINK_HOME             relocate all configuration and data under one directory
  BASHWINK_VM_MAX_REQUESTS  model requests allowed per session (1 to 40, default 8)

EXIT CODES
  0 success   1 a check failed or a command was refused   2 usage error
  3 the session could not start (see the message and startup-failures.jsonl)

See share/doc/ALPHA_TESTER_GUIDE.md and KNOWN_LIMITATIONS.md in the install directory.
`

/**
 * The help of the standard (native) package: the general help without what that package does not have.
 * Derived from HELP so the two cannot drift: the optional sandbox subcommands and the environment switch
 * for the execution backend are removed (the standard package refuses both), and the mode is stated first.
 */
function standardHelp(): string {
  const kept: string[] = []
  let skipping = false
  for (const line of HELP.split("\n")) {
    if (line.startsWith("  sandbox ")) {
      skipping = true
      continue
    }
    if (skipping && line.startsWith(" ".repeat(28))) continue
    skipping = false
    if (line.startsWith("  BASHWINK_BACKEND=")) continue
    kept.push(line)
  }
  const mode = [
    "MODE",
    "  STANDARD: native and permission-controlled. Bashwink runs on this computer with your user's access.",
    "  It asks before shell commands, edits outside the agreed scope and network use. It is NOT an",
    "  operating-system sandbox: an approved command can do anything you can. The optional isolated",
    "  sandbox (`--sandbox`) is not part of this package; asking for it fails closed and starts nothing.",
    "",
  ]
  const text = kept.join("\n")
  const at = text.indexOf("USAGE")
  return `${text.slice(0, at)}${mode.join("\n")}\n${text.slice(at)}`
}

export function renderHelp(): string {
  if (STANDARD_BUILD) return standardHelp()
  return RELEASE_BUILD ? RELEASE_HELP : HELP
}
