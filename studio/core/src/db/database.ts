// SPDX-License-Identifier: Apache-2.0
//
// Studio database (EXECUTION_PROMPT Phase 4): SQLite through Node's built-in `node:sqlite` (no native addon to
// package — proven in the bundled Node 22 sidecar). Lives at %LOCALAPPDATA%\ModuleXGameStudio\studio.db.
//
// Migrations run in order, each inside a transaction, after a byte backup of the file (Execution Patch 2 §8).
// Secrets never enter this database: rows hold `secret://` handles only.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface DbMigration {
  id: string;
  version: number;
  sql: string;
}

/** Schema v1 — the Phase 4 table set; v2 adds the Phase 11 build worker tables. */
export const MIGRATIONS: DbMigration[] = [
  {
    id: 'm0001_initial',
    version: 1,
    sql: `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, godot_install TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE pipeline_runs (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE stages (
  run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id), stage TEXT NOT NULL, position INTEGER NOT NULL,
  status TEXT NOT NULL, started_at TEXT, finished_at TEXT, evidence TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, stage)
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, run_id TEXT, stage TEXT, idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session TEXT, caller TEXT NOT NULL, role TEXT,
  tool TEXT NOT NULL, tier TEXT, effect TEXT NOT NULL, task_id TEXT, duration_ms INTEGER, status TEXT, error_code TEXT
);
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TRIGGER audit_log_append_only_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_append_only_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
  res_path TEXT, sha256 TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE asset_stages (
  asset_id TEXT NOT NULL REFERENCES assets(asset_id), stage TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  at TEXT NOT NULL, PRIMARY KEY (asset_id, stage)
);
CREATE TABLE comfy_jobs (
  job_id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, worker_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, failure_class TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE workers (worker_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflows (workflow_id TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (workflow_id, version));
CREATE TABLE builds (
  build_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, platform TEXT NOT NULL, profile TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(build_id), path TEXT NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE test_runs (
  test_run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE failures (
  fingerprint TEXT NOT NULL, project_id TEXT NOT NULL, class TEXT NOT NULL, message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);
CREATE TABLE checkpoints (
  project_id TEXT NOT NULL, name TEXT NOT NULL, commit_sha TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, ref TEXT,
  quantity REAL NOT NULL, unit TEXT NOT NULL, usd REAL NOT NULL
);
CREATE TABLE budgets (scope TEXT PRIMARY KEY, usd_cap REAL NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
  },
  {
    // Phase 11: remote build worker jobs. A row is written BEFORE the job is sent (like comfy_jobs), so a Core
    // restart reconciles it with the worker instead of submitting a duplicate.
    id: 'm0002_build_jobs',
    version: 2,
    sql: `
CREATE TABLE build_workers (
  worker_id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, token_ref TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', paired_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE build_jobs (
  job_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, worker_id TEXT NOT NULL, project_id TEXT NOT NULL,
  platform TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, spec TEXT NOT NULL,
  view TEXT, local TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX build_jobs_key ON build_jobs (idempotency_key);
`,
  },
];

export const DB_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class StudioDb {
  readonly db: DatabaseSync;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const existed = path !== ':memory:' && existsSync(path);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL)',
    );
    const pending = MIGRATIONS.filter((m) => !this.applied().includes(m.id));
    if (pending.length && existed) copyFileSync(path, `${path}.bak-v${this.version()}-${Date.now()}`);
    for (const m of pending) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.run(
          'INSERT INTO schema_migrations (id, version, applied_at) VALUES (?, ?, ?)',
          m.id,
          m.version,
          this.iso(),
        );
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`migration ${m.id} failed (database unchanged): ${(e as Error).message}`);
      }
    }
  }

  private applied(): string[] {
    return (this.db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id);
  }

  version(): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return r.v ?? 0;
  }

  iso(): string {
    return this.now().toISOString();
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Idempotent task claim (Phase 12 resumability): the first caller with a key creates the task; later callers
   * get the existing row back and must check its post-conditions instead of redoing the work.
   */
  claimTask(
    key: string,
    taskId: string,
    runId: string | null,
    stage: string | null,
  ): { created: boolean; task: TaskRow } {
    return this.tx(() => {
      const existing = this.get<TaskRow>('SELECT * FROM tasks WHERE idempotency_key = ?', key);
      if (existing) return { created: false, task: existing };
      const at = this.iso();
      this.run(
        'INSERT INTO tasks (task_id, run_id, stage, idempotency_key, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        taskId,
        runId,
        stage,
        key,
        'PENDING',
        at,
        at,
      );
      return { created: true, task: this.get<TaskRow>('SELECT * FROM tasks WHERE task_id = ?', taskId)! };
    });
  }

  updateTask(taskId: string, status: string, result?: unknown): void {
    this.run(
      'UPDATE tasks SET status = ?, attempts = attempts + 1, result = ?, updated_at = ? WHERE task_id = ?',
      status,
      result === undefined ? null : JSON.stringify(result),
      this.iso(),
      taskId,
    );
  }

  recordToolCall(r: {
    session?: string | null;
    caller: string;
    role?: string | null;
    tool: string;
    tier?: string | null;
    effect: string;
    task_id?: string | null;
    duration_ms?: number | null;
    status?: string | null;
    error_code?: string | null;
  }): void {
    this.run(
      'INSERT INTO tool_calls (at, session, caller, role, tool, tier, effect, task_id, duration_ms, status, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.iso(),
      r.session ?? null,
      r.caller,
      r.role ?? null,
      r.tool,
      r.tier ?? null,
      r.effect,
      r.task_id ?? null,
      r.duration_ms ?? null,
      r.status ?? null,
      r.error_code ?? null,
    );
  }

  addCost(r: {
    project_id: string | null;
    kind: string;
    ref: string | null;
    quantity: number;
    unit: string;
    usd: number;
  }): void {
    this.run(
      'INSERT INTO cost_ledger (at, project_id, kind, ref, quantity, unit, usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
      this.iso(),
      r.project_id,
      r.kind,
      r.ref,
      r.quantity,
      r.unit,
      r.usd,
    );
  }

  spent(projectId: string | null): number {
    const r = projectId
      ? this.get<{ s: number | null }>('SELECT SUM(usd) AS s FROM cost_ledger WHERE project_id = ?', projectId)
      : this.get<{ s: number | null }>('SELECT SUM(usd) AS s FROM cost_ledger');
    return r?.s ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export interface TaskRow {
  task_id: string;
  run_id: string | null;
  stage: string | null;
  idempotency_key: string;
  status: string;
  attempts: number;
  result: string | null;
  created_at: string;
  updated_at: string;
}
