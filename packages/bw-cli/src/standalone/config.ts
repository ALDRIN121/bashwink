/**
 * Standalone Bashwink configuration and credential reference handling.
 *
 * Strictly ignores foreign CLI state (~/.opencode, ~/.hermes, ~/.pi) and ambient provider
 * environment keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, CMD_API_KEY) unless explicitly named by
 * the user inside Bashwink's own `standalone.json`.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths, type Paths } from "../paths.ts"
import type { CredentialConfig, StandaloneConfig } from "./types.ts"

export const STANDALONE_CONFIG_VERSION = 1

export class StandaloneConfigError extends Error {
  readonly code = "standalone_config_invalid"
  constructor(message: string) {
    super(message)
    this.name = "StandaloneConfigError"
  }
}

export function standaloneConfigFile(configDirectory: string): string {
  return path.join(configDirectory, "standalone.json")
}

export function resolveStandalonePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  return paths(env)
}

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1"
}

export function normalizeBaseURL(
  raw: string,
  endpointType: "local" | "hosted",
): string {
  const trimmed = raw.trim()
  if (trimmed === "") throw new StandaloneConfigError("Endpoint URL must not be empty.")

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new StandaloneConfigError(`Invalid endpoint URL '${trimmed}'.`)
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new StandaloneConfigError("Endpoint URL must not embed credentials.")
  }
  if (endpointType === "local") {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new StandaloneConfigError("Local endpoint URL must use http:// or https://.")
    }
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      throw new StandaloneConfigError(
        `Plain http:// is restricted to loopback hosts (127.0.0.1, localhost, ::1); use https:// for '${parsed.hostname}'.`,
      )
    }
  } else {
    if (parsed.protocol !== "https:") {
      throw new StandaloneConfigError(
        `Hosted endpoint '${parsed.origin}' must use https://.`,
      )
    }
  }

  let pathname = parsed.pathname.replace(/\/+$/, "")
  if (pathname.endsWith("/chat/completions")) {
    pathname = pathname.slice(0, -"/chat/completions".length)
  }
  return `${parsed.origin}${pathname}`
}

export function validateModelID(model: string): string {
  const trimmed = model.trim()
  if (trimmed === "" || /[\r\n\0]/.test(trimmed)) {
    throw new StandaloneConfigError("Model ID must be a non-empty single-line identifier.")
  }
  return trimmed
}

export function validateEnvVarName(variable: string): string {
  const trimmed = variable.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new StandaloneConfigError(
      `Invalid environment variable name '${trimmed}'. Use letters, digits, and underscores.`,
    )
  }
  return trimmed
}

export function validateKeyFilePath(filePath: string): string {
  const trimmed = filePath.trim()
  if (trimmed === "") throw new StandaloneConfigError("Key file path must not be empty.")
  return path.resolve(trimmed)
}

export type ConfigLoadResult =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "ok"; readonly config: StandaloneConfig }

export function parseStandaloneConfig(raw: string): StandaloneConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new StandaloneConfigError(
      `Invalid JSON in standalone config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StandaloneConfigError("Standalone config must be a JSON object.")
  }
  const obj = parsed as Record<string, unknown>
  if (obj["version"] !== STANDALONE_CONFIG_VERSION) {
    throw new StandaloneConfigError(
      `Unsupported standalone config version ${String(obj["version"])} (expected ${STANDALONE_CONFIG_VERSION}).`,
    )
  }
  const endpointType = obj["endpointType"]
  if (endpointType !== "local" && endpointType !== "hosted") {
    throw new StandaloneConfigError("Config endpointType must be 'local' or 'hosted'.")
  }
  if (typeof obj["baseURL"] !== "string" || typeof obj["model"] !== "string") {
    throw new StandaloneConfigError("Config must declare string 'baseURL' and 'model'.")
  }
  const baseURL = normalizeBaseURL(obj["baseURL"], endpointType)
  const model = validateModelID(obj["model"])

  const credRaw = obj["credential"]
  if (typeof credRaw !== "object" || credRaw === null || Array.isArray(credRaw)) {
    throw new StandaloneConfigError("Config must declare a credential reference object.")
  }
  const credObj = credRaw as Record<string, unknown>
  let credential: CredentialConfig
  if (credObj["kind"] === "none") {
    credential = { kind: "none" }
  } else if (credObj["kind"] === "env" && typeof credObj["variable"] === "string") {
    credential = { kind: "env", variable: validateEnvVarName(credObj["variable"]) }
  } else if (credObj["kind"] === "file" && typeof credObj["path"] === "string") {
    credential = { kind: "file", path: validateKeyFilePath(credObj["path"]) }
  } else {
    throw new StandaloneConfigError("Config credential reference is invalid.")
  }

  let price: StandaloneConfig["price"]
  if (obj["price"] !== undefined) {
    if (typeof obj["price"] !== "object" || obj["price"] === null) {
      throw new StandaloneConfigError("Config price must be an object when present.")
    }
    const p = obj["price"] as Record<string, unknown>
    if (
      typeof p["inputUsdPer1M"] !== "number" ||
      typeof p["outputUsdPer1M"] !== "number" ||
      p["inputUsdPer1M"] < 0 ||
      p["outputUsdPer1M"] < 0
    ) {
      throw new StandaloneConfigError("Config price fields must be non-negative numbers.")
    }
    price = { inputUsdPer1M: p["inputUsdPer1M"], outputUsdPer1M: p["outputUsdPer1M"] }
  }

  let providerId: string | undefined
  if (obj["providerId"] !== undefined) {
    if (typeof obj["providerId"] !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(obj["providerId"])) {
      throw new StandaloneConfigError("Config providerId is invalid.")
    }
    providerId = obj["providerId"]
  }

  let wireProtocol: StandaloneConfig["wireProtocol"]
  if (obj["wireProtocol"] !== undefined) {
    if (obj["wireProtocol"] !== "openai-chat" && obj["wireProtocol"] !== "anthropic-messages") {
      throw new StandaloneConfigError("Config wireProtocol must be 'openai-chat' or 'anthropic-messages'.")
    }
    wireProtocol = obj["wireProtocol"]
  }

  let headers: Record<string, string> | undefined
  if (obj["headers"] !== undefined) {
    if (typeof obj["headers"] !== "object" || obj["headers"] === null || Array.isArray(obj["headers"])) {
      throw new StandaloneConfigError("Config headers must be an object.")
    }
    headers = {}
    for (const [k, v] of Object.entries(obj["headers"] as Record<string, unknown>)) {
      if (typeof v !== "string" || /[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) {
        throw new StandaloneConfigError(`Config header '${k}' is invalid.`)
      }
      if (/^(authorization|content-type|host|x-api-key)$/i.test(k)) {
        throw new StandaloneConfigError(`Config header '${k}' cannot be overridden.`)
      }
      headers[k] = v
    }
  }

  return {
    version: STANDALONE_CONFIG_VERSION,
    ...(providerId === undefined ? {} : { providerId }),
    endpointType,
    ...(wireProtocol === undefined ? {} : { wireProtocol }),
    baseURL,
    model,
    credential,
    ...(headers === undefined ? {} : { headers }),
    updatedAt: typeof obj["updatedAt"] === "string" ? obj["updatedAt"] : new Date(0).toISOString(),
    ...(price === undefined ? {} : { price }),
  }
}

export function loadStandaloneConfig(configDirectory: string): ConfigLoadResult {
  const file = standaloneConfigFile(configDirectory)
  if (!existsSync(file)) return { status: "missing" }
  try {
    const config = parseStandaloneConfig(readFileSync(file, "utf8"))
    return { status: "ok", config }
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Write standalone.json atomically so cancellation or crash never leaves a partial profile. */
export function saveStandaloneConfig(configDirectory: string, config: StandaloneConfig): string {
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  const normalized: StandaloneConfig = {
    version: STANDALONE_CONFIG_VERSION,
    ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
    endpointType: config.endpointType,
    ...(config.wireProtocol === undefined ? {} : { wireProtocol: config.wireProtocol }),
    baseURL: normalizeBaseURL(config.baseURL, config.endpointType),
    model: validateModelID(config.model),
    credential: config.credential,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    updatedAt: config.updatedAt,
    ...(config.price === undefined ? {} : { price: config.price }),
  }
  const file = standaloneConfigFile(configDirectory)
  const temp = path.join(
    configDirectory,
    `.standalone.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  )
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, file)
  return file
}

export interface ResolvedCredential {
  readonly ok: boolean
  readonly secret?: string
  readonly summary: string
  readonly warning?: string
}

export function resolveCredentialSecret(
  credential: CredentialConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  if (credential.kind === "none") {
    return { ok: true, summary: "none (unauthenticated)" }
  }
  if (credential.kind === "env") {
    const raw = env[credential.variable]
    const trimmed = typeof raw === "string" ? raw.trim() : ""
    if (trimmed === "") {
      return {
        ok: false,
        summary: `env:${credential.variable} (not set or empty)`,
      }
    }
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8)
    return {
      ok: true,
      secret: trimmed,
      summary: `env:${credential.variable} (present, ${trimmed.length} chars, sha256:${digest}…)`,
    }
  }
  const file = path.resolve(credential.path)
  if (!existsSync(file)) {
    return { ok: false, summary: `file:${file} (missing)` }
  }
  try {
    const st = statSync(file)
    const raw = readFileSync(file, "utf8").trim()
    if (raw === "") {
      return { ok: false, summary: `file:${file} (empty)` }
    }
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8)
    const warning =
      process.platform !== "win32" && (st.mode & 0o077) !== 0
        ? `key file ${file} is readable by group/others; run chmod 600`
        : undefined
    return {
      ok: true,
      secret: raw,
      summary: `file:${file} (present, ${raw.length} chars, sha256:${digest}…)`,
      ...(warning === undefined ? {} : { warning }),
    }
  } catch (error) {
    return {
      ok: false,
      summary: `file:${file} (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

export function formatDestination(baseURL: string): string {
  try {
    const u = new URL(baseURL)
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
  } catch {
    return baseURL
  }
}

export interface LegacyProviderCandidate {
  readonly id: string
  readonly baseURL: string
  readonly model: string
  readonly credential: CredentialConfig
}

/**
 * Inspect legacy `opencode.json` in `configDirectory` to offer an explicit opt-in import preview
 * without auto-enabling or mutating legacy config.
 */
export function inspectLegacyOpenAiProviders(configDirectory: string): LegacyProviderCandidate[] {
  const legacyFile = path.join(configDirectory, "opencode.json")
  if (!existsSync(legacyFile)) return []
  try {
    const parsed = JSON.parse(readFileSync(legacyFile, "utf8")) as Record<string, unknown>
    const providers = parsed["providers"]
    if (typeof providers !== "object" || providers === null) return []
    const out: LegacyProviderCandidate[] = []
    for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue
      const p = entry as Record<string, unknown>
      const settings = p["settings"] as Record<string, unknown> | undefined
      const baseURL = typeof settings?.["baseURL"] === "string" ? settings["baseURL"] : undefined
      if (!baseURL) continue
      const modelsObj = p["models"] as Record<string, unknown> | undefined
      const modelID = modelsObj ? Object.keys(modelsObj)[0] : undefined
      if (!modelID) continue
      const envArr = Array.isArray(p["env"]) ? p["env"].filter((v): v is string => typeof v === "string") : []
      const apiKeyRef = typeof settings?.["apiKey"] === "string" ? settings["apiKey"] : undefined
      let credential: CredentialConfig = { kind: "none" }
      const fileMatch = apiKeyRef ? /^\{file:([^}]+)\}$/.exec(apiKeyRef) : null
      const envMatch = apiKeyRef ? /^\{env:([^}]+)\}$/.exec(apiKeyRef) : null
      if (fileMatch?.[1]) credential = { kind: "file", path: fileMatch[1] }
      else if (envMatch?.[1]) credential = { kind: "env", variable: envMatch[1] }
      else if (envArr[0]) credential = { kind: "env", variable: envArr[0] }
      out.push({ id, baseURL, model: modelID, credential })
    }
    return out
  } catch {
    return []
  }
}
