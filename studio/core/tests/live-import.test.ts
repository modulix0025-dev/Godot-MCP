// SPDX-License-Identifier: Apache-2.0
//
// GATE 8 (live): import a valid GLB into a REAL Godot 4.5.1 editor through the Studio importer — checkpoint,
// copy, full scan, resource-find, project-validate-resources, instance into a scratch scene, scene-get-data,
// screenshot-isolated thumbnail — and prove a malformed file never reaches res://. Same environment as GATE 4.
// With DISPLAY set (Xvfb), the editor runs windowed so the thumbnail renders; headless, the thumbnail step is
// reported as not rendered and the import is PARTIAL_SUCCESS (never a blank image passed off as a thumbnail).
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { GodotAssetImporter } from '../src/assets/godot-import.js';
import { StudioDb } from '../src/db/database.js';
import { GodotSession } from '../src/godot/godot-session.js';
import { makeGlb } from './fixtures/glb.js';

const GODOT = process.env.MODULEX_LIVE_GODOT;
const SERVER = process.env.MODULEX_LIVE_SERVER;
const PROJECT = process.env.MODULEX_LIVE_PROJECT;
const live = Boolean(GODOT && SERVER && PROJECT && existsSync(GODOT) && existsSync(SERVER) && existsSync(PROJECT));
const windowed = Boolean(process.env.DISPLAY);

describe.runIf(live)('GATE 8 — Godot import of a generated GLB', () => {
  let dir: string;
  let session: GodotSession;
  let importer: GodotAssetImporter;

  beforeAll(async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'mx-gate8-')), 'proj');
    cpSync(PROJECT!, dir, { recursive: true });
    const redactor = new Redactor();
    session = new GodotSession({
      projectId: 'gate8',
      projectPath: dir,
      godot: GODOT!,
      serverBinary: SERVER!,
      audit: new AuditLog(redactor),
      redactor,
      db: new StudioDb(':memory:'),
      headless: !windowed,
    });
    await session.start();
    session.checkpoints.init();
    importer = new GodotAssetImporter(session);
  }, 240_000);

  afterAll(async () => {
    await session?.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('a valid GLB is imported, instanced and inspected', async () => {
    const r = await importer.import({
      projectDir: dir,
      assetId: 'crate',
      category: 'prop',
      name: 'crate',
      bytes: makeGlb({ n: 8 }),
    });
    for (const row of r.rows) console.log(`[gate8] ${row.ok ? 'ok ' : 'BAD'} ${row.check}: ${row.detail}`);
    expect(r.res_path).toBe('res://assets/generated/prop/crate/crate.glb');
    expect(existsSync(join(dir, 'assets/generated/prop/crate/crate.glb'))).toBe(true);
    expect(r.rows.find((x) => x.check === 'scene_tree')?.ok).toBe(true);
    if (windowed) {
      expect(r.status).toBe('SUCCESS');
      expect(r.thumbnail_png?.subarray(1, 4).toString('ascii')).toBe('PNG');
      writeFileSync(join(tmpdir(), 'gate8-thumbnail.png'), r.thumbnail_png!);
      console.log(`[gate8] thumbnail ${r.thumbnail_png!.length} bytes → ${join(tmpdir(), 'gate8-thumbnail.png')}`);
    } else {
      expect(r.status).toBe('PARTIAL_SUCCESS');
      console.log(`[gate8] headless: ${r.reason}`);
    }
    console.log('[gate8] live import: exercised');
  }, 180_000);

  it('a malformed GLB never reaches res://', async () => {
    const r = await importer.import({
      projectDir: dir,
      assetId: 'bad',
      category: 'prop',
      name: 'bad',
      bytes: makeGlb({ badMagic: true }),
    });
    expect(r.status).toBe('FAILED');
    expect(existsSync(join(dir, 'assets/generated/prop/bad'))).toBe(false);
  });
});
