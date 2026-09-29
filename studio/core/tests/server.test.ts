// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
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
  });

  it('owner endpoints refuse agent tokens', async () => {
    core = await startCore();
    const r = await fetch(`http://127.0.0.1:${core.handshake.port}/approvals`, {
      headers: { authorization: `Bearer ${core.handshake.claudeDesktopToken}` },
    });
    expect(r.status).toBe(403);
  });
});
