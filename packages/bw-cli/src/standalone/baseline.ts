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

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

function isProtectedBaselineFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/")
  const base = path.posix.basename(normalized)
  return base === "package.json" || isTestPath(normalized)
}

export function collectProtectedFileHashes(workspace: string): Readonly<Record<string, string>> {
  const hashes: Record<string, string> = {}

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      let st
      try {
        st = lstatSync(fullPath)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(fullPath)
        continue
      }
      if (!st.isFile()) continue
      const rel = path.relative(workspace, fullPath).replace(/\\/g, "/")
      if (!isProtectedBaselineFile(rel)) continue
      try {
        const bytes = readFileSync(fullPath)
        hashes[rel] = sha256Buffer(bytes)
      } catch {
        // Ignore unreadable file during snapshot.
      }
    }
  }

  walk(workspace)
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
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
    if (entry.startsWith("\"") && entry.endsWith("\"") && entry.length >= 2) {
      entry = entry.slice(1, -1)
    }
    if (entry !== "") files.add(entry.replace(/\\/g, "/"))
  }
  return [...files].sort()
}

export function captureWorkspaceBaseline(workspace: string): WorkspaceBaseline {
  const insideWorkTree = runGit(workspace, ["rev-parse", "--is-inside-work-tree"])
  const protectedTestHashes = collectProtectedFileHashes(workspace)

  if (insideWorkTree !== "true") {
    return {
      capturedAt: new Date().toISOString(),
      gitHead: null,
      gitBranch: null,
      dirtyFiles: [],
      protectedTestHashes,
      mode: "filesystem",
    }
  }

  const head = runGit(workspace, ["rev-parse", "HEAD"])
  const branchRaw = runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])
  const statusRes = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5000,
  })
  const dirtyFiles =
    statusRes.status === 0 && typeof statusRes.stdout === "string"
      ? parseDirtyPorcelain(statusRes.stdout)
      : []

  return {
    capturedAt: new Date().toISOString(),
    gitHead: head && /^[0-9a-f]{7,40}$/i.test(head) ? head : null,
    gitBranch: branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    dirtyFiles,
    protectedTestHashes,
    mode: "git",
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
