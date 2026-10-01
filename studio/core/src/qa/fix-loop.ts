// SPDX-License-Identifier: Apache-2.0
//
// Fix loop (Phase 9). For each failing fingerprint: checkpoint → a Fixer proposes a change → re-run the suite (the
// failing tier, then the full regression) → keep it only when the fingerprint is gone AND nothing new broke;
// otherwise restore the checkpoint. Limits: 3 attempts per fingerprint, 8 fixes per run, a wall-clock budget.
// A fingerprint that comes back after being fixed escalates at once. `infra` failures never consume attempts.
// Whatever cannot be fixed ends BLOCKED with evidence and a suggested owner action — never SUCCESS.
import type { ProjectCheckpoints } from '../checkpoints/project-checkpoints.js';
import type { StudioDb } from '../db/database.js';
import type { QaFailure } from './failures.js';

export interface FixProposal {
  changed: boolean;
  description: string;
  files: string[];
}

/** Who proposes fixes: the ModuleX Agent / Claude through Studio tools, or a built-in rule. */
export interface Fixer {
  readonly name: string;
  propose(failure: QaFailure, attempt: number): Promise<FixProposal>;
}

export interface FixLoopLimits {
  perFingerprint: number;
  perRun: number;
  wallClockMs: number;
}

export const DEFAULT_FIX_LIMITS: FixLoopLimits = { perFingerprint: 3, perRun: 8, wallClockMs: 30 * 60_000 };

export interface FixAttempt {
  fingerprint: string;
  class: QaFailure['class'];
  attempt: number;
  fixer: string;
  checkpoint: string;
  proposal: string;
  outcome: 'fixed' | 'no_change' | 'still_failing' | 'regressed_restored';
}

export interface FixLoopResult {
  status: 'SUCCESS' | 'BLOCKED';
  attempts: FixAttempt[];
  remaining: QaFailure[];
  summary: string;
  suggested_action: string | null;
}

export class FixLoop {
  constructor(
    private readonly o: {
      projectId: string;
      checkpoints: Pick<ProjectCheckpoints, 'checkpoint' | 'restore'>;
      fixer: Fixer;
      /** Runs the whole suite (static + playtest) and returns every failure. */
      runSuite: () => Promise<QaFailure[]>;
      db?: StudioDb | null;
      limits?: Partial<FixLoopLimits>;
      now?: () => number;
    },
  ) {}

  private bump(f: QaFailure, status: string): void {
    this.o.db?.run(
      'UPDATE failures SET attempts = attempts + 1, status = ?, last_seen = ? WHERE project_id = ? AND fingerprint = ?',
      status,
      new Date().toISOString(),
      this.o.projectId,
      f.fingerprint,
    );
  }

  async run(initial?: QaFailure[]): Promise<FixLoopResult> {
    const limits = { ...DEFAULT_FIX_LIMITS, ...this.o.limits };
    const now = this.o.now ?? Date.now;
    const started = now();
    const attempts: FixAttempt[] = [];
    const perFp = new Map<string, number>();
    const fixed = new Set<string>();
    let failures = initial ?? (await this.o.runSuite());
    let fixes = 0;
    const blocked = (reason: string, action: string): FixLoopResult => ({
      status: 'BLOCKED',
      attempts,
      remaining: failures,
      summary: reason,
      suggested_action: action,
    });

    for (;;) {
      const actionable = failures.filter((f) => f.class !== 'infra');
      if (!actionable.length) {
        if (failures.length)
          return blocked(
            `${failures.length} infrastructure failure(s): ${failures[0]!.message}`,
            'Check the Godot session / worker in Diagnostics, then resume the pipeline. Infrastructure failures do not consume fix attempts.',
          );
        return {
          status: 'SUCCESS',
          attempts,
          remaining: [],
          summary: `all tests pass after ${fixes} fix(es)`,
          suggested_action: null,
        };
      }
      const recurred = actionable.find((f) => fixed.has(f.fingerprint));
      if (recurred)
        return blocked(
          `${recurred.class} recurred after it was fixed: ${recurred.message}`,
          'Review the failure evidence; the automatic fix does not hold.',
        );
      if (fixes >= limits.perRun)
        return blocked(
          `fix budget exhausted (${limits.perRun} fixes per run)`,
          'Review the remaining failures and approve a manual fix or a new run.',
        );
      if (now() - started > limits.wallClockMs)
        return blocked('fix loop wall-clock budget exhausted', 'Resume later or fix manually.');
      const target = actionable.find((f) => (perFp.get(f.fingerprint) ?? 0) < limits.perFingerprint);
      if (!target) {
        const f = actionable[0]!;
        return blocked(
          `could not fix ${f.class} after ${limits.perFingerprint} attempts: ${f.message}${f.file && !f.message.includes(f.file) ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`,
          `Fix ${f.file ?? 'the failing code'} manually or ask the ModuleX Agent with the evidence, then resume the pipeline.`,
        );
      }
      const n = (perFp.get(target.fingerprint) ?? 0) + 1;
      perFp.set(target.fingerprint, n);
      const cp = await this.o.checkpoints.checkpoint(
        `fix attempt ${n}/${limits.perFingerprint} for ${target.class} ${target.fingerprint}`,
      );
      const proposal = await this.o.fixer.propose(target, n);
      const record = (outcome: FixAttempt['outcome']) =>
        attempts.push({
          fingerprint: target.fingerprint,
          class: target.class,
          attempt: n,
          fixer: this.o.fixer.name,
          checkpoint: cp.name,
          proposal: proposal.description,
          outcome,
        });
      if (!proposal.changed) {
        record('no_change');
        this.bump(target, 'open');
        continue;
      }
      const before = new Set(failures.map((f) => f.fingerprint));
      const after = await this.o.runSuite();
      const introduced = after.filter((f) => !before.has(f.fingerprint) && f.class !== 'infra');
      const gone = !after.some((f) => f.fingerprint === target.fingerprint);
      if (introduced.length) {
        await this.o.checkpoints.restore(cp.name);
        record('regressed_restored');
        this.bump(target, 'open');
        failures = await this.o.runSuite();
        continue;
      }
      if (gone) {
        fixes++;
        fixed.add(target.fingerprint);
        record('fixed');
        this.bump(target, 'fixed');
      } else {
        record('still_failing');
        this.bump(target, 'open');
      }
      failures = after;
    }
  }
}
