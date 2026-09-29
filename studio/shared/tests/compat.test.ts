// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkGodotPin, parseCompat, parseGodotVersion } from '../src/compat.js';

const base = {
  studioVersion: '0.1.0',
  godot: { version: '4.5.1', flavor: 'mono', versionPrefix: '4.5.1.stable.mono' },
  dotnetSdk: '8.0',
  godotNetSdk: '4.5.1',
  addon: { godot_mcp: '0.25.1', modulex_studio: '0.1.0' },
  server: { name: 'gamedev-mcp-server', version: '9.2.9' },
  nuget: { 'com.IvanMurzak.ReflectorNet': '5.4.1', 'com.IvanMurzak.McpPlugin': '8.6.0' },
  dbSchema: 1,
};

describe('parseCompat', () => {
  it('accepts the canonical manifest', () => {
    expect(parseCompat(base).godot.version).toBe('4.5.1');
  });

  it('rejects a versionPrefix that disagrees with the version', () => {
    expect(() => parseCompat({ ...base, godot: { ...base.godot, versionPrefix: '4.5.0.stable.mono' } })).toThrow(
      /versionPrefix/,
    );
  });

  it('rejects a Godot.NET.Sdk that differs from the engine pin', () => {
    expect(() => parseCompat({ ...base, godotNetSdk: '4.3.0' })).toThrow(/Godot.NET.Sdk/);
  });

  it('rejects unknown keys (strict) and a non-mono flavor', () => {
    expect(() => parseCompat({ ...base, extra: true })).toThrow();
    expect(() => parseCompat({ ...base, godot: { ...base.godot, flavor: 'standard' } })).toThrow();
  });
});

describe('parseGodotVersion', () => {
  it.each([
    ['4.5.1.stable.mono.official.f62fdbde1', '4.5.1', 'stable', 'mono', 'official', 'f62fdbde1'],
    ['4.3.stable.mono.official.77dcf97d8', '4.3.0', 'stable', 'mono', 'official', '77dcf97d8'],
    ['4.5.1.stable.official.f62fdbde1', '4.5.1', 'stable', 'standard', 'official', 'f62fdbde1'],
    ['4.6.rc2.mono.official.abcdef123', '4.6.0', 'rc2', 'mono', 'official', 'abcdef123'],
    ['4.5.1.stable.mono', '4.5.1', 'stable', 'mono', null, null],
  ])('%s', (raw, version, status, flavor, build, hash) => {
    expect(parseGodotVersion(raw)).toEqual({ raw, version, status, flavor, build, hash });
  });

  it('skips banner/noise lines and finds the version line', () => {
    expect(parseGodotVersion('WARNING: something\r\n4.5.1.stable.mono.official.f62fdbde1\r\n')?.version).toBe('4.5.1');
  });

  it('returns null for non-version output', () => {
    expect(parseGodotVersion('')).toBeNull();
    expect(parseGodotVersion('Godot Engine v4.5.1 - https://godotengine.org')).toBeNull();
  });
});

describe('checkGodotPin', () => {
  const compat = parseCompat(base);
  it('accepts the exact pinned mono stable build', () => {
    expect(checkGodotPin('4.5.1.stable.mono.official.f62fdbde1', compat).ok).toBe(true);
  });
  it.each([
    ['4.5.0.stable.mono.official.aaaaaa1', 'Godot 4.5.0 mono (stable) found'],
    ['4.5.1.stable.official.f62fdbde1', 'Godot 4.5.1 standard (stable) found'],
    ['4.5.1.rc1.mono.official.abcdef1', 'Godot 4.5.1 mono (rc1) found'],
    ['garbage', 'Unrecognised'],
  ])('refuses %s with found + required versions', (raw, fragment) => {
    const r = checkGodotPin(raw, compat);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(fragment);
      expect(r.reason).toContain('requires Godot 4.5.1 mono (stable)');
    }
  });
});
