// SPDX-License-Identifier: Apache-2.0
//
// GATE 4 — live, against a real Godot 4.5.1 mono editor and the real gamedev-mcp-server. Runs only when the
// environment provides them (CI job `studio-live` / a developer machine); otherwise the suite is skipped and the
// gate is reported as not exercised — it is never faked.
//
//   MODULEX_LIVE_GODOT    Godot 4.5.1 mono editor binary
//   MODULEX_LIVE_SERVER   gamedev-mcp-server binary (the pinned ServerVersion)
//   MODULEX_LIVE_PROJECT  a prepared project (addons copied in, imported, `dotnet build` done)
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCompat } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { StudioDb } from '../src/db/database.js';
import { GodotClient } from '../src/godot/godot-call.js';
import { GodotSession } from '../src/godot/godot-session.js';
import { verifyGodot } from '../src/godot/installations.js';

const GODOT = process.env.MODULEX_LIVE_GODOT;
const SERVER = process.env.MODULEX_LIVE_SERVER;
const PROJECT = process.env.MODULEX_LIVE_PROJECT;
const live = Boolean(GODOT && SERVER && PROJECT && existsSync(GODOT) && existsSync(SERVER) && existsSync(PROJECT));

describe.runIf(live)('GATE 4 — Studio Core against a real Godot editor', () => {
  const compat = loadCompat(resolve(__dirname, '../../compat.json'));
  const redactor = new Redactor();
  const audit = new AuditLog(redactor);
  const db = new StudioDb(':memory:');
  let dir: string;
  let session: GodotSession;
  const log: string[] = [];

  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'mx-gate4-')), 'proj');
    cpSync(PROJECT!, dir, { recursive: true });
    session = new GodotSession({
      projectId: 'gate4',
      projectPath: dir,
      godot: GODOT!,
      serverBinary: SERVER!,
      audit,
      redactor,
      db,
      headless: true,
      onLog: (l) => log.push(l),
    });
    await session.start();
  }, 240_000);

  afterAll(async () => {
    await session?.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('install: the configured Godot is the pinned 4.5.1 mono build', async () => {
    expect(await verifyGodot(GODOT!, compat)).toMatchObject({ ok: true });
  });

  it('server runs in token mode; an unauthorised ping is rejected', async () => {
    expect(session.server.state).toBe('ready');
    expect((await session.server.ping('x', null)).status).toBe(401);
    expect((await session.server.ping('x', 'not-the-token')).status).toBe(401);
  });

  it('editor connects, and the token never appears in the editor log', () => {
    expect(session.editor.running()).toBe(true);
    expect(log.join('\n')).not.toContain(session.server.token);
  });

  it('scene-create → node-create → scene-save through GodotCall, recorded in tool_calls', async () => {
    const c = session.client;
    const created = await c.call({
      tool: 'scene-create',
      args: { resourcePath: 'res://mx_gate4.tscn', rootTypeClassName: 'Node3D', rootName: 'World' },
    });
    expect(created.ok, GodotClient.text(created)).toBe(true);
    const node = await c.call({ tool: 'node-create', args: { name: 'Crate', typeClassName: 'MeshInstance3D' } });
    expect(node.ok, GodotClient.text(node)).toBe(true);
    const saved = await c.call({ tool: 'scene-save', args: {} });
    expect(saved.ok, GodotClient.text(saved)).toBe(true);
    const tscn = readFileSync(join(dir, 'mx_gate4.tscn'), 'utf-8');
    expect(tscn).toContain('name="World"');
    expect(tscn).toContain('name="Crate"');
    const calls = db.all<{ tool: string; status: string }>('SELECT tool, status FROM tool_calls');
    expect(calls.map((x) => x.tool)).toEqual(expect.arrayContaining(['scene-create', 'node-create', 'scene-save']));
    expect(calls.every((x) => x.status === 'success')).toBe(true);
  }, 120_000);

  it('checkpoint and restore round trip through the editor', async () => {
    const cp = session.checkpoints;
    cp.init();
    const base = await cp.checkpoint('gate4 baseline');
    await session.client.call({ tool: 'node-create', args: { name: 'Extra', typeClassName: 'Node3D' } });
    await cp.checkpoint('after adding Extra'); // saves the edited scene first
    expect(readFileSync(join(dir, 'mx_gate4.tscn'), 'utf-8')).toContain('name="Extra"');
    await cp.restore(base.name);
    expect(readFileSync(join(dir, 'mx_gate4.tscn'), 'utf-8')).not.toContain('name="Extra"');
    expect(cp.list().length).toBeGreaterThanOrEqual(3); // history kept
  }, 120_000);

  it('the server is restarted after a crash', async () => {
    const pid = session.server.pid()!;
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 200 && (session.server.state !== 'ready' || session.server.pid() === pid); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(session.server.state).toBe('ready');
    expect(session.server.pid()).not.toBe(pid);
    // Same port and token: the editor plugin reconnects on its own (bounded reconnect).
    await session.editor.waitConnected(90_000);
    expect((await session.server.ping('after-restart')).status).toBe(200);
  }, 150_000);
});

describe.runIf(!live)('GATE 4 — live Godot', () => {
  it.skip('not exercised: set MODULEX_LIVE_GODOT, MODULEX_LIVE_SERVER and MODULEX_LIVE_PROJECT', () => undefined);
});
