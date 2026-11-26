/**
 * Immutable workspace baseline capture and protected test-file hashing (BW-057).
 *
 * Supports both Git worktrees (`git rev-parse HEAD`, dirty status) and plain directories
 * (`mode: "filesystem"`), hashing protected test files and `package.json` without following
 * symlinks or traversing `.git`, `node_modules`, or build directories.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { isTestPath } from "./security.ts"
import type { WorkspaceBaseline } from "./types.ts"

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".standalone-dist"])
const DEFAULT_BASELINE_MAX_FILES = 20_000
const DEFAULT_BASELINE_MAX_ELAPSED_MS = 5_000
const MAX_BASELINE_HASH_BYTES = 2 * 1024 * 1024

export interface BaselineScanOptions {
  readonly maxFiles?: number
  readonly maxElapsedMs?: number
  readonly signal?: AbortSignal
}

export interface ProtectedHashCollection {
  readonly hashes: Readonly<Record<string, string>>
  readonly partial: boolean
  readonly partialReason?: string
  readonly visitedEntries: number
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

function isProtectedBaselineFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/")
  const base = path.posix.basename(normalized)
  return base === "package.json" || isTestPath(normalized)
}

export function collectProtectedFileHashesBounded(
  workspace: string,
  options: BaselineScanOptions = {},
): ProtectedHashCollection {
  const hashes: Record<string, string> = {}
  const maxFiles = options.maxFiles ?? DEFAULT_BASELINE_MAX_FILES
  const maxElapsedMs = options.maxElapsedMs ?? DEFAULT_BASELINE_MAX_ELAPSED_MS
  const started = Date.now()
  let visitedEntries = 0
  let partial = false
  let partialReason: string | undefined

  const queue: string[] = [workspace]
  while (queue.length > 0) {
    if (options.signal?.aborted) {
      partial = true
      partialReason = "cancelled"
      break
    }
    if (Date.now() - started >= maxElapsedMs) {
      partial = true
      partialReason = `time_budget_${maxElapsedMs}ms`
      break
    }
    const dir = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    } catch {
      continue
    }
    for (const entry of entries) {
      if (options.signal?.aborted) {
        partial = true
        partialReason = "cancelled"
        break
      }
      if (visitedEntries >= maxFiles) {
        partial = true
        partialReason = `file_limit_${maxFiles}`
        break
      }
      if (Date.now() - started >= maxElapsedMs) {
        partial = true
        partialReason = `time_budget_${maxElapsedMs}ms`
        break
      }
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      let st
      try {
        st = lstatSync(fullPath)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      visitedEntries += 1
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(fullPath)
        continue
      }
      if (!st.isFile()) continue
      const rel = path.relative(workspace, fullPath).replace(/\\/g, "/")
      if (!isProtectedBaselineFile(rel)) continue
      if (st.size > MAX_BASELINE_HASH_BYTES) {
        partial = true
        partialReason = `oversized_protected_file:${rel}`
        continue
      }
      try {
        const bytes = readFileSync(fullPath)
        hashes[rel] = sha256Buffer(bytes)
      } catch {
        // Ignore unreadable file during snapshot.
      }
    }
    if (partial) break
  }

  return {
    hashes: Object.fromEntries(
      Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    partial,
    ...(partialReason !== undefined ? { partialReason } : {}),
    visitedEntries,
  }
}

export function collectProtectedFileHashes(
  workspace: string,
  options: BaselineScanOptions = {},
): Readonly<Record<string, string>> {
  return collectProtectedFileHashesBounded(workspace, options).hashes
}

function runGit(workspace: string, args: readonly string[]): string | null {
  try {
    const res = spawnSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 5000,
    })
    if (res.status !== 0 || typeof res.stdout !== "string") return null
    return res.stdout.trim()
  } catch {
    return null
  }
}

function parseDirtyPorcelain(statusText: string): readonly string[] {
  const files = new Set<string>()
  for (const rawLine of statusText.split(/\r?\n/)) {
    if (rawLine.length < 4) continue
    let entry = rawLine.slice(3).trim()
    const arrowIdx = entry.indexOf(" -> ")
    if (arrowIdx >= 0) entry = entry.slice(arrowIdx + 4).trim()
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2) {
      entry = entry.slice(1, -1)
    }
    if (entry !== "") files.add(entry.replace(/\\/g, "/"))
  }
  return [...files].sort()
}

export function captureWorkspaceBaseline(
  workspace: string,
  options: BaselineScanOptions = {},
): WorkspaceBaseline {
  const insideWorkTree = runGit(workspace, ["rev-parse", "--is-inside-work-tree"])
  const scan = collectProtectedFileHashesBounded(workspace, options)
  const protectedTestHashes = scan.hashes

  if (insideWorkTree !== "true") {
    return {
      capturedAt: new Date().toISOString(),
      gitHead: null,
      gitBranch: null,
      dirtyFiles: [],
      protectedTestHashes,
      mode: "filesystem",
      ...(scan.partial
        ? { partial: true, ...(scan.partialReason ? { partialReason: scan.partialReason } : {}) }
        : {}),
    }
  }

  const head = runGit(workspace, ["rev-parse", "HEAD"])
  const branchRaw = runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])
  const statusRes = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5000,
  })
  const statusOk = statusRes.status === 0 && typeof statusRes.stdout === "string"
  const dirtyFiles = statusOk ? parseDirtyPorcelain(statusRes.stdout) : []
  const validHead = head && /^[0-9a-f]{7,40}$/i.test(head) ? head : null
  const gitError = !statusOk
    ? `git status failed (exit ${statusRes.status ?? "unknown"})`
    : validHead === null
      ? "git HEAD could not be resolved (unborn or corrupted repository)"
      : undefined

  return {
    capturedAt: new Date().toISOString(),
    gitHead: validHead,
    gitBranch: branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    dirtyFiles,
    protectedTestHashes,
    mode: "git",
    ...(scan.partial
      ? { partial: true, ...(scan.partialReason ? { partialReason: scan.partialReason } : {}) }
      : {}),
    ...(gitError !== undefined ? { gitError } : {}),
  }
}

export interface ProtectedBaselineDelta {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
  readonly afterHashes: Readonly<Record<string, string>>
}

export function diffProtectedHashes(
  beforeHashes: Readonly<Record<string, string>>,
  afterHashes: Readonly<Record<string, string>>,
): ProtectedBaselineDelta {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [file, hash] of Object.entries(beforeHashes)) {
    const after = afterHashes[file]
    if (after === undefined) deleted.push(file)
    else if (after !== hash) modified.push(file)
  }
  for (const file of Object.keys(afterHashes)) {
    if (beforeHashes[file] === undefined) added.push(file)
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    afterHashes,
  }
}

export function diffProtectedBaseline(
  workspace: string,
  baseline: WorkspaceBaseline,
): ProtectedBaselineDelta {
  return diffProtectedHashes(baseline.protectedTestHashes, collectProtectedFileHashes(workspace))
}
