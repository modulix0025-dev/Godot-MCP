// SPDX-License-Identifier: Apache-2.0
//
// Godot editor / playtest-game supervisor (Phase 4, Phase 9). Spawns Godot with the Custom-mode loopback env for
// ITS server (godotSessionEnv), waits until the plugin answers an authenticated ping through that server, and
// stops it gracefully. Rules from the plan:
//   - never set GODOT_MCP_DEV_CONTROL (developer mode only);
//   - no token on disk: everything travels in the child env;
//   - GODOT_MCP_* / MODULEX_QA inherited from the Studio's own env are stripped first;
//   - readiness = wait-for-ready semantics (ping until connected), 120 s default.
import { spawn, type ChildProcess } from 'node:child_process';
import { godotSessionEnv } from './server-args.js';
import type { ServerSupervisor } from './server-supervisor.js';

export interface GodotLaunchOptions {
  godot: string;
  projectPath: string;
  server: ServerSupervisor;
  mode: 'editor' | 'game';
  headless?: boolean;
  /** Game only: scene to start and window geometry. */
  scene?: string;
  extraEnv?: Record<string, string>;
  /** Receives stdout/stderr lines, already redacted of the session token. */
  onLog?: (line: string) => void;
}

export function childEnv(server: ServerSupervisor, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GODOT_MCP_') || k === 'MODULEX_QA') delete env[k];
  return { ...env, ...godotSessionEnv(server.port, server.token), ...extra };
}

export class GodotProcess {
  private child: ChildProcess | null = null;
  exitCode: number | null = null;

  constructor(private readonly o: GodotLaunchOptions) {}

  args(): string[] {
    const a = ['--path', this.o.projectPath];
    if (this.o.mode === 'editor') a.push('--editor');
    else {
      if (this.o.scene) a.push(this.o.scene);
      a.push('--windowed', '--resolution', '1280x720', '--position', '0,0');
    }
    if (this.o.headless) a.unshift('--headless');
    return a;
  }

  start(): void {
    const child = spawn(this.o.godot, this.args(), {
      env: childEnv(this.o.server, this.o.extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const token = this.o.server.token;
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf-8').split(/\r?\n/))
        if (line.trim()) this.o.onLog?.(line.split(token).join('<redacted>'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      this.exitCode = code ?? -1;
      this.child = null;
    });
  }

  running(): boolean {
    return this.child !== null;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Ping through the server until the plugin echoes our message (the plugin is connected). */
  async waitConnected(timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!this.running() && this.exitCode !== null)
        throw new Error(`Godot exited with code ${this.exitCode} before connecting`);
      try {
        const r = await this.o.server.ping('modulex-ready');
        if (r.status === 200 && r.body.includes('modulex-ready')) return;
      } catch {
        /* server busy */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Godot did not connect to its MCP server in time');
  }

  async stop(graceMs = 10_000): Promise<void> {
    const c = this.child;
    if (!c) return;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
    if (this.child) c.kill('SIGKILL');
  }
}
