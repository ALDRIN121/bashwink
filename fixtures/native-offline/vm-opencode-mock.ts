// Disposable guest-only provider. It has no upstream destination or credentials.
type Message = { role: string }
type Tool = { function: { name: string } }

const project = [
  { tool: "write", args: { path: "one.ts", content: "export const one = 2\n" } },
  { tool: "write", args: { path: "two.ts", content: "export const two = 3\n" } },
  { tool: "write", args: { path: "new.ts", content: "export const added = 5\n" } },
  { tool: "shell", args: { command: "rm obsolete.ts" } },
  { tool: "shell", args: { command: "bun test accept.test.ts && project-heartbeat" } },
]
const original = "Fix the persistent project"
const resume = "Continue the saved project task"

Bun.serve({
  hostname: "127.0.0.1",
  port: 8117,
  async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/healthz") return new Response("ok")
    if (route !== "/v1/chat/completions" || request.method !== "POST")
      return new Response(null, { status: 404 })
    const body = (await request.json()) as { messages: Message[]; tools?: Tool[]; model: string }
    const offered = body.tools ?? []
    if (
      offered.length > 0 &&
      JSON.stringify(body.messages).includes("Crash the disposable VM runtime")
    ) {
      const proofs = [
        ...new Bun.Glob(".readiness-*/ready.json").scanSync("/state/bashwink/data/scopes"),
      ]
      if (proofs.length !== 1) throw new Error("expected one guest runtime proof")
      const proof = await Bun.file(`/state/bashwink/data/scopes/${proofs[0]}`).json()
      const pid = Number(proof.pid)
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid runtime proof PID")
      const command = (await Bun.file(`/proc/${pid}/cmdline`).text()).split("\0")
      if (command[0] !== "/opt/opencode" || !command.includes("serve"))
        throw new Error("runtime proof did not identify the guest server")
      process.kill(pid, "SIGKILL")
      console.log("BW_VM_GUEST_SERVER_KILLED")
      return new Response(null, { status: 503 })
    }
    const isProject = process.env.BW_VM_PROJECT === "1"
    const userIndex = body.messages.findLastIndex((message) => message.role === "user")
    const prompt = JSON.stringify(body.messages[userIndex] ?? {})
    const step = body.messages
      .slice(isProject ? userIndex + 1 : 0)
      .filter((message) => message.role === "tool").length
    let next: { tool: string; args: object } | undefined
    let completion: string
    if (isProject && prompt.includes(resume)) {
      const continued = body.messages
        .slice(0, userIndex)
        .some((message) => message.role === "user" && JSON.stringify(message).includes(original))
      completion = continued
        ? "VM project original conversation observed"
        : "VM project history missing"
    } else if (isProject && prompt.includes(original)) {
      next = project[step]
      completion = "VM project tool sequence completed"
    } else if (!isProject) {
      next = [
        { tool: "write", args: { path: "task.txt", content: "VM fixture edit\n" } },
        { tool: "shell", args: { command: "sh check.sh" } },
      ][step]
      completion = "VM fixture tool sequence completed"
    } else {
      return new Response("unexpected mock project prompt", { status: 422 })
    }
    if (next && offered.length === 0) {
      // OpenCode can request a title in parallel without including any tool definitions.
      next = undefined
      completion = "Bashwink VM fixture"
    }
    if (next && !offered.some((item) => item.function.name === next.tool))
      return new Response("expected fixture tool unavailable", { status: 422 })
    if (next) console.log(isProject ? `BW_VM_PROJECT_TOOL_${step}` : `BW_VM_TOOL_${step}`)

    const chunk = (delta: object, finish: string | null = null) => ({
      id: `chatcmpl-vm-${step}`,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
    const action =
      next === undefined
        ? chunk({ content: completion })
        : chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_vm_${step}`,
                type: "function",
                function: { name: next.tool, arguments: JSON.stringify(next.args) },
              },
            ],
          })
    const frames = [
      chunk({ role: "assistant", content: "" }),
      action,
      chunk({}, next === undefined ? "stop" : "tool_calls"),
    ]
    return new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
