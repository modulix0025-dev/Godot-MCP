// SPDX-License-Identifier: Apache-2.0
//
// System Evolution service (Execution Patch 2). One lifecycle for the three modification modes:
//
//   Mode A  config     → validate candidate → exact JSON diff → owner approval → versioned write → verify
//   Mode B  extension  → inspect manifest/permissions/licence/deps → sandbox copy → content validation
//                        (+ workflow test job) → owner approval → backup → install → health → verify
//   Mode C  core       → sandbox git worktree + branch → patch → risk-based test gates → diff + patch guard →
//                        owner approval (bound to the diff hash) → checkpoint tag + data backup → fast-forward
//                        production → health check → verify, or automatic revert
//
// Invariants (§17, §25, §26, §33):
//   - nothing touches the live installation before the owner approved the exact change (hash-bound);
//   - only the owner (the Studio UI principal) can approve; CRITICAL changes need a typed confirmation;
//   - an agent can deploy only LOW/MEDIUM, non-protected evolutions; protected controls (policy gateway,
//     approvals, audit, credentials, backup/rollback, updater, sandbox, schema) are owner-deployed only;
//   - a patch that removes audit calls, deletes or skips tests, hard-codes credentials or opens 0.0.0.0 is
//     blocked outright, whatever anyone approves;
//   - every transition is audited.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canRunJob,
  classifyRequest,
  componentsForFiles,
  CONFIG_DOCS,
  diffFiles,
  isProtected,
  maxRisk,
  MODE_FOR_CATEGORY,
  patchGuard,
  publicWorkerView,
  requiredGates,
  riskFloor,
  riskRank,
  stricterMode,
  studioError,
  StudioFailure,
  type ChangeProposal,
  type ConfigDocId,
  type EvolutionReview,
  type EvolutionStage,
  type EvolutionStatus,
  type ExtensionManifest,
  type ExtensionReview,
  type JsonChange,
  type Permission,
  type RequestCategory,
  type RiskLevel,
  type TestResult,
  type WorkflowDefinition,
} from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor } from '../audit/secrets.js';
import type { StudioStore } from '../store/studio-store.js';
import { createBackup, restoreBackup, tagCheckpoint, type Backup } from './checkpoint.js';
import type { ConfigStore } from './config-store.js';
import { MANIFEST_FILE, type ExtensionRegistry } from './extension-registry.js';
import { git, GitError, gitHead } from './git.js';
import { runGate, type GateCommand, type GateCommands } from './test-runner.js';
import type { UpdateManager } from './updates.js';

type Actor = 'owner-ui' | 'modulex-agent';

export interface StageRecord {
  stage: EvolutionStage;
  status: 'done' | 'failed' | 'skipped' | 'blocked';
  at: string;
  detail: string;
}

export interface EvolutionRecord {
  evolution_id: string;
  proposal: ChangeProposal;
  status: EvolutionStatus;
  stages: StageRecord[];
  workspace: string;
  plan: string | null;
  tests: TestResult[];
  review: EvolutionReview | null;
  approval: { by: 'owner-ui'; at: string; diff_sha256: string; grants: Permission[] } | null;
  deployment: {
    at: string;
    checkpoint_tag: string | null;
    backup: Backup | null;
    health: { ok: boolean; detail: string } | null;
    verified: boolean;
    /** Commit subjects actually deployed (core only) — the changelog's only source for code changes. */
    commits?: string[];
  } | null;
  rollback: { at: string; by: string; reason: string } | null;
  problems: string[];
  config: { doc: ConfigDocId; candidate: unknown; base_version: number; diff: JsonChange[] } | null;
  extension: {
    package: string;
    name: string;
    version: string;
    kinds: string[];
    review: ExtensionReview;
    is_update_of: string | null;
    sandbox_dir: string;
    workflow_test: { worker_id: string; output: string; checks: string[] } | null;
  } | null;
  core: { branch: string; base_commit: string; worktree: string } | null;
  created_at: string;
  updated_at: string;
}

/** A job runner for workflow test generations (ComfyUI client in Phase 7; a fake in tests). */
export interface WorkflowTester {
  run(def: WorkflowDefinition, graph: unknown, workerId: string): Promise<{ bytes: Buffer; filename: string }>;
}

export interface SourceWorkspace {
  /** The production checkout of the Studio source (the branch below is checked out here). */
  repo: string;
  productionBranch: string;
  gates: GateCommands;
  /** Run in the production checkout after deploy; failure → automatic revert. */
  healthCheck: GateCommand[];
  /** Run after a healthy deploy; SUCCESS only when it passes. */
  verify: GateCommand[];
}

export interface EvolutionOptions {
  dataDir: string;
  studioVersion: string;
  audit: AuditLog;
  redactor: Redactor;
  config: ConfigStore;
  configPath?: string;
  extensions: ExtensionRegistry;
  store: StudioStore;
  updates?: UpdateManager;
  source?: SourceWorkspace;
  workflowTester?: WorkflowTester;
  /** Re-reads live configuration after a config deploy (e.g. the gateway's policy). Returns problems. */
  onConfigApplied?: (doc: ConfigDocId) => string[];
  now?: () => Date;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const fail = (
  code: Parameters<typeof studioError>[1],
  message: string,
  action: string,
  status: 'BLOCKED' | 'FAILED' = 'BLOCKED',
) => new StudioFailure(studioError(status, code, message, action));

function bumpVersion(v: string, category: RequestCategory): string {
  const [a, b, c] = v.split('.').map(Number) as [number, number, number];
  return category === 'BUGFIX' ? `${a}.${b}.${c + 1}` : `${a}.${b + 1}.0`;
}

export class EvolutionService {
  private readonly records = new Map<string, EvolutionRecord>();
  private readonly root: string;
  private readonly now: () => Date;

  constructor(private readonly o: EvolutionOptions) {
    this.root = join(o.dataDir, 'evolution');
    this.now = o.now ?? (() => new Date());
    const f = join(this.root, 'history.json');
    if (existsSync(f))
      for (const r of JSON.parse(readFileSync(f, 'utf-8')) as EvolutionRecord[]) this.records.set(r.evolution_id, r);
  }

  // ================================================================ queries

  get(id: string): EvolutionRecord {
    const r = this.records.get(id);
    if (!r)
      throw fail(
        'NOT_FOUND',
        `Evolution '${id}' not found.`,
        'List evolutions with studio_evolution_history.',
        'FAILED',
      );
    return r;
  }

  /** §22 — Evolution History rows. */
  history() {
    return [...this.records.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => ({
        evolution_id: r.evolution_id,
        version: `${r.proposal.base_version} → ${r.proposal.target_version}`,
        date: r.created_at,
        change: r.proposal.request,
        classification: r.proposal.classification,
        requested_by: r.proposal.requested_by,
        authored_by: r.proposal.authored_by,
        status: r.status,
        risk: r.proposal.risk,
        tests: r.tests.length ? `${r.tests.filter((t) => t.passed).length}/${r.tests.length} gates` : '—',
        approval: r.approval ? `owner ${r.approval.at}` : r.status === 'REJECTED' ? 'rejected' : '—',
        rollback: r.rollback ? `rolled back ${r.rollback.at}` : r.deployment ? 'available' : '—',
      }));
  }

  /**
   * §23 — changelog built ONLY from what actually happened: verified evolutions and the commit subjects that were
   * deployed. Rolled-back and rejected changes are listed as such; nothing is summarised or invented.
   */
  changelog(): string {
    const byVersion = new Map<string, string[]>();
    const recs = [...this.records.values()]
      .filter((r) => r.deployment && (r.status === 'SUCCESS' || r.status === 'ROLLED_BACK'))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of recs) {
      const v = r.proposal.target_version;
      const lines = byVersion.get(v) ?? [];
      const tag = r.status === 'ROLLED_BACK' ? ' (rolled back)' : '';
      const who = r.proposal.authored_by === 'ai' ? 'ModuleX Agent' : 'owner';
      if (r.config)
        lines.push(`- config ${r.config.doc}: ${r.config.diff.length} change(s)${tag} [${r.evolution_id}, ${who}]`);
      else if (r.extension)
        lines.push(
          `- extension ${r.extension.name} ${r.extension.is_update_of ? `${r.extension.is_update_of} → ` : ''}${r.extension.version}${tag} [${r.evolution_id}, ${who}]`,
        );
      else for (const c of r.deployment!.commits ?? []) lines.push(`- ${c}${tag} [${r.evolution_id}, ${who}]`);
      byVersion.set(v, lines);
    }
    return [...byVersion.entries()]
      .sort(([a], [b]) => (a === b ? 0 : a < b ? 1 : -1))
      .map(([v, lines]) => `## ${v}\n${lines.join('\n')}`)
      .join('\n\n');
  }

  // ================================================================ proposals (all modes)

  private newRecord(p: Omit<ChangeProposal, 'evolution_id' | 'requires_owner_approval'>): EvolutionRecord {
    const evolution_id = `evo_${randomUUID().slice(0, 13)}`;
    const at = this.now().toISOString();
    const workspace = join(this.root, evolution_id);
    mkdirSync(workspace, { recursive: true });
    const r: EvolutionRecord = {
      evolution_id,
      proposal: { ...p, evolution_id, requires_owner_approval: true },
      status: 'PROPOSED',
      stages: [],
      workspace,
      plan: null,
      tests: [],
      review: null,
      approval: null,
      deployment: null,
      rollback: null,
      problems: [],
      config: null,
      extension: null,
      core: null,
      created_at: at,
      updated_at: at,
    };
    this.records.set(evolution_id, r);
    this.stage(r, 'request', 'done', p.request);
    this.stage(r, 'analyze', 'done', `${p.category} → ${p.classification} (${p.kinds.join(', ')})`);
    this.o.audit.append('evolution_proposed', p.requested_by, {
      evolution_id,
      classification: p.classification,
      category: p.category,
      risk: p.risk,
    });
    return r;
  }

  /**
   * §32 — classify a free-text request and open an evolution. The agent's own category is honoured only when it is
   * at least as controlled as Core's keyword classification.
   */
  propose(input: { request: string; by: Actor; category?: RequestCategory; reason?: string }): EvolutionRecord {
    const core = classifyRequest(input.request);
    const agentMode = input.category ? MODE_FOR_CATEGORY[input.category] : core.mode;
    const mode = stricterMode(agentMode, core.mode);
    const category = mode === agentMode && input.category ? input.category : core.category;
    const risk = riskFloor([], core.kinds);
    const r = this.newRecord({
      request: input.request,
      requested_by: input.by,
      authored_by: input.by === 'owner-ui' ? 'manual' : 'ai',
      category,
      classification: mode,
      kinds: core.kinds,
      reason: input.reason ?? input.request,
      affected_components: [],
      files: [],
      dependencies: { added: [], removed: [] },
      database_changes: [],
      security_impact: 'none',
      risk,
      rollback_plan:
        mode === 'config'
          ? 'Restore the previous configuration version.'
          : mode === 'extension'
            ? 'Re-activate the previous extension version (kept on disk) or uninstall.'
            : 'Revert the evolution commits on the production branch; restore the data backup.',
      tests: requiredGates(risk, mode),
      estimated_cost_usd: 0,
      base_version: this.o.studioVersion,
      target_version: mode === 'core' ? bumpVersion(this.o.studioVersion, category) : this.o.studioVersion,
    });
    this.stage(
      r,
      'proposal',
      'done',
      `next: ${mode === 'config' ? 'studio_config_propose' : mode === 'extension' ? 'studio_extension_install / studio_workflow_register / studio_provider_register' : 'studio_evolution_plan'}`,
    );
    if (mode === 'core' && !this.o.source) {
      r.status = 'BLOCKED';
      r.problems.push(
        'Core changes need the Studio source workspace (Settings → System → Developer source); none is configured.',
      );
      this.stage(r, 'sandbox', 'blocked', r.problems[0]!);
      this.o.audit.append('evolution_blocked', 'studio', {
        evolution_id: r.evolution_id,
        reason: 'no source workspace',
      });
    }
    this.save();
    return r;
  }

  // ---------------------------------------------------------------- Mode A

  proposeConfig(input: { doc: ConfigDocId; value: unknown; reason: string; by: Actor }): EvolutionRecord {
    const cur = this.o.config.get(input.doc);
    const preview = this.o.config.preview(input.doc, input.value);
    const docMeta = CONFIG_DOCS[input.doc];
    const r = this.newRecord({
      request: `Change ${input.doc}: ${input.reason}`,
      requested_by: input.by,
      authored_by: input.by === 'owner-ui' ? 'manual' : 'ai',
      category: 'CONFIG',
      classification: 'config',
      kinds: ['runtime_config'],
      reason: input.reason,
      affected_components: docMeta.security ? ['policy_gateway'] : [],
      files: [`config:${input.doc}`],
      dependencies: { added: [], removed: [] },
      database_changes: [],
      security_impact: docMeta.security ? 'critical' : 'none',
      risk: docMeta.risk,
      rollback_plan: `Restore ${input.doc} v${cur.version} (every version is kept).`,
      tests: ['static'],
      estimated_cost_usd: 0,
      base_version: this.o.studioVersion,
      target_version: this.o.studioVersion,
    });
    this.stage(r, 'proposal', 'done', `${input.doc} v${cur.version} → v${cur.version + 1}`);
    const started = Date.now();
    if (!preview.ok) {
      r.tests.push(this.syntheticTest('static', false, preview.issues.join('\n'), started));
      r.status = 'TESTS_FAILED';
      r.problems.push(...preview.issues);
      this.stage(r, 'unit_tests', 'failed', preview.issues.join('; '));
      this.save();
      return r;
    }
    r.config = { doc: input.doc, candidate: preview.value, base_version: cur.version, diff: preview.diff };
    r.tests.push(
      this.syntheticTest('static', true, `schema ${input.doc}: valid; ${preview.diff.length} change(s)`, started),
    );
    for (const s of ['affected_files', 'risks', 'plan', 'sandbox', 'implement'] as const)
      this.stage(r, s, 'skipped', 'configuration change');
    this.stage(r, 'unit_tests', 'done', 'schema validation passed');
    this.o.audit.append('config_change_proposed', input.by, {
      evolution_id: r.evolution_id,
      doc: input.doc,
      changes: preview.diff.length,
    });
    this.buildReview(r);
    r.status = 'AWAITING_APPROVAL';
    this.save();
    return r;
  }

  // ---------------------------------------------------------------- Mode B

  async proposeExtension(input: {
    package: string;
    by: Actor;
    reason?: string;
    expectKind?: ExtensionManifest['kinds'][number];
  }): Promise<EvolutionRecord> {
    const pkgDir = this.o.extensions.incomingDir(input.package);
    const ins = this.o.extensions.inspect(pkgDir, this.o.studioVersion);
    const m = ins.manifest;
    const kinds = m?.kinds ?? [];
    const components = [
      ...(kinds.includes('skill') ? (['skills'] as const) : []),
      ...(kinds.includes('workflow') ? (['workflows'] as const) : []),
      ...(kinds.includes('provider') ? (['providers'] as const) : []),
      ...(kinds.includes('mcp_adapter') ? (['mcp_adapters'] as const) : []),
      ...(kinds.includes('ui_panel') ? (['ui'] as const) : []),
    ];
    const risk = maxRisk(ins.review.risk, riskFloor(components, ['skill_workflow']));
    const category: RequestCategory = kinds.includes('workflow')
      ? 'WORKFLOW'
      : kinds.includes('provider')
        ? 'PROVIDER'
        : 'EXTENSION';
    const r = this.newRecord({
      request: `${ins.is_update_of ? 'Update' : 'Install'} extension ${m ? `${m.name} ${m.version}` : input.package}`,
      requested_by: input.by,
      authored_by: input.by === 'owner-ui' ? 'manual' : 'ai',
      category,
      classification: 'extension',
      kinds: ['skill_workflow'],
      reason: input.reason ?? m?.description ?? 'extension install',
      affected_components: components,
      files: m ? Object.keys(m.files) : [],
      dependencies: { added: m ? m.dependencies.map((d) => `${d.name} ${d.range}`) : [], removed: [] },
      database_changes: [],
      security_impact: ins.review.needs_explicit_grant.length
        ? 'medium'
        : ins.review.risk === 'CRITICAL'
          ? 'critical'
          : 'low',
      risk,
      rollback_plan: ins.is_update_of
        ? `Re-activate ${m?.name} ${ins.is_update_of} (kept on disk).`
        : 'Uninstall the extension; restore the registry backup.',
      tests: requiredGates(risk, 'extension'),
      estimated_cost_usd: 0,
      base_version: this.o.studioVersion,
      target_version: this.o.studioVersion,
    });
    this.o.audit.append('extension_inspected', input.by, {
      evolution_id: r.evolution_id,
      package: input.package,
      ok: ins.review.ok && !ins.content_problems.length,
      risk: ins.review.risk,
    });
    const started = Date.now();
    const problems = [...ins.review.problems, ...ins.content_problems];
    if (m && input.expectKind && !m.kinds.includes(input.expectKind))
      problems.push(`package ${m.name} is not a ${input.expectKind} (it provides: ${m.kinds.join(', ')})`);
    this.stage(r, 'proposal', 'done', m ? `${m.name} ${m.version} (${m.kinds.join(', ')})` : 'unreadable manifest');
    this.stage(r, 'affected_files', 'done', `${Object.keys(m?.files ?? {}).length} packaged file(s)`);
    this.stage(
      r,
      'risks',
      'done',
      `risk ${risk}; explicit grants needed: ${ins.review.needs_explicit_grant.join(', ') || 'none'}`,
    );
    if (!m || problems.length) {
      r.problems.push(...problems);
      r.tests.push(this.syntheticTest('static', false, problems.join('\n'), started));
      r.status = 'BLOCKED';
      this.stage(r, 'sandbox', 'blocked', problems.join('; '));
      this.o.audit.append('evolution_blocked', 'studio', { evolution_id: r.evolution_id, problems: problems.length });
      this.save();
      return r;
    }
    const sandbox_dir = join(r.workspace, 'extension');
    this.o.extensions.stage(pkgDir, m, sandbox_dir);
    this.stage(r, 'plan', 'skipped', 'declarative package');
    this.stage(r, 'sandbox', 'done', 'staged into the evolution sandbox (not live)');
    this.stage(r, 'implement', 'skipped', 'declarative package');
    this.o.audit.append('evolution_sandbox_created', 'studio', { evolution_id: r.evolution_id, kind: 'extension' });
    r.extension = {
      package: input.package,
      name: m.name,
      version: m.version,
      kinds: m.kinds,
      review: ins.review,
      is_update_of: ins.is_update_of,
      sandbox_dir,
      workflow_test: null,
    };
    r.tests.push(
      this.syntheticTest('static', true, 'manifest, hashes, licence, compatibility, content schemas: ok', started),
    );
    this.stage(r, 'unit_tests', 'done', 'manifest + content validation passed');

    if (m.kinds.includes('workflow')) {
      const t = await this.workflowTestJob(r, m, sandbox_dir);
      r.tests.push(t);
      this.stage(r, 'integration_tests', t.passed ? 'done' : 'failed', t.output_tail.split('\n')[0] ?? '');
      if (!t.passed) {
        r.status = /no TRUSTED worker|no workflow test runner/.test(t.output_tail) ? 'BLOCKED' : 'TESTS_FAILED';
        r.problems.push(t.output_tail);
        this.o.audit.append('evolution_tested', 'studio', { evolution_id: r.evolution_id, passed: false });
        this.save();
        return r;
      }
    } else this.stage(r, 'integration_tests', 'skipped', 'no executable content');
    this.o.audit.append('evolution_tested', 'studio', { evolution_id: r.evolution_id, passed: true });
    this.buildReview(r);
    r.status = 'AWAITING_APPROVAL';
    this.save();
    return r;
  }

  /** §27 steps 3–7: find a capable TRUSTED worker, run one test generation, validate the output. */
  private async workflowTestJob(r: EvolutionRecord, m: ExtensionManifest, dir: string): Promise<TestResult> {
    const started = Date.now();
    const rel = m.entrypoints.workflow![0]!;
    const def = JSON.parse(readFileSync(join(dir, rel), 'utf-8')) as WorkflowDefinition;
    const graph = JSON.parse(readFileSync(join(dir, def.graph), 'utf-8')) as unknown;
    const worker = this.o.store
      .listWorkers()
      .find(
        (w) => canRunJob(w.trust, 'production') && def.worker_capabilities.every((c) => w.capabilities.includes(c)),
      );
    if (!this.o.workflowTester)
      return this.syntheticTest(
        'integration',
        false,
        'no workflow test runner is configured in this build (Phase 7 ComfyUI client)',
        started,
      );
    if (!worker)
      return this.syntheticTest(
        'integration',
        false,
        `no TRUSTED worker offers capabilities [${def.worker_capabilities.join(', ')}] — add or onboard one in Workers`,
        started,
      );
    try {
      const out = await this.o.workflowTester.run(def, graph, worker.worker_id);
      const checks: string[] = [];
      const bad: string[] = [];
      for (const c of def.validation.output_checks) {
        if (c === 'nonempty') (out.bytes.length > 0 ? checks : bad).push('nonempty');
        if (c === 'glb_magic') (out.bytes.subarray(0, 4).toString('ascii') === 'glTF' ? checks : bad).push('glb_magic');
        if (c === 'png_magic') (out.bytes.subarray(1, 4).toString('ascii') === 'PNG' ? checks : bad).push('png_magic');
        if (c === 'provenance') (def.license_facts.length > 0 ? checks : bad).push('provenance');
        if (c === 'triangle_budget') checks.push('triangle_budget (deferred to Godot import in Phase 8)');
      }
      const outPath = join(r.workspace, 'test-output', out.filename.replace(/[^A-Za-z0-9._-]/g, '_'));
      mkdirSync(join(r.workspace, 'test-output'), { recursive: true });
      writeFileSync(outPath, out.bytes);
      r.extension!.workflow_test = { worker_id: publicWorkerView(worker).worker_id, output: outPath, checks };
      return this.syntheticTest(
        'integration',
        bad.length === 0,
        bad.length
          ? `test job on ${worker.worker_id}: output failed ${bad.join(', ')}`
          : `test job on ${worker.worker_id}: ${out.bytes.length} bytes; checks ${checks.join(', ')}`,
        started,
      );
    } catch (e) {
      return this.syntheticTest('integration', false, `test job failed: ${this.o.redactor.redact(String(e))}`, started);
    }
  }

  // ---------------------------------------------------------------- Mode C

  /** Create the sandbox (worktree + branch) and apply the agent's patch there. Never touches production. */
  plan(id: string, input: { plan: string; patch?: string; by: Actor; message?: string }): EvolutionRecord {
    const r = this.get(id);
    const src = this.o.source;
    if (r.proposal.classification !== 'core')
      throw fail(
        'INVALID_ARGUMENTS',
        'Only core evolutions take a patch plan.',
        'Use the proposal tool for this mode.',
        'FAILED',
      );
    if (!src)
      throw fail(
        'PIPELINE_ENGINE_UNAVAILABLE',
        'No Studio source workspace is configured.',
        'Configure it in Settings → System.',
      );
    if (!['PROPOSED', 'IN_SANDBOX', 'TESTS_FAILED'].includes(r.status))
      throw fail(
        'INVALID_ARGUMENTS',
        `Evolution is ${r.status}; plans can only change before review.`,
        'Open a new evolution.',
        'FAILED',
      );
    r.plan = input.plan;
    this.stage(r, 'plan', 'done', input.plan.slice(0, 200));
    if (!r.core) {
      const branch = `evolution/${r.evolution_id}`;
      const worktree = join(r.workspace, 'worktree');
      const base_commit = gitHead(src.repo, src.productionBranch);
      git(src.repo, ['worktree', 'add', '-b', branch, worktree, base_commit]);
      r.core = { branch, base_commit, worktree };
      this.stage(r, 'sandbox', 'done', `worktree ${branch} @ ${base_commit.slice(0, 10)}`);
      this.o.audit.append('evolution_sandbox_created', 'studio', { evolution_id: id, kind: 'git-worktree', branch });
    }
    if (input.patch) {
      try {
        git(
          r.core.worktree,
          ['apply', '--index', '--whitespace=nowarn', '-'],
          input.patch.endsWith('\n') ? input.patch : `${input.patch}\n`,
        );
        git(r.core.worktree, [
          '-c',
          'user.name=ModuleX System Evolution',
          '-c',
          'user.email=evolution@modulex.invalid',
          'commit',
          '-q',
          '-m',
          `${input.message ?? r.proposal.request}\n\nEvolution: ${id}\nAuthored-by: ${input.by === 'owner-ui' ? 'owner' : 'ModuleX Agent'}`,
        ]);
      } catch (e) {
        const msg = e instanceof GitError ? e.message : String(e);
        this.stage(r, 'implement', 'failed', msg);
        throw fail(
          'INVALID_ARGUMENTS',
          `The patch does not apply to the sandbox: ${this.o.redactor.redact(msg)}`,
          'Regenerate the patch against the evolution base commit.',
          'FAILED',
        );
      }
      this.stage(r, 'implement', 'done', 'patch committed in the sandbox branch');
    }
    this.refreshCoreScope(r);
    r.status = 'IN_SANDBOX';
    r.tests = [];
    r.review = null;
    this.o.audit.append('evolution_planned', input.by, {
      evolution_id: id,
      files: r.proposal.files.length,
      risk: r.proposal.risk,
    });
    this.save();
    return r;
  }

  private coreDiff(r: EvolutionRecord): string {
    return git(r.core!.worktree, ['diff', '--no-color', `${r.core!.base_commit}..HEAD`]);
  }

  /** Recompute files/components/risk from the ACTUAL diff (an agent can raise risk, never lower it). */
  private refreshCoreScope(r: EvolutionRecord): void {
    const files = diffFiles(this.coreDiff(r));
    const paths = files.map((f) => f.path);
    const components = componentsForFiles(paths);
    const kinds = new Set(r.proposal.kinds);
    if (paths.some((p) => /package(-lock)?\.json$|Cargo\.(toml|lock)$|\.csproj$/.test(p))) kinds.add('dependency');
    if (components.includes('schema')) kinds.add('schema_migration');
    if (components.includes('build_system') || components.includes('shell')) kinds.add('platform_build');
    r.proposal.files = paths;
    r.proposal.kinds = [...kinds];
    r.proposal.affected_components = components;
    r.proposal.risk = maxRisk(r.proposal.risk, riskFloor(components, r.proposal.kinds));
    r.proposal.security_impact = isProtected(components)
      ? 'critical'
      : riskRank(r.proposal.risk) >= 2
        ? 'medium'
        : 'low';
    r.proposal.tests = requiredGates(r.proposal.risk, 'core');
    this.stage(r, 'affected_files', 'done', `${paths.length} file(s): ${components.join(', ') || '—'}`);
    this.stage(
      r,
      'risks',
      'done',
      `risk ${r.proposal.risk}${isProtected(components) ? ' — touches protected controls (owner-only)' : ''}`,
    );
  }

  /** §18 — run the risk-based gates in the sandbox. */
  test(id: string, by: Actor): EvolutionRecord {
    const r = this.get(id);
    if (r.proposal.classification !== 'core') return r; // config/extension proposals are tested when proposed
    if (!r.core || !this.o.source)
      throw fail(
        'INVALID_ARGUMENTS',
        'Create the sandbox with studio_evolution_plan first.',
        'Call studio_evolution_plan.',
        'FAILED',
      );
    if (!['IN_SANDBOX', 'TESTS_FAILED'].includes(r.status))
      throw fail('INVALID_ARGUMENTS', `Evolution is ${r.status}.`, 'Tests run before review only.', 'FAILED');
    r.status = 'TESTING';
    r.tests = [];
    const stageFor: Partial<Record<string, EvolutionStage>> = {
      static: 'unit_tests',
      unit: 'unit_tests',
      integration: 'integration_tests',
      security: 'integration_tests',
      packaging: 'build',
      self_test: 'self_test',
      e2e: 'self_test',
    };
    for (const gate of r.proposal.tests) {
      const cmds = this.o.source.gates[gate];
      if (!cmds?.length) {
        r.tests.push(this.syntheticTest(gate, false, `gate '${gate}' has no configured command`, Date.now()));
        break;
      }
      const t = runGate(r.core.worktree, gate, cmds, (s) => this.o.redactor.redact(s));
      r.tests.push(t);
      this.stage(r, stageFor[gate]!, t.passed ? 'done' : 'failed', `${gate}: ${t.passed ? 'passed' : 'FAILED'}`);
      if (!t.passed) break; // fail fast; later gates are not run
    }
    const passed = r.tests.length === r.proposal.tests.length && r.tests.every((t) => t.passed);
    r.status = passed ? 'IN_SANDBOX' : 'TESTS_FAILED';
    this.o.audit.append('evolution_tested', by, {
      evolution_id: id,
      passed,
      gates: r.tests.map((t) => `${t.gate}:${t.passed}`),
    });
    this.save();
    return r;
  }

  // ================================================================ review + approval

  /** The exact diff text an approval is bound to. */
  diffText(r: EvolutionRecord): string {
    if (r.config)
      return JSON.stringify({ doc: r.config.doc, base: r.config.base_version, diff: r.config.diff }, null, 2);
    if (r.extension) {
      const m = JSON.parse(readFileSync(join(r.extension.sandbox_dir, MANIFEST_FILE), 'utf-8')) as ExtensionManifest;
      return JSON.stringify(
        { extension: m.name, version: m.version, permissions: m.permissions, files: m.files },
        null,
        2,
      );
    }
    if (r.core) return this.coreDiff(r);
    return '';
  }

  diff(id: string): {
    evolution_id: string;
    diff: string;
    truncated: boolean;
    review: EvolutionReview | null;
    guard: string[];
  } {
    const r = this.get(id);
    const text = this.o.redactor.redact(this.diffText(r));
    const max = 200_000;
    return {
      evolution_id: id,
      diff: text.slice(0, max),
      truncated: text.length > max,
      review: r.review,
      guard: r.core ? patchGuard(this.diffText(r)) : [],
    };
  }

  private buildReview(r: EvolutionRecord): EvolutionReview {
    const text = this.diffText(r);
    const p = r.proposal;
    let files = { modified: 0, added: 0, deleted: 0, list: [] as string[] };
    let changes: string[] = [];
    if (r.core) {
      const fl = diffFiles(text);
      files = {
        modified: fl.filter((f) => f.status === 'modified' || f.status === 'renamed').length,
        added: fl.filter((f) => f.status === 'added').length,
        deleted: fl.filter((f) => f.status === 'deleted').length,
        list: fl.map((f) => f.path),
      };
      changes = fl.map((f) => `${f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'} ${f.path}`);
    } else if (r.config) {
      files = { modified: 1, added: 0, deleted: 0, list: [`config:${r.config.doc}`] };
      changes = r.config.diff.map(
        (c) => `${c.op} ${c.path}: ${JSON.stringify(c.from ?? null)} → ${JSON.stringify(c.to ?? null)}`,
      );
    } else if (r.extension) {
      files = { modified: 0, added: p.files.length, deleted: 0, list: p.files };
      changes = [
        `${r.extension.is_update_of ? `~ ${r.extension.name} ${r.extension.is_update_of} → ${r.extension.version}` : `+ ${r.extension.name} ${r.extension.version}`} (${r.extension.kinds.join(', ')})`,
        ...r.extension.review.default_grants.map((g) => `+ permission ${g} (default)`),
        ...r.extension.review.needs_explicit_grant.map((g) => `? permission ${g} (owner must tick)`),
      ];
    }
    const counts = r.tests.reduce(
      (a, t) => ({
        passed: a.passed + (t.counts?.passed ?? (t.passed ? 1 : 0)),
        failed: a.failed + (t.counts?.failed ?? (t.passed ? 0 : 1)),
        skipped: a.skipped + (t.counts?.skipped ?? 0),
      }),
      { passed: 0, failed: 0, skipped: 0 },
    );
    const protectedComponents = p.affected_components.filter((c) => isProtected([c]));
    const review: EvolutionReview = {
      evolution_id: r.evolution_id,
      title: p.request,
      version_transition: { from: p.base_version, to: p.target_version },
      changes,
      why: p.reason,
      files,
      dependencies: p.dependencies,
      database_migrations: p.database_changes,
      security: {
        impact: p.security_impact,
        protected_components: protectedComponents,
        notes: [
          ...(protectedComponents.length ? ['Touches protected controls: owner-only deploy, typed confirmation.'] : []),
          ...(r.extension?.review.needs_explicit_grant.length
            ? ['High-risk permissions are NOT granted unless you tick them.']
            : []),
          ...(r.config && CONFIG_DOCS[r.config.doc].security ? ['Security-sensitive configuration.'] : []),
        ],
      },
      cost_usd: p.estimated_cost_usd,
      rollback: { available: true, method: p.rollback_plan },
      tests: { ...counts, gates: r.tests.map((t) => ({ gate: t.gate, passed: t.passed })) },
      risk: p.risk,
      guard_violations: r.core ? patchGuard(text) : [],
      diff_sha256: sha(text),
      confirmation_required: p.risk === 'CRITICAL' || protectedComponents.length > 0,
    };
    r.review = review;
    this.stage(r, 'diff', 'done', `sha256 ${review.diff_sha256.slice(0, 12)}…`);
    this.stage(r, 'change_report', 'done', `${changes.length} change line(s); risk ${review.risk}`);
    return review;
  }

  /** `studio_evolution_approve` — the agent SUBMITS for owner review. It cannot approve. */
  requestReview(id: string, by: Actor): EvolutionReview {
    const r = this.get(id);
    if (r.status === 'AWAITING_APPROVAL' && r.review) return r.review;
    if (r.proposal.classification !== 'core' || r.status !== 'IN_SANDBOX')
      throw fail(
        'INVALID_ARGUMENTS',
        `Evolution is ${r.status}; nothing to submit.`,
        'Run the pipeline steps first.',
        'FAILED',
      );
    const passed = r.tests.length === r.proposal.tests.length && r.tests.every((t) => t.passed);
    if (!passed)
      throw fail(
        'INVALID_ARGUMENTS',
        'Tests have not passed for the current patch.',
        'Call studio_evolution_test.',
        'FAILED',
      );
    const review = this.buildReview(r);
    r.status = review.guard_violations.length ? 'BLOCKED' : 'AWAITING_APPROVAL';
    if (review.guard_violations.length) {
      r.problems.push(...review.guard_violations);
      this.o.audit.append('evolution_blocked', 'studio', { evolution_id: id, guard: review.guard_violations });
    } else this.o.audit.append('evolution_review_requested', by, { evolution_id: id, risk: review.risk });
    this.save();
    return review;
  }

  /** Owner decision (Studio UI). Bound to the diff hash the owner saw. */
  decide(
    id: string,
    action: 'approve' | 'reject',
    opts: { actor: string; diff_sha256: string; confirm?: string; grants?: Permission[]; reason?: string },
  ): EvolutionRecord {
    if (opts.actor !== 'owner-ui')
      throw fail(
        'APPROVAL_NOT_OWNER',
        'Only the owner can approve or reject an evolution, in the Studio.',
        'Ask the owner to review it in System → Evolution.',
      );
    const r = this.get(id);
    if (r.status !== 'AWAITING_APPROVAL' || !r.review)
      throw fail(
        'INVALID_ARGUMENTS',
        `Evolution is ${r.status}.`,
        'Only evolutions awaiting approval can be decided.',
        'FAILED',
      );
    const current = sha(this.diffText(r));
    if (opts.diff_sha256 !== r.review.diff_sha256 || current !== r.review.diff_sha256)
      throw fail(
        'APPROVAL_EXPIRED',
        'The change differs from the one you reviewed.',
        'Reload the review and decide again.',
      );
    if (action === 'reject') {
      r.status = 'REJECTED';
      this.stage(r, 'owner_approval', 'failed', opts.reason ?? 'rejected by the owner');
      this.o.audit.append('evolution_rejected', 'owner-ui', { evolution_id: id, reason: opts.reason ?? null });
      this.cleanupWorktree(r);
      this.save();
      return r;
    }
    if (r.review.guard_violations.length)
      throw fail(
        'TOOL_NOT_ALLOWED',
        `Blocked by the patch guard: ${r.review.guard_violations.join('; ')}`,
        'Reject it and ask for a patch that keeps tests and audit intact.',
      );
    if (r.review.confirmation_required && opts.confirm !== id)
      throw fail(
        'APPROVAL_REQUIRED',
        'This change is CRITICAL: type the evolution id to confirm.',
        `Send confirm = "${id}".`,
      );
    const offered = r.extension
      ? [...r.extension.review.default_grants, ...r.extension.review.needs_explicit_grant]
      : [];
    const grants = r.extension
      ? [...new Set([...r.extension.review.default_grants, ...(opts.grants ?? []).filter((g) => offered.includes(g))])]
      : [];
    r.approval = { by: 'owner-ui', at: this.now().toISOString(), diff_sha256: current, grants };
    r.status = 'APPROVED';
    this.stage(r, 'owner_approval', 'done', `approved (sha256 ${current.slice(0, 12)}…)`);
    this.o.audit.append('evolution_approved', 'owner-ui', { evolution_id: id, risk: r.proposal.risk, grants });
    this.save();
    return r;
  }

  // ================================================================ deploy / verify / rollback

  async deploy(id: string, actor: Actor): Promise<EvolutionRecord> {
    const r = this.get(id);
    if (r.status !== 'APPROVED' || !r.approval || !r.review)
      throw fail(
        'APPROVAL_REQUIRED',
        `Evolution is ${r.status}; only owner-approved evolutions deploy.`,
        'Submit it for review; the owner approves in the Studio.',
      );
    const protectedScope = r.review.confirmation_required || isProtected(r.proposal.affected_components);
    if (actor !== 'owner-ui' && (protectedScope || riskRank(r.proposal.risk) >= riskRank('HIGH')))
      throw fail(
        'APPROVAL_NOT_OWNER',
        `A ${r.proposal.risk}${protectedScope ? ', protected' : ''} evolution is deployed by the owner, never by an agent.`,
        'Ask the owner to press Deploy in System → Evolution.',
      );
    if (sha(this.diffText(r)) !== r.approval.diff_sha256)
      throw fail('APPROVAL_EXPIRED', 'The change was modified after approval.', 'Re-submit for review.');
    r.status = 'DEPLOYING';
    this.save();
    try {
      if (r.config) await this.deployConfig(r, actor);
      else if (r.extension) await this.deployExtension(r);
      else if (r.core) await this.deployCore(r);
    } catch (e) {
      r.status = 'FAILED';
      r.problems.push(this.o.redactor.redact(e instanceof Error ? e.message : String(e)));
      this.o.audit.append('evolution_blocked', 'studio', { evolution_id: id, reason: 'deploy error' });
    }
    this.save();
    return r;
  }

  private dataBackup(r: EvolutionRecord): Backup {
    const paths = [...(this.o.configPath ? [this.o.configPath] : []), join(this.o.extensions.root, 'registry.json')];
    const b = createBackup(join(r.workspace, 'backup'), 'pre-deploy', paths, this.now());
    return b;
  }

  private async deployConfig(r: EvolutionRecord, actor: Actor): Promise<void> {
    const c = r.config!;
    const backup = this.dataBackup(r);
    r.deployment = { at: this.now().toISOString(), checkpoint_tag: null, backup, health: null, verified: false };
    this.stage(r, 'checkpoint', 'done', `config ${c.doc} v${c.base_version} kept; data backup taken`);
    this.o.audit.append('evolution_checkpoint_created', 'studio', { evolution_id: r.evolution_id, backup: backup.id });
    const v = this.o.config.apply(c.doc, c.candidate, {
      by: actor,
      evolutionId: r.evolution_id,
      reason: r.proposal.reason,
      expectedVersion: c.base_version,
    });
    this.stage(r, 'deploy', 'done', `${c.doc} v${v.version} written`);
    this.o.audit.append('config_changed', 'owner-ui', {
      evolution_id: r.evolution_id,
      doc: c.doc,
      version: v.version,
      changes: c.diff.length,
    });
    const problems = [
      ...(JSON.stringify(this.o.config.get(c.doc).value) === JSON.stringify(c.candidate) ? [] : ['read-back differs']),
      ...(this.o.onConfigApplied?.(c.doc) ?? []),
    ];
    r.deployment.health = { ok: problems.length === 0, detail: problems.join('; ') || 'live configuration reloaded' };
    this.o.audit.append('evolution_health_check', 'studio', {
      evolution_id: r.evolution_id,
      ok: problems.length === 0,
    });
    if (problems.length) {
      this.o.config.rollback(c.doc, c.base_version, 'studio', `health check failed: ${problems.join('; ')}`);
      return this.markRolledBack(r, 'studio', `health check failed: ${problems.join('; ')}`);
    }
    this.stage(r, 'health_check', 'done', r.deployment.health.detail);
    this.verified(r, `${c.doc} v${v.version} active`);
  }

  private async deployExtension(r: EvolutionRecord): Promise<void> {
    const x = r.extension!;
    const backup = this.dataBackup(r);
    r.deployment = { at: this.now().toISOString(), checkpoint_tag: null, backup, health: null, verified: false };
    this.stage(r, 'checkpoint', 'done', 'registry backup taken');
    this.o.audit.append('evolution_checkpoint_created', 'studio', { evolution_id: r.evolution_id, backup: backup.id });
    const m = JSON.parse(readFileSync(join(x.sandbox_dir, MANIFEST_FILE), 'utf-8')) as ExtensionManifest;
    this.o.extensions.install(x.sandbox_dir, m, r.approval!.grants, 'local');
    this.stage(r, 'deploy', 'done', `${m.name} ${m.version} installed`);
    this.o.audit.append(x.is_update_of ? 'extension_updated' : 'extension_installed', 'owner-ui', {
      evolution_id: r.evolution_id,
      name: m.name,
      version: m.version,
      grants: r.approval!.grants,
    });
    const problems = this.o.extensions.verify(m.name);
    if (m.kinds.includes('workflow')) {
      const def = this.o.extensions.workflows().find((w) => w.extension === m.name);
      if (!def || def.definition.version !== m.version) problems.push('workflow does not resolve to the new version');
      else
        this.o.audit.append(x.is_update_of ? 'workflow_activated' : 'workflow_registered', 'studio', {
          id: def.definition.id,
          version: m.version,
        });
    }
    if (m.kinds.includes('provider')) {
      for (const p of this.o.extensions.providers().filter((pp) => pp.extension === m.name))
        this.o.audit.append('provider_registered', 'studio', { id: p.definition.id, family: p.definition.family });
    }
    r.deployment.health = {
      ok: problems.length === 0,
      detail: problems.join('; ') || 'hashes verified; registry resolves the new version',
    };
    this.o.audit.append('evolution_health_check', 'studio', {
      evolution_id: r.evolution_id,
      ok: problems.length === 0,
    });
    if (problems.length) {
      restoreBackup(backup);
      return this.markRolledBack(r, 'studio', `health check failed: ${problems.join('; ')}`);
    }
    this.stage(r, 'health_check', 'done', r.deployment.health.detail);
    this.verified(r, `${m.name} ${m.version} active`);
  }

  private async deployCore(r: EvolutionRecord): Promise<void> {
    const src = this.o.source!;
    const c = r.core!;
    const tag = tagCheckpoint(src.repo, `mx-evo-cp/${r.evolution_id}`, src.productionBranch);
    const backup = this.dataBackup(r);
    r.deployment = { at: this.now().toISOString(), checkpoint_tag: tag, backup, health: null, verified: false };
    this.stage(r, 'checkpoint', 'done', `tag ${tag}; data backup`);
    this.o.audit.append('evolution_checkpoint_created', 'studio', {
      evolution_id: r.evolution_id,
      tag,
      backup: backup.id,
    });
    if (gitHead(src.repo, src.productionBranch) !== c.base_commit) {
      r.status = 'BLOCKED';
      r.problems.push('Production moved since the sandbox was created; re-run the evolution on the new base.');
      this.stage(r, 'deploy', 'blocked', r.problems[r.problems.length - 1]!);
      return;
    }
    r.deployment.commits = git(src.repo, ['log', '--format=%h %s', `${c.base_commit}..${c.branch}`])
      .split('\n')
      .filter(Boolean);
    git(src.repo, ['merge', '--ff-only', '-q', c.branch]);
    this.stage(r, 'deploy', 'done', `${src.productionBranch} fast-forwarded to ${gitHead(src.repo).slice(0, 10)}`);
    this.o.audit.append('evolution_deployed', 'owner-ui', { evolution_id: r.evolution_id, commit: gitHead(src.repo) });
    const health = runGate(src.repo, 'self_test', src.healthCheck, (s) => this.o.redactor.redact(s));
    r.deployment.health = { ok: health.passed, detail: health.output_tail.split('\n').slice(-3).join(' ') };
    this.o.audit.append('evolution_health_check', 'studio', { evolution_id: r.evolution_id, ok: health.passed });
    if (!health.passed) {
      this.revertCore(r);
      restoreBackup(backup);
      this.o.updates?.recordEvolution(
        r.proposal.base_version,
        r.proposal.target_version,
        'rolled_back',
        backup.dir,
        'health check failed',
      );
      return this.markRolledBack(r, 'studio', 'health check failed after deploy');
    }
    this.stage(r, 'health_check', 'done', 'health check passed');
    const verify = runGate(src.repo, 'e2e', src.verify, (s) => this.o.redactor.redact(s));
    if (!verify.passed) {
      this.revertCore(r);
      restoreBackup(backup);
      this.o.updates?.recordEvolution(
        r.proposal.base_version,
        r.proposal.target_version,
        'rolled_back',
        backup.dir,
        'verification failed',
      );
      return this.markRolledBack(r, 'studio', 'verification failed after deploy');
    }
    this.o.updates?.recordEvolution(
      r.proposal.base_version,
      r.proposal.target_version,
      'healthy',
      backup.dir,
      r.proposal.request,
    );
    this.verified(r, `${r.proposal.base_version} → ${r.proposal.target_version} verified`);
    this.cleanupWorktree(r);
  }

  /** Revert the evolution's commits on production (history is never rewritten). */
  private revertCore(r: EvolutionRecord): void {
    const src = this.o.source!;
    git(src.repo, [
      '-c',
      'user.name=ModuleX System Evolution',
      '-c',
      'user.email=evolution@modulex.invalid',
      'revert',
      '--no-edit',
      `${r.core!.base_commit}..${gitHead(src.repo, r.core!.branch)}`,
    ]);
  }

  private verified(r: EvolutionRecord, detail: string): void {
    r.deployment!.verified = true;
    r.status = 'SUCCESS';
    this.stage(r, 'verify', 'done', detail);
    this.o.audit.append('evolution_verified', 'studio', { evolution_id: r.evolution_id, detail });
  }

  private markRolledBack(r: EvolutionRecord, by: string, reason: string): void {
    r.status = 'ROLLED_BACK';
    r.rollback = { at: this.now().toISOString(), by, reason };
    this.stage(r, 'health_check', 'failed', reason);
    this.o.audit.append('evolution_rolled_back', by, { evolution_id: r.evolution_id, reason });
  }

  /** §20 — roll back a deployed evolution. Always audited. */
  rollback(id: string, actor: Actor, reason: string): EvolutionRecord {
    const r = this.get(id);
    if (r.status !== 'SUCCESS' || !r.deployment)
      throw fail(
        'INVALID_ARGUMENTS',
        `Evolution is ${r.status}; only deployed evolutions roll back.`,
        'Check studio_evolution_history.',
        'FAILED',
      );
    if (actor !== 'owner-ui' && (r.review?.confirmation_required || isProtected(r.proposal.affected_components)))
      throw fail(
        'APPROVAL_NOT_OWNER',
        'Protected evolutions are rolled back by the owner.',
        'Use System → Updates → Roll Back.',
      );
    if (r.config) {
      this.o.config.rollback(r.config.doc, r.config.base_version, actor, reason);
      this.o.audit.append('config_rolled_back', actor, {
        evolution_id: id,
        doc: r.config.doc,
        to_version: r.config.base_version,
      });
    } else if (r.extension) {
      const x = r.extension;
      if (x.is_update_of) this.o.extensions.activate(x.name, x.is_update_of);
      else this.o.extensions.setEnabled(x.name, false);
      this.o.audit.append('extension_rolled_back', actor, {
        evolution_id: id,
        name: x.name,
        to: x.is_update_of ?? 'disabled',
      });
    } else if (r.core) {
      this.revertCore(r);
      this.o.updates?.recordEvolution(
        r.proposal.target_version,
        r.proposal.base_version,
        'healthy',
        r.deployment.backup?.dir ?? null,
        `rollback: ${reason}`,
      );
    }
    this.markRolledBack(r, actor, reason);
    this.save();
    return r;
  }

  // ================================================================ helpers

  private cleanupWorktree(r: EvolutionRecord): void {
    if (!r.core || !this.o.source) return;
    try {
      git(this.o.source.repo, ['worktree', 'remove', '--force', r.core.worktree]);
    } catch {
      /* already gone */
    }
  }

  private syntheticTest(gate: TestResult['gate'], passed: boolean, output: string, started: number): TestResult {
    return {
      gate,
      command: 'studio-internal',
      passed,
      counts: null,
      duration_ms: Math.max(0, Date.now() - started),
      output_tail: this.o.redactor.redact(output),
    };
  }

  private stage(r: EvolutionRecord, stage: EvolutionStage, status: StageRecord['status'], detail: string): void {
    r.stages = r.stages.filter((s) => s.stage !== stage);
    r.stages.push({ stage, status, at: this.now().toISOString(), detail: this.o.redactor.redact(detail) });
    r.updated_at = this.now().toISOString();
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true });
    const f = join(this.root, 'history.json');
    writeFileSync(`${f}.tmp`, JSON.stringify([...this.records.values()], null, 2), 'utf-8');
    renameSync(`${f}.tmp`, f);
  }
}

export type { RiskLevel };
