import { expect, test } from "bun:test"
import { validateVmSnapshot } from "../src/vm-project.js"

const token = "583ac076-7196-4c56-8af8-099829254ff8"
const bytes = Buffer.from("editable fixture\n").toString("base64")
const snapshot = {
  token,
  files: { "file.ts": bytes },
  state: {},
  sessions: ["ses_fixture"],
}

test("a VM checkpoint accepts only its launch identity and unique session IDs", () => {
  expect(validateVmSnapshot(snapshot, token)).toEqual(snapshot)
  expect(() => validateVmSnapshot(snapshot, "another-launch")).toThrow("checkpoint identity")
  expect(() =>
    validateVmSnapshot({ ...snapshot, sessions: ["ses_fixture", "ses_fixture"] }),
  ).toThrow("checkpoint identity")
})

test("VM checkpoints reject out-of-scope paths, aliases and invalid project bytes", () => {
  for (const files of [
    { "../outside.ts": bytes },
    { "secret.txt": bytes },
    { "two.ts": bytes, "Two.ts": bytes },
    { "two.ts": "???not base64" },
  ])
    expect(() => validateVmSnapshot({ ...snapshot, files })).toThrow()
})

test("VM checkpoints never restore old readiness state", () => {
  expect(() =>
    validateVmSnapshot({
      ...snapshot,
      state: { "bashwink/data/scopes/.readiness-fixture/ready.json": bytes },
    }),
  ).toThrow("disallowed VM checkpoint path")
})
