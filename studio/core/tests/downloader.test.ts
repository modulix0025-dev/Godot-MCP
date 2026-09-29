// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { download, fileDigest, godotDownloads, parseChecksums } from '../src/setup/downloader.js';

const payload = Buffer.alloc(256 * 1024, 7);
payload.write('godot-archive', 0);
const sha512 = createHash('sha512').update(payload).digest('hex');
let server: Server;
let base = '';
let rangeRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m) {
      rangeRequests++;
      const start = Number(m[1]);
      res.writeHead(206, { 'content-length': payload.length - start }).end(payload.subarray(start));
    } else res.writeHead(200, { 'content-length': payload.length }).end(payload);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Setup Assistant downloader', () => {
  it('verifies the digest before the file is put in place', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'mx-dl-')), 'godot.zip');
    const events: number[] = [];
    await download({ url: `${base}/g.zip`, dest, algorithm: 'sha512', digest: sha512 }, (p) => events.push(p.received));
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(events.at(-1)).toBe(payload.length);
  });

  it('resumes a partial download with a Range request', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'mx-dl-')), 'godot.zip');
    writeFileSync(`${dest}.part`, payload.subarray(0, 100_000));
    const before = rangeRequests;
    let resumed = false;
    await download({ url: `${base}/g.zip`, dest, algorithm: 'sha512', digest: sha512 }, (p) => (resumed ||= p.resumed));
    expect(rangeRequests).toBe(before + 1);
    expect(resumed).toBe(true);
    expect(await fileDigest(dest, 'sha512')).toBe(sha512);
  });

  it('discards a file whose checksum does not match (never used)', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'mx-dl-')), 'godot.zip');
    await expect(
      download({ url: `${base}/g.zip`, dest, algorithm: 'sha512', digest: 'a'.repeat(128) }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('parses official checksum files and builds the pinned Godot URLs', () => {
    const sums = parseChecksums(
      `${'ab'.repeat(64)}  Godot_v4.5.1-stable_mono_win64.zip\n${'cd'.repeat(32)} *other.bin\n`,
    );
    expect(sums.get('Godot_v4.5.1-stable_mono_win64.zip')).toBe('ab'.repeat(64));
    expect(sums.get('other.bin')).toBe('cd'.repeat(32));
    const d = godotDownloads('4.5.1', 'windows');
    expect(d.editor.url).toBe(
      'https://github.com/godotengine/godot-builds/releases/download/4.5.1-stable/Godot_v4.5.1-stable_mono_win64.zip',
    );
    expect(d.sums).toMatch(/SHA512-SUMS\.txt$/);
  });

  it.runIf(existsSync('/srv/mx/SUMS') && existsSync('/srv/mx/godot.zip'))(
    'matches the real Godot 4.5.1 archive against the official SHA512-SUMS (Phase 0 download)',
    async () => {
      const sums = parseChecksums(readFileSync('/srv/mx/SUMS', 'utf-8'));
      const expected = sums.get('Godot_v4.5.1-stable_mono_linux_x86_64.zip');
      expect(expected).toBeDefined();
      expect(await fileDigest('/srv/mx/godot.zip', 'sha512')).toBe(expected);
    },
    120_000,
  );
});
