// SPDX-License-Identifier: Apache-2.0
//
// gamedev-mcp-server supervisor (Phase 4). One server per Studio session role (editor, playtest), each on its
// own port and token — one server cannot host both (DECISIONS D-008).
//
//   port    derived from the project path (godot-cli `derivePortV2`, 20000–29999); next free port on collision
//   token   32 random bytes, base64url, per session; never logged, never written to disk
//   spawn   the exact token-mode command line (server-args.ts, D-004); stdout/stderr are DISCARDED because the
//           server prints its command line (which contains the token)
//   ready   GET /help → 200 (the authenticated ping is the EDITOR's readiness: the plugin answers it)
//   crash   restart with backoff; more than 3 crashes in 10 minutes → BLOCKED (no restart loop)
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { derivePortV2, MAX_PORT, MIN_PORT } from 'godot-cli';
import { buildServerArgs, generateSessionToken } from './server-args.js';

export type ServerState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'blocked';

export interface ServerSupervisorOptions {
  binary: string;
  /** Arguments placed before the server arguments (e.g. a script path when `binary` is node). */
  prefixArgs?: string[];
  /** Project path used to derive the preferred port; or an explicit port. */
  projectPath?: string;
  port?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  readyTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** The project's derived port, or the next free port above it (wrapping inside 20000–29999). */
export async function allocatePort(projectPath: string | undefined, explicit?: number): Promise<number> {
  if (explicit) return explicit;
  const start = projectPath ? derivePortV2(projectPath) : MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
  for (let i = 0; i <= MAX_PORT - MIN_PORT; i++) {
    const p = MIN_PORT + ((start - MIN_PORT + i) % (MAX_PORT - MIN_PORT + 1));
    if (await portIsFree(p)) return p;
  }
  throw new Error('no free port in 20000–29999');
}

export class ServerSupervisor extends EventEmitter {
  state: ServerState = 'stopped';
  port = 0;
  readonly token = generateSessionToken();
  private child: ChildProcess | null = null;
  private crashes: number[] = [];
  private stopping = false;

  constructor(private readonly o: ServerSupervisorOptions) {
    super();
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (!this.port) this.port = await allocatePort(this.o.projectPath, this.o.port);
    this.setState('starting');
    this.spawnOnce();
    await this.waitReady(this.o.readyTimeoutMs ?? 60_000);
    this.setState('ready');
  }

  private spawnOnce(): void {
    const child = spawn(
      this.o.binary,
      [...(this.o.prefixArgs ?? []), ...buildServerArgs({ port: this.port, token: this.token })],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      },
    );
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      this.emit('crash', { code, signal });
      void this.onCrash();
    });
  }

  private async onCrash(): Promise<void> {
    const now = Date.now();
    const window = this.o.restartWindowMs ?? 10 * 60_000;
    this.crashes = this.crashes.filter((t) => now - t < window);
    this.crashes.push(now);
    if (this.crashes.length > (this.o.maxRestarts ?? 3)) {
      this.setState('blocked');
      return;
    }
    this.setState('restarting');
    await new Promise((r) => setTimeout(r, (this.o.backoffMs ?? ((a) => 500 * 2 ** a))(this.crashes.length - 1)));
    if (this.stopping) return;
    this.spawnOnce();
    try {
      await this.waitReady(this.o.readyTimeoutMs ?? 60_000);
      this.setState('ready');
    } catch {
      /* the exit handler records the next crash */
    }
  }

  private setState(s: ServerState): void {
    this.state = s;
    this.emit('state', s);
  }

  /**
   * Liveness: GET /help → 200. (An authenticated ping is NOT a server check: `ping` is a System tool answered by
   * the connected plugin, so without an editor the server correctly answers 503 — that is editor readiness.)
   */
  async waitReady(timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const help = await fetch(`${this.baseUrl}/help`, { signal: AbortSignal.timeout(3000) });
        if (help.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`MCP server did not become ready on port ${this.port}`);
  }

  /** POST /api/system-tools/ping. `token: null` omits the bearer (used to prove 401). */
  async ping(message = 'modulex', token: string | null = this.token): Promise<{ status: number; body: string }> {
    const r = await fetch(`${this.baseUrl}/api/system-tools/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, body: await r.text() };
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      const exited = new Promise((r) => c.once('exit', r));
      c.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (c.exitCode === null) c.kill('SIGKILL');
    }
    this.setState('stopped');
  }
}
