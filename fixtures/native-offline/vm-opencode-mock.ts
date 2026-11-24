// Disposable guest-only provider. It has no upstream destination or credentials.
type Message = { role: string }
type Tool = { function: { name: string } }

Bun.serve({
  hostname: "127.0.0.1",
  port: 8117,
  async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/healthz") return new Response("ok")
    if (route !== "/v1/chat/completions" || request.method !== "POST")
      return new Response(null, { status: 404 })
    const body = (await request.json()) as { messages: Message[]; tools: Tool[]; model: string }
    if (JSON.stringify(body.messages).includes("Crash the disposable VM runtime")) {
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
    const step = body.messages.filter((message) => message.role === "tool").length
    const tool = step === 0 ? "write" : "shell"
    const args =
      step === 0 ? { path: "task.txt", content: "VM fixture edit\n" } : { command: "sh check.sh" }
    if (step < 2 && !body.tools.some((item) => item.function.name === tool))
      return new Response("expected fixture tool unavailable", { status: 422 })
    if (step < 2) console.log(`BW_VM_TOOL_${step}`)

    const chunk = (delta: object, finish: string | null = null) => ({
      id: `chatcmpl-vm-${step}`,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
    const action =
      step >= 2
        ? chunk({ content: "VM fixture tool sequence completed" })
        : chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_vm_${step}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          })
    const frames = [
      chunk({ role: "assistant", content: "" }),
      action,
      chunk({}, step >= 2 ? "stop" : "tool_calls"),
    ]
    return new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
