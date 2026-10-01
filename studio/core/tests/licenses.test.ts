// SPDX-License-Identifier: Apache-2.0
//
// Phase 14 licence compliance. The committed inventory (studio/third-party-licenses.json, rendered to
// docs/modulex/THIRD_PARTY_LICENSES.md) must match what the bundle and the lockfile actually contain, and every
// shipped package must be under a licence the policy allows. Copyleft runtimes (MinGit, the JDK, ComfyUI) are
// separate programs, never linked, and are listed under `binaries` instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const studio = resolve(__dirname, '../..');
const committed = JSON.parse(readFileSync(resolve(studio, 'third-party-licenses.json'), 'utf-8')) as Record<
  string,
  { name: string; version: string; license: string }[]
>;

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'Zlib',
  'CC0-1.0',
  'BSL-1.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'MPL-2.0', // file-level copyleft; used unmodified (Rust crates of the shell)
  'OFL-1.1', // fonts of the UI
  'Apache-2.0 WITH LLVM-exception',
]);

/** SPDX-ish expression → allowed when every AND-term has at least one allowed OR-alternative. */
export function licenceAllowed(expr: string): boolean {
  const e = expr.replace(/[()]/g, ' ').replace(/\//g, ' OR ').trim();
  if (!e || /UNKNOWN|SEE LICENSE/i.test(e)) return false;
  return e.split(/\s+AND\s+/).every((term) => term.split(/\s+OR\s+/).some((alt) => ALLOWED.has(alt.trim())));
}

describe('third-party licences (Phase 14)', () => {
  it('the policy parser', () => {
    expect(licenceAllowed('MIT OR Apache-2.0')).toBe(true);
    expect(licenceAllowed('(MIT OR Apache-2.0) AND Unicode-3.0')).toBe(true);
    expect(licenceAllowed('MIT/Apache-2.0')).toBe(true);
    expect(licenceAllowed('GPL-3.0')).toBe(false);
    expect(licenceAllowed('Apache-2.0 AND LGPL-3.0-or-later')).toBe(false);
    expect(licenceAllowed('LGPL-3.0 OR MIT')).toBe(true);
    expect(licenceAllowed('UNKNOWN')).toBe(false);
  });

  it('every shipped npm package and Rust crate is under an allowed licence', () => {
    for (const section of ['core', 'core_declared_not_bundled', 'ui', 'cargo'])
      for (const p of committed[section] ?? [])
        expect(licenceAllowed(p.license), `${section}: ${p.name}@${p.version} is ${p.license}`).toBe(true);
    expect(committed.cargo!.length).toBeGreaterThan(50);
  });

  it('the inventory matches the real bundle and lockfile (regenerate with node studio/scripts/third-party-licenses.mjs)', async () => {
    const mod = (await import(resolve(studio, 'scripts/third-party-licenses.mjs'))) as {
      inventory: (prev: unknown) => Promise<Record<string, unknown>>;
    };
    const fresh = await mod.inventory(committed);
    expect(fresh.core).toEqual(committed.core);
    expect(fresh.core_declared_not_bundled).toEqual(committed.core_declared_not_bundled);
    expect(fresh.ui).toEqual(committed.ui);
    expect(fresh.models).toEqual((committed as Record<string, unknown>).models);
    let cargo = false;
    try {
      execFileSync('cargo', ['--version'], { stdio: 'ignore' });
      cargo = true;
    } catch {
      /* no cargo on this runner: the committed crate list is policy-checked above */
    }
    if (cargo) expect(fresh.cargo).toEqual(committed.cargo);
  }, 120_000);

  it('the plan-required licences are listed: gltf-transform, meshoptimizer, the Khronos validator, the models', () => {
    const all = [...committed.core!, ...committed.core_declared_not_bundled!];
    const lic = (n: string) => all.find((p) => p.name === n)?.license;
    expect(lic('@gltf-transform/core')).toBe('MIT');
    expect(lic('@gltf-transform/functions')).toBe('MIT');
    expect(lic('meshoptimizer')).toBe('MIT');
    expect(lic('gltf-validator')).toBe('Apache-2.0');
    const models = (committed as unknown as { models: { license: string }[] }).models;
    expect(models.map((m) => m.license)).toEqual(
      expect.arrayContaining(['Tencent Hunyuan 3D 2.0 Community License', 'CreativeML Open RAIL++-M']),
    );
    const md = readFileSync(resolve(studio, '../docs/modulex/THIRD_PARTY_LICENSES.md'), 'utf-8');
    for (const s of ['meshoptimizer', 'gltf-validator', 'Godot Engine 4.5.1', 'Hunyuan', 'GPL-2.0'])
      expect(md).toContain(s);
  });
});
