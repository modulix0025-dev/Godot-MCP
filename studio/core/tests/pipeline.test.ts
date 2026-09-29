// SPDX-License-Identifier: Apache-2.0
//
// Phase 6/10 without a Godot binary: the deterministic game generator, the pipeline engine's ordering, halting,
// resume and honest PARTIAL_SUCCESS reporting (fake executors / fake services), the Build Service's refusal paths,
// and the studio_game_create → studio_pipeline_resume tool flow through the Gateway.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATION_PIPELINE, SAMPLE_GAME_SPEC, type GameSpec, type PipelineStage } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { BuildService } from '../src/build/build-service.js';
import { Gateway } from '../src/gateway/gateway.js';
import { createHandlers } from '../src/gateway/tool-handlers.js';
import { chooseProfiles, PipelineEngine, type StageExecutor } from '../src/pipeline/engine.js';
import { assemblyName, generateProject, physicalKeycode } from '../src/project/game-generator.js';
import { godotErrors } from '../src/project/project-factory.js';
import { StudioStore } from '../src/store/studio-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-p6-'));
const spec = (): GameSpec => structuredClone(SAMPLE_GAME_SPEC);

describe('game generator', () => {
  it('is deterministic and names a valid C# assembly', () => {
    const a = generateProject(spec());
    const b = generateProject(spec());
    expect(a.files).toEqual(b.files);
    expect(assemblyName('space-kid-journey')).toBe('SpaceKidJourney');
    expect(assemblyName('3d-run')).toMatch(/^[A-Za-z_]/);
  });

  it('writes the input map with the required actions and physical keycodes', () => {
    const g = generateProject(spec());
    const pg = g.files.find((f) => f.path === 'project.godot')!.content;
    for (const a of ['move_left', 'move_right', 'move_forward', 'move_back', 'jump', 'interact', 'pause'])
      expect(pg, a).toMatch(new RegExp(`^${a}=`, 'm'));
    expect(physicalKeycode('W')).toBe(87);
    expect(physicalKeycode('Space')).toBe(32);
    expect(physicalKeycode('NoSuchKey')).toBeNull();
  });

  it('keeps the MCP NuGet references and catalog out of ExportRelease (D-042)', () => {
    const g = generateProject(spec());
    const csproj = g.files.find((f) => f.path.endsWith('.csproj'))!.content;
    const group = /<ItemGroup Condition="'\$\(Configuration\)' != 'ExportRelease'">([\s\S]*?)<\/ItemGroup>/.exec(
      csproj,
    );
    expect(group?.[1]).toContain('com.IvanMurzak.McpPlugin');
    expect(group?.[1]).toContain('com.IvanMurzak.ReflectorNet');
    expect(group?.[1]).toContain('extensions.catalog.json');
    expect(g.files.some((f) => f.path.endsWith('.sln'))).toBe(true);
    const presets = g.files.find((f) => f.path === 'export_presets.cfg')!.content;
    expect(presets).toContain('build-output/*');
  });

  it('produces one scene per level and a main scene', () => {
    const s = spec();
    const g = generateProject(s);
    expect(g.levelScenes).toHaveLength(s.levels.length);
    for (const l of g.levelScenes) expect(g.files.some((f) => `res://${f.path}` === l)).toBe(true);
    expect(g.files.some((f) => `res://${f.path}` === g.mainScene)).toBe(true);
  });
});

describe('godotErrors', () => {
  it('keeps project errors and drops engine-internal editor noise', () => {
    const log = [
      'ERROR: Condition "p_child->data.parent" is true.',
      '   at: add_child (scene/main/node.cpp:1670)',
      'SCRIPT ERROR: Parse Error: Identifier "foo" not declared in the current scope.',
      '   at: GDScript::reload (res://scripts/player.gd:12)',
      'ERROR: Failed loading resource: res://scenes/missing.tscn.',
    ].join('\n');
    const e = godotErrors(log);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatch(/Parse Error/);
    expect(e[1]).toMatch(/missing\.tscn/);
  });
});

describe('build profiles', () => {
  it('builds QA internally and exports the most distributable profile', () => {
    const s = spec();
    s.build_profiles = ['DEV', 'QA', 'RELEASE'];
    expect(chooseProfiles(s)).toEqual({ build: 'QA', export: 'RELEASE' });
    s.build_profiles = ['DEV'];
    expect(chooseProfiles(s)).toEqual({ build: 'DEV', export: 'DEV' });
  });

  it('Android without an SDK is BLOCKED, never faked', async () => {
    const r = await new BuildService({ godot: '/nonexistent/godot' }).build({
      projectId: 'p',
      projectDir: tmp(),
      assembly: 'P',
      platform: 'android',
      profile: 'QA',
      version: '0.1.0',
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.artifacts).toEqual([]);
    expect(r.errors[0]).toMatch(/Android SDK/);
  });

  it('a Windows export whose assemblies are missing is FAILED even when Godot exits 0 (D-011)', async () => {
    const r = await new BuildService({ godot: process.platform === 'win32' ? 'cmd' : 'true' }).build({
      projectId: 'p',
      projectDir: tmp(),
      assembly: 'P',
      platform: 'windows',
      profile: 'QA',
      version: '0.1.0',
    });
    expect(r.status).toBe('FAILED');
    expect(r.errors.join('\n')).toMatch(/no P\.exe|C# assemblies missing/);
  });
});

function engineFor(store: StudioStore, executors: Partial<Record<PipelineStage, StageExecutor>>, calls: string[] = []) {
  const all: Partial<Record<PipelineStage, StageExecutor>> = {};
  for (const s of CREATION_PIPELINE)
    all[s] = async () => {
      calls.push(s);
      return { status: 'SUCCESS', evidence: [`${s} ok`] };
    };
  const unused = async () => {
    throw new Error('not used');
  };
  return new PipelineEngine({
    store,
    factory: { create: unused },
    builds: { build: unused },
    runScene: unused,
    executors: { ...all, ...executors },
  });
}

describe('pipeline engine', () => {
  it('runs every non-planning stage once, in order', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const calls: string[] = [];
    const engine = engineFor(store, {}, calls);
    engine.start(SAMPLE_GAME_SPEC.project.id);
    const run = await engine.execute(SAMPLE_GAME_SPEC.project.id);
    const planning = ['user_request', 'game_specification', 'scene_manifest', 'asset_manifest', 'task_graph'];
    expect(calls).toEqual(CREATION_PIPELINE.filter((s) => !planning.includes(s)));
    expect(run.stages.every((s) => s.status === 'SUCCESS')).toBe(true);
    expect(run.blocked).toBeNull();
  });

  it('stops at a FAILED stage with the reason, and resume re-runs from it', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const id = SAMPLE_GAME_SPEC.project.id;
    let attempts = 0;
    const calls: string[] = [];
    const engine = engineFor(
      store,
      {
        qa: async () => {
          calls.push('qa');
          return ++attempts === 1
            ? { status: 'FAILED', evidence: ['player.gd:12'], reason: 'Parse Error in player.gd' }
            : { status: 'SUCCESS', evidence: ['fixed'] };
        },
      },
      calls,
    );
    engine.start(id);
    const run = await engine.execute(id);
    expect(run.stages.find((s) => s.stage === 'qa')).toMatchObject({
      status: 'FAILED',
      reason: 'Parse Error in player.gd',
    });
    expect(run.stages.find((s) => s.stage === 'playtest')!.status).toBe('PENDING');
    expect(run.blocked).toMatchObject({ code: 'STAGE_FAILED' });
    expect(store.getProject(id)!.recent_errors.at(-1)!.message).toMatch(/qa: Parse Error/);
    calls.length = 0;
    const again = await engine.execute(id);
    expect(calls[0]).toBe('qa');
    expect(calls).not.toContain('project_creation');
    expect(again.stages.every((s) => s.status === 'SUCCESS')).toBe(true);
    expect(again.blocked).toBeNull();
  });

  it('PARTIAL_SUCCESS continues but keeps its reason; a thrown executor becomes FAILED', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const id = SAMPLE_GAME_SPEC.project.id;
    const engine = engineFor(store, {
      asset_generation: async () => ({
        status: 'PARTIAL_SUCCESS',
        evidence: [],
        reason: 'needs a TRUSTED ComfyUI worker',
      }),
      build: async () => {
        throw new Error('disk full');
      },
    });
    engine.start(id);
    const run = await engine.execute(id);
    expect(run.stages.find((s) => s.stage === 'asset_generation')).toMatchObject({
      status: 'PARTIAL_SUCCESS',
      reason: 'needs a TRUSTED ComfyUI worker',
    });
    expect(run.stages.find((s) => s.stage === 'build')).toMatchObject({ status: 'FAILED', reason: 'disk full' });
    expect(run.stages.find((s) => s.stage === 'export')!.status).toBe('PENDING');
  });

  it('a stage left RUNNING by a crash is run again; concurrent execute calls share one run', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const id = SAMPLE_GAME_SPEC.project.id;
    const calls: string[] = [];
    const engine = engineFor(store, {}, calls);
    const run = engine.start(id);
    store.updateStage(id, run.run_id, 'technical_specification', { status: 'SUCCESS' });
    store.updateStage(id, run.run_id, 'project_creation', { status: 'RUNNING' });
    const [a, b] = [engine.execute(id), engine.execute(id)];
    expect(a).toBe(b);
    await a;
    expect(calls[0]).toBe('project_creation');
    expect(calls.filter((c) => c === 'project_creation')).toHaveLength(1);
  });
});

describe('studio_game_create / studio_pipeline_resume', () => {
  const setup = (withEngine: boolean) => {
    const store = new StudioStore();
    const audit = new AuditLog(new Redactor());
    const pipeline = withEngine ? engineFor(store, {}) : null;
    const gateway = new Gateway({ audit, store, handlers: createHandlers(), pipeline });
    return { store, gateway, pipeline };
  };

  it('without an engine: plans only and says why nothing executes', async () => {
    const { gateway } = setup(false);
    const r = await gateway.call('studio_game_create', { spec: SAMPLE_GAME_SPEC }, { caller: 'modulex-agent' });
    expect(r.status).toBe('PARTIAL_SUCCESS');
    expect((r as { data: { pipeline: { blocked: { code: string } } } }).data.pipeline.blocked.code).toBe(
      'PIPELINE_ENGINE_UNAVAILABLE',
    );
    const res = await gateway.call(
      'studio_pipeline_resume',
      { project_id: SAMPLE_GAME_SPEC.project.id },
      { caller: 'modulex-agent' },
    );
    expect(res.status).toBe('BLOCKED');
  });

  it('with an engine: executes in the background; resume after completion is a no-op', async () => {
    const { gateway, store, pipeline } = setup(true);
    const id = SAMPLE_GAME_SPEC.project.id;
    const r = await gateway.call('studio_game_create', { spec: SAMPLE_GAME_SPEC }, { caller: 'claude-desktop' });
    expect(r.status).toBe('SUCCESS');
    for (let i = 0; i < 50 && pipeline!.isRunning(id); i++) await new Promise((res) => setTimeout(res, 10));
    expect(
      store
        .getProject(id)!
        .runs.at(-1)!
        .stages.every((s) => s.status === 'SUCCESS'),
    ).toBe(true);
    const res = await gateway.call('studio_pipeline_resume', { project_id: id }, { caller: 'claude-desktop' });
    expect(res).toMatchObject({ status: 'SUCCESS', data: { executing: false, resumed_from: null } });
  });
});
