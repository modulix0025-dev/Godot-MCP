// SPDX-License-Identifier: Apache-2.0
//
// QA runner (Phase 9): the static tier (C# build with parsed MSBuild errors, every scene run headless as the main
// scene, main scene set, optional editor checks: script-validate / project-validate-resources) and the playtest
// tier (scenarios through the in-game QA runtime). `runSuite` returns every failure, classified and fingerprinted,
// which is exactly what the fix loop consumes.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProjectFactory } from '../project/project-factory.js';
import { runScene } from './scene-runner.js';
import { classifyGodotMessage, makeFailure, recordFailures, topFrame, type QaFailure } from './failures.js';
import type { PlaytestSession, ScenarioResult } from './playtest.js';
import { ScenarioSchema, type Scenario } from './scenarios.js';
import type { GodotClient } from '../godot/godot-call.js';
import type { StudioDb } from '../db/database.js';

const run = promisify(execFile);

export interface MsbuildError {
  file: string;
  line: number;
  code: string;
  message: string;
}

/** `path/File.cs(12,5): error CS1002: ; expected [proj.csproj]` → structured rows. */
export function parseMsbuildErrors(log: string): MsbuildError[] {
  const out: MsbuildError[] = [];
  const seen = new Set<string>();
  for (const m of log.matchAll(/^\s*(.+?)\((\d+),\d+\): error ([A-Z]+\d+): (.+?)(?: \[[^\]]+\])?\s*$/gm)) {
    const key = `${m[1]}|${m[2]}|${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: m[1]!, line: Number(m[2]), code: m[3]!, message: m[4]! });
  }
  return out;
}

export function scenariosDir(projectDir: string): string {
  return join(projectDir, '.modulex', 'tests');
}

export function writeScenarios(projectDir: string, scenarios: Scenario[]): void {
  mkdirSync(scenariosDir(projectDir), { recursive: true });
  for (const s of scenarios)
    writeFileSync(join(scenariosDir(projectDir), `${s.id}.json`), `${JSON.stringify(s, null, 2)}\n`);
}

export function loadScenarios(projectDir: string): Scenario[] {
  const dir = scenariosDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ScenarioSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf-8'))));
}

export interface QaRunnerOptions {
  projectId: string;
  projectDir: string;
  godot: string;
  solution: string;
  dotnet?: string;
  env?: NodeJS.ProcessEnv;
  db?: StudioDb | null;
  /** Editor session for script-validate / project-validate-resources (optional). */
  editor?: Pick<GodotClient, 'call'> | null;
  /** Factory for a fresh playtest session per suite run (null = static tier only). */
  playtest?: (() => PlaytestSession) | null;
}

export interface SuiteReport {
  failures: QaFailure[];
  static: { build: MsbuildError[]; scenes: { scene: string; ok: boolean }[] };
  playtest: ScenarioResult[] | null;
}

export class QaRunner {
  lastReport: SuiteReport | null = null;
  constructor(private readonly o: QaRunnerOptions) {}

  async staticTier(): Promise<{
    failures: QaFailure[];
    build: MsbuildError[];
    scenes: { scene: string; ok: boolean }[];
  }> {
    const failures: QaFailure[] = [];
    let log = '';
    try {
      const r = await run(this.o.dotnet ?? 'dotnet', ['build', this.o.solution, '-c', 'Debug', '-nologo'], {
        env: { ...process.env, ...this.o.env },
        timeout: 900_000,
        maxBuffer: 32 << 20,
      });
      log = `${r.stdout}\n${r.stderr}`;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      log = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      if (!/error [A-Z]+\d+/.test(log))
        failures.push(makeFailure('infra', `dotnet build did not run: ${err.message}`, 'static:build'));
    }
    const build = parseMsbuildErrors(log);
    for (const b of build)
      failures.push(makeFailure('compile_error', `${b.code}: ${b.message}`, 'static:build', b.file, b.line));

    const pg = readFileSync(join(this.o.projectDir, 'project.godot'), 'utf-8');
    const main = /^run\/main_scene="(res:\/\/[^"]+)"/m.exec(pg)?.[1];
    if (!main || !existsSync(join(this.o.projectDir, main.slice(6))))
      failures.push(
        makeFailure(
          'missing_resource',
          `main scene is not set or missing (${main ?? 'unset'})`,
          'static:project',
          main ?? null,
        ),
      );

    const scenes: { scene: string; ok: boolean }[] = [];
    for (const f of ProjectFactory.listScenes(this.o.projectDir)) {
      const scene = `res://scenes/${f}`;
      const r = await runScene(this.o.godot, this.o.projectDir, scene, 90, { ...process.env, ...this.o.env });
      scenes.push({ scene, ok: r.ok });
      for (const e of r.errors) {
        const { file, line } = topFrame(e);
        failures.push(makeFailure(classifyGodotMessage(e), e, `static:scene ${scene}`, file, line));
      }
      if (!r.errors.length && r.exit !== 0)
        failures.push(makeFailure('crash', `${scene} exited with ${r.exit}`, `static:scene ${scene}`, scene));
    }

    if (this.o.editor) {
      const sv = await this.o.editor.call({ tool: 'script-validate', args: {}, role: 'qa' });
      const diags =
        ((sv.result ?? {}) as { diagnostics?: { path?: string; line?: number; message?: string; severity?: string }[] })
          .diagnostics ?? [];
      for (const d of diags.filter((x) => (x.severity ?? 'error').toLowerCase() === 'error'))
        failures.push(
          makeFailure(
            'script_parse',
            d.message ?? 'script error',
            'static:script-validate',
            d.path ?? null,
            d.line ?? null,
          ),
        );
      const vr = await this.o.editor.call({ tool: 'project-validate-resources', args: {}, role: 'qa' });
      for (const p of ((vr.result ?? {}) as { problems?: { path: string; kind: string; detail: string }[] }).problems ??
        [])
        failures.push(makeFailure('missing_resource', `${p.kind}: ${p.detail}`, 'static:validate-resources', p.path));
    }
    return { failures: dedupe(failures), build, scenes };
  }

  async runSuite(): Promise<QaFailure[]> {
    const st = await this.staticTier();
    let playtest: ScenarioResult[] | null = null;
    const failures = [...st.failures];
    // The playtest tier needs a game that compiles and boots; skip it when the static tier already failed hard.
    const blocking = st.failures.some((f) => f.class === 'compile_error' || f.class === 'script_parse');
    if (this.o.playtest && !blocking) {
      const session = this.o.playtest();
      playtest = [];
      try {
        await session.start();
        for (const sc of loadScenarios(this.o.projectDir)) {
          const r = await session.runScenario(sc);
          playtest.push(r);
          failures.push(...r.failures);
        }
      } catch (e) {
        failures.push(
          makeFailure(session.game.running() ? 'infra' : 'crash', `playtest: ${(e as Error).message}`, 'playtest'),
        );
      } finally {
        await session.stop();
      }
    }
    const all = dedupe(failures);
    recordFailures(this.o.db, this.o.projectId, all);
    this.lastReport = { failures: all, static: { build: st.build, scenes: st.scenes }, playtest };
    return all;
  }
}

function dedupe(f: QaFailure[]): QaFailure[] {
  const seen = new Set<string>();
  return f.filter((x) => (seen.has(x.fingerprint) ? false : (seen.add(x.fingerprint), true)));
}
