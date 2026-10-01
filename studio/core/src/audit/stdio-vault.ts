// SPDX-License-Identifier: Apache-2.0
//
// The credential store bridge, Core side (D-056). Core runs as the Tauri shell's child; the shell owns Windows
// Credential Manager. To store or resolve a secret Core writes one `vault-request` JSON line to stdout and waits
// for the matching `vault-response` on stdin (see studio/app/src-tauri/src/vault.rs). Enabled only when the shell
// sets MODULEX_VAULT_BRIDGE=1; values are registered with the redactor and never logged.
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { WritableVault } from '../build/build-workers.js';
import type { Redactor } from './secrets.js';

interface Pending {
  resolve: (v: { ok: boolean; value: string | null; error: string | null }) => void;
  timer: NodeJS.Timeout;
}

export class StdioVault implements WritableVault {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly redactor?: Redactor,
    private readonly timeoutMs = 15_000,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        this.onLine(line);
      }
    });
  }

  private onLine(line: string): void {
    let msg: { type?: string; id?: number; ok?: boolean; value?: string | null; error?: string | null };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== 'vault-response' || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve({ ok: msg.ok === true, value: msg.value ?? null, error: msg.error ?? null });
  }

  private request(op: 'get' | 'set' | 'delete', ref: string, value?: string) {
    const id = this.nextId++;
    return new Promise<{ ok: boolean; value: string | null; error: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, value: null, error: 'the credential store bridge did not answer' });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.output.write(`${JSON.stringify({ type: 'vault-request', id, op, ref, value })}\n`);
    });
  }

  async set(ref: string, value: string): Promise<void> {
    this.redactor?.register(value);
    const r = await this.request('set', ref, value);
    if (!r.ok) throw new Error(`credential store: ${r.error ?? 'refused'}`);
  }

  async resolve(ref: string): Promise<string | null> {
    const r = await this.request('get', ref);
    if (!r.ok) return null;
    if (r.value) this.redactor?.register(r.value);
    return r.value;
  }

  async delete(ref: string): Promise<void> {
    const r = await this.request('delete', ref);
    if (!r.ok) throw new Error(`credential store: ${r.error ?? 'refused'}`);
  }

  /** Store → read back → delete a random probe (the installed self-test proves the bridge end to end). */
  async selfTest(): Promise<{ ok: boolean; steps: { step: string; ok: boolean; error?: string }[] }> {
    const ref = 'secret://studio/selftest/probe';
    const probe = randomBytes(18).toString('base64url');
    const steps: { step: string; ok: boolean; error?: string }[] = [];
    const step = async (name: string, fn: () => Promise<boolean>) => {
      try {
        steps.push({ step: name, ok: await fn() });
      } catch (e) {
        steps.push({ step: name, ok: false, error: (e as Error).message });
      }
    };
    await step('store', async () => (await this.set(ref, probe), true));
    await step('read back', async () => (await this.resolve(ref)) === probe);
    await step('delete', async () => (await this.delete(ref), true));
    await step('gone', async () => (await this.resolve(ref)) === null);
    return { ok: steps.every((s) => s.ok), steps };
  }
}
