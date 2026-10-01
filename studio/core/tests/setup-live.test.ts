// SPDX-License-Identifier: Apache-2.0
//
// Setup Assistant against the REAL official sources (opt-in: MODULEX_LIVE_SETUP=1). Installs, for the host OS,
// Godot 4.5.1 mono (SHA512-SUMS.txt), gamedev-mcp-server 9.2.9 (SHA256SUMS) and the .NET 8 SDK (releases.json
// SHA-512) into a temp data dir, with the real archive extraction, then runs `godot --version` and `dotnet --version`
// from what it installed. MODULEX_LIVE_SETUP_COMPONENTS narrows the set (comma-separated).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentId } from '@modulex/shared';
import { SetupAssistant } from '../src/setup/assistant.js';

const live = process.env.MODULEX_LIVE_SETUP === '1';
const wanted = (process.env.MODULEX_LIVE_SETUP_COMPONENTS ?? 'godot-mono,mcp-server,dotnet-sdk').split(
  ',',
) as ComponentId[];

describe.runIf(live)('Setup Assistant — live official sources', () => {
  it(
    `installs ${wanted.join(', ')} checksum-verified and they run`,
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'mx-setup-live-'));
      const a = new SetupAssistant({ dataDir, templatesDir: join(dataDir, 'export_templates') });
      for (const id of wanted) {
        const st = await a.install(id);
        console.log(
          `[setup-live] ${id}: ${st.status} ${st.version ?? ''} ${st.verified?.slice(0, 24) ?? ''}… ${st.message ?? ''}`,
        );
        expect(st.status, `${id}: ${st.message}`).toBe('installed');
      }
      const env = a.env();
      if (env.MODULEX_GODOT) {
        const v = execFileSync(env.MODULEX_GODOT, ['--version', '--headless']).toString().trim().split('\n').pop();
        console.log(`[setup-live] godot --version: ${v}`);
        expect(v).toMatch(/^4\.5\.1\.stable\.mono/);
      }
      if (env.DOTNET_ROOT) {
        const d = execFileSync(join(env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'), [
          '--version',
        ])
          .toString()
          .trim();
        console.log(`[setup-live] dotnet --version: ${d}`);
        expect(d).toMatch(/^8\.0\./);
      }
      console.log('[setup-live] official sources: exercised');
    },
    30 * 60_000,
  );
});

it.skipIf(live)('Setup Assistant live official sources: not exercised (set MODULEX_LIVE_SETUP=1)', () => undefined);
