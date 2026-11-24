import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readTrust } from "../src/trust.js"
import { offerWorkspaceTrust } from "../src/workspace-approval.js"
import type { AcknowledgmentIO } from "../src/release.js"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-standard-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("standard bundle", () => {
  let entry: string
  let marker: string
  const home = path.join(root, "home")

  beforeAll(() => {
    entry = path.join(root, "bundle", "bashwink.js")
    mkdirSync(path.dirname(entry), { recursive: true })
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        path.join(import.meta.dir, "../src/bin.ts"),
        "--target=bun",
        "--define",
        "__BASHWINK_STANDARD__=true",
        "--outfile",
        entry,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode).toBe(0)
    marker = path.join(root, "runtime-started")
    writeFileSync(path.join(root, "runtime"), `#!/bin/sh\necho started > "${marker}"\n`, {
      mode: 0o700,
    })
  })

  const run = (args: string[], environment: Record<string, string> = {}) =>
    Bun.spawnSync({
      cmd: [process.execPath, entry, ...args],
      env: { PATH: process.env["PATH"]!, HOME: root, BASHWINK_HOME: home, ...environment },
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
    })

  test("--sandbox fails closed: nothing runs natively and the failure is recorded", () => {
    const result = run(["--sandbox"], { BASHWINK_OPENCODE_BIN: path.join(root, "runtime") })
    expect(result.exitCode).toBe(3)
    const message = result.stderr.toString()
    expect(message).toContain("sandbox mode is not installed")
    expect(message).toContain("will not start")
    expect(message).toContain("not an operating-system sandbox")
    expect(existsSync(marker)).toBe(false)
    const log = readFileSync(path.join(home, "data", "startup-failures.jsonl"), "utf8")
      .trim()
      .split("\n")
    expect(JSON.parse(log.at(-1)!)).toMatchObject({ code: "sandbox-unavailable" })
  })

  test("--sandbox is refused wherever it appears among the arguments", () => {
    for (const args of [
      ["run", "--sandbox", "hi"],
      ["--continue", "--sandbox"],
    ]) {
      expect(run(args, { BASHWINK_OPENCODE_BIN: path.join(root, "runtime") }).exitCode).toBe(3)
    }
    expect(existsSync(marker)).toBe(false)
  })

  test("the environment cannot select the VM or another backend", () => {
    for (const environment of [
      { BASHWINK_BACKEND: "vm" },
      { BASHWINK_BACKEND: "native" },
      { BASHWINK_BACKEND: "unrestricted-host" },
      { BASHWINK_VM_PROVIDER: "anything" },
    ]) {
      const result = run(["backend"], environment)
      expect(result.exitCode).toBe(0)
      const capabilities = JSON.parse(result.stdout.toString())
      expect(capabilities.mode).toBe("standard-native")
      expect(capabilities.filesystemIsolation).toBe(false)
      expect(capabilities.processIsolation).toBe(false)
    }
  })

  test("the runtime must be supplied by the launcher, never discovered on PATH", () => {
    writeFileSync(path.join(root, "opencode"), `#!/bin/sh\necho started > "${marker}"\n`, {
      mode: 0o700,
    })
    const result = run(["run", "hello"], { PATH: `${root}:${process.env["PATH"]!}` })
    expect(result.exitCode).toBe(127)
    expect(result.stderr.toString()).toContain("pinned OpenCode runtime was not provided")
    expect(existsSync(marker)).toBe(false)
  })

  test("sandbox subcommands are not part of the standard package", () => {
    const result = run(["sandbox", "vm-review"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("optional sandbox component")
  })

  test("version and help work", () => {
    expect(run(["--version"]).exitCode).toBe(0)
    expect(run(["--help"]).exitCode).toBe(0)
  })
})

describe("first-run trust offer", () => {
  const io = (answers: (string | null)[], interactive = true) => {
    const written: string[] = []
    const value: AcknowledgmentIO = {
      interactive,
      write: (text) => void written.push(text),
      readLine: () => answers.shift() ?? null,
    }
    return { value, written }
  }
  const setup = () => ({
    config: mkdtempSync(path.join(root, "cfg-")),
    workspace: mkdtempSync(path.join(root, "ws-")),
  })

  test("never asks without a terminal and never answers for the user", () => {
    const { config, workspace } = setup()
    const t = io(["y"], false)
    expect(
      offerWorkspaceTrust({ configDirectory: config, workspace, io: t.value, user: "u" }),
    ).toBe("not-asked")
    expect(existsSync(path.join(config, "trust.json"))).toBe(false)
  })

  test("a refusal is allowed and records nothing; the session continues read-only", () => {
    const { config, workspace } = setup()
    for (const answer of ["", "n", "no", null]) {
      expect(
        offerWorkspaceTrust({
          configDirectory: config,
          workspace,
          io: io([answer]).value,
          user: "u",
        }),
      ).toBe("declined")
    }
    expect(existsSync(path.join(config, "trust.json"))).toBe(false)
  })

  test("the question states what standard mode is and is not, then the answer is remembered", () => {
    const { config, workspace } = setup()
    const t = io(["y"])
    expect(
      offerWorkspaceTrust({ configDirectory: config, workspace, io: t.value, user: "dev" }),
    ).toBe("granted")
    const shown = t.written.join("")
    expect(shown).toContain("NOT a sandbox")
    expect(shown).toContain("ask each time")
    expect(shown).toContain("sent to your configured model provider")
    expect(readTrust(path.join(config, "trust.json")).workspaces[0]!.grantedBy).toBe(
      "interactive:dev",
    )
    expect(
      offerWorkspaceTrust({
        configDirectory: config,
        workspace,
        io: io([], false).value,
        user: "dev",
      }),
    ).toBe("already")
  })
})
