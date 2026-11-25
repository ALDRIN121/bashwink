/**
 * Curated multi-provider & model catalog ported from OpenCode v2.3.2
 * (`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, MIT license, Copyright (c) 2025 opencode),
 * specifically `packages/ai/src/providers/{openai,openrouter,deepseek,groq,xai}.ts`
 * and `packages/core/src/plugin/provider/{ollama,lmstudio,vllm}.ts`.
 *
 * Intentionally pure static data: zero network discovery on startup/setup, zero automatic
 * credential pickup from ambient environment variables or foreign CLI config files.
 */

export interface ProviderPreset {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly endpointType: "hosted" | "local"
  readonly defaultBaseURL?: string
  readonly defaultEnvVar?: string
  readonly defaultCredentialKind: "env" | "none"
  readonly defaultModels: readonly string[]
  readonly defaultHeaders?: Readonly<Record<string, string>>
  readonly note: string
}

export const PROVIDER_CATALOG: readonly ProviderPreset[] = [
  {
    index: 1,
    id: "openai",
    name: "OpenAI",
    endpointType: "hosted",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultEnvVar: "OPENAI_API_KEY",
    defaultCredentialKind: "env",
    defaultModels: ["gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    note: "Official OpenAI API",
  },
  {
    index: 2,
    id: "openrouter",
    name: "OpenRouter",
    endpointType: "hosted",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    defaultEnvVar: "OPENROUTER_API_KEY",
    defaultCredentialKind: "env",
    defaultModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "deepseek/deepseek-chat-v3-0324",
    ],
    defaultHeaders: { "X-Title": "Bashwink" },
    note: "Multi-provider gateway",
  },
  {
    index: 3,
    id: "deepseek",
    name: "DeepSeek",
    endpointType: "hosted",
    defaultBaseURL: "https://api.deepseek.com/v1",
    defaultEnvVar: "DEEPSEEK_API_KEY",
    defaultCredentialKind: "env",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
    note: "DeepSeek API",
  },
  {
    index: 4,
    id: "groq",
    name: "Groq",
    endpointType: "hosted",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    defaultEnvVar: "GROQ_API_KEY",
    defaultCredentialKind: "env",
    defaultModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b"],
    note: "Groq OpenAI-compatible API",
  },
  {
    index: 5,
    id: "xai",
    name: "xAI (Grok)",
    endpointType: "hosted",
    defaultBaseURL: "https://api.x.ai/v1",
    defaultEnvVar: "XAI_API_KEY",
    defaultCredentialKind: "env",
    defaultModels: ["grok-3", "grok-3-mini", "grok-code-fast-1"],
    note: "xAI Grok API",
  },
  {
    index: 6,
    id: "custom-hosted",
    name: "Custom hosted endpoint",
    endpointType: "hosted",
    defaultCredentialKind: "env",
    defaultModels: [],
    note: "Any HTTPS OpenAI-compatible endpoint",
  },
  {
    index: 7,
    id: "ollama",
    name: "Ollama (local)",
    endpointType: "local",
    defaultBaseURL: "http://127.0.0.1:11434/v1",
    defaultCredentialKind: "none",
    defaultModels: ["qwen2.5-coder:7b", "llama3.2", "deepseek-r1:8b"],
    note: "Local Ollama OpenAI-compatible server",
  },
  {
    index: 8,
    id: "lmstudio",
    name: "LM Studio (local)",
    endpointType: "local",
    defaultBaseURL: "http://127.0.0.1:1234/v1",
    defaultCredentialKind: "none",
    defaultModels: ["local-model"],
    note: "Local LM Studio server",
  },
  {
    index: 9,
    id: "vllm",
    name: "vLLM (local)",
    endpointType: "local",
    defaultBaseURL: "http://127.0.0.1:8000/v1",
    defaultCredentialKind: "none",
    defaultModels: [],
    note: "Local vLLM server",
  },
  {
    index: 10,
    id: "custom-local",
    name: "Custom local endpoint",
    endpointType: "local",
    defaultCredentialKind: "none",
    defaultModels: [],
    note: "Loopback HTTP/HTTPS endpoint",
  },
]

export function findProviderPreset(input: string): ProviderPreset | undefined {
  const clean = input.trim().toLowerCase()
  if (clean === "") return undefined
  const asNum = Number(clean)
  if (Number.isInteger(asNum)) {
    return PROVIDER_CATALOG.find((p) => p.index === asNum)
  }
  if (clean === "hosted") return PROVIDER_CATALOG.find((p) => p.id === "custom-hosted")
  if (clean === "local") return PROVIDER_CATALOG.find((p) => p.id === "custom-local")
  return PROVIDER_CATALOG.find(
    (p) => p.id === clean || p.name.toLowerCase() === clean,
  )
}
