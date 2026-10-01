// SPDX-License-Identifier: Apache-2.0
//
// Project creation (Phase 6 "Project Creation" stage, Phase 10 template): writes the generated project, copies
// both addons in (they ship as source), writes the .modulex manifests, initialises git checkpoints, then runs the
// safe three-process pattern — `godot --headless --import --quit`, `dotnet build`, (editor boot later) — and
// validates the logs. The exit codes are never trusted alone: Godot's own `ERROR:` / `SCRIPT ERROR:` /
// `Parse Error` lines fail the stage (D-011).
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { GameSpec } from '@modulex/shared';
import { ProjectCheckpoints } from '../checkpoints/project-checkpoints.js';
import type { StudioDb } from '../db/database.js';
import { generateProject, type GeneratedProject } from './game-generator.js';

const run = promisify(execFile);

export interface ProjectFactoryOptions {
  /** Where game projects live, e.g. %USERPROFILE%\ModuleX Games. */
  projectsRoot: string;
  /** Directory containing `godot_mcp/` and `modulex_studio/` (the bundled addon sources). */
  addonsSource: string;
  godot: string;
  dotnet?: string;
  db?: StudioDb | null;
  /** Extra env for Godot/dotnet (DOTNET_ROOT, PATH for the private .NET SDK). */
  env?: NodeJS.ProcessEnv;
}

export interface StepLog {
  step: string;
  ok: boolean;
  ms: number;
  errors: string[];
  tail: string;
}

export interface CreatedProject {
  projectDir: string;
  generated: GeneratedProject;
  steps: StepLog[];
  ok: boolean;
}

/** Godot/MSBuild error lines worth failing on (warnings are kept out). */
export function godotErrors(log: string): string[] {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    const next = (lines[i + 1] ?? '').trim();
    if (
      /^SCRIPT ERROR\b|Parse Error|^ERROR: (Failed loading resource|Cannot load|Failed to load|Resource file not found)/.test(
        t,
      )
    )
      // Keep the GDScript frame ("at: _ready (res://scripts/bonus.gd:5)") with the error: it is what attributes the
      // failure to a file (topFrame), so the fix loop can name — and the generator fixer restore — the right script.
      out.push(/^at:/.test(next) && /res:\/\//.test(next) ? `${t} ${next}` : t);
    // Engine-internal editor noise in headless runs (dialog parenting, EditorSettings lookups) has no project
    // location; a genuine project error names a res:// file on the line or its "at:" continuation.
    else if (/^ERROR\b/.test(t) && /res:\/\//.test(`${t} ${next}`)) out.push(`${t} ${next}`);
  });
  return out.slice(0, 50);
}

export class ProjectFactory {
  constructor(private readonly o: ProjectFactoryOptions) {}

  projectDir(spec: GameSpec): string {
    return join(this.o.projectsRoot, spec.project.id);
  }

  /** Write files + addons + manifests; idempotent (existing files are overwritten with the same content). */
  write(spec: GameSpec, manifests: Record<string, unknown>): { dir: string; generated: GeneratedProject } {
    const dir = this.projectDir(spec);
    const generated = generateProject(spec);
    for (const f of generated.files) {
      const p = join(dir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content, 'utf-8');
    }
    for (const addon of ['godot_mcp', 'modulex_studio']) {
      const src = join(this.o.addonsSource, addon);
      if (!existsSync(src)) throw new Error(`addon source missing: ${src}`);
      cpSync(src, join(dir, 'addons', addon), { recursive: true, filter: (s) => !/[\\/](bin|obj)([\\/]|$)/.test(s) });
    }
    mkdirSync(join(dir, '.modulex'), { recursive: true });
    for (const [name, value] of Object.entries(manifests))
      writeFileSync(join(dir, '.modulex', name), `${JSON.stringify(value, null, 2)}\n`);
    return { dir, generated };
  }

  private async step(
    name: string,
    fn: () => Promise<{ stdout: string; stderr: string }>,
    errorsOf: (log: string) => string[],
  ): Promise<StepLog> {
    const t = Date.now();
    let log = '';
    let failed = false;
    let failure = '';
    try {
      const r = await fn();
      log = `${r.stdout}\n${r.stderr}`;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      log = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`;
      failed = true;
      failure = err.message.split('\n')[0]!.slice(0, 300);
    }
    const errors = errorsOf(log);
    // A process that failed to start or exited non-zero without a recognisable error line still says why.
    if (failed && !errors.length) errors.push(failure);
    return {
      step: name,
      ok: !failed && errors.length === 0,
      ms: Date.now() - t,
      errors,
      tail: log.split('\n').slice(-30).join('\n'),
    };
  }

  async create(spec: GameSpec, manifests: Record<string, unknown> = {}): Promise<CreatedProject> {
    const { dir, generated } = this.write(spec, manifests);
    const env = { ...process.env, ...this.o.env };
    for (const k of Object.keys(env)) if (k.startsWith('GODOT_MCP_') || k === 'MODULEX_QA') delete env[k];
    const steps: StepLog[] = [];
    steps.push(
      await this.step(
        'godot --import',
        () =>
          run(this.o.godot, ['--headless', '--path', dir, '--import', '--quit'], {
            env,
            timeout: 600_000,
            maxBuffer: 32 << 20,
          }),
        // The first import of a fresh project legitimately reports the not-yet-built C# assembly; the build
        // step below is the authority for C#, so only script/scene errors fail this step.
        (log) => godotErrors(log).filter((l) => !/\.cs|assembly|dotnet|\.NET|CSharp|Mono/i.test(l)),
      ),
    );
    steps.push(
      await this.step(
        'dotnet build',
        () =>
          run(this.o.dotnet ?? 'dotnet', ['build', join(dir, `${generated.assembly}.sln`), '-c', 'Debug', '-nologo'], {
            env,
            timeout: 900_000,
            maxBuffer: 32 << 20,
          }),
        (log) =>
          log
            .split('\n')
            .filter((l) => /: error [A-Z]+\d+/.test(l))
            .slice(0, 50),
      ),
    );
    const cp = new ProjectCheckpoints(dir, spec.project.id, this.o.db);
    cp.init();
    await cp.checkpoint('project created from the Game Specification');
    return { projectDir: dir, generated, steps, ok: steps.every((s) => s.ok) };
  }

  /** Files present in the project (for evidence). */
  static listScenes(dir: string): string[] {
    const scenes = join(dir, 'scenes');
    return existsSync(scenes) ? readdirSync(scenes).filter((f) => f.endsWith('.tscn')) : [];
  }
}
