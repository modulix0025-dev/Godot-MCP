// SPDX-License-Identifier: Apache-2.0
//
// Updater verification (Phase 13, D-058). The minisign fixtures were produced by an independent implementation
// (py-minisign 2026): a key, a prehashed (ED) signature and a legacy (Ed) one over update.bin. The release-feed
// steps plug into UpdateManager: a correctly signed release installs; a tampered file, a foreign key, a broken
// trusted comment or a missing public key never reach `install`.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReleaseManifest } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { parsePublicKey, verifyMinisign } from '../src/evolution/minisign.js';
import { releaseFeedSteps } from '../src/evolution/release-feed.js';
import { UpdateManager, type UpdatePlatform } from '../src/evolution/updates.js';

const FX = resolve(__dirname, 'fixtures/minisign');
const data = readFileSync(join(FX, 'update.bin'));
const pub = readFileSync(join(FX, 'key.pub'), 'utf-8');
const sig = readFileSync(join(FX, 'update.bin.minisig'), 'utf-8');
const legacy = readFileSync(join(FX, 'update.bin.legacy.minisig'), 'utf-8');
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('minisign verification (independent fixtures)', () => {
  it('accepts the prehashed and legacy signatures by the right key, also in Tauri base64 wrapping', () => {
    expect(parsePublicKey(pub).key).toHaveLength(32);
    expect(verifyMinisign(data, sig, pub)).toBe(true);
    expect(verifyMinisign(data, legacy, pub)).toBe(true);
    expect(verifyMinisign(data, b64(sig), b64(pub))).toBe(true);
  });

  it('rejects tampered bytes, a tampered trusted comment, another key and garbage', () => {
    const tampered = Buffer.from(data);
    tampered[10] ^= 1;
    expect(verifyMinisign(tampered, sig, pub)).toBe(false);
    expect(verifyMinisign(data, sig.replace('timestamp:1790000000', 'timestamp:1790000001'), pub)).toBe(false);
    const raw = Buffer.from(pub.trim().split('\n')[1]!, 'base64');
    raw[20] ^= 1; // a different Ed25519 key with the same key id
    expect(verifyMinisign(data, sig, `untrusted comment: x\n${raw.toString('base64')}`)).toBe(false);
    expect(verifyMinisign(data, 'nonsense', pub)).toBe(false);
  });
});

let server: Server;
let base = '';
const installer = data;
const feed = (over: Partial<ReleaseManifest> = {}): ReleaseManifest[] => [
  {
    version: '0.2.0',
    channel: 'stable',
    notes: 'test release',
    url: `${base}/ModuleXGameStudioSetup-0.2.0.exe`,
    sha256: createHash('sha256').update(installer).digest('hex'),
    signature: b64(sig),
    min_schema: 1,
    target_schema: 2,
    migrations: [],
    ...over,
  },
];
let current: ReleaseManifest[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/feed.json') return res.end(JSON.stringify(current));
    if (req.url?.endsWith('.exe')) return res.end(installer);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function platform(publicKey: string) {
  const installed: string[] = [];
  // The test server is plain HTTP on loopback; production requires https (checked in download()).
  const steps = releaseFeedSteps({ feedUrl: `${base}/feed.json`, publicKey });
  const p: UpdatePlatform = {
    ...steps,
    download: async (r) => Buffer.from(await (await fetch(r.url)).arrayBuffer()),
    backup: async (label) => `backup:${label}`,
    install: async (_b, r) => void installed.push(r.version),
    migrate: async () => undefined,
    healthCheck: async () => ({ ok: true, detail: 'ok' }),
    restore: async () => undefined,
  };
  return { p, installed };
}

describe('release feed + UpdateManager', () => {
  it('a release signed by the embedded key installs; never automatically, only via apply(owner)', async () => {
    current = feed();
    const m = new UpdateManager(
      join(mkdtempSync(join(tmpdir(), 'mx-upd-')), 'install.json'),
      '0.1.0',
      new AuditLog(new Redactor()),
    );
    const { p, installed } = platform(pub);
    const offered = await m.check(p, 'stable');
    expect(offered?.version).toBe('0.2.0');
    expect(installed).toEqual([]); // checking never installs
    const out = await m.apply(p, offered!, 'owner-ui');
    expect(out.status).toBe('SUCCESS');
    expect(installed).toEqual(['0.2.0']);
  });

  it('a foreign signature, or no public key in this build, fails closed before install', async () => {
    for (const key of [
      '',
      `untrusted comment: other\n${Buffer.from('Ed' + 'k'.repeat(40), 'latin1').toString('base64')}`,
    ]) {
      current = feed();
      const m = new UpdateManager(
        join(mkdtempSync(join(tmpdir(), 'mx-upd-')), 'install.json'),
        '0.1.0',
        new AuditLog(new Redactor()),
      );
      const { p, installed } = platform(key);
      const out = await m.apply(p, (await m.check(p, 'stable'))!, 'owner-ui');
      expect(out).toMatchObject({ status: 'FAILED', failed_step: 'verify' });
      expect(installed).toEqual([]);
    }
  });

  it('stable never sees beta; https is required for downloads in production', async () => {
    current = feed({ channel: 'beta' });
    const m = new UpdateManager(
      join(mkdtempSync(join(tmpdir(), 'mx-upd-')), 'install.json'),
      '0.1.0',
      new AuditLog(new Redactor()),
    );
    expect(await m.check(platform(pub).p, 'stable')).toBeNull();
    await expect(
      releaseFeedSteps({ feedUrl: 'x', publicKey: pub }).download(feed({ url: 'http://example.com/x.exe' })[0]!),
    ).rejects.toThrow(/https/);
  });
});
