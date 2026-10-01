// SPDX-License-Identifier: Apache-2.0
//
// The production UI's only channel to Studio Core: the owner endpoints on 127.0.0.1, authenticated with the owner
// session token the Tauri shell hands over (`core_connection`, the shell's single privileged command). The token
// stays in memory; it is never written to storage, the URL or logs. In `vite dev` only, `?core=<port>&token=…`
// lets a developer point the UI at a Core started by hand.

export interface CoreConnection {
  base: string;
  token: string;
}

type TauriInternals = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

/** The shell's Studio Core state while the UI boots: Core starts in the background and may take a while. */
export type CoreBoot =
  | { status: 'ready'; connection: CoreConnection }
  | { status: 'starting'; elapsedS: number }
  | { status: 'failed'; error: string; log: string | null }
  | { status: 'outside' };

/** The message of anything thrown: Tauri rejects commands with a plain string, not an Error. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export async function bootStatus(): Promise<CoreBoot> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (tauri) {
    const info = (await tauri.invoke('core_connection')) as
      | { status: 'ready'; port: number; token: string }
      | { status: 'starting'; elapsed_s: number }
      | { status: 'failed'; error: string; log: string | null };
    if (info.status === 'starting') return { status: 'starting', elapsedS: info.elapsed_s };
    if (info.status === 'failed') return { status: 'failed', error: info.error, log: info.log };
    return { status: 'ready', connection: { base: `http://127.0.0.1:${info.port}`, token: info.token } };
  }
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search);
    const port = q.get('core');
    const token = q.get('token');
    if (port && token) return { status: 'ready', connection: { base: `http://127.0.0.1:${port}`, token } };
  }
  return { status: 'outside' };
}

/** Call one of the shell's commands (Tauri). Throws outside the desktop app. */
export async function shellInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!tauri) throw new Error('only available in the ModuleX Game Studio app');
  return (await tauri.invoke(cmd, args)) as T;
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class CoreClient {
  constructor(
    private readonly conn: CoreConnection,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const r = await this.fetchImpl(`${this.conn.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.conn.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const msg = (parsed as { error?: unknown } | null)?.error;
      throw new CoreError(r.status, typeof msg === 'string' ? msg : `HTTP ${r.status} for ${path}`, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.req<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.req<T>('POST', path, body);
  }
}
