// SPDX-License-Identifier: Apache-2.0
//
// Build Service (Phase 10). Exports a generated project and VERIFIES the result — Godot's exit code is never
// trusted alone (D-011: a C# export without a .sln exits 0 and ships no assemblies).
//
//   Windows   `--export-debug|--export-release "Windows Desktop"`; the .exe, .pck and
//             `data_<Assembly>_windows_x86_64/<Assembly>.dll` must exist.
//   Android   needs the Android SDK/JDK configured; otherwise BLOCKED with the missing requirement. APK verified
//             by existence + size; never "device-tested" without a device (build-profiles.md).
//   iOS       on non-macOS hosts: PREPARED — a snapshot bundle (git bundle + export_presets.cfg, no secrets)
//             as ios-prep-<version>.zip. Never reported as a built/signed app (iosStatus()).
//   RELEASE / PREVIEW exports run from a SNAPSHOT (git worktree at a checkpoint) in which the ModulexQa autoload
//             line is removed (D-032), then `distributableViolations` must be empty (no MCP/QA/SignalR/.env).
//
// Output goes under <projectsRoot>/<project>/build-output/<version>/<platform>-<profile>/ (never inside res://
// scanning paths: the exported folder is excluded by export_presets' exclude_filter and .gitignore).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { distributableViolations, iosStatus, type BuildProfile } from '@modulex/shared';
import type { BuildJobs } from './build-workers.js';
import type { StudioDb } from '../db/database.js';
import { git, gitHead } from '../evolution/git.js';
import { godotErrors } from '../project/project-factory.js';

const run = promisify(execFile);

export type Platform = 'windows' | 'android' | 'ios';

export interface BuildRequest {
  projectId: string;
  projectDir: string;
  assembly: string;
  platform: Platform;
  profile: BuildProfile;
  version: string;
}

export interface BuildResult {
  build_id: string;
  platform: Platform;
  profile: BuildProfile;
  /** SIGNED: a signed iOS build returned by a paired macOS build worker (Phase 11). */
  status: 'BUILT' | 'PREPARED' | 'SIGNED' | 'BLOCKED' | 'FAILED';
  artifacts: { path: string; sha256: string; size: number }[];
  errors: string[];
  note: string | null;
  ms: number;
}

export interface BuildServiceOptions {
  godot: string;
  db?: StudioDb | null;
  env?: NodeJS.ProcessEnv;
  /** Android SDK path from editor settings / Setup Assistant; unset → Android is BLOCKED. */
  androidSdk?: string | null;
  now?: () => Date;
  /**
   * Remote build workers (Phase 11). With a paired macOS worker online, iOS is exported and signed there from the
   * prepared snapshot; without one, iOS stays PREPARED. Signing material never leaves the worker.
   */
  remote?: Pick<BuildJobs, 'run'> | null;
  /** The worker-side signing profile NAME used for iOS (Settings → Build). Null → no signed build is attempted. */
  iosSigningProfile?: string | null | (() => string | null);
  /** Pinned Godot version sent to workers (compat.json). */
  godotVersion?: string;
  /** This Godot version's export templates folder (default: Godot's per-user location, D-055). */
  templatesDir?: string;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const PRESET: Record<Platform, string> = { windows: 'Windows Desktop', android: 'Android', ios: 'iOS' };

export interface Requirement {
  id: string;
  ok: boolean;
  detail: string;
}

/** Export-template folder for a Godot version (user data dir; Windows %APPDATA%, Linux XDG, macOS). */
export function exportTemplatesDir(version = '4.5.1.stable.mono', env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return join(env.APPDATA ?? '', 'Godot', 'export_templates', version);
  if (process.platform === 'darwin')
    return join(env.HOME ?? '', 'Library', 'Application Support', 'Godot', 'export_templates', version);
  return join(env.XDG_DATA_HOME ?? join(env.HOME ?? '', '.local', 'share'), 'godot', 'export_templates', version);
}

/**
 * Requirement checks shown BEFORE a build (Phase 10). Secrets are only checked for presence in the environment
 * (resolved just in time from the credential store); they are never read into the result.
 */
export async function buildRequirements(
  platform: Platform,
  profile: BuildProfile,
  o: { androidSdk?: string | null; env?: NodeJS.ProcessEnv; macWorkerOnline?: boolean; templatesDir?: string } = {},
): Promise<Requirement[]> {
  const env = { ...process.env, ...o.env };
  const out: Requirement[] = [];
  const templates = o.templatesDir ?? exportTemplatesDir(undefined, env);
  if (platform === 'windows') {
    const file = join(
      templates,
      profile === 'RELEASE' || profile === 'PREVIEW' ? 'windows_release_x86_64.exe' : 'windows_debug_x86_64.exe',
    );
    out.push({
      id: 'export_templates',
      ok: existsSync(file),
      detail: existsSync(file) ? templates : `missing ${file}`,
    });
  }
  if (platform === 'android') {
    let java = '';
    try {
      const r = await run('java', ['-version'], { env, timeout: 15_000 });
      java = `${r.stdout}${r.stderr}`;
    } catch (e) {
      java = String((e as { stderr?: string }).stderr ?? '');
    }
    const jdk = /version "(\d+)/.exec(java)?.[1];
    out.push({ id: 'jdk17', ok: jdk === '17', detail: jdk ? `JDK ${jdk}` : 'java not found' });
    out.push({
      id: 'android_sdk',
      ok: Boolean(o.androidSdk && existsSync(o.androidSdk)),
      detail: o.androidSdk ?? 'not configured',
    });
    out.push({ id: 'android_templates', ok: existsSync(join(templates, 'android_debug.apk')), detail: templates });
    if (profile === 'RELEASE')
      out.push({
        id: 'release_keystore',
        ok: [
          'GODOT_ANDROID_KEYSTORE_RELEASE_PATH',
          'GODOT_ANDROID_KEYSTORE_RELEASE_USER',
          'GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD',
        ].every((k) => Boolean(env[k])),
        detail: 'from the credential store via environment only; never written to export_presets.cfg',
      });
  }
  if (platform === 'ios')
    out.push({
      id: 'macos_worker',
      ok: Boolean(o.macWorkerOnline),
      detail: o.macWorkerOnline ? 'online' : 'macOS/Xcode build worker required for a signed build',
    });
  return out;
}

export class BuildService {
  constructor(private readonly o: BuildServiceOptions) {}

  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env, ...this.o.env };
    for (const k of Object.keys(env)) if (k.startsWith('GODOT_MCP_') || k === 'MODULEX_QA') delete env[k];
    return env;
  }

  outDir(req: BuildRequest): string {
    return join(req.projectDir, 'build-output', req.version, `${req.platform}-${req.profile.toLowerCase()}`);
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const started = Date.now();
    const build_id = `b_${createHash('sha256').update(`${req.projectId}|${req.platform}|${req.profile}|${req.version}|${started}`).digest('hex').slice(0, 10)}`;
    const base = { build_id, platform: req.platform, profile: req.profile };
    const finish = (r: Omit<BuildResult, 'build_id' | 'platform' | 'profile' | 'ms'>): BuildResult => {
      const res = { ...base, ...r, ms: Date.now() - started };
      this.record(req, res);
      return res;
    };

    if (req.platform === 'ios') {
      const prep = await this.prepareIos(req);
      const remote = this.o.remote;
      const sp = this.o.iosSigningProfile;
      const profile = (typeof sp === 'function' ? sp() : sp) ?? null;
      if (remote && profile) {
        const r = await remote.run({
          idempotencyKey: `${req.projectId}|ios|${req.profile}|${req.version}|${prep.sha256}`,
          projectId: req.projectId,
          platform: 'ios',
          profile: req.profile,
          preset: PRESET.ios,
          version: req.version,
          assembly: req.assembly,
          godotVersion: this.o.godotVersion ?? '4.5.1',
          bundlePath: prep.path,
          signingProfile: profile,
          outDir: join(this.outDir(req), 'signed'),
        });
        const ipa = r.artifacts.find((a) => a.path.endsWith('.ipa'));
        const st = iosStatus({
          preparationDone: true,
          macWorkerOnline: r.status !== 'BLOCKED',
          signedIpaSha256: r.status === 'SUCCEEDED' && r.signed && ipa ? ipa.sha256 : null,
          releaseRequested: req.profile === 'RELEASE',
        });
        if (st.status === 'SIGNED')
          return finish({
            status: 'SIGNED',
            artifacts: [...r.artifacts, prep],
            errors: [],
            note: `SIGNED on build worker ${r.worker_id} (job ${r.job_id})`,
          });
        if (r.status === 'FAILED')
          return finish({
            status: 'FAILED',
            artifacts: [prep],
            errors: [`macOS build worker: ${r.message}`],
            note: `job ${r.job_id}; the prepared snapshot is kept`,
          });
        return finish({
          status: 'PREPARED',
          artifacts: [prep],
          errors: [],
          note: `PREPARED — ${r.status === 'BLOCKED' ? r.message : `worker returned no signed .ipa (${r.status})`}`,
        });
      }
      const st = iosStatus({
        preparationDone: true,
        macWorkerOnline: false,
        signedIpaSha256: null,
        releaseRequested: req.profile === 'RELEASE',
      });
      return finish({
        status: 'PREPARED',
        artifacts: [prep],
        errors: [],
        note:
          st.status === 'BLOCKED'
            ? `PREPARED — ${st.reason}`
            : remote
              ? 'PREPARED — no iOS signing profile selected for the macOS build worker'
              : 'PREPARED — final signed build requires the macOS/Xcode build worker',
      });
    }
    if (req.platform === 'android' && !this.o.androidSdk)
      return finish({
        status: 'BLOCKED',
        artifacts: [],
        errors: ['Android SDK not configured'],
        note: 'Install the Android tools in Setup Assistant (JDK 17 + Android SDK).',
      });

    // Requirement check BEFORE exporting: missing templates are a setup gap (BLOCKED, with the fix), not a failed
    // export — otherwise Godot fails and the D-011 artifact check would blame the C# assemblies instead.
    if (req.platform === 'windows') {
      const t = (
        await buildRequirements('windows', req.profile, { env: this.env(), templatesDir: this.o.templatesDir })
      ).find((r) => r.id === 'export_templates');
      if (t && !t.ok)
        return finish({
          status: 'BLOCKED',
          artifacts: [],
          errors: [`Godot export templates are not installed (${t.detail})`],
          note: 'Install "Export templates 4.5.1 (.NET)" in the Setup Assistant, then resume.',
        });
    }

    const distributable = req.profile === 'RELEASE' || req.profile === 'PREVIEW';
    const source = distributable ? this.releaseSnapshot(req) : req.projectDir;
    const out = this.outDir(req);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const file = req.platform === 'windows' ? `${req.assembly}.exe` : `${req.assembly}.apk`;
    const target = join(out, file);
    let log = '';
    try {
      const r = await run(
        this.o.godot,
        [
          '--headless',
          '--path',
          source,
          distributable ? '--export-release' : '--export-debug',
          PRESET[req.platform],
          target,
        ],
        { env: this.env(), timeout: 1_800_000, maxBuffer: 64 << 20 },
      );
      log = `${r.stdout}\n${r.stderr}`;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      log = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`;
    } finally {
      if (source !== req.projectDir) this.dropSnapshot(req, source);
    }
    // The log stays OUTSIDE the distributable folder (logs/<platform>-<profile>.export.log).
    const logs = join(req.projectDir, 'build-output', req.version, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, `${req.platform}-${req.profile.toLowerCase()}.export.log`),
      log.replace(/Bearer [A-Za-z0-9_-]+/g, 'Bearer <redacted>'),
    );
    const errors = godotErrors(log).filter((l) => !/EditorSettings/.test(l));
    if (!existsSync(target)) errors.unshift(`export produced no ${file}`);
    if (req.platform === 'windows') {
      const data = join(out, `data_${req.assembly}_windows_x86_64`);
      if (!existsSync(join(data, `${req.assembly}.dll`)))
        errors.unshift(`C# assemblies missing: ${relative(out, data)}/${req.assembly}.dll (see D-011)`);
    }
    if (distributable && existsSync(out)) {
      const violations = distributableViolations(
        walk(out).map((f) => relative(out, f)),
        req.profile,
      );
      errors.push(...violations.map((v) => `distributable must not contain ${v}`));
    }
    if (errors.length) return finish({ status: 'FAILED', artifacts: [], errors, note: null });
    const artifacts = [];
    for (const f of [target, join(out, `${req.assembly}.pck`)].filter(existsSync))
      artifacts.push({ path: f, sha256: await sha256File(f), size: statSync(f).size });
    return finish({
      status: 'BUILT',
      artifacts,
      errors: [],
      note: req.platform === 'android' ? 'Built, not device-tested (no Android device/emulator available)' : null,
    });
  }

  /**
   * RELEASE/PREVIEW source: a git worktree at the current commit with the QA autoload removed, so the compiled-out
   * ModulexQa script is not referenced (D-032). The working project is never modified.
   */
  private releaseSnapshot(req: BuildRequest): string {
    const dir = join(req.projectDir, 'build-output', '.snapshots', `${Date.now()}`);
    mkdirSync(join(dir, '..'), { recursive: true });
    git(req.projectDir, ['worktree', 'add', '--detach', dir, gitHead(req.projectDir)]);
    const pg = join(dir, 'project.godot');
    writeFileSync(
      pg,
      readFileSync(pg, 'utf-8')
        .replace(/^ModulexQa=.*\r?\n/m, '')
        .replace(/^config\/version=".*"$/m, `config/version="${req.version}"`),
    );
    const presets = join(dir, 'export_presets.cfg');
    if (existsSync(presets)) {
      let text = readFileSync(presets, 'utf-8')
        .replace(/^version\/name=".*"$/gm, `version/name="${req.version}"`)
        .replace(/^application\/short_version=".*"$/m, `application/short_version="${req.version}"`);
      if (req.platform === 'android')
        text = text.replace(/^version\/code=\d+$/gm, `version/code=${this.nextAndroidCode(req)}`);
      writeFileSync(presets, text);
    }
    // The snapshot has no .godot/ import cache; copy it so the export does not re-import from scratch.
    const cache = join(req.projectDir, '.godot');
    if (existsSync(cache))
      cpSync(cache, join(dir, '.godot'), { recursive: true, filter: (p) => !/[\\/]mono([\\/]|$)/.test(p) });
    return dir;
  }

  /** Android version/code: monotonic per project, persisted in .modulex/android-version-code. */
  nextAndroidCode(req: Pick<BuildRequest, 'projectDir'>): number {
    const f = join(req.projectDir, '.modulex', 'android-version-code');
    const next = (existsSync(f) ? Number(readFileSync(f, 'utf-8').trim()) || 0 : 0) + 1;
    mkdirSync(join(req.projectDir, '.modulex'), { recursive: true });
    writeFileSync(f, `${next}\n`);
    return next;
  }

  private dropSnapshot(req: BuildRequest, dir: string): void {
    try {
      git(req.projectDir, ['worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** iOS on a non-macOS host: a secret-free snapshot for the macOS worker. */
  private async prepareIos(req: BuildRequest): Promise<{ path: string; sha256: string; size: number }> {
    const out = this.outDir(req);
    mkdirSync(out, { recursive: true });
    const bundle = join(out, `ios-prep-${req.version}.bundle`);
    git(req.projectDir, ['bundle', 'create', bundle, 'HEAD']);
    return { path: bundle, sha256: await sha256File(bundle), size: statSync(bundle).size };
  }

  private record(req: BuildRequest, r: BuildResult): void {
    const db = this.o.db;
    if (!db) return;
    const at = (this.o.now ?? (() => new Date()))().toISOString();
    db.run(
      'INSERT INTO builds (build_id, project_id, platform, profile, version, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.build_id,
      req.projectId,
      r.platform,
      r.profile,
      req.version,
      r.status,
      at,
      JSON.stringify({ errors: r.errors, note: r.note, ms: r.ms }),
    );
    for (const a of r.artifacts)
      db.run(
        'INSERT INTO artifacts (artifact_id, build_id, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `${r.build_id}:${a.sha256.slice(0, 8)}`,
        r.build_id,
        a.path,
        a.sha256,
        a.size,
        at,
      );
  }
}
