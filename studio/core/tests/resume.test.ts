// SPDX-License-Identifier: Apache-2.0
//
// GATE 12: resumability, the completion predicate wired to the pipeline, and budgets.
//   - Core killed at "scene 17 of 30": a new Core on the same store + studio.db resumes at scene 17 (scenes 1-16 are
//     not re-run), and the interrupted run continues on start (resumeInterrupted).
//   - Core killed mid-generation: a new job system on the same studio.db follows the persisted prompt_id; the
//     ComfyUI worker accepted exactly one prompt (no duplicate job).
//   - Core killed mid-build: covered end to end in build-workers.test.ts (GATE 11, "kill -9 of Core mid-build").
//   - The completion verdict is computed from evidence after every execution; stage SUCCESS alone never makes a game
//     complete, and no tool can set it.
//   - Budgets: a stage estimate above the cap stops NEEDS_HUMAN; an over-budget tool call becomes an Ask.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREATION_PIPELINE,
  ONBOARDING_STEPS,
  SAMPLE_GAME_SPEC,
  type GameSpec,
  type PipelineStage,
} from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { ComfyClient } from '../src/comfy/client.js';
import { ComfyJobSystem, type JobRequest, type WorkerHandle } from '../src/comfy/jobs.js';
import { loadWorkflows } from '../src/comfy/registry.js';
import { Budget, monthStart } from '../src/cost/budget.js';
import { StudioDb } from '../src/db/database.js';
import { Gateway } from '../src/gateway/gateway.js';
import { createHandlers } from '../src/gateway/tool-handlers.js';
import { PipelineEngine, type StageExecutor } from '../src/pipeline/engine.js';
import { completionOf } from '../src/pipeline/completion.js';
import type { SceneRun } from '../src/qa/scene-runner.js';
import { StudioStore } from '../src/store/studio-store.js';
import { startMockComfy, type MockComfy } from './fixtures/mock-comfy.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-g12-'));
const spec = (): GameSpec => structuredClone(SAMPLE_GAME_SPEC);
const ID = SAMPLE_GAME_SPEC.project.id;

function fakes(skip: PipelineStage[]): Partial<Record<PipelineStage, StageExecutor>> {
  const all: Partial<Record<PipelineStage, StageExecutor>> = {};
  for (const s of CREATION_PIPELINE)
    if (!skip.includes(s)) all[s] = async () => ({ status: 'SUCCESS', evidence: [`${s} ok`] });
  return all;
}
const unused = async () => {
  throw new Error('not used');
};

function projectWithScenes(n: number): string {
  const dir = tmp();
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  for (let i = 1; i <= n; i++)
    writeFileSync(join(dir, 'scenes', `scene_${String(i).padStart(2, '0')}.tscn`), '[gd_scene format=3]\n');
  return dir;
}

describe('GATE 12 — resumability', () => {
  it('Core killed at scene 17 of 30: the next Core resumes at scene 17, scenes 1-16 are not re-run', async () => {
    const storePath = join(tmp(), 'studio-store.json');
    const dbPath = join(tmp(), 'studio.db');
    const dir = projectWithScenes(30);

    // Core #1 — dies while scene 17 is running (its runScene never returns; nothing more is persisted).
    const store1 = new StudioStore(storePath);
    store1.upsertFromSpec(spec());
    store1.setProjectPath(ID, dir);
    const ran1: string[] = [];
    const core1 = new PipelineEngine({
      store: store1,
      db: new StudioDb(dbPath),
      factory: { create: unused },
      builds: { build: unused },
      runScene: (_d, scene) => {
        ran1.push(scene);
        if (ran1.length === 17) return new Promise<SceneRun>(() => undefined); // killed here
        return Promise.resolve({ scene, ok: true, errors: [], exit: 0, ms: 5 });
      },
      executors: fakes(['scene_construction']),
    });
    core1.start(ID);
    void core1.execute(ID);
    for (let i = 0; i < 200 && ran1.length < 17; i++) await new Promise((r) => setTimeout(r, 5));
    expect(ran1).toHaveLength(17);

    // Core #2 — a fresh process on the same files. On start it resumes the interrupted run by itself.
    const store2 = new StudioStore(storePath);
    expect(
      store2
        .getProject(ID)!
        .runs.at(-1)!
        .stages.find((s) => s.stage === 'scene_construction')!.status,
    ).toBe('RUNNING');
    const ran2: string[] = [];
    const core2 = new PipelineEngine({
      store: store2,
      db: new StudioDb(dbPath),
      factory: { create: unused },
      builds: { build: unused },
      runScene: async (_d, scene) => {
        ran2.push(scene);
        return { scene, ok: true, errors: [], exit: 0, ms: 5 };
      },
      executors: fakes(['scene_construction']),
    });
    const resumed = core2.resumeInterrupted();
    expect(resumed).toHaveLength(1);
    const run = await resumed[0]!;
    expect(ran2[0]).toBe('res://scenes/scene_17.tscn');
    expect(ran2).toHaveLength(14); // 17..30
    const sc = run.stages.find((s) => s.stage === 'scene_construction')!;
    expect(sc.status).toBe('SUCCESS');
    expect(sc.evidence.filter((e) => e.includes('verified before the restart'))).toHaveLength(16);
    expect(new Set([...ran1.slice(0, 16), ...ran2]).size).toBe(30);
  });

  it('a re-run stage skips verified scenes and runs only what is new or unverified', async () => {
    const dbPath = join(tmp(), 'studio.db');
    const dir = projectWithScenes(3);
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    store.setProjectPath(ID, dir);
    const ran: string[] = [];
    const mk = () =>
      new PipelineEngine({
        store,
        db: new StudioDb(dbPath),
        factory: { create: unused },
        builds: { build: unused },
        runScene: async (_d, scene) => {
          ran.push(scene);
          return { scene, ok: true, errors: [], exit: 0, ms: 1 };
        },
        executors: fakes(['scene_construction']),
      });
    const e = mk();
    const r = e.start(ID);
    await e.execute(ID);
    expect(ran).toHaveLength(3);
    // The stage runs again in the same run (resumed after a later failure) and a scene was added meanwhile.
    store.updateStage(ID, r.run_id, 'scene_construction', { status: 'RUNNING' });
    writeFileSync(join(dir, 'scenes', 'scene_04.tscn'), '[gd_scene format=3]\n');
    ran.length = 0;
    await mk().execute(ID);
    expect(ran).toEqual(['res://scenes/scene_04.tscn']);
  });

  it('Core killed mid-generation: the next Core follows the persisted prompt_id — the worker saw one job', async () => {
    const mock: MockComfy = await startMockComfy({ pollsToComplete: 3 });
    mocks.push(mock);
    const dbPath = join(tmp(), 'studio.db');
    const wf = loadWorkflows(resolve(__dirname, '../../workflows')).find(
      (w) => w.definition.id === '3D_PROP.hunyuan3d2',
    )!;
    const definition = { ...wf.definition, verification: { status: 'VERIFIED' as const, evidence: 'test' } };
    const handle: WorkerHandle = {
      record: {
        worker_id: 'gpu-1',
        kind: 'comfyui',
        provider: 'local',
        location: 'test',
        base_url: mock.url,
        transport: 'loopback',
        secret_ref: null,
        gpu: 'RTX 4090',
        comfy_version: '0.3.60',
        vram_gb: 24,
        capabilities: ['3d', 'image', 'texture'],
        auth_status: 'ok',
        last_health_at: null,
        trust: 'TRUSTED',
        failure_count: 0,
        cost_class: 'low',
        onboarding: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, 'passed'])) as never,
        quarantine_reason: null,
      },
      client: new ComfyClient({ baseUrl: mock.url }),
      costPerHourUsd: 1.8,
      priority: 1,
      nodes: [...(definition.required_nodes ?? [])],
    };
    const request: JobRequest = {
      idempotencyKey: 'space-kid:asset:crate',
      projectId: ID,
      assetId: 'crate',
      workflow: definition,
      graph: wf.graph,
      inputs: { reference_image: 'crate.png', prompt: 'a wooden crate' },
      purpose: 'production',
    };
    let t = 0;
    // Core #1: the process dies during its first wait for the running job.
    const core1 = new ComfyJobSystem({
      db: new StudioDb(dbPath),
      workers: () => [handle],
      cacheDir: tmp(),
      pollMs: 1000,
      sleep: async () => {
        throw new Error('core killed');
      },
      now: () => t,
    });
    await core1.run(request).catch(() => undefined);
    expect(mock.accepted).toHaveLength(1);

    // Core #2 on the same studio.db.
    const core2 = new ComfyJobSystem({
      db: new StudioDb(dbPath),
      workers: () => [handle],
      cacheDir: tmp(),
      pollMs: 1000,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    const r = await core2.run(request);
    expect(r.status).toBe('SUCCESS');
    expect(mock.accepted).toHaveLength(1); // no duplicate ComfyUI job
    expect(r.prompt_ids).toEqual(mock.accepted);
  });
});

const mocks: MockComfy[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});

describe('completion predicate wired to the pipeline', () => {
  it('every stage SUCCESS is still not a complete game without platform evidence', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const e = new PipelineEngine({
      store,
      factory: { create: unused },
      builds: { build: unused },
      runScene: unused,
      executors: fakes([]),
    });
    e.start(ID);
    const run = await e.execute(ID);
    const v = store.getProject(ID)!.runs.at(-1)!.completion!;
    expect(run.stages.every((s) => s.status === 'SUCCESS')).toBe(true);
    expect(v.isGameComplete).toBe(false);
    expect(v.status).not.toBe('SUCCESS');
    expect(v.missing.some((m) => m.startsWith('windows.'))).toBe(true);
  });

  it('SUCCESS only with every evidence row: builds with sha256, a launch smoke, a signed iOS release', () => {
    const store = new StudioStore();
    const s = spec();
    store.upsertFromSpec(s);
    const run = store.createRun(ID, null);
    for (const st of run.stages) store.updateStage(ID, run.run_id, st.stage, { status: 'SUCCESS' });
    const p = () => store.getProject(ID)!;
    for (const a of p().manifests.assetManifest!.assets.filter((x) => x.required))
      store.addProvenance(ID, {
        asset_id: a.id,
        source: 'procedural',
        generator: 'modulex-procedural',
        workflow_id: null,
        workflow_version: null,
        model: null,
        worker_id: null,
        prompt_hash: null,
        seed: null,
        generated_at: new Date().toISOString(),
        source_reference: 'res://scenes/main.tscn',
        human_modified: false,
        license_facts: [
          {
            subject: 'source:modulex-procedural',
            license: 'Owner',
            commercial_use: 'allowed',
            evidence: 'built-in primitives',
          },
        ],
      } as never);
    const exportProfile = 'RELEASE';
    const add = (platform: 'windows' | 'android' | 'ios', status: 'BUILT' | 'PREPARED' | 'SIGNED', smoke?: boolean) =>
      store.addBuild(ID, {
        build_id: `b_${platform}`,
        platform,
        profile: exportProfile,
        status,
        version: '0.1.0',
        sha256: 'a'.repeat(64),
        size_bytes: 1,
        created_at: new Date().toISOString(),
        note: status === 'SIGNED' ? 'SIGNED on build worker bw_1 (job bj_x)' : null,
        smoke,
      });
    const verdict = () => completionOf(p(), p().runs.at(-1)!, exportProfile);
    expect(verdict().isGameComplete).toBe(false);
    for (const platform of s.platforms) add(platform, platform === 'ios' ? 'PREPARED' : 'BUILT', true);
    const partial = verdict();
    expect(partial.isGameComplete).toBe(false);
    if (s.platforms.includes('ios')) expect(partial.failed.join()).toMatch(/ios\.signedBuild/);
    for (const platform of s.platforms) if (platform === 'ios') add('ios', 'SIGNED');
    if (s.platforms.includes('android')) expect(verdict().notes.join()).toMatch(/not device-tested/);
    // Windows launch smoke missing → never complete.
    store.setBuildSmoke(ID, 'b_windows', null);
    expect(verdict().missing).toContain('windows.launchSmokePassed');
    store.setBuildSmoke(ID, 'b_windows', true);
    // A partial playtest (boot only) proves nothing.
    store.updateStage(ID, p().runs.at(-1)!.run_id, 'playtest', { status: 'PARTIAL_SUCCESS' });
    expect(verdict().missing).toContain('qa.smokeTestsPass');
  });
});

describe('budgets and the Ask tier', () => {
  it('Budget: per-project and monthly caps, with the numbers', () => {
    const db = new StudioDb(':memory:');
    const now = new Date('2026-10-15T12:00:00Z');
    const b = new Budget(
      db,
      () => ({ monthly_usd: 10, per_project_usd: 4 }),
      () => now,
    );
    expect(b.check('p1', 3).ok).toBe(true);
    db.addCost({ project_id: 'p1', kind: 'gpu_seconds', ref: null, quantity: 3600, unit: 's', usd: 3.5 });
    const over = b.check('p1', 1);
    expect(over).toMatchObject({ ok: false });
    expect(over.reason).toMatch(/per-project budget \$4\.00/);
    expect(over.detail).toMatch(/project p1 \$3\.50 of \$4\.00/);
    db.addCost({ project_id: 'p2', kind: 'gpu_seconds', ref: null, quantity: 1, unit: 's', usd: 6 });
    expect(b.check('p3', 1).reason).toMatch(/monthly budget/);
    expect(monthStart(now)).toBe('2026-10-01T00:00:00.000Z');
  });

  it('a stage whose estimate crosses the budget stops NEEDS_HUMAN with the numbers; nothing runs', async () => {
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    let generated = 0;
    const db = new StudioDb(':memory:');
    const e = new PipelineEngine({
      store,
      factory: { create: unused },
      builds: { build: unused },
      runScene: unused,
      executors: {
        ...fakes([]),
        asset_generation: async () => {
          generated++;
          return { status: 'SUCCESS', evidence: [] };
        },
      },
      budget: new Budget(db, () => ({ monthly_usd: 50, per_project_usd: 1 })),
      estimateUsd: (stage) => (stage === 'asset_generation' ? 2.5 : 0),
    });
    e.start(ID);
    const run = await e.execute(ID);
    const st = run.stages.find((s) => s.stage === 'asset_generation')!;
    expect(st.status).toBe('NEEDS_HUMAN');
    expect(st.reason).toMatch(/per-project budget \$1\.00/);
    expect(st.evidence[0]).toMatch(/estimate \$2\.50/);
    expect(generated).toBe(0);
    expect(store.getProject(ID)!.runs.at(-1)!.completion!.status).toBe('NEEDS_HUMAN');
  });

  it('an over-budget tool call becomes an owner approval (Ask); within budget it runs', async () => {
    const audit = new AuditLog(new Redactor());
    const store = new StudioStore();
    store.upsertFromSpec(spec());
    const handlers = new Map(createHandlers());
    const base = handlers.get('studio_pipeline_status')!;
    // A read tool the agent may call without approval, given a cost estimate for this test.
    handlers.set('studio_pipeline_status', { ...base, estimateCostUsd: () => 0.1 });
    const db = new StudioDb(':memory:');
    const caps = { monthly_usd: 50, per_project_usd: 1 };
    const gw = new Gateway({ audit, store, handlers, budget: new Budget(db, () => caps) });
    const ctx = { caller: 'modulex-agent' as const, role: 'producer' as const };
    const ok = await gw.call('studio_pipeline_status', { project_id: ID }, ctx);
    expect(ok.status).toBe('SUCCESS');
    db.addCost({ project_id: ID, kind: 'gpu_seconds', ref: null, quantity: 1, unit: 's', usd: 0.95 });
    const ask = await gw.call('studio_pipeline_status', { project_id: ID }, ctx);
    expect(ask.status).toBe('PENDING_APPROVAL');
    expect(JSON.stringify(ask)).toMatch(/per-project budget \$1\.00 would be exceeded/);
  });
});
