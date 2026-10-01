// SPDX-License-Identifier: Apache-2.0
//
// The credential store bridge, Core side (D-056): StdioVault speaks the vault-request/vault-response protocol to
// a fake shell that behaves like studio/app/src-tauri/src/vault.rs (refs validated, values kept by the "OS").
// Build worker pairing then works end to end through Core's owner endpoint, and the token stays in the store.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WorkerService } from '../../worker/src/index.js';
import { StdioVault } from '../src/audit/stdio-vault.js';
import { StudioDb } from '../src/db/database.js';
import { startCore } from '../src/server.js';

/** A stand-in for the Rust shell: reads Core's stdout lines, answers on Core's stdin. */
function fakeShell(opts: { store?: boolean; silent?: boolean } = {}) {
  const coreStdout = new PassThrough();
  const coreStdin = new PassThrough();
  const os = new Map<string, string>();
  const seen: string[] = [];
  let buf = '';
  coreStdout.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      seen.push(line);
      if (opts.silent) continue;
      const req = JSON.parse(line) as { id: number; op: string; ref: string; value?: string };
      const name = /^secret:\/\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(req.ref) ? `vault/${req.ref.slice(9)}` : null;
      const reply = (ok: boolean, value: string | null = null, error: string | null = null) =>
        coreStdin.write(`${JSON.stringify({ type: 'vault-response', id: req.id, ok, value, error })}\n`);
      if (!name) reply(false, null, 'invalid secret ref');
      else if (opts.store === false) reply(false, null, 'no credential store on this OS');
      else if (req.op === 'set') {
        os.set(name, req.value!);
        reply(true);
      } else if (req.op === 'get') reply(true, os.get(name) ?? null);
      else if (req.op === 'delete') {
        os.delete(name);
        reply(true);
      }
    }
  });
  return { vault: new StdioVault(coreStdin, coreStdout, undefined, 300), os, seen };
}

describe('StdioVault (credential store bridge)', () => {
  it('stores, resolves and deletes through the shell; the self-test round-trips', async () => {
    const { vault, os } = fakeShell();
    await vault.set('secret://buildworker/abc/token', 'mxw_secret_value');
    expect(os.get('vault/buildworker/abc/token')).toBe('mxw_secret_value');
    expect(await vault.resolve('secret://buildworker/abc/token')).toBe('mxw_secret_value');
    await vault.delete('secret://buildworker/abc/token');
    expect(await vault.resolve('secret://buildworker/abc/token')).toBeNull();
    expect(await vault.selfTest()).toMatchObject({ ok: true });
    expect(os.size).toBe(0);
  });

  it('a refused store throws (never falls back); a silent shell times out instead of hanging', async () => {
    await expect(fakeShell({ store: false }).vault.set('secret://a/b/c', 'v')).rejects.toThrow(/no credential store/);
    await expect(fakeShell().vault.set('secret://bad', 'v')).rejects.toThrow(/invalid secret ref/);
    const silent = fakeShell({ silent: true });
    await expect(silent.vault.set('secret://a/b/c', 'v')).rejects.toThrow(/did not answer/);
    expect(await silent.vault.resolve('secret://a/b/c')).toBeNull();
  });

  it('Core: /vault/selftest and build worker pairing work through the bridge; the token is only in the store', async () => {
    const { vault, os } = fakeShell();
    const svc = new WorkerService({
      stateDir: mkdtempSync(join(tmpdir(), 'mx-bw-')),
      runner: {
        capabilities: async () => ({
          os: 'darwin',
          platforms: ['ios'],
          godot_version: '4.5.1',
          xcode_version: null,
          signing_profiles: [],
        }),
        run: async () => ({ signed: false, artifacts: [] }),
      },
    });
    const { url } = await svc.listen();
    const db = new StudioDb(':memory:');
    const core = await startCore({ db, vault });
    try {
      const post = (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${core.handshake.port}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${core.handshake.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(await (await post('/vault/selftest', {})).json()).toMatchObject({ ok: true });
      const r = await post('/build-workers/pair', { url, code: svc.store.newPairingCode(), name: 'Mac' });
      expect(r.status).toBe(200);
      const rec = (await r.json()) as { token_ref: string };
      const token = os.get(`vault/${rec.token_ref.slice(9)}`);
      expect(token).toMatch(/^mxw_/);
      expect(JSON.stringify(db.all('SELECT * FROM build_workers'))).not.toContain(token!);
    } finally {
      await core.close();
      await svc.close();
    }
    const noBridge = await startCore({});
    try {
      const r = await fetch(`http://127.0.0.1:${noBridge.handshake.port}/vault/selftest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${noBridge.handshake.token}` },
      });
      expect(r.status).toBe(503);
    } finally {
      await noBridge.close();
    }
  });
});
