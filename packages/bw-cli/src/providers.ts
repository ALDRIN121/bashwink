/**
 * Provider and model configuration for the real-LLM path (BW-091/BW-092).
 *
 * **What this module is not.** It is not a second provider engine. Inference, streaming,
 * tool calling, retries and session state all belong to the pinned OpenCode runtime
 * (ADR-003). Bashwink's job is narrower and load-bearing: write a *valid* provider
 * definition into the config the runtime reads, report credential state honestly, and
 * surface the runtime's model catalogue without guessing.
 *
 * Three facts found by reading the v2.3.2 source and then confirming against the real
 * binary shape everything below:
 *
 * 1. A custom provider's `package` chooses the **wire protocol**, and it is applied to
 *    every model of that provider. A provider whose models speak different protocols
 *    (Anthropic Messages vs OpenAI chat) therefore needs a per-model `package` override.
 *    Getting this wrong is not a validation error at load time: the first request fails
 *    with a message naming the endpoint shape, several steps away from the config that
 *    caused it. `modelsForProtocol()` encodes the mapping once.
 *
 * 2. Credentials are resolved by the runtime, not by Bashwink: `env: [...]` names the
 *    variables it will read, and `{env:VAR}` / `{file:PATH}` are substituted inside the
 *    config text. Bashwink therefore never needs to hold a key — it only needs to declare
 *    where one lives, and to say whether that location currently resolves.
 *
 * 3. Anything that can hold a secret is reported as presence plus a fingerprint. Not a
 *    prefix, not a suffix: this output is designed to be pasted into an issue.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/** Wire protocol a provider's models speak. */
export type Protocol = "anthropic" | "openai" | "openai-responses"

/**
 * Provider packages the pinned runtime ships, keyed by protocol.
 *
 * Values are the exact import specifiers the runtime resolves (`packages/ai/package.json`
 * `exports` in v2.3.2). A typo here is not caught by the runtime at load time — the
 * provider simply never produces a model — so the constants live in one place and are
 * asserted in tests.
 */
export const PROTOCOL_PACKAGE: Readonly<Record<Protocol, string>> = {
  anthropic: "@opencode/ai/providers/anthropic",
  openai: "@opencode/ai/providers/openai/chat",
  "openai-responses": "@opencode/ai/providers/openai/responses",
}

export class ProviderConfigError extends Error {
  readonly code = "provider_config_invalid"
  constructor(message: string) {
    super(message)
    this.name = "ProviderConfigError"
  }
}

export interface ProviderModelSpec {
  readonly id: string
  readonly name?: string
  readonly protocol?: Protocol
  readonly context?: number
  readonly output?: number
}

export interface ProviderSpec {
  readonly id: string
  readonly name?: string
  /** Base URL of an OpenAI/Anthropic-compatible endpoint. */
  readonly baseURL: string
  /**
   * Environment variables the runtime may read the key from, in order.
   *
   * Declaring the name is what makes `bashwink auth status` able to answer "will this
   * work?" without Bashwink ever reading the value.
   */
  readonly env?: readonly string[]
  /** Protocol for every model of this provider; per-model `protocol` overrides it. */
  readonly protocol?: Protocol
  readonly models: readonly ProviderModelSpec[]
}

/**
 * A provider declaration as it appears in the runtime config file.
 *
 * Note the absence of `id`: the provider's key in the `providers` map *is* its id, and the
 * runtime's config schema rejects unknown keys. An earlier version emitted `id` too, which
 * type-checked (the writers were structurally compatible) but wrote a config the runtime
 * would refuse — caught by running the real binary against it.
 */
export interface RawProvider {
  readonly name?: string
  readonly package?: string
  readonly env?: readonly string[]
  readonly settings?: { readonly baseURL?: string; readonly apiKey?: unknown }
  readonly models?: Readonly<Record<string, RawModel>>
}

interface RawModel {
  readonly name?: string
  readonly package?: string
  readonly limit?: { readonly context?: number; readonly output?: number }
}

/** Config file shape, limited to the keys this module reads or writes. */
export interface RuntimeConfig {
  readonly model?: unknown
  readonly providers?: Readonly<Record<string, RawProvider>>
  readonly [key: string]: unknown
}

export function configFile(configDirectory: string): string {
  return path.join(configDirectory, "opencode.json")
}

/** Read the runtime config. A missing file is `{}`; a corrupt one is an error, not a guess. */
export function readRuntimeConfig(configDirectory: string): RuntimeConfig {
  const file = configFile(configDirectory)
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new ProviderConfigError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ProviderConfigError(`${file} must contain a JSON object`)
  return parsed as RuntimeConfig
}

/** Normalise a model reference. `provider/model` only: a bare model id is ambiguous. */
export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const at = ref.indexOf("/")
  if (at <= 0 || at === ref.length - 1)
    throw new ProviderConfigError(
      `model reference '${ref}' must be 'provider/model' (for example 'anthropic/claude-sonnet-5')`,
    )
  return { providerID: ref.slice(0, at), modelID: ref.slice(at + 1) }
}

/** Validate an id against the runtime's accepted shape, before it becomes a config key. */
export function validateProviderID(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id))
    throw new ProviderConfigError(
      `provider id '${id}' is invalid: use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit`,
    )
  if (id.length > 64) throw new ProviderConfigError("provider id is longer than 64 characters")
}

function protocolOf(pkg: string | undefined): Protocol | undefined {
  if (pkg === PROTOCOL_PACKAGE.anthropic) return "anthropic"
  if (pkg === PROTOCOL_PACKAGE.openai) return "openai"
  if (pkg === PROTOCOL_PACKAGE["openai-responses"]) return "openai-responses"
  return undefined
}

/**
 * Build the runtime's `providers` entry for one provider.
 *
 * The provider-level `package` is set only when every model shares one protocol. When
 * models differ, each model carries its own `package` and the provider-level field is
 * omitted: the runtime applies the provider package to all models, so a provider-level
 * value would silently mis-protocol the other models.
 */
export interface BuiltProvider {
  readonly provider: RawProvider
  readonly id: string
}

export function toRuntimeProvider(spec: ProviderSpec): RawProvider {
  const protocols = new Set(
    spec.models.map((model) => model.protocol ?? spec.protocol ?? ("openai" as Protocol)),
  )
  const uniform = protocols.size === 1 ? [...protocols][0] : undefined
  const models: Record<string, RawModel> = {}
  for (const model of spec.models) {
    const protocol = model.protocol ?? spec.protocol ?? "openai"
    models[model.id] = {
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(uniform === undefined ? { package: PROTOCOL_PACKAGE[protocol] } : {}),
      ...(model.context === undefined && model.output === undefined
        ? {}
        : {
            limit: {
              ...(model.context === undefined ? {} : { context: model.context }),
              ...(model.output === undefined ? {} : { output: model.output }),
            },
          }),
    }
  }
  return {
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(uniform === undefined ? {} : { package: PROTOCOL_PACKAGE[uniform] }),
    ...(spec.env === undefined ? {} : { env: [...spec.env] }),
    settings: { baseURL: spec.baseURL },
    models,
  }
}

/**
 * Pre-flight the credential for a model reference, before the runtime starts.
 *
 * The runtime's failure for a missing key is `Invalid \'Authorization\' header or token.` —
 * true, but it names the header rather than the variable, and it arrives after the server
 * has started and a session has been created. A wrapper that knows which variable the
 * provider declared owes the user that sentence instead.
 *
 * Returns `undefined` when nothing can be said: an unconfigured provider (the runtime's own
 * catalogue handles its own credentials) or a model ref that does not name a config provider.
 */
export function preflightCredential(
  config: RuntimeConfig,
  modelRef: string | undefined,
): { readonly ok: boolean; readonly message: string } | undefined {
  if (modelRef === undefined) return undefined
  let parsed
  try {
    parsed = parseModelRef(modelRef)
  } catch {
    return undefined
  }
  const provider = config.providers?.[parsed.providerID]
  if (provider === undefined) return undefined
  const { state, source } = providerCredential(provider)
  if (credentialUsable(state)) return undefined
  const detail = describeCredential(state, source)
  return {
    ok: false,
    message:
      `model '${modelRef}' selects provider '${parsed.providerID}', which cannot authenticate: ${detail}\n` +
      (state.kind === "env"
        ? `fix: export ${state.variable}=... and re-run`
        : state.kind === "file"
          ? `fix: create the key file ${state.file} and re-run`
          : "fix: declare --env or --key-file with `bashwink auth add`"),
  }
}

/** Read back the providers a config declares, in a shape the CLI can print. */
export function declaredProviders(config: RuntimeConfig): ProviderSpec[] {
  const out: ProviderSpec[] = []
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const models: ProviderModelSpec[] = Object.entries(provider.models ?? {}).map(
      ([modelID, m]) => {
        const protocol = protocolOf(m.package)
        return {
          id: modelID,
          ...(m.name === undefined ? {} : { name: m.name }),
          ...(protocol === undefined ? {} : { protocol }),
          ...(m.limit?.context === undefined ? {} : { context: m.limit.context }),
          ...(m.limit?.output === undefined ? {} : { output: m.limit.output }),
        }
      },
    )
    const protocol = protocolOf(provider.package)
    out.push({
      id: String(id),
      ...(provider.name === undefined ? {} : { name: provider.name }),
      baseURL: provider.settings?.baseURL ?? "",
      ...(provider.env === undefined ? {} : { env: provider.env }),
      ...(protocol === undefined ? {} : { protocol }),
      models,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Default model declared in the config, if any. Accepts both reference spellings. */
export function defaultModel(config: RuntimeConfig): string | undefined {
  const value = config.model
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const record = value as { providerID?: unknown; model?: unknown; modelID?: unknown }
    const providerID = record.providerID
    const modelID = record.model ?? record.modelID
    if (typeof providerID === "string" && typeof modelID === "string")
      return `${providerID}/${modelID}`
  }
  return undefined
}

/** True when the credential route resolves right now. */
export function credentialUsable(state: CredentialState): boolean {
  return state.kind === "literal" || (state.kind !== "none" && state.present)
}

export type CredentialState =
  | { readonly kind: "env"; readonly variable: string; readonly present: boolean }
  | {
      readonly kind: "file"
      readonly file: string
      readonly present: boolean
      /**
       * True when the file is readable by group or others.
       *
       * A key file's protection *is* its permission bits; nothing else stops another local
       * account from reading it. Reported rather than enforced: refusing would break a file
       * that works, and the runtime reads it happily — but a 0644 key file is a finding, and
       * silence about it would be the wrong default.
       */
      readonly groupOrWorldReadable: boolean
    }
  | { readonly kind: "literal"; readonly present: true }
  | { readonly kind: "none" }

/** Extract a `{env:VAR}` or `{file:PATH}` reference, if that is what the value is. */
export function credentialRef(value: unknown): CredentialState {
  if (typeof value !== "string" || value === "") return { kind: "none" }
  const env = /^\{env:([^}]+)\}$/.exec(value)
  if (env?.[1] !== undefined)
    return {
      kind: "env",
      variable: env[1],
      present: (process.env[env[1]] ?? "").trim() !== "",
    }
  const file = /^\{file:([^}]+)\}$/.exec(value)
  if (file?.[1] !== undefined) {
    const resolved = path.resolve(file[1])
    return {
      kind: "file",
      file: resolved,
      present: fileHasContent(resolved),
      groupOrWorldReadable: isGroupOrWorldReadable(resolved),
    }
  }
  return { kind: "literal", present: true }
}

/**
 * Whether a provider can authenticate right now, and by which route.
 *
 * Order matches the runtime's: an explicit `settings.apiKey` wins, then any declared
 * environment variable. `unconfigured` is a distinct answer from `missing`: a provider
 * that declares no credential route is a config decision, while one that declares a route
 * whose variable is empty is a broken install.
 */
export function providerCredential(provider: RawProvider): {
  state: CredentialState
  source: "settings" | "env" | "none"
} {
  const ref = credentialRef((provider.settings as { apiKey?: unknown } | undefined)?.apiKey)
  if (ref.kind !== "none") return { state: ref, source: "settings" }
  for (const name of provider.env ?? []) {
    if ((process.env[name] ?? "").trim() !== "")
      return { state: { kind: "env", variable: name, present: true }, source: "env" }
  }
  const first = (provider.env ?? [])[0]
  if (first !== undefined)
    return { state: { kind: "env", variable: first, present: false }, source: "env" }
  return { state: { kind: "none" }, source: "none" }
}

/** True when group or others have any access. A missing file answers false (nothing to leak). */
function isGroupOrWorldReadable(file: string): boolean {
  try {
    return (statSync(file).mode & 0o077) !== 0
  } catch {
    return false
  }
}

function fileHasContent(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

/**
 * Describe a secret without revealing it: presence, length and a truncated digest.
 *
 * No prefix and no suffix — a "last four characters" habit narrows a key search enough to
 * matter, and this string is meant to be shareable.
 */
export function fingerprint(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "") return "absent"
  return `present (${trimmed.length} chars, sha256:${createHash("sha256").update(trimmed).digest("hex").slice(0, 8)}…)`
}

/** Human-readable credential state for `bashwink auth status` and `doctor`. */
export function describeCredential(
  state: CredentialState,
  source: "settings" | "env" | "none",
): string {
  switch (state.kind) {
    case "env":
      return state.present
        ? `${state.variable} is set (${fingerprint(process.env[state.variable] ?? "")})`
        : `${state.variable} is not set`
    case "file":
      if (!state.present) return `key file ${state.file} is missing or empty`
      return (
        `key file ${state.file} (${fileSize(state.file)} bytes` +
        (state.groupOrWorldReadable
          ? ", WARNING: readable by group/others — chmod 600 it"
          : ", mode 600") +
        ")"
      )
    case "literal":
      return "key stored verbatim in the config (works, but a file or env var is safer)"
    case "none":
      return source === "none" ? "no credential route declared" : "no credential available"
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
