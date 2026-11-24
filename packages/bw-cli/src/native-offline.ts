import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { executionTimeout, makeBackend, runWithBackend } from "./execution-backend.js"
import { execute, PROFILE, SEATBELT } from "./native-sandbox.js"
import { newRunId } from "./run-health.js"
import { PINNED_RUNTIME_VERSION } from "./runtime.js"

export const OFFLINE_USAGE = "usage: bashwink sandbox offline <mock-port>"

export async function runNativeOffline(portText: string | undefined, plugin: string) {
  if (
    portText === undefined ||
    !/^\d{1,5}$/.test(portText) ||
    +portText < 1024 ||
    +portText > 65535
  )
    throw new Error(OFFLINE_USAGE)
  if (process.platform !== "darwin") throw new Error("offline coding requires macOS Seatbelt")
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("offline coding requires an interactive terminal")
  const timeoutMs = executionTimeout(process.env["BASHWINK_TIMEOUT_MS"])
  const terminal = Bun.spawnSync(["/usr/bin/tty"], { stdin: "inherit", stderr: "ignore" })
  const tty = terminal.stdout.toString().trim()
  if (terminal.exitCode !== 0 || !/^\/dev\/ttys\d+$/.test(tty))
    throw new Error("could not identify the inherited macOS terminal")
  const mockPort = +portText
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

  const root = realpathSync(mkdtempSync("/private/tmp/bashwink-offline-"))
  const workspace = path.join(root, "work")
  const scratch = path.join(root, "scratch")
  const runtime = path.join(root, "opencode")
  const scopes = path.join(scratch, "scopes")
  const evidence = path.join(scratch, "evidence")
  const policy = path.join(root, "scope.json")
  for (const directory of [workspace, scratch, scopes, evidence])
    mkdirSync(directory, { mode: 0o700 })
  copyFileSync(source, runtime)
  chmodSync(runtime, 0o500)
  writeFileSync(path.join(workspace, "task.txt"), "Bashwink disposable coding fixture\n", {
    mode: 0o600,
  })
  writeFileSync(
    policy,
    JSON.stringify({
      mode: "enforce",
      workspace,
      readPaths: [workspace],
      allowedPaths: [workspace],
      forbiddenPaths: [scratch],
      allowShell: true,
    }),
    { mode: 0o400 },
  )
  const runId = newRunId()
  const data = path.join(scratch, "data")
  const config = path.join(scratch, "config")
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
            "mock-tool-model": { name: "Mock Tool Model", limit: { context: 32768, output: 4096 } },
          },
        },
      },
      model: "bashwink-mock/mock-tool-model",
      permissions: ["external_directory", "webfetch", "websearch", "subagent", "automation"].map(
        (action) => ({ action, resource: "*", effect: "deny" }),
      ),
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
  const wrap = (rules: string, argv: readonly string[]) => [
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
    `TTY=${tty}`,
    "-p",
    PROFILE +
      `
      (allow file-read* (subpath (param "PLUGIN")) (literal (param "SCOPE")) (literal "/dev/tty"))
      (allow file-ioctl (literal "/dev/tty") (literal (param "TTY")))
      ` +
      rules,
    runtime,
    ...argv,
  ]
  const version = await execute(wrap("", ["--version"]), workspace, env)
  if (version.exitCode !== 0 || version.stdout.trim() !== `opencode v${PINNED_RUNTIME_VERSION}`) {
    rmSync(root, { recursive: true, force: true })
    throw new Error("the confined runtime did not report the pinned OpenCode version")
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
    return await runWithBackend(
      backend,
      {
        command: runtime,
        args: [],
        cwd: workspace,
        env,
        readiness: { runId, workspace, scopesDirectory: scopes, pluginDirectory: plugin, logFile },
      },
      { signal: cancellation.signal, timeoutMs },
    )
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    rmSync(runtime, { force: true })
  }
}
