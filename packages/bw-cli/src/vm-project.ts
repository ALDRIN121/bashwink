import { verifyText } from "@bashwink/evidence"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import { acquireNativeLifetime } from "./native-lifetime.js"
import {
  directoryIdentity,
  regularFile,
  SESSION_ID,
  sha256,
  syncDirectory,
} from "./native-stage.js"
import { paths } from "./paths.js"

export const VM_PROJECT_DISK_SIZE = 40 * 1024 * 1024
const PAYLOAD_SIZE = 32 * 1024 * 1024
const PAYLOAD_OFFSET = 4096
const FILE_SIZE = 256 * 1024
const EVIDENCE = "bashwink/data/evidence/evidence.jsonl"

export interface VmProjectBaseFile {
  data: string
  identity: string
  revision: string
  mode: number
  stamp: string
}

type FileMap = Record<string, string>

export interface VmProjectSnapshot {
  token: string
  files: FileMap
  state: FileMap
  sessions: string[]
}

interface ProjectRecord {
  version: 1
  project: string
  identity: string
  revision: string
  profile: string
  base: Record<string, VmProjectBaseFile>
  snapshot?: VmProjectSnapshot
}

export function vmProjectFile(name: string) {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,78}\.(?:ts|js|txt)$/.test(name) &&
    !/(?:^|[-_.])(?:credentials?|secrets?|tokens?|private[-_.]key)(?:[-_.]|$)/i.test(name)
  )
}

export function vmProtectedTest(name: string) {
  return /(?:\.test\.|\.spec\.|^test[-_.])/i.test(name)
}

function stateFile(name: string) {
  return /^bashwink\/(?:opencode\/opencode\.db(?:-wal|-shm)?|data\/(?:evidence\/evidence\.jsonl|bashwink\.sqlite(?:-wal|-shm)?|plans\/[a-zA-Z0-9-]{1,100}\.json|runs\/[a-zA-Z0-9_-]{1,100}\.json|current-plan\.json|active-task))$/.test(
    name,
  )
}

function fileMap(value: unknown, allow: (name: string) => boolean, limit: number): FileMap {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed VM checkpoint file map")
  const entries = Object.entries(value)
  const names = new Set<string>()
  if (entries.length > 128) throw new Error("VM checkpoint contains too many files")
  for (const [name, encoded] of entries) {
    if (!allow(name) || names.has(name.toLowerCase()) || typeof encoded !== "string")
      throw new Error(`disallowed VM checkpoint path: ${name}`)
    names.add(name.toLowerCase())
    const content = Buffer.from(encoded, "base64")
    if (content.length > limit || content.toString("base64") !== encoded)
      throw new Error(`invalid VM checkpoint bytes: ${name}`)
    if (allow === vmProjectFile) {
      new TextDecoder("utf-8", { fatal: true }).decode(content)
      if (content.includes(0)) throw new Error("project staging supports text files only")
    }
  }
  return Object.fromEntries(entries)
}

export function validateVmSnapshot(value: unknown, token?: string): VmProjectSnapshot {
  const raw = value as Partial<VmProjectSnapshot> | undefined
  if (
    !raw ||
    typeof raw.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(raw.token) ||
    (token !== undefined && raw.token !== token) ||
    !Array.isArray(raw.sessions) ||
    raw.sessions.length > 128 ||
    !raw.sessions.every((id) => typeof id === "string" && SESSION_ID.test(id)) ||
    new Set(raw.sessions).size !== raw.sessions.length
  )
    throw new Error("invalid VM checkpoint identity")
  return {
    token: raw.token,
    files: fileMap(raw.files, vmProjectFile, FILE_SIZE),
    state: fileMap(raw.state, stateFile, PAYLOAD_SIZE),
    sessions: raw.sessions,
  }
}

export function writeVmPayload(fd: number, value: object) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > PAYLOAD_SIZE) throw new Error("VM checkpoint exceeds the byte limit")
  const header = Buffer.alloc(512)
  header.write(`BWPROJECT1 ${body.length}\n`)
  if (
    writeSync(fd, body, 0, body.length, PAYLOAD_OFFSET) !== body.length ||
    writeSync(fd, header, 0, header.length, 0) !== header.length
  )
    throw new Error("could not write complete VM checkpoint")
}

function readVmPayload(disk: string): unknown {
  const fd = openSync(disk, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const header = Buffer.alloc(512)
    readSync(fd, header, 0, header.length, 0)
    const match = /^BWPROJECT1 ([1-9]\d{0,7})\n\0*$/.exec(header.toString())
    const length = Number(match?.[1])
    if (!Number.isSafeInteger(length) || length < 1 || length > PAYLOAD_SIZE)
      throw new Error("invalid VM checkpoint length")
    const body = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const size = readSync(fd, body, offset, length - offset, PAYLOAD_OFFSET + offset)
      if (size === 0) throw new Error("truncated stopped VM checkpoint")
      offset += size
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } finally {
    closeSync(fd)
  }
}

function git(project: string, args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], {
    cwd: project,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stderr: "ignore",
    timeout: 3_000,
  })
  if (result.exitCode !== 0)
    throw new Error("VM project import requires a Git checkout with a commit")
  return result.stdout.toString()
}

export function assertVmProjectRevision(project: ReturnType<typeof openVmProject>) {
  if (git(project.project, ["rev-parse", "--verify", "HEAD"]).trim() !== project.record.revision)
    throw new Error("the Git base revision changed after staging")
}

export function vmVerificationSeed(project: ReturnType<typeof openVmProject>) {
  const saved = project.record.snapshot
  if (!saved) throw new Error("no stopped VM checkpoint to verify")
  const files: FileMap = {}
  const verify = Object.keys(project.record.base).filter((name) =>
    /\.(?:test|spec)\.(?:ts|js)$/.test(name),
  )
  if (verify.length === 0)
    throw new Error("no protected tests were present in the enrolled project")
  for (const name of new Set([...Object.keys(project.record.base), ...Object.keys(saved.files)])) {
    try {
      const file = regularFile(path.join(project.project, name), FILE_SIZE)
      if (vmProtectedTest(name) && project.record.base[name]?.revision !== file.revision)
        throw new Error(`protected host test changed: ${name}`)
      files[name] = file.data.toString("base64")
    } catch (error) {
      if (vmProtectedTest(name) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return { token: randomUUID(), files: fileMap(files, vmProjectFile, FILE_SIZE), verify }
}

export function recordVmVerification(
  project: ReturnType<typeof openVmProject>,
  seed: ReturnType<typeof vmVerificationSeed>,
  disk: string,
) {
  const result = readVmPayload(disk) as {
    token?: string
    verification?: { exitCode?: number; output?: string }
  }
  const evidence = result?.verification
  if (
    result?.token !== seed.token ||
    typeof evidence?.exitCode !== "number" ||
    !Number.isInteger(evidence.exitCode) ||
    evidence.exitCode < 0 ||
    evidence.exitCode > 255 ||
    typeof evidence.output !== "string" ||
    Buffer.byteLength(evidence.output) > 64 * 1024
  )
    throw new Error("invalid protected test verification result")
  assertVmProjectRevision(project)
  const current = vmVerificationSeed(project)
  if (JSON.stringify(current.files) !== JSON.stringify(seed.files))
    throw new Error("host project changed during protected verification")
  const record = {
    version: 1,
    revision: project.record.revision,
    tests: seed.verify,
    protectedHashes: Object.fromEntries(
      seed.verify.map((name) => [name, project.record.base[name]!.revision]),
    ),
    sourceHashes: Object.fromEntries(
      Object.entries(seed.files).map(([name, data]) => [name, sha256(Buffer.from(data, "base64"))]),
    ),
    exitCode: evidence.exitCode,
    output: evidence.output,
  }
  writeFileSync(
    path.join(project.root, `verification-${seed.token}.json`),
    JSON.stringify(record, null, 2) + "\n",
    { flag: "wx", mode: 0o600, flush: true },
  )
  syncDirectory(project.root)
  process.stdout.write(
    `Protected tests exited with status ${record.exitCode} (${record.tests.join(", ")})\n`,
  )
  return record.exitCode
}

function readBase(project: string) {
  if (git(project, ["rev-parse", "--show-prefix"]).trim() !== "")
    throw new Error("start VM coding from the Git checkout root")
  const revision = git(project, ["rev-parse", "--verify", "HEAD"]).trim()
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("missing project base revision")
  const names = git(project, ["ls-files", "--cached", "-z"]).split("\0").filter(vmProjectFile)
  if (
    names.length === 0 ||
    names.length > 64 ||
    new Set(names.map((n) => n.toLowerCase())).size !== names.length
  )
    throw new Error("invalid or oversized top-level project file inventory")
  const base = Object.fromEntries(
    names.map((name) => {
      const file = regularFile(path.join(project, name), FILE_SIZE)
      return [name, { ...file, data: file.data.toString("base64") }]
    }),
  )
  fileMap(
    Object.fromEntries(Object.entries(base).map(([name, file]) => [name, file.data])),
    vmProjectFile,
    FILE_SIZE,
  )
  return { base, revision }
}

export function openVmProject(profile?: string) {
  const project = realpathSync(process.cwd())
  const identity = directoryIdentity(project)
  const parent = path.join(paths().data, "vm-projects")
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = path.join(realpathSync(parent), sha256(`${project}\0${identity}`))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  directoryIdentity(root)
  const metadata = lstatSync(root)
  if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
    throw new Error("VM project state directory is not private")
  const lifetime = acquireNativeLifetime(root, true)
  try {
    const filename = path.join(root, "checkpoint.json")
    let record: ProjectRecord
    let saved: Buffer | undefined
    try {
      saved = regularFile(filename, 100 * 1024 * 1024).data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (saved) {
      try {
        const envelope = JSON.parse(saved.toString()) as {
          payload?: unknown
          digest?: unknown
        } | null
        if (typeof envelope?.payload !== "string" || sha256(envelope.payload) !== envelope.digest)
          throw new Error("invalid checkpoint digest")
        record = JSON.parse(envelope.payload)
        if (!record || typeof record !== "object") throw new Error("invalid checkpoint object")
      } catch {
        throw new Error("VM project checkpoint is corrupt")
      }
      if (
        record.version !== 1 ||
        record.project !== project ||
        record.identity !== identity ||
        (profile !== undefined && profile !== record.profile)
      )
        throw new Error("VM project or runtime identity changed")
      if (record.snapshot) record.snapshot = validateVmSnapshot(record.snapshot)
    } else {
      if (profile === undefined) throw new Error("no saved VM project to review")
      record = { version: 1, project, identity, profile, ...readBase(project) }
    }
    return { root, project, record, lifetime, filename }
  } catch (error) {
    lifetime.close()
    throw error
  }
}

export function vmProjectSeed(record: ProjectRecord, resume?: string) {
  const saved = record.snapshot
  if (
    resume &&
    (!saved ||
      saved.sessions.length === 0 ||
      (resume !== "continue" && !saved.sessions.includes(resume)))
  )
    throw new Error("no saved session owned by this VM project")
  return {
    token: randomUUID(),
    files:
      saved?.files ??
      Object.fromEntries(Object.entries(record.base).map(([name, file]) => [name, file.data])),
    state: saved?.state,
    resume,
  }
}

export function commitVmProject(
  project: ReturnType<typeof openVmProject>,
  disk: string,
  token: string,
) {
  const snapshot = validateVmSnapshot(readVmPayload(disk), token)
  for (const name of new Set([
    ...Object.keys(project.record.base),
    ...Object.keys(snapshot.files),
  ])) {
    if (vmProtectedTest(name) && project.record.base[name]?.data !== snapshot.files[name])
      throw new Error(`protected test changed inside the VM: ${name}`)
  }
  const evidence = Buffer.from(snapshot.state[EVIDENCE] ?? "", "base64")
  const previous = Buffer.from(project.record.snapshot?.state[EVIDENCE] ?? "", "base64")
  if (
    evidence.length <= previous.length ||
    !evidence.subarray(0, previous.length).equals(previous) ||
    !verifyText(evidence.toString("utf8")).ok ||
    !evidence
      .subarray(previous.length)
      .toString("utf8")
      .split("\n")
      .some((line) => line.includes('"phase":"boot"'))
  )
    throw new Error("VM checkpoint does not extend the verified evidence chain with a fresh boot")
  const payload = JSON.stringify({ ...project.record, snapshot })
  const temporary = path.join(project.root, `.checkpoint-${randomUUID()}`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ payload, digest: sha256(payload) }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, project.filename)
  syncDirectory(project.root)
  if (snapshot.sessions.length > 0)
    process.stdout.write(`Saved VM sessions: ${snapshot.sessions.join(", ")}\n`)
}
