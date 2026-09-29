// SPDX-License-Identifier: Apache-2.0
//
// Extension / Skill / workflow / provider registry (Execution Patch 2 §9–13). Packages are declarative (see
// shared/extensions.ts): Core validates and stores them, never executes them. Every installed version is kept on
// disk so an update can be rolled back; in Safe Mode every non-builtin extension is treated as disabled without
// changing the owner's saved choices.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import {
  compareSemver,
  ExtensionManifestSchema,
  ProviderDefinitionSchema,
  reviewExtension,
  UiPanelSchema,
  WorkflowDefinitionSchema,
  type ExtensionManifest,
  type ExtensionReview,
  type InstalledExtension,
  type Permission,
  type ProviderDefinition,
  type SkillView,
  type WorkflowDefinition,
} from '@modulex/shared';

export const MANIFEST_FILE = 'modulex-extension.json';

export interface Inspection {
  manifest: ExtensionManifest | null;
  review: ExtensionReview;
  /** Package-level problems: hash mismatches, missing files, invalid Skill/workflow/provider/panel content. */
  content_problems: string[];
  is_update_of: string | null;
}

interface State {
  extensions: InstalledExtension[];
  /** project_id → workflow id → pinned version (§11 "a production project can stay on a known-good version"). */
  workflow_pins: Record<string, Record<string, string>>;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Resolve a package-relative path and refuse anything that escapes the package directory. */
function inside(root: string, rel: string): string {
  const p = normalize(join(root, rel));
  const r = relative(root, p);
  if (r.startsWith('..') || r.split(sep).includes('..')) throw new Error(`path escapes the package: ${rel}`);
  return p;
}

export class ExtensionRegistry {
  private state: State = { extensions: [], workflow_pins: {} };
  private safeMode = false;

  constructor(
    /** e.g. %LOCALAPPDATA%\ModuleXGameStudio\extensions */
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const f = join(root, 'registry.json');
    if (existsSync(f)) this.state = JSON.parse(readFileSync(f, 'utf-8')) as State;
  }

  setSafeMode(on: boolean): void {
    this.safeMode = on;
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  list(): (InstalledExtension & { effective_enabled: boolean })[] {
    return this.state.extensions.map((e) => ({ ...e, effective_enabled: this.isActive(e) }));
  }

  get(name: string): InstalledExtension | undefined {
    return this.state.extensions.find((e) => e.name === name);
  }

  installedVersions(): Record<string, string> {
    return Object.fromEntries(this.state.extensions.map((e) => [e.name, e.active_version]));
  }

  private isActive(e: InstalledExtension): boolean {
    return e.enabled && (!this.safeMode || e.source === 'builtin');
  }

  // ------------------------------------------------------------ inspection (§29 steps 1–4)

  inspect(pkgDir: string, studioVersion: string): Inspection {
    const content_problems: string[] = [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(pkgDir, MANIFEST_FILE), 'utf-8'));
    } catch (e) {
      return {
        manifest: null,
        review: reviewExtension(undefined, studioVersion),
        content_problems: [`cannot read ${MANIFEST_FILE}: ${(e as Error).message}`],
        is_update_of: null,
      };
    }
    const review = reviewExtension(raw, studioVersion, this.installedVersions());
    const parsed = ExtensionManifestSchema.safeParse(raw);
    if (!parsed.success) return { manifest: null, review, content_problems, is_update_of: null };
    const m = parsed.data;

    for (const [rel, expected] of Object.entries(m.files)) {
      try {
        const p = inside(pkgDir, rel);
        if (!existsSync(p)) content_problems.push(`missing file ${rel}`);
        else if (sha256(readFileSync(p)) !== expected) content_problems.push(`sha256 mismatch for ${rel}`);
      } catch (e) {
        content_problems.push((e as Error).message);
      }
    }
    if (!content_problems.length) content_problems.push(...this.validateContent(pkgDir, m));

    const existing = this.get(m.name);
    if (existing && existing.versions.includes(m.version))
      content_problems.push(`${m.name} ${m.version} is already installed`);
    if (existing && compareSemver(m.version, existing.active_version) < 0)
      content_problems.push(`${m.version} is older than the active ${existing.active_version}; use rollback instead`);
    return { manifest: m, review, content_problems, is_update_of: existing ? existing.active_version : null };
  }

  /** Kind-specific validation of the declarative content. */
  private validateContent(dir: string, m: ExtensionManifest): string[] {
    const out: string[] = [];
    const json = (rel: string): unknown => JSON.parse(readFileSync(inside(dir, rel), 'utf-8'));
    for (const rel of m.entrypoints.skill ?? []) {
      const text = readFileSync(inside(dir, rel), 'utf-8');
      if (text.trim().length < 20) out.push(`skill ${rel} is empty`);
    }
    for (const rel of m.entrypoints.workflow ?? []) {
      const r = WorkflowDefinitionSchema.safeParse(json(rel));
      if (!r.success) out.push(...r.error.issues.map((i) => `workflow ${rel}: ${i.path.join('.')}: ${i.message}`));
      else if (!(r.data.graph in m.files)) out.push(`workflow ${rel}: graph ${r.data.graph} is not in the package`);
      else {
        try {
          json(r.data.graph);
        } catch {
          out.push(`workflow ${rel}: graph ${r.data.graph} is not valid JSON`);
        }
      }
    }
    for (const rel of m.entrypoints.provider ?? []) {
      const r = ProviderDefinitionSchema.safeParse(json(rel));
      if (!r.success) out.push(...r.error.issues.map((i) => `provider ${rel}: ${i.path.join('.')}: ${i.message}`));
    }
    for (const rel of m.entrypoints.ui_panel ?? []) {
      const r = UiPanelSchema.safeParse(json(rel));
      if (!r.success) out.push(...r.error.issues.map((i) => `ui panel ${rel}: ${i.path.join('.')}: ${i.message}`));
    }
    for (const k of ['build_adapter', 'asset_processor', 'exporter', 'mcp_adapter'] as const)
      if (m.entrypoints[k])
        out.push(
          `'${k}' needs executable code: submit it as a core change through System Evolution, not as an extension`,
        );
    return out;
  }

  // ------------------------------------------------------------ staging + install (sandbox first)

  /** Copy exactly the declared files into a sandbox directory (never the live extensions folder). */
  stage(pkgDir: string, m: ExtensionManifest, sandboxDir: string): void {
    mkdirSync(sandboxDir, { recursive: true });
    copyFileSync(join(pkgDir, MANIFEST_FILE), join(sandboxDir, MANIFEST_FILE));
    for (const rel of Object.keys(m.files)) {
      const dst = inside(sandboxDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(inside(pkgDir, rel), dst);
    }
  }

  /** Promote a staged, owner-approved package to the live registry. Returns the previous active version. */
  install(sandboxDir: string, m: ExtensionManifest, grants: Permission[], source: 'local' | 'registry'): string | null {
    const dest = join(this.root, m.name, m.version);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.incoming`;
    this.stage(sandboxDir, m, tmp);
    renameSync(tmp, dest);
    const at = this.now().toISOString();
    const existing = this.get(m.name);
    const allowedGrants = grants.filter((g) => m.permissions.includes(g));
    if (existing) {
      const previous = existing.active_version;
      existing.versions = [...new Set([...existing.versions, m.version])];
      existing.active_version = m.version;
      existing.granted_permissions = allowedGrants;
      existing.updated_at = at;
      existing.health = 'healthy';
      existing.last_error = null;
      this.save();
      return previous;
    }
    this.state.extensions.push({
      name: m.name,
      active_version: m.version,
      versions: [m.version],
      enabled: true,
      kinds: m.kinds,
      source,
      license: m.license.spdx,
      granted_permissions: allowedGrants,
      installed_at: at,
      updated_at: at,
      health: 'healthy',
      last_error: null,
    });
    this.save();
    return null;
  }

  /** Remove a version that was installed by a failed deployment (used by rollback of a fresh install). */
  uninstall(name: string): void {
    this.state.extensions = this.state.extensions.filter((e) => e.name !== name);
    this.save();
  }

  setEnabled(name: string, enabled: boolean): InstalledExtension {
    const e = this.mustGet(name);
    e.enabled = enabled;
    e.updated_at = this.now().toISOString();
    this.save();
    return e;
  }

  /** Switch the active version (rollback or re-activation). The target must already be installed. */
  activate(name: string, version: string): InstalledExtension {
    const e = this.mustGet(name);
    if (!e.versions.includes(version)) throw new Error(`${name} ${version} is not installed`);
    e.active_version = version;
    e.updated_at = this.now().toISOString();
    this.save();
    return e;
  }

  previousVersion(name: string): string | null {
    const e = this.mustGet(name);
    const sorted = [...e.versions].sort(compareSemver);
    const i = sorted.indexOf(e.active_version);
    return i > 0 ? sorted[i - 1]! : null;
  }

  /** Re-hash the active version on disk; used by health checks and diagnostics. */
  verify(name: string): string[] {
    const e = this.mustGet(name);
    const dir = join(this.root, name, e.active_version);
    const problems: string[] = [];
    let m: ExtensionManifest;
    try {
      m = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8')));
    } catch (err) {
      return [`manifest unreadable: ${(err as Error).message}`];
    }
    for (const [rel, expected] of Object.entries(m.files)) {
      const p = join(dir, rel);
      if (!existsSync(p)) problems.push(`missing ${rel}`);
      else if (sha256(readFileSync(p)) !== expected) problems.push(`modified on disk: ${rel}`);
    }
    e.health = problems.length ? 'failing' : 'healthy';
    e.last_error = problems[0] ?? null;
    this.save();
    return problems;
  }

  // ------------------------------------------------------------ views (§10–12)

  private activeManifest(e: InstalledExtension): { dir: string; m: ExtensionManifest } {
    const dir = join(this.root, e.name, e.active_version);
    return { dir, m: ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8'))) };
  }

  skills(): SkillView[] {
    return this.state.extensions
      .filter((e) => e.kinds.includes('skill'))
      .map((e) => {
        const { dir, m } = this.activeManifest(e);
        const tools = new Set<string>();
        for (const rel of m.entrypoints.skill ?? []) {
          const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, rel), 'utf-8'));
          const line = fm?.[1]?.split('\n').find((l) => l.startsWith('tools:'));
          line
            ?.slice(6)
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .forEach((t) => tools.add(t));
        }
        return {
          name: e.name,
          version: e.active_version,
          source: e.source,
          license: e.license,
          permissions: e.granted_permissions,
          tools_required: [...tools],
          last_update: e.updated_at,
          health: e.health,
          enabled: this.isActive(e),
        };
      });
  }

  /** Active workflow definitions (from enabled extensions), with every installed version listed. */
  workflows(): { definition: WorkflowDefinition; extension: string; versions: string[]; enabled: boolean }[] {
    const out: { definition: WorkflowDefinition; extension: string; versions: string[]; enabled: boolean }[] = [];
    for (const e of this.state.extensions.filter((x) => x.kinds.includes('workflow'))) {
      const { dir, m } = this.activeManifest(e);
      for (const rel of m.entrypoints.workflow ?? [])
        out.push({
          definition: WorkflowDefinitionSchema.parse(JSON.parse(readFileSync(join(dir, rel), 'utf-8'))),
          extension: e.name,
          versions: e.versions,
          enabled: this.isActive(e),
        });
    }
    return out;
  }

  /** The workflow version a project runs: its pin if set, else the active version. */
  resolveWorkflow(projectId: string | null, workflowId: string): { version: string; pinned: boolean } | null {
    const pin = projectId ? this.state.workflow_pins[projectId]?.[workflowId] : undefined;
    const wf = this.workflows().find((w) => w.definition.id === workflowId && w.enabled);
    if (!wf) return null;
    if (pin) return { version: pin, pinned: true };
    return { version: wf.definition.version, pinned: false };
  }

  pinWorkflow(projectId: string, workflowId: string, version: string): void {
    const wf = this.workflows().find((w) => w.definition.id === workflowId);
    if (!wf) throw new Error(`unknown workflow ${workflowId}`);
    if (!wf.versions.includes(version)) throw new Error(`${workflowId} ${version} is not installed`);
    (this.state.workflow_pins[projectId] ??= {})[workflowId] = version;
    this.save();
  }

  providers(): { definition: ProviderDefinition; extension: string; enabled: boolean }[] {
    const out: { definition: ProviderDefinition; extension: string; enabled: boolean }[] = [];
    for (const e of this.state.extensions.filter((x) => x.kinds.includes('provider'))) {
      const { dir, m } = this.activeManifest(e);
      for (const rel of m.entrypoints.provider ?? [])
        out.push({
          definition: ProviderDefinitionSchema.parse(JSON.parse(readFileSync(join(dir, rel), 'utf-8'))),
          extension: e.name,
          enabled: this.isActive(e),
        });
    }
    return out;
  }

  /** Packages waiting in the owner's incoming folder (the only place agents may install from). */
  incoming(): string[] {
    const dir = join(this.root, 'incoming');
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, MANIFEST_FILE)))
          .map((d) => d.name)
      : [];
  }

  incomingDir(pkg: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(pkg)) throw new Error('package must be a folder name inside extensions/incoming');
    return join(this.root, 'incoming', pkg);
  }

  private mustGet(name: string): InstalledExtension {
    const e = this.get(name);
    if (!e) throw new Error(`extension '${name}' is not installed`);
    return e;
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true });
    const f = join(this.root, 'registry.json');
    writeFileSync(`${f}.tmp`, JSON.stringify(this.state, null, 2), 'utf-8');
    renameSync(`${f}.tmp`, f);
  }
}
