// Host-only synthetic upstream for the installed VM relay acceptance fixture.
// The normal Bashwink launcher never provides test transport dependencies.
import { fileURLToPath } from "node:url"
import path from "node:path"
import { runOfflineVm } from "../../packages/bw-cli/src/offline-vm.js"
import { startProviderRelay } from "../../packages/bw-cli/src/provider-relay.js"

const actions = [
  { tool: "write", args: { path: "one.ts", content: "export const one = 2\n" } },
  { tool: "write", args: { path: "two.ts", content: "export const two = 3\n" } },
  { tool: "write", args: { path: "new.ts", content: "export const added = 5\n" } },
  { tool: "shell", args: { command: "rm obsolete.ts" } },
  { tool: "shell", args: { command: "bun test accept.test.ts && project-heartbeat" } },
]
const original = "Fix the persistent project"
const continued = "Continue the saved project task"
const credential = process.env["BW_SYNTHETIC_CREDENTIAL"]
if (!credential) throw new Error("missing disposable upstream credential")
const [flag, session] = process.argv.slice(2)
const resume = flag === "--continue" ? "continue" : flag === "--session" ? session : undefined
const result = await runOfflineVm(path.dirname(fileURLToPath(import.meta.url)), resume, (options) =>
  startProviderRelay(options, {
    resolve: async () => ["93.184.216.34"],
    request: async ({ endpoint, address, headers, body, signal }) => {
      if (
        endpoint.href !== "https://api.openai.com/v1/chat/completions" ||
        address !== "93.184.216.34" ||
        headers["authorization"] !== `Bearer ${credential}` ||
        body.includes(credential)
      )
        throw new Error("incorrect synthetic relay contract")
      const request = JSON.parse(body.toString()) as {
        model: string
        messages: { role: string }[]
        tools?: { function: { name: string } }[]
      }
      const user = request.messages.findLastIndex((message) => message.role === "user")
      const prompt = JSON.stringify(request.messages[user] ?? {})
      const step = request.messages
        .slice(user + 1)
        .filter((message) => message.role === "tool").length
      const next = request.tools?.length && prompt.includes(original) ? actions[step] : undefined
      let completion = "Bashwink relay fixture"
      if (request.tools?.length && prompt.includes(original))
        completion = "VM project tool sequence completed"
      if (prompt.includes(continued)) {
        const prior = request.messages
          .slice(0, user)
          .some((message) => message.role === "user" && JSON.stringify(message).includes(original))
        completion = prior
          ? "VM project original conversation observed"
          : "VM project history missing"
      }
      if (next) {
        if (!request.tools?.some((tool) => tool.function.name === next.tool))
          throw new Error("missing permitted tool in synthetic request")
        process.stdout.write(`BW_VM_PROJECT_TOOL_${step}\n`)
      }
      const choice = (delta: object, finish: string | null = null) => ({
        id: `chatcmpl-relay-${step}`,
        object: "chat.completion.chunk",
        created: 1,
        model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const frames = [
        choice({ role: "assistant", content: "" }),
        next
          ? choice({
              tool_calls: [
                {
                  index: 0,
                  id: `call_relay_${step}`,
                  type: "function",
                  function: { name: next.tool, arguments: JSON.stringify(next.args) },
                },
              ],
            })
          : choice({ content: completion }),
        choice({}, next ? "tool_calls" : "stop"),
        {
          id: `chatcmpl-relay-${step}`,
          object: "chat.completion.chunk",
          created: 1,
          model: request.model,
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        },
      ]
      return {
        status: 200,
        contentType: "text/event-stream",
        body: (async function* () {
          for (const frame of frames) {
            if (signal.aborted) return
            yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`)
            await Bun.sleep(8)
          }
          yield Buffer.from("data: [DONE]\n\n")
        })(),
        cancel() {},
      }
    },
  }),
)
process.exit(result)
