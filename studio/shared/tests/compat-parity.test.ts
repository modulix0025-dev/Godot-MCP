// SPDX-License-Identifier: Apache-2.0
//
// Drift tripwire (mirrors cli/tests/addon-deps-parity.test.ts): studio/compat.json must agree with every
// repository file that actually pins a version. A pin changed in one place fails CI until all agree.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCompat } from '../src/compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf-8');
const compat = loadCompat(resolve(repo, 'studio', 'compat.json'));

function csprojPins(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  const re = /<PackageReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"[^>]*?\bVersion\s*=\s*"([^"]+)"/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) pins.set(m[1]!, m[2]!);
  return pins;
}

const pluginVersion = (rel: string) => /^version="([^"]+)"/m.exec(read(rel))?.[1];

describe('compat.json parity with the repository pins', () => {
  it('server.version equals ServerVersion in GodotMcpServerView.cs', () => {
    const m = /ServerVersion\s*=\s*"([^"]+)"/.exec(read('addons/godot_mcp/Runtime/Connection/GodotMcpServerView.cs'));
    expect(m?.[1]).toBe(compat.server.version);
  });

  it('nuget pins equal Godot-MCP.csproj, the xUnit project and the ModuleX testbed', () => {
    for (const file of [
      'Godot-MCP.csproj',
      'Godot-MCP.Tests/Godot-MCP.Tests.csproj',
      'Godot-Tests-Modulex/Godot-Tests-Modulex.csproj',
    ]) {
      const pins = csprojPins(read(file));
      for (const [id, version] of Object.entries(compat.nuget)) {
        expect(pins.get(id), `${file}: ${id}`).toBe(version);
      }
    }
  });

  it('the csproj declares no reused pin missing from compat.json', () => {
    const pins = csprojPins(read('Godot-MCP.csproj'));
    expect([...pins.keys()].sort()).toEqual(Object.keys(compat.nuget).sort());
  });

  it('addon versions equal the two plugin.cfg files', () => {
    expect(pluginVersion('addons/godot_mcp/plugin.cfg')).toBe(compat.addon.godot_mcp);
    expect(pluginVersion('addons/modulex_studio/plugin.cfg')).toBe(compat.addon.modulex_studio);
  });

  it('the ModuleX testbed builds with the pinned Godot.NET.Sdk', () => {
    const sdk = /Sdk="Godot\.NET\.Sdk\/([^"]+)"/.exec(read('Godot-Tests-Modulex/Godot-Tests-Modulex.csproj'))?.[1];
    expect(sdk).toBe(compat.godotNetSdk);
  });

  it('the live QA workflow downloads the pinned server and Godot', () => {
    const wf = read('.github/workflows/test_modulex_qa.yml');
    expect(wf).toContain(`SERVER_VERSION: "${compat.server.version}"`);
    expect(wf).toContain(`GODOT_VERSION: "${compat.godot.version}"`);
  });
});
