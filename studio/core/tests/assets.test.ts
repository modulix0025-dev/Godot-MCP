// SPDX-License-Identifier: Apache-2.0
//
// GATE 8 (fixtures): valid, broken-magic, NaN vertices, zero meshes, over-budget and rigged GLBs each get the
// expected verdict; processing brings an over-budget mesh into budget and normalises scale; the stage machine
// blocks an unrigged character; and a malformed file never reaches res:// through the importer.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GodotAssetImporter, looksBlank, pixelVariance } from '../src/assets/godot-import.js';
import { processGlb } from '../src/assets/process.js';
import { assetStages } from '../src/assets/stages.js';
import { validateGlb } from '../src/assets/validate.js';
import { makeGlb, TINY_PNG } from './fixtures/glb.js';

const failed = (v: { rows: { check: string; ok: boolean }[] }) => v.rows.filter((r) => !r.ok).map((r) => r.check);

describe('GLB validation', () => {
  it('a valid prop passes every check with evidence rows', async () => {
    const v = await validateGlb(makeGlb(), { category: 'prop' });
    expect(failed(v)).toEqual([]);
    expect(v.status).toBe('SUCCESS');
    expect(v.rows.map((r) => r.check)).toEqual(
      expect.arrayContaining([
        'container',
        'khronos_validator',
        'mesh',
        'finite',
        'surface',
        'triangle_budget',
        'scale',
      ]),
    );
    expect(v.stats).toMatchObject({ triangles: 32, meshes: 1 });
  });

  it('broken magic fails at the container and is never parsed', async () => {
    const v = await validateGlb(makeGlb({ badMagic: true }), { category: 'prop' });
    expect(v).toMatchObject({ status: 'FAILED', stats: null });
    expect(failed(v)).toEqual(['container']);
  });

  it('NaN vertex positions fail', async () => {
    const v = await validateGlb(makeGlb({ nan: true }), { category: 'prop' });
    expect(v.status).toBe('FAILED');
    expect(failed(v)).toContain('finite');
  });

  it('a file with zero meshes fails', async () => {
    const v = await validateGlb(makeGlb({ noMesh: true }), { category: 'prop' });
    expect(failed(v)).toContain('mesh');
  });

  it('an over-budget mesh fails the triangle budget (24,200 > 20,000 for a prop)', async () => {
    const v = await validateGlb(makeGlb({ n: 110 }), { category: 'prop' });
    expect(v.stats!.triangles).toBe(24_200);
    expect(failed(v)).toEqual(['triangle_budget']);
  });

  it('degenerate geometry fails the surface check', async () => {
    const v = await validateGlb(makeGlb({ degenerate: true }), { category: 'prop' });
    expect(failed(v)).toContain('surface');
  });

  it('the rig checks pass for a rigged sample and fail for an unrigged one', async () => {
    const rigged = await validateGlb(makeGlb({ skin: true, size: 1.8 }), {
      category: 'character',
      rigged: true,
      checkScale: false,
    });
    expect(rigged.rows.filter((r) => r.check.startsWith('rig_')).every((r) => r.ok)).toBe(true);
    const plain = await validateGlb(makeGlb(), { category: 'character', rigged: true, checkScale: false });
    expect(failed(plain)).toEqual(expect.arrayContaining(['rig_skin', 'rig_hierarchy']));
  });

  it('a textured stage requires materials and textures', async () => {
    const v = await validateGlb(makeGlb(), { category: 'prop', textured: true });
    expect(failed(v)).toContain('material');
  });

  it('the file-size cap is enforced', async () => {
    const v = await validateGlb(makeGlb(), { category: 'prop', maxBytes: 100 });
    expect(failed(v)).toContain('file_size');
  });
});

describe('processing', () => {
  it('simplifies an over-budget mesh into budget and normalises it to the target size', async () => {
    const out = await processGlb(makeGlb({ n: 110, size: 40 }), { category: 'prop', targetSize: 1 });
    expect(out.steps.find((s) => s.step === 'optimisation')).toMatchObject({ status: 'done' });
    expect(out.steps.find((s) => s.step === 'normalise')).toMatchObject({ status: 'done' });
    const v = await validateGlb(out.bytes, { category: 'prop', checkScale: false });
    expect(v.status).toBe('SUCCESS');
    expect(v.stats!.triangles).toBeLessThanOrEqual(20_000);
  });
});

describe('asset stage machine', () => {
  it('a mesh-only character that needs a rig ends BLOCKED "requires rigging"', () => {
    const r = assetStages({
      category: 'character',
      produces: ['mesh'],
      needsRig: true,
      referenceProvided: true,
      processing: [{ step: 'cleanup', status: 'done', detail: 'ok' }],
      validated: true,
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.reason).toMatch(/requires rigging/);
    expect(r.rows.find((x) => x.stage === 'texture')!.status).toBe('skipped');
  });

  it('a validated prop is SUCCESS; a failed validation is FAILED', () => {
    const base = {
      category: 'prop' as const,
      produces: ['mesh'],
      needsRig: false,
      referenceProvided: true,
      processing: [],
    };
    expect(assetStages({ ...base, validated: true }).status).toBe('SUCCESS');
    expect(assetStages({ ...base, validated: false }).status).toBe('FAILED');
  });
});

describe('Godot import guard', () => {
  it('a malformed GLB never reaches res:// and no editor call is made', async () => {
    const calls: string[] = [];
    const importer = new GodotAssetImporter({
      client: { call: async (r) => (calls.push(r.tool), { ok: true, result: null, content: [], raw: {} }) },
      checkpoints: {
        checkpoint: async () => (calls.push('checkpoint'), { name: 'mx-cp-1' }) as never,
        restore: async () => ({}) as never,
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'mx-p8-'));
    const r = await importer.import({
      projectDir: dir,
      assetId: 'crate',
      category: 'prop',
      name: 'crate',
      bytes: makeGlb({ nan: true }),
    });
    expect(r.status).toBe('FAILED');
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, 'assets'))).toBe(false);
  });
});

describe('thumbnail check', () => {
  it('a real editor render has variance; a flat or undecodable image is blank', () => {
    const real = readFileSync(join(__dirname, 'fixtures/thumbnail-crate.png'));
    expect(pixelVariance(real)).toBeGreaterThan(100);
    expect(looksBlank(real)).toBe(false);
    expect(looksBlank(TINY_PNG)).toBe(true);
    expect(looksBlank(Buffer.from('not a png'))).toBe(true);
  });
});
