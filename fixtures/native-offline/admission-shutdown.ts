import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { startAdmission } from "../../packages/bw-cli/src/session-admission.js"

const workspace = realpathSync(process.cwd())
const lookup = Promise.withResolvers<void>()
const finishLookup = Promise.withResolvers<void>()
let toolRequests = 0
let accepting = true
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "GET") {
      lookup.resolve()
      await finishLookup.promise
      return Response.json({ data: { location: { directory: workspace } } })
    }
    toolRequests++
    return Response.json({})
  },
})
const gateway = startAdmission(
  upstream.url.origin,
  "fixture-upstream",
  "fixture-client",
  workspace,
  async () => accepting,
)
const submit = () =>
  fetch(gateway.url.origin + "/api/session/ses_fixture/prompt", {
    method: "POST",
    headers: { Authorization: "fixture-client" },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  })
try {
  const pending = submit()
  await Promise.race([
    lookup.promise,
    Bun.sleep(2_000).then(() => {
      throw new Error("no session lookup")
    }),
  ])
  accepting = false
  finishLookup.resolve()
  assert.equal((await pending).status, 403)
  assert.equal((await submit()).status, 403)
  assert.equal(toolRequests, 0)
  console.log("PASS: shutdown denied both a pending and a new tool-dispatch request")
} finally {
  finishLookup.resolve()
  await gateway.stop(true)
  await upstream.stop(true)
}
