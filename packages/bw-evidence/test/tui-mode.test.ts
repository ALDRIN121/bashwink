import { expect, test } from "bun:test"
import { modeLabel } from "../src/tui-mode.ts"

test("each launcher-reported mode has its own wording and never claims isolation it lacks", () => {
  expect(modeLabel("isolated-vm").indicator).toBe("SANDBOXED VM")
  expect(modeLabel("unrestricted-host").indicator).toBe("UNSAFE LOCAL MODE")
  expect(modeLabel("development-host").indicator).toContain("NOT ISOLATED")
  expect(modeLabel("unrestricted-host").variant).toBe("warning")
})

test("a missing, empty or unexpected mode is reported as unknown, never as isolated", () => {
  for (const mode of [undefined, "", "vm", "ISOLATED-VM", "constructor", "__proto__", "toString"]) {
    const label = modeLabel(mode)
    expect(label.indicator).toBe("EXECUTION MODE UNKNOWN")
    expect(label.indicator).not.toContain("SANDBOXED")
    expect(label.variant).toBe("warning")
  }
})
