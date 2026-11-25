import { timingSafeEqual } from "node:crypto"
import { physicalPath } from "@bashwink/evidence"

const SESSION_ROUTE = /^\/api\/(?:experimental\/)?session\/(ses_[A-Za-z0-9_-]+)(?:\/|$)/
const SESSION_ACTION =
  /^\/(?:prompt|synthetic|shell|interrupt|agent|model|fork|compact|view|wait|skill|permission\/per_[A-Za-z0-9_-]+\/reply)$/

export function sessionAction(method: string, pathname: string): string | undefined {
  const matched = pathname.match(SESSION_ROUTE)
  const id = matched?.[1]
  if (id === undefined) return undefined
  const suffix = pathname.slice(pathname.indexOf(id) + id.length)
  if (method === "PATCH" && suffix === "") return id
  return method === "POST" && SESSION_ACTION.test(suffix) ? id : undefined
}

const MODEL_WORK = /\/(?:prompt|synthetic|compact|skill)$/

/** True for the session actions that make the runtime call the model. */
export function startsModelWork(method: string, pathname: string): boolean {
  return method === "POST" && MODEL_WORK.test(pathname)
}

function inWorkspace(directory: unknown, workspace: string): boolean {
  if (typeof directory !== "string") return false
  try {
    return directory.startsWith("/") && physicalPath(directory) === workspace
  } catch {
    return false
  }
}

function acceptedLocation(url: URL, request: Request, workspace: string): boolean {
  if (url.searchParams.has("location[workspace]")) return false
  for (const directory of url.searchParams.getAll("location[directory]"))
    if (!inWorkspace(directory, workspace)) return false
  const header = request.headers.get("x-opencode-directory")
  return header === null || inWorkspace(decodeURIComponent(header), workspace)
}

function validCredential(request: Request, authorization: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "")
  const expected = Buffer.from(authorization)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Limit the pinned client to the attested location, even after it resumes a saved session. */
export function startAdmission(
  upstream: string,
  upstreamAuth: string,
  clientAuth: string,
  workspace: string,
  admitted: () => Promise<boolean> = async () => true,
  /** A reason to refuse new model work (a usage limit was reached), or undefined to admit it. */
  blocked: () => string | undefined = () => undefined,
) {
  const refused = () =>
    Response.json(
      { message: "Bashwink refused an action outside the admitted session policy" },
      { status: 403 },
    )
  const sameSession = async (id: string, signal: AbortSignal) => {
    const response = await fetch(upstream + "/api/session/" + encodeURIComponent(id), {
      headers: { authorization: upstreamAuth },
      redirect: "error",
      signal,
    })
    if (!response.ok) return false
    const record = (await response.json()) as {
      data?: { location?: { directory?: string; workspaceID?: string } }
    }
    return (
      record.data?.location?.workspaceID === undefined &&
      inWorkspace(record.data?.location?.directory, workspace)
    )
  }

  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      if (!validCredential(request, clientAuth)) return new Response(null, { status: 401 })
      const url = new URL(request.url)
      try {
        if (
          !(await admitted()) ||
          request.headers.has("upgrade") ||
          !url.pathname.startsWith("/api/") ||
          !acceptedLocation(url, request, workspace)
        )
          return refused()

        let body: string | undefined
        const method = request.method
        const session = sessionAction(method, url.pathname)
        if (session !== undefined && startsModelWork(method, url.pathname)) {
          const reason = blocked()
          if (reason !== undefined) return Response.json({ message: reason }, { status: 429 })
        }
        if (method === "POST" && url.pathname === "/api/session") {
          const record = (await request.json()) as Record<string, unknown>
          const location = record["location"] as
            { directory?: string; workspace?: string } | undefined
          if (
            record["parentID"] !== undefined ||
            record["permissions"] !== undefined ||
            (location !== undefined &&
              (!inWorkspace(location.directory, workspace) || location.workspace !== undefined))
          )
            return refused()
          // Keep caller session ids and model choices, but always create in this location.
          body = JSON.stringify({ ...record, location: { directory: workspace } })
        } else if (session !== undefined) {
          if (!(await sameSession(session, request.signal))) return refused()
          body = await request.text()
          if (
            method === "PATCH" &&
            (JSON.parse(body) as Record<string, unknown>)["permissions"] !== undefined
          )
            return refused()
        } else if (method === "GET") {
          const requestedSession = url.pathname.match(SESSION_ROUTE)?.[1]
          if (
            requestedSession !== undefined &&
            !(await sameSession(requestedSession, request.signal))
          )
            return new Response(null, { status: 404 })
        } else return refused()

        if (!(await admitted())) return refused()
        const headers = new Headers(request.headers)
        for (const header of ["host", "connection", "content-length", "accept-encoding"])
          headers.delete(header)
        headers.set("authorization", upstreamAuth)
        headers.set("x-opencode-directory", encodeURIComponent(workspace))
        const response = await fetch(upstream + url.pathname + url.search, {
          method,
          headers,
          redirect: "error",
          signal: request.signal,
          timeout: false,
          ...(body === undefined ? {} : { body }),
        })
        const output = new Headers(response.headers)
        output.delete("content-encoding")
        output.delete("content-length")
        return new Response(response.body, { status: response.status, headers: output })
      } catch {
        return refused()
      }
    },
  })
}
