// SPDX-License-Identifier: Apache-2.0
//
// Versions, project compatibility, update channels, the update process, migrations and Safe Mode (Execution Patch 2
// §8, §14–16, §20–21). Extends the Phase 13 update plan (Tauri updater with a signed manifest, disabled by default,
// never forced; `.modulex/project.json` version stamps) — it does not replace it.
import { z } from 'zod';
import { compareSemver } from './extensions.js';

/** §16 — every version the Studio tracks. */
export const VersionSetSchema = z
  .object({
    studio: z.string(),
    schema: z.number().int().positive(),
    godot: z.string(),
    addons: z.record(z.string(), z.string()),
    worker_protocol: z.number().int().positive(),
    workflows: z.record(z.string(), z.string()),
  })
  .strict();
export type VersionSet = z.infer<typeof VersionSetSchema>;

/** `.modulex/project.json` — what a project was last written with. */
export const ProjectStampSchema = z
  .object({
    studio_version: z.string(),
    schema: z.number().int().positive(),
    godot_version: z.string(),
    addon_versions: z.record(z.string(), z.string()),
    workflow_pins: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type ProjectStamp = z.infer<typeof ProjectStampSchema>;

export type ProjectCompatibility =
  | { status: 'compatible' }
  | { status: 'upgrade_required'; reasons: string[] }
  | { status: 'read_only'; reasons: string[] };

/**
 * §16 — opening a project never modifies it silently. Older project → "Upgrade Project" (checkpoint first).
 * Newer project (written by a newer Studio or schema) → read-only in this app.
 */
export function projectCompatibility(stamp: ProjectStamp, app: VersionSet): ProjectCompatibility {
  const newer: string[] = [];
  const older: string[] = [];
  if (stamp.schema > app.schema) newer.push(`project schema ${stamp.schema} > app schema ${app.schema}`);
  if (stamp.schema < app.schema) older.push(`project schema ${stamp.schema} < app schema ${app.schema}`);
  if (compareSemver(stamp.studio_version, app.studio) > 0)
    newer.push(`written by ModuleX Game Studio ${stamp.studio_version} (this is ${app.studio})`);
  if (stamp.godot_version !== app.godot) older.push(`Godot ${stamp.godot_version} → ${app.godot}`);
  for (const [addon, v] of Object.entries(app.addons)) {
    const pv = stamp.addon_versions[addon];
    if (pv && compareSemver(pv, v) > 0) newer.push(`addon ${addon} ${pv} is newer than ${v}`);
    else if (pv !== v) older.push(`addon ${addon} ${pv ?? 'missing'} → ${v}`);
  }
  if (newer.length) return { status: 'read_only', reasons: newer };
  if (older.length) return { status: 'upgrade_required', reasons: older };
  return { status: 'compatible' };
}

/** §14 — update channels. Default Stable; updates are never forced or automatic. */
export const UPDATE_CHANNELS = ['stable', 'beta', 'developer'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export const UpdateSettingsSchema = z
  .object({
    channel: z.enum(UPDATE_CHANNELS).default('stable'),
    check_automatically: z.boolean().default(false),
    install_automatically: z.literal(false).default(false),
  })
  .strict();
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

/** A release offered by the update feed (the Tauri updater's signed manifest carries the same facts). */
export const ReleaseManifestSchema = z
  .object({
    version: z.string(),
    channel: z.enum(UPDATE_CHANNELS),
    notes: z.string(),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().min(1),
    min_schema: z.number().int().positive(),
    target_schema: z.number().int().positive(),
    migrations: z.array(z.string()),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** §15 — the update process. Any failure from `install` onwards triggers rollback. */
export const UPDATE_STEPS = [
  'check',
  'download',
  'verify',
  'backup',
  'install',
  'migrate',
  'health_check',
  'mark_healthy',
] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

/** §8 — a migration. Every one has a backup and a rollback strategy; none runs silently. */
export const MigrationSchema = z
  .object({
    id: z.string().regex(/^m\d{4}_[a-z0-9_]+$/),
    from_schema: z.number().int().positive(),
    to_schema: z.number().int().positive(),
    description: z.string().min(1),
    rollback: z.enum(['restore_backup', 'down_migration']),
  })
  .strict()
  .refine((m) => m.to_schema === m.from_schema + 1, { message: 'migrations advance the schema by exactly one' });
export type Migration = z.infer<typeof MigrationSchema>;

/** Ordered migration path, or an error naming the gap. */
export function migrationPath(all: Migration[], from: number, to: number): Migration[] {
  const path: Migration[] = [];
  for (let s = from; s < to; s++) {
    const m = all.find((x) => x.from_schema === s);
    if (!m) throw new Error(`no migration from schema ${s} to ${s + 1}`);
    path.push(m);
  }
  return path;
}

/** Persistent record of what is installed and what is known good (drives rollback and Safe Mode). */
export const InstallStateSchema = z
  .object({
    current: z.string(),
    previous: z.string().nullable(),
    last_known_good: z.string(),
    pending_health_check: z.boolean(),
    failed_boots: z.number().int().nonnegative(),
    crashing_extensions: z.array(z.string()),
    history: z.array(
      z
        .object({
          at: z.string(),
          from: z.string(),
          to: z.string(),
          kind: z.enum(['update', 'rollback', 'evolution']),
          result: z.enum(['healthy', 'rolled_back', 'failed']),
          backup: z.string().nullable(),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type InstallState = z.infer<typeof InstallStateSchema>;

export const SAFE_MODE_FAILED_BOOTS = 2;

export type BootDecision =
  { mode: 'normal' } | { mode: 'safe'; reasons: string[]; disable_extensions: 'all_non_core'; use_version: string };

/**
 * §21 — Safe Mode. Entered when an update did not pass its health check, boots keep failing, or an extension keeps
 * crashing. Safe Mode runs the last known-good version/configuration with every non-core extension disabled; the
 * owner then chooses: roll back, disable an extension, inspect logs, repair configuration, or retry the update.
 */
export function bootDecision(s: InstallState, forced = false): BootDecision {
  const reasons: string[] = [];
  if (forced) reasons.push('Safe Mode requested');
  if (s.pending_health_check) reasons.push(`version ${s.current} never passed its health check`);
  if (s.failed_boots >= SAFE_MODE_FAILED_BOOTS) reasons.push(`${s.failed_boots} failed starts in a row`);
  if (s.crashing_extensions.length) reasons.push(`crashing extensions: ${s.crashing_extensions.join(', ')}`);
  return reasons.length
    ? { mode: 'safe', reasons, disable_extensions: 'all_non_core', use_version: s.last_known_good }
    : { mode: 'normal' };
}
