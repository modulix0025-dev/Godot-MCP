// SPDX-License-Identifier: Apache-2.0
//
// Budgets and the Ask tier (EXECUTION_PROMPT Phase 12). Spend comes from the cost ledger (GPU seconds × rate,
// build worker minutes, LLM tokens when the agent reports them). Caps come from the versioned `budgets` config
// document (per project, monthly global). A pre-flight estimate that would cross a cap never runs silently: the
// gateway turns the call into an owner approval (Ask) and the pipeline stops NEEDS_HUMAN with the numbers.
import type { StudioDb } from '../db/database.js';

export interface BudgetCaps {
  monthly_usd: number;
  per_project_usd: number;
}

export interface BudgetCheck {
  ok: boolean;
  /** Short reason when not ok ("per-project budget $20.00 would be exceeded"). */
  reason: string;
  /** The numbers behind the decision (always set; shown to the owner). */
  detail: string;
}

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class Budget {
  constructor(
    private readonly db: StudioDb,
    private readonly caps: () => BudgetCaps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Would spending `estimateUsd` more on `projectId` stay within both caps? */
  check(projectId: string | null, estimateUsd: number): BudgetCheck {
    const caps = this.caps();
    const since = monthStart(this.now());
    const month = this.db.spentSince(null, since);
    const project = projectId ? this.db.spent(projectId) : 0;
    const detail =
      `this month $${month.toFixed(2)} of $${caps.monthly_usd.toFixed(2)}` +
      (projectId ? `; project ${projectId} $${project.toFixed(2)} of $${caps.per_project_usd.toFixed(2)}` : '') +
      `; estimate $${estimateUsd.toFixed(2)}`;
    if (projectId && project + estimateUsd > caps.per_project_usd)
      return { ok: false, reason: `per-project budget $${caps.per_project_usd.toFixed(2)} would be exceeded`, detail };
    if (month + estimateUsd > caps.monthly_usd)
      return { ok: false, reason: `monthly budget $${caps.monthly_usd.toFixed(2)} would be exceeded`, detail };
    return { ok: true, reason: '', detail };
  }
}
