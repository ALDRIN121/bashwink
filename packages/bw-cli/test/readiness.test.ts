import { expect, test } from "bun:test"
import { parsePrivateEndpoint, matchesReadiness } from "../src/private-server.js"

test("only a bare HTTP address on the owned IPv4 loopback listener is accepted", () => {
  expect(parsePrivateEndpoint('{"url":"http://127.0.0.1:32123"}')).toBe("http://127.0.0.1:32123")
  for (const url of [
    "http://localhost:32123",
    "http://127.0.0.1:32123/admin",
    "http://user@127.0.0.1:32123",
    "https://127.0.0.1:32123",
    "http://127.0.0.1",
  ]) {
    expect(() => parsePrivateEndpoint(JSON.stringify({ url }))).toThrow()
  }
})

test("an acknowledgement is only valid for the exact launch, server pid and workspace", () => {
  const expected = { v: 1, runId: "run_new", nonce: "fresh", pid: 321, workspace: "/approved" }
  expect(matchesReadiness(expected, expected)).toBe(true)
  for (const wrong of [
    { ...expected, nonce: "old" },
    { ...expected, pid: 320 },
    { ...expected, workspace: "/other" },
    { ...expected, runId: "run_previous" },
    { ...expected, v: 0 },
    { runId: expected.runId },
    null,
  ])
    expect(matchesReadiness(wrong, expected)).toBe(false)
})
