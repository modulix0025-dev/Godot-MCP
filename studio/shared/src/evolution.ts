// SPDX-License-Identifier: Apache-2.0
//
// System Evolution (Execution Patch 2, docs/modulex/system-evolution.md). The contracts for changing ModuleX Game
// Studio itself: request classification, the three modification modes, risk levels, the controlled core-change
// workflow, change proposals, the owner review, and the protected controls that no evolution may silently weaken.
//
// Design rule (§33): the system may change itself, but never the controls that govern that ability without the
// owner. Protected controls are listed here, and every guard below is computed by Core — an agent can raise a
// risk level, never lower it.
import { z } from 'zod';

/** §1 — what kind of thing changes. */
export const CHANGE_KINDS = [
  'runtime_config',
  'skill_workflow',
  'source_code',
  'dependency',
  'platform_build',
  'schema_migration',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** §2 — the three modification modes. */
export const MODIFICATION_MODES = ['config', 'extension', 'core'] as const;
export type ModificationMode = (typeof MODIFICATION_MODES)[number];

/** §32 — the request categories the Agent (or the deterministic fallback below) assigns. */
export const REQUEST_CATEGORIES = ['CONFIG', 'EXTENSION', 'WORKFLOW', 'PROVIDER', 'BUGFIX', 'CORE_CHANGE'] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

export const MODE_FOR_CATEGORY: Record<RequestCategory, ModificationMode> = {
  CONFIG: 'config',
  EXTENSION: 'extension',
  WORKFLOW: 'extension',
  PROVIDER: 'extension',
  BUGFIX: 'core',
  CORE_CHANGE: 'core',
};

/** §19 — risk levels, ordered. */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskRank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);
export const maxRisk = (...rs: RiskLevel[]): RiskLevel =>
  rs.reduce<RiskLevel>((a, b) => (riskRank(b) > riskRank(a) ? b : a), 'LOW');

/**
 * Studio components. `protected: true` = a control that governs the system's ability to change itself or its
 * security boundary (§25, §26, §33). Any evolution touching one is CRITICAL, needs the owner's explicit
 * confirmation, and can never be deployed by an agent.
 */
export const COMPONENTS = {
  ui: { risk: 'LOW', protected: false, paths: ['studio/app/ui/'] },
  docs: { risk: 'LOW', protected: false, paths: ['docs/', 'README'] },
  skills: { risk: 'MEDIUM', protected: false, paths: ['studio/extensions/skills/'] },
  workflows: { risk: 'MEDIUM', protected: false, paths: ['studio/extensions/workflows/'] },
  providers: { risk: 'HIGH', protected: false, paths: ['studio/core/src/providers/'] },
  studio_tools: { risk: 'HIGH', protected: false, paths: ['studio/core/src/gateway/tool-handlers.ts'] },
  mcp_adapters: { risk: 'HIGH', protected: false, paths: ['studio/core/src/mcp/', 'studio/claude-desktop/'] },
  godot_integration: { risk: 'HIGH', protected: false, paths: ['addons/', 'studio/core/src/godot/'] },
  build_system: { risk: 'HIGH', protected: false, paths: ['.github/', 'studio/app/src-tauri/tauri.conf.json'] },
  shell: { risk: 'HIGH', protected: false, paths: ['studio/app/src-tauri/src/'] },
  schema: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/store/', 'studio/core/src/evolution/migrations'],
  },
  policy_gateway: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/shared/src/policy.ts', 'studio/core/src/gateway/gateway.ts'],
  },
  approvals: { risk: 'CRITICAL', protected: true, paths: ['studio/core/src/evolution/review'] },
  audit: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/audit/audit-log.ts', 'studio/shared/src/audit-events.ts'],
  },
  credentials: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/audit/secrets.ts', 'studio/app/src-tauri/src/credentials.rs'],
  },
  auth_network: { risk: 'CRITICAL', protected: true, paths: ['studio/core/src/server.ts', 'studio/core/src/main.ts'] },
  worker_auth: { risk: 'CRITICAL', protected: true, paths: ['studio/shared/src/workers.ts'] },
  sandbox: { risk: 'CRITICAL', protected: true, paths: ['studio/core/src/evolution/sandbox'] },
  backup_rollback: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/evolution/checkpoint', 'studio/core/src/evolution/updates'],
  },
  updater: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/evolution/updates', 'studio/shared/src/versions.ts'],
  },
  evolution_engine: {
    risk: 'CRITICAL',
    protected: true,
    paths: ['studio/core/src/evolution/', 'studio/shared/src/evolution.ts'],
  },
  signing: { risk: 'CRITICAL', protected: true, paths: ['studio/app/src-tauri/tauri.conf.json#signing'] },
} as const satisfies Record<string, { risk: RiskLevel; protected: boolean; paths: readonly string[] }>;
export type Component = keyof typeof COMPONENTS;
export const COMPONENT_IDS = Object.keys(COMPONENTS) as Component[];

/** Map repository paths to components (longest matching prefix wins). Unknown source paths count as HIGH/core. */
export function componentsForFiles(files: string[]): Component[] {
  const out = new Set<Component>();
  for (const f of files) {
    let best: { c: Component; len: number } | null = null;
    for (const c of COMPONENT_IDS) {
      for (const p of COMPONENTS[c].paths) {
        const prefix = p.split('#')[0]!;
        if (f.startsWith(prefix) && (!best || prefix.length > best.len)) best = { c, len: prefix.length };
      }
    }
    if (best) out.add(best.c);
    else if (f.startsWith('studio/')) out.add('studio_tools');
  }
  return [...out];
}

export const isProtected = (components: readonly Component[]): boolean =>
  components.some((c) => COMPONENTS[c].protected);

/** The risk floor for a set of components and change kinds. Agents may raise it, never lower it. */
export function riskFloor(components: readonly Component[], kinds: readonly ChangeKind[]): RiskLevel {
  let r: RiskLevel = 'LOW';
  for (const c of components) r = maxRisk(r, COMPONENTS[c].risk);
  if (kinds.includes('schema_migration')) r = maxRisk(r, 'CRITICAL');
  if (kinds.includes('dependency')) r = maxRisk(r, 'HIGH');
  if (kinds.includes('source_code') || kinds.includes('platform_build')) r = maxRisk(r, 'MEDIUM');
  if (kinds.includes('skill_workflow')) r = maxRisk(r, 'MEDIUM');
  return r;
}

/**
 * §32 deterministic classifier. The ModuleX Agent classifies requests with its own reasoning; Core re-runs this
 * keyword classifier and keeps the MORE conservative mode (config < extension < core), so a mis-classification
 * can never route a core change around the patch pipeline. Arabic and English keywords.
 */
export function classifyRequest(text: string): {
  category: RequestCategory;
  mode: ModificationMode;
  kinds: ChangeKind[];
} {
  const t = text.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  let category: RequestCategory;
  if (has('bug', 'fix', 'broken', 'crash', 'صلح', 'مشكلة', 'اصلاح', 'إصلاح', 'خطأ')) category = 'BUGFIX';
  else if (
    has(
      'schema',
      'database',
      'migration',
      'security',
      'auth',
      'refactor',
      'source code',
      'engine',
      'gateway',
      'implement',
      'قاعدة البيانات',
      'الأمان',
      'الكود',
    )
  )
    category = 'CORE_CHANGE';
  else if (has('workflow', 'comfyui', 'ووركفلو')) category = 'WORKFLOW';
  else if (has('provider', 'model', 'llm', 'tts', 'موديل', 'مزود', 'نموذج')) category = 'PROVIDER';
  else if (has('skill', 'extension', 'plugin', 'panel', 'widget', 'إضافة', 'اضافة', 'سكيل', 'مهارة'))
    category = 'EXTENSION';
  else if (has('policy', 'approval', 'budget', 'setting', 'routing', 'سياسة', 'الموافقة', 'ميزانية', 'إعدادات'))
    category = 'CONFIG';
  else if (has('export target', 'build', 'platform', 'تصدير', 'منصة')) category = 'CORE_CHANGE';
  else category = 'CORE_CHANGE'; // unknown → most controlled path
  const kinds: ChangeKind[] =
    category === 'CONFIG'
      ? ['runtime_config']
      : category === 'EXTENSION' || category === 'WORKFLOW' || category === 'PROVIDER'
        ? ['skill_workflow']
        : ['source_code'];
  return { category, mode: MODE_FOR_CATEGORY[category], kinds };
}

const MODE_RANK: Record<ModificationMode, number> = { config: 0, extension: 1, core: 2 };
/** Keep the more controlled of two modes. */
export const stricterMode = (a: ModificationMode, b: ModificationMode): ModificationMode =>
  MODE_RANK[a] >= MODE_RANK[b] ? a : b;

/** §3 — the controlled workflow for every core modification, in order. */
export const EVOLUTION_STAGES = [
  'request',
  'analyze',
  'proposal',
  'affected_files',
  'risks',
  'plan',
  'sandbox',
  'implement',
  'unit_tests',
  'integration_tests',
  'build',
  'self_test',
  'diff',
  'change_report',
  'owner_approval',
  'checkpoint',
  'deploy',
  'health_check',
  'verify',
] as const;
export type EvolutionStage = (typeof EVOLUTION_STAGES)[number];

export const EVOLUTION_STATUSES = [
  'PROPOSED',
  'IN_SANDBOX',
  'TESTING',
  'TESTS_FAILED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'DEPLOYING',
  'SUCCESS',
  'ROLLED_BACK',
  'FAILED',
  'BLOCKED',
] as const;
export type EvolutionStatus = (typeof EVOLUTION_STATUSES)[number];

/** §18 — test gates, and which gates each risk level requires. */
export const TEST_GATES = ['static', 'unit', 'integration', 'security', 'packaging', 'self_test', 'e2e'] as const;
export type TestGate = (typeof TEST_GATES)[number];
export function requiredGates(risk: RiskLevel, mode: ModificationMode): TestGate[] {
  if (mode === 'config') return ['static'];
  const base: TestGate[] = ['static', 'unit'];
  if (mode === 'extension') return risk === 'LOW' ? base : [...base, 'integration'];
  switch (risk) {
    case 'LOW':
      return base;
    case 'MEDIUM':
      return [...base, 'integration'];
    case 'HIGH':
      return [...base, 'integration', 'security', 'packaging'];
    case 'CRITICAL':
      return [...TEST_GATES];
  }
}

export const TestResultSchema = z
  .object({
    gate: z.enum(TEST_GATES),
    command: z.string(),
    passed: z.boolean(),
    counts: z.object({ passed: z.number().int(), failed: z.number().int(), skipped: z.number().int() }).nullable(),
    duration_ms: z.number().int().nonnegative(),
    output_tail: z.string(),
  })
  .strict();
export type TestResult = z.infer<typeof TestResultSchema>;

/** §5 — the change proposal. Field names follow the project's snake_case JSON convention. */
export const ChangeProposalSchema = z
  .object({
    evolution_id: z.string().regex(/^evo_[a-z0-9-]+$/),
    request: z.string().min(1),
    requested_by: z.enum(['owner-ui', 'modulex-agent']),
    authored_by: z.enum(['ai', 'manual']),
    category: z.enum(REQUEST_CATEGORIES),
    classification: z.enum(MODIFICATION_MODES),
    kinds: z.array(z.enum(CHANGE_KINDS)).min(1),
    reason: z.string().min(1),
    affected_components: z.array(z.enum(COMPONENT_IDS as [Component, ...Component[]])),
    files: z.array(z.string()),
    dependencies: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
    database_changes: z.array(z.string()),
    security_impact: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    risk: z.enum(RISK_LEVELS),
    rollback_plan: z.string().min(1),
    tests: z.array(z.enum(TEST_GATES)),
    estimated_cost_usd: z.number().nonnegative(),
    requires_owner_approval: z.literal(true),
    base_version: z.string(),
    target_version: z.string(),
  })
  .strict();
export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;

/** §6 — exactly what the owner sees before approving. Bound to the diff hash it was computed from. */
export interface EvolutionReview {
  evolution_id: string;
  title: string;
  version_transition: { from: string; to: string };
  changes: string[];
  why: string;
  files: { modified: number; added: number; deleted: number; list: string[] };
  dependencies: { added: string[]; removed: string[] };
  database_migrations: string[];
  security: { impact: ChangeProposal['security_impact']; protected_components: Component[]; notes: string[] };
  cost_usd: number;
  rollback: { available: boolean; method: string };
  tests: { passed: number; failed: number; skipped: number; gates: { gate: TestGate; passed: boolean }[] };
  risk: RiskLevel;
  guard_violations: string[];
  diff_sha256: string;
  /** CRITICAL reviews require the owner to type the evolution id to confirm (§19 "stronger approval"). */
  confirmation_required: boolean;
}

/**
 * §17 / §33 — patch guard. Static checks over a unified diff that catch an AI patch weakening the system to make
 * itself pass. Any violation blocks deployment outright (not just "needs approval"): the owner must reject it or
 * have the patch rewritten. Protected-component changes are not violations — they are CRITICAL and owner-only.
 */
export function patchGuard(diff: string): string[] {
  const v: string[] = [];
  const files = diffFiles(diff);
  for (const f of files) {
    if (f.status === 'deleted' && /(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]sx?$|Tests?\.cs$/.test(f.path))
      v.push(`deletes a test file: ${f.path}`);
  }
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  if (added.some((l) => /\b(it|test|describe)\.(skip|todo)\(|\bxit\(|\[Fact\(Skip\s*=/.test(l)))
    v.push('skips or disables tests');
  const auditRemoved = removed.filter((l) => /audit\.append\(/.test(l)).length;
  const auditAdded = added.filter((l) => /audit\.append\(/.test(l)).length;
  if (auditRemoved > auditAdded) v.push(`removes ${auditRemoved - auditAdded} audit log call(s)`);
  if (added.some((l) => /requires_owner_approval\s*:\s*false|confirmed\s*:\s*true\s*[,}]\s*\/\/\s*auto/i.test(l)))
    v.push('bypasses owner approval');
  if (added.some((l) => /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(l)))
    v.push('adds a hard-coded credential');
  if (added.some((l) => /listen\([^)]*['"]0\.0\.0\.0['"]/.test(l))) v.push('exposes a service on all interfaces');
  return v;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
}

/** Parse the file list out of a `git diff` unified diff. */
export function diffFiles(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2]!, status: m[1] !== m[2] ? 'renamed' : 'modified' };
      out.push(cur);
    } else if (cur && line.startsWith('new file mode')) cur.status = 'added';
    else if (cur && line.startsWith('deleted file mode')) cur.status = 'deleted';
  }
  return out;
}

/** §24 — self-diagnostic repair classes. Security-critical repairs are never automatic. */
export const REPAIR_ACTIONS = {
  restart_core: { automatic: true, security: false },
  restart_godot_server: { automatic: true, security: false },
  rebuild_connection_config: { automatic: false, security: false },
  restore_workflow_version: { automatic: false, security: false },
  disable_extension: { automatic: true, security: false },
  enter_safe_mode: { automatic: true, security: false },
  rotate_credentials: { automatic: false, security: true },
  change_network_exposure: { automatic: false, security: true },
  change_policy: { automatic: false, security: true },
} as const;
export type RepairAction = keyof typeof REPAIR_ACTIONS;
