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
  status: 'BUILT' | 'PREPARED' | 'BLOCKED' | 'FAILED';
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
      const st = iosStatus({
        preparationDone: true,
        macWorkerOnline: false,
        signedIpaSha256: null,
        releaseRequested: req.profile === 'RELEASE',
      });
      const prep = await this.prepareIos(req);
      return finish({
        status: 'PREPARED',
        artifacts: [prep],
        errors: [],
        note:
          st.status === 'BLOCKED'
            ? `PREPARED — ${st.reason}`
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
    writeFileSync(pg, readFileSync(pg, 'utf-8').replace(/^ModulexQa=.*\r?\n/m, ''));
    // The snapshot has no .godot/ import cache; copy it so the export does not re-import from scratch.
    const cache = join(req.projectDir, '.godot');
    if (existsSync(cache))
      cpSync(cache, join(dir, '.godot'), { recursive: true, filter: (p) => !/[\\/]mono([\\/]|$)/.test(p) });
    return dir;
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
