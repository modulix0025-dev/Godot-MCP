// SPDX-License-Identifier: Apache-2.0
//
// Application updates, rollback and Safe Mode state (Execution Patch 2 §14–15, §20–21). This is the orchestration
// around the Phase 13 Tauri updater: it owns the ORDER and the SAFETY rules (verify before install, backup before
// install, health check before "healthy", automatic rollback on failure), while the platform steps — download,
// signature check, install, restore — are injected (the Tauri updater with its signed manifest in production;
// fakes in tests). Only the owner can start an install; no agent tool reaches this class.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  bootDecision,
  compareSemver,
  InstallStateSchema,
  ReleaseManifestSchema,
  type BootDecision,
  type InstallState,
  type ReleaseManifest,
  type UpdateChannel,
  type UpdateStep,
} from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';

export interface UpdatePlatform {
  /** Releases published on the feed (all channels). */
  fetchFeed(): Promise<unknown[]>;
  download(r: ReleaseManifest): Promise<Buffer>;
  /** Signature check of the downloaded bytes (Tauri updater: minisign public key embedded in the app). */
  verifySignature(bytes: Buffer, r: ReleaseManifest): Promise<boolean>;
  backup(label: string): Promise<string>;
  install(bytes: Buffer, r: ReleaseManifest): Promise<void>;
  migrate(r: ReleaseManifest): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  restore(backup: string): Promise<void>;
}

/** Channel visibility: stable sees stable; beta sees stable+beta; developer sees all. */
const VISIBLE: Record<UpdateChannel, UpdateChannel[]> = {
  stable: ['stable'],
  beta: ['stable', 'beta'],
  developer: ['stable', 'beta', 'developer'],
};

export type UpdateOutcome =
  | { status: 'SUCCESS'; from: string; to: string; steps: UpdateStep[] }
  | {
      status: 'ROLLED_BACK' | 'FAILED';
      from: string;
      to: string;
      failed_step: UpdateStep;
      reason: string;
      steps: UpdateStep[];
    };

export class UpdateManager {
  private state: InstallState;

  constructor(
    private readonly statePath: string,
    currentVersion: string,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = existsSync(statePath)
      ? InstallStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf-8')))
      : {
          current: currentVersion,
          previous: null,
          last_known_good: currentVersion,
          pending_health_check: false,
          failed_boots: 0,
          crashing_extensions: [],
          history: [],
        };
  }

  getState(): InstallState {
    return structuredClone(this.state);
  }

  boot(forceSafe = false): BootDecision {
    const d = bootDecision(this.state, forceSafe);
    if (d.mode === 'safe') this.audit.append('safe_mode_entered', 'studio', { reasons: d.reasons });
    return d;
  }

  recordBoot(ok: boolean): void {
    this.state.failed_boots = ok ? 0 : this.state.failed_boots + 1;
    this.save();
  }

  recordExtensionCrash(name: string): void {
    if (!this.state.crashing_extensions.includes(name)) this.state.crashing_extensions.push(name);
    this.save();
  }

  clearSafeModeCauses(by: 'owner-ui'): void {
    this.state.failed_boots = 0;
    this.state.crashing_extensions = [];
    this.save();
    this.audit.append('safe_mode_exited', by, {});
  }

  async check(platform: UpdatePlatform, channel: UpdateChannel): Promise<ReleaseManifest | null> {
    const feed = (await platform.fetchFeed())
      .map((r) => ReleaseManifestSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => r.data!)
      .filter((r) => VISIBLE[channel].includes(r.channel) && compareSemver(r.version, this.state.current) > 0)
      .sort((a, b) => compareSemver(b.version, a.version));
    this.audit.append('update_checked', 'owner-ui', { channel, offered: feed[0]?.version ?? null });
    return feed[0] ?? null;
  }

  /** §15: check → download → verify → backup → install → migrate → health check → mark healthy; else rollback. */
  async apply(platform: UpdatePlatform, r: ReleaseManifest, actor: 'owner-ui'): Promise<UpdateOutcome> {
    if (actor !== 'owner-ui') throw new Error('Only the owner can install an update.');
    const from = this.state.current;
    const steps: UpdateStep[] = ['check'];
    const fail = async (step: UpdateStep, reason: string, backup: string | null): Promise<UpdateOutcome> => {
      if (backup) {
        await platform.restore(backup);
        this.state.current = from;
        this.state.pending_health_check = false;
        this.pushHistory(from, r.version, 'update', 'rolled_back', backup, reason);
        this.audit.append('update_rolled_back', 'studio', { from, to: r.version, step, reason });
        return { status: 'ROLLED_BACK', from, to: r.version, failed_step: step, reason, steps };
      }
      this.pushHistory(from, r.version, 'update', 'failed', null, reason);
      return { status: 'FAILED', from, to: r.version, failed_step: step, reason, steps };
    };

    const bytes = await platform.download(r);
    steps.push('download');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== r.sha256) return fail('verify', `sha256 mismatch (${digest.slice(0, 12)}…)`, null);
    if (!(await platform.verifySignature(bytes, r))) return fail('verify', 'signature verification failed', null);
    steps.push('verify');
    const backup = await platform.backup(`update-${from}-to-${r.version}`);
    steps.push('backup');
    try {
      this.state.pending_health_check = true;
      this.save();
      await platform.install(bytes, r);
      steps.push('install');
      await platform.migrate(r);
      steps.push('migrate');
    } catch (e) {
      return fail(steps.includes('install') ? 'migrate' : 'install', (e as Error).message, backup);
    }
    const h = await platform.healthCheck();
    steps.push('health_check');
    if (!h.ok) return fail('health_check', h.detail, backup);
    this.state.previous = from;
    this.state.current = r.version;
    this.state.last_known_good = r.version;
    this.state.pending_health_check = false;
    steps.push('mark_healthy');
    this.pushHistory(from, r.version, 'update', 'healthy', backup, r.notes);
    this.audit.append('update_installed', 'owner-ui', { from, to: r.version, channel: r.channel });
    return { status: 'SUCCESS', from, to: r.version, steps };
  }

  /** §20 — "Roll Back Update": restore the backup of the last update. Audited. */
  async rollback(platform: UpdatePlatform, actor: 'owner-ui', reason: string): Promise<InstallState> {
    if (actor !== 'owner-ui') throw new Error('Only the owner can roll back an update.');
    const last = [...this.state.history].reverse().find((h) => h.kind === 'update' && h.result === 'healthy');
    if (!last?.backup) throw new Error('No update with a backup to roll back.');
    await platform.restore(last.backup);
    const from = this.state.current;
    this.state.current = last.from;
    this.state.previous = from;
    this.state.last_known_good = last.from;
    this.state.pending_health_check = false;
    this.pushHistory(from, last.from, 'rollback', 'healthy', last.backup, reason);
    this.audit.append('update_rolled_back', 'owner-ui', { from, to: last.from, reason, backup: last.backup });
    return this.getState();
  }

  /** Evolutions deployed through the patch pipeline are recorded in the same install history. */
  recordEvolution(
    from: string,
    to: string,
    result: 'healthy' | 'rolled_back' | 'failed',
    backup: string | null,
    reason: string,
  ): void {
    this.pushHistory(from, to, 'evolution', result, backup, reason);
    if (result === 'healthy' && to !== from) {
      this.state.previous = from;
      this.state.current = to;
      this.state.last_known_good = to;
    }
    this.save();
  }

  private pushHistory(
    from: string,
    to: string,
    kind: 'update' | 'rollback' | 'evolution',
    result: 'healthy' | 'rolled_back' | 'failed',
    backup: string | null,
    reason: string,
  ): void {
    this.state.history.push({ at: this.now().toISOString(), from, to, kind, result, backup, reason });
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.state, null, 2), 'utf-8');
    renameSync(`${this.statePath}.tmp`, this.statePath);
  }
}
