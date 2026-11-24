import { accessSync, constants, statSync } from "node:fs"
import { constants as osConstants } from "node:os"
import {
  ReadinessError,
  startPrivateServer,
  type ReadinessRequest,
  type RuntimeLauncher,
} from "./private-server.js"

export interface BackendCapabilities {
  readonly mode: string
  readonly workspace: "direct" | "staged"
  readonly filesystemIsolation: boolean
  readonly networkIsolation: boolean
  readonly processIsolation: boolean
  readonly cancellation: "direct-child" | "backend-workload"
}

/** A launch already authorized by the caller. Arguments are an argv vector, never a shell string. */
export interface LaunchRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly readiness?: ReadinessRequest
}

export interface PreparedExecution {
  execute(): Promise<number>
  cancel(): void | Promise<void>
  /** Collect a normally finished execution's workspace, if the backend uses staging. */
  sync(): void | Promise<void>
  dispose(): void | Promise<void>
}

export interface ExecutionBackend {
  readonly capabilities: BackendCapabilities
  /** Cheap local validation. A backend starts its cancellable workload only in execute(). */
  prepare(request: LaunchRequest): PreparedExecution
}

export interface BackendResult {
  readonly backend: BackendCapabilities
  readonly outcome:
    "exited" | "cancelled" | "timed-out" | "startup-failed" | "readiness-failed" | "cleanup-failed"
  readonly exitCode: number
  readonly detail?: string
}

const localCapabilities: BackendCapabilities = {
  mode: "local",
  workspace: "direct",
  filesystemIsolation: false,
  networkIsolation: false,
  processIsolation: false,
  cancellation: "direct-child",
}

const unrestrictedCapabilities: BackendCapabilities = {
  ...localCapabilities,
  mode: "unrestricted-host",
}

export const makeBackend = (
  capabilities: BackendCapabilities,
  launcher?: RuntimeLauncher,
): ExecutionBackend => ({
  capabilities,
  prepare(request) {
    if (!statSync(request.cwd).isDirectory())
      throw new Error("runtime workspace is not a directory")
    try {
      if (!statSync(request.command).isFile()) throw new Error("not a regular file")
      accessSync(request.command, constants.X_OK)
    } catch {
      throw new Error("configured runtime is not an executable file")
    }

    let child: Bun.Subprocess<"inherit", "inherit", "inherit"> | undefined
    let stopping: Promise<void> | undefined
    let server: Awaited<ReturnType<typeof startPrivateServer>> | undefined
    const controller = new AbortController()
    const stopClient = async (): Promise<void> => {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
      const running = child
      running.kill("SIGTERM")
      const force = setTimeout(() => {
        if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL")
      }, 1_500)
      try {
        await running.exited
      } finally {
        clearTimeout(force)
      }
    }
    const cancel = async () => {
      controller.abort()
      let results: PromiseSettledResult<void | undefined>[]
      try {
        await server?.closeAdmission()
      } finally {
        results = await Promise.allSettled([stopClient(), server?.stop()])
      }
      for (const stopped of results) if (stopped.status === "rejected") throw stopped.reason
    }
    return {
      async execute() {
        if (child !== undefined) throw new Error("prepared execution has already started")
        let args = request.args
        let env = request.env
        if (request.readiness !== undefined) {
          server = await startPrivateServer(
            request.command,
            request.env,
            request.readiness,
            controller.signal,
            launcher,
          )
          const endpoint = await server.ready(controller.signal)
          if (controller.signal.aborted)
            throw new ReadinessError("private runtime launch was cancelled")
          args = [
            `--server=${endpoint.url}`,
            ...args.filter(
              (arg, i) =>
                arg !== "--standalone" || (args.indexOf("--") >= 0 && i > args.indexOf("--")),
            ),
          ]
          env = {
            ...env,
            PWD: request.cwd,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_PASSWORD: endpoint.password,
          }
        }
        child = Bun.spawn(launcher?.client(request.command, args) ?? [request.command, ...args], {
          cwd: request.cwd,
          env,
          stdio: [
            "inherit",
            "inherit",
            "inherit",
            ...(launcher?.lifetime ? [launcher.lifetime.fd] : []),
          ],
        })
        if (launcher?.lifetime !== undefined) {
          try {
            launcher.lifetime.verify(child.pid)
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error("owned client already exited")
            launcher.lifetime.attached()
            server?.openAdmission()
          } catch {
            throw new ReadinessError(
              "could not certify both owned native processes before admission",
            )
          }
        }
        const exited = child.exited
        const code = await (server === undefined
          ? exited
          : Promise.race([
              exited,
              server.exited.then(() => {
                throw new ReadinessError(
                  "private OpenCode server stopped; the client will be closed",
                )
              }),
            ]))
        const signal = child.signalCode
        if (signal === null) return code
        return 128 + (typeof signal === "number" ? signal : osConstants.signals[signal])
      },
      cancel() {
        return (stopping ??= cancel())
      },
      sync() {
        // Local changes are already in the working directory.
      },
      dispose() {
        return (stopping ??= cancel())
      },
    }
  },
})

export const localBackend = makeBackend(localCapabilities)

/** Host execution that a release build offers only after a typed acknowledgment. */
export const unrestrictedBackend = makeBackend(unrestrictedCapabilities)

export function selectBackend(mode = "local"): ExecutionBackend {
  if (mode === "local") return localBackend
  if (mode === "unrestricted-host") return unrestrictedBackend
  if (mode === "native")
    throw new Error(
      "native coding sessions are not qualified; use bashwink sandbox probe for offline checks",
    )
  throw new Error(`execution backend '${mode}' is unavailable`)
}

export function executionTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const milliseconds = Number(value)
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 2_147_483_647
  )
    throw new Error("BASHWINK_TIMEOUT_MS must be a positive integer up to 2147483647")
  return milliseconds
}

/** Bound execution time and report its outcome after the backend has disposed its resources. */
export async function runWithBackend(
  backend: ExecutionBackend,
  request: LaunchRequest,
  options: {
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs?: number | undefined
  } = {},
): Promise<BackendResult> {
  const report = (
    outcome: BackendResult["outcome"],
    exitCode: number,
    detail?: string,
  ): BackendResult => ({
    backend: backend.capabilities,
    outcome,
    exitCode,
    ...(detail === undefined ? {} : { detail }),
  })
  const cancelled = report("cancelled", 130, "execution cancelled")
  const timeout = report("timed-out", 124, "execution deadline expired")
  if (options.signal?.aborted) return cancelled

  let prepared: PreparedExecution
  try {
    prepared = backend.prepare(request)
  } catch (error) {
    return report("startup-failed", 1, error instanceof Error ? error.message : String(error))
  }

  let result: BackendResult = cancelled
  const interrupted = Promise.withResolvers<BackendResult>()
  const abort = () => interrupted.resolve(cancelled)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stage: "startup-failed" | "cleanup-failed" = "startup-failed"
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    if (!options.signal?.aborted) {
      if (options.timeoutMs !== undefined)
        timer = setTimeout(() => interrupted.resolve(timeout), options.timeoutMs)
      const exit = prepared.execute().then((code) => report("exited", code))
      result = await Promise.race([exit, interrupted.promise])
      stage = "cleanup-failed"
      if (result.outcome === "exited") await prepared.sync()
      else {
        await prepared.cancel()
        await exit.catch(() => undefined)
      }
    }
  } catch (error) {
    result =
      error instanceof ReadinessError
        ? report("readiness-failed", 3, error.message)
        : report(stage, 1, error instanceof Error ? error.message : String(error))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }

  try {
    await prepared.dispose()
  } catch (error) {
    return report("cleanup-failed", 1, error instanceof Error ? error.message : String(error))
  }
  return result
}
