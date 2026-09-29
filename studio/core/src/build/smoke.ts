// SPDX-License-Identifier: Apache-2.0
//
// Exported-build smoke tests (Phase 10).
//
//   Debug/QA build   launched with the QA env against its own playtest server; the default scenarios run through
//                    the in-game runtime exactly as in the editor playtest (PlaytestSession with the exported exe).
//   Release build    has no MCP at all: launched plain, it must stay alive for 10 s (no crash, no early exit) and
//                    then close. The desktop shell closes it gracefully (WM_CLOSE); here the process is stopped
//                    with SIGTERM → SIGKILL, and an early exit code is reported as a crash.
import { spawn } from 'node:child_process';
import { makeFailure, type QaFailure } from '../qa/failures.js';
import { PlaytestSession, type PlaytestOptions, type ScenarioResult } from '../qa/playtest.js';
import type { Scenario } from '../qa/scenarios.js';

export interface ReleaseSmoke {
  alive: boolean;
  exitCode: number | null;
  aliveMs: number;
  log: string;
}

export async function smokeRelease(
  exe: string,
  opts: { aliveMs?: number; args?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<ReleaseSmoke> {
  const aliveMs = opts.aliveMs ?? 10_000;
  const env = { ...process.env, ...opts.env };
  for (const k of Object.keys(env)) if (k.startsWith('GODOT_MCP_') || k === 'MODULEX_QA') delete env[k];
  const child = spawn(exe, opts.args ?? ['--windowed', '--resolution', '1280x720'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let log = '';
  child.stdout?.on('data', (b: Buffer) => (log += b.toString('utf-8')));
  child.stderr?.on('data', (b: Buffer) => (log += b.toString('utf-8')));
  let exitCode: number | null = null;
  const exited = new Promise<void>((r) =>
    child.once('exit', (c) => {
      exitCode = c ?? -1;
      r();
    }),
  );
  await Promise.race([exited, new Promise((r) => setTimeout(r, aliveMs))]);
  const alive = exitCode === null;
  if (alive) {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (exitCode === null) child.kill('SIGKILL');
  }
  return { alive, exitCode: alive ? null : exitCode, aliveMs, log: log.slice(-8000) };
}

export async function smokeDebug(
  exe: string,
  scenarios: Scenario[],
  opts: Omit<PlaytestOptions, 'exportedExecutable' | 'godot'>,
): Promise<{ results: ScenarioResult[]; failures: QaFailure[]; log: string[] }> {
  const session = new PlaytestSession({ ...opts, godot: exe, exportedExecutable: exe });
  const results: ScenarioResult[] = [];
  const failures: QaFailure[] = [];
  try {
    await session.start();
    for (const sc of scenarios) {
      const r = await session.runScenario(sc);
      results.push(r);
      failures.push(...r.failures);
    }
  } catch (e) {
    failures.push(makeFailure(session.game.running() ? 'infra' : 'crash', `smoke: ${(e as Error).message}`, 'smoke'));
  } finally {
    await session.stop();
  }
  return { results, failures, log: session.log };
}
