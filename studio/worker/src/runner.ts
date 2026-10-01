// SPDX-License-Identifier: Apache-2.0
//
// The export + signing runner (Phase 11). A `BuildRunner` turns an uploaded project snapshot into artifacts.
//
// GodotExportRunner (the real one):
//   1. `git clone <bundle>`: the snapshot the Studio uploaded (no secrets inside: D-032 strip, PREPARED bundle).
//   2. `godot --version` must start with the job's pinned version (compat.json); otherwise godot_version_mismatch.
//   3. `godot --headless --path <src> --import`, then `--export-release|--export-debug "<preset>" <out>`.
//   4. iOS with a signing profile (macOS only): the preset is switched to "export project only", then
//      `xcodebuild archive` + `xcodebuild -exportArchive -exportOptionsPlist <profile>/ExportOptions.plist`.
//      The profile directory lives ON THE WORKER (`<signingDir>/<name>/`); certificates, provisioning profiles and
//      App Store Connect keys stay in the worker's keychain and are never read into, logged by or returned from
//      this process. Only the signed .ipa (and the archive's size/hash) goes back.
//
// Not verified live here: there is no macOS host in this environment (PROGRESS: GATE 11 live = BLOCKED).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BuildJobFailure, BuildJobSpec, BuildWorkerCapabilities, BuildWorkerPlatform } from '@modulex/shared';

export class RunnerError extends Error {
  constructor(
    readonly failure: BuildJobFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface RunContext {
  job: BuildJobSpec;
  bundlePath: string;
  workDir: string;
  outDir: string;
  log: (line: string) => void;
  signal: AbortSignal;
}

export interface RunResult {
  signed: boolean;
  /** Artifact paths (inside outDir). */
  artifacts: string[];
}

export interface BuildRunner {
  capabilities(): Promise<Omit<BuildWorkerCapabilities, 'worker_id' | 'worker_version' | 'max_concurrent_jobs'>>;
  run(ctx: RunContext): Promise<RunResult>;
}

/** Run a process, streaming its output to the log; aborting kills it. Resolves with the exit code. */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; log?: (l: string) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, signal: opts.signal });
    const onData = (b: Buffer) => {
      const s = b.toString('utf-8');
      out += s;
      if (out.length > 1 << 20) out = out.slice(-(1 << 19));
      for (const l of s.split(/\r?\n/)) if (l.trim()) opts.log?.(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (e) => (e.name === 'AbortError' ? resolve({ code: null, out }) : reject(e)));
    child.once('close', (code) => resolve({ code, out }));
  });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

export interface GodotRunnerOptions {
  godot: string;
  /** Where named signing profiles live on this worker: `<signingDir>/<name>/{profile.json,ExportOptions.plist}`. */
  signingDir?: string | null;
  git?: string;
  xcodebuild?: string;
  platform?: NodeJS.Platform;
}

export class GodotExportRunner implements BuildRunner {
  constructor(private readonly o: GodotRunnerOptions) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  async godotVersion(): Promise<string | null> {
    const r = await exec(this.o.godot, ['--version', '--headless']).catch(() => null);
    return r?.out.trim().split(/\r?\n/).pop()?.trim() || null;
  }

  async capabilities() {
    const platforms: BuildWorkerPlatform[] =
      this.platform === 'darwin' ? ['ios', 'macos'] : this.platform === 'win32' ? ['windows', 'android'] : ['android'];
    let xcode: string | null = null;
    if (this.platform === 'darwin') {
      const r = await exec(this.o.xcodebuild ?? 'xcodebuild', ['-version']).catch(() => null);
      xcode = r?.code === 0 ? r.out.trim().split(/\r?\n/)[0]! : null;
    }
    const dir = this.o.signingDir;
    const signing_profiles =
      dir && existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'ExportOptions.plist')))
            .map((d) => d.name)
        : [];
    return {
      os: `${this.platform}`,
      platforms,
      godot_version: await this.godotVersion(),
      xcode_version: xcode,
      signing_profiles,
    };
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const { job, log, signal } = ctx;
    const src = join(ctx.workDir, 'src');
    const clone = await exec(this.o.git ?? 'git', ['clone', '-q', ctx.bundlePath, src], { log, signal });
    if (clone.code !== 0) throw new RunnerError('bundle_invalid', 'git clone of the uploaded bundle failed');

    const version = await this.godotVersion();
    if (!version?.startsWith(`${job.godot_version}.`) && version !== job.godot_version)
      throw new RunnerError(
        'godot_version_mismatch',
        `worker Godot is ${version ?? 'missing'}; the project is pinned to ${job.godot_version}`,
      );

    const signIos = job.platform === 'ios' && job.signing_profile !== null;
    let profileDir: string | null = null;
    if (signIos) {
      if (this.platform !== 'darwin') throw new RunnerError('signing_failed', 'iOS signing needs a macOS worker');
      profileDir = this.o.signingDir ? join(this.o.signingDir, job.signing_profile!) : null;
      if (!profileDir || !existsSync(join(profileDir, 'ExportOptions.plist')))
        throw new RunnerError('signing_profile_missing', `signing profile '${job.signing_profile}' is not configured`);
      const profile = existsSync(join(profileDir, 'profile.json'))
        ? (JSON.parse(readFileSync(join(profileDir, 'profile.json'), 'utf-8')) as { team_id?: string })
        : {};
      setPresetOptions(join(src, 'export_presets.cfg'), job.preset, {
        'application/export_project_only': 'true',
        ...(profile.team_id ? { 'application/app_store_team_id': `"${profile.team_id}"` } : {}),
      });
    }

    await exec(this.o.godot, ['--headless', '--path', src, '--import'], { log, signal });
    const ext = { windows: '.exe', android: '.apk', ios: '.ipa', macos: '.zip' }[job.platform];
    const exportDir = signIos ? join(ctx.workDir, 'xcode') : ctx.outDir;
    const target = join(exportDir, `${job.assembly}${ext}`);
    const flag = job.profile === 'RELEASE' || job.profile === 'PREVIEW' ? '--export-release' : '--export-debug';
    const ex = await exec(this.o.godot, ['--headless', '--path', src, flag, job.preset, target], { log, signal });
    if (signal.aborted) throw new RunnerError('export_failed', 'cancelled');
    if (ex.code !== 0 && !signIos)
      throw new RunnerError('export_failed', `godot ${flag} exited with ${ex.code ?? 'a signal'}`);

    if (!signIos) {
      // The Godot exit code is never trusted on its own (D-011): the artifact must exist.
      const files = filesUnder(ctx.outDir);
      if (!files.length) throw new RunnerError('export_failed', 'the export produced no files');
      return { signed: false, artifacts: files };
    }

    const project = readdirSync(exportDir).find((f) => f.endsWith('.xcodeproj'));
    if (!project) throw new RunnerError('export_failed', 'Godot did not write an Xcode project');
    const scheme = project.replace(/\.xcodeproj$/, '');
    const archive = join(ctx.workDir, `${scheme}.xcarchive`);
    const xc = this.o.xcodebuild ?? 'xcodebuild';
    const a = await exec(
      xc,
      [
        '-project',
        join(exportDir, project),
        '-scheme',
        scheme,
        '-configuration',
        'Release',
        '-archivePath',
        archive,
        'archive',
      ],
      { log, signal },
    );
    if (a.code !== 0) throw new RunnerError('signing_failed', `xcodebuild archive exited with ${a.code}`);
    const e = await exec(
      xc,
      [
        '-exportArchive',
        '-archivePath',
        archive,
        '-exportOptionsPlist',
        join(profileDir!, 'ExportOptions.plist'),
        '-exportPath',
        ctx.outDir,
      ],
      { log, signal },
    );
    if (e.code !== 0) throw new RunnerError('signing_failed', `xcodebuild -exportArchive exited with ${e.code}`);
    const ipa = filesUnder(ctx.outDir).filter((f) => f.endsWith('.ipa'));
    if (!ipa.length) throw new RunnerError('signing_failed', 'xcodebuild produced no .ipa');
    return { signed: true, artifacts: ipa };
  }
}

/** Set `key=value` options inside one `[preset.N.options]` section of export_presets.cfg (by preset name). */
export function setPresetOptions(path: string, preset: string, options: Record<string, string>): void {
  const text = readFileSync(path, 'utf-8');
  const header = [...text.matchAll(/^\[preset\.(\d+)\]\s*$/gm)].find((m) => {
    const after = text.slice(m.index! + m[0].length);
    return new RegExp(`^name="${preset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm').test(after.split(/^\[/m)[0]!);
  });
  if (!header) throw new RunnerError('export_failed', `preset '${preset}' not found in export_presets.cfg`);
  const section = `[preset.${header[1]}.options]`;
  const start = text.indexOf(section);
  if (start < 0) throw new RunnerError('export_failed', `${section} missing`);
  const bodyStart = start + section.length;
  const next = text.slice(bodyStart).search(/^\[/m);
  const end = next < 0 ? text.length : bodyStart + next;
  let body = text.slice(bodyStart, end);
  for (const [k, v] of Object.entries(options)) {
    const re = new RegExp(`^${k.replace(/[/.]/g, '\\$&')}=.*$`, 'm');
    body = re.test(body) ? body.replace(re, `${k}=${v}`) : `${body.replace(/\n*$/, '\n')}${k}=${v}\n`;
  }
  writeFileSync(path, text.slice(0, bodyStart) + body + text.slice(end));
}

/** Artifact name relative to the job's out dir, with forward slashes. */
export function artifactName(outDir: string, path: string): string {
  return relative(outDir, path).split(/[\\/]/).join('/');
}

export function fileSize(path: string): number {
  return statSync(path).size;
}
