// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreServer } from '../src/server.js';

let core: CoreServer | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

describe('Studio Core server', () => {
  it('binds loopback on a random port and hands off a fresh token', async () => {
    core = await startCore();
    const addr = core.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
    expect(core.handshake.port).toBeGreaterThan(0);
    expect(core.handshake.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('serves /health only with the bearer token', async () => {
    core = await startCore();
    const url = `http://127.0.0.1:${core.handshake.port}/health`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: `Bearer ${core.handshake.token}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; godotCli: string[] };
    expect(body.ok).toBe(true);
    expect(body.godotCli).toContain('createProject');
  });
});
