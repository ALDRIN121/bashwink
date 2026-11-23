/**
 * Durable plan/task store on SQLite (`bun:sqlite`, no external dependency).
 *
 * Requirements this file exists to satisfy (BW-012, BW-016, BW-019):
 *   - tasks and plans survive a process restart,
 *   - state transitions go through the state machine, never a raw UPDATE,
 *   - migrations are atomic and versioned, so an older binary refuses a newer schema instead
 *     of corrupting it,
 *   - attempt/write tracking is durable so a killed run can be reconciled rather than
 *     re-applied (BW-019).
 *
 * `bun:sqlite` is chosen over a driver dependency so the licence surface stays MIT-only
 * (ADR-008) and there is nothing to audit for security.
 */

import { Database } from "bun:sqlite"
import { assertTransition, canTransition, type TaskStatus } from "./status.js"
import type { Plan } from "./plan.js"

/** Current schema version. Bump only alongside a new entry in `MIGRATIONS`. */
export const SCHEMA_VERSION = 1

/**
 * Migrations, applied in order inside one transaction.
 *
 * Rollback story (BW-012 acceptance): every migration is additive and each step is wrapped
 * in a transaction, so a failure at step N leaves the database at step N-1 rather than
 * half-migrated. To roll *back* deliberately, run the matching statement in
 * `DOWN_MIGRATIONS` — documented and exercised in `test/store.test.ts` rather than left as
 * prose, because a migration story nobody has run is a story about code that does not
 * exist.
 */
const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE plan (
    id            TEXT PRIMARY KEY,
    objective     TEXT NOT NULL,
    approval      TEXT NOT NULL CHECK (approval IN ('draft','approved','rejected')),
    approved_by   TEXT,
    approved_at   TEXT,
    created_at    TEXT NOT NULL,
    risks         TEXT NOT NULL DEFAULT '[]',
    files         TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE task (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL,
    depends_on    TEXT NOT NULL DEFAULT '[]',
    files         TEXT NOT NULL DEFAULT '[]',
    checks        TEXT NOT NULL DEFAULT '[]',
    note          TEXT,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX task_plan ON task(plan_id);

  -- Every transition ever applied, so "how did this get verified" is answerable later.
  CREATE TABLE transition (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    from_status   TEXT NOT NULL,
    to_status     TEXT NOT NULL,
    at            TEXT NOT NULL,
    reason        TEXT
  );

  -- BW-019: durable attempt tracking for idempotent resume.
  CREATE TABLE attempt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    operation     TEXT NOT NULL,
    -- Content hash of the intended write, so a resume can tell "already applied" from
    -- "not yet applied" without trusting a prose note.
    fingerprint   TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('started','applied','failed','abandoned')),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    detail        TEXT
  );

  CREATE INDEX attempt_task ON attempt(task_id);
  CREATE INDEX attempt_state ON attempt(state);

  -- Recorded check observations. A task may only become 'verified' when every declared
  -- check has a passing observation.
  CREATE TABLE observation (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    check_id      TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pass','fail','not_run')),
    exit_code     INTEGER,
    at            TEXT NOT NULL,
    detail        TEXT
  );

  CREATE INDEX observation_task ON observation(task_id);

  -- The run a task's work belongs to, so tool events can be task-linked (BW-016).
  CREATE TABLE run (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    exit_code     INTEGER,
    interrupted   INTEGER NOT NULL DEFAULT 0
  );
  `,
]

/** Inverse of each migration, newest last. Used by the documented rollback test. */
const DOWN_MIGRATIONS: readonly string[] = [
  `
  DROP TABLE IF EXISTS run;
  DROP TABLE IF EXISTS observation;
  DROP TABLE IF EXISTS attempt;
  DROP TABLE IF EXISTS transition;
  DROP TABLE IF EXISTS task;
  DROP TABLE IF EXISTS plan;
  `,
]

export class SchemaTooNewError extends Error {
  readonly code = "schema_too_new"
  constructor(found: number) {
    super(
      `database schema v${found} is newer than this build (v${SCHEMA_VERSION}); ` +
        `refusing to run against it — upgrade Bashwink instead of downgrading the schema`,
    )
    this.name = "SchemaTooNewError"
  }
}

export interface StoreOptions {
  /** Path to the SQLite file. `:memory:` for tests. */
  readonly file: string
  /** Injected clock so transition timestamps are deterministic in tests. */
  readonly now?: () => Date
}

/** One recorded transition, as read back from the log. */
export interface TransitionRecord {
  readonly seq: number
  readonly taskId: string
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly at: string
  readonly reason?: string
}

export interface ObservationInput {
  readonly checkId: string
  readonly status: "pass" | "fail" | "not_run"
  readonly exitCode?: number
  readonly detail?: string
}

export class Store {
  readonly db: Database
  private readonly now: () => Date

  constructor(options: StoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.db = new Database(options.file, { create: true })
    // WAL keeps a killed process from corrupting the file — directly relevant to BW-019.
    if (options.file !== ":memory:") this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  /** Apply pending migrations atomically. Safe to call on every start. */
  migrate(): number {
    const current = this.schemaVersion()
    if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current)
    if (current === SCHEMA_VERSION) return current
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const statement = MIGRATIONS[version]
      if (statement === undefined) throw new Error(`no migration for v${version + 1}`)
      // One transaction per step: a failure leaves the previous version intact.
      this.db.transaction(() => {
        this.db.run(statement)
        this.db.run(`PRAGMA user_version = ${version + 1}`)
      })()
    }
    return this.schemaVersion()
  }

  /** Current schema version recorded in the file, 0 for a fresh database. */
  schemaVersion(): number {
    const row = this.db.query("PRAGMA user_version").get() as { user_version?: number } | null
    return Number(row?.user_version ?? 0)
  }

  /**
   * Documented rollback: drop everything and return to v0.
   *
   * Exposed as a method rather than a shell script so the rollback is covered by a test
   * that actually runs it. Only the newest down-migration is implemented because there is
   * only one schema version; adding v2 means adding its inverse here.
   */
  rollback(): number {
    for (let version = this.schemaVersion(); version > 0; version -= 1) {
      const statement = DOWN_MIGRATIONS[version - 1]
      if (statement === undefined) throw new Error(`no down-migration for v${version}`)
      this.db.transaction(() => {
        this.db.run(statement)
        this.db.run(`PRAGMA user_version = ${version - 1}`)
      })()
    }
    return this.schemaVersion()
  }

  nowIso(): string {
    return this.now().toISOString()
  }

  // ---------------------------------------------------------------- plans

  savePlan(plan: Plan): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO plan (id, objective, approval, approved_by, approved_at, created_at, risks, files)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             objective=excluded.objective, approval=excluded.approval,
             approved_by=excluded.approved_by, approved_at=excluded.approved_at,
             risks=excluded.risks, files=excluded.files`,
        )
        .run(
          plan.id,
          plan.objective,
          plan.approval,
          plan.approvedBy ?? null,
          plan.approvedAt ?? null,
          plan.createdAt,
          JSON.stringify(plan.risks ?? []),
          JSON.stringify(plan.files),
        )
      for (const task of plan.tasks) {
        this.db
          .query(
            `INSERT INTO task (id, plan_id, title, status, depends_on, files, checks, note, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, depends_on=excluded.depends_on,
               files=excluded.files, checks=excluded.checks, note=excluded.note`,
          )
          .run(
            task.id,
            plan.id,
            task.title,
            task.status,
            JSON.stringify(task.dependsOn ?? []),
            JSON.stringify(task.files ?? []),
            JSON.stringify(task.checks ?? []),
            task.note ?? null,
            this.nowIso(),
          )
      }
    })()
  }

  plan(id: string): Plan | undefined {
    // After `rollback()` the tables are gone by design. Returning undefined is the honest
    // answer ("this database holds no plan"), whereas letting SQLite throw `no such table`
    // surfaces a storage detail as if it were a data problem.
    if (this.schemaVersion() === 0) return undefined
    const row = this.db.query("SELECT * FROM plan WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null
    if (!row) return undefined
    const tasks = this.db
      .query("SELECT * FROM task WHERE plan_id = ? ORDER BY id")
      .all(id) as Record<string, unknown>[]
    return {
      v: 1,
      id: String(row.id),
      objective: String(row.objective),
      approval: row.approval as Plan["approval"],
      ...(row.approved_by === null ? {} : { approvedBy: String(row.approved_by) }),
      ...(row.approved_at === null ? {} : { approvedAt: String(row.approved_at) }),
      createdAt: String(row.created_at),
      risks: JSON.parse(String(row.risks)) as string[],
      files: JSON.parse(String(row.files)) as string[],
      tasks: tasks.map((task) => {
        const checks = JSON.parse(String(task.checks)) as Plan["tasks"][number]["checks"]
        return {
          id: String(task.id),
          title: String(task.title),
          status: task.status as TaskStatus,
          dependsOn: JSON.parse(String(task.depends_on)) as string[],
          files: JSON.parse(String(task.files)) as string[],
          // An absent `checks` column is spread out rather than set to undefined, which
          // `exactOptionalPropertyTypes` refuses.
          ...(checks === undefined ? {} : { checks }),
          ...(task.note === null ? {} : { note: String(task.note) }),
        }
      }),
    }
  }

  // ---------------------------------------------------------------- tasks

  taskStatus(taskId: string): TaskStatus | undefined {
    const row = this.db.query("SELECT status FROM task WHERE id = ?").get(taskId) as {
      status: string
    } | null
    return row ? (row.status as TaskStatus) : undefined
  }

  /**
   * Validate, apply and record a transition.
   *
   * Refuses an illegal transition with `InvalidTransitionError` rather than returning false,
   * because every caller is a CLI/agent path that would otherwise ignore it.
   */
  transition(taskId: string, to: TaskStatus, reason?: string): TaskStatus {
    const from = this.taskStatus(taskId)
    if (from === undefined) throw new Error(`unknown task '${taskId}'`)
    assertTransition(from, to)
    const at = this.nowIso()
    this.db.transaction(() => {
      this.db.query("UPDATE task SET status = ?, updated_at = ? WHERE id = ?").run(to, at, taskId)
      this.db
        .query(
          "INSERT INTO transition (task_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?)",
        )
        .run(taskId, from, to, at, reason ?? null)
    })()
    return to
  }

  /** Full transition history for a task, oldest first. */
  transitions(taskId: string): TransitionRecord[] {
    return (
      this.db
        .query(
          "SELECT seq, task_id, from_status, to_status, at, reason FROM transition WHERE task_id = ? ORDER BY seq",
        )
        .all(taskId) as Record<string, unknown>[]
    ).map((row) => ({
      seq: Number(row.seq),
      taskId: String(row.task_id),
      from: row.from_status as TaskStatus,
      to: row.to_status as TaskStatus,
      at: String(row.at),
      ...(row.reason === null ? {} : { reason: String(row.reason) }),
    }))
  }

  /** Statuses of all tasks in a plan, for dependency resolution. */
  taskGraph(planId: string): { id: string; status: TaskStatus; dependsOn: string[] }[] {
    const rows = this.db
      .query("SELECT id, status, depends_on FROM task WHERE plan_id = ? ORDER BY id")
      .all(planId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      status: row.status as TaskStatus,
      dependsOn: JSON.parse(String(row.depends_on)) as string[],
    }))
  }

  // ------------------------------------------------------- observations

  /**
   * Record the outcome of a declared check.
   *
   * `not_run` is a first-class status on purpose: BW-015's acceptance requires an export to
   * distinguish "did not pass" from "was never executed". Collapsing them into `fail` is how
   * a report starts lying.
   */
  observe(taskId: string, observation: ObservationInput): void {
    if (this.taskStatus(taskId) === undefined) throw new Error(`unknown task '${taskId}'`)
    this.db
      .query(
        `INSERT INTO observation (task_id, check_id, status, exit_code, at, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        observation.checkId,
        observation.status,
        observation.exitCode ?? null,
        this.nowIso(),
        observation.detail ?? null,
      )
  }

  observations(taskId: string): {
    checkId: string
    status: "pass" | "fail" | "not_run"
    exitCode?: number
    at: string
    detail?: string
  }[] {
    return (
      this.db
        .query(
          "SELECT check_id, status, exit_code, at, detail FROM observation WHERE task_id = ? ORDER BY id",
        )
        .all(taskId) as Record<string, unknown>[]
    ).map((row) => ({
      checkId: String(row.check_id),
      status: row.status as "pass" | "fail" | "not_run",
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      at: String(row.at),
      ...(row.detail === null ? {} : { detail: String(row.detail) }),
    }))
  }

  /**
   * Every declared check has a passing observation.
   *
   * This is the guard that stops `implemented -> verified` from being a label an agent can
   * apply to itself without running anything.
   */
  checksPassed(taskId: string): { ok: boolean; reason?: string } {
    const row = this.db.query("SELECT plan_id, checks FROM task WHERE id = ?").get(taskId) as {
      plan_id: string
      checks: string
    } | null
    if (!row) return { ok: false, reason: `unknown task '${taskId}'` }
    const declared = (JSON.parse(row.checks) as { id: string }[] | undefined) ?? []
    if (declared.length === 0)
      return { ok: false, reason: `task '${taskId}' declares no checks, so it cannot be verified` }
    const observed = this.observations(taskId)
    for (const check of declared) {
      const runs = observed.filter((o) => o.checkId === check.id)
      if (runs.length === 0) return { ok: false, reason: `check '${check.id}' was never run` }
      const last = runs.at(-1)
      if (last?.status !== "pass")
        return { ok: false, reason: `check '${check.id}' last reported '${last?.status}'` }
    }
    return { ok: true }
  }

  // ----------------------------------------------------------- attempts

  /**
   * Begin an attempt at a write.
   *
   * `fingerprint` is a content hash of the intended write, which is what makes resume
   * idempotent (BW-019): a restart can ask "was this exact write already applied?" instead of
   * re-applying it and hoping.
   */
  startAttempt(taskId: string, operation: string, fingerprint: string): number {
    const result = this.db
      .query(
        `INSERT INTO attempt (task_id, operation, fingerprint, state, started_at)
         VALUES (?, ?, ?, 'started', ?)`,
      )
      .run(taskId, operation, fingerprint, this.nowIso())
    return Number(result.lastInsertRowid ?? 0)
  }

  finishAttempt(id: number, state: "applied" | "failed" | "abandoned", detail?: string): void {
    this.db
      .query("UPDATE attempt SET state = ?, finished_at = ?, detail = ? WHERE id = ?")
      .run(state, this.nowIso(), detail ?? null, id)
  }

  /**
   * Find an attempt that was started but never finished — i.e. the process died mid-write.
   *
   * Returns it rather than guessing an outcome: the caller decides whether to assume applied
   * (by checking the file) or to abandon. "Prefer explicit uncertain states over attempted
   * automatic recovery" (PHASE-01 risk note).
   */
  interruptedAttempts(): {
    id: number
    taskId: string
    operation: string
    fingerprint: string
    startedAt: string
  }[] {
    return (
      this.db
        .query(
          "SELECT id, task_id, operation, fingerprint, started_at FROM attempt WHERE state = 'started' ORDER BY id",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      operation: String(row.operation),
      fingerprint: String(row.fingerprint),
      startedAt: String(row.started_at),
    }))
  }

  /** Has this exact write already been applied? The idempotency check. */
  alreadyApplied(taskId: string, operation: string, fingerprint: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS hit FROM attempt WHERE task_id = ? AND operation = ? AND fingerprint = ? AND state = 'applied' LIMIT 1",
      )
      .get(taskId, operation, fingerprint) as { hit?: number } | null
    return row !== null
  }

  // --------------------------------------------------------------- runs

  startRun(id: string, planId: string): void {
    this.db
      .query("INSERT OR REPLACE INTO run (id, plan_id, started_at) VALUES (?, ?, ?)")
      .run(id, planId, this.nowIso())
  }

  endRun(id: string, exitCode: number, interrupted = false): void {
    this.db
      .query("UPDATE run SET ended_at = ?, exit_code = ?, interrupted = ? WHERE id = ?")
      .run(this.nowIso(), exitCode, interrupted ? 1 : 0, id)
  }

  /** Runs with no `ended_at`: the process died without recording an exit. */
  interruptedRuns(): { id: string; planId: string; startedAt: string }[] {
    return (
      this.db
        .query("SELECT id, plan_id, started_at FROM run WHERE ended_at IS NULL ORDER BY started_at")
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      planId: String(row.plan_id),
      startedAt: String(row.started_at),
    }))
  }

  close(): void {
    this.db.close()
  }
}

export { canTransition }
