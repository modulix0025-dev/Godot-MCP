// SPDX-License-Identifier: Apache-2.0
//
// Shapes of the owner endpoints the UI reads (studio/core/src/server.ts). Kept structural and minimal: the UI shows
// what Core returns and never invents a status. Anything Core does not report is rendered as "not reported".
import type { Tone } from '../prototype/data';

export type Outcome = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'BLOCKED' | 'FAILED' | 'NEEDS_HUMAN' | 'PENDING_APPROVAL';
export type StageStatus = Outcome | 'PENDING' | 'RUNNING';

export interface Completion {
  isGameComplete: boolean;
  status: Exclude<Outcome, 'PENDING_APPROVAL'>;
  missing: string[];
  failed: string[];
  notes: string[];
}

export interface BuildRecord {
  build_id: string;
  platform: 'windows' | 'android' | 'ios';
  profile: string;
  status: 'BUILT' | 'PREPARED' | 'SIGNED' | 'BLOCKED' | 'FAILED';
  version: string;
  sha256: string | null;
  size_bytes: number | null;
  created_at: string;
  note: string | null;
  smoke?: boolean | null;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  created_at: string;
  platforms: string[];
  executing: boolean;
  run: {
    run_id: string;
    stages: { stage: string; status: StageStatus; reason: string | null }[];
    blocked: { code: string; message: string } | null;
    completion: Completion | null;
  } | null;
  builds: BuildRecord[];
  spent_usd: number;
}

export interface ProjectDetail extends ProjectSummary {
  path: string | null;
  recent_errors: { at: string; message: string; source: string }[];
  provenance: {
    asset_id: string;
    source: string;
    generator?: string | null;
    license_facts?: { license: string; commercial_use: string }[];
  }[];
  runs: {
    run_id: string;
    stages: { stage: string; status: StageStatus; evidence: string[]; reason: string | null }[];
  }[];
}

export interface Approval {
  approval_id: string;
  tool: string;
  requested_by: string;
  role: string | null;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'executed';
  impact: {
    what: string;
    why: string;
    scope: string;
    files: string[];
    risk: 'low' | 'medium' | 'high' | 'critical';
    rollback: string;
  };
}

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface SetupComponentState {
  id: string;
  status: 'missing' | 'installing' | 'installed' | 'failed' | 'needs_owner';
  version: string | null;
  path: string | null;
  origin: 'downloaded' | 'bundled' | 'detected' | null;
  verified: string | null;
  message: string | null;
}

export interface SetupView {
  components: SetupComponentState[];
  plan: string[];
  progress: Record<string, { received: number; total: number | null; resumed: boolean }>;
  pipeline: { available: boolean; qaTier: boolean };
}

export interface BuildWorker {
  worker_id: string;
  url: string;
  name: string;
  paired_at: string;
  capabilities: {
    platforms: string[];
    signing_profiles: string[];
    xcode_version: string | null;
    godot_version: string | null;
  } | null;
}

export interface ComfyWorker {
  worker_id: string;
  gpu?: string | null;
  trust: 'TRUSTED' | 'DEGRADED' | 'UNTRUSTED' | 'QUARANTINED' | 'OFFLINE' | string;
  capabilities?: string[];
  vram_gb?: number | null;
  quarantine_reason?: string | null;
  has_credential?: boolean;
}

export interface BudgetView {
  caps: { monthly_usd: number; per_project_usd: number };
  month_usd: number;
  total_usd: number;
  ledger: boolean;
}

export interface Health {
  ok: boolean;
  version: string;
  pipeline?: { available: boolean; qaTier: boolean };
}

export interface DevMode {
  enabled: boolean;
  capabilities: string[];
}

/** One poll of everything the shell and the screens show. Each part may be missing (its error is kept). */
export interface Snapshot {
  health: Health | null;
  projects: ProjectSummary[] | null;
  approvals: Approval[] | null;
  audit: AuditEntry[] | null;
  setup: SetupView | null;
  buildWorkers: BuildWorker[] | null;
  workers: ComfyWorker[] | null;
  budget: BudgetView | null;
  devMode: DevMode | null;
  errors: Partial<Record<keyof Omit<Snapshot, 'errors'>, string>>;
}

export const OUTCOME_TONE: Record<StageStatus, Tone> = {
  SUCCESS: 'success',
  PARTIAL_SUCCESS: 'warning',
  BLOCKED: 'warning',
  FAILED: 'danger',
  NEEDS_HUMAN: 'accent',
  PENDING_APPROVAL: 'accent',
  PENDING: 'neutral',
  RUNNING: 'running',
};

export const BUILD_TONE: Record<BuildRecord['status'], Tone> = {
  BUILT: 'success',
  SIGNED: 'success',
  PREPARED: 'info',
  BLOCKED: 'warning',
  FAILED: 'danger',
};

/** `asset_generation` → "Asset generation". */
export function stageLabel(id: string): string {
  const s = id.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
