// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  bootDecision,
  classifyRequest,
  componentsForFiles,
  CONFIG_DOCS,
  decide,
  DEFAULT_CONFIG,
  DEV_MODE_OFF,
  isProtected,
  jsonDiff,
  migrationPath,
  MigrationSchema,
  patchGuard,
  PolicyConfigSchema,
  ProviderDefinitionSchema,
  projectCompatibility,
  requiredGates,
  reviewExtension,
  riskFloor,
  satisfies,
  stricterMode,
  UiPanelSchema,
  UpdateSettingsSchema,
  WorkflowDefinitionSchema,
  type ExtensionManifest,
  type InstallState,
  type VersionSet,
} from '../src/index.js';

const H = 'a'.repeat(64);

export const skillManifest = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  name: 'level-layout-skill',
  version: '1.0.0',
  display_name: 'Level layout',
  description: 'Teaches the Level Designer role a grid layout technique.',
  kinds: ['skill'],
  modulex: '>=0.1.0 <1.0.0',
  permissions: ['project:read'],
  network_hosts: [],
  dependencies: [],
  license: { spdx: 'MIT', commercial_use: 'allowed' },
  author: 'ModuleX',
  entrypoints: { skill: ['SKILL.md'] },
  files: { 'SKILL.md': H },
  ...over,
});

describe('request classification (§32)', () => {
  it.each([
    ['ضيف دعم لموديل جديد.', 'PROVIDER', 'extension'],
    ['اعمل workflow جديد.', 'WORKFLOW', 'extension'],
    ['صلح مشكلة الـComfyUI worker.', 'BUGFIX', 'core'],
    ['غير سياسة الـapproval بحيث العمليات دي تبقى Auto.', 'CONFIG', 'config'],
    ['ثبت إضافة جديدة.', 'EXTENSION', 'extension'],
    ['Add a new dashboard section.', 'CORE_CHANGE', 'core'],
    ['Change the database schema for builds', 'CORE_CHANGE', 'core'],
  ])('%s → %s', (text, category, mode) => {
    const c = classifyRequest(text);
    expect(c.category).toBe(category);
    expect(c.mode).toBe(mode);
  });

  it('keeps the more controlled mode when the agent and Core disagree', () => {
    expect(stricterMode('config', 'core')).toBe('core');
    expect(stricterMode('extension', 'config')).toBe('extension');
  });
});

describe('risk and protected controls (§19, §25, §26, §33)', () => {
  it('maps files to components and computes a risk floor', () => {
    expect(componentsForFiles(['studio/app/ui/src/x.tsx'])).toEqual(['ui']);
    expect(riskFloor(['ui'], ['source_code'])).toBe('MEDIUM');
    expect(riskFloor(['ui'], [])).toBe('LOW');
    expect(riskFloor(['providers'], ['source_code'])).toBe('HIGH');
    expect(riskFloor(['ui'], ['schema_migration'])).toBe('CRITICAL');
  });

  it.each([
    'studio/shared/src/policy.ts',
    'studio/core/src/gateway/gateway.ts',
    'studio/core/src/audit/audit-log.ts',
    'studio/app/src-tauri/src/credentials.rs',
    'studio/core/src/evolution/updates.ts',
    'studio/core/src/evolution/checkpoint.ts',
    'studio/core/src/server.ts',
  ])('%s is a protected control → CRITICAL', (f) => {
    const c = componentsForFiles([f]);
    expect(isProtected(c)).toBe(true);
    expect(riskFloor(c, ['source_code'])).toBe('CRITICAL');
  });

  it('test gates scale with risk', () => {
    expect(requiredGates('LOW', 'config')).toEqual(['static']);
    expect(requiredGates('MEDIUM', 'core')).toEqual(['static', 'unit', 'integration']);
    expect(requiredGates('CRITICAL', 'core')).toContain('security');
    expect(requiredGates('CRITICAL', 'core')).toContain('e2e');
  });
});

describe('patch guard (§17)', () => {
  const diff = (body: string) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n${body}\n`;
  it('passes an ordinary patch', () => {
    expect(patchGuard(diff('+const a = 1;\n-const a = 0;'))).toEqual([]);
  });
  it('catches removed audit calls, skipped tests, deleted tests, hard-coded credentials and 0.0.0.0', () => {
    expect(patchGuard(diff("-    this.audit.append('x', 'y', {});"))).toContain('removes 1 audit log call(s)');
    expect(patchGuard(diff("+it.skip('works', () => {});"))).toContain('skips or disables tests');
    expect(
      patchGuard('diff --git a/studio/core/tests/a.test.ts b/studio/core/tests/a.test.ts\ndeleted file mode 100644\n'),
    ).toContain('deletes a test file: studio/core/tests/a.test.ts');
    expect(patchGuard(diff("+const apiKey = 'sk-live-1234567890';"))).toContain('adds a hard-coded credential');
    expect(patchGuard(diff("+server.listen(80, '0.0.0.0')"))).toContain('exposes a service on all interfaces');
  });
});

describe('extensions (§9–10, §29)', () => {
  it('accepts a declarative skill and grants only low/medium permissions by default', () => {
    const r = reviewExtension(skillManifest(), '0.1.0', {});
    expect(r.ok).toBe(true);
    expect(r.default_grants).toEqual(['project:read']);
    expect(r.needs_explicit_grant).toEqual([]);
  });

  it('never grants high-risk permissions automatically', () => {
    const r = reviewExtension(
      skillManifest({
        permissions: ['project:read', 'tools:register', 'network:egress'],
        network_hosts: ['api.example.com'],
      }),
      '0.1.0',
    );
    expect(r.ok).toBe(true);
    expect(r.risk).toBe('HIGH');
    expect(r.default_grants).toEqual(['project:read']);
    expect(r.needs_explicit_grant).toEqual(['tools:register', 'network:egress']);
  });

  it('rejects forbidden permissions, bad licences, incompatible versions and missing dependencies', () => {
    expect(reviewExtension(skillManifest({ permissions: ['secrets:read'] }), '0.1.0').problems).toContain(
      "requests forbidden permission 'secrets:read'",
    );
    expect(
      reviewExtension(skillManifest({ license: { spdx: 'CC-BY-NC-4.0', commercial_use: 'forbidden' } }), '0.1.0').ok,
    ).toBe(false);
    expect(reviewExtension(skillManifest({ modulex: '^2.0.0' }), '0.1.0').compatible).toBe(false);
    expect(
      reviewExtension(skillManifest({ dependencies: [{ name: 'base-skill', range: '^1.0.0' }] }), '0.1.0').problems,
    ).toContain('missing dependency base-skill ^1.0.0');
  });

  it('refuses remote or escaping entrypoints (no remote code)', () => {
    for (const bad of ['https://cdn.example.com/x.js', '../../etc/passwd', '/abs/x.md']) {
      const r = reviewExtension(skillManifest({ entrypoints: { skill: [bad] }, files: { [bad]: H } }), '0.1.0');
      expect(r.ok).toBe(false);
    }
  });

  it('semver ranges', () => {
    expect(satisfies('0.2.3', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfies('1.4.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
  });
});

describe('workflows, providers, UI panels (§11–13)', () => {
  const wf = {
    id: '3D_CHARACTER.stylized_v2',
    version: '1.0.0',
    kind: 'comfyui',
    description: 'Stylised 3D character from a reference image.',
    inputs: { reference: { type: 'image', required: true }, seed: { type: 'seed', required: false } },
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
  it('validates a workflow definition', () => {
    expect(WorkflowDefinitionSchema.safeParse(wf).success).toBe(true);
    expect(WorkflowDefinitionSchema.safeParse({ ...wf, worker_capabilities: [] }).success).toBe(false);
  });
  it('providers configure built-in adapter families and never embed credentials', () => {
    const p = {
      id: 'local-llm',
      version: '1.0.0',
      kind: 'llm',
      family: 'openai-compatible-http',
      display_name: 'Local LLM',
      settings: { base_url: 'http://127.0.0.1:8080/v1' },
      secret_ref: null,
      models: ['qwen3'],
    };
    expect(ProviderDefinitionSchema.safeParse(p).success).toBe(true);
    expect(ProviderDefinitionSchema.safeParse({ ...p, settings: { api_key: 'sk-123456789' } }).success).toBe(false);
    expect(ProviderDefinitionSchema.safeParse({ ...p, kind: 'storage' }).success).toBe(false);
  });
  it('UI panels are declarative data only', () => {
    expect(
      UiPanelSchema.safeParse({
        id: 'gpu-costs',
        title: 'GPU costs',
        placement: 'dashboard',
        blocks: [{ type: 'kv', source: 'studio_worker_status' }],
      }).success,
    ).toBe(true);
    expect(
      UiPanelSchema.safeParse({
        id: 'x-panel',
        title: 'x',
        placement: 'dashboard',
        blocks: [{ type: 'script', src: 'https://x/y.js' }],
      }).success,
    ).toBe(false);
  });
});

describe('configuration documents (§2 Mode A, §28)', () => {
  it('every default document validates', () => {
    for (const [id, doc] of Object.entries(CONFIG_DOCS))
      expect(doc.schema.safeParse(DEFAULT_CONFIG[id as keyof typeof DEFAULT_CONFIG]).success, id).toBe(true);
  });
  it('policy can auto-approve destructive/cost studio tools, but never raw, critical or evolution tools', () => {
    expect(
      PolicyConfigSchema.safeParse({ auto_approve: [{ tool: 'studio_asset_delete', projects: '*' }] }).success,
    ).toBe(true);
    for (const tool of [
      'node-delete',
      'studio_secret_set',
      'studio_evolution_deploy',
      'studio_extension_install',
      'studio_ping',
    ])
      expect(PolicyConfigSchema.safeParse({ auto_approve: [{ tool, projects: '*' }] }).success, tool).toBe(false);
  });
  it('update settings never allow automatic installs', () => {
    expect(UpdateSettingsSchema.parse({})).toEqual({
      channel: 'stable',
      check_automatically: false,
      install_automatically: false,
    });
    expect(UpdateSettingsSchema.safeParse({ install_automatically: true }).success).toBe(false);
  });
  it('jsonDiff shows the exact change', () => {
    expect(jsonDiff({ a: 1, b: [1] }, { a: 2, b: [1, 2], c: true })).toEqual([
      { path: '/a', op: 'replace', from: 1, to: 2 },
      { path: '/b/1', op: 'add', to: 2 },
      { path: '/c', op: 'add', to: true },
    ]);
  });
});

describe('policy hardening', () => {
  const ctx = (caller: 'modulex-agent' | 'claude-desktop') => ({
    caller,
    devMode: DEV_MODE_OFF,
    alwaysAllow: new Set(['studio_asset_delete', 'studio_evolution_rollback', 'studio_extension_enable']),
  });
  it('"always allow" applies to the ModuleX Agent, never to Claude Desktop', () => {
    expect(decide('studio_asset_delete', ctx('modulex-agent')).effect).toBe('allow');
    expect(decide('studio_asset_delete', ctx('claude-desktop')).effect).toBe('ask');
  });
  it('protected evolution tools always ask, whatever the overrides', () => {
    expect(decide('studio_evolution_rollback', ctx('modulex-agent')).effect).toBe('ask');
    expect(decide('studio_extension_enable', ctx('modulex-agent')).effect).toBe('ask');
  });
  it('Claude Desktop sees system status only from the evolution family', () => {
    expect(decide('studio_system_status', ctx('claude-desktop')).effect).toBe('allow');
    expect(decide('studio_evolution_propose', ctx('claude-desktop')).effect).toBe('deny');
  });
});

describe('versions, updates, migrations, Safe Mode (§8, §14–16, §21)', () => {
  const app: VersionSet = {
    studio: '0.2.0',
    schema: 2,
    godot: '4.5.1',
    addons: { godot_mcp: '0.1.0', modulex_studio: '0.1.0' },
    worker_protocol: 1,
    workflows: {},
  };
  const stamp = {
    studio_version: '0.2.0',
    schema: 2,
    godot_version: '4.5.1',
    addon_versions: { godot_mcp: '0.1.0', modulex_studio: '0.1.0' },
    workflow_pins: {},
  };
  it('never modifies a project silently', () => {
    expect(projectCompatibility(stamp, app).status).toBe('compatible');
    expect(projectCompatibility({ ...stamp, schema: 1 }, app).status).toBe('upgrade_required');
    expect(projectCompatibility({ ...stamp, schema: 3 }, app).status).toBe('read_only');
    expect(projectCompatibility({ ...stamp, studio_version: '0.9.0' }, app).status).toBe('read_only');
  });
  it('migration paths are contiguous and every migration names a rollback', () => {
    const ms = [
      MigrationSchema.parse({
        id: 'm0001_builds_profile',
        from_schema: 1,
        to_schema: 2,
        description: 'x',
        rollback: 'restore_backup',
      }),
      MigrationSchema.parse({
        id: 'm0002_workflow_pins',
        from_schema: 2,
        to_schema: 3,
        description: 'y',
        rollback: 'restore_backup',
      }),
    ];
    expect(migrationPath(ms, 1, 3).map((m) => m.id)).toEqual(['m0001_builds_profile', 'm0002_workflow_pins']);
    expect(() => migrationPath(ms, 1, 4)).toThrow(/no migration from schema 3/);
    expect(
      MigrationSchema.safeParse({
        id: 'm0003_x',
        from_schema: 1,
        to_schema: 3,
        description: 'z',
        rollback: 'restore_backup',
      }).success,
    ).toBe(false);
  });
  it('Safe Mode after a failed health check, repeated failed boots or crashing extensions', () => {
    const s: InstallState = {
      current: '0.2.0',
      previous: '0.1.0',
      last_known_good: '0.1.0',
      pending_health_check: false,
      failed_boots: 0,
      crashing_extensions: [],
      history: [],
    };
    expect(bootDecision(s).mode).toBe('normal');
    expect(bootDecision({ ...s, pending_health_check: true })).toMatchObject({ mode: 'safe', use_version: '0.1.0' });
    expect(bootDecision({ ...s, failed_boots: 2 }).mode).toBe('safe');
    expect(bootDecision({ ...s, crashing_extensions: ['bad-ext'] }).mode).toBe('safe');
    expect(bootDecision(s, true).mode).toBe('safe');
  });
});
