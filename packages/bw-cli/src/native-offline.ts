import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { executionTimeout, makeBackend, runWithBackend } from "./execution-backend.js"
import { execute, PROFILE, SEATBELT } from "./native-sandbox.js"
import { newRunId } from "./run-health.js"
import { PINNED_RUNTIME_VERSION } from "./runtime.js"
import { snapshotDestination } from "./native-export.js"
import {
  captureEvidence,
  directoryIdentity,
  lockStage,
  newStageState,
  readStage,
  regularFile,
  selectSavedSession,
  SESSION_ID,
  sha256,
  STAGED_FILE,
  writeStage,
} from "./native-stage.js"

export const OFFLINE_USAGE =
  "usage: bashwink sandbox offline <mock-port> [--stage-file | --stage <path> (--continue | --session <id>)]"

const OFFLINE_RULES = `
  (allow file-read* (subpath (param "PLUGIN")) (subpath (param "CONFIG"))
                    (literal (param "SCOPE")) (literal "/dev/tty"))
  (allow file-ioctl (literal "/dev/tty") (literal (param "TTY")))
`
const RECOVERY_RULES = `
  (deny process-fork)
  (deny process-exec (literal "/bin/sh") (literal "/bin/bash")
                     (literal "/bin/cat") (literal "/usr/bin/nc"))
`

export function parseOffline(argv: readonly string[]) {
  const [portText, flag, stage, selection, requested] = argv
  if (
    portText === undefined ||
    !/^\d{1,5}$/.test(portText) ||
    +portText < 1024 ||
    +portText > 65535
  )
    throw new Error(OFFLINE_USAGE)
  const mockPort = +portText
  if (argv.length === 1 || (argv.length === 2 && flag === "--stage-file"))
    return { mockPort, stageFile: flag === "--stage-file" }
  if (
    flag === "--stage" &&
    stage !== undefined &&
    ((selection === "--continue" && argv.length === 4) ||
      (selection === "--session" &&
        argv.length === 5 &&
        requested !== undefined &&
        SESSION_ID.test(requested)))
  )
    return { mockPort, stage, requested }
  throw new Error(OFFLINE_USAGE)
}

export async function runNativeOffline(options: ReturnType<typeof parseOffline>, plugin: string) {
  const { stage, requested, mockPort, stageFile } = options
  if (stage !== undefined && readStage(stage).destination === undefined)
    throw new Error("shell-capable fixture stages cannot be reopened")
  const recoveryRules = stageFile || stage !== undefined ? RECOVERY_RULES : ""
  if (process.platform !== "darwin") throw new Error("offline coding requires macOS Seatbelt")
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("offline coding requires an interactive terminal")
  const timeoutMs = executionTimeout(process.env["BASHWINK_TIMEOUT_MS"])
  const terminal = Bun.spawnSync(["/usr/bin/tty"], { stdin: "inherit", stderr: "ignore" })
  const tty = terminal.stdout.toString().trim()
  if (terminal.exitCode !== 0 || !/^\/dev\/ttys\d+$/.test(tty))
    throw new Error("could not identify the inherited macOS terminal")
  const mock = `http://127.0.0.1:${mockPort}`
  const health = await fetch(mock + "/healthz", {
    signal: AbortSignal.timeout(1_000),
    redirect: "error",
    proxy: "",
  })
  if (
    !health.ok ||
    ((await health.json()) as { service?: string }).service !== "bashwink-offline-fixture-v1"
  )
    throw new Error("offline mock fixture did not identify itself")
  const source = process.env["BASHWINK_OPENCODE_BIN"]
  if (source === undefined || !path.isAbsolute(source))
    throw new Error("set BASHWINK_OPENCODE_BIN to the absolute path of the trusted pinned binary")

  const runtimeBytes = readFileSync(source)
  const pluginSource = path.join(plugin, "src")
  const pluginHashes = readdirSync(pluginSource)
    .sort()
    .map((name) => sha256(readFileSync(path.join(pluginSource, name))))
  const profile = sha256(
    JSON.stringify([
      "seatbelt-offline-profile-v1",
      process.arch,
      PROFILE,
      OFFLINE_RULES,
      recoveryRules,
      sha256(runtimeBytes),
      pluginHashes,
    ]),
  )
  const approved = stageFile ? snapshotDestination() : undefined
  const root = stage ?? realpathSync(mkdtempSync("/private/tmp/bashwink-offline-"))
  const unlock = lockStage(root)
  let release = true
  try {
    const workspace = path.join(root, "work")
    const scratch = path.join(root, "scratch")
    const runtime = path.join(root, "opencode")
    const scopes = path.join(scratch, "scopes")
    const evidence = path.join(scratch, "evidence")
    const policy = path.join(root, "scope.json")
    const config = path.join(root, "config")
    const scope = JSON.stringify({
      mode: "enforce",
      workspace,
      readPaths: [workspace],
      allowedPaths: [workspace],
      forbiddenPaths: [scratch],
      allowShell: recoveryRules === "",
    })
    if (stage === undefined) {
      for (const directory of [
        workspace,
        scratch,
        scopes,
        evidence,
        config,
        path.join(config, "opencode"),
      ])
        mkdirSync(directory, { mode: 0o700 })
      writeFileSync(
        path.join(workspace, STAGED_FILE),
        approved?.data ?? "Bashwink disposable coding fixture\n",
        {
          mode: 0o600,
          flag: "wx",
        },
      )
      writeFileSync(policy, scope, { mode: 0o400, flag: "wx" })
      writeStage(root, newStageState(root, profile, approved?.destination))
    }
    const state = readStage(root)
    if (state.profile !== profile)
      throw new Error("saved stage has an incompatible execution profile")
    if (regularFile(policy).data.toString() !== scope)
      throw new Error("saved stage has an incompatible workspace policy")
    directoryIdentity(config)
    directoryIdentity(scopes)
    if (readdirSync(scopes).length !== 0)
      throw new Error("saved stage has outstanding readiness state")
    const anchor = captureEvidence(root, state.evidence)
    const session = stage === undefined ? undefined : selectSavedSession(root, requested)
    // Exclusive creation prevents following a leftover or replaced runtime path.
    writeFileSync(runtime, runtimeBytes, { mode: 0o500, flag: "wx" })
    const runId = newRunId()
    const data = path.join(scratch, "data")
    const logFile = path.join(data, "opencode", "log", "opencode.log")
    const env = {
      HOME: scratch,
      TMPDIR: scratch,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: path.join(scratch, "state"),
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      LC_ALL: "C",
      TERM: "xterm-256color",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugins: [plugin],
        providers: {
          "bashwink-mock": {
            name: "Bashwink offline fixture",
            package: "@opencode/ai/providers/openai/chat",
            settings: { baseURL: mock + "/v1" },
            models: {
              "mock-tool-model": {
                name: "Mock Tool Model",
                limit: { context: 32768, output: 4096 },
              },
            },
          },
        },
        model: "bashwink-mock/mock-tool-model",
        permissions: [
          "external_directory",
          "webfetch",
          "websearch",
          "subagent",
          "automation",
          ...(recoveryRules ? ["shell"] : []),
        ].map((action) => ({ action, resource: "*", effect: "deny" })),
      }),
      BASHWINK_SCOPE_FILE: policy,
      BASHWINK_RUN_ID: runId,
      BASHWINK_EVIDENCE_DIR: evidence,
      BASHWINK_EVIDENCE_EXPECTED: "1",
    }

    const reservation = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end()
        },
      },
    })
    const serverPort = reservation.port
    reservation.stop(true)
    const wrap = (rules: string, argv: readonly string[], executable = runtime) => [
      SEATBELT,
      "-D",
      `ROOT=${root}`,
      "-D",
      `WORK=${workspace}`,
      "-D",
      `SCRATCH=${scratch}`,
      "-D",
      `RUNTIME=${runtime}`,
      "-D",
      `PLUGIN=${plugin}`,
      "-D",
      `SCOPE=${policy}`,
      "-D",
      `CONFIG=${config}`,
      "-D",
      `TTY=${tty}`,
      "-p",
      PROFILE + OFFLINE_RULES + recoveryRules + rules,
      executable,
      ...argv,
    ]
    const version = await execute(wrap("", ["--version"]), workspace, env)
    if (version.exitCode !== 0 || version.stdout.trim() !== `opencode v${PINNED_RUNTIME_VERSION}`) {
      rmSync(runtime, { force: true })
      throw new Error("the confined runtime did not report the pinned OpenCode version")
    }
    if (recoveryRules) {
      const shell = await execute(wrap("", ["-c", "exit 0"], "/bin/sh"), workspace, env)
      if (shell.exitCode === 0 || !/Operation not permitted|Permission denied/.test(shell.stderr)) {
        rmSync(runtime, { force: true })
        throw new Error("the recovery profile did not prove its shell execution denial")
      }
    }
    const backend = makeBackend(
      {
        mode: "seatbelt-offline-fixture",
        workspace: "staged",
        filesystemIsolation: true,
        networkIsolation: false,
        processIsolation: false,
        cancellation: "direct-child",
      },
      {
        serverPort,
        server() {
          return wrap(
            `
        (allow network-bind network-inbound (local tcp4 "localhost:${serverPort}"))
        (allow network-outbound (remote tcp4 "localhost:${mockPort}"))
      `,
            ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(serverPort)],
          )
        },
        client(_command, args) {
          const endpoint = new URL(args[0]!.slice("--server=".length))
          const gatewayPort = Number(endpoint.port)
          if (
            endpoint.hostname !== "127.0.0.1" ||
            !Number.isInteger(gatewayPort) ||
            gatewayPort < 1024 ||
            gatewayPort > 65535
          )
            throw new Error("offline admission endpoint is not owned loopback")
          return wrap(`(allow network-outbound (remote tcp4 "localhost:${gatewayPort}"))`, args)
        },
      },
    )
    process.stdout.write(`Bashwink offline fixture workspace: ${workspace}\n`)
    const cancellation = new AbortController()
    const stop = () => cancellation.abort()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      release = false
      const result = await runWithBackend(
        backend,
        {
          command: runtime,
          args: session === undefined ? [] : ["--session", session],
          cwd: workspace,
          env,
          readiness: {
            runId,
            workspace,
            scopesDirectory: scopes,
            pluginDirectory: plugin,
            logFile,
            ...(session === undefined ? {} : { resumeSession: session }),
          },
        },
        { signal: cancellation.signal, timeoutMs },
      )
      if (result.outcome !== "cleanup-failed") {
        writeStage(root, { ...state, evidence: captureEvidence(root, anchor) })
        release = true
      }
      return result
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      rmSync(runtime, { force: true })
    }
  } finally {
    if (release) unlock()
  }
}
