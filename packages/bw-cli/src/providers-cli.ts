/**
 * `bashwink auth` and `bashwink model` — provider and model surface (BW-091).
 *
 * Both commands read and write the *same* config file the runtime reads, and neither
 * performs inference. That boundary is deliberate: a second inference path would need its
 * own retries, streaming and tool-call handling, and would drift from the pinned runtime
 * the evidence chain is built around (ADR-003).
 *
 * Exit codes follow `help.ts`: 0 ok, 1 refused/failed, 2 usage. A provider that exists but
 * cannot authenticate is a `1`, not a `0` with a warning, because a caller scripting
 * `bashwink auth status && bashwink run ...` must not proceed on a broken credential.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  PROTOCOL_PACKAGE,
  ProviderConfigError,
  type RawProvider,
  configFile,
  credentialRef,
  declaredProviders,
  defaultModel,
  credentialUsable,
  describeCredential,
  fingerprint,
  parseModelRef,
  providerCredential,
  readRuntimeConfig,
  toRuntimeProvider,
  validateProviderID,
  type Protocol,
  type ProviderSpec,
  type RuntimeConfig,
} from "./providers.js"
import { paths } from "./paths.js"
import type { CommandResult } from "./commands.js"

const usage = (message: string): CommandResult => ({ exitCode: 2, stdout: "", stderr: message })

function fail(message: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr: message }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  return args[at + 1]
}

/** Split repeated `--x a --x b` values. */
function flagValues(args: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1] !== undefined) out.push(args[index + 1] as string)
  return out
}

function writeConfig(configDirectory: string, config: RuntimeConfig): string {
  const file = configFile(configDirectory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return file
}

/** Parse a `--model id[:protocol][:context]` style declaration. */
function parseModelSpec(raw: string, fallback: Protocol): ProviderSpec["models"][number] {
  const [id, protocolText, contextText, outputText] = raw.split(":")
  if (id === undefined || id === "")
    throw new ProviderConfigError(`model declaration '${raw}' has no id`)
  const protocol = protocolText === undefined || protocolText === "" ? fallback : protocolText
  if (protocol !== "anthropic" && protocol !== "openai" && protocol !== "openai-responses")
    throw new ProviderConfigError(
      `model '${id}' declares protocol '${protocol}'; expected anthropic, openai or openai-responses`,
    )
  const context = contextText === undefined ? undefined : Number(contextText)
  const output = outputText === undefined ? undefined : Number(outputText)
  if (context !== undefined && !Number.isInteger(context))
    throw new ProviderConfigError(
      `model '${id}' declares a non-integer context limit '${contextText}'`,
    )
  if (output !== undefined && !Number.isInteger(output))
    throw new ProviderConfigError(
      `model '${id}' declares a non-integer output limit '${outputText}'`,
    )
  return {
    id,
    protocol,
    ...(context === undefined ? {} : { context }),
    ...(output === undefined ? {} : { output }),
  }
}

/**
 * `bashwink auth add <provider-id> --base-url URL --env VAR [--model id[:protocol]]...`
 *
 * Writes a provider declaration. Does **not** store a key: `--env` names the variable the
 * runtime reads, and `--key-file` names a file substituted at run time. A literal
 * `--key` is accepted only with an explicit acknowledgement, because a key in a config
 * file inside a user's project is one `git add -A` away from disclosure.
 */
export function runAuthCommand(args: readonly string[]): CommandResult {
  const resolved = paths()
  const sub = args[0]

  if (sub === "status" || sub === undefined) return authStatus(resolved.config)

  if (sub === "add") {
    const rest = args.slice(1)
    const id = rest[0]
    if (id === undefined)
      return usage(
        "usage: bashwink auth add <provider-id> --base-url <url> (--env <VAR> | --key-file <path>) [--model id[:protocol[:context[:output]]]]... [--anthropic|--openai]",
      )
    try {
      validateProviderID(id)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const baseURL = flagValue(rest, "--base-url")
    if (baseURL === undefined) return usage("missing --base-url")
    const env = flagValues(rest, "--env")
    const keyFile = flagValue(rest, "--key-file")
    // Checked before the "declare a route" requirement, so a user who passed `--key` is told
    // why it is refused rather than being asked for a different flag. Ordering mattered
    // here: with the route check first, this refusal was unreachable dead code.
    if (flagValue(rest, "--key") !== undefined)
      return fail(
        "refusing --key: a literal key in the config is one `git add -A` from disclosure. " +
          "Use --env <VAR> (the runtime reads the variable) or --key-file <path> " +
          "(the runtime substitutes {file:...} at run time, and the file stays outside the repo).",
      )
    if (env.length === 0 && keyFile === undefined)
      return usage("declare where the key lives with --env <VAR> or --key-file <path>")
    const defaultProtocol: Protocol = rest.includes("--anthropic") ? "anthropic" : "openai"
    let models: ProviderSpec["models"]
    try {
      models = flagValues(rest, "--model")
        .filter((value) => value !== "")
        .map((value) => parseModelSpec(value, defaultProtocol))
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    if (models.length === 0) return usage("declare at least one --model id[:protocol]")

    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    // Not `...(config.providers ?? {})`: a spread of `undefined` adds nothing anyway, and
    // the empty-object fallback reads as if it were doing something.
    const providers: Record<string, RawProvider> = { ...config.providers }
    if (providers[id] !== undefined)
      return fail(
        `provider '${id}' is already configured in ${configFile(resolved.config)}; ` +
          "edit that file directly, or choose another id",
      )
    const built = toRuntimeProvider({
      id,
      ...(flagValue(rest, "--name") === undefined
        ? {}
        : { name: flagValue(rest, "--name") as string }),
      baseURL,
      ...(env.length === 0 ? {} : { env }),
      models,
      ...(keyFile === undefined ? {} : {}),
    })
    providers[id] = {
      ...built,
      ...(keyFile === undefined
        ? {}
        : { settings: { ...built.settings, apiKey: `{file:${path.resolve(keyFile)}}` } }),
    }
    const file = writeConfig(resolved.config, { ...config, providers })
    return {
      exitCode: 0,
      stdout:
        `added provider '${id}' to ${file}\n` +
        `  base URL: ${baseURL}\n` +
        `  credential: ${env.length > 0 ? `$${env.join(" or $")}` : `{file:${path.resolve(keyFile as string)}}`}\n` +
        `  models: ${models.map((model) => `${model.id} [${model.protocol ?? defaultProtocol}]`).join(", ")}\n\n` +
        `set a default model with: bashwink model use ${id}/${models[0]?.id ?? "<model>"}`,
    }
  }

  if (sub === "remove") {
    const id = args[1]
    if (id === undefined) return usage("usage: bashwink auth remove <provider-id>")
    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    if (config.providers?.[id] === undefined) return fail(`provider '${id}' is not configured`)
    const providers = { ...config.providers }
    delete providers[id]
    const next: RuntimeConfig = { ...config, providers }
    // A default model pointing at the removed provider would make every run fail at start.
    const current = defaultModel(config)
    if (current !== undefined && current.startsWith(`${id}/`)) {
      const remaining = Object.keys(providers)[0]
      if (remaining === undefined) delete (next as { model?: unknown }).model
      else
        (next as { model?: unknown }).model = `${remaining}/${
          Object.keys(providers[remaining]?.models ?? {})[0] ?? ""
        }`
    }
    const file = writeConfig(resolved.config, next)
    return { exitCode: 0, stdout: `removed provider '${id}' from ${file}` }
  }

  if (sub === "check") {
    const id = args[1]
    if (id === undefined) return usage("usage: bashwink auth check <provider-id>")
    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const provider = config.providers?.[id]
    if (provider === undefined) return fail(`provider '${id}' is not configured`)
    const { state, source } = providerCredential(provider)
    const usable = credentialUsable(state)
    return {
      exitCode: usable ? 0 : 1,
      stdout: `${id}: ${describeCredential(state, source)}`,
      ...(usable
        ? {}
        : {
            stderr:
              `provider '${id}' cannot authenticate: ` +
              (state.kind === "env"
                ? `export ${state.variable}=... before running`
                : state.kind === "file"
                  ? `create the key file ${state.file}`
                  : "declare --env or --key-file"),
          }),
    }
  }

  return usage(`unknown auth subcommand '${sub}'; expected status, add, remove, check`)
}

function authStatus(configDirectory: string): CommandResult {
  let config: RuntimeConfig
  try {
    config = readRuntimeConfig(configDirectory)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  const providers = Object.entries(config.providers ?? {})
  if (providers.length === 0)
    return {
      exitCode: 0,
      stdout:
        `no providers configured in ${configFile(configDirectory)}\n` +
        "add one with: bashwink auth add <id> --base-url <url> --env <VAR> --model <model>",
    }
  const lines: string[] = [`providers in ${configFile(configDirectory)}`]
  let unusable = 0
  for (const [id, provider] of providers.sort(([a], [b]) => a.localeCompare(b))) {
    const { state, source } = providerCredential(provider)
    const usable = credentialUsable(state)
    if (!usable) unusable += 1
    const protocol =
      Object.values(provider.models ?? {})
        .map((model) => model.package)
        .filter((pkg): pkg is string => typeof pkg === "string")
        .map(
          (pkg) => Object.entries(PROTOCOL_PACKAGE).find(([, value]) => value === pkg)?.[0] ?? pkg,
        ) ?? []
    lines.push(
      `${usable ? "✓" : "✗"} ${id}` +
        (provider.name === undefined ? "" : ` (${provider.name})`) +
        `\n    url: ${provider.settings?.baseURL ?? "(none)"}` +
        `\n    credential: ${describeCredential(state, source)}` +
        (protocol.length === 0 ? "" : `\n    protocols: ${[...new Set(protocol)].join(", ")}`) +
        `\n    models: ${Object.keys(provider.models ?? {}).length}`,
    )
  }
  const active = defaultModel(config)
  lines.push("", active === undefined ? "default model: (none)" : `default model: ${active}`)
  return {
    exitCode: unusable === 0 ? 0 : 1,
    stdout: lines.join("\n"),
    ...(unusable === 0
      ? {}
      : {
          stderr: `${unusable} provider(s) cannot authenticate; see the ✗ entries above`,
        }),
  }
}

/**
 * `bashwink model` — list and select models.
 *
 * `list` reports what the *config* declares, which is a fact Bashwink owns. It does not
 * claim to be the runtime's live catalogue: that requires starting a server, and printing
 * a stale or partial list as if it were the catalogue would be exactly the kind of
 * unverified claim the evidence chain exists to prevent. `bashwink models` (forwarded to
 * the runtime) answers the live question.
 */
export function runModelCommand(args: readonly string[]): CommandResult {
  const resolved = paths()
  const sub = args[0]

  if (sub === "list" || sub === undefined) {
    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const providers = declaredProviders(config)
    if (providers.length === 0)
      return {
        exitCode: 0,
        stdout:
          "no models configured\n" +
          "add a provider with: bashwink auth add <id> --base-url <url> --env <VAR> --model <model>",
      }
    const active = defaultModel(config)
    const lines: string[] = []
    for (const provider of providers) {
      for (const model of provider.models) {
        const ref = `${provider.id}/${model.id}`
        lines.push(
          `${ref === active ? "*" : " "} ${ref}` +
            (model.protocol === undefined ? "" : `  [${model.protocol}]`),
        )
      }
    }
    lines.push("", "* = default. Live catalogue from the runtime: `bashwink models`")
    return { exitCode: 0, stdout: lines.join("\n") }
  }

  if (sub === "use") {
    const ref = args[1]
    if (ref === undefined) return usage("usage: bashwink model use <provider>/<model>")
    let parsed
    try {
      parsed = parseModelRef(ref)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const provider = config.providers?.[parsed.providerID]
    if (provider === undefined)
      return fail(
        `provider '${parsed.providerID}' is not configured; run \`bashwink auth status\` to see what is`,
      )
    if (provider.models?.[parsed.modelID] === undefined)
      return fail(
        `model '${parsed.modelID}' is not declared under '${parsed.providerID}'; ` +
          `declared: ${Object.keys(provider.models ?? {}).join(", ") || "(none)"}`,
      )
    const file = writeConfig(resolved.config, { ...config, model: ref })
    return { exitCode: 0, stdout: `default model is now ${ref} (${file})` }
  }

  if (sub === "current") {
    let config: RuntimeConfig
    try {
      config = readRuntimeConfig(resolved.config)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const active = defaultModel(config)
    return { exitCode: 0, stdout: active ?? "no default model configured" }
  }

  return usage(`unknown model subcommand '${sub}'; expected list, use, current`)
}

/** Exported for tests: read the key status of one provider without a CLI. */
export function inspectProvider(
  configDirectory: string,
  providerID: string,
): { present: boolean; detail: string } | undefined {
  let config: RuntimeConfig
  try {
    config = readRuntimeConfig(configDirectory)
  } catch {
    return undefined
  }
  const provider = config.providers?.[providerID]
  if (provider === undefined) return undefined
  const { state, source } = providerCredential(provider)
  return {
    present: credentialUsable(state),
    detail: describeCredential(state, source),
  }
}

/** Exported for `doctor`: does any configured provider resolve a credential? */
export function credentialSummary(configDirectory: string): {
  readonly configured: number
  readonly usable: number
  readonly detail: string
} {
  let config: RuntimeConfig
  try {
    config = readRuntimeConfig(configDirectory)
  } catch (error) {
    return {
      configured: 0,
      usable: 0,
      detail: `config is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const providers = Object.values(config.providers ?? {})
  const usable = providers.filter((provider) =>
    credentialUsable(providerCredential(provider).state),
  )
  return {
    configured: providers.length,
    usable: usable.length,
    detail:
      providers.length === 0
        ? "no providers configured; using the runtime's built-in catalogue"
        : `${usable.length}/${providers.length} configured provider(s) can authenticate`,
  }
}

/** Exported for tests: the raw credential reference of a provider's settings. */
export function providerKeyRef(configDirectory: string, providerID: string): unknown {
  try {
    return readRuntimeConfig(configDirectory).providers?.[providerID]?.settings?.apiKey
  } catch {
    return undefined
  }
}

/** Exported for tests: describe the routing decision for a provider spec. */
export function protocolPlan(spec: ProviderSpec): Record<string, string> {
  const plan: Record<string, string> = {}
  for (const model of spec.models)
    plan[model.id] = PROTOCOL_PACKAGE[model.protocol ?? spec.protocol ?? "openai"]
  return plan
}

/** Exported for tests: file existence without leaking a path into output. */
export function keyFileExists(file: string): boolean {
  return existsSync(path.resolve(file)) && credentialRef(`{file:${file}}`).kind === "file"
}

/** Exported for tests: fingerprint of an arbitrary string. */
export { fingerprint }
