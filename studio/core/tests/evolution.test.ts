// SPDX-License-Identifier: Apache-2.0
//
// Execution Patch 2 — System Evolution, end to end on real files and a real git repository:
//   §27 scenario 1  new 3D-character workflow (sandbox, schema, test job, output validation, approval, deploy, verify)
//   §28 scenario 2  approval policy change (exact diff, risk, owner approval, versioned write, verify, audit)
//   §29 scenario 3  extension install (manifest, permissions, licence, deps, sandbox, tests, approval, rollback)
//   §3/§7/§17/§33   core patch pipeline (worktree sandbox, test gates, diff-bound approval, checkpoint, deploy,
//                   health check, automatic revert, patch guard, protected controls)
//   §8, §15, §20–21 migrations, updates + rollback, Safe Mode; §24 diagnostics.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, DEV_MODE_OFF, loadCompat, type ReleaseManifest, type WorkerRecord } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { git } from '../src/evolution/git.js';
import { migrateJsonFile } from '../src/evolution/migrations.js';
import { createSystem, type SystemServices } from '../src/evolution/system.js';
import type { SourceWorkspace, WorkflowTester } from '../src/evolution/evolution-service.js';
import { UpdateManager, type UpdatePlatform } from '../src/evolution/updates.js';
import { startCore, type CoreServer } from '../src/server.js';
import { StudioStore } from '../src/store/studio-store.js';
import { STUDIO_VERSIONS } from '../src/version.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const node = (code: string) => ({ cmd: [process.execPath, '-e', code] });
const PASS = node("console.log(' Tests  3 passed (3)')");
const FAIL = node("console.log(' Tests  1 failed | 2 passed (3)'); process.exit(1)");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mx-evo-'));
}

/** Write a package into <data>/extensions/incoming/<dir>, computing the file hashes. */
function writePackage(
  dataDir: string,
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const root = join(dataDir, 'extensions', 'incoming', dir);
  mkdirSync(root, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
    hashes[rel] = sha(content);
  }
  writeFileSync(join(root, 'modulex-extension.json'), JSON.stringify({ ...manifest, files: hashes }, null, 2));
}

const skillManifest = (version: string, over: Record<string, unknown> = {}) => ({
  name: 'level-layout-skill',
  version,
  display_name: 'Level layout',
  description: 'Grid-based level layout technique for the Level Designer role.',
  kinds: ['skill'],
  modulex: '>=0.1.0 <1.0.0',
  permissions: ['project:read'],
  network_hosts: [],
  dependencies: [],
  license: { spdx: 'MIT', commercial_use: 'allowed' },
  author: 'ModuleX',
  entrypoints: { skill: ['SKILL.md'] },
  ...over,
});
const SKILL_MD =
  '---\nname: level-layout\ntools: studio_scene_create, studio_project_validate\n---\n\n# Level layout\nLay levels out on a 4 m grid.\n';

const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  worker_id: 'remote-gpu-01',
  kind: 'comfyui',
  provider: 'vastai',
  location: 'eu-west',
  base_url: 'https://gpu-01.internal.example.net',
  transport: 'https-auth-proxy',
  secret_ref: 'secret://worker/remote-gpu-01/token',
  gpu: 'RTX 5090',
  comfy_version: '0.37.0',
  vram_gb: 32,
  capabilities: ['3d', 'image'],
  auth_status: 'ok',
  last_health_at: '2026-09-29T10:00:00Z',
  trust: 'TRUSTED',
  failure_count: 0,
  cost_class: 'medium',
  onboarding: {} as WorkerRecord['onboarding'],
  quarantine_reason: null,
  ...over,
});

const WORKFLOW = {
  id: '3D_CHARACTER.stylized_v2',
  version: '1.0.0',
  kind: 'comfyui',
  description: 'Stylised 3D character from a reference image.',
  inputs: { reference: { type: 'image', required: true } },
  outputs: { mesh: { type: 'mesh_glb' } },
  dependencies: { models: ['hunyuan3d-dit-v2-0'], custom_nodes: ['ComfyUI-Hunyuan3DWrapper'] },
  worker_capabilities: ['3d'],
  cost_profile: { est_gpu_seconds: 240, est_usd: 0.04 },
  timeout_s: 900,
  retry_policy: { max_attempts: 2, backoff_s: 30 },
  validation: { output_checks: ['glb_magic', 'nonempty', 'provenance'] },
  license_facts: [
    {
      subject: 'model:hunyuan3d-dit-v2-0',
      license: 'tencent-hunyuan-community',
      commercial_use: 'conditional',
      recorded_by: 'workflow-registry',
    },
  ],
  graph: 'workflow.api.json',
};
const workflowPackage = (dataDir: string, dir: string, version: string) =>
  writePackage(
    dataDir,
    dir,
    {
      name: 'stylized-character-workflow',
      version,
      display_name: 'Stylised characters',
      description: 'A 3D character workflow.',
      kinds: ['workflow'],
      modulex: '^0.1.0',
      permissions: ['worker:submit-jobs', 'project:write-assets'],
      network_hosts: [],
      dependencies: [],
      license: { spdx: 'Apache-2.0', commercial_use: 'allowed' },
      author: 'ModuleX',
      entrypoints: { workflow: ['workflow.json'] },
    },
    {
      'workflow.json': JSON.stringify({ ...WORKFLOW, version }),
      'workflow.api.json': JSON.stringify({ '1': { class_type: 'LoadImage' } }),
    },
  );

const glbTester = (
  bytes = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 1)]),
): WorkflowTester & { calls: number } => {
  const t = {
    calls: 0,
    async run() {
      t.calls++;
      return { bytes, filename: 'test.glb' };
    },
  };
  return t;
};

interface Env {
  dataDir: string;
  audit: AuditLog;
  store: StudioStore;
  sys: SystemServices;
}

function env(extra: { source?: SourceWorkspace; tester?: WorkflowTester; forceSafeMode?: boolean } = {}): Env {
  const dataDir = tmp();
  const redactor = new Redactor();
  const audit = new AuditLog(redactor);
  const store = new StudioStore();
  const sys = createSystem({
    dataDir,
    studioVersion: '0.1.0',
    versions: STUDIO_VERSIONS,
    audit,
    redactor,
    store,
    source: extra.source,
    workflowTester: extra.tester,
    forceSafeMode: extra.forceSafeMode,
  });
  return { dataDir, audit, store, sys };
}

describe('versions', () => {
  it('Core reports the same versions as studio/compat.json', () => {
    const compat = loadCompat(resolve(__dirname, '../../compat.json'));
    expect(STUDIO_VERSIONS.studio).toBe(compat.studioVersion);
    expect(STUDIO_VERSIONS.godot).toBe(compat.godot.version);
    expect(STUDIO_VERSIONS.schema).toBe(compat.dbSchema);
    expect(STUDIO_VERSIONS.addons).toEqual(compat.addon);
  });
});

describe('§28 scenario 2 — "change the approval policy so these operations become Auto"', () => {
  it('shows the exact diff and risk, needs owner approval + typed confirmation, writes a new version, verifies, audits', async () => {
    const { sys, audit } = env();
    const before = sys.config.get('policy');
    const r = sys.evolution.proposeConfig({
      doc: 'policy',
      value: {
        auto_approve: [{ tool: 'studio_asset_delete', projects: ['space-kid-journey'] }],
        cost_threshold_usd: 0.25,
        approval_ttl_minutes: 30,
      },
      reason: 'غير سياسة الـapproval بحيث العمليات دي تبقى Auto.',
      by: 'modulex-agent',
    });
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(r.proposal.risk).toBe('CRITICAL');
    expect(r.review!.changes).toEqual([
      'add /auto_approve/0: null → {"tool":"studio_asset_delete","projects":["space-kid-journey"]}',
    ]);
    expect(r.review!.confirmation_required).toBe(true);
    // Nothing changed yet: no silent policy change.
    expect(sys.config.get('policy').version).toBe(before.version);

    // The agent cannot approve, and cannot deploy before (or after) approval.
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'modulex-agent', diff_sha256: r.review!.diff_sha256 }),
    ).toThrow(/Only the owner/);
    await expect(sys.evolution.deploy(r.evolution_id, 'modulex-agent')).rejects.toThrow(/only owner-approved/);
    // CRITICAL: the owner must type the evolution id.
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 }),
    ).toThrow(/type the evolution id/);
    sys.evolution.decide(r.evolution_id, 'approve', {
      actor: 'owner-ui',
      diff_sha256: r.review!.diff_sha256,
      confirm: r.evolution_id,
    });
    await expect(sys.evolution.deploy(r.evolution_id, 'modulex-agent')).rejects.toThrow(/never by an agent/);
    const done = await sys.evolution.deploy(r.evolution_id, 'owner-ui');
    expect(done.status).toBe('SUCCESS');
    expect(sys.config.get('policy').version).toBe(before.version + 1);
    expect(audit.list({ type: 'config_changed' })).toHaveLength(1);
    expect(sys.config.history('policy')).toHaveLength(2); // the previous version is kept

    // Rollback writes the old value again as a NEW version and is audited.
    sys.evolution.rollback(r.evolution_id, 'owner-ui', 'changed my mind');
    expect(sys.config.get('policy').value).toEqual(before.value);
    expect(sys.config.get('policy').version).toBe(before.version + 2);
    expect(audit.list({ type: 'config_rolled_back' })).toHaveLength(1);
  });

  it('refuses a policy that auto-approves raw, critical or evolution tools (before any approval)', () => {
    const { sys } = env();
    const r = sys.evolution.proposeConfig({
      doc: 'policy',
      value: {
        auto_approve: [
          { tool: 'studio_evolution_deploy', projects: '*' },
          { tool: 'node-delete', projects: '*' },
        ],
      },
      reason: 'make everything automatic',
      by: 'modulex-agent',
    });
    expect(r.status).toBe('TESTS_FAILED');
    expect(r.problems.join('\n')).toMatch(/cannot be auto-approved/);
  });

  it('a stale approval (the document changed meanwhile) is not applied', async () => {
    const { sys } = env();
    const mk = (t: number) =>
      sys.evolution.proposeConfig({
        doc: 'budgets',
        value: { monthly_usd: t, per_project_usd: 20, gpu_hour_cap: 10 },
        reason: 'budget',
        by: 'owner-ui',
      });
    const a = mk(80);
    const b = mk(90);
    for (const r of [a, b])
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 });
    expect((await sys.evolution.deploy(a.evolution_id, 'owner-ui')).status).toBe('SUCCESS');
    const second = await sys.evolution.deploy(b.evolution_id, 'owner-ui');
    expect(second.status).toBe('FAILED');
    expect(second.problems.join()).toMatch(/changed .* since the proposal/);
  });
});

describe('§29 scenario 3 — "install a new extension"', () => {
  it('inspects, sandboxes, tests, asks the owner, installs, verifies, updates and rolls back', async () => {
    const { sys, dataDir, audit } = env();
    writePackage(dataDir, 'layout-1.0.0', skillManifest('1.0.0', { permissions: ['project:read', 'tools:register'] }), {
      'SKILL.md': SKILL_MD,
    });
    const r = await sys.evolution.proposeExtension({ package: 'layout-1.0.0', by: 'modulex-agent' });
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(r.proposal.risk).toBe('HIGH'); // tools:register is high-risk
    expect(r.extension!.review.default_grants).toEqual(['project:read']);
    expect(r.extension!.review.needs_explicit_grant).toEqual(['tools:register']);
    expect(r.review!.changes).toContain('? permission tools:register (owner must tick)');
    // Staged in the sandbox, not live.
    expect(existsSync(join(r.workspace, 'extension', 'SKILL.md'))).toBe(true);
    expect(sys.extensions.list()).toHaveLength(0);

    // Owner approves WITHOUT ticking tools:register → it is not granted.
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 });
    await expect(sys.evolution.deploy(r.evolution_id, 'modulex-agent')).rejects.toThrow(/never by an agent/); // HIGH
    const done = await sys.evolution.deploy(r.evolution_id, 'owner-ui');
    expect(done.status).toBe('SUCCESS');
    expect(sys.extensions.get('level-layout-skill')!.granted_permissions).toEqual(['project:read']);
    expect(sys.extensions.skills()[0]).toMatchObject({
      name: 'level-layout-skill',
      version: '1.0.0',
      tools_required: ['studio_scene_create', 'studio_project_validate'],
      enabled: true,
      health: 'healthy',
    });

    // Update to 1.1.0 (MEDIUM: the agent may deploy after owner approval), then roll back to 1.0.0.
    writePackage(dataDir, 'layout-1.1.0', skillManifest('1.1.0'), { 'SKILL.md': `${SKILL_MD}\nv1.1\n` });
    const u = await sys.evolution.proposeExtension({
      package: 'layout-1.1.0',
      by: 'modulex-agent',
      expectKind: 'skill',
    });
    expect(u.extension!.is_update_of).toBe('1.0.0');
    sys.evolution.decide(u.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: u.review!.diff_sha256 });
    expect((await sys.evolution.deploy(u.evolution_id, 'modulex-agent')).status).toBe('SUCCESS');
    expect(sys.extensions.get('level-layout-skill')!.active_version).toBe('1.1.0');
    sys.evolution.rollback(u.evolution_id, 'modulex-agent', 'regression in layouts');
    expect(sys.extensions.get('level-layout-skill')!.active_version).toBe('1.0.0');
    expect(audit.list({ type: 'extension_rolled_back' })).toHaveLength(1);
  });

  it.each([
    [
      'a tampered file',
      (d: string) => {
        writePackage(d, 'p', skillManifest('1.0.0'), { 'SKILL.md': SKILL_MD });
        writeFileSync(join(d, 'extensions', 'incoming', 'p', 'SKILL.md'), `${SKILL_MD} tampered`);
      },
      /sha256 mismatch/,
    ],
    [
      'a forbidden permission',
      (d: string) =>
        writePackage(d, 'p', skillManifest('1.0.0', { permissions: ['secrets:read'] }), { 'SKILL.md': SKILL_MD }),
      /forbidden permission/,
    ],
    [
      'a non-commercial licence',
      (d: string) =>
        writePackage(
          d,
          'p',
          skillManifest('1.0.0', { license: { spdx: 'CC-BY-NC-4.0', commercial_use: 'forbidden' } }),
          { 'SKILL.md': SKILL_MD },
        ),
      /commercial use/,
    ],
    [
      'a missing dependency',
      (d: string) =>
        writePackage(d, 'p', skillManifest('1.0.0', { dependencies: [{ name: 'base-skill', range: '^1.0.0' }] }), {
          'SKILL.md': SKILL_MD,
        }),
      /missing dependency/,
    ],
    [
      'executable adapter code',
      (d: string) =>
        writePackage(
          d,
          'p',
          skillManifest('1.0.0', { kinds: ['mcp_adapter'], entrypoints: { mcp_adapter: ['index.js'] } }),
          { 'index.js': 'process.exit(1)' },
        ),
      /core change/,
    ],
  ])('blocks %s before anything is staged', async (_n, make, why) => {
    const { sys, dataDir } = env();
    make(dataDir);
    const r = await sys.evolution.proposeExtension({ package: 'p', by: 'modulex-agent' });
    expect(r.status).toBe('BLOCKED');
    expect(r.problems.join('\n')).toMatch(why);
    expect(existsSync(join(r.workspace, 'extension'))).toBe(false);
  });

  it('agents can only install from the owner-managed incoming folder', async () => {
    const { sys } = env();
    await expect(sys.evolution.proposeExtension({ package: '../../etc', by: 'modulex-agent' })).rejects.toThrow(
      /incoming/,
    );
  });
});

describe('§27 scenario 1 — "add support for a new 3D-character workflow"', () => {
  it('registers in the sandbox, validates, runs a test job on a TRUSTED worker, validates the GLB, deploys and verifies', async () => {
    const tester = glbTester();
    const { sys, dataDir, store, audit } = env({ tester });
    store.putWorker(worker());
    workflowPackage(dataDir, 'wf-1.0.0', '1.0.0');
    const r = await sys.evolution.proposeExtension({
      package: 'wf-1.0.0',
      by: 'modulex-agent',
      expectKind: 'workflow',
    });
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(tester.calls).toBe(1);
    expect(r.extension!.workflow_test).toMatchObject({
      worker_id: 'remote-gpu-01',
      checks: ['glb_magic', 'nonempty', 'provenance'],
    });
    expect(r.tests.map((t) => [t.gate, t.passed])).toEqual([
      ['static', true],
      ['integration', true],
    ]);
    // Not live before approval.
    expect(sys.extensions.workflows()).toHaveLength(0);
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 });
    const done = await sys.evolution.deploy(r.evolution_id, 'modulex-agent'); // MEDIUM, not protected
    expect(done.status).toBe('SUCCESS');
    expect(done.deployment!.verified).toBe(true);
    expect(sys.extensions.resolveWorkflow(null, '3D_CHARACTER.stylized_v2')).toEqual({
      version: '1.0.0',
      pinned: false,
    });
    expect(audit.list({ type: 'workflow_registered' })).toHaveLength(1);
    expect(sys.evolution.history()[0]).toMatchObject({
      status: 'SUCCESS',
      requested_by: 'modulex-agent',
      authored_by: 'ai',
    });

    // Version pinning: a production project stays on 1.0.0 while 1.1.0 becomes active.
    sys.extensions.pinWorkflow('space-kid-journey', '3D_CHARACTER.stylized_v2', '1.0.0');
    workflowPackage(dataDir, 'wf-1.1.0', '1.1.0');
    const u = await sys.evolution.proposeExtension({
      package: 'wf-1.1.0',
      by: 'modulex-agent',
      expectKind: 'workflow',
    });
    sys.evolution.decide(u.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: u.review!.diff_sha256 });
    await sys.evolution.deploy(u.evolution_id, 'modulex-agent');
    expect(sys.extensions.resolveWorkflow(null, '3D_CHARACTER.stylized_v2')!.version).toBe('1.1.0');
    expect(sys.extensions.resolveWorkflow('space-kid-journey', '3D_CHARACTER.stylized_v2')).toEqual({
      version: '1.0.0',
      pinned: true,
    });
  });

  it('is BLOCKED (not SUCCESS) without a TRUSTED worker offering the capability', async () => {
    const { sys, dataDir, store } = env({ tester: glbTester() });
    store.putWorker(worker({ trust: 'QUARANTINED' }));
    workflowPackage(dataDir, 'wf', '1.0.0');
    const r = await sys.evolution.proposeExtension({ package: 'wf', by: 'modulex-agent' });
    expect(r.status).toBe('BLOCKED');
    expect(r.problems.join()).toMatch(/no TRUSTED worker offers capabilities \[3d\]/);
  });

  it('fails the gate when the generated asset is not a GLB', async () => {
    const { sys, dataDir, store } = env({ tester: glbTester(Buffer.from('<html>error</html>')) });
    store.putWorker(worker());
    workflowPackage(dataDir, 'wf', '1.0.0');
    const r = await sys.evolution.proposeExtension({ package: 'wf', by: 'modulex-agent' });
    expect(r.status).toBe('TESTS_FAILED');
    expect(r.problems.join()).toMatch(/failed glb_magic/);
  });
});

// ---------------------------------------------------------------- core patch pipeline on a real git repository

function productionRepo(): string {
  const repo = tmp();
  const g = (args: string[]) => git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git(repo, ['init', '-q', '-b', 'modulex/production']);
  mkdirSync(join(repo, 'studio/app/ui/src'), { recursive: true });
  mkdirSync(join(repo, 'studio/core/src/audit'), { recursive: true });
  mkdirSync(join(repo, 'studio/shared/src'), { recursive: true });
  writeFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), "export const sections = ['overview'];\n");
  writeFileSync(
    join(repo, 'studio/core/src/audit/log.ts'),
    "export function f(audit) {\n  audit.append('x', 'y', {});\n}\n",
  );
  writeFileSync(join(repo, 'studio/shared/src/policy.ts'), 'export const x = 1;\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'base']);
  return repo;
}

function source(repo: string, over: Partial<SourceWorkspace> = {}): SourceWorkspace {
  return {
    repo,
    productionBranch: 'modulex/production',
    gates: {
      static: [PASS],
      unit: [PASS],
      integration: [PASS],
      security: [PASS],
      packaging: [PASS],
      self_test: [PASS],
      e2e: [PASS],
    },
    healthCheck: [PASS],
    verify: [PASS],
    ...over,
  };
}

const PATCH_UI = `diff --git a/studio/app/ui/src/dashboard.ts b/studio/app/ui/src/dashboard.ts
--- a/studio/app/ui/src/dashboard.ts
+++ b/studio/app/ui/src/dashboard.ts
@@ -1 +1 @@
-export const sections = ['overview'];
+export const sections = ['overview', 'gpu-costs'];
`;

describe('§3 core evolution — sandbox → tests → diff → owner approval → checkpoint → deploy → health → verify', () => {
  it('deploys an approved MEDIUM UI change and can roll it back (history is never rewritten)', async () => {
    const repo = productionRepo();
    const { sys, audit } = env({ source: source(repo) });
    const base = git(repo, ['rev-parse', 'HEAD']).trim();
    const r = sys.evolution.propose({ request: 'Add a new dashboard section for GPU costs.', by: 'modulex-agent' });
    expect(r.proposal.classification).toBe('core');
    sys.evolution.plan(r.evolution_id, { plan: 'Add a gpu-costs section', patch: PATCH_UI, by: 'modulex-agent' });
    // Production untouched while the sandbox holds the change.
    expect(readFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), 'utf-8')).not.toContain('gpu-costs');
    expect(r.proposal.affected_components).toEqual(['ui']);
    expect(r.proposal.risk).toBe('MEDIUM');
    expect(r.proposal.tests).toEqual(['static', 'unit', 'integration']);
    sys.evolution.test(r.evolution_id, 'modulex-agent');
    expect(r.tests.every((t) => t.passed)).toBe(true);
    expect(r.tests[0]!.counts).toEqual({ passed: 3, failed: 0, skipped: 0 });
    const review = sys.evolution.requestReview(r.evolution_id, 'modulex-agent');
    expect(review).toMatchObject({
      version_transition: { from: '0.1.0', to: '0.2.0' },
      files: { modified: 1, added: 0, deleted: 0 },
      risk: 'MEDIUM',
      guard_violations: [],
      confirmation_required: false,
      rollback: { available: true },
    });
    expect(review.tests.passed).toBe(9);
    // The agent's "approve" tool only submits; approval is the owner's.
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'modulex-agent', diff_sha256: review.diff_sha256 }),
    ).toThrow();
    // An approval for a different diff is refused.
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: 'f'.repeat(64) }),
    ).toThrow(/differs/);
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: review.diff_sha256 });
    const done = await sys.evolution.deploy(r.evolution_id, 'modulex-agent');
    expect(done.status).toBe('SUCCESS');
    expect(readFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), 'utf-8')).toContain('gpu-costs');
    expect(git(repo, ['tag', '--list', 'mx-evo-cp/*']).trim()).toBe(`mx-evo-cp/${r.evolution_id}`);
    expect(git(repo, ['rev-parse', `mx-evo-cp/${r.evolution_id}`]).trim()).toBe(base);
    expect(sys.updates.getState()).toMatchObject({ current: '0.2.0', previous: '0.1.0', last_known_good: '0.2.0' });
    for (const t of [
      'evolution_proposed',
      'evolution_planned',
      'evolution_tested',
      'evolution_review_requested',
      'evolution_approved',
      'evolution_checkpoint_created',
      'evolution_deployed',
      'evolution_health_check',
      'evolution_verified',
    ] as const)
      expect(audit.list({ type: t }).length, t).toBeGreaterThan(0);

    // §23: the changelog comes only from what was deployed (the real commit subject), never invented.
    expect(sys.evolution.changelog()).toMatch(
      /^## 0\.2\.0\n- [0-9a-f]{7,} Add a new dashboard section for GPU costs\. \[evo_[a-z0-9-]+, ModuleX Agent\]$/,
    );

    sys.evolution.rollback(r.evolution_id, 'modulex-agent', 'owner prefers the old dashboard');
    expect(sys.evolution.changelog()).toContain('(rolled back)');
    expect(readFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), 'utf-8')).not.toContain('gpu-costs');
    expect(git(repo, ['log', '--format=%s', '-1']).trim()).toMatch(/^Revert/);
    expect(git(repo, ['merge-base', '--is-ancestor', base, 'HEAD']) === '').toBe(true); // base still in history
  });

  it('a failed health check reverts production automatically (ROLLED_BACK, not SUCCESS)', async () => {
    const repo = productionRepo();
    const { sys } = env({ source: source(repo, { healthCheck: [FAIL] }) });
    const r = sys.evolution.propose({ request: 'Add a new dashboard section.', by: 'owner-ui' });
    sys.evolution.plan(r.evolution_id, { plan: 'x', patch: PATCH_UI, by: 'owner-ui' });
    sys.evolution.test(r.evolution_id, 'owner-ui');
    const review = sys.evolution.requestReview(r.evolution_id, 'owner-ui');
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: review.diff_sha256 });
    const done = await sys.evolution.deploy(r.evolution_id, 'owner-ui');
    expect(done.status).toBe('ROLLED_BACK');
    expect(readFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), 'utf-8')).not.toContain('gpu-costs');
    expect(sys.updates.getState().current).toBe('0.1.0');
  });

  it('failing tests stop the pipeline before review', () => {
    const repo = productionRepo();
    const { sys } = env({ source: source(repo, { gates: { static: [PASS], unit: [FAIL], integration: [PASS] } }) });
    const r = sys.evolution.propose({ request: 'Add a new dashboard section.', by: 'modulex-agent' });
    sys.evolution.plan(r.evolution_id, { plan: 'x', patch: PATCH_UI, by: 'modulex-agent' });
    sys.evolution.test(r.evolution_id, 'modulex-agent');
    expect(r.status).toBe('TESTS_FAILED');
    expect(r.tests.map((t) => t.gate)).toEqual(['static', 'unit']); // fail fast
    expect(() => sys.evolution.requestReview(r.evolution_id, 'modulex-agent')).toThrow(/nothing to submit|not passed/);
  });

  it('a patch that removes audit logging is BLOCKED by the patch guard, whatever is approved', () => {
    const repo = productionRepo();
    const { sys } = env({ source: source(repo) });
    const r = sys.evolution.propose({ request: 'Speed up logging.', by: 'modulex-agent' });
    sys.evolution.plan(r.evolution_id, {
      plan: 'drop audit',
      by: 'modulex-agent',
      patch: `diff --git a/studio/core/src/audit/log.ts b/studio/core/src/audit/log.ts
--- a/studio/core/src/audit/log.ts
+++ b/studio/core/src/audit/log.ts
@@ -1,3 +1,2 @@
 export function f(audit) {
-  audit.append('x', 'y', {});
 }
`,
    });
    sys.evolution.test(r.evolution_id, 'modulex-agent');
    const review = sys.evolution.requestReview(r.evolution_id, 'modulex-agent');
    expect(review.guard_violations).toContain('removes 1 audit log call(s)');
    expect(r.status).toBe('BLOCKED');
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', {
        actor: 'owner-ui',
        diff_sha256: review.diff_sha256,
        confirm: r.evolution_id,
      }),
    ).toThrow(/Evolution is BLOCKED/);
  });

  it('protected controls: CRITICAL, all gates, typed confirmation, owner-only deploy', async () => {
    const repo = productionRepo();
    const { sys } = env({ source: source(repo) });
    const r = sys.evolution.propose({ request: 'Refactor the policy gateway to add a tier.', by: 'modulex-agent' });
    sys.evolution.plan(r.evolution_id, {
      plan: 'x',
      by: 'modulex-agent',
      patch: `diff --git a/studio/shared/src/policy.ts b/studio/shared/src/policy.ts
--- a/studio/shared/src/policy.ts
+++ b/studio/shared/src/policy.ts
@@ -1 +1 @@
-export const x = 1;
+export const x = 2;
`,
    });
    expect(r.proposal.risk).toBe('CRITICAL');
    expect(r.proposal.affected_components).toEqual(['policy_gateway']);
    expect(r.proposal.tests).toEqual(['static', 'unit', 'integration', 'security', 'packaging', 'self_test', 'e2e']);
    sys.evolution.test(r.evolution_id, 'modulex-agent');
    const review = sys.evolution.requestReview(r.evolution_id, 'modulex-agent');
    expect(review.security.protected_components).toEqual(['policy_gateway']);
    expect(() =>
      sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: review.diff_sha256 }),
    ).toThrow(/type the evolution id/);
    sys.evolution.decide(r.evolution_id, 'approve', {
      actor: 'owner-ui',
      diff_sha256: review.diff_sha256,
      confirm: r.evolution_id,
    });
    await expect(sys.evolution.deploy(r.evolution_id, 'modulex-agent')).rejects.toThrow(/never by an agent/);
    expect((await sys.evolution.deploy(r.evolution_id, 'owner-ui')).status).toBe('SUCCESS');
    expect(() => sys.evolution.rollback(r.evolution_id, 'modulex-agent', 'x')).toThrow(/owner/);
  });

  it('a change made after approval voids the approval', async () => {
    const repo = productionRepo();
    const { sys } = env({ source: source(repo) });
    const r = sys.evolution.propose({ request: 'Add a new dashboard section.', by: 'modulex-agent' });
    sys.evolution.plan(r.evolution_id, { plan: 'x', patch: PATCH_UI, by: 'modulex-agent' });
    sys.evolution.test(r.evolution_id, 'modulex-agent');
    const review = sys.evolution.requestReview(r.evolution_id, 'modulex-agent');
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: review.diff_sha256 });
    const wt = r.core!.worktree;
    writeFileSync(join(wt, 'studio/app/ui/src/dashboard.ts'), "export const sections = ['sneaky'];\n");
    git(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'sneak']);
    await expect(sys.evolution.deploy(r.evolution_id, 'owner-ui')).rejects.toThrow(/modified after approval/);
    expect(readFileSync(join(repo, 'studio/app/ui/src/dashboard.ts'), 'utf-8')).not.toContain('sneaky');
  });

  it('without a source workspace, core evolutions are honestly BLOCKED', () => {
    const { sys } = env();
    const r = sys.evolution.propose({ request: 'صلح مشكلة الـComfyUI worker.', by: 'modulex-agent' });
    expect(r.proposal.category).toBe('BUGFIX');
    expect(r.proposal.target_version).toBe('0.1.1');
    expect(r.status).toBe('BLOCKED');
  });

  it("the agent's classification is ignored when it is less controlled than the Studio's", () => {
    const { sys } = env();
    const r = sys.evolution.propose({
      request: 'Change the database schema for builds',
      category: 'CONFIG',
      by: 'modulex-agent',
    });
    expect(r.proposal.classification).toBe('core');
  });
});

// ---------------------------------------------------------------- updates, migrations, Safe Mode, diagnostics

function fakePlatform(over: Partial<UpdatePlatform> = {}) {
  const bytes = Buffer.from('installer-0.2.0');
  const log: string[] = [];
  const p: UpdatePlatform & { log: string[] } = {
    log,
    fetchFeed: async () => [
      {
        version: '0.2.0',
        channel: 'stable',
        notes: 'n',
        url: 'https://updates.example/0.2.0',
        sha256: sha(bytes),
        signature: 'sig',
        min_schema: 1,
        target_schema: 1,
        migrations: [],
      },
      {
        version: '0.3.0',
        channel: 'beta',
        notes: 'b',
        url: 'https://updates.example/0.3.0',
        sha256: sha(bytes),
        signature: 'sig',
        min_schema: 1,
        target_schema: 1,
        migrations: [],
      },
    ],
    download: async () => bytes,
    verifySignature: async () => true,
    backup: async (l) => (log.push(`backup:${l}`), `bk-${l}`),
    install: async () => void log.push('install'),
    migrate: async () => void log.push('migrate'),
    healthCheck: async () => ({ ok: true, detail: 'ok' }),
    restore: async (b) => void log.push(`restore:${b}`),
    ...over,
  };
  return p;
}

describe('§14–15, §20 updates', () => {
  const mgr = () => new UpdateManager(join(tmp(), 'install-state.json'), '0.1.0', new AuditLog(new Redactor()));
  it('Stable sees Stable only; Beta sees Beta', async () => {
    const m = mgr();
    expect((await m.check(fakePlatform(), 'stable'))!.version).toBe('0.2.0');
    expect((await m.check(fakePlatform(), 'beta'))!.version).toBe('0.3.0');
  });
  it('verify → backup → install → migrate → health → healthy; then the owner can roll back', async () => {
    const m = mgr();
    const p = fakePlatform();
    const r = (await m.check(p, 'stable')) as ReleaseManifest;
    const out = await m.apply(p, r, 'owner-ui');
    expect(out).toMatchObject({
      status: 'SUCCESS',
      steps: ['check', 'download', 'verify', 'backup', 'install', 'migrate', 'health_check', 'mark_healthy'],
    });
    expect(m.getState()).toMatchObject({ current: '0.2.0', previous: '0.1.0', last_known_good: '0.2.0' });
    await m.rollback(p, 'owner-ui', 'crash on export');
    expect(m.getState().current).toBe('0.1.0');
    expect(p.log).toContain('restore:bk-update-0.1.0-to-0.2.0');
  });
  it('a checksum or signature failure stops before anything is installed', async () => {
    const m = mgr();
    const bad = fakePlatform({ download: async () => Buffer.from('tampered') });
    const out = await m.apply(bad, (await m.check(bad, 'stable'))!, 'owner-ui');
    expect(out).toMatchObject({ status: 'FAILED', failed_step: 'verify' });
    expect(bad.log).toEqual([]);
    const unsigned = fakePlatform({ verifySignature: async () => false });
    expect(await m.apply(unsigned, (await m.check(unsigned, 'stable'))!, 'owner-ui')).toMatchObject({
      status: 'FAILED',
      failed_step: 'verify',
    });
  });
  it('a failed health check rolls back automatically', async () => {
    const m = mgr();
    const p = fakePlatform({ healthCheck: async () => ({ ok: false, detail: 'Core did not start' }) });
    const out = await m.apply(p, (await m.check(p, 'stable'))!, 'owner-ui');
    expect(out).toMatchObject({ status: 'ROLLED_BACK', failed_step: 'health_check' });
    expect(p.log.at(-1)).toBe('restore:bk-update-0.1.0-to-0.2.0');
    expect(m.getState()).toMatchObject({ current: '0.1.0', pending_health_check: false });
  });
});

describe('§21 Safe Mode', () => {
  it('disables non-core extensions without touching the saved choice', async () => {
    const { sys, dataDir } = env();
    writePackage(dataDir, 'p', skillManifest('1.0.0'), { 'SKILL.md': SKILL_MD });
    const r = await sys.evolution.proposeExtension({ package: 'p', by: 'owner-ui' });
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 });
    await sys.evolution.deploy(r.evolution_id, 'owner-ui');
    const safe = createSystem({
      dataDir,
      studioVersion: '0.1.0',
      versions: STUDIO_VERSIONS,
      audit: new AuditLog(new Redactor()),
      redactor: new Redactor(),
      store: new StudioStore(),
      forceSafeMode: true,
    });
    expect(safe.safeMode.active).toBe(true);
    expect(safe.extensions.list()[0]).toMatchObject({ enabled: true, effective_enabled: false });
  });
});

describe('§8 migrations', () => {
  const steps = [
    {
      meta: {
        id: 'm0001_add_profiles',
        from_schema: 1,
        to_schema: 2,
        description: 'x',
        rollback: 'restore_backup' as const,
      },
      up: (d: Record<string, unknown>) => ({ ...d, profiles: [] }),
    },
  ];
  it('backs up, migrates a copy, validates, then applies atomically', () => {
    const f = join(tmp(), 'store.json');
    writeFileSync(f, JSON.stringify({ projects: [] }));
    const audit = new AuditLog(new Redactor());
    const out = migrateJsonFile(
      f,
      steps,
      2,
      (d) => (Array.isArray((d as { profiles?: unknown }).profiles) ? [] : ['profiles missing']),
      audit,
      'owner-ui',
    );
    expect(out.applied).toEqual(['m0001_add_profiles']);
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ projects: [], profiles: [], schema_version: 2 });
    expect(JSON.parse(readFileSync(out.backup, 'utf-8'))).toEqual({ projects: [] });
    expect(audit.list({ type: 'migration_applied' })).toHaveLength(1);
  });
  it('never touches production when the migrated copy is invalid', () => {
    const f = join(tmp(), 'store.json');
    writeFileSync(f, JSON.stringify({ projects: [] }));
    expect(() =>
      migrateJsonFile(f, steps, 2, () => ['always invalid'], new AuditLog(new Redactor()), 'owner-ui'),
    ).toThrow(/production untouched/);
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ projects: [] });
  });
});

describe('§24 diagnostics', () => {
  it('finds a tampered extension, repairs it by disabling, and never applies security repairs', async () => {
    const { sys, dataDir, store } = env();
    store.putWorker(worker({ trust: 'QUARANTINED' }));
    writePackage(dataDir, 'p', skillManifest('1.0.0'), { 'SKILL.md': SKILL_MD });
    const r = await sys.evolution.proposeExtension({ package: 'p', by: 'owner-ui' });
    sys.evolution.decide(r.evolution_id, 'approve', { actor: 'owner-ui', diff_sha256: r.review!.diff_sha256 });
    await sys.evolution.deploy(r.evolution_id, 'owner-ui');
    writeFileSync(join(dataDir, 'extensions', 'level-layout-skill', '1.0.0', 'SKILL.md'), 'changed behind our back');
    const f = await sys.diagnostics.run('modulex-agent');
    const ext = f.find((x) => x.check === 'extensions')!;
    expect(ext.status).toBe('error');
    expect(ext.recommendation).toMatchObject({
      action: 'disable_extension',
      target: 'level-layout-skill',
      security: false,
    });
    expect(f.find((x) => x.check === 'workers')!.recommendation!.security).toBe(true);
    expect(await sys.diagnostics.repair('disable_extension', 'level-layout-skill', 'modulex-agent')).toMatchObject({
      applied: true,
    });
    expect(sys.extensions.get('level-layout-skill')!.enabled).toBe(false);
    expect(await sys.diagnostics.repair('change_policy', null, 'modulex-agent')).toMatchObject({ applied: false });
  });
});

// ---------------------------------------------------------------- MCP surface

describe('§30 System Evolution tools over MCP', () => {
  let core: CoreServer;
  const clients: Client[] = [];
  const mcp = async (token: string) => {
    const c = new Client({ name: 't', version: '0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${core.handshake.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(c);
    return c;
  };
  const out = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;
  const owner = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${core.handshake.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${core.handshake.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);

  beforeEach(async () => {
    core = await startCore({ dataDir: tmp() });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await core.close();
  });

  it('the agent proposes a policy change; the owner approves the exact diff; the gateway enforces the new policy live', async () => {
    const a = await mcp(core.handshake.agentToken);
    const names = (await a.listTools()).tools.map((t) => t.name);
    for (const t of [
      'studio_system_status',
      'studio_evolution_propose',
      'studio_config_propose',
      'studio_extension_install',
      'studio_diagnostics_run',
    ])
      expect(names).toContain(t);
    expect(names.some((n) => /^(git|fs|shell|exec)/.test(n))).toBe(false); // no raw filesystem/process abstraction

    const p = out(
      await a.callTool({
        name: 'studio_config_propose',
        arguments: {
          doc: 'policy',
          value: { auto_approve: [{ tool: 'studio_asset_delete', projects: '*' }] },
          reason: 'owner asked for auto deletes',
        },
      }),
    );
    const data = p.data as { evolution_id: string; status: string; review: { diff_sha256: string } };
    expect(data.status).toBe('AWAITING_APPROVAL');
    // "approve" from the agent only submits for review — and for config it already awaits the owner.
    const again = out(
      await a.callTool({ name: 'studio_evolution_approve', arguments: { evolution_id: data.evolution_id } }),
    );
    expect(again.status).toBe('SUCCESS');
    expect(core.system!.evolution.get(data.evolution_id).status).toBe('AWAITING_APPROVAL');

    // Before: the agent's delete needs approval.
    expect(decide('studio_asset_delete', { caller: 'modulex-agent', devMode: DEV_MODE_OFF }).effect).toBe('ask');
    const decided = await owner(`/evolutions/${data.evolution_id}/decision`, {
      action: 'approve',
      diff_sha256: data.review.diff_sha256,
      confirm: data.evolution_id,
    });
    expect(decided.status).toBe('APPROVED');
    expect((await owner(`/evolutions/${data.evolution_id}/deploy`, {})).status).toBe('SUCCESS');
    expect(core.system!.policy().auto_approve).toEqual([{ tool: 'studio_asset_delete', projects: '*' }]);

    // After: live policy auto-approves for the ModuleX Agent — but never for Claude Desktop.
    await a.callTool({
      name: 'studio_game_create',
      arguments: { spec: (await import('@modulex/shared')).SAMPLE_GAME_SPEC },
    });
    const del = out(
      await a.callTool({
        name: 'studio_asset_delete',
        arguments: { project_id: 'space-kid-journey', all: true, reason: 'reset' },
      }),
    );
    expect(del.status).not.toBe('PENDING_APPROVAL');
    const d = await mcp(core.handshake.claudeDesktopToken);
    const dd = out(
      await d.callTool({
        name: 'studio_asset_delete',
        arguments: { project_id: 'space-kid-journey', all: true, reason: 'reset' },
      }),
    );
    expect(dd.status).toBe('PENDING_APPROVAL');
  });

  it('Claude Desktop sees system status but none of the evolution tools', async () => {
    const d = await mcp(core.handshake.claudeDesktopToken);
    const names = (await d.listTools()).tools.map((t) => t.name);
    expect(names).toContain('studio_system_status');
    expect(
      names.filter((n) => /^studio_(evolution|extension|skill|workflow|provider|config|system_repair)/.test(n)),
    ).toEqual([]);
    // Not registered for Claude Desktop at all: refused by the MCP layer before the gateway (and audited nowhere
    // as a success), and the gateway would deny it too.
    const denied = (await d.callTool({ name: 'studio_evolution_propose', arguments: { request: 'x' } })) as {
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    expect(decide('studio_evolution_propose', { caller: 'claude-desktop', devMode: DEV_MODE_OFF }).effect).toBe('deny');
  });

  it('owner-only System endpoints refuse agent tokens', async () => {
    const r = await fetch(`http://127.0.0.1:${core.handshake.port}/system`, {
      headers: { Authorization: `Bearer ${core.handshake.agentToken}` },
    });
    expect(r.status).toBe(403);
    const s = await owner('/system');
    expect(s).toMatchObject({ versions: { studio: '0.1.0' }, safe_mode: { active: false }, update_channel: 'stable' });
  });
});
