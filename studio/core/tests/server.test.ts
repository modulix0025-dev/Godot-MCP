// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerService } from '../../worker/src/index.js';
import { MemoryVault } from '../src/audit/secrets.js';
import { StudioDb } from '../src/db/database.js';
import { startCore, type CoreServer } from '../src/server.js';

let core: CoreServer | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

describe('Studio Core server', () => {
  it('binds loopback on a random port and hands off three distinct fresh tokens', async () => {
    core = await startCore();
    const addr = core.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
    const { token, agentToken, claudeDesktopToken } = core.handshake;
    for (const t of [token, agentToken, claudeDesktopToken]) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([token, agentToken, claudeDesktopToken]).size).toBe(3);
  });

  it('reuses stable pairing tokens passed by the shell', async () => {
    const claudeDesktopToken = 'P'.repeat(43);
    core = await startCore({ claudeDesktopToken });
    expect(core.handshake.claudeDesktopToken).toBe(claudeDesktopToken);
  });

  it('serves /health only with a bearer token and reports the principal', async () => {
    core = await startCore();
    const url = `http://127.0.0.1:${core.handshake.port}/health`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: `Bearer ${core.handshake.token}` } });
    const body = (await ok.json()) as { ok: boolean; godotCli: string[]; principal: string };
    expect(body).toMatchObject({ ok: true, principal: 'owner-ui' });
    expect(body.godotCli).toContain('createProject');
    expect(body).toMatchObject({ pipeline: { available: false, qaTier: false } });
  });

  it('build worker pairing is owner-only, BLOCKED without a vault, and keeps the token out of the response', async () => {
    const owner = (c: CoreServer, path: string, body?: unknown, token = c.handshake.token) =>
      fetch(`http://127.0.0.1:${c.handshake.port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    core = await startCore();
    expect((await owner(core, '/build-workers/pair', { url: 'https://x', code: 'AAAA-AAAA' })).status).toBe(503);
    await core.close();

    const svc = new WorkerService({
      stateDir: mkdtempSync(join(tmpdir(), 'mx-bw-')),
      runner: {
        capabilities: async () => ({
          os: 'darwin',
          platforms: ['ios'],
          godot_version: '4.5.1',
          xcode_version: null,
          signing_profiles: ['AppStore'],
        }),
        run: async () => ({ signed: false, artifacts: [] }),
      },
    });
    const { url } = await svc.listen();
    try {
      const vault = new MemoryVault();
      core = await startCore({ db: new StudioDb(':memory:'), vault });
      const code = svc.store.newPairingCode();
      expect((await owner(core, '/build-workers/pair', { url, code }, core.handshake.agentToken)).status).toBe(403);
      const r = await owner(core, '/build-workers/pair', { url, code, name: 'Mac mini' });
      expect(r.status).toBe(200);
      const rec = (await r.json()) as { token_ref: string };
      const token = await vault.resolve(rec.token_ref);
      expect(token).toBeTruthy();
      const list = await (await owner(core, '/build-workers')).text();
      expect(list).toContain('Mac mini');
      expect(list).not.toContain(token!);
      expect(
        (await (await owner(core, '/build-workers/ios-signing-profile', { name: 'AppStore' })).json()) as object,
      ).toEqual({ ios_signing_profile: 'AppStore' });
    } finally {
      await svc.close();
    }
  });

  it('CORS: only the desktop UI origins get CORS headers; preflight answers without data', async () => {
    core = await startCore();
    const base = `http://127.0.0.1:${core.handshake.port}`;
    const pre = await fetch(`${base}/projects`, {
      method: 'OPTIONS',
      headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    const evil = await fetch(`${base}/projects`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const noToken = await fetch(`${base}/projects`, { headers: { origin: 'http://tauri.localhost' } });
    expect(noToken.status).toBe(401);
    const ok = await fetch(`${base}/projects`, {
      headers: { origin: 'tauri://localhost', authorization: `Bearer ${core.handshake.token}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
  });

  it('owner endpoints refuse agent tokens', async () => {
    core = await startCore();
    const r = await fetch(`http://127.0.0.1:${core.handshake.port}/approvals`, {
      headers: { authorization: `Bearer ${core.handshake.claudeDesktopToken}` },
    });
    expect(r.status).toBe(403);
  });
});
