import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { validateAssets } from "../src/offline-vm.js"
import {
  AcknowledgmentError,
  StartupError,
  UNRESTRICTED_PHRASE,
  acknowledgeUnrestricted,
  judgeHost,
  parseQualifiedHosts,
  recordStartupFailure,
  type AcknowledgmentIO,
  type HostFacts,
} from "../src/release.js"
import { readTrust } from "../src/trust.js"
import { requireWorkspaceApproval, type ApprovalSummary } from "../src/workspace-approval.js"

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-release-mode-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const lab: HostFacts = { platform: "darwin", arch: "arm64", osVersion: "27.0.1", osBuild: "26A434" }
const qualified = [{ version: "27.0.1", build: "26A434" }]

describe("host qualification", () => {
  test("accepts exactly a qualified macOS build on Apple Silicon", () => {
    expect(judgeHost(lab, qualified).supported).toBe(true)
  })
  test("refuses other macOS builds, architectures and operating systems", () => {
    for (const facts of [
      { ...lab, osBuild: "26A435" },
      { ...lab, osVersion: "27.0.2" },
      { ...lab, arch: "x64" },
      { ...lab, platform: "linux" },
      { ...lab, platform: "win32" },
      { ...lab, osVersion: undefined },
      { ...lab, osBuild: undefined },
    ]) {
      const verdict = judgeHost(facts, qualified)
      expect(verdict.supported).toBe(false)
      expect(verdict.reason.length).toBeGreaterThan(20)
    }
  })
  test("an empty qualified list supports nothing", () => {
    const verdict = judgeHost(lab, [])
    expect(verdict.supported).toBe(false)
    expect(verdict.reason).toContain("no qualified macOS builds")
  })
  test("qualified list parsing rejects malformed entries", () => {
    expect(parseQualifiedHosts(undefined)).toEqual([])
    expect(parseQualifiedHosts('[{"version":"27.0.1","build":"26A434"}]')).toEqual(qualified)
    expect(() => parseQualifiedHosts('{"version":"x"}')).toThrow()
    expect(() => parseQualifiedHosts('[{"version":1}]')).toThrow()
  })
})

function terminal(answers: (string | null)[], interactive = true) {
  const written: string[] = []
  const prompts: string[] = []
  const io: AcknowledgmentIO = {
    interactive,
    write: (text) => void written.push(text),
    readLine: (message) => {
      prompts.push(message)
      return answers.shift() ?? null
    },
  }
  return { io, written, prompts }
}

describe("unrestricted-mode acknowledgment", () => {
  test("a non-interactive launch is refused without prompting", () => {
    const t = terminal([UNRESTRICTED_PHRASE], false)
    expect(() => acknowledgeUnrestricted(t.io)).toThrow(AcknowledgmentError)
    expect(t.prompts).toEqual([])
  })
  test("anything but the exact phrase is refused", () => {
    for (const answer of [
      "y",
      "yes",
      "",
      "i accept host access",
      "I accept host access please",
      null,
    ]) {
      expect(() => acknowledgeUnrestricted(terminal([answer]).io)).toThrow(AcknowledgmentError)
    }
  })
  test("the typed phrase passes, after the risks were displayed", () => {
    const t = terminal([`  ${UNRESTRICTED_PHRASE}  `])
    acknowledgeUnrestricted(t.io)
    const shown = t.written.join("")
    expect(shown).toContain("same access you have")
    expect(shown).toContain("credentials")
    expect(shown).toContain("Existing approvals and hard denials still apply")
  })
})

describe("workspace approval", () => {
  const summary = (workspace: string): ApprovalSummary => ({
    workspace,
    included: [{ name: "a.ts", bytes: 12 }],
    notStaged: 3,
    provider: "commandcode",
    model: "commandcode/claude-sonnet-5",
    maxRequests: 8,
  })
  const setup = () => {
    const config = mkdtempSync(path.join(root, "cfg-"))
    const workspace = mkdtempSync(path.join(root, "ws-"))
    return { config, workspace }
  }
  test("non-interactive launch in an unapproved project is refused", () => {
    const { config, workspace } = setup()
    const t = terminal(["y"], false)
    expect(() =>
      requireWorkspaceApproval({
        configDirectory: config,
        summary: summary(workspace),
        io: t.io,
        user: "u",
      }),
    ).toThrow(StartupError)
    expect(readTrust(path.join(config, "trust.json")).workspaces).toEqual([])
  })
  test("declining records nothing", () => {
    const { config, workspace } = setup()
    for (const answer of ["", "n", "no", null]) {
      expect(() =>
        requireWorkspaceApproval({
          configDirectory: config,
          summary: summary(workspace),
          io: terminal([answer]).io,
          user: "u",
        }),
      ).toThrow(StartupError)
    }
    expect(existsSync(path.join(config, "trust.json"))).toBe(false)
  })
  test("approval shows what is copied and what leaves the machine, then is remembered", () => {
    const { config, workspace } = setup()
    const t = terminal(["y"])
    expect(
      requireWorkspaceApproval({
        configDirectory: config,
        summary: summary(workspace),
        io: t.io,
        user: "dev",
      }),
    ).toBe("granted")
    const shown = t.written.join("")
    expect(shown).toContain("a.ts (12 bytes)")
    expect(shown).toContain("commandcode")
    expect(shown).toContain("8 requests")
    expect(shown).toContain("Your project changes only when you review and apply them")
    const trust = readTrust(path.join(config, "trust.json"))
    expect(trust.workspaces).toHaveLength(1)
    expect(trust.workspaces[0]!.grantedBy).toBe("interactive:dev")
    // Already approved: no terminal needed any more.
    expect(
      requireWorkspaceApproval({
        configDirectory: config,
        summary: summary(workspace),
        io: terminal([], false).io,
        user: "dev",
      }),
    ).toBe("already")
  })
})

describe("startup failure record", () => {
  test("appends private JSON lines and never throws", () => {
    const data = path.join(root, "data")
    expect(
      recordStartupFailure(
        data,
        { code: "vm-assets-missing", mode: "isolated-vm", message: "x" },
        () => new Date(0),
      ),
    ).toBe(true)
    recordStartupFailure(data, { code: "unsupported-host", mode: "isolated-vm", message: "y" })
    const lines = readFileSync(path.join(data, "startup-failures.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: 1,
      code: "vm-assets-missing",
      at: "1970-01-01T00:00:00.000Z",
    })
    // An unwritable location reports false instead of masking the launch error.
    expect(
      recordStartupFailure("/dev/null/nope", {
        code: "vm-init-failed",
        mode: "isolated-vm",
        message: "z",
      }),
    ).toBe(false)
  })
})

describe("release asset validation", () => {
  function install(options: { relay?: boolean; version?: number } = {}) {
    const lib = mkdtempSync(path.join(root, "lib-"))
    chmodSync(lib, 0o700)
    const assets = path.join(lib, "offline-vm")
    mkdirSync(assets, { mode: 0o700 })
    const contents = { "vm-owner": "#!/bin/sh\nexit 0\n", Image: "kernel", initramfs: "initrd" }
    for (const [name, data] of Object.entries(contents)) {
      writeFileSync(path.join(assets, name), data, { mode: name === "vm-owner" ? 0o700 : 0o600 })
    }
    const manifest = JSON.stringify({
      version: options.version ?? 2,
      ...(options.relay === false ? {} : { relay: true }),
      sha256: Object.fromEntries(Object.entries(contents).map(([name, data]) => [name, sha(data)])),
    })
    writeFileSync(path.join(lib, "offline-vm.json"), manifest)
    return { lib, assets, digest: sha(manifest) }
  }
  const validate = (lib: string, digest: string | undefined) =>
    validateAssets(lib, { release: true, expectedManifest: digest })
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(StartupError)
      return error as StartupError
    }
    throw new Error("expected a startup failure")
  }

  test("a pristine installation validates", async () => {
    const { lib, digest } = install()
    const result = await validate(lib, digest)
    expect(result.relay).toBe(true)
    expect(result.profile).toBe(digest)
  })
  test("a missing manifest is reported as missing assets with the way out", async () => {
    const lib = mkdtempSync(path.join(root, "empty-"))
    const error = await failure(validate(lib, sha("x")))
    expect(error.code).toBe("vm-assets-missing")
    expect(error.message).toContain("install.sh")
  })
  test("a build without a pinned digest refuses every installation", async () => {
    const { lib } = install()
    expect((await failure(validate(lib, undefined))).code).toBe("vm-assets-corrupt")
  })
  test("a manifest edited after the build is refused even when it is self-consistent", async () => {
    const { lib, assets } = install()
    const originalDigest = sha(readFileSync(path.join(lib, "offline-vm.json")))
    writeFileSync(path.join(assets, "Image"), "evil kernel")
    const manifest = JSON.parse(readFileSync(path.join(lib, "offline-vm.json"), "utf8"))
    manifest.sha256.Image = sha("evil kernel")
    writeFileSync(path.join(lib, "offline-vm.json"), JSON.stringify(manifest))
    expect((await failure(validate(lib, originalDigest))).code).toBe("vm-assets-corrupt")
  })
  test("a modified asset is refused", async () => {
    for (const name of ["vm-owner", "Image", "initramfs"]) {
      const { lib, assets, digest } = install()
      writeFileSync(path.join(assets, name), "tampered", {
        mode: name === "vm-owner" ? 0o700 : 0o600,
      })
      const error = await failure(validate(lib, digest))
      expect(error.code).toBe("vm-assets-corrupt")
      expect(error.message).toContain(name)
    }
  })
  test("a deleted asset or asset directory is reported as missing", async () => {
    const one = install()
    rmSync(path.join(one.assets, "initramfs"))
    expect((await failure(validate(one.lib, one.digest))).code).toBe("vm-assets-missing")
    const two = install()
    rmSync(two.assets, { recursive: true })
    expect((await failure(validate(two.lib, two.digest))).code).toBe("vm-assets-missing")
  })
  test("a symlinked asset directory is refused", async () => {
    const { lib, assets, digest } = install()
    const elsewhere = path.join(lib, "elsewhere")
    mkdirSync(elsewhere, { mode: 0o700 })
    for (const name of ["vm-owner", "Image", "initramfs"])
      writeFileSync(path.join(elsewhere, name), readFileSync(path.join(assets, name)), {
        mode: 0o700,
      })
    rmSync(assets, { recursive: true })
    symlinkSync(elsewhere, assets)
    expect((await failure(validate(lib, digest))).code).toBe("vm-assets-corrupt")
  })
  test("group- or world-writable asset locations are refused", async () => {
    const one = install()
    chmodSync(one.assets, 0o775)
    expect((await failure(validate(one.lib, one.digest))).code).toBe("vm-assets-corrupt")
    const two = install()
    chmodSync(path.join(two.assets, "Image"), 0o666)
    expect((await failure(validate(two.lib, two.digest))).code).toBe("vm-assets-corrupt")
    const three = install()
    chmodSync(three.lib, 0o777)
    expect((await failure(validate(three.lib, three.digest))).code).toBe("vm-assets-corrupt")
  })
  test("a hard-linked asset is refused", async () => {
    const { lib, assets, digest } = install()
    const link = path.join(root, `link-${Math.random()}`)
    require("node:fs").linkSync(path.join(assets, "Image"), link)
    expect((await failure(validate(lib, digest))).code).toBe("vm-assets-corrupt")
  })
  test("an image without the provider relay, or an old manifest version, is refused", async () => {
    const one = install({ relay: false })
    expect((await failure(validate(one.lib, one.digest))).code).toBe("vm-assets-corrupt")
    const two = install({ version: 1 })
    expect((await failure(validate(two.lib, two.digest))).code).toBe("vm-assets-corrupt")
  })
  test("malformed manifests are refused", async () => {
    const { lib } = install()
    writeFileSync(path.join(lib, "offline-vm.json"), "{not json")
    expect((await failure(validate(lib, sha("{not json")))).code).toBe("vm-assets-corrupt")
  })
})

describe("release bundle process behavior", () => {
  let entry: string
  let marker: string
  const home = path.join(root, "bundle-home")

  beforeAll(() => {
    entry = path.join(root, "bundle", "lib", "bashwink.js")
    mkdirSync(path.dirname(entry), { recursive: true })
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        path.join(import.meta.dir, "../src/bin.ts"),
        "--target=bun",
        "--define",
        "__BASHWINK_RELEASE__=true",
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
      env: {
        PATH: process.env["PATH"]!,
        HOME: root,
        BASHWINK_HOME: home,
        BASHWINK_OPENCODE_BIN: path.join(root, "runtime"),
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
    })
  const failures = () => {
    const file = path.join(home, "data", "startup-failures.jsonl")
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { code: string; mode: string })
      : []
  }

  test("a bundle with no qualified hosts cannot start the VM, says why, and records it", () => {
    const result = run([])
    expect(result.exitCode).toBe(3)
    // On macOS arm64 the empty list is the reason; elsewhere the platform itself is.
    expect(result.stderr.toString()).toContain(
      process.platform === "darwin" && process.arch === "arm64"
        ? "no qualified macOS builds"
        : "macOS on Apple Silicon only",
    )
    expect(result.stderr.toString()).toContain(
      "No model request was made and no tool was dispatched.",
    )
    expect(failures().at(-1)).toMatchObject({ code: "unsupported-host", mode: "isolated-vm" })
    expect(existsSync(marker)).toBe(false)
  })

  test("environment cannot select the host, a provider or a different mode", () => {
    for (const environment of [
      { BASHWINK_BACKEND: "local" },
      { BASHWINK_BACKEND: "unrestricted-host" },
      { BASHWINK_VM_PROVIDER: "anything" },
      { BASHWINK_BACKEND: "vm", BASHWINK_OPENCODE_BIN: path.join(root, "runtime") },
    ]) {
      for (const args of [
        [],
        ["--continue"],
        ["--session", "ses_abc"],
        ["run", "hello"],
        ["--model", "x/y"],
        ["-p", "x"],
      ]) {
        const result = run(args, environment)
        expect(result.exitCode).toBe(3)
        expect(existsSync(marker)).toBe(false)
      }
    }
  })

  test("a bundle that does not list this Mac's real OS build refuses it, naming build and qualified list", () => {
    const other = path.join(root, "other-qualified", "lib", "bashwink.js")
    mkdirSync(path.dirname(other), { recursive: true })
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        path.join(import.meta.dir, "../src/bin.ts"),
        "--target=bun",
        "--define",
        "__BASHWINK_RELEASE__=true",
        "--define",
        `__BASHWINK_QUALIFIED_HOSTS__=${JSON.stringify(JSON.stringify([{ version: "26.9.9", build: "ZZZ99" }]))}`,
        "--outfile",
        other,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode).toBe(0)
    const result = Bun.spawnSync({
      cmd: [process.execPath, other],
      env: { PATH: process.env["PATH"]!, HOME: root, BASHWINK_HOME: path.join(root, "other-home") },
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
    })
    const message = result.stderr.toString()
    expect(result.exitCode).toBe(3)
    expect(message).toContain("No model request was made and no tool was dispatched.")
    if (process.platform === "darwin" && process.arch === "arm64") {
      // The real host facts, read from this machine, are judged against the bundle's own list.
      const version = Bun.spawnSync({
        cmd: ["/usr/bin/sw_vers", "-productVersion"],
        stdout: "pipe",
      })
        .stdout.toString()
        .trim()
      const osBuild = Bun.spawnSync({
        cmd: ["/usr/sbin/sysctl", "-n", "kern.osversion"],
        stdout: "pipe",
      })
        .stdout.toString()
        .trim()
      expect(message).toContain(`macOS ${version} (${osBuild}) is not a qualified host`)
      expect(message).toContain("Qualified: 26.9.9 (ZZZ99)")
    } else {
      expect(message).toContain("macOS on Apple Silicon only")
    }
    expect(existsSync(marker)).toBe(false)
  })

  test("a host invocation inside VM mode is refused as unsupported", () => {
    const before = failures().length
    const result = run(["run", "hello"])
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString()).toContain("--unsafe-local")
    expect(failures().length).toBe(before + 1)
    expect(failures().at(-1)).toMatchObject({ code: "unsupported-invocation" })
  })

  test("development sandbox experiments are not part of the release", () => {
    for (const args of [
      ["sandbox", "probe"],
      ["sandbox", "offline", "1", "--stage-file"],
      ["sandbox", "export", "x"],
    ]) {
      const result = run(args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain("not part of release builds")
    }
    expect(existsSync(marker)).toBe(false)
  })

  test("--unsafe-local must lead, and cannot be satisfied without a terminal", () => {
    expect(run(["--continue", "--unsafe-local"]).exitCode).toBe(2)
    const result = run(["--unsafe-local", "run", "hello"])
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString()).toContain("acknowledgment")
    expect(failures().at(-1)).toMatchObject({
      code: "acknowledgment-required",
      mode: "unrestricted-host",
    })
    expect(existsSync(marker)).toBe(false)
  })

  test("version and help work without any VM", () => {
    expect(run(["--version"]).exitCode).toBe(0)
    expect(run(["--help"]).exitCode).toBe(0)
  })
})
