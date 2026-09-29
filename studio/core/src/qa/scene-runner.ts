// SPDX-License-Identifier: Apache-2.0
//
// Headless scene runs (Phase 9 static/boot tier): start the game at a given scene with the project's autoloads,
// run N frames, and return the project errors Godot reported. Used to validate every generated scene and as the
// "boots without errors" check. MCP/QA env is stripped so the run is the plain game.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { godotErrors } from '../project/project-factory.js';

const run = promisify(execFile);

export interface SceneRun {
  scene: string;
  ok: boolean;
  errors: string[];
  exit: number | null;
  ms: number;
}

export async function runScene(
  godot: string,
  projectDir: string,
  scene: string,
  frames = 120,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SceneRun> {
  const clean = { ...env };
  for (const k of Object.keys(clean)) if (k.startsWith('GODOT_MCP_') || k === 'MODULEX_QA') delete clean[k];
  const t = Date.now();
  let log = '';
  let exit: number | null = 0;
  try {
    const r = await run(godot, ['--headless', '--path', projectDir, scene, '--quit-after', String(frames)], {
      env: clean,
      timeout: 120_000,
      maxBuffer: 32 << 20,
    });
    log = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number | null };
    log = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    exit = typeof err.code === 'number' ? err.code : null;
  }
  const errors = godotErrors(log);
  return { scene, ok: exit === 0 && errors.length === 0, errors, exit, ms: Date.now() - t };
}
