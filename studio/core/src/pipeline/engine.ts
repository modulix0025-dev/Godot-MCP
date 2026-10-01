// SPDX-License-Identifier: Apache-2.0
//
// Pipeline engine (EXECUTION_PROMPT Phase 6). Drives a run's stages in CREATION_PIPELINE order, one at a time:
//
//   - A stage is marked RUNNING (persisted) before its executor starts, and gets SUCCESS / PARTIAL_SUCCESS /
//     FAILED / BLOCKED / NEEDS_HUMAN with evidence afterwards. SUCCESS and PARTIAL_SUCCESS let the run continue;
//     anything else stops it with `run.blocked` explaining why.
//   - Resumable: `execute` starts at the first stage that is not SUCCESS/PARTIAL_SUCCESS. A stage left RUNNING by
//     a crash is simply run again, so executors are idempotent (project files are rewritten with the same content,
//     scene runs and builds are repeatable).
//   - One execution per project at a time.
//   - PARTIAL_SUCCESS always carries a reason naming what was not done (e.g. a missing TRUSTED ComfyUI worker, the
//     Android SDK, the macOS worker). A stage is never reported as done when its work was not done.
//
// The executors use the real services (ProjectFactory, runScene, BuildService); tests inject replacements.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CREATION_PIPELINE,
  MANIFEST_FILES,
  type AssetProvenance,
  type GameSpec,
  type OutcomeStatus,
  type PipelineStage,
} from '@modulex/shared';
import { AuditLog } from '../audit/audit-log.js';
import { Redactor } from '../audit/secrets.js';
import { ProjectCheckpoints } from '../checkpoints/project-checkpoints.js';
import { BuildService, type BuildRequest, type BuildResult, type Platform } from '../build/build-service.js';
import type { StudioDb } from '../db/database.js';
import { generateProject, type GeneratedProject } from '../project/game-generator.js';
import { ProjectFactory } from '../project/project-factory.js';
import type { QaFailure } from '../qa/failures.js';
import { FixLoop, type FixLoopResult } from '../qa/fix-loop.js';
import { GeneratorRestoreFixer } from '../qa/fixers.js';
import { PlaytestSession } from '../qa/playtest.js';
import { loadScenarios, QaRunner, writeScenarios, type SuiteReport } from '../qa/qa-runner.js';
import { defaultScenarios } from '../qa/scenarios.js';
import { runScene, type SceneRun } from '../qa/scene-runner.js';
import type { PipelineRun, ProjectRecord, StudioStore } from '../store/studio-store.js';

export type StageStatus = Exclude<OutcomeStatus, 'PENDING_APPROVAL'>;

export interface StageOutcome {
  status: StageStatus;
  evidence: string[];
  reason?: string | null;
}

export interface StageContext {
  project: ProjectRecord;
  spec: GameSpec;
  run: PipelineRun;
  /** Absolute project directory (null before project_creation). Internal only; never returned to agents. */
  projectDir: string | null;
  generated: GeneratedProject;
  engine: PipelineEngine;
}

export type StageExecutor = (ctx: StageContext) => Promise<StageOutcome>;

/**
 * The Phase 9 QA tier: the full suite (static tier + scripted playtest through the in-game QA runtime on its own
 * playtest server) and the bounded fix loop. Wired only when a gamedev-mcp-server binary is configured
 * (MODULEX_SERVER); without it the playtest stage stays a boot-only PARTIAL_SUCCESS that says so.
 */
export interface QaTier {
  suite(c: StageContext): Promise<SuiteReport>;
  fix(c: StageContext, initial?: QaFailure[]): Promise<FixLoopResult>;
}

export interface PipelineEngineOptions {
  store: StudioStore;
  audit?: AuditLog | null;
  factory: Pick<ProjectFactory, 'create'>;
  builds: Pick<BuildService, 'build'>;
  runScene: (projectDir: string, scene: string, frames?: number) => Promise<SceneRun>;
  /** Override individual stages (tests; later phases plug in the playtest / visual tiers). */
  executors?: Partial<Record<PipelineStage, StageExecutor>>;
  /** The QA tier (null/undefined = boot-only playtest; the reason is recorded). */
  qa?: QaTier | null;
  version?: string;
}

const DONE = new Set<string>(['SUCCESS', 'PARTIAL_SUCCESS']);
/** Asset types the deterministic generator can stand in for with procedural geometry. */
const PROCEDURAL_TYPES = new Set(['character', 'prop', 'environment']);

export function isDone(status: string): boolean {
  return DONE.has(status);
}

/** The profile to build for `build` (a playable internal build) and for `export` (the most distributable one). */
export function chooseProfiles(spec: GameSpec): {
  build: GameSpec['build_profiles'][number];
  export: GameSpec['build_profiles'][number];
} {
  const has = (p: string) => spec.build_profiles.includes(p as never);
  const build = has('QA') ? 'QA' : has('DEV') ? 'DEV' : spec.build_profiles[0]!;
  const exp = has('RELEASE') ? 'RELEASE' : has('PREVIEW') ? 'PREVIEW' : build;
  return { build, export: exp };
}

function summarise(r: BuildResult): string {
  const a = r.artifacts
    .map((x) => `${x.path.split(/[\\/]/).pop()} ${x.size}B sha256:${x.sha256.slice(0, 12)}`)
    .join(', ');
  return `${r.platform}/${r.profile}: ${r.status}${a ? ` — ${a}` : ''}${r.note ? ` (${r.note})` : ''}${r.errors.length ? ` errors: ${r.errors.slice(0, 3).join('; ')}` : ''}`;
}

export class PipelineEngine {
  private readonly running = new Map<string, Promise<PipelineRun>>();
  /** Failures the playtest stage found in this process, handed to bug_fixes (re-derived by the loop on resume). */
  private readonly pendingFailures = new Map<string, QaFailure[]>();

  constructor(private readonly o: PipelineEngineOptions) {}

  /** Create a fresh run for a project with the planning stages done; does not execute. */
  start(projectId: string): PipelineRun {
    return this.o.store.createRun(projectId, null);
  }

  /** True when the scripted QA tier (playtest server + fix loop) is wired. */
  get qaTierAvailable(): boolean {
    return Boolean(this.o.qa);
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  /** Execute (or resume) the latest run. Concurrent calls for the same project share one execution. */
  execute(projectId: string): Promise<PipelineRun> {
    const existing = this.running.get(projectId);
    if (existing) return existing;
    const p = this.loop(projectId).finally(() => this.running.delete(projectId));
    this.running.set(projectId, p);
    return p;
  }

  private async loop(projectId: string): Promise<PipelineRun> {
    const store = this.o.store;
    const project = store.mustProject(projectId);
    const run = project.runs.at(-1);
    if (!run) throw new Error(`project '${projectId}' has no pipeline run`);
    const spec = project.manifests.gameSpec;
    if (!spec) throw new Error(`project '${projectId}' has no Game Specification`);
    if (run.blocked)
      this.audit('pipeline_resumed', { project_id: projectId, run_id: run.run_id, from: run.blocked.code });
    store.setRunBlocked(projectId, run.run_id, null);
    const generated = generateProject(spec);
    for (const stage of CREATION_PIPELINE) {
      const st = run.stages.find((s) => s.stage === stage)!;
      if (isDone(st.status)) continue;
      store.updateStage(projectId, run.run_id, stage, { status: 'RUNNING', reason: null, evidence: [] });
      const ctx: StageContext = { project, spec, run, projectDir: project.path, generated, engine: this };
      let out: StageOutcome;
      try {
        out = await (this.o.executors?.[stage] ?? this.executorFor(stage))(ctx);
      } catch (e) {
        out = { status: 'FAILED', evidence: [], reason: (e as Error).message };
      }
      store.updateStage(projectId, run.run_id, stage, {
        status: out.status,
        evidence: out.evidence,
        reason: out.reason ?? null,
      });
      this.audit('pipeline_stage_completed', { project_id: projectId, run_id: run.run_id, stage, status: out.status });
      if (!isDone(out.status)) {
        if (out.reason) store.addRecentError(projectId, `${stage}: ${out.reason}`, 'pipeline');
        store.setRunBlocked(projectId, run.run_id, {
          code: `STAGE_${out.status}`,
          message: `${stage}: ${out.reason ?? out.status}`,
        });
        break;
      }
    }
    return run;
  }

  private audit(
    type: 'pipeline_stage_completed' | 'pipeline_resumed' | 'build_completed',
    data: Record<string, unknown>,
  ) {
    this.o.audit?.append(type, 'studio-pipeline', data);
  }

  private executorFor(stage: PipelineStage): StageExecutor {
    const map: Partial<Record<PipelineStage, StageExecutor>> = {
      technical_specification: (c) => this.technicalSpecification(c),
      project_creation: (c) => this.projectCreation(c),
      asset_generation: (c) => this.assetGeneration(c),
      asset_processing: (c) => this.assetProcessing(c),
      scene_construction: (c) => this.sceneRuns(c, 'scene', 120),
      gameplay: (c) => this.gameplay(c),
      qa: (c) => this.staticQa(c),
      playtest: (c) => this.playtest(c),
      visual_inspection: async () => ({
        status: 'PARTIAL_SUCCESS',
        evidence: [],
        reason: 'Visual inspection tier (screenshots + deterministic checks) is not wired in this Studio build yet.',
      }),
      bug_fixes: (c) => this.bugFixes(c),
      regression: (c) => this.sceneRuns(c, 'regression', 120),
      optimization: async (c) => ({
        status: 'PARTIAL_SUCCESS',
        evidence: [`target: ${c.spec.performance_targets.fps} fps`],
        reason: 'No performance measurement tier in this Studio build yet; nothing was optimised.',
      }),
      build: (c) => this.build(c),
      export: (c) => this.exportAll(c),
    };
    const fn = map[stage];
    if (!fn) return async () => ({ status: 'SUCCESS', evidence: ['planning stage (manifests stored)'] });
    return fn;
  }

  private dir(c: StageContext): string {
    if (!c.projectDir) throw new Error('project directory unknown — project_creation has not completed');
    return c.projectDir;
  }

  // ---------- stages ----------

  private async technicalSpecification(c: StageContext): Promise<StageOutcome> {
    const g = c.generated;
    return {
      status: 'SUCCESS',
      evidence: [
        `Godot 4.5.1 .NET project, assembly ${g.assembly}`,
        `${g.files.length} generated files`,
        `main scene ${g.mainScene}`,
        `levels: ${g.levelScenes.join(', ')}`,
      ],
    };
  }

  private async projectCreation(c: StageContext): Promise<StageOutcome> {
    const m = c.project.manifests;
    const manifests: Record<string, unknown> = {};
    for (const [k, file] of Object.entries(MANIFEST_FILES)) {
      const v = m[k as keyof typeof m];
      if (v) manifests[file.replace('.modulex/', '')] = v;
    }
    const created = await this.o.factory.create(c.spec, manifests);
    this.o.store.setProjectPath(c.project.project_id, created.projectDir);
    c.projectDir = created.projectDir;
    const evidence = created.steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAILED'} (${Math.round(s.ms / 100) / 10}s)`);
    if (!created.ok) {
      const errs = created.steps.flatMap((s) => s.errors).slice(0, 10);
      return { status: 'FAILED', evidence: [...evidence, ...errs], reason: errs[0] ?? 'project creation failed' };
    }
    return { status: 'SUCCESS', evidence: [...evidence, 'checkpoint: project created from the Game Specification'] };
  }

  private async assetGeneration(c: StageContext): Promise<StageOutcome> {
    const dir = this.dir(c);
    const store = this.o.store;
    const evidence: string[] = [];
    const missing: string[] = [];
    for (const a of c.spec.assets) {
      const scene = c.generated.proceduralAssets[a.id];
      if (scene && PROCEDURAL_TYPES.has(a.type)) {
        const file = join(dir, scene.replace('res://', ''));
        const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
        const record: AssetProvenance = {
          asset_id: a.id,
          asset_type: a.type,
          source: 'procedural',
          generator: 'ModuleX game generator (Godot primitive meshes)',
          workflow_id: null,
          workflow_version: null,
          model: null,
          checkpoint: null,
          custom_nodes: [],
          worker_id: null,
          generated_at: new Date().toISOString(),
          source_reference: scene,
          human_modified: false,
          license_facts: [
            {
              subject: 'source:modulex-procedural',
              license: 'Owner (generated in-project from built-in Godot primitives)',
              commercial_use: 'allowed',
              recorded_by: 'workflow-registry',
            },
          ],
          sha256,
        };
        store.addProvenance(c.project.project_id, record);
        store.updateAssetManifest(c.project.project_id, (m) => {
          const e = m.assets.find((x) => x.id === a.id);
          if (e) Object.assign(e, { state: 'imported', res_path: scene, blocked_reason: null });
        });
        this.audit_provenance(c.project.project_id, a.id);
        evidence.push(`${a.id}: procedural placeholder in ${scene}`);
      } else {
        const reason =
          a.type === 'audio' ? 'no audio generator is configured' : 'needs a TRUSTED ComfyUI worker (none registered)';
        store.updateAssetManifest(c.project.project_id, (m) => {
          const e = m.assets.find((x) => x.id === a.id);
          if (e) Object.assign(e, { state: 'blocked', blocked_reason: reason });
        });
        missing.push(`${a.id} (${a.type}${a.required ? ', required' : ''}): ${reason}`);
      }
    }
    if (!missing.length) return { status: 'SUCCESS', evidence };
    return {
      status: 'PARTIAL_SUCCESS',
      evidence: [...evidence, ...missing.map((m) => `not generated: ${m}`)],
      reason: `${missing.length} asset(s) not generated; the game uses procedural placeholders where possible.`,
    };
  }

  private audit_provenance(projectId: string, assetId: string) {
    this.o.audit?.append('asset_provenance_recorded', 'studio-pipeline', {
      project_id: projectId,
      asset_id: assetId,
      source: 'procedural',
    });
  }

  private async assetProcessing(c: StageContext): Promise<StageOutcome> {
    const assets = c.project.manifests.assetManifest?.assets ?? [];
    const imported = assets.filter((a) => a.state === 'imported');
    return {
      status: 'SUCCESS',
      evidence: [
        `${imported.length} asset(s) in project; procedural placeholders are built-in Godot meshes (no import step)`,
      ],
    };
  }

  private scenesOf(c: StageContext): string[] {
    return ProjectFactory.listScenes(this.dir(c)).map((f) => `res://scenes/${f}`);
  }

  private async runAll(c: StageContext, scenes: string[], frames: number, label: string): Promise<StageOutcome> {
    const dir = this.dir(c);
    const evidence: string[] = [];
    const failures: string[] = [];
    for (const s of scenes) {
      const r = await this.o.runScene(dir, s, frames);
      evidence.push(`${s}: ${r.ok ? 'ok' : 'FAILED'} (${frames} frames, ${Math.round(r.ms / 100) / 10}s)`);
      if (!r.ok) failures.push(`${s}: ${r.errors[0] ?? `exit ${r.exit}`}`);
    }
    if (!scenes.length) return { status: 'FAILED', evidence, reason: `${label}: no scenes found` };
    if (failures.length) return { status: 'FAILED', evidence: [...evidence, ...failures], reason: failures[0] };
    return { status: 'SUCCESS', evidence };
  }

  private sceneRuns(c: StageContext, label: string, frames: number): Promise<StageOutcome> {
    return this.runAll(c, this.scenesOf(c), frames, label);
  }

  private gameplay(c: StageContext): Promise<StageOutcome> {
    return this.runAll(c, c.generated.levelScenes, 600, 'gameplay');
  }

  /** Static tier: required input actions, autoloads, main scene and every script referenced by a scene. */
  private async staticQa(c: StageContext): Promise<StageOutcome> {
    const dir = this.dir(c);
    const pg = readFileSync(join(dir, 'project.godot'), 'utf-8');
    const problems: string[] = [];
    for (const action of ['move_left', 'move_right', 'move_forward', 'move_back', 'jump', 'interact', 'pause'])
      if (!new RegExp(`^${action}=`, 'm').test(pg)) problems.push(`input action '${action}' missing`);
    if (!/^GameState="\*res:\/\/scripts\/game_state\.gd"/m.test(pg)) problems.push('GameState autoload missing');
    const main = /^run\/main_scene="(res:\/\/[^"]+)"/m.exec(pg)?.[1];
    if (!main || !existsSync(join(dir, main.replace('res://', ''))))
      problems.push(`main scene missing (${main ?? 'unset'})`);
    let refs = 0;
    for (const s of this.scenesOf(c)) {
      const text = readFileSync(join(dir, s.replace('res://', '')), 'utf-8');
      for (const m of text.matchAll(/path="(res:\/\/[^"]+)"/g)) {
        refs++;
        if (!existsSync(join(dir, m[1]!.replace('res://', '')))) problems.push(`${s} references missing ${m[1]}`);
      }
    }
    const evidence = [
      `project.godot checked (input map, autoloads, main scene)`,
      `${refs} scene resource references resolved`,
    ];
    if (problems.length) return { status: 'FAILED', evidence: [...evidence, ...problems], reason: problems[0] };
    return { status: 'SUCCESS', evidence };
  }

  private async playtest(c: StageContext): Promise<StageOutcome> {
    const qa = this.o.qa;
    if (!qa) {
      const r = await this.runAll(c, [c.generated.mainScene], 900, 'playtest');
      if (!isDone(r.status)) return r;
      return {
        status: 'PARTIAL_SUCCESS',
        evidence: r.evidence,
        reason:
          'Boot playtest only (900 frames from the main scene): no gamedev-mcp-server is configured (MODULEX_SERVER), so the scripted QA scenarios did not run.',
      };
    }
    const report = await qa.suite(c);
    const evidence = [
      `static tier: ${report.static.build.length} build error(s), ${report.static.scenes.filter((s) => s.ok).length}/${report.static.scenes.length} scenes ok`,
      ...(report.playtest ?? []).map(
        (s) =>
          `scenario ${s.id}: ${s.status} (${s.steps.filter((x) => x.status === 'passed').length}/${s.steps.length} steps)`,
      ),
      ...report.failures.map(
        (f) => `${f.class} ${f.fingerprint} ${f.file ?? ''}:${f.line ?? ''} — ${f.message.slice(0, 160)}`,
      ),
    ];
    if (!report.playtest)
      return { status: 'FAILED', evidence, reason: 'the scripted playtest did not run (no playtest session)' };
    if (!report.failures.length) return { status: 'SUCCESS', evidence };
    this.pendingFailures.set(c.project.project_id, report.failures);
    return {
      status: 'PARTIAL_SUCCESS',
      evidence,
      reason: `${report.failures.length} QA failure(s) found; handed to bug_fixes (fix loop)`,
    };
  }

  private async bugFixes(c: StageContext): Promise<StageOutcome> {
    const qa = this.o.qa;
    const playtest = c.run.stages.find((s) => s.stage === 'playtest');
    const pending = this.pendingFailures.get(c.project.project_id);
    // The playtest found failures (in this process, or before a restart: its reason says so) → run the fix loop.
    if (qa && (pending?.length || /QA failure\(s\) found/.test(playtest?.reason ?? ''))) {
      const r = await qa.fix(c, pending);
      this.pendingFailures.delete(c.project.project_id);
      const evidence = [
        ...r.attempts.map((a) => `fix ${a.class} #${a.attempt} (${a.checkpoint}): ${a.outcome} — ${a.proposal}`),
        r.summary,
      ];
      if (r.status === 'SUCCESS') return { status: 'SUCCESS', evidence };
      return { status: 'BLOCKED', evidence, reason: r.summary };
    }
    const failed = c.run.stages.filter((s) => s.status === 'FAILED');
    if (!failed.length) return { status: 'SUCCESS', evidence: ['no failures recorded in this run; nothing to fix'] };
    return {
      status: 'NEEDS_HUMAN',
      evidence: failed.map((s) => `${s.stage}: ${s.reason ?? 'failed'}`),
      reason: 'The automatic fix loop needs the QA tier (MODULEX_SERVER) to verify a fix.',
    };
  }

  private buildRequest(c: StageContext, platform: Platform, profile: BuildRequest['profile']): BuildRequest {
    return {
      projectId: c.project.project_id,
      projectDir: this.dir(c),
      assembly: c.generated.assembly,
      platform,
      profile,
      version: this.o.version ?? '0.1.0',
    };
  }

  private async runBuild(c: StageContext, platform: Platform, profile: BuildRequest['profile']): Promise<BuildResult> {
    const r = await this.o.builds.build(this.buildRequest(c, platform, profile));
    const first = r.artifacts[0];
    this.o.store.addBuild(c.project.project_id, {
      build_id: r.build_id,
      platform,
      profile,
      status: r.status,
      version: this.o.version ?? '0.1.0',
      sha256: first?.sha256 ?? null,
      size_bytes: first?.size ?? null,
      created_at: new Date().toISOString(),
      note: r.note ?? (r.errors[0] || null),
    });
    this.audit('build_completed', {
      project_id: c.project.project_id,
      build_id: r.build_id,
      platform,
      profile,
      status: r.status,
    });
    return r;
  }

  /** A playable internal build for the first desktop platform (Windows), the one QA uses. */
  private async build(c: StageContext): Promise<StageOutcome> {
    const { build } = chooseProfiles(c.spec);
    const platform: Platform = c.spec.platforms.includes('windows') ? 'windows' : c.spec.platforms[0]!;
    const r = await this.runBuild(c, platform, build);
    if (r.status === 'FAILED')
      return { status: 'FAILED', evidence: [summarise(r)], reason: r.errors[0] ?? 'build failed' };
    if (r.status === 'BUILT') return { status: 'SUCCESS', evidence: [summarise(r)] };
    return { status: 'PARTIAL_SUCCESS', evidence: [summarise(r)], reason: r.note ?? r.errors[0] ?? r.status };
  }

  /** Every platform in the spec at its most distributable profile. BUILT everywhere → SUCCESS. */
  private async exportAll(c: StageContext): Promise<StageOutcome> {
    const profile = chooseProfiles(c.spec).export;
    const results: BuildResult[] = [];
    for (const platform of c.spec.platforms) results.push(await this.runBuild(c, platform, profile));
    const evidence = results.map(summarise);
    const failed = results.filter((r) => r.status === 'FAILED');
    if (failed.length)
      return {
        status: 'FAILED',
        evidence,
        reason: `${failed[0]!.platform}: ${failed[0]!.errors[0] ?? 'export failed'}`,
      };
    const notBuilt = results.filter((r) => r.status !== 'BUILT');
    if (!notBuilt.length) return { status: 'SUCCESS', evidence };
    if (notBuilt.length === results.length && !results.some((r) => r.status === 'PREPARED'))
      return {
        status: 'BLOCKED',
        evidence,
        reason: notBuilt.map((r) => `${r.platform}: ${r.note ?? r.errors[0]}`).join('; '),
      };
    return {
      status: 'PARTIAL_SUCCESS',
      evidence,
      reason: notBuilt.map((r) => `${r.platform} ${r.status}: ${r.errors[0] ?? r.note}`).join('; '),
    };
  }
}

export interface PipelineHostConfig {
  /** Verified Godot 4.5.1 .NET binary. */
  godot: string;
  /** Where game projects are created, e.g. %USERPROFILE%\ModuleX Games. */
  projectsRoot: string;
  /** Directory holding the bundled `godot_mcp/` and `modulex_studio/` addon sources. */
  addonsSource: string;
  dotnet?: string;
  androidSdk?: string | null;
  /** gamedev-mcp-server binary for the playtest server (MODULEX_SERVER); unset → boot-only playtest. */
  serverBinary?: string | null;
  /** Run the playtest game windowed (screenshots need a GPU/display). Default true. */
  windowed?: boolean;
  env?: NodeJS.ProcessEnv;
  db?: StudioDb | null;
}

/** The real QA tier: QaRunner (static + playtest) per project, the fix loop with the generator-restore fixer. */
export function createQaTier(
  host: PipelineHostConfig & { serverBinary: string },
  deps: { audit?: AuditLog | null; redactor?: Redactor },
): QaTier {
  const redactor = deps.redactor ?? new Redactor();
  const audit = deps.audit ?? new AuditLog(redactor);
  const runnerFor = (c: StageContext): { runner: QaRunner; dir: string } => {
    const dir = c.projectDir;
    if (!dir) throw new Error('playtest: the project has not been created yet');
    if (!loadScenarios(dir).length) writeScenarios(dir, defaultScenarios(c.spec, c.generated));
    const runner = new QaRunner({
      projectId: c.project.project_id,
      projectDir: dir,
      godot: host.godot,
      solution: join(dir, `${c.generated.assembly}.sln`),
      dotnet: host.dotnet,
      env: host.env,
      db: host.db,
      playtest: () =>
        new PlaytestSession({
          godot: host.godot,
          serverBinary: host.serverBinary,
          projectDir: dir,
          audit,
          redactor,
          db: host.db,
          windowed: host.windowed ?? true,
        }),
    });
    return { runner, dir };
  };
  return {
    async suite(c) {
      const { runner } = runnerFor(c);
      await runner.runSuite();
      return runner.lastReport!;
    },
    async fix(c, initial) {
      const { runner, dir } = runnerFor(c);
      return new FixLoop({
        projectId: c.project.project_id,
        checkpoints: new ProjectCheckpoints(dir, c.project.project_id, host.db),
        fixer: new GeneratorRestoreFixer(dir, c.generated),
        runSuite: () => runner.runSuite(),
        db: host.db,
      }).run(initial);
    },
  };
}

/** Wire the real services (ProjectFactory, headless scene runs, BuildService) into an engine. */
export function createPipelineEngine(
  host: PipelineHostConfig,
  deps: { store: StudioStore; audit?: AuditLog | null; redactor?: Redactor },
): PipelineEngine {
  const env = host.env;
  const serverBinary = host.serverBinary;
  return new PipelineEngine({
    store: deps.store,
    audit: deps.audit,
    factory: new ProjectFactory({ ...host }),
    builds: new BuildService({ godot: host.godot, db: host.db, env, androidSdk: host.androidSdk }),
    runScene: (dir, scene, frames) => runScene(host.godot, dir, scene, frames, { ...process.env, ...env }),
    qa: serverBinary ? createQaTier({ ...host, serverBinary }, deps) : null,
  });
}
