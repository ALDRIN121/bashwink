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
import { collectWorkspaceFilesBFS } from "./tools.ts"
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

export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const dir = path.dirname(lockPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ownerToken = `${process.pid}:${randomBytes(6).toString("hex")}`
  const deadline = Date.now() + timeoutMs
  let acquired = false
  while (Date.now() <= deadline) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
        0o600,
      )
      try {
        writeFileSync(fd, `${ownerToken}\n${Date.now()}\n`, "utf8")
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
        const ownerPart = content.split("\n")[0]?.trim() ?? ""
        const ownerPid = Number(ownerPart.split(":")[0])
        const pidValid = Number.isInteger(ownerPid) && ownerPid > 0
        const alive = pidValid && isPidAlive(ownerPid)
        // Reclaim stale lock only if owner PID is definitely dead, or unreadable/corrupt and aged out.
        if ((pidValid && !alive) || (!pidValid && Date.now() - st.mtimeMs > LOCK_STALE_MS)) {
          if (readFileSync(lockPath, "utf8").startsWith(ownerPart)) {
            unlinkSync(lockPath)
            continue
          }
        }
      } catch {
        // Lock vanished concurrently; retry immediately.
        continue
      }
      sleepSyncMs(10)
    }
  }
  if (!acquired) {
    throw new Error(
      `Timed out waiting for exclusive lock '${lockPath}' after ${LOCK_TIMEOUT_MS}ms.`,
    )
  }
  try {
    return fn()
  } finally {
    try {
      const current = readFileSync(lockPath, "utf8")
      if (current.startsWith(ownerToken)) {
        unlinkSync(lockPath)
      }
    } catch {
      // Already unlinked or unavailable
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

function isValidIndexEntry(val: unknown): val is SessionIndexEntry {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false
  const e = val as Record<string, unknown>
  if (
    typeof e["id"] !== "string" ||
    e["id"].trim() === "" ||
    typeof e["title"] !== "string" ||
    typeof e["workspace"] !== "string" ||
    typeof e["createdAt"] !== "string" ||
    typeof e["updatedAt"] !== "string" ||
    typeof e["turnCount"] !== "number" ||
    !Number.isInteger(e["turnCount"]) ||
    e["turnCount"] < 0
  ) {
    return false
  }
  const u = e["usageTotals"]
  if (typeof u !== "object" || u === null || Array.isArray(u)) return false
  const ut = u as Record<string, unknown>
  return (
    typeof ut["requests"] === "number" &&
    Number.isFinite(ut["requests"]) &&
    typeof ut["inputTokens"] === "number" &&
    Number.isFinite(ut["inputTokens"]) &&
    typeof ut["outputTokens"] === "number" &&
    Number.isFinite(ut["outputTokens"]) &&
    typeof ut["totalTokens"] === "number" &&
    Number.isFinite(ut["totalTokens"])
  )
}

function loadRawIndex(dataDir: string): Record<string, SessionIndexEntry> {
  const idxFile = sessionsIndexFile(dataDir)
  if (!existsSync(idxFile)) return {}
  try {
    const parsed = JSON.parse(readFileSync(idxFile, "utf8")) as Record<string, unknown>
    if (parsed["version"] !== SESSION_SCHEMA_VERSION) return {}
    const entries = parsed["entries"]
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {}
    const clean: Record<string, SessionIndexEntry> = {}
    for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
      if (isValidIndexEntry(v) && v.id === k) {
        clean[k] = v
      }
    }
    return clean
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

function isFiniteUsageObj(val: unknown): boolean {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false
  const u = val as Record<string, unknown>
  return (
    typeof u["inputTokens"] === "number" &&
    Number.isFinite(u["inputTokens"]) &&
    typeof u["outputTokens"] === "number" &&
    Number.isFinite(u["outputTokens"]) &&
    typeof u["totalTokens"] === "number" &&
    Number.isFinite(u["totalTokens"])
  )
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
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) return undefined
    const t = turn as Record<string, unknown>
    if (
      typeof t["id"] !== "string" ||
      typeof t["userPrompt"] !== "string" ||
      typeof t["assistantText"] !== "string" ||
      typeof t["messageCountBefore"] !== "number" ||
      !Number.isInteger(t["messageCountBefore"]) ||
      t["messageCountBefore"] < 0 ||
      !Array.isArray(t["checkpoints"]) ||
      !Array.isArray(t["commands"]) ||
      !Array.isArray(t["changedFiles"]) ||
      !isFiniteUsageObj(t["usage"])
    ) {
      return undefined
    }
  }
  if (rec["historyArchive"] !== undefined) {
    const arch = rec["historyArchive"]
    if (typeof arch !== "object" || arch === null || Array.isArray(arch)) return undefined
    const a = arch as Record<string, unknown>
    if (
      !Array.isArray(a["messages"]) ||
      !a["messages"].every(isValidChatMessage) ||
      !Array.isArray(a["turnMessageOffsets"]) ||
      !a["turnMessageOffsets"].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)
    ) {
      return undefined
    }
  }
  const totals = rec["usageTotals"]
  if (!isFiniteUsageObj(totals)) return undefined
  const u = totals as Record<string, unknown>
  if (typeof u["requests"] !== "number" || !Number.isFinite(u["requests"])) {
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
  const forkedArchive = source.historyArchive
    ? {
        messages:
          archiveOffset !== undefined
            ? source.historyArchive.messages.slice(0, archiveOffset)
            : [...source.historyArchive.messages],
        turnMessageOffsets: source.historyArchive.turnMessageOffsets.slice(0, count),
      }
    : undefined
  return {
    ...base,
    title: `${source.title} (fork)`,
    customTitle: true,
    parentSessionId: source.id,
    ...(forkedFrom === undefined ? {} : { forkedFromTurnId: forkedFrom }),
    messages: keptMessages,
    turns: adjustedTurns,
    ...(forkedArchive ? { historyArchive: forkedArchive } : {}),
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
  if (content.includes(0)) return true
  const utf8 = content.toString("utf8")
  if (sanitizeSecretText(utf8, activeSecret) !== utf8) return true
  const stripped = content.toString("latin1").replace(/\0/g, "")
  if (sanitizeSecretText(stripped, activeSecret) !== stripped) return true
  const utf16 = content.toString("utf16le")
  return sanitizeSecretText(utf16, activeSecret) !== utf16
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
        omittedReason: bytes.includes(0)
          ? "binary_or_sensitive_content_omitted"
          : "sensitive_content_omitted",
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
  options: { readonly forceOverwrite?: boolean; readonly allowPartial?: boolean } = {},
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

  // Preflight every target before modifying any file on disk (#96).
  const planned: Array<{ readonly cp: FileCheckpoint; readonly resolvedPath: string }> = []
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
    if (cp.sha256After !== undefined && !options.forceOverwrite) {
      if (!existsSync(check.resolvedPath)) {
        skipped.push({
          path: cp.relativePath,
          reason: "deleted_externally_since_turn",
        })
        continue
      }
      try {
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
      } catch (err) {
        skipped.push({
          path: cp.relativePath,
          reason: err instanceof Error ? err.message : String(err),
        })
        continue
      }
    }
    planned.push({ cp, resolvedPath: check.resolvedPath })
  }

  if (skipped.length > 0 && !options.allowPartial && !options.forceOverwrite) {
    return { restored: [], removed: [], skipped }
  }

  const backups: Array<{
    readonly resolvedPath: string
    readonly relativePath: string
    readonly existed: boolean
    readonly bytes?: Buffer
    readonly mode?: number
  }> = []

  for (const item of planned) {
    const { cp, resolvedPath } = item
    try {
      const existedNow = existsSync(resolvedPath)
      const prevBytes = existedNow ? readFileSync(resolvedPath) : undefined
      const prevMode = existedNow ? statSync(resolvedPath).mode & 0o777 : undefined

      if (!cp.existedBefore) {
        if (existedNow) {
          backups.push({
            resolvedPath,
            relativePath: cp.relativePath,
            existed: true,
            ...(prevBytes !== undefined ? { bytes: prevBytes } : {}),
            ...(prevMode !== undefined ? { mode: prevMode } : {}),
          })
          unlinkSync(resolvedPath)
          removed.push(cp.relativePath)
        }
      } else if (cp.contentBase64 !== undefined) {
        const buf = Buffer.from(cp.contentBase64, "base64")
        mkdirSync(path.dirname(resolvedPath), { recursive: true })
        const temp = path.join(
          path.dirname(resolvedPath),
          `.bw-rewind.${process.pid}.${randomBytes(3).toString("hex")}.tmp`,
        )
        writeFileSync(temp, buf)
        if (cp.mode !== undefined && process.platform !== "win32") {
          chmodSync(temp, cp.mode)
        }
        backups.push({
          resolvedPath,
          relativePath: cp.relativePath,
          existed: existedNow,
          ...(prevBytes !== undefined ? { bytes: prevBytes } : {}),
          ...(prevMode !== undefined ? { mode: prevMode } : {}),
        })
        renameSync(temp, resolvedPath)
        restored.push(cp.relativePath)
      }
    } catch (err) {
      // Roll back earlier writes in this rewind batch to keep workspace consistent.
      for (let b = backups.length - 1; b >= 0; b -= 1) {
        const snap = backups[b]!
        try {
          if (!snap.existed) {
            if (existsSync(snap.resolvedPath)) unlinkSync(snap.resolvedPath)
          } else if (snap.bytes !== undefined) {
            writeFileSync(snap.resolvedPath, snap.bytes)
            if (snap.mode !== undefined && process.platform !== "win32") {
              chmodSync(snap.resolvedPath, snap.mode)
            }
          }
        } catch {
          // Best-effort rollback
        }
      }
      skipped.push({
        path: cp.relativePath,
        reason: err instanceof Error ? err.message : String(err),
      })
      return { restored: [], removed: [], skipped }
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

/** Bounded BFS workspace file walk with `.gitignore` filtering for `@` autocomplete suggestions. */
export function listWorkspaceFiles(workspace: string, maxFiles = 300): string[] {
  return collectWorkspaceFilesBFS(workspace, {
    maxDepth: 6,
    maxCollect: maxFiles,
    includeDirs: false,
  }).entries
}
