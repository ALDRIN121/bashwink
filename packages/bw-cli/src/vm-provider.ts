import { randomBytes } from "node:crypto"
import { regularFile, sha256 } from "./native-stage.js"
import { paths } from "./paths.js"
import {
  declaredProviders,
  defaultModel,
  parseModelRef,
  readRuntimeConfig,
  type Protocol,
  type RawProvider,
  type RuntimeConfig,
} from "./providers.js"

const APPROVED = [
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1",
  "https://api.commandcode.ai/provider/v1",
]

const WIRE = {
  openai: ["openai-chat", "chat/completions"],
  anthropic: ["anthropic-messages", "messages"],
  "openai-responses": ["openai-responses", "responses"],
} as const satisfies Record<Protocol, readonly [string, string]>

type RelayProtocol = (typeof WIRE)[Protocol][0]

type RelayRoute = {
  id: string
  protocol: RelayProtocol
  endpoint: URL
  credential: string
  models: string[]
  maxOutputTokens: number
}

function credential(provider: RawProvider, environment: NodeJS.ProcessEnv) {
  const ref = provider.settings?.apiKey
  let key: string | undefined
  if (typeof ref === "string" && ref !== "") {
    const variable = /^\{env:([A-Z_][A-Z_0-9]*)\}$/i.exec(ref)?.[1]
    const filename = /^\{file:(\/[^{}]+)\}$/.exec(ref)?.[1]
    if (variable) key = environment[variable]
    else if (filename) {
      let file
      try {
        file = regularFile(filename, 4096)
      } catch {
        throw new Error("the configured host credential file is unavailable")
      }
      if ((file.mode & 0o077) !== 0)
        throw new Error("the configured host credential file is not private")
      key = file.data.toString("utf8")
    } else
      throw new Error("use a host environment reference or a private key file for the VM provider")
  } else {
    for (const name of provider.env ?? []) {
      if (!/^[A-Z_][A-Z_0-9]*$/i.test(name))
        throw new Error("invalid host credential variable name")
      if (environment[name]?.trim()) {
        key = environment[name]
        break
      }
    }
  }
  const value = key?.trim()
  if (!value || !/^[!-~]{1,4096}$/.test(value))
    throw new Error("host provider credential is missing or invalid. Run bashwink auth status")
  return value
}

function requestLimit(value?: string) {
  if (value === undefined) return 8
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 40)
    throw new Error("BASHWINK_VM_MAX_REQUESTS must be between 1 and 40")
  return Number(value)
}

export function vmProviderSelection(
  config: RuntimeConfig,
  id: string,
  environment: NodeJS.ProcessEnv,
) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error("invalid selected VM provider ID")
  const spec = declaredProviders(config).find((provider) => provider.id === id)
  const raw = Object.hasOwn(config.providers ?? {}, id) ? config.providers?.[id] : undefined
  if (!spec || !raw) throw new Error("configure the selected provider with bashwink auth add")
  const base = spec.baseURL.replace(/\/$/, "")
  if (!APPROVED.includes(base))
    throw new Error("provider destination is outside the offline VM allowlist")
  if (spec.models.length === 0 || spec.models.length > 8)
    throw new Error("the VM relay requires one to eight explicitly declared models")
  const selected = defaultModel(config)
  const model = selected ? parseModelRef(selected) : undefined
  if (!model || model.providerID !== id || !spec.models.some((entry) => entry.id === model.modelID))
    throw new Error("select an approved VM provider model with bashwink model use")
  const key = credential(raw, environment)
  const capability = randomBytes(32).toString("hex")
  const routes: RelayRoute[] = []
  const guestRoutes: {
    id: string
    provider: string
    model: string
    protocol: RelayProtocol
    context: number
    output: number
  }[] = []
  const protocols = new Set(spec.models.map((entry) => entry.protocol ?? spec.protocol))
  for (const protocol of [...protocols].sort()) {
    if (!protocol) throw new Error("declare the wire protocol of every approved VM model")
    if (base === "https://api.openai.com/v1" && protocol === "anthropic")
      throw new Error("the selected VM provider does not serve Anthropic Messages")
    if (base === "https://api.anthropic.com/v1" && protocol !== "anthropic")
      throw new Error("the selected VM provider only serves Anthropic Messages")
    const [wire, suffix] = WIRE[protocol]
    const entries = spec.models.filter((entry) => (entry.protocol ?? spec.protocol) === protocol)
    const models = entries.map((entry) => entry.id).sort()
    const output = Math.min(1024, ...entries.map((entry) => entry.output ?? 1024))
    if (
      !Number.isSafeInteger(output) ||
      output < 1 ||
      !models.every((name) => /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i.test(name))
    )
      throw new Error("invalid VM provider model limits or identifier")
    routes.push({
      id: wire,
      protocol: wire,
      endpoint: new URL(`${base}/${suffix}`),
      credential: key,
      models,
      maxOutputTokens: output,
    })
    for (const entry of entries) {
      const context = entry.context ?? 32_768
      if (!Number.isSafeInteger(context) || context < output || context > 2_000_000)
        throw new Error("invalid VM provider context limit")
      guestRoutes.push({
        id: wire,
        provider: protocols.size === 1 ? id : `${id}-${wire}`,
        model: entry.id,
        protocol: wire,
        context,
        output,
      })
    }
  }
  const chosen = guestRoutes.find((entry) => entry.model === model.modelID)!
  return {
    binding: sha256(JSON.stringify([id, base, guestRoutes])),
    provider: id,
    routes,
    maxRequests: requestLimit(environment["BASHWINK_VM_MAX_REQUESTS"]),
    guest: { capability, defaultModel: `${chosen.provider}/${chosen.model}`, routes: guestRoutes },
  }
}

export function configuredVmProvider() {
  const id = process.env["BASHWINK_VM_PROVIDER"]
  return id === undefined
    ? undefined
    : vmProviderSelection(readRuntimeConfig(paths().config), id, process.env)
}

export type VmProviderSelection = ReturnType<typeof vmProviderSelection>
