// SPDX-License-Identifier: Apache-2.0
//
// Worker-side persistence. Everything lives under the worker's state directory:
//
//   state.json             worker id, paired Studio tokens (SHA-256 hashes only), the pending pairing code (hash)
//   jobs/<job_id>/job.json the job (spec + view), rewritten atomically on every transition
//   jobs/<job_id>/bundle   the uploaded project snapshot (git bundle)
//   jobs/<job_id>/out/     artifacts
//   jobs/<job_id>/log.txt  the job log
//
// Tokens and pairing codes are stored as hashes, so a copied state directory cannot be replayed as a credential.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildJobSpec, BuildJobView } from '@modulex/shared';

export interface PairedStudio {
  token_sha256: string;
  studio: string;
  paired_at: string;
}

export interface WorkerState {
  worker_id: string;
  paired: PairedStudio[];
  pairing: { code_sha256: string; expires_at: string; attempts: number } | null;
}

export interface StoredJob {
  spec: BuildJobSpec;
  view: BuildJobView;
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class WorkerStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'jobs'), { recursive: true });
  }

  private get statePath(): string {
    return join(this.dir, 'state.json');
  }

  state(): WorkerState {
    if (!existsSync(this.statePath)) {
      const s: WorkerState = { worker_id: `bw_${randomBytes(6).toString('hex')}`, paired: [], pairing: null };
      this.saveState(s);
      return s;
    }
    return JSON.parse(readFileSync(this.statePath, 'utf-8')) as WorkerState;
  }

  saveState(s: WorkerState): void {
    writeAtomic(this.statePath, `${JSON.stringify(s, null, 2)}\n`);
  }

  /** Mint a one-time pairing code (shown to the operator on the worker host only). Valid for `ttlMs`. */
  newPairingCode(ttlMs = 10 * 60_000, now = Date.now()): string {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const b = randomBytes(8);
    let raw = '';
    for (let i = 0; i < 8; i++) raw += alphabet[b[i]! % alphabet.length];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const s = this.state();
    s.pairing = { code_sha256: sha256(code), expires_at: new Date(now + ttlMs).toISOString(), attempts: 0 };
    this.saveState(s);
    return code;
  }

  /**
   * Exchange a pairing code for a worker token. The code is single use, expires, and is burnt after 5 wrong
   * attempts. Returns the token once; only its hash is kept.
   */
  pair(code: string, studio: string, now = Date.now()): { worker_id: string; token: string } | null {
    const s = this.state();
    const p = s.pairing;
    if (!p) return null;
    if (Date.parse(p.expires_at) < now || p.attempts >= 5) {
      s.pairing = null;
      this.saveState(s);
      return null;
    }
    if (!safeEqualHex(sha256(code), p.code_sha256)) {
      p.attempts++;
      if (p.attempts >= 5) s.pairing = null;
      this.saveState(s);
      return null;
    }
    const token = `mxw_${randomBytes(32).toString('base64url')}`;
    s.pairing = null;
    s.paired.push({ token_sha256: sha256(token), studio, paired_at: new Date(now).toISOString() });
    this.saveState(s);
    return { worker_id: s.worker_id, token };
  }

  isPairedToken(token: string): boolean {
    const h = sha256(token);
    return this.state().paired.some((p) => safeEqualHex(h, p.token_sha256));
  }

  revokeAll(): void {
    const s = this.state();
    s.paired = [];
    this.saveState(s);
  }

  jobDir(id: string): string {
    return join(this.dir, 'jobs', id);
  }

  getJob(id: string): StoredJob | null {
    const p = join(this.jobDir(id), 'job.json');
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as StoredJob) : null;
  }

  saveJob(job: StoredJob): void {
    mkdirSync(this.jobDir(job.spec.job_id), { recursive: true });
    writeAtomic(join(this.jobDir(job.spec.job_id), 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  }

  listJobs(): StoredJob[] {
    return readdirSync(join(this.dir, 'jobs'))
      .map((id) => this.getJob(id))
      .filter((j): j is StoredJob => j !== null);
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
