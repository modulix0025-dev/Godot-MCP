// SPDX-License-Identifier: Apache-2.0
//
// GATE 6/10 — live: SAMPLE_GAME_SPEC → studio_game_create → the real pipeline engine creates the Godot 4.5.1 .NET
// project, imports and compiles it, runs every scene headless, runs the static QA tier, builds Windows QA and exports
// every platform. Runs only when MODULEX_LIVE_GODOT points at the Godot binary (with export templates installed);
// otherwise skipped and reported as not exercised — never faked. MODULEX_LIVE_PROJECTS_ROOT keeps the generated
// project and its builds (CI uploads the Windows RELEASE build as the downloadable sample game).
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_GAME_SPEC } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { StudioDb } from '../src/db/database.js';
import { Gateway } from '../src/gateway/gateway.js';
import { createHandlers } from '../src/gateway/tool-handlers.js';
import { createPipelineEngine } from '../src/pipeline/engine.js';
import { StudioStore } from '../src/store/studio-store.js';

const GODOT = process.env.MODULEX_LIVE_GODOT;
const live = Boolean(GODOT && existsSync(GODOT));

describe.runIf(live)('GATE 6 — Game Specification to exported builds', () => {
  it(
    'studio_game_create runs the whole creation pipeline',
    async () => {
      const store = new StudioStore();
      const audit = new AuditLog(new Redactor());
      const db = new StudioDb(':memory:');
      const projectsRoot = process.env.MODULEX_LIVE_PROJECTS_ROOT ?? mkdtempSync(join(tmpdir(), 'mx-gate6-'));
      const pipeline = createPipelineEngine(
        { godot: GODOT!, projectsRoot, addonsSource: resolve(__dirname, '../../../addons'), db },
        { store, audit },
      );
      const gateway = new Gateway({ audit, store, handlers: createHandlers(), pipeline });
      const id = SAMPLE_GAME_SPEC.project.id;
      const r = await gateway.call('studio_game_create', { spec: SAMPLE_GAME_SPEC }, { caller: 'claude-desktop' });
      expect(r.status).toBe('SUCCESS');
      await pipeline.execute(id); // joins the background execution
      const run = store.getProject(id)!.runs.at(-1)!;
      for (const s of run.stages)
        console.log(`[gate6] ${s.stage}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}\n  ${s.evidence.join('\n  ')}`);
      expect(run.blocked).toBeNull();
      const status = (st: string) => run.stages.find((s) => s.stage === st)!.status;
      for (const st of [
        'technical_specification',
        'project_creation',
        'scene_construction',
        'gameplay',
        'qa',
        'regression',
        'build',
      ])
        expect(status(st), st).toBe('SUCCESS');
      // Windows exports; Android is BLOCKED without an SDK and iOS is PREPARED on a non-macOS host → PARTIAL.
      expect(['SUCCESS', 'PARTIAL_SUCCESS']).toContain(status('export'));
      const builds = store.getProject(id)!.builds;
      expect(builds.find((b) => b.platform === 'windows' && b.profile === 'QA')?.status).toBe('BUILT');
      expect(builds.find((b) => b.platform === 'windows' && b.profile === 'RELEASE')?.status).toBe('BUILT');
      expect(builds.find((b) => b.platform === 'ios')?.status).toBe('PREPARED');
      const provenance = store.getProject(id)!.provenance;
      expect(provenance.length).toBeGreaterThan(0);
      expect(provenance.every((p) => p.source === 'procedural')).toBe(true);
      const rel = join(projectsRoot, id, 'build-output', '0.1.0', 'windows-release');
      expect(readdirSync(rel).filter((f) => f.endsWith('.log'))).toEqual([]);
      const data = readdirSync(rel).find((f) => f.startsWith('data_'))!;
      const dlls = readdirSync(join(rel, data));
      expect(dlls).toContain('SpaceKidJourney.dll');
      expect(dlls.filter((f) => /mcp|reflector|signalr/i.test(f))).toEqual([]);
      console.log('[gate6] SAMPLE_GAME_SPEC → project → scenes → QA → Windows QA + RELEASE builds: exercised');
    },
    40 * 60_000,
  );
});
