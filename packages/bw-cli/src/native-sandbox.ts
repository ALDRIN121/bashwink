// First native milestone: a disposable, offline policy probe. Agent admission is separate.
import { createHash, randomUUID } from "node:crypto"
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { release } from "node:os"
import path from "node:path"
import { PINNED_RUNTIME_VERSION } from "./runtime.js"

export const SEATBELT = "/usr/bin/sandbox-exec"

// Bind canonical, host-created paths with Seatbelt parameters. The profile never grants
// project-supplied allow rules, general network access or writes to the executable.
export const PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.osproductversion")
                   (sysctl-name "kern.osrelease"))
(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/cat")
                    (literal "/usr/bin/nc") (literal (param "RUNTIME")))
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom")
                  (literal "/bin") (literal "/usr") (literal "/usr/bin")
                  (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/cat")
                  (literal "/usr/bin/nc") (literal (param "RUNTIME"))
                  (subpath "/System/Library") (subpath "/usr/lib")
                  (subpath "/usr/share/icu") (subpath "/usr/share/zoneinfo")
                  (subpath "/private/var/db/timezone")
                  (subpath (param "WORK")) (subpath (param "SCRATCH")))
(allow file-read-metadata (literal "/private") (literal "/private/tmp") (literal "/dev")
                          (literal (param "ROOT")))
(allow file-write* (literal "/dev/null")
                   (subpath (param "WORK")) (subpath (param "SCRATCH")))
(deny network*)
`

function digest(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function execute(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const stop = setTimeout(() => child.kill("SIGKILL"), 4_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(stop)
  }
}

export interface SandboxCheck {
  readonly id: string
  readonly verdict: "PASS" | "FAIL" | "NOT_RUN"
  readonly exitCode?: number
  readonly observed: string
}

export async function probeNativeSandbox(runtimePath?: string) {
  const status = {
    backend: process.platform === "darwin" ? "seatbelt-probe" : "unavailable",
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    runId: randomUUID(),
    helperDigest: undefined as string | undefined,
    runtimeDigest: undefined as string | undefined,
    policyDigest: digest(PROFILE),
    checks: [] as SandboxCheck[],
  }
  const report = (exitCode: number, stage: string, detail?: string) => ({
    exitCode,
    report: { ...status, stage, detail },
  })
  if (process.platform !== "darwin")
    return report(1, "platform", "the native probe currently requires macOS Seatbelt")
  let root: string | undefined
  let closeListener: (() => void) | undefined
  let stage = "helper"
  try {
    accessSync(SEATBELT, constants.X_OK)
    status.helperDigest = digest(readFileSync(SEATBELT))
    stage = "stage"
    // Ignore an inherited TMPDIR. The fixture data and executable live under a private root.
    root = realpathSync(mkdtempSync(path.join("/private/tmp", "bw-native-probe-")))
    const work = path.join(root, "work")
    const scratch = path.join(root, "scratch")
    const runtime = path.join(root, "opencode")
    mkdirSync(work, { mode: 0o700 })
    mkdirSync(scratch, { mode: 0o700 })
    const canary = path.join(root, "protected")
    const link = path.join(work, "outside-link")
    const output = path.join(work, "output")
    writeFileSync(canary, "Bashwink synthetic protected fixture\n", { mode: 0o600 })
    symlinkSync(canary, link)
    const before = lstatSync(canary)
    const beforeDigest = digest(readFileSync(canary))
    const env = {
      HOME: scratch,
      TMPDIR: scratch,
      XDG_CONFIG_HOME: path.join(scratch, "config"),
      XDG_DATA_HOME: path.join(scratch, "data"),
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      XDG_STATE_HOME: path.join(scratch, "state"),
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    }
    const seatbelt = [
      SEATBELT,
      "-D",
      `ROOT=${root}`,
      "-D",
      `WORK=${work}`,
      "-D",
      `SCRATCH=${scratch}`,
      "-D",
      `RUNTIME=${runtime}`,
      "-p",
      PROFILE,
    ]
    const run = (argv: string[]) => execute([...seatbelt, ...argv], work, env)
    const stable = () => {
      const after = lstatSync(canary)
      return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        beforeDigest === digest(readFileSync(canary))
      )
    }
    const check = (id: string, good: boolean, exitCode: number, observed: string) => {
      status.checks.push({ id, verdict: good ? "PASS" : "FAIL", exitCode, observed })
    }
    stage = "workspace"
    const allowed = await run([
      "/bin/sh",
      "-c",
      'printf "%s" probe > "$1" && /bin/cat "$1"',
      "probe",
      output,
    ])
    const wrote =
      allowed.exitCode === 0 &&
      allowed.stdout === "probe" &&
      readFileSync(output, "utf8") === "probe"
    check(
      "workspace-write-read",
      wrote,
      allowed.exitCode,
      wrote ? "staged output read and verified" : "confined positive control failed",
    )
    if (!wrote) return report(1, stage, "Seatbelt did not complete the confined positive control")
    stage = "filesystem"
    const refused = /Operation not permitted|Permission denied/
    for (const [id, argv] of [
      ["outside-child-read", ["/bin/sh", "-c", '/bin/cat "$1"; exit $?', "probe", canary]],
      ["outside-write", ["/bin/sh", "-c", 'printf "%s" fixture > "$1"', "probe", canary]],
      ["symlink-write", ["/bin/sh", "-c", 'printf "%s" fixture > "$1"', "probe", link]],
    ] as const) {
      const result = await run([...argv])
      const good =
        result.exitCode === 1 && refused.test(result.stderr) && result.stdout === "" && stable()
      check(
        id,
        good,
        result.exitCode,
        good
          ? "OS denial with unchanged host file hash and identity"
          : "denial or host file integrity unverified",
      )
    }

    stage = "network"
    let connections = 0
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          connections++
          socket.end()
        },
        data() {},
      },
    })
    closeListener = () => listener.stop(true)
    const connect = ["/usr/bin/nc", "-v", "-z", "-w", "1", "127.0.0.1", String(listener.port)]
    const baseline = await execute(connect, work, env)
    const seen = connections === 1
    const blocked = await run(connect)
    const network =
      baseline.exitCode === 0 &&
      seen &&
      blocked.exitCode === 1 &&
      refused.test(blocked.stderr) &&
      connections === 1
    check(
      "tcp-loopback-denied",
      network,
      blocked.exitCode,
      network
        ? "host control connected once; sandboxed attempt received OS denial and never reached listener"
        : "positive control or OS denial did not match the expected result",
    )

    stage = "runtime-version"
    if (runtimePath === undefined) {
      status.checks.push({
        id: stage,
        verdict: "NOT_RUN",
        observed: "no explicit BASHWINK_OPENCODE_BIN supplied",
      })
    } else {
      if (!path.isAbsolute(runtimePath) || !statSync(runtimePath).isFile())
        return report(1, stage, "BASHWINK_OPENCODE_BIN must name an absolute trusted native binary")
      copyFileSync(runtimePath, runtime, constants.COPYFILE_EXCL)
      chmodSync(runtime, 0o500)
      const binary = readFileSync(runtime)
      // The package-manager JavaScript shim can spawn a distinct process and resolve
      // additional files. This check uses the staged native Mach-O executable only.
      if (
        binary.length < 4 ||
        !["cffaedfe", "feedfacf", "cafebabe", "cafebabf"].includes(
          binary.subarray(0, 4).toString("hex"),
        )
      )
        return report(
          1,
          stage,
          "BASHWINK_OPENCODE_BIN must point to the real Mach-O OpenCode executable",
        )
      const result = await run([runtime, "--version"])
      status.runtimeDigest = digest(binary)
      const correct =
        result.exitCode === 0 && result.stdout.trim() === `opencode v${PINNED_RUNTIME_VERSION}`
      check(
        stage,
        correct,
        result.exitCode,
        `${correct ? "verified pinned OpenCode version" : "pinned OpenCode version unverified"}; sha256=${digest(binary)}`,
      )
    }
    return status.checks.some((item) => item.verdict === "FAIL")
      ? report(1, "checks", "one or more actual OS controls failed")
      : report(0, "probe-complete")
  } catch (error) {
    // Child or runtime output can carry user-controlled data. Print only stage and error class.
    return report(1, stage, error instanceof Error ? error.name : "probe error")
  } finally {
    closeListener?.()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
}
