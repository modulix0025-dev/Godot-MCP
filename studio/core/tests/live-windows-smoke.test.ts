// SPDX-License-Identifier: Apache-2.0
//
// GATE 10 (Windows host): export the sample game for Windows in QA and RELEASE, then smoke-test both:
//   QA       the exported debug exe runs the default scenarios through the in-game QA runtime;
//   RELEASE  the exe (no MCP inside) stays alive for 10 s and is then closed.
// Needs MODULEX_LIVE_GODOT (+ export templates) and MODULEX_LIVE_SERVER (the win-x64 server) on a Windows host.
// MODULEX_SMOKE_HEADLESS=1 runs without a window (a host with no usable GPU); the log says which mode ran.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_GAME_SPEC } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { BuildService } from '../src/build/build-service.js';
import { smokeDebug, smokeRelease } from '../src/build/smoke.js';
import { StudioDb } from '../src/db/database.js';
import { ProjectFactory } from '../src/project/project-factory.js';
import { defaultScenarios } from '../src/qa/scenarios.js';

const GODOT = process.env.MODULEX_LIVE_GODOT;
const SERVER = process.env.MODULEX_LIVE_SERVER;
const headless = process.env.MODULEX_SMOKE_HEADLESS === '1';
const live = process.platform === 'win32' && Boolean(GODOT && SERVER && existsSync(GODOT) && existsSync(SERVER));

describe.runIf(live)('GATE 10 — Windows export + smoke test (QA and RELEASE)', () => {
  it(
    'exports both configurations and both pass their smoke test',
    async () => {
      const db = new StudioDb(':memory:');
      const redactor = new Redactor();
      const audit = new AuditLog(redactor);
      const root = process.env.MODULEX_LIVE_PROJECTS_ROOT ?? mkdtempSync(join(tmpdir(), 'mx-gate10-'));
      const factory = new ProjectFactory({
        projectsRoot: root,
        addonsSource: resolve(__dirname, '../../../addons'),
        godot: GODOT!,
        db,
      });
      const created = await factory.create(SAMPLE_GAME_SPEC);
      for (const s of created.steps)
        console.log(`[gate10] ${s.step}: ${s.ok ? 'ok' : 'FAILED'} ${s.errors.slice(0, 3).join(' | ')}`);
      expect(created.ok).toBe(true);
      const builds = new BuildService({ godot: GODOT!, db });
      const base = {
        projectId: SAMPLE_GAME_SPEC.project.id,
        projectDir: created.projectDir,
        assembly: created.generated.assembly,
        platform: 'windows' as const,
        version: '0.1.0',
      };
      const qa = await builds.build({ ...base, profile: 'QA' });
      const rel = await builds.build({ ...base, profile: 'RELEASE' });
      for (const b of [qa, rel])
        console.log(
          `[gate10] ${b.profile}: ${b.status} ${b.artifacts.map((a) => `${a.path.split(/[\\/]/).pop()} ${a.size}B ${a.sha256.slice(0, 12)}`).join(', ')} ${b.errors.join('; ')}`,
        );
      expect(qa.status).toBe('BUILT');
      expect(rel.status).toBe('BUILT');

      console.log(`[gate10] mode: ${headless ? 'headless (no window verified)' : 'windowed'}`);
      const scenarios = defaultScenarios(SAMPLE_GAME_SPEC, created.generated);
      const debug = await smokeDebug(qa.artifacts[0]!.path, scenarios, {
        serverBinary: SERVER!,
        projectDir: created.projectDir,
        audit,
        redactor,
        db,
        windowed: !headless,
      });
      for (const r of debug.results) console.log(`[gate10] QA scenario ${r.id}: ${r.status}`);
      for (const f of debug.failures) console.log(`[gate10] QA failure ${f.class}: ${f.message.slice(0, 200)}`);
      expect(debug.failures).toEqual([]);
      expect(debug.results.length).toBe(scenarios.length);

      const release = await smokeRelease(rel.artifacts[0]!.path, { args: headless ? ['--headless'] : undefined });
      console.log(`[gate10] RELEASE alive ${release.alive} for ${release.aliveMs} ms (exit ${release.exitCode})`);
      expect(release.alive).toBe(true);
      console.log('[gate10] Windows QA + RELEASE smoke: exercised');
    },
    45 * 60_000,
  );
});
