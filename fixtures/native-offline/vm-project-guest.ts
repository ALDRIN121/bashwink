// Runs as the unprivileged guest user. stdin is the bounded project input from init.
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const LIMIT = 32 * 1024 * 1024
const FILE_LIMIT = 256 * 1024
const FILE_COUNT = 128
const PROJECT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,78}\.(ts|js|txt)$/
const TEST_FILE = /(?:\.test\.|\.spec\.|^test[-_.])/i
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,100}$/
const SESSION_DB = "bashwink/opencode/opencode.db"
const TASK_DB = "bashwink/data/bashwink.sqlite"
const STATE = [
  SESSION_DB,
  `${SESSION_DB}-wal`,
  `${SESSION_DB}-shm`,
  TASK_DB,
  `${TASK_DB}-wal`,
  `${TASK_DB}-shm`,
  "bashwink/data/active-task",
  "bashwink/data/current-plan.json",
  "bashwink/data/evidence/evidence.jsonl",
]
const STATE_DIRS = {
  "bashwink/data/plans": /^[A-Za-z0-9-]{1,100}\.json$/,
  "bashwink/data/runs": /^[A-Za-z0-9_-]{1,100}\.json$/,
}

function stateFile(name: string) {
  if (STATE.includes(name)) return true
  return Object.entries(STATE_DIRS).some(
    ([dir, pattern]) => name.startsWith(`${dir}/`) && pattern.test(name.slice(dir.length + 1)),
  )
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid guest project object")
  return value as Record<string, unknown>
}

function restoreFiles(
  root: string,
  files: Record<string, unknown>,
  allowed: (name: string) => boolean,
  limit: number,
) {
  if (Object.keys(files).length > FILE_COUNT) throw new Error("too many guest project entries")
  for (const [name, data] of Object.entries(files)) {
    if (!allowed(name) || typeof data !== "string") throw new Error("invalid guest project file")
    const bytes = Buffer.from(data, "base64")
    if (bytes.length > limit || bytes.toString("base64") !== data)
      throw new Error("invalid guest project file encoding")
    const file = path.join(root, name)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  }
}

function stateNames(state: string) {
  const names = [...STATE]
  for (const [relative, pattern] of Object.entries(STATE_DIRS)) {
    const dir = path.join(state, relative)
    try {
      for (let parent = dir; parent !== state; parent = path.dirname(parent)) {
        if (!lstatSync(parent).isDirectory()) throw new Error("unsafe guest state directory")
      }
      names.push(
        ...readdirSync(dir)
          .filter((name) => pattern.test(name))
          .map((name) => `${relative}/${name}`),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return names
}

function readRegular(root: string, name: string, optional: boolean, limit: number) {
  const file = path.join(root, name)
  let fd: number
  try {
    for (
      let directory = path.dirname(file);
      directory !== root;
      directory = path.dirname(directory)
    ) {
      if (!lstatSync(directory).isDirectory()) throw new Error("unsafe guest project directory")
    }
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > limit)
      throw new Error("unsafe or oversized guest project file")
    // The open file may have changed since fstat. Read no more than the remaining budget.
    const bytes = Buffer.alloc(stats.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (read === 0) break
      length += read
    }
    const after = fstatSync(fd)
    if (
      length !== stats.size ||
      after.size !== stats.size ||
      after.nlink !== stats.nlink ||
      after.ctimeMs !== stats.ctimeMs ||
      after.mtimeMs !== stats.mtimeMs
    )
      throw new Error("guest project file changed during snapshot")
    return bytes.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

function sessionsFor(workspace: string, state: string) {
  for (const name of [SESSION_DB, `${SESSION_DB}-wal`, `${SESSION_DB}-shm`]) {
    try {
      const stats = lstatSync(path.join(state, name))
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > LIMIT)
        throw new Error("unsafe guest session database")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (name === SESSION_DB) return []
    }
  }
  const database = new Database(path.join(state, SESSION_DB), { readonly: true })
  try {
    const rows = database
      .query<{ id: string }, [string]>(
        "SELECT id FROM session_v2 WHERE directory = ? AND workspace_id IS NULL ORDER BY time_updated DESC, id DESC",
      )
      .all(workspace)
    const sessions = rows.map(({ id }) => id)
    if (!sessions.every((id) => typeof id === "string" && SESSION_ID.test(id)))
      throw new Error("invalid saved guest session")
    return sessions
  } finally {
    database.close()
  }
}

function verificationFiles(request: Record<string, unknown>): string[] {
  const files = record(request.files)
  const names = request.verify
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > FILE_COUNT ||
    new Set(names).size !== names.length ||
    request.state !== undefined ||
    request.resume !== undefined ||
    !names.every(
      (name) =>
        typeof name === "string" &&
        PROJECT_FILE.test(name) &&
        TEST_FILE.test(name) &&
        Object.hasOwn(files, name),
    )
  )
    throw new Error("invalid guest protected test selection")
  return names
}

function writeCheckpoint(record: object) {
  const payload = Buffer.from(JSON.stringify(record))
  if (payload.length > LIMIT) throw new Error("guest project checkpoint is too large")
  const header = Buffer.alloc(4096)
  header.write(`BWPROJECT1 ${payload.length}\n`)
  process.stdout.write(header)
  process.stdout.write(payload)
}

const [mode, workspace = "/workspace", state = "/state"] = Bun.argv.slice(2)
const input = await Bun.stdin.text()
if (Buffer.byteLength(input) > LIMIT) throw new Error("guest project input is too large")
const request = record(JSON.parse(input))
if (typeof request.token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(request.token))
  throw new Error("invalid guest project identity")

if (mode === "restore") {
  restoreFiles(workspace, record(request.files), (name) => PROJECT_FILE.test(name), FILE_LIMIT)
  restoreFiles(state, record(request.state ?? {}), stateFile, LIMIT)
  if (request.verify !== undefined) {
    verificationFiles(request)
    console.log("verify")
  } else if (request.resume !== undefined) {
    if (
      request.resume !== "continue" &&
      (typeof request.resume !== "string" || !SESSION_ID.test(request.resume))
    )
      throw new Error("invalid requested guest session")
    const sessions = sessionsFor(workspace, state)
    const session = request.resume === "continue" ? sessions[0] : request.resume
    if (session === undefined || !sessions.includes(session))
      throw new Error("no saved session owned by this project guest")
    console.log(session)
  }
} else if (mode === "verify") {
  const names = verificationFiles(request)
  const temporary = path.join(state, "tmp")
  mkdirSync(temporary, { mode: 0o700 })
  const result = spawnSync(process.execPath, ["test", ...names.map((name) => `./${name}`)], {
    cwd: workspace,
    env: { HOME: state, TMPDIR: temporary, PATH: "/opt:/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 32_768,
  })
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`
  const output = Buffer.from(diagnostics)
    .subarray(0, 65_536 - 3)
    .toString("utf8")
  writeCheckpoint({ token: request.token, verification: { exitCode: result.status ?? 1, output } })
} else if (mode === "snapshot") {
  const files: Record<string, string> = {}
  const savedState: Record<string, string> = {}
  let remaining = Math.floor((LIMIT * 3) / 4)
  const names = readdirSync(workspace)
  if (names.length > FILE_COUNT) throw new Error("too many guest project entries")
  for (const name of names) {
    if (!PROJECT_FILE.test(name)) throw new Error("unexpected guest project entry")
    const content = readRegular(workspace, name, false, Math.min(remaining, FILE_LIMIT))!
    remaining -= content.byteLength
    files[name] = content.toString("base64")
  }
  const sessions = sessionsFor(workspace, state)
  for (const name of stateNames(state)) {
    const content = readRegular(state, name, true, remaining)
    if (!content) continue
    remaining -= content.byteLength
    savedState[name] = content.toString("base64")
  }
  if (Object.keys(savedState).length > FILE_COUNT) throw new Error("too many guest state entries")
  writeCheckpoint({ token: request.token, files, state: savedState, sessions })
} else {
  throw new Error("invalid guest project operation")
}
