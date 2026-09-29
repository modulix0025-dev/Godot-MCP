// SPDX-License-Identifier: Apache-2.0
//
// Extensions, Skills, workflows and provider adapters (Execution Patch 2 §9–13). An extension is a versioned,
// declarative package with a manifest (`modulex-extension.json`) that states what it provides, what it needs,
// which permissions it asks for, and under which licence it ships.
//
// Safety model:
//   - Extensions installed through the registry are DECLARATIVE: Skills (Markdown + JSON), workflow definitions
//     (JSON), provider configurations for built-in adapter families, and UI panels described as JSON. Core never
//     loads extension JavaScript into its process and the UI never executes remote code.
//   - Anything that needs new executable code (a new adapter family, a new exporter) is a CORE change and goes
//     through the System Evolution patch pipeline, where a human-reviewable diff is tested and approved.
//   - Permissions are granted explicitly. High-risk permissions are never granted by default (§10); forbidden
//     permissions (secrets, filesystem outside the project, policy) make the manifest invalid.
import { z } from 'zod';
import { LicenseFactSchema } from './provenance.js';

export const EXTENSION_KINDS = [
  'skill',
  'workflow',
  'provider',
  'build_adapter',
  'asset_processor',
  'exporter',
  'ui_panel',
  'mcp_adapter',
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** Permission catalogue. `forbidden` permissions can never be granted to an extension. */
export const PERMISSIONS = {
  'project:read': { risk: 'LOW', forbidden: false, summary: 'Read project manifests and assets.' },
  'project:write-assets': { risk: 'MEDIUM', forbidden: false, summary: 'Write under res://assets/generated/.' },
  'worker:submit-jobs': { risk: 'MEDIUM', forbidden: false, summary: 'Submit jobs to TRUSTED workers (cost-gated).' },
  'ui:panel': { risk: 'LOW', forbidden: false, summary: 'Render a declarative panel in the Studio.' },
  'tools:register': { risk: 'HIGH', forbidden: false, summary: 'Expose new studio_* tools to agents.' },
  'network:egress': { risk: 'HIGH', forbidden: false, summary: 'Reach the hosts listed in `network_hosts`.' },
  'llm:call': { risk: 'MEDIUM', forbidden: false, summary: 'Use a configured LLM provider (cost-gated).' },
  'secrets:read': { risk: 'CRITICAL', forbidden: true, summary: 'Read credentials — never granted.' },
  'fs:outside-project': { risk: 'CRITICAL', forbidden: true, summary: 'Filesystem outside the project — never.' },
  'policy:modify': { risk: 'CRITICAL', forbidden: true, summary: 'Change policy/approvals — never.' },
  'process:execute': { risk: 'CRITICAL', forbidden: true, summary: 'Run processes — core change only.' },
} as const;
export type Permission = keyof typeof PERMISSIONS;
const PERMISSION_IDS = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'semantic version, e.g. 1.2.0');
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lower-case id, e.g. hunyuan3d-character');
/** A path inside the extension package: relative, no `..`, no URL scheme (no remote code). */
const packagePath = z
  .string()
  .min(1)
  .refine((p) => !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), {
    message: 'entrypoints must be files inside the package (no URLs, absolute paths or ..)',
  });

export const ExtensionManifestSchema = z
  .object({
    name,
    version: semver,
    display_name: z.string().min(1),
    description: z.string().min(1),
    kinds: z.array(z.enum(EXTENSION_KINDS)).min(1),
    /** Compatible ModuleX Game Studio versions, e.g. ">=0.1.0 <1.0.0" or "^0.2.0". */
    modulex: z.string().min(1),
    permissions: z.array(z.enum(PERMISSION_IDS)),
    network_hosts: z.array(z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i)).default([]),
    dependencies: z.array(z.object({ name, range: z.string().min(1) }).strict()).default([]),
    license: z.object({ spdx: z.string().min(1), commercial_use: LicenseFactSchema.shape.commercial_use }).strict(),
    author: z.string().min(1),
    entrypoints: z.record(z.enum(EXTENSION_KINDS), z.array(packagePath).min(1)),
    /** sha256 of each packaged file, keyed by package path; verified on install. */
    files: z.record(packagePath, z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const k of Object.keys(m.entrypoints)) {
      if (!m.kinds.includes(k as ExtensionKind))
        ctx.addIssue({ code: 'custom', path: ['entrypoints', k], message: `entrypoint for undeclared kind '${k}'` });
    }
    for (const list of Object.values(m.entrypoints))
      for (const p of list ?? [])
        if (!(p in m.files))
          ctx.addIssue({ code: 'custom', path: ['files'], message: `entrypoint '${p}' has no sha256 in files` });
    if (m.permissions.includes('network:egress') && m.network_hosts.length === 0)
      ctx.addIssue({ code: 'custom', path: ['network_hosts'], message: 'network:egress requires network_hosts' });
  });
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// ---------------------------------------------------------------- versions

export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semantic version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** Minimal semver range check: space-separated comparators (>=, >, <=, <, =), ^x.y.z, ~x.y.z, *, exact. */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === '*' || r === '') return true;
  return r.split(/\s+/).every((c) => {
    const caret = /^\^(\d+\.\d+\.\d+)$/.exec(c);
    if (caret) {
      const [maj, min] = parseSemver(caret[1]!)!;
      const upper = maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
      return compareSemver(version, caret[1]!) >= 0 && compareSemver(version, upper) < 0;
    }
    const tilde = /^~(\d+\.\d+\.\d+)$/.exec(c);
    if (tilde) {
      const [maj, min] = parseSemver(tilde[1]!)!;
      return compareSemver(version, tilde[1]!) >= 0 && compareSemver(version, `${maj}.${min + 1}.0`) < 0;
    }
    const cmp = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(c);
    if (!cmp) throw new Error(`unsupported range comparator '${c}'`);
    const d = compareSemver(version, cmp[2]!);
    switch (cmp[1] ?? '=') {
      case '>=':
        return d >= 0;
      case '<=':
        return d <= 0;
      case '>':
        return d > 0;
      case '<':
        return d < 0;
      default:
        return d === 0;
    }
  });
}

// ---------------------------------------------------------------- review

export interface ExtensionReview {
  ok: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  problems: string[];
  /** Permissions granted if the owner approves without ticking anything extra (low/medium only). */
  default_grants: Permission[];
  /** Permissions the owner must tick individually. */
  needs_explicit_grant: Permission[];
  license_ok: boolean;
  compatible: boolean;
}

/**
 * Inspect a manifest before anything is installed (§9, §29). Pure: file hashes and dependency resolution are
 * checked by Core against the actual package and registry.
 */
export function reviewExtension(
  manifest: unknown,
  studioVersion: string,
  installed: Record<string, string> = {},
): ExtensionReview {
  const parsed = ExtensionManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return {
      ok: false,
      risk: 'CRITICAL',
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`),
      default_grants: [],
      needs_explicit_grant: [],
      license_ok: false,
      compatible: false,
    };
  }
  const m = parsed.data;
  const problems: string[] = [];
  const forbidden = m.permissions.filter((p) => PERMISSIONS[p].forbidden);
  for (const p of forbidden) problems.push(`requests forbidden permission '${p}'`);
  let compatible = false;
  try {
    compatible = satisfies(studioVersion, m.modulex);
  } catch (e) {
    problems.push(`modulex range: ${(e as Error).message}`);
  }
  if (!compatible) problems.push(`not compatible with ModuleX Game Studio ${studioVersion} (needs ${m.modulex})`);
  const license_ok = m.license.commercial_use === 'allowed' || m.license.commercial_use === 'conditional';
  if (!license_ok)
    problems.push(
      `licence ${m.license.spdx} commercial use is '${m.license.commercial_use}' — blocked (see asset provenance)`,
    );
  for (const d of m.dependencies) {
    const have = installed[d.name];
    if (!have) problems.push(`missing dependency ${d.name} ${d.range}`);
    else if (!satisfies(have, d.range)) problems.push(`dependency ${d.name} ${have} does not satisfy ${d.range}`);
  }
  const allowed = m.permissions.filter((p) => !PERMISSIONS[p].forbidden);
  const default_grants = allowed.filter((p) => PERMISSIONS[p].risk === 'LOW' || PERMISSIONS[p].risk === 'MEDIUM');
  const needs_explicit_grant = allowed.filter((p) => PERMISSIONS[p].risk === 'HIGH');
  const risk = forbidden.length
    ? 'CRITICAL'
    : needs_explicit_grant.length || m.kinds.includes('mcp_adapter')
      ? 'HIGH'
      : m.kinds.some((k) => k !== 'ui_panel')
        ? 'MEDIUM'
        : 'LOW';
  return { ok: problems.length === 0, risk, problems, default_grants, needs_explicit_grant, license_ok, compatible };
}

// ---------------------------------------------------------------- registries

/** One installed version of an extension; older versions are kept for rollback. */
export const InstalledExtensionSchema = z
  .object({
    name,
    active_version: semver,
    versions: z.array(semver).min(1),
    enabled: z.boolean(),
    kinds: z.array(z.enum(EXTENSION_KINDS)),
    source: z.enum(['builtin', 'local', 'registry']),
    license: z.string(),
    granted_permissions: z.array(z.enum(PERMISSION_IDS)),
    installed_at: z.string(),
    updated_at: z.string(),
    health: z.enum(['healthy', 'degraded', 'failing', 'unknown']),
    last_error: z.string().nullable(),
  })
  .strict();
export type InstalledExtension = z.infer<typeof InstalledExtensionSchema>;

/** Skill registry row (§10) — a view over installed extensions of kind `skill`. */
export interface SkillView {
  name: string;
  version: string;
  source: InstalledExtension['source'];
  license: string;
  permissions: Permission[];
  tools_required: string[];
  last_update: string;
  health: InstalledExtension['health'];
  enabled: boolean;
}

export const WORKFLOW_KINDS = ['comfyui', 'build', 'qa', 'game_generation', 'export'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

/** §11 — a versioned workflow definition. The graph itself (e.g. ComfyUI API JSON) lives beside it. */
export const WorkflowDefinitionSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9_]+\.[a-z0-9_-]+$/, 'e.g. 3D_CHARACTER.hunyuan3d2'),
    version: semver,
    kind: z.enum(WORKFLOW_KINDS),
    description: z.string().min(1),
    inputs: z.record(
      z.string(),
      z.object({ type: z.enum(['string', 'number', 'image', 'mesh', 'seed']), required: z.boolean() }).strict(),
    ),
    outputs: z.record(
      z.string(),
      z.object({ type: z.enum(['image', 'mesh_glb', 'texture', 'archive', 'report']) }).strict(),
    ),
    dependencies: z.object({ models: z.array(z.string()), custom_nodes: z.array(z.string()) }).strict(),
    worker_capabilities: z.array(z.string()).min(1),
    cost_profile: z.object({ est_gpu_seconds: z.number().nonnegative(), est_usd: z.number().nonnegative() }).strict(),
    timeout_s: z.number().int().positive().max(7200),
    retry_policy: z
      .object({ max_attempts: z.number().int().min(1).max(5), backoff_s: z.number().nonnegative() })
      .strict(),
    validation: z
      .object({
        output_checks: z.array(z.enum(['glb_magic', 'png_magic', 'nonempty', 'triangle_budget', 'provenance'])),
      })
      .strict(),
    license_facts: z.array(LicenseFactSchema).min(1),
    graph: packagePath,
    /** Phase 7 execution fields (ComfyUI). Input name → `<nodeId>.inputs.<field>` in the API graph. */
    bindings: z.record(z.string(), z.string().regex(/^[^.\s]+\.inputs\.[A-Za-z0-9_]+$/)).optional(),
    /** Output name → the node that reports it and the history `ui` key it appears under. */
    output_nodes: z
      .record(z.string(), z.object({ node: z.string().min(1), ui_key: z.enum(['images', '3d']) }).strict())
      .optional(),
    /** What the workflow really produces (a mesh-only workflow never claims texture/rig/animation). */
    produces: z.array(z.enum(['mesh', 'texture', 'material', 'rig', 'animation', 'image'])).optional(),
    /** Node classes the worker must have (checked against /object_info before submission). */
    required_nodes: z.array(z.string().min(1)).optional(),
    min_vram_gb: z.number().nonnegative().optional(),
    /** VERIFIED only after a real generation on a real worker; UNVERIFIED workflows never run production jobs. */
    verification: z
      .object({ status: z.enum(['UNVERIFIED', 'VERIFIED']), evidence: z.string().nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const PROVIDER_ADAPTER_KINDS = ['llm', 'tts', 'image', 'video', '3d', 'comfyui', 'build', 'storage'] as const;
export type ProviderAdapterKind = (typeof PROVIDER_ADAPTER_KINDS)[number];

/**
 * Built-in adapter families (code that ships with Core). A provider EXTENSION configures one of these; a new family
 * is a core change. Keeps "add another provider" a configuration-level change in the common case (§12).
 */
export const ADAPTER_FAMILIES = {
  anthropic: { kinds: ['llm'], builtin: true },
  'openai-compatible-http': { kinds: ['llm', 'image', 'tts'], builtin: true },
  'comfyui-http': { kinds: ['comfyui', 'image', '3d', 'video'], builtin: true },
  'local-build': { kinds: ['build'], builtin: true },
  'filesystem-storage': { kinds: ['storage'], builtin: true },
} as const satisfies Record<string, { kinds: readonly ProviderAdapterKind[]; builtin: boolean }>;
export type AdapterFamily = keyof typeof ADAPTER_FAMILIES;

export const ProviderDefinitionSchema = z
  .object({
    id: name,
    version: semver,
    kind: z.enum(PROVIDER_ADAPTER_KINDS),
    family: z.enum(Object.keys(ADAPTER_FAMILIES) as [AdapterFamily, ...AdapterFamily[]]),
    display_name: z.string().min(1),
    /** Non-secret settings only (base URL, model ids). Credentials are referenced, never embedded. */
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    secret_ref: z.string().startsWith('secret://').nullable(),
    models: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!(ADAPTER_FAMILIES[p.family].kinds as readonly string[]).includes(p.kind))
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `adapter family '${p.family}' does not serve '${p.kind}'`,
      });
    for (const [k, v] of Object.entries(p.settings))
      if (typeof v === 'string' && /(key|secret|token|password)/i.test(k))
        ctx.addIssue({
          code: 'custom',
          path: ['settings', k],
          message: 'credentials go in secret_ref, never in settings',
        });
  });
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

/** §13 — a declarative UI panel. Rendered by the Studio from data; no scripts, no remote URLs. */
export const UiPanelSchema = z
  .object({
    id: name,
    title: z.string().min(1),
    placement: z.enum(['system', 'project', 'settings', 'dashboard']),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string() }).strict(),
          z.object({ type: z.literal('kv'), source: z.string().regex(/^studio_[a-z_]+$/) }).strict(),
          z
            .object({
              type: z.literal('table'),
              source: z.string().regex(/^studio_[a-z_]+$/),
              columns: z.array(z.string()),
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();
export type UiPanel = z.infer<typeof UiPanelSchema>;
