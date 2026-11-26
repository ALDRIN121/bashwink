/**
 * Persistent standalone session store, checkpoint snapshots, rewind/fork helpers,
 * prompt history, and workspace file discovery for `@` mentions.
 *
 * Pure Node 22+ built-ins only; respects workspace trust and path boundaries on restore.
 */

import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { checkWorkspaceWritePath, sanitizeSecretText, type BoundaryContext } from "./security.ts"
import type {
  ChatMessage,
  CommandOutcomeRecord,
  DiffPreviewRecord,
  RunActionRecord,
  RunSummaryRecord,
  TaskResult,
} from "./types.ts"

export const SESSION_SCHEMA_VERSION = 1
const MAX_CHECKPOINT_BYTES = 1024 * 1024
const MAX_HISTORY_ENTRIES = 500
const MAX_STORED_SESSIONS = 200
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 1500
const LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

export interface FileCheckpoint {
  readonly relativePath: string
  readonly existedBefore: boolean
  readonly contentBase64?: string
  readonly sha256Before?: string
  readonly sha256After?: string
  readonly mode?: number
  readonly omittedReason?: string
}

export interface SessionTurn {
  readonly id: string
  readonly createdAt: string
  readonly userPrompt: string
  readonly assistantText: string
  readonly outcome: TaskResult["outcome"]
  readonly stopReason?: string
  readonly runId: string
  readonly model: string
  readonly messageCountBefore: number
  readonly requests?: number
  readonly guardianRequests?: number
  readonly changedFiles: readonly string[]
  readonly diffPreviews?: readonly DiffPreviewRecord[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly actions: readonly RunActionRecord[]
  readonly checkpoints: readonly FileCheckpoint[]
  readonly usage: RunSummaryRecord["usage"]
}

export interface SessionRecord {
  readonly version: 1
  readonly id: string
  readonly title: string
  readonly customTitle?: boolean
  readonly workspace: string
  readonly gitBranch?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly archived?: boolean
  readonly pinned?: boolean
  readonly parentSessionId?: string
  readonly forkedFromTurnId?: string
  readonly messages: readonly ChatMessage[]
  readonly turns: readonly SessionTurn[]
  readonly historyArchive?: {
    readonly messages: readonly ChatMessage[]
    readonly turnMessageOffsets: readonly number[]
  }
  readonly usageTotals: {
    readonly requests: number
    readonly guardianRequests?: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
    readonly costUsd?: number
  }
}

export interface SessionIndexEntry {
  readonly id: string
  readonly title: string
  readonly customTitle?: boolean
  readonly workspace: string
  readonly gitBranch?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly archived?: boolean
  readonly pinned?: boolean
  readonly turnCount: number
  readonly usageTotals: SessionRecord["usageTotals"]
}

export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions")
}

export function sessionFilePath(dataDir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")
  return path.join(sessionsDir(dataDir), `${safeId}.json`)
}

export function detectGitBranch(workspace: string): string | undefined {
  for (const gitBin of ["git", "/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"]) {
    try {
      const res = spawnSync(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 800,
      })
      if (res.status === 0) {
        const branch = res.stdout.trim()
        if (branch && branch !== "HEAD") return branch
      }
      if (res.status !== undefined) return undefined
    } catch {
      // Try next git candidate
    }
  }
  return undefined
}

export function createSession(workspace: string, gitBranch?: string): SessionRecord {
  const now = new Date().toISOString()
  const stamp = now.slice(0, 19).replace(/[-:T]/g, "")
  const id = `ses_${stamp}_${randomBytes(3).toString("hex")}`
  return {
    version: SESSION_SCHEMA_VERSION,
    id,
    title: "New session",
    workspace,
    ...(gitBranch ? { gitBranch } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [],
    usageTotals: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  }
}

function sanitizeUnknownSecret(value: unknown, activeSecret?: string, depth = 0): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]"
  if (typeof value === "string") return sanitizeSecretText(value, activeSecret)
  if (Array.isArray(value))
    return value.map((item) => sanitizeUnknownSecret(item, activeSecret, depth + 1))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeUnknownSecret(v, activeSecret, depth + 1)
    }
    return out
  }
  return value
}

function sanitizeChatMessages(
  messages: readonly ChatMessage[],
  activeSecret?: string,
): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return {
        role: "assistant",
        content: sanitizeSecretText(msg.content, activeSecret),
        ...(msg.toolCalls
          ? {
              toolCalls: msg.toolCalls.map((tc) => ({
                ...tc,
                input: sanitizeUnknownSecret(tc.input, activeSecret) as Record<string, unknown>,
                ...(tc.rawArguments !== undefined
                  ? { rawArguments: sanitizeSecretText(tc.rawArguments, activeSecret) }
                  : {}),
              })),
            }
          : {}),
      }
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        callId: msg.callId,
        name: msg.name,
        content: sanitizeSecretText(msg.content, activeSecret),
        ...(msg.isError === undefined ? {} : { isError: msg.isError }),
      }
    }
    return {
      role: msg.role,
      content: sanitizeSecretText(msg.content, activeSecret),
    }
  })
}

export function deriveSessionTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim()
  if (clean === "") return "Untitled session"
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean
}

function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(LOCK_SLEEP_BUF, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Fallback busy wait if SharedArrayBuffer Atomics unavailable
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

function withFileLock<T>(lockPath: string, fn: () => T): T {
  const dir = path.dirname(lockPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let acquired = false
  while (Date.now() <= deadline) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
        0o600,
      )
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf8")
      } finally {
        closeSync(fd)
      }
      acquired = true
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "EEXIST") throw err
      try {
        const st = statSync(lockPath)
        const content = readFileSync(lockPath, "utf8")
        const ownerPid = Number(content.split("\n")[0]?.trim())
        const staleAge = Date.now() - st.mtimeMs > LOCK_STALE_MS
        const deadPid = Number.isInteger(ownerPid) && ownerPid > 0 && !isPidAlive(ownerPid)
        if (staleAge || deadPid) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // Lock removed concurrently; retry immediately
        continue
      }
      sleepSyncMs(10)
    }
  }
  try {
    return fn()
  } finally {
    if (acquired) {
      try {
        unlinkSync(lockPath)
      } catch {
        // Best-effort unlock
      }
    }
  }
}

function sessionsIndexFile(dataDir: string): string {
  return path.join(sessionsDir(dataDir), "sessions-index.json")
}

function toIndexEntry(session: SessionRecord): SessionIndexEntry {
  return {
    id: session.id,
    title: session.title,
    ...(session.customTitle === undefined ? {} : { customTitle: session.customTitle }),
    workspace: session.workspace,
    ...(session.gitBranch === undefined ? {} : { gitBranch: session.gitBranch }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.archived === undefined ? {} : { archived: session.archived }),
    ...(session.pinned === undefined ? {} : { pinned: session.pinned }),
    turnCount: session.turns.length,
    usageTotals: session.usageTotals,
  }
}

function writeAtomicJson(targetPath: string, payload: unknown): void {
  const dir = path.dirname(targetPath)
  const temp = path.join(dir, `.tmp.${process.pid}.${randomBytes(4).toString("hex")}.json`)
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, targetPath)
}

function loadRawIndex(dataDir: string): Record<string, SessionIndexEntry> {
  const idxFile = sessionsIndexFile(dataDir)
  if (!existsSync(idxFile)) return {}
  try {
    const parsed = JSON.parse(readFileSync(idxFile, "utf8")) as Record<string, unknown>
    if (parsed["version"] !== SESSION_SCHEMA_VERSION) return {}
    const entries = parsed["entries"]
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {}
    return entries as Record<string, SessionIndexEntry>
  } catch {
    return {}
  }
}

function isValidChatMessage(val: unknown): val is ChatMessage {
  if (typeof val !== "object" || val === null) return false
  const rec = val as Record<string, unknown>
  if (
    rec["role"] !== "system" &&
    rec["role"] !== "user" &&
    rec["role"] !== "assistant" &&
    rec["role"] !== "tool"
  ) {
    return false
  }
  return typeof rec["content"] === "string"
}

function validateSessionRecord(parsed: unknown): SessionRecord | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const rec = parsed as Record<string, unknown>
  if (rec["version"] !== SESSION_SCHEMA_VERSION) return undefined
  if (
    typeof rec["id"] !== "string" ||
    rec["id"].trim() === "" ||
    typeof rec["workspace"] !== "string" ||
    rec["workspace"].trim() === "" ||
    typeof rec["title"] !== "string" ||
    typeof rec["createdAt"] !== "string" ||
    typeof rec["updatedAt"] !== "string"
  ) {
    return undefined
  }
  if (!Array.isArray(rec["messages"]) || !rec["messages"].every(isValidChatMessage)) {
    return undefined
  }
  if (!Array.isArray(rec["turns"])) return undefined
  for (const turn of rec["turns"]) {
    if (typeof turn !== "object" || turn === null) return undefined
    const t = turn as Record<string, unknown>
    if (
      typeof t["id"] !== "string" ||
      typeof t["userPrompt"] !== "string" ||
      typeof t["assistantText"] !== "string" ||
      typeof t["messageCountBefore"] !== "number" ||
      !Number.isFinite(t["messageCountBefore"]) ||
      t["messageCountBefore"] < 0 ||
      !Array.isArray(t["checkpoints"]) ||
      !Array.isArray(t["commands"])
    ) {
      return undefined
    }
  }
  const totals = rec["usageTotals"]
  if (typeof totals !== "object" || totals === null || Array.isArray(totals)) return undefined
  const u = totals as Record<string, unknown>
  if (
    typeof u["requests"] !== "number" ||
    typeof u["inputTokens"] !== "number" ||
    typeof u["outputTokens"] !== "number" ||
    typeof u["totalTokens"] !== "number"
  ) {
    return undefined
  }
  return parsed as SessionRecord
}

export function saveSession(
  dataDir: string,
  session: SessionRecord,
  activeSecret?: string,
): string {
  const dir = sessionsDir(dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sanitized: SessionRecord = {
    ...session,
    title: sanitizeSecretText(session.title, activeSecret),
    messages: sanitizeChatMessages(session.messages, activeSecret),
    ...(session.historyArchive
      ? {
          historyArchive: {
            messages: sanitizeChatMessages(session.historyArchive.messages, activeSecret),
            turnMessageOffsets: [...session.historyArchive.turnMessageOffsets],
          },
        }
      : {}),
    turns: session.turns.map((t) => ({
      ...t,
      userPrompt: sanitizeSecretText(t.userPrompt, activeSecret),
      assistantText: sanitizeSecretText(t.assistantText, activeSecret),
      commands: t.commands.map((c) => ({
        ...c,
        command: sanitizeSecretText(c.command, activeSecret),
        args: c.args.map((a) => sanitizeSecretText(a, activeSecret)),
      })),
      ...(t.actions
        ? {
            actions: t.actions.map((a) => ({
              ...a,
              summary: sanitizeSecretText(a.summary, activeSecret),
            })),
          }
        : {}),
      ...(t.diffPreviews
        ? {
            diffPreviews: t.diffPreviews.map((d) => ({
              ...d,
              patch: sanitizeSecretText(d.patch, activeSecret),
            })),
          }
        : {}),
      ...(t.stopReason === undefined
        ? {}
        : { stopReason: sanitizeSecretText(t.stopReason, activeSecret) }),
    })),
  }
  const target = sessionFilePath(dataDir, sanitized.id)
  const lockPath = path.join(dir, ".sessions.lock")
  withFileLock(lockPath, () => {
    writeAtomicJson(target, sanitized)
    const entries = loadRawIndex(dataDir)
    entries[sanitized.id] = toIndexEntry(sanitized)
    writeAtomicJson(sessionsIndexFile(dataDir), {
      version: SESSION_SCHEMA_VERSION,
      entries,
    })
  })
  return target
}

export function loadSession(dataDir: string, sessionId: string): SessionRecord | undefined {
  const file = sessionFilePath(dataDir, sessionId)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return validateSessionRecord(parsed)
  } catch {
    return undefined
  }
}

export function deleteSession(dataDir: string, sessionId: string): boolean {
  const dir = sessionsDir(dataDir)
  const file = sessionFilePath(dataDir, sessionId)
  if (!existsSync(file)) return false
  return withFileLock(path.join(dir, ".sessions.lock"), () => {
    try {
      if (!existsSync(file)) return false
      unlinkSync(file)
      const entries = loadRawIndex(dataDir)
      if (sessionId in entries) {
        delete entries[sessionId]
        writeAtomicJson(sessionsIndexFile(dataDir), {
          version: SESSION_SCHEMA_VERSION,
          entries,
        })
      }
      return true
    } catch {
      return false
    }
  })
}

export function listSessionSummaries(
  dataDir: string,
  options: { readonly workspace?: string; readonly includeArchived?: boolean } = {},
): SessionIndexEntry[] {
  const dir = sessionsDir(dataDir)
  if (!existsSync(dir)) return []
  let entriesOnDisk: string[]
  try {
    entriesOnDisk = readdirSync(dir)
  } catch {
    return []
  }
  const diskIds = new Set<string>()
  const idToFile = new Map<string, string>()
  for (const name of entriesOnDisk) {
    if (!name.endsWith(".json") || name.startsWith(".") || name === "sessions-index.json") continue
    const id = name.slice(0, -5)
    diskIds.add(id)
    idToFile.set(id, name)
  }

  const index = loadRawIndex(dataDir)
  let indexDirty = false
  for (const id of Object.keys(index)) {
    if (!diskIds.has(id)) {
      delete index[id]
      indexDirty = true
    }
  }
  for (const [id, name] of idToFile) {
    if (!(id in index)) {
      try {
        const rec = validateSessionRecord(JSON.parse(readFileSync(path.join(dir, name), "utf8")))
        if (rec) {
          index[rec.id] = toIndexEntry(rec)
          indexDirty = true
        }
      } catch {
        // Ignore corrupt session file
      }
    }
  }
  if (indexDirty) {
    try {
      withFileLock(path.join(dir, ".sessions.lock"), () => {
        writeAtomicJson(sessionsIndexFile(dataDir), {
          version: SESSION_SCHEMA_VERSION,
          entries: index,
        })
      })
    } catch {
      // Best-effort index refresh
    }
  }

  const targetWs = options.workspace ? path.resolve(options.workspace) : undefined
  const out = Object.values(index).filter((entry) => {
    if (!options.includeArchived && entry.archived) return false
    if (targetWs && path.resolve(entry.workspace) !== targetWs) return false
    return true
  })
  out.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return out.slice(0, MAX_STORED_SESSIONS)
}

export function listSessions(
  dataDir: string,
  options: { readonly workspace?: string; readonly includeArchived?: boolean } = {},
): SessionRecord[] {
  const summaries = listSessionSummaries(dataDir, options)
  const out: SessionRecord[] = []
  for (const summary of summaries) {
    const full = loadSession(dataDir, summary.id)
    if (full) out.push(full)
  }
  return out
}

export function appendTurnToSession(
  session: SessionRecord,
  turnInput: {
    readonly userPrompt: string
    readonly result: TaskResult
    readonly model: string
    readonly checkpoints: readonly FileCheckpoint[]
  },
): SessionRecord {
  const now = new Date().toISOString()
  const messageCountBefore = session.messages.length
  const delta = turnInput.result.messages ?? [
    { role: "user" as const, content: turnInput.userPrompt },
    ...(turnInput.result.finalText
      ? [{ role: "assistant" as const, content: turnInput.result.finalText }]
      : []),
  ]
  const turn: SessionTurn = {
    id: `turn_${session.turns.length + 1}`,
    createdAt: now,
    userPrompt: turnInput.userPrompt,
    assistantText: turnInput.result.finalText,
    outcome: turnInput.result.outcome,
    ...(turnInput.result.stopReason === undefined
      ? {}
      : { stopReason: turnInput.result.stopReason }),
    runId: turnInput.result.runId,
    model: turnInput.model,
    messageCountBefore,
    requests: turnInput.result.requests,
    ...(turnInput.result.guardianRequests !== undefined
      ? { guardianRequests: turnInput.result.guardianRequests }
      : {}),
    changedFiles: [...turnInput.result.changedFiles],
    ...(turnInput.result.diffPreviews ? { diffPreviews: [...turnInput.result.diffPreviews] } : {}),
    commands: [...turnInput.result.commands],
    actions: [...(turnInput.result.actions ?? [])],
    checkpoints: [...turnInput.checkpoints],
    usage: turnInput.result.usage,
  }
  const nextTitle =
    !session.customTitle && session.turns.length === 0
      ? deriveSessionTitle(turnInput.userPrompt)
      : session.title
  const nextCost =
    session.usageTotals.costUsd !== undefined || turnInput.result.usage.costUsd !== undefined
      ? Number(
          ((session.usageTotals.costUsd ?? 0) + (turnInput.result.usage.costUsd ?? 0)).toFixed(6),
        )
      : undefined
  const totalGuardian =
    (session.usageTotals.guardianRequests ?? 0) + (turnInput.result.guardianRequests ?? 0)
  return {
    ...session,
    title: nextTitle,
    updatedAt: now,
    messages: [...session.messages, ...delta],
    ...(session.historyArchive
      ? {
          historyArchive: {
            messages: [...session.historyArchive.messages, ...delta],
            turnMessageOffsets: [
              ...session.historyArchive.turnMessageOffsets,
              session.historyArchive.messages.length,
            ],
          },
        }
      : {}),
    turns: [...session.turns, turn],
    usageTotals: {
      requests: session.usageTotals.requests + turnInput.result.requests,
      ...(totalGuardian > 0 ? { guardianRequests: totalGuardian } : {}),
      inputTokens: session.usageTotals.inputTokens + turnInput.result.usage.inputTokens,
      outputTokens: session.usageTotals.outputTokens + turnInput.result.usage.outputTokens,
      totalTokens: session.usageTotals.totalTokens + turnInput.result.usage.totalTokens,
      ...(nextCost === undefined ? {} : { costUsd: nextCost }),
    },
  }
}

export function forkSession(source: SessionRecord, upToTurnCount?: number): SessionRecord {
  const count =
    upToTurnCount === undefined
      ? source.turns.length
      : Math.max(0, Math.min(upToTurnCount, source.turns.length))
  const keptTurns = source.turns.slice(0, count)
  const cutTurn = source.turns[count]
  const archiveOffset =
    count < source.turns.length ? source.historyArchive?.turnMessageOffsets[count] : undefined
  const keptMessages =
    archiveOffset !== undefined && source.historyArchive
      ? source.historyArchive.messages.slice(0, archiveOffset)
      : cutTurn
        ? source.messages.slice(0, cutTurn.messageCountBefore)
        : [...source.messages]
  const adjustedTurns =
    archiveOffset !== undefined && source.historyArchive
      ? keptTurns.map((t, idx) => ({
          ...t,
          messageCountBefore:
            source.historyArchive!.turnMessageOffsets[idx] ?? t.messageCountBefore,
        }))
      : keptTurns
  const base = createSession(source.workspace, source.gitBranch)
  const forkedFrom = adjustedTurns.at(-1)?.id
  return {
    ...base,
    title: `${source.title} (fork)`,
    customTitle: true,
    parentSessionId: source.id,
    ...(forkedFrom === undefined ? {} : { forkedFromTurnId: forkedFrom }),
    messages: keptMessages,
    turns: adjustedTurns,
    usageTotals: adjustedTurns.reduce(
      (acc, t) => {
        const nextGuardian = (acc.guardianRequests ?? 0) + (t.guardianRequests ?? 0)
        return {
          requests: acc.requests + (t.requests ?? 1),
          ...(nextGuardian > 0 ? { guardianRequests: nextGuardian } : {}),
          inputTokens: acc.inputTokens + t.usage.inputTokens,
          outputTokens: acc.outputTokens + t.usage.outputTokens,
          totalTokens: acc.totalTokens + t.usage.totalTokens,
          ...(acc.costUsd !== undefined || t.usage.costUsd !== undefined
            ? { costUsd: Number(((acc.costUsd ?? 0) + (t.usage.costUsd ?? 0)).toFixed(6)) }
            : {}),
        }
      },
      {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      } as SessionRecord["usageTotals"],
    ),
  }
}

const SENSITIVE_CHECKPOINT_SEGMENTS = [
  /(?:^|\/)\.env(?:\.[^/]+)?$/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.aws(?:\/|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.pypirc$/i,
  /(?:^|\/)\.netrc$/i,
  /\.(?:pem|key|p12|pfx)$/i,
]

function isSensitiveCheckpointFile(
  relativePath: string,
  content: Buffer,
  activeSecret?: string,
): boolean {
  const norm = relativePath.replace(/\\/g, "/")
  if (SENSITIVE_CHECKPOINT_SEGMENTS.some((re) => re.test(norm))) return true
  if (content.includes(0)) return false
  const text = content.toString("utf8")
  return sanitizeSecretText(text, activeSecret) !== text
}

export function captureFileCheckpoint(
  _workspace: string,
  relativePath: string,
  targetPath: string,
  activeSecret?: string,
): FileCheckpoint | undefined {
  if (!existsSync(targetPath)) {
    return { relativePath, existedBefore: false }
  }
  try {
    const st = statSync(targetPath)
    if (!st.isFile()) return undefined
    const mode = st.mode & 0o777
    if (st.size > MAX_CHECKPOINT_BYTES) {
      return {
        relativePath,
        existedBefore: true,
        mode,
        omittedReason: `exceeds_max_checkpoint_bytes (${st.size} > ${MAX_CHECKPOINT_BYTES})`,
      }
    }
    const bytes = readFileSync(targetPath)
    const sha256Before = createHash("sha256").update(bytes).digest("hex")
    if (isSensitiveCheckpointFile(relativePath, bytes, activeSecret)) {
      return {
        relativePath,
        existedBefore: true,
        sha256Before,
        mode,
        omittedReason: "sensitive_content_omitted",
      }
    }
    return {
      relativePath,
      existedBefore: true,
      contentBase64: bytes.toString("base64"),
      sha256Before,
      mode,
    }
  } catch {
    return undefined
  }
}

export function finalizeTurnCheckpoints(
  boundary: BoundaryContext,
  checkpoints: readonly FileCheckpoint[],
): FileCheckpoint[] {
  return checkpoints.map((cp) => {
    if (cp.sha256After !== undefined) return cp
    const check = checkWorkspaceWritePath(boundary, cp.relativePath)
    if (!check.allow || !existsSync(check.resolvedPath)) return cp
    try {
      const st = statSync(check.resolvedPath)
      if (!st.isFile() || st.size > MAX_CHECKPOINT_BYTES) return cp
      const sha256After = createHash("sha256")
        .update(readFileSync(check.resolvedPath))
        .digest("hex")
      return { ...cp, sha256After }
    } catch {
      return cp
    }
  })
}

export interface RestoreResult {
  readonly restored: string[]
  readonly removed: string[]
  readonly skipped: { readonly path: string; readonly reason: string }[]
}

export function restoreTurnCheckpoints(
  boundary: BoundaryContext,
  turnsToRevert: readonly SessionTurn[],
  options: { readonly forceOverwrite?: boolean } = {},
): RestoreResult {
  const restored: string[] = []
  const removed: string[] = []
  const skipped: { path: string; reason: string }[] = []

  // Apply checkpoints in reverse chronological order so earliest state wins
  const allCheckpoints: FileCheckpoint[] = []
  for (let i = turnsToRevert.length - 1; i >= 0; i -= 1) {
    const turn = turnsToRevert[i]!
    for (let j = turn.checkpoints.length - 1; j >= 0; j -= 1) {
      allCheckpoints.push(turn.checkpoints[j]!)
    }
  }

  for (const cp of allCheckpoints) {
    if (cp.omittedReason !== undefined) {
      skipped.push({ path: cp.relativePath, reason: cp.omittedReason })
      continue
    }
    const check = checkWorkspaceWritePath(boundary, cp.relativePath)
    if (!check.allow) {
      skipped.push({ path: cp.relativePath, reason: check.reason })
      continue
    }
    try {
      if (
        cp.sha256After !== undefined &&
        !options.forceOverwrite &&
        existsSync(check.resolvedPath)
      ) {
        const currentSha = createHash("sha256")
          .update(readFileSync(check.resolvedPath))
          .digest("hex")
        if (currentSha !== cp.sha256After && currentSha !== cp.sha256Before) {
          skipped.push({
            path: cp.relativePath,
            reason: "modified_externally_since_turn",
          })
          continue
        }
      }
      if (!cp.existedBefore) {
        if (existsSync(check.resolvedPath)) {
          unlinkSync(check.resolvedPath)
          removed.push(cp.relativePath)
        }
      } else if (cp.contentBase64 !== undefined) {
        const buf = Buffer.from(cp.contentBase64, "base64")
        mkdirSync(path.dirname(check.resolvedPath), { recursive: true })
        const temp = path.join(
          path.dirname(check.resolvedPath),
          `.bw-rewind.${process.pid}.${randomBytes(3).toString("hex")}.tmp`,
        )
        writeFileSync(temp, buf)
        if (cp.mode !== undefined && process.platform !== "win32") {
          chmodSync(temp, cp.mode)
        }
        renameSync(temp, check.resolvedPath)
        restored.push(cp.relativePath)
      }
    } catch (err) {
      skipped.push({
        path: cp.relativePath,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { restored, removed, skipped }
}

export function rewindSessionToTurn(
  session: SessionRecord,
  turnIndex: number,
): {
  readonly updated: SessionRecord
  readonly revertedTurns: readonly SessionTurn[]
  readonly promptToRestore: string
} {
  const clamped = Math.max(0, Math.min(turnIndex, session.turns.length - 1))
  const targetTurn = session.turns[clamped]
  if (!targetTurn) {
    return { updated: session, revertedTurns: [], promptToRestore: "" }
  }
  const keptTurns = session.turns.slice(0, clamped)
  const revertedTurns = session.turns.slice(clamped)
  const archiveOffset = session.historyArchive?.turnMessageOffsets[clamped]
  const keptMessages =
    archiveOffset !== undefined && session.historyArchive
      ? session.historyArchive.messages.slice(0, archiveOffset)
      : session.messages.slice(0, targetTurn.messageCountBefore)
  const adjustedTurns =
    archiveOffset !== undefined && session.historyArchive
      ? keptTurns.map((t, idx) => ({
          ...t,
          messageCountBefore:
            session.historyArchive!.turnMessageOffsets[idx] ?? t.messageCountBefore,
        }))
      : keptTurns
  const keptArchive =
    session.historyArchive && archiveOffset !== undefined
      ? {
          messages: session.historyArchive.messages.slice(0, archiveOffset),
          turnMessageOffsets: session.historyArchive.turnMessageOffsets.slice(0, clamped),
        }
      : undefined
  return {
    updated: {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: keptMessages,
      turns: adjustedTurns,
      ...(keptArchive ? { historyArchive: keptArchive } : {}),
    },
    revertedTurns,
    promptToRestore: targetTurn.userPrompt,
  }
}

export function compactSessionMessages(
  session: SessionRecord,
  keepRecentTurns = 2,
): {
  readonly updated: SessionRecord
  readonly summarizedTurns: number
  readonly beforeMessages: number
  readonly afterMessages: number
} {
  const beforeMessages = session.messages.length
  if (session.turns.length <= keepRecentTurns) {
    return { updated: session, summarizedTurns: 0, beforeMessages, afterMessages: beforeMessages }
  }
  const originalMessages = session.historyArchive?.messages ?? session.messages
  const originalOffsets =
    session.historyArchive?.turnMessageOffsets ?? session.turns.map((t) => t.messageCountBefore)

  const cutIdx = session.turns.length - keepRecentTurns
  const olderTurns = session.turns.slice(0, cutIdx)
  const firstKeptTurn = session.turns[cutIdx]!
  const recentMessages = session.messages.slice(firstKeptTurn.messageCountBefore)

  const summaryLines = olderTurns.map((t, idx) => {
    const files = t.changedFiles.length > 0 ? ` [edited: ${t.changedFiles.join(", ")}]` : ""
    const promptShort = t.userPrompt.replace(/\s+/g, " ").trim().slice(0, 120)
    const answerShort = t.assistantText.replace(/\s+/g, " ").trim().slice(0, 180)
    return `Turn ${idx + 1} (${t.outcome}${files}): User="${promptShort}" -> Assistant="${answerShort}"`
  })
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Compacted session context from ${olderTurns.length} earlier turn(s)]\n${summaryLines.join("\n")}`,
  }
  const nextMessages = [summaryMessage, ...recentMessages]
  const offsetDelta = firstKeptTurn.messageCountBefore - 1
  const nextTurns = session.turns.map((t, i) =>
    i < cutIdx
      ? { ...t, messageCountBefore: 0 }
      : { ...t, messageCountBefore: Math.max(1, t.messageCountBefore - offsetDelta) },
  )
  return {
    updated: {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: nextMessages,
      turns: nextTurns,
      historyArchive: {
        messages: [...originalMessages],
        turnMessageOffsets: [...originalOffsets],
      },
    },
    summarizedTurns: olderTurns.length,
    beforeMessages,
    afterMessages: nextMessages.length,
  }
}

export function promptHistoryFile(dataDir: string): string {
  return path.join(dataDir, "prompt-history.json")
}

export function loadPromptHistory(dataDir: string): string[] {
  const file = promptHistoryFile(dataDir)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}

export function appendPromptHistory(
  dataDir: string,
  entry: string,
  activeSecret?: string,
): string[] {
  const clean = sanitizeSecretText(entry.trim(), activeSecret)
  if (clean === "") return loadPromptHistory(dataDir)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return withFileLock(path.join(dataDir, ".prompt-history.lock"), () => {
    const existing = loadPromptHistory(dataDir)
    if (existing.at(-1) === clean) return existing
    const next = [...existing, clean].slice(-MAX_HISTORY_ENTRIES)
    const target = promptHistoryFile(dataDir)
    const temp = path.join(dataDir, `.history.${process.pid}.${randomBytes(3).toString("hex")}.tmp`)
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
    renameSync(temp, target)
    return next
  })
}

function loadGitIgnorePatterns(dir: string): string[] {
  const file = path.join(dir, ".gitignore")
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
  } catch {
    return []
  }
}

function matchesGitIgnorePattern(
  relPath: string,
  name: string,
  isDir: boolean,
  pattern: string,
): boolean {
  const dirOnly = pattern.endsWith("/")
  const clean = pattern.replace(/\/$/, "").replace(/^\//, "")
  if (!clean) return false
  if (dirOnly && !isDir) return false
  const regexStr = clean
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
  const re = new RegExp(`^${regexStr}$`)
  if (!clean.includes("/")) return re.test(name)
  return re.test(relPath)
}

/** Bounded BFS workspace file walk with `.gitignore` filtering for `@` autocomplete suggestions. */
export function listWorkspaceFiles(workspace: string, maxFiles = 300): string[] {
  const out: string[] = []
  const skip = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"])
  const rootPatterns = loadGitIgnorePatterns(workspace)
  const queue: { dir: string; depth: number; patterns: string[] }[] = [
    { dir: workspace, depth: 0, patterns: rootPatterns },
  ]
  while (queue.length > 0 && out.length < maxFiles) {
    const current = queue.shift()!
    if (current.depth > 5) continue
    const patterns =
      current.depth === 0
        ? current.patterns
        : [...current.patterns, ...loadGitIgnorePatterns(current.dir)]
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      if (entry.isSymbolicLink() || skip.has(entry.name)) continue
      const abs = path.join(current.dir, entry.name)
      const rel = path.relative(workspace, abs).split(path.sep).join("/")
      const isDir = entry.isDirectory()
      if (patterns.some((p) => matchesGitIgnorePattern(rel, entry.name, isDir, p))) continue
      if (isDir) {
        queue.push({ dir: abs, depth: current.depth + 1, patterns })
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  return out
}
