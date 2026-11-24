import { dlopen } from "bun:ffi"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  captureEvidence,
  directoryIdentity,
  readStage,
  regularFile,
  writeStage,
} from "./native-stage.js"

const LOCK_FILE = ".lifetime"
const PROOF_FILE = "quiescence.json"
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4

export function acquireNativeLifetime(root: string, create: boolean) {
  if (process.platform !== "darwin") throw new Error("native stage lifetime requires macOS")
  const filename = path.join(root, LOCK_FILE)
  const fd = openSync(
    filename,
    constants.O_RDWR |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (create ? constants.O_CREAT : 0),
    0o600,
  )
  try {
    const info = fstatSync(fd)
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("offline stage lifetime descriptor is not a private regular file")
    const darwin = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: ["i32", "i32"], returns: "i32" },
    })
    try {
      if (darwin.symbols.flock(fd, LOCK_EXCLUSIVE_NONBLOCKING) !== 0)
        throw new Error("offline stage lifetime is still held or cannot be verified")
    } finally {
      darwin.close()
    }
    return {
      fd,
      filename,
      inode: String(info.ino),
      identity: `${info.dev}:${info.ino}`,
      // Close only. LOCK_UN would release the same lock reference held by live children.
      close: () => closeSync(fd),
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

type Lifetime = ReturnType<typeof acquireNativeLifetime>

export function verifyNativeHolder(lifetime: Lifetime, pid: number) {
  // Inspect an already-owned child, never signal a process named in an on-disk record.
  const deadline = performance.now() + 1_500
  const executable = path.join(path.dirname(lifetime.filename), "opencode")
  do {
    const found = Bun.spawnSync(
      ["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "3,txt", "-Ffin"],
      { timeout: 1_500, stderr: "ignore" },
    )
    const records = found.stdout.toString().split(/(?=^f)/m)
    if (
      found.exitCode === 0 &&
      records.some(
        (record) => record.startsWith("ftxt\n") && record.split("\n").includes(`n${executable}`),
      ) &&
      records.some(
        (record) =>
          record.startsWith("f3\n") &&
          record.split("\n").includes(`i${lifetime.inode}`) &&
          record.split("\n").includes(`n${lifetime.filename}`),
      )
    )
      return
    Bun.sleepSync(20)
  } while (performance.now() < deadline)
  throw new Error("owned offline process did not retain its lifetime descriptor after exec")
}

export function recordNativeLifetime(
  root: string,
  lifetime: Lifetime,
  runId: string,
  profile: string,
) {
  const file = path.join(root, ".active", PROOF_FILE)
  const fd = openSync(file, "wx", 0o600)
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        version: 1,
        kind: "file-only-run",
        rootId: directoryIdentity(root),
        lockId: lifetime.identity,
        profile,
        runId,
      }) + "\n",
    )
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function retireNativeActivation(root: string, record = PROOF_FILE) {
  const active = path.join(root, ".active")
  const retired = path.join(root, `.retired-${randomUUID()}`)
  const files = readdirSync(active)
  if (files.some((file) => file !== record))
    throw new Error("unrecognized native activation contents")
  // Atomically retire the interlock. Interrupted housekeeping cannot authorize a launch.
  renameSync(active, retired)
  for (const file of files) unlinkSync(path.join(retired, file))
  rmdirSync(retired)
}

function retireReadiness(root: string) {
  const scopes = path.join(root, "scratch", "scopes")
  directoryIdentity(scopes)
  for (const name of readdirSync(scopes)) {
    if (!/^\.readiness-[A-Za-z0-9]+$/.test(name))
      throw new Error("unrecognized entry in offline readiness directory")
    const directory = path.join(scopes, name)
    directoryIdentity(directory)
    const entries = readdirSync(directory)
    if (
      !entries.every(
        (entry) =>
          ["ready.json", "ready.json.pending", "retire"].includes(entry) &&
          lstatSync(path.join(directory, entry)).isFile(),
      )
    )
      throw new Error("unrecognized offline readiness proof contents")
    for (const entry of entries) unlinkSync(path.join(directory, entry))
    rmdirSync(directory)
  }
}

export function recoverClosedNativeStage(root: string): boolean {
  readStage(root)
  const lifetime = acquireNativeLifetime(root, false)
  try {
    const state = readStage(root)
    const active = path.join(root, ".active")
    try {
      directoryIdentity(active)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
    const files = readdirSync(active)
    if (files.length !== 1 || files[0] !== PROOF_FILE || state.destination === undefined)
      throw new Error("interrupted stage has no verified native writer proof")
    const proof = JSON.parse(regularFile(path.join(active, PROOF_FILE), 8192).data.toString()) as {
      version?: unknown
      kind?: unknown
      rootId?: unknown
      lockId?: unknown
      profile?: unknown
      runId?: unknown
    }
    if (
      proof.version !== 1 ||
      proof.kind !== "file-only-run" ||
      proof.rootId !== state.rootId ||
      proof.lockId !== lifetime.identity ||
      proof.profile !== state.profile ||
      typeof proof.runId !== "string" ||
      !/^run_[0-9]+_[a-f0-9]+$/.test(proof.runId)
    )
      throw new Error("interrupted stage has no verified native writer proof")

    // A second independent open got the exclusive lock. Our pinned no-fork processes
    // were proved to hold it before admission, so there is no admitted writer left.
    const evidence = captureEvidence(root, state.evidence)
    retireReadiness(root)
    try {
      unlinkSync(path.join(root, "opencode"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    writeStage(root, { ...state, evidence })
    retireNativeActivation(root)
    return true
  } finally {
    lifetime.close()
  }
}
