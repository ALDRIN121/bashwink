import { Database, SQLiteError } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { startAdmission } from "./session-admission.js"

export interface ReadinessRequest {
  readonly runId: string
  readonly workspace: string
  readonly scopesDirectory: string
  readonly pluginDirectory: string
  readonly logFile: string
  readonly resumeSession?: string
}

interface Identity {
  readonly v: number
  readonly runId: string
  readonly workspace: string
  readonly nonce: string
  readonly pid: number
}

/** Native launch policy for the same owned server and private client. */
export interface RuntimeLauncher {
  server(command: string): string[]
  client(command: string, args: readonly string[]): string[]
  readonly serverPort: number
}

export class ReadinessError extends Error {}

class EndpointError extends Error {}

export function matchesReadiness(value: unknown, expected: Identity): boolean {
  if (typeof value !== "object" || value === null) return false
  const actual = value as Record<string, unknown>
  return (
    actual["v"] === expected.v &&
    actual["runId"] === expected.runId &&
    actual["workspace"] === expected.workspace &&
    actual["nonce"] === expected.nonce &&
    actual["pid"] === expected.pid
  )
}

export function parsePrivateEndpoint(line: string): string {
  const value: unknown = JSON.parse(line)
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    throw new Error("missing server endpoint")
  const url = new URL(value.url)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.href !== url.origin + "/"
  )
    throw new Error("expected an ephemeral loopback endpoint")
  return url.origin
}

async function drainEndpoint(
  stream: ReadableStream<Uint8Array>,
  ready: PromiseWithResolvers<string>,
) {
  const decoder = new TextDecoder()
  let pending = ""
  let found = false
  try {
    for await (const bytes of stream) {
      if (found) continue
      pending += decoder.decode(bytes, { stream: true })
      const newline = pending.indexOf("\n")
      if (newline !== -1) {
        if (newline > 4096) throw new EndpointError("owned server endpoint line was oversized")
        try {
          ready.resolve(parsePrivateEndpoint(pending.slice(0, newline)))
        } catch {
          throw new EndpointError("owned server advertised a malformed or non-loopback endpoint")
        }
        found = true
        pending = ""
      } else if (pending.length > 4096)
        throw new EndpointError("owned server endpoint line was oversized")
    }
    if (!found)
      throw new EndpointError("owned server closed stdout before advertising its endpoint")
  } catch (error) {
    ready.reject(error)
  }
}

async function unattendedDatabase(environment: Record<string, string>, cancel: AbortSignal) {
  if (environment["OPENCODE_DB"] === ":memory:") return ":memory:"
  const data = environment["XDG_DATA_HOME"]
  if (data === undefined) throw new ReadinessError("OpenCode data directory is missing")
  // Pin the database checked here to the file used by OpenCode. Its scheduler
  // starts before any client attaches and must have no persisted automations.
  const file = path.resolve(data, "opencode", environment["OPENCODE_DB"] ?? "opencode.db")
  try {
    statSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return file
    throw new ReadinessError(
      `could not locate the OpenCode database before startup (${code ?? "unknown error"})`,
    )
  }
  const deadline = performance.now() + 2_000
  while (!cancel.aborted) {
    try {
      const db = new Database(file, { readonly: true })
      try {
        // The pinned migration can turn old schedules into runnable automations.
        for (const table of ["automation", "schedule"]) {
          if (
            db
              .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
              .get(table) !== null &&
            db.query(`SELECT 1 FROM ${table} LIMIT 1`).get() !== null
          )
            throw new ReadinessError(
              "OpenCode database contains saved automations or schedules; choose an automation-free Bashwink home",
            )
        }
      } finally {
        db.close()
      }
      return file
    } catch (error) {
      if (error instanceof ReadinessError) throw error
      if (
        error instanceof SQLiteError &&
        (error.errno & 0xff) === 5 &&
        performance.now() < deadline
      ) {
        // A concurrent managed service can briefly hold a SQLite bootstrap lock.
        await Bun.sleep(50)
        continue
      }
      const detail =
        error instanceof SQLiteError ? `${error.code} / ${error.errno}` : "unknown error"
      throw new ReadinessError(`could not inspect the OpenCode database before startup (${detail})`)
    }
  }
  throw new ReadinessError("private runtime launch was cancelled")
}

export async function startPrivateServer(
  command: string,
  environment: Record<string, string>,
  request: ReadinessRequest,
  cancel: AbortSignal,
  launcher?: RuntimeLauncher,
) {
  const database = await unattendedDatabase(environment, cancel)
  if (cancel.aborted) throw new ReadinessError("private runtime launch was cancelled")
  const directory = mkdtempSync(path.join(request.scopesDirectory, ".readiness-"))
  const ack = path.join(directory, "ready.json")
  const retiring = path.join(directory, "retire")
  const nonce = randomBytes(32).toString("hex")
  const password = randomBytes(32).toString("base64url")
  const authorization = (value: string) =>
    `Basic ${Buffer.from(`opencode:${value}`).toString("base64")}`
  let admission: ReturnType<typeof startAdmission> | undefined

  let child: Bun.Subprocess<"pipe", "pipe", "ignore">
  try {
    child = Bun.spawn(launcher?.server(command) ?? [command, "serve", "--stdio", "--port", "0"], {
      cwd: request.workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...environment,
        OPENCODE_PASSWORD: password,
        OPENCODE_DB: database,
        OPENCODE_FILEWATCHER_DISABLE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        BASHWINK_READINESS: JSON.stringify({
          runId: request.runId,
          workspace: request.workspace,
          nonce,
          ack,
          retiring,
        }),
      },
    })
  } catch {
    rmSync(directory, { recursive: true, force: true })
    throw new ReadinessError(`could not start the private OpenCode server; see ${request.logFile}`)
  }
  const expected: Identity = {
    v: 1,
    runId: request.runId,
    workspace: request.workspace,
    nonce,
    pid: child.pid,
  }
  const endpoint = Promise.withResolvers<string>()
  void drainEndpoint(child.stdout, endpoint)

  const stopping = async () => {
    try {
      await admission?.stop(true)
      // Intentional lease closure permits orderly plugin teardown.
      writeFileSync(retiring, "", { mode: 0o600 })
    } finally {
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 1_500)
      try {
        try {
          await child.stdin.end()
        } catch {
          // The peer may already have closed its lease. Still wait for exit and reap it.
        }
        await child.exited
      } finally {
        clearTimeout(force)
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
  let stopPromise: Promise<void> | undefined
  return {
    exited: child.exited,
    async ready(cancel: AbortSignal) {
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(12_000)])
      let stage = "waiting for the owned server endpoint"
      const failed = () =>
        new ReadinessError(
          `required policy plugin did not become ready (${stage}); check its install, activation and server log at ${request.logFile}`,
        )
      const interrupted = Promise.withResolvers<never>()
      const abort = () => interrupted.reject(failed())
      signal.addEventListener("abort", abort, { once: true })
      try {
        if (signal.aborted) throw failed()
        const url = await Promise.race([endpoint.promise, interrupted.promise]).catch(
          (error: unknown) => {
            if (error instanceof EndpointError) {
              stage = `${error.message}, exit=${child.exitCode ?? "unknown"}, signal=${child.signalCode ?? "none"}`
              throw failed()
            }
            throw error
          },
        )
        stage = "validating the owned server endpoint"
        if (launcher !== undefined && new URL(url).port !== String(launcher.serverPort))
          throw failed()
        const headers = {
          Authorization: authorization(password),
        }
        const inventory = new URL("/api/plugin", url)
        inventory.searchParams.set("location[directory]", request.workspace)
        while (!signal.aborted && child.exitCode === null && child.signalCode === null) {
          stage = "reading private plugin inventory"
          const response = await fetch(inventory, { headers, signal, redirect: "error" })
          if (!response.ok) {
            stage = `private plugin inventory returned HTTP ${response.status}`
            throw failed()
          }
          stage = "decoding private plugin inventory"
          const listed = (await response.json()) as {
            location?: { directory?: string }
            data?: Array<{
              id?: string
              source?: { type?: string; path?: string }
              state?: { status?: string }
            }>
          }
          if (listed.location?.directory !== request.workspace || !Array.isArray(listed.data)) {
            stage = "plugin inventory workspace or response shape did not match"
            throw failed()
          }
          const plugins = listed.data.filter(
            (entry) =>
              entry.id === "bashwink-evidence" ||
              (entry.source?.type === "local" &&
                entry.source.path !== undefined &&
                (entry.source.path === request.pluginDirectory ||
                  entry.source.path.startsWith(request.pluginDirectory + path.sep))),
          )
          if (plugins.some((entry) => entry.state?.status === "failed"))
            throw new ReadinessError(
              `required policy plugin failed to activate; see ${request.logFile}`,
            )
          if (existsSync(ack)) {
            stage = "reading the policy acknowledgment"
            const proof: unknown = JSON.parse(readFileSync(ack, "utf8"))
            stage = "checking policy acknowledgment run, server and workspace identity"
            if (!matchesReadiness(proof, expected)) throw failed()
            if (
              plugins.some(
                (entry) =>
                  entry.id === "bashwink-evidence" &&
                  entry.source?.type === "local" &&
                  entry.source.path === request.pluginDirectory &&
                  entry.state?.status === "active",
              )
            ) {
              if (request.resumeSession !== undefined) {
                stage = "checking saved session ownership on the attested runtime"
                const lookup = await fetch(
                  url + "/api/session/" + encodeURIComponent(request.resumeSession),
                  {
                    headers,
                    signal,
                    redirect: "error",
                  },
                )
                if (!lookup.ok) throw failed()
                const record = (await lookup.json()) as {
                  data?: { id?: string; location?: { directory?: string; workspaceID?: string } }
                }
                if (
                  record.data?.id !== request.resumeSession ||
                  record.data.location?.directory !== request.workspace ||
                  record.data.location.workspaceID !== undefined
                )
                  throw failed()
              }
              stage = "opening the local session endpoint"
              if (signal.aborted || child.exitCode !== null || child.signalCode !== null)
                throw failed()
              const clientPassword = randomBytes(32).toString("base64url")
              admission = startAdmission(
                url,
                headers.Authorization,
                authorization(clientPassword),
                request.workspace,
              )
              return { url: admission.url.origin, password: clientPassword }
            }
          }
          stage = "waiting for the required plugin acknowledgment and active inventory entry"
          await Bun.sleep(50)
        }
        throw failed()
      } catch (error) {
        throw error instanceof ReadinessError ? error : failed()
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
    stop: () => (stopPromise ??= stopping()),
  }
}
