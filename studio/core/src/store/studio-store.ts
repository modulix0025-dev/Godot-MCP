// SPDX-License-Identifier: Apache-2.0
//
// Studio state for the gateway and the Studio MCP tools: projects with their manifests, provenance records,
// builds, pipeline runs, and the worker registry. In-memory with optional JSON persistence; Phase 4 moves the
// same shapes into SQLite (studio.db) without changing this interface. Never stores a secret: workers carry
// `secret_ref` handles only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CREATION_PIPELINE,
  MANIFEST_FILES,
  type AssetManifest,
  type AssetProvenance,
  type BuildManifest,
  type GameSpec,
  type OutcomeStatus,
  type PipelineStage,
  type SceneManifest,
  type TaskGraph,
  type TestManifest,
  type WorkerRecord,
} from '@modulex/shared';

export interface BuildRecord {
  build_id: string;
  platform: 'windows' | 'android' | 'ios';
  profile: 'DEV' | 'QA' | 'PREVIEW' | 'RELEASE';
  status: 'BUILT' | 'PREPARED' | 'SIGNED' | 'BLOCKED' | 'FAILED';
  version: string;
  sha256: string | null;
  size_bytes: number | null;
  created_at: string;
  note: string | null;
}

export interface StageState {
  stage: PipelineStage;
  status: OutcomeStatus | 'PENDING' | 'RUNNING';
  evidence: string[];
  reason: string | null;
}

export interface PipelineRun {
  run_id: string;
  created_at: string;
  stages: StageState[];
  /** Why the run is not progressing (e.g. the pipeline engine is not available in this build). */
  blocked: { code: string; message: string } | null;
}

export interface ProjectRecord {
  project_id: string;
  name: string;
  /** Absolute path of the Godot project on disk; null until created. Internal only — never sent to agents. */
  path: string | null;
  created_at: string;
  current_scene: string | null;
  recent_errors: { at: string; message: string; source: string }[];
  manifests: {
    gameSpec: GameSpec | null;
    sceneManifest: SceneManifest | null;
    assetManifest: AssetManifest | null;
    taskGraph: TaskGraph | null;
    buildManifest: BuildManifest | null;
    testManifest: TestManifest | null;
  };
  provenance: AssetProvenance[];
  builds: BuildRecord[];
  runs: PipelineRun[];
}

interface Snapshot {
  projects: ProjectRecord[];
  workers: WorkerRecord[];
}

const PLANNING_EVIDENCE = {
  user_request: 'game-spec.json#project.brief (owner words, verbatim)',
  game_specification: MANIFEST_FILES.gameSpec,
  scene_manifest: MANIFEST_FILES.sceneManifest,
  asset_manifest: MANIFEST_FILES.assetManifest,
  task_graph: MANIFEST_FILES.taskGraph,
} as const;

const key = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);

/** Deterministically derive the planning manifests from a Game Specification (same spec → same manifests). */
export function deriveManifests(
  spec: GameSpec,
): Pick<
  ProjectRecord['manifests'],
  'sceneManifest' | 'assetManifest' | 'taskGraph' | 'testManifest' | 'buildManifest'
> {
  const main = spec.scenes.find((s) => s.id === 'main_menu')?.id ?? spec.scenes[0]!.id;
  const sceneManifest: SceneManifest = {
    schema: 1,
    scenes: spec.scenes.map((s) => ({
      id: s.id,
      path: `res://scenes/${s.id}.tscn`,
      root_type: 'Node3D',
      main: s.id === main,
      assets: [],
      status: 'planned',
    })),
  };
  const assetManifest: AssetManifest = {
    schema: 1,
    assets: spec.assets.map((a) => ({
      id: a.id,
      type: a.type,
      required: a.required,
      state: 'planned',
      res_path: null,
      provenance_id: null,
      produces: [],
      blocked_reason: null,
    })),
  };
  const P = spec.project.id;
  const t = (id: string, kind: TaskGraph['tasks'][number]['kind'], title: string, deps: string[]) => ({
    id,
    kind,
    title,
    depends_on: deps,
    idempotency_key: key(P, id),
    status: 'pending' as const,
  });
  const assetTasks = spec.assets.map((a) =>
    t(`asset_${a.id}`, 'asset', `Generate + validate asset ${a.id}`, ['project']),
  );
  const sceneTasks = spec.scenes.map((s) =>
    t(`scene_${s.id}`, 'scene', `Build scene ${s.id}`, ['project', ...assetTasks.map((x) => x.id)]),
  );
  const gameplayTasks = spec.mechanics.map((m) =>
    t(
      `gameplay_${m.id}`,
      'gameplay',
      `Implement ${m.id}`,
      sceneTasks.map((x) => x.id),
    ),
  );
  const qa = t(
    'qa',
    'qa',
    'Static + playtest + visual QA',
    gameplayTasks.map((x) => x.id),
  );
  const builds = spec.platforms.map((p) => t(`build_${p}`, p === 'ios' ? 'export' : 'build', `Build ${p}`, ['qa']));
  const taskGraph: TaskGraph = {
    schema: 1,
    tasks: [
      { ...t('spec', 'spec', 'Game specification', []), status: 'done' },
      t('project', 'project', 'Create Godot project from template', ['spec']),
      ...assetTasks,
      ...sceneTasks,
      ...gameplayTasks,
      qa,
      ...builds,
    ],
  };
  const testManifest: TestManifest = {
    schema: 1,
    tests: [
      {
        id: 'build_clean',
        tier: 'static',
        mandatory: true,
        description: 'C# build clean; scripts validate',
        scenario: null,
      },
      {
        id: 'resources_valid',
        tier: 'static',
        mandatory: true,
        description: 'project-validate-resources reports no problems',
        scenario: null,
      },
      {
        id: 'boots_main',
        tier: 'playtest',
        mandatory: true,
        description: 'Boots to the main scene within 10 s',
        scenario: '.modulex/tests/boots_main.json',
      },
      {
        id: 'player_moves',
        tier: 'playtest',
        mandatory: true,
        description: 'Player moves on move_* actions',
        scenario: '.modulex/tests/player_moves.json',
      },
      {
        id: 'no_runtime_errors',
        tier: 'playtest',
        mandatory: true,
        description: 'No runtime errors during the default scenarios',
        scenario: null,
      },
      {
        id: 'hud_visible',
        tier: 'visual',
        mandatory: true,
        description: 'HUD visible, inside the viewport, no overlaps',
        scenario: null,
      },
      ...spec.win_conditions.map((w, i) => ({
        id: `win_${i + 1}`,
        tier: 'playtest' as const,
        mandatory: true,
        description: `Win condition reachable: ${w}`,
        scenario: `.modulex/tests/win_${i + 1}.json`,
      })),
    ],
  };
  const buildManifest: BuildManifest = {
    schema: 1,
    version: '0.1.0',
    android_version_code: 1,
    targets: spec.platforms.flatMap((platform) =>
      spec.build_profiles.map((profile) => ({ platform, profile, requested: true })),
    ),
  };
  return { sceneManifest, assetManifest, taskGraph, testManifest, buildManifest };
}

export class StudioStore {
  private projects = new Map<string, ProjectRecord>();
  private workers = new Map<string, WorkerRecord>();

  constructor(
    private readonly persistPath?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (persistPath && existsSync(persistPath)) {
      const snap = JSON.parse(readFileSync(persistPath, 'utf-8')) as Snapshot;
      for (const p of snap.projects) this.projects.set(p.project_id, p);
      for (const w of snap.workers) this.workers.set(w.worker_id, w);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const snap: Snapshot = { projects: [...this.projects.values()], workers: [...this.workers.values()] };
    writeFileSync(this.persistPath, JSON.stringify(snap, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  listProjects(): ProjectRecord[] {
    return [...this.projects.values()].sort((a, b) => a.project_id.localeCompare(b.project_id));
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.projects.get(id);
  }

  /** Create or return the project for a spec (idempotent on the project id). */
  upsertFromSpec(spec: GameSpec): { project: ProjectRecord; created: boolean } {
    const existing = this.projects.get(spec.project.id);
    const derived = deriveManifests(spec);
    if (existing) {
      existing.manifests = { gameSpec: spec, ...derived };
      this.save();
      return { project: existing, created: false };
    }
    const project: ProjectRecord = {
      project_id: spec.project.id,
      name: spec.project.name,
      path: null,
      created_at: this.now().toISOString(),
      current_scene: null,
      recent_errors: [],
      manifests: { gameSpec: spec, ...derived },
      provenance: [],
      builds: [],
      runs: [],
    };
    this.projects.set(project.project_id, project);
    this.save();
    return { project, created: true };
  }

  /** Create a pipeline run with the planning stages marked done (evidence = the stored manifests). */
  createRun(projectId: string, blocked: PipelineRun['blocked']): PipelineRun {
    const p = this.mustProject(projectId);
    const planning = new Set<PipelineStage>([
      'user_request',
      'game_specification',
      'scene_manifest',
      'asset_manifest',
      'task_graph',
    ]);
    const run: PipelineRun = {
      run_id: `run_${key(projectId, String(p.runs.length + 1)).slice(0, 12)}`,
      created_at: this.now().toISOString(),
      stages: CREATION_PIPELINE.map((stage) => ({
        stage,
        status: planning.has(stage)
          ? 'SUCCESS'
          : stage === 'technical_specification' || stage === 'project_creation'
            ? blocked
              ? 'BLOCKED'
              : 'PENDING'
            : 'PENDING',
        evidence: planning.has(stage) ? [PLANNING_EVIDENCE[stage as keyof typeof PLANNING_EVIDENCE]] : [],
        reason:
          !planning.has(stage) && blocked && (stage === 'technical_specification' || stage === 'project_creation')
            ? blocked.message
            : null,
      })),
      blocked,
    };
    p.runs.push(run);
    this.save();
    return run;
  }

  setProjectPath(projectId: string, path: string): void {
    this.mustProject(projectId).path = path;
    this.save();
  }

  addProvenance(projectId: string, record: AssetProvenance): void {
    const p = this.mustProject(projectId);
    p.provenance = [...p.provenance.filter((r) => r.asset_id !== record.asset_id), record];
    const a = p.manifests.assetManifest?.assets.find((x) => x.id === record.asset_id);
    if (a) a.provenance_id = record.asset_id;
    this.save();
  }

  updateAssetManifest(projectId: string, fn: (m: AssetManifest) => void): void {
    const p = this.mustProject(projectId);
    if (p.manifests.assetManifest) fn(p.manifests.assetManifest);
    this.save();
  }

  addBuild(projectId: string, b: BuildRecord): void {
    this.mustProject(projectId).builds.push(b);
    this.save();
  }

  listWorkers(): WorkerRecord[] {
    return [...this.workers.values()].sort((a, b) => a.worker_id.localeCompare(b.worker_id));
  }

  getWorker(id: string): WorkerRecord | undefined {
    return this.workers.get(id);
  }

  putWorker(w: WorkerRecord): void {
    this.workers.set(w.worker_id, w);
    this.save();
  }

  mustProject(id: string): ProjectRecord {
    const p = this.projects.get(id);
    if (!p) throw new Error(`unknown project '${id}'`);
    return p;
  }
}
