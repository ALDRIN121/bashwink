import { physicalPath, type ScopePolicy } from "@bashwink/evidence"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readPlan } from "./commands.js"
import type { Paths } from "./paths.js"
import { Store } from "./store.js"
import { isTrusted, readTrust } from "./trust.js"

const CLIENT_COMMANDS = new Set(["run", "models", "stats", "session"])

const CONTROL_COMMANDS = new Set([
  "acp",
  "api",
  "mcp",
  "mini",
  "pair",
  "plugin",
  "reload",
  "serve",
  "service",
])

function firstPosition(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--") {
      const directory = argv[index + 1]
      return directory === undefined ? undefined : path.resolve(directory)
    }
    if (arg === "--model" || arg === "-m") {
      const model = argv[index + 1]
      if (model === undefined || model === "" || model.startsWith("-"))
        throw new Error(`missing value for ${arg}`)
      index++
      continue
    }
    if (arg === "--session" || arg === "-s" || arg === "--prompt") {
      index++
      continue
    }
    if (!arg.startsWith("-")) return arg
  }
  return undefined
}

/** True for the commands that talk to the private server without taking over the terminal (`run`, `models`, ...). */
export function isClientCommand(argv: readonly string[]): boolean {
  return CLIENT_COMMANDS.has(firstPosition(argv) ?? "")
}

export function standaloneArguments(argv: readonly string[]): string[] {
  const delimiter = argv.indexOf("--")
  const flags = argv.slice(0, delimiter < 0 ? argv.length : delimiter)
  if (flags.some((token) => /^--(?:no-standalone|server)(?:=|$)|^--standalone=/.test(token)))
    throw new Error("Bashwink requires its own standalone OpenCode server")
  if (flags.some((token) => /^(?:--worktree(?:=|$)|-w)/.test(token)))
    throw new Error("start Bashwink from the authorized worktree instead of using --worktree")
  const command = firstPosition(argv)
  if (command !== undefined && CONTROL_COMMANDS.has(command))
    throw new Error(`Bashwink does not authorize the OpenCode '${command}' service command`)
  if (
    command !== undefined &&
    !CLIENT_COMMANDS.has(command) &&
    path.resolve(command) !== process.cwd()
  )
    throw new Error(
      "start Bashwink from the intended workspace instead of passing another directory",
    )
  return flags.includes("--standalone") ? [...argv] : ["--standalone", ...argv]
}

export function admitInteractiveConfig(
  argv: readonly string[],
  workspace: string,
  trusted: boolean,
) {
  if (trusted || CLIENT_COMMANDS.has(firstPosition(argv) ?? "")) return
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    for (const file of [
      ".opencode/plugins",
      ".opencode/tui.json",
      ".opencode/tui.jsonc",
      "tui.json",
      "tui.jsonc",
    ]) {
      try {
        lstatSync(path.join(directory, file))
        throw new Error("trust this workspace before opening project TUI plugins or configuration")
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error
      }
    }
    if (path.dirname(directory) === directory) break
  }
}

export function prepareLaunchPolicy(resolved: Paths, runId: string) {
  const workspace = physicalPath(process.cwd())
  const trusted = isTrusted(readTrust(path.join(resolved.config, "trust.json")), workspace)
  // Absence is a normal no-plan run. An existing unreadable or malformed plan must not
  // be interpreted as no contract because that would widen the tool policy.
  const plan = readPlan()
  if (plan.plan === undefined) {
    try {
      readFileSync(path.join(resolved.data, "current-plan.json"), "utf8")
      throw new Error(plan.error)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const contract = (() => {
    if (plan.plan === undefined) return undefined
    const store = new Store({ file: resolved.database })
    try {
      return store.contractForPlan(plan.plan.id)
    } finally {
      store.close()
    }
  })()

  const mayWrite = trusted && (contract === undefined || contract.approval === "approved")
  const hasCommandConstraints =
    (contract?.constraints.forbiddenCommands?.length ?? 0) > 0 ||
    (contract?.constraints.allowedCommands?.length ?? 0) > 0
  const roots = (items: readonly string[]) =>
    items.map((item) => physicalPath(path.resolve(workspace, item)))
  const allowedPaths = mayWrite ? roots(contract?.allowedPaths ?? [workspace]) : []
  const restrictsWorkspace =
    contract !== undefined &&
    (!allowedPaths.includes(workspace) ||
      contract.forbiddenPaths.length > 0 ||
      contract.constraints.maxFiles !== undefined)
  const policy: ScopePolicy = {
    mode: "enforce",
    workspace,
    readPaths: [workspace],
    allowedPaths,
    forbiddenPaths: roots([
      resolved.config,
      resolved.data,
      resolved.cache,
      resolved.state,
      ...(contract?.forbiddenPaths ?? []),
    ]),
    // The general shell cannot enforce a narrower file scope or command list.
    allowShell: mayWrite && !restrictsWorkspace && !hasCommandConstraints,
    ...(!trusted
      ? { origin: "trust" as const }
      : contract === undefined
        ? {}
        : { origin: "contract" as const }),
  }
  const directory = path.join(resolved.data, "scopes")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${runId}.json`)
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  return { file, policy, trusted, workspace }
}

/** Defense in depth while the custom scope hook is unavailable. Only add native denials. */
export function launchEnvironment(
  environment: Record<string, string>,
  launch: ReturnType<typeof prepareLaunchPolicy>,
): Record<string, string> {
  delete environment["OPENCODE_PTY_HANDOFF"]
  delete environment["BASHWINK_READINESS"]
  environment["BASHWINK_SCOPE_FILE"] = launch.file
  if (!launch.trusted) environment["OPENCODE_CONFIG_PROJECT_DISABLE"] = "1"

  const content = (JSON.parse(environment["OPENCODE_CONFIG_CONTENT"] ?? "{}") ?? {}) as Record<
    string,
    unknown
  >
  if (typeof content !== "object" || Array.isArray(content))
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object")
  const userRules = content["permissions"] ?? []
  if (!Array.isArray(userRules)) throw new Error("OpenCode permissions must be an array")
  const denied = ["external_directory"]
  if (!launch.policy.allowShell) denied.push("shell")
  if (launch.policy.allowedPaths.length === 0) denied.push("edit")
  if (!launch.trusted) denied.push("webfetch", "websearch", "subagent", "automation")
  environment["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({
    ...content,
    permissions: [
      ...userRules,
      ...denied.map((action) => ({ action, resource: "*", effect: "deny" })),
    ],
  })
  return environment
}
