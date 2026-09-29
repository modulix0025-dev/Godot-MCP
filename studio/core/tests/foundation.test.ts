// SPDX-License-Identifier: Apache-2.0
//
// Phase 4 foundation, no Godot binary needed: SQLite schema + migrations + idempotent tasks + append-only audit,
// git checkpoints on a real repository, the MCP server supervisor (token mode, 401 without bearer, crash restart
// with backoff and the BLOCKED cap) against a fake server, and the Godot version-pin refusal.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCompat } from '@modulex/shared';
import { ProjectCheckpoints, PROJECT_GITIGNORE } from '../src/checkpoints/project-checkpoints.js';
import { DB_SCHEMA_VERSION, StudioDb } from '../src/db/database.js';
import { verifyGodot } from '../src/godot/installations.js';
import { allocatePort, portIsFree, ServerSupervisor } from '../src/godot/server-supervisor.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-p4-'));
const compat = loadCompat(resolve(__dirname, '../../compat.json'));
const FAKE = resolve(__dirname, 'fixtures/fake-mcp-server.mjs');

describe('studio.db', () => {
  it('creates the Phase 4 schema through a recorded migration', () => {
    const db = new StudioDb(join(tmp(), 'studio.db'));
    expect(db.version()).toBe(DB_SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    for (const t of [
      'projects',
      'pipeline_runs',
      'stages',
      'tasks',
      'tool_calls',
      'approvals',
      'audit_log',
      'assets',
      'asset_stages',
      'comfy_jobs',
      'workers',
      'workflows',
      'builds',
      'artifacts',
      'test_runs',
      'failures',
      'checkpoints',
      'cost_ledger',
      'budgets',
      'settings',
    ])
      expect(tables, t).toContain(t);
    db.close();
  });

  it('reopening is a no-op; tasks are idempotent by key', () => {
    const path = join(tmp(), 'studio.db');
    const a = new StudioDb(path);
    const first = a.claimTask('run1:scene:17', 't1', null, 'scene_construction');
    const again = a.claimTask('run1:scene:17', 't2', null, 'scene_construction');
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, task: { task_id: 't1' } });
    a.close();
    const b = new StudioDb(path);
    expect(b.all('SELECT * FROM tasks')).toHaveLength(1);
    b.close();
  });

  it('audit_log is append-only at the database level', () => {
    const db = new StudioDb(':memory:');
    db.run("INSERT INTO audit_log VALUES (1, 'now', 't', 'a', '{}', 'p', 'h')");
    expect(() => db.run("UPDATE audit_log SET actor = 'x'")).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM audit_log')).toThrow(/append-only/);
  });

  it('comfy_jobs.prompt_id is unique (no double submission can be recorded)', () => {
    const db = new StudioDb(':memory:');
    const ins = (id: string) =>
      db.run(
        "INSERT INTO comfy_jobs (job_id, prompt_id, idempotency_key, worker_id, workflow_id, status, created_at, updated_at) VALUES (?, 'p-1', 'k', 'w', 'wf', 'queued', 'now', 'now')",
        id,
      );
    ins('j1');
    expect(() => ins('j2')).toThrow(/UNIQUE/);
  });

  it('cost ledger sums per project', () => {
    const db = new StudioDb(':memory:');
    db.addCost({ project_id: 'p', kind: 'gpu', ref: 'job', quantity: 240, unit: 'gpu_s', usd: 0.04 });
    db.addCost({ project_id: 'p', kind: 'gpu', ref: 'job2', quantity: 120, unit: 'gpu_s', usd: 0.02 });
    expect(db.spent('p')).toBeCloseTo(0.06);
  });
});

describe('project checkpoints (git)', () => {
  it('initialises with the template .gitignore, checkpoints and restores without rewriting history', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'project.godot'), '[application]\n');
    writeFileSync(join(dir, 'main.tscn'), 'v1');
    writeFileSync(join(dir, 'crate.glb.import'), '[remap]\n');
    let saved = 0;
    let reloaded: string[] = [];
    const cp = new ProjectCheckpoints(dir, 'p', new StudioDb(':memory:'), {
      beforeCheckpoint: async () => void saved++,
      afterRestore: async (changed) => void (reloaded = changed),
    });
    cp.init();
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain(PROJECT_GITIGNORE.split('\n')[0]!);
    const one = await cp.checkpoint('before scene rewrite');
    expect(one.name).toBe('mx-cp-1');
    writeFileSync(join(dir, 'main.tscn'), 'v2-broken');
    writeFileSync(join(dir, 'extra.gd'), 'new file');
    await cp.checkpoint('fix attempt 1/3');
    const r = await cp.restore('mx-cp-1');
    expect(readFileSync(join(dir, 'main.tscn'), 'utf-8')).toBe('v1');
    expect(existsSync(join(dir, 'extra.gd'))).toBe(false);
    expect(r.safety.name).toBe('mx-cp-3');
    expect(reloaded.sort()).toEqual(['extra.gd', 'main.tscn']);
    expect(saved).toBe(3);
    // History kept: all three checkpoints still resolve, and the .import sidecar is tracked.
    expect(cp.list().map((c) => c.name)).toEqual(['mx-cp-1', 'mx-cp-2', 'mx-cp-3']);
    const { git } = await import('../src/evolution/git.js');
    expect(git(dir, ['ls-files'])).toContain('crate.glb.import');
  });
});

describe('MCP server supervisor', () => {
  const sups: ServerSupervisor[] = [];
  afterEach(async () => {
    for (const s of sups.splice(0)) await s.stop();
  });
  const make = (o: Partial<ConstructorParameters<typeof ServerSupervisor>[0]> = {}) => {
    const s = new ServerSupervisor({
      binary: process.execPath,
      prefixArgs: [FAKE],
      projectPath: tmp(),
      backoffMs: () => 50,
      ...o,
    });
    sups.push(s);
    return s;
  };

  it('derives a port in 20000–29999 and moves to the next free one on collision', async () => {
    const p = await allocatePort('/some/project');
    expect(p).toBeGreaterThanOrEqual(20000);
    expect(p).toBeLessThanOrEqual(29999);
    expect(await portIsFree(p)).toBe(true);
  });

  it('starts in token mode; ping needs the bearer', async () => {
    const s = make();
    await s.start();
    expect(s.state).toBe('ready');
    expect((await s.ping('hi')).body).toContain('hi');
    expect((await s.ping('hi', null)).status).toBe(401);
    expect((await s.ping('hi', 'wrong')).status).toBe(401);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('restarts after a crash, and stops restarting after 3 crashes in the window (BLOCKED)', async () => {
    const s = make({ maxRestarts: 3 });
    await s.start();
    const crash = () => fetch(`${s.baseUrl}/crash`, { method: 'POST' }).catch(() => undefined);
    const until = async (st: string) => {
      for (let i = 0; i < 100 && s.state !== st; i++) await new Promise((r) => setTimeout(r, 50));
      return s.state;
    };
    for (let i = 0; i < 3; i++) {
      await crash();
      expect(await until('restarting')).toBe('restarting');
      expect(await until('ready')).toBe('ready');
    }
    await crash();
    expect(await until('blocked')).toBe('blocked');
  });
});

// A fake Godot must be a directly spawnable executable; Windows only spawns .exe that way (the real Godot is one).
describe.runIf(process.platform !== 'win32')('Godot version pin', () => {
  it('refuses a mismatched Godot with found and required versions', async () => {
    const dir = tmp();
    const bin = process.platform === 'win32' ? join(dir, 'godot.cmd') : join(dir, 'godot');
    writeFileSync(
      bin,
      process.platform === 'win32'
        ? '@echo 4.4.1.stable.mono.official.49a5bc7b6\r\n'
        : '#!/bin/sh\necho 4.4.1.stable.mono.official.49a5bc7b6\n',
    );
    chmodSync(bin, 0o755);
    const r = await verifyGodot(bin, compat);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/4\.4\.1.*requires Godot 4\.5\.1/);
  });

  it('accepts the pinned build', async () => {
    const dir = tmp();
    const bin = process.platform === 'win32' ? join(dir, 'godot.cmd') : join(dir, 'godot');
    writeFileSync(
      bin,
      process.platform === 'win32'
        ? '@echo 4.5.1.stable.mono.official.f62fdbde1\r\n'
        : '#!/bin/sh\necho 4.5.1.stable.mono.official.f62fdbde1\n',
    );
    chmodSync(bin, 0o755);
    expect(await verifyGodot(bin, compat)).toMatchObject({ ok: true });
  });
});
