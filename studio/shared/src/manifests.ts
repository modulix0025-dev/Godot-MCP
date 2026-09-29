// SPDX-License-Identifier: Apache-2.0
//
// Game Specification + project manifests (Execution Patch 1 §9–11). The GAME_SPEC is the authoritative plan
// of a project; the other manifests are derived from it and drive resumable, idempotent execution. They live in
// `<project>/.modulex/` as JSON (one file each) and are versioned with the project's git checkpoints.
import { z } from 'zod';
import { ASSET_TYPES } from './provenance.js';

export const MANIFEST_FILES = {
  gameSpec: '.modulex/game-spec.json',
  sceneManifest: '.modulex/scene-manifest.json',
  assetManifest: '.modulex/asset-manifest.json',
  taskGraph: '.modulex/task-graph.json',
  buildManifest: '.modulex/build-manifest.json',
  testManifest: '.modulex/test-manifest.json',
} as const;

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase id: [a-z0-9_-], max 64');
const text = z.string().min(1).max(4000);
const PLATFORMS = ['windows', 'android', 'ios'] as const;

export const GameSpecSchema = z
  .object({
    schema: z.literal(1),
    project: z
      .object({
        id,
        name: text, // any language; shown as-is
        language: z.string().min(2).max(16), // BCP-47 of the owner's brief, e.g. "ar", "en"
        brief: text, // the owner's words, preserved verbatim
      })
      .strict(),
    genre: text,
    target_audience: text,
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    game_loop: text,
    player: z.object({ description: text, abilities: z.array(text) }).strict(),
    characters: z.array(z.object({ id, name: text, role: text, needs_rig: z.boolean() }).strict()),
    world: text,
    levels: z.array(z.object({ id, name: text, goal: text, scene: id }).strict()).min(1),
    scenes: z.array(z.object({ id, purpose: text }).strict()).min(1),
    mechanics: z.array(z.object({ id, description: text }).strict()).min(1),
    controls: z.array(z.object({ action: id, description: text, default_keys: z.array(z.string()) }).strict()).min(1),
    ui: z.array(z.object({ id, purpose: text }).strict()),
    audio: z.array(z.object({ id, purpose: text }).strict()),
    win_conditions: z.array(text).min(1),
    lose_conditions: z.array(text),
    save_system: z.object({ required: z.boolean(), description: text.optional() }).strict(),
    progression: text,
    assets: z.array(z.object({ id, type: z.enum(ASSET_TYPES), description: text, required: z.boolean() }).strict()),
    dependencies: z.array(text),
    performance_targets: z
      .object({
        fps: z.number().int().min(24).max(240),
        max_draw_calls: z.number().int().positive().optional(),
        max_memory_mb: z.number().int().positive().optional(),
      })
      .strict(),
    build_profiles: z.array(z.enum(['DEV', 'QA', 'PREVIEW', 'RELEASE'])).min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const scenes = new Set(s.scenes.map((x) => x.id));
    s.levels.forEach((l, i) => {
      if (!scenes.has(l.scene))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levels', i, 'scene'],
          message: `unknown scene '${l.scene}'`,
        });
    });
    for (const [key, list] of [
      ['scenes', s.scenes],
      ['levels', s.levels],
      ['assets', s.assets],
      ['characters', s.characters],
      ['mechanics', s.mechanics],
    ] as const) {
      const seen = new Set<string>();
      list.forEach((x, i) => {
        if (seen.has(x.id))
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, i, 'id'], message: `duplicate id '${x.id}'` });
        seen.add(x.id);
      });
    }
  });
export type GameSpec = z.infer<typeof GameSpecSchema>;

export const SceneManifestSchema = z
  .object({
    schema: z.literal(1),
    scenes: z.array(
      z
        .object({
          id,
          path: z.string().regex(/^res:\/\/[^\\]+\.tscn$/),
          root_type: z.string().min(1),
          main: z.boolean(),
          assets: z.array(id),
          status: z.enum(['planned', 'created', 'validated']),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.scenes.filter((s) => s.main).length !== 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes'], message: 'exactly one main scene is required' });
  });
export type SceneManifest = z.infer<typeof SceneManifestSchema>;

export const ASSET_STATES = [
  'planned',
  'queued',
  'generating',
  'validating',
  'needs_rig',
  'blocked',
  'imported',
  'failed',
] as const;

export const AssetManifestSchema = z
  .object({
    schema: z.literal(1),
    assets: z.array(
      z
        .object({
          id,
          type: z.enum(ASSET_TYPES),
          required: z.boolean(),
          state: z.enum(ASSET_STATES),
          res_path: z
            .string()
            .regex(/^res:\/\//)
            .nullable(),
          /** Links to the provenance record (asset_provenance.asset_id); null until produced. */
          provenance_id: z.string().nullable(),
          produces: z.array(z.enum(['mesh', 'texture', 'material', 'rig', 'animation', 'image'])),
          blocked_reason: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export const TASK_KINDS = ['spec', 'project', 'asset', 'scene', 'gameplay', 'qa', 'fix', 'build', 'export'] as const;

export const TaskGraphSchema = z
  .object({
    schema: z.literal(1),
    tasks: z.array(
      z
        .object({
          id,
          kind: z.enum(TASK_KINDS),
          title: text,
          depends_on: z.array(id),
          /** Deterministic key: re-running the same task never duplicates its effect. */
          idempotency_key: z.string().min(8),
          status: z.enum(['pending', 'running', 'done', 'blocked', 'failed', 'skipped']),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((g, ctx) => {
    const problem = taskGraphProblem(g.tasks);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks'], message: problem });
  });
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

/** Unknown dependencies, duplicate ids/keys, or a cycle. Returns null when the graph is a valid DAG. */
export function taskGraphProblem(
  tasks: { id: string; depends_on: string[]; idempotency_key: string }[],
): string | null {
  const ids = new Map(tasks.map((t) => [t.id, t]));
  if (ids.size !== tasks.length) return 'duplicate task id';
  if (new Set(tasks.map((t) => t.idempotency_key)).size !== tasks.length) return 'duplicate idempotency_key';
  for (const t of tasks)
    for (const d of t.depends_on) if (!ids.has(d)) return `task '${t.id}' depends on unknown task '${d}'`;
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (tid: string): string | null => {
    if (state.get(tid) === 2) return null;
    if (state.get(tid) === 1) return `dependency cycle through '${tid}'`;
    state.set(tid, 1);
    for (const d of ids.get(tid)!.depends_on) {
      const p = visit(d);
      if (p) return p;
    }
    state.set(tid, 2);
    return null;
  };
  for (const t of tasks) {
    const p = visit(t.id);
    if (p) return p;
  }
  return null;
}

/** Tasks ready to run: pending, with every dependency done. Deterministic order (by id). */
export function readyTasks(g: TaskGraph): string[] {
  const done = new Set(g.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').map((t) => t.id));
  return g.tasks
    .filter((t) => t.status === 'pending' && t.depends_on.every((d) => done.has(d)))
    .map((t) => t.id)
    .sort();
}

export const BuildManifestSchema = z
  .object({
    schema: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    android_version_code: z.number().int().positive(),
    targets: z.array(
      z
        .object({
          platform: z.enum(PLATFORMS),
          profile: z.enum(['DEV', 'QA', 'PREVIEW', 'RELEASE']),
          requested: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

export const TestManifestSchema = z
  .object({
    schema: z.literal(1),
    tests: z.array(
      z
        .object({
          id,
          tier: z.enum(['static', 'playtest', 'visual']),
          mandatory: z.boolean(),
          description: text,
          /** Scenario file for playtests (`.modulex/tests/<id>.json`). */
          scenario: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type TestManifest = z.infer<typeof TestManifestSchema>;

/** The default creation pipeline (Execution Patch 1 §11). Stage ids are stable; the UI localises the titles. */
export const CREATION_PIPELINE = [
  'user_request',
  'game_specification',
  'technical_specification',
  'scene_manifest',
  'asset_manifest',
  'task_graph',
  'project_creation',
  'asset_generation',
  'asset_processing',
  'scene_construction',
  'gameplay',
  'qa',
  'playtest',
  'visual_inspection',
  'bug_fixes',
  'regression',
  'optimization',
  'build',
  'export',
] as const;
export type PipelineStage = (typeof CREATION_PIPELINE)[number];

/** Stages that may not start before the plan exists: nothing mutating runs until spec + manifests + task graph. */
export function stageAllowed(stage: PipelineStage, completed: ReadonlySet<PipelineStage>): boolean {
  const idx = CREATION_PIPELINE.indexOf(stage);
  return CREATION_PIPELINE.slice(0, idx).every((s) => completed.has(s));
}
