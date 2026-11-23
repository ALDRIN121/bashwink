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
import {
  CONTRACT_VERSION,
  ContractGateError,
  ContractRevisionError,
  assertContract,
  assertCriterionTransition,
  type ContractApproval,
  type ContractConstraints,
  type CriterionStatus,
  type TaskContract,
} from "./contract.js"

/** Current schema version. Bump only alongside a new entry in `MIGRATIONS`. */
export const SCHEMA_VERSION = 2

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
  // v2 — BW-055: TaskContract, immutable revisions and the criterion lifecycle.
  //
  // `criterion` is the point of this migration. It is a *separate* table from the revision
  // snapshot on purpose: a revision records what the contract said, while the criterion row
  // carries the status across revisions. Removing a criterion sets `dropped_in_revision`; it
  // never deletes the row, so a status cannot disappear by revising the contract.
  `
  CREATE TABLE contract (
    id                    TEXT PRIMARY KEY,
    plan_id               TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    objective             TEXT NOT NULL,
    revision              INTEGER NOT NULL,
    base_commit           TEXT,
    allowed_paths         TEXT NOT NULL DEFAULT '[]',
    forbidden_paths       TEXT NOT NULL DEFAULT '[]',
    negative_requirements TEXT NOT NULL DEFAULT '[]',
    constraints           TEXT NOT NULL DEFAULT '{}',
    approval              TEXT NOT NULL CHECK (approval IN ('draft','approved','rejected')),
    approved_by           TEXT,
    approved_at           TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );

  CREATE INDEX contract_plan ON contract(plan_id);

  CREATE TABLE contract_revision (
    contract_id           TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
    revision              INTEGER NOT NULL,
    at                    TEXT NOT NULL,
    objective             TEXT NOT NULL,
    allowed_paths         TEXT NOT NULL,
    forbidden_paths       TEXT NOT NULL,
    negative_requirements TEXT NOT NULL,
    constraints           TEXT NOT NULL,
    criteria              TEXT NOT NULL,
    reason                TEXT,
    approved_by           TEXT,
    PRIMARY KEY (contract_id, revision)
  );

  CREATE TABLE criterion (
    contract_id           TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
    criterion_id          TEXT NOT NULL,
    statement             TEXT NOT NULL,
    required              INTEGER NOT NULL,
    task_id               TEXT NOT NULL,
    check_id              TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('pending','passed','failed','not_run','dropped')),
    first_revision        INTEGER NOT NULL,
    last_revision         INTEGER NOT NULL,
    dropped_in_revision   INTEGER,
    status_reason         TEXT,
    status_at             TEXT NOT NULL,
    PRIMARY KEY (contract_id, criterion_id)
  );

  CREATE INDEX criterion_task ON criterion(contract_id, task_id);

  -- Evidence linked to an acceptance criterion, not just to a task. observation_id points
  -- at the row in observation that proves it; the row is kept even if the observation is
  -- later superseded, because the criterion's history is the audit trail.
  CREATE TABLE criterion_evidence (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id    TEXT NOT NULL,
    criterion_id   TEXT NOT NULL,
    observation_id INTEGER,
    status         TEXT NOT NULL CHECK (status IN ('pass','fail','not_run')),
    exit_code      INTEGER,
    at             TEXT NOT NULL,
    detail         TEXT,
    FOREIGN KEY (contract_id, criterion_id) REFERENCES criterion(contract_id, criterion_id)
  );

  CREATE INDEX criterion_evidence_ref ON criterion_evidence(contract_id, criterion_id);
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
  `
  DROP TABLE IF EXISTS criterion_evidence;
  DROP TABLE IF EXISTS criterion;
  DROP TABLE IF EXISTS contract_revision;
  DROP TABLE IF EXISTS contract;
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

  /**
   * Refuse to start a task when its plan has a contract that is not approved or does not
   * cover it. A plan with no contract is unaffected (Phase 1 behaviour).
   *
   * Read-only, so `resume` can pre-flight every task before it changes anything.
   */
  assertExecutionAllowed(taskId: string): void {
    if (this.schemaVersion() < 2) return
    const row = this.db.query("SELECT plan_id FROM task WHERE id = ?").get(taskId) as {
      plan_id: string
    } | null
    if (row === null) return
    const contract = this.contractForPlan(String(row.plan_id))
    if (contract === undefined) return
    if (contract.approval !== "approved")
      throw new ContractGateError(
        `contract ${contract.id} revision ${contract.revision} is '${contract.approval}'; ` +
          `approve it before starting '${taskId}'`,
      )
    const covering = this.criteria(contract.id).filter(
      (criterion) => criterion.task === taskId && criterion.status !== "dropped",
    )
    if (covering.length === 0)
      throw new ContractGateError(
        `no criterion in contract ${contract.id} covers task '${taskId}'; ` +
          `add one in a revision before starting the work`,
      )
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
    // Starting work is the one transition a contract governs. Enforced here rather than only
    // in `plan task` so `resume` and any future caller cannot route around it.
    if (to === "in_progress") this.assertExecutionAllowed(taskId)
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
   *
   * BW-055: when the task's plan has a contract, the observation is also linked to every
   * criterion that names this task + check. That link is what makes "evidence for an
   * acceptance criterion" a recorded fact rather than a claim about a file somewhere.
   */
  observe(taskId: string, observation: ObservationInput): number {
    if (this.taskStatus(taskId) === undefined) throw new Error(`unknown task '${taskId}'`)
    const at = this.nowIso()
    return this.db.transaction(() => {
      const result = this.db
        .query(
          `INSERT INTO observation (task_id, check_id, status, exit_code, at, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          observation.checkId,
          observation.status,
          observation.exitCode ?? null,
          at,
          observation.detail ?? null,
        )
      const observationId = Number(result.lastInsertRowid ?? 0)

      const row = this.db.query("SELECT plan_id FROM task WHERE id = ?").get(taskId) as {
        plan_id: string
      } | null
      if (row !== null) {
        const contractRow = this.db
          .query("SELECT id FROM contract WHERE plan_id = ? ORDER BY updated_at DESC, id LIMIT 1")
          .get(row.plan_id) as { id: string } | null
        if (contractRow !== null) {
          const criteria = this.db
            .query(
              "SELECT criterion_id FROM criterion WHERE contract_id = ? AND task_id = ? AND check_id = ?",
            )
            .all(String(contractRow.id), taskId, observation.checkId) as {
            criterion_id: string
          }[]
          for (const criterion of criteria)
            this.recordCriterionEvidence({
              contractId: String(contractRow.id),
              criterionId: String(criterion.criterion_id),
              status: observation.status,
              observationId,
              ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
              ...(observation.detail === undefined ? {} : { detail: observation.detail }),
            })
        }
      }
      return observationId
    })()
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

  // ------------------------------------------------------------- contracts

  /**
   * Persist a contract revision.
   *
   * Revisions must increment by exactly one. That is not ceremony: allowing "revision 2"
   * to overwrite "revision 1" would make the audit trail a mutable document, and the whole
   * point of the criterion table below is that history survives amendment.
   *
   * Criteria are upserted by stable id. A criterion that the new revision omits is marked
   * `dropped` in place; a previously dropped id cannot be re-added, because reusing it would
   * erase the record of the drop.
   */
  saveContract(contract: TaskContract): void {
    assertContract(contract)
    const existing = this.db
      .query("SELECT revision FROM contract WHERE id = ?")
      .get(contract.id) as { revision: number } | null
    if (existing === null) {
      if (contract.revision !== 1)
        throw new ContractRevisionError(`new contract '${contract.id}' must start at revision 1`)
    } else if (contract.revision !== Number(existing.revision) + 1) {
      throw new ContractRevisionError(
        `contract '${contract.id}' is at revision ${existing.revision}; ` +
          `the next write must be revision ${Number(existing.revision) + 1}, not ${contract.revision}`,
      )
    }

    const at = this.nowIso()
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO contract (id, plan_id, objective, revision, base_commit, allowed_paths,
             forbidden_paths, negative_requirements, constraints, approval, approved_by,
             approved_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             objective=excluded.objective, revision=excluded.revision,
             base_commit=excluded.base_commit, allowed_paths=excluded.allowed_paths,
             forbidden_paths=excluded.forbidden_paths,
             negative_requirements=excluded.negative_requirements,
             constraints=excluded.constraints, approval=excluded.approval,
             approved_by=excluded.approved_by, approved_at=excluded.approved_at,
             updated_at=excluded.updated_at`,
        )
        .run(
          contract.id,
          contract.planId,
          contract.objective,
          contract.revision,
          contract.baseCommit ?? null,
          JSON.stringify(contract.allowedPaths),
          JSON.stringify(contract.forbiddenPaths),
          JSON.stringify(contract.negativeRequirements),
          JSON.stringify(contract.constraints),
          contract.approval,
          contract.approvedBy ?? null,
          contract.approvedAt ?? null,
          contract.createdAt,
          at,
        )

      this.db
        .query(
          `INSERT INTO contract_revision (contract_id, revision, at, objective, allowed_paths,
             forbidden_paths, negative_requirements, constraints, criteria, reason, approved_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          contract.id,
          contract.revision,
          at,
          contract.objective,
          JSON.stringify(contract.allowedPaths),
          JSON.stringify(contract.forbiddenPaths),
          JSON.stringify(contract.negativeRequirements),
          JSON.stringify(contract.constraints),
          JSON.stringify(
            contract.criteria.map(({ id, statement, required, task, check }) => ({
              id,
              statement,
              required,
              task,
              check,
            })),
          ),
          contract.reason ?? null,
          contract.approvedBy ?? null,
        )

      const rows = this.db
        .query(
          "SELECT criterion_id, status, task_id, check_id FROM criterion WHERE contract_id = ?",
        )
        .all(contract.id) as {
        criterion_id: string
        status: CriterionStatus
        task_id: string
        check_id: string
      }[]
      const known = new Map(
        rows.map((row) => [
          String(row.criterion_id),
          { status: row.status, task: String(row.task_id), check: String(row.check_id) },
        ]),
      )
      const present = new Set(contract.criteria.map((criterion) => criterion.id))

      for (const criterion of contract.criteria) {
        const existing = known.get(criterion.id)
        const status = existing?.status
        if (status === "dropped")
          throw new ContractRevisionError(
            `criterion '${criterion.id}' was dropped in revision ${contract.revision - 1} and cannot be re-added; ` +
              `give the new requirement its own id so the drop stays visible`,
          )
        if (
          existing !== undefined &&
          (existing.task !== criterion.task || existing.check !== criterion.check)
        )
          // A criterion's identity is the evidence it points at. Re-pointing it would let a
          // passed status carry over to a different check, which is exactly the kind of
          // silent substitution the contract exists to prevent.
          throw new ContractRevisionError(
            `criterion '${criterion.id}' cannot change its task/check ` +
              `(${existing.task}/${existing.check} -> ${criterion.task}/${criterion.check}); add a new criterion id`,
          )
        if (status === undefined)
          this.db
            .query(
              `INSERT INTO criterion (contract_id, criterion_id, statement, required, task_id,
                 check_id, status, first_revision, last_revision, status_at)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
            )
            .run(
              contract.id,
              criterion.id,
              criterion.statement,
              criterion.required ? 1 : 0,
              criterion.task,
              criterion.check,
              contract.revision,
              contract.revision,
              at,
            )
        else
          this.db
            .query(
              `UPDATE criterion SET statement = ?, required = ?, task_id = ?, check_id = ?,
                 last_revision = ? WHERE contract_id = ? AND criterion_id = ?`,
            )
            .run(
              criterion.statement,
              criterion.required ? 1 : 0,
              criterion.task,
              criterion.check,
              contract.revision,
              contract.id,
              criterion.id,
            )
      }

      for (const [id, existing] of known) {
        if (present.has(id) || existing.status === "dropped") continue
        this.db
          .query(
            `UPDATE criterion SET status = 'dropped', dropped_in_revision = ?, status_at = ?,
               status_reason = ? WHERE contract_id = ? AND criterion_id = ?`,
          )
          .run(
            contract.revision,
            at,
            contract.reason ?? `removed in revision ${contract.revision}`,
            contract.id,
            id,
          )
      }
    })()
  }

  /** Approve a draft contract without creating a revision. Approval is not content. */
  approveContract(contractId: string, by: string, at = this.nowIso()): TaskContract {
    const contract = this.contract(contractId)
    if (contract === undefined) throw new Error(`unknown contract '${contractId}'`)
    if (by.trim() === "") throw new Error("approval must record who approved the contract")
    this.db
      .query(
        "UPDATE contract SET approval = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(by, at, at, contractId)
    return { ...contract, approval: "approved", approvedBy: by, approvedAt: at }
  }

  contract(id: string): TaskContract | undefined {
    if (this.schemaVersion() === 0) return undefined
    const row = this.db.query("SELECT * FROM contract WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null
    if (!row) return undefined
    const criteria = this.criteria(id)
    return {
      v: CONTRACT_VERSION,
      id: String(row.id),
      planId: String(row.plan_id),
      objective: String(row.objective),
      revision: Number(row.revision),
      ...(row.base_commit === null ? {} : { baseCommit: String(row.base_commit) }),
      allowedPaths: JSON.parse(String(row.allowed_paths)) as string[],
      forbiddenPaths: JSON.parse(String(row.forbidden_paths)) as string[],
      negativeRequirements: JSON.parse(String(row.negative_requirements)) as string[],
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        required: criterion.required,
        task: criterion.task,
        check: criterion.check,
        status: criterion.status,
      })),
      constraints: JSON.parse(String(row.constraints)) as ContractConstraints,
      approval: row.approval as ContractApproval,
      ...(row.approved_by === null ? {} : { approvedBy: String(row.approved_by) }),
      ...(row.approved_at === null ? {} : { approvedAt: String(row.approved_at) }),
      createdAt: String(row.created_at),
    }
  }

  /** The current (highest-revision) contract for a plan, if one exists. */
  contractForPlan(planId: string): TaskContract | undefined {
    const row = this.db
      .query("SELECT id FROM contract WHERE plan_id = ? ORDER BY updated_at DESC, id LIMIT 1")
      .get(planId) as { id: string } | null
    return row === null ? undefined : this.contract(String(row.id))
  }

  revisions(contractId: string): {
    revision: number
    at: string
    objective: string
    criteria: {
      id: string
      statement: string
      required: boolean
      task: string
      check: string
    }[]
    reason?: string
    approvedBy?: string
  }[] {
    return (
      this.db
        .query(
          "SELECT revision, at, objective, criteria, reason, approved_by FROM contract_revision WHERE contract_id = ? ORDER BY revision",
        )
        .all(contractId) as Record<string, unknown>[]
    ).map((row) => ({
      revision: Number(row.revision),
      at: String(row.at),
      objective: String(row.objective),
      criteria: JSON.parse(String(row.criteria)) as {
        id: string
        statement: string
        required: boolean
        task: string
        check: string
      }[],
      ...(row.reason === null ? {} : { reason: String(row.reason) }),
      ...(row.approved_by === null ? {} : { approvedBy: String(row.approved_by) }),
    }))
  }

  /** Criterion rows, including dropped ones. Nothing here is ever deleted by a revision. */
  criteria(contractId: string): {
    id: string
    statement: string
    required: boolean
    task: string
    check: string
    status: CriterionStatus
    firstRevision: number
    lastRevision: number
    droppedInRevision?: number
    statusReason?: string
    statusAt: string
  }[] {
    if (this.schemaVersion() === 0) return []
    return (
      (
        this.db
          // Insertion order, not alphabetical: the criterion order is part of what the author
          // wrote, and a round-trip that reorders it is not a round-trip.
          .query("SELECT * FROM criterion WHERE contract_id = ? ORDER BY rowid")
          .all(contractId) as Record<string, unknown>[]
      ).map((row) => ({
        id: String(row.criterion_id),
        statement: String(row.statement),
        required: Number(row.required) === 1,
        task: String(row.task_id),
        check: String(row.check_id),
        status: row.status as CriterionStatus,
        firstRevision: Number(row.first_revision),
        lastRevision: Number(row.last_revision),
        ...(row.dropped_in_revision === null
          ? {}
          : { droppedInRevision: Number(row.dropped_in_revision) }),
        ...(row.status_reason === null ? {} : { statusReason: String(row.status_reason) }),
        statusAt: String(row.status_at),
      }))
    )
  }

  /**
   * Change a criterion's status deliberately.
   *
   * `passed` requires a passing evidence row, mirroring the task-level rule: a status that
   * asserts success must point at something that actually succeeded. `dropped` requires a
   * reason, because "it stopped being convenient" is not a reason a reviewer can audit.
   */
  setCriterionStatus(
    contractId: string,
    criterionId: string,
    to: CriterionStatus,
    options: { readonly reason?: string } = {},
  ): CriterionStatus {
    const current = this.criteria(contractId).find((criterion) => criterion.id === criterionId)
    if (current === undefined)
      throw new Error(`unknown criterion '${criterionId}' on contract '${contractId}'`)
    if (current.status !== to) assertCriterionTransition(current.status, to)
    if (
      to === "passed" &&
      this.criterionEvidence(contractId, criterionId).every((row) => row.status !== "pass")
    )
      throw new Error(
        `criterion '${criterionId}' cannot be marked passed without a passing observation`,
      )
    if (to === "dropped" && (options.reason ?? "").trim() === "")
      throw new Error(`criterion '${criterionId}' cannot be dropped without a reason`)
    this.db
      .query(
        "UPDATE criterion SET status = ?, status_at = ?, status_reason = ? WHERE contract_id = ? AND criterion_id = ?",
      )
      .run(to, this.nowIso(), options.reason ?? null, contractId, criterionId)
    return to
  }

  criterionEvidence(
    contractId: string,
    criterionId: string,
  ): {
    id: number
    status: "pass" | "fail" | "not_run"
    exitCode?: number
    at: string
    observationId?: number
    detail?: string
  }[] {
    return (
      this.db
        .query(
          "SELECT id, status, exit_code, at, observation_id, detail FROM criterion_evidence WHERE contract_id = ? AND criterion_id = ? ORDER BY id",
        )
        .all(contractId, criterionId) as Record<string, unknown>[]
    ).map((row) => ({
      id: Number(row.id),
      status: row.status as "pass" | "fail" | "not_run",
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      at: String(row.at),
      ...(row.observation_id === null ? {} : { observationId: Number(row.observation_id) }),
      ...(row.detail === null ? {} : { detail: String(row.detail) }),
    }))
  }

  /**
   * Record an observation against a criterion and move its status.
   *
   * A dropped criterion is left alone: it is no longer part of the contract, and a later
   * observation must not resurrect it implicitly.
   */
  recordCriterionEvidence(input: {
    readonly contractId: string
    readonly criterionId: string
    readonly status: "pass" | "fail" | "not_run"
    readonly observationId?: number
    readonly exitCode?: number
    readonly detail?: string
  }): void {
    const current = this.criteria(input.contractId).find(
      (criterion) => criterion.id === input.criterionId,
    )
    if (current === undefined)
      throw new Error(`unknown criterion '${input.criterionId}' on contract '${input.contractId}'`)
    if (current.status === "dropped") return
    const at = this.nowIso()
    this.db
      .query(
        `INSERT INTO criterion_evidence (contract_id, criterion_id, observation_id, status, exit_code, at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.contractId,
        input.criterionId,
        input.observationId ?? null,
        input.status,
        input.exitCode ?? null,
        at,
        input.detail ?? null,
      )
    const next: CriterionStatus =
      input.status === "pass" ? "passed" : input.status === "fail" ? "failed" : "not_run"
    // Evidence moves the status directly, without the manual transition matrix. Evidence is
    // the fact the status describes: refusing `passed -> not_run` because the matrix says so
    // would keep a stale success on the record after a check was re-run as unexecuted.
    this.db
      .query(
        "UPDATE criterion SET status = ?, status_at = ? WHERE contract_id = ? AND criterion_id = ?",
      )
      .run(next, at, input.contractId, input.criterionId)
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
