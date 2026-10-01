// SPDX-License-Identifier: Apache-2.0
//
// modulex-build-worker HTTP(S) service (Phase 11). See `@modulex/shared` build-worker.ts for the protocol.
//
// Security rules enforced here:
//   - TLS is mandatory unless the service binds to loopback only (a same-host worker, tests). There is no flag to
//     serve plain HTTP on a reachable interface.
//   - Every route except POST /v1/pair needs a paired bearer token (compared by hash, constant time).
//   - Pairing codes are one-time, expire and burn after 5 wrong attempts (WorkerStore).
//   - Uploads are size-capped by the spec and must match its sha256 before a job is queued.
//   - Artifact names are resolved inside the job's out dir only (no path traversal).
//   - Job logs never contain signing material: the runner never reads it (see runner.ts).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve, sep } from 'node:path';
import {
  BuildJobSpec,
  PairRequest,
  TERMINAL_BUILD_JOB_STATES,
  type BuildJobView,
  type BuildWorkerCapabilities,
} from '@modulex/shared';
import { artifactName, fileSize, RunnerError, type BuildRunner } from './runner.js';
import { WorkerStore, type StoredJob } from './store.js';

export const BUILD_WORKER_VERSION = '0.1.0';

export interface WorkerServiceOptions {
  stateDir: string;
  runner: BuildRunner;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer } | null;
  maxConcurrentJobs?: number;
  /** Hard cap on an uploaded bundle (bytes). Default 2 GiB. */
  maxBundleBytes?: number;
  jobTimeoutMs?: number;
  now?: () => Date;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export class WorkerService {
  readonly store: WorkerStore;
  private server: Server | null = null;
  private readonly running = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly o: WorkerServiceOptions) {
    const host = o.host ?? '127.0.0.1';
    if (!o.tls && !LOOPBACK.has(host))
      throw new Error(`refusing to serve plain HTTP on '${host}': configure TLS or bind to 127.0.0.1`);
    this.store = new WorkerStore(o.stateDir);
    this.recover();
  }

  private now(): string {
    return (this.o.now ?? (() => new Date()))().toISOString();
  }

  /** Worker restart: queued jobs (bundle verified) run again; a job that was running has an unknown outcome. */
  private recover(): void {
    for (const j of this.store.listJobs()) {
      if (j.view.state === 'running') {
        this.update(j, { state: 'failed', failure: 'worker_restarted', message: 'the worker restarted mid-job' });
      } else if (j.view.state === 'queued') this.queue.push(j.spec.job_id);
    }
  }

  async listen(): Promise<{ port: number; url: string }> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handle(req, res).catch((e: Error) => send(res, 500, { error: e.message }));
    };
    this.server = this.o.tls ? createHttpsServer(this.o.tls, handler) : createHttpServer(handler);
    await new Promise<void>((r) => this.server!.listen(this.o.port ?? 0, this.o.host ?? '127.0.0.1', r));
    const port = (this.server.address() as { port: number }).port;
    this.kick();
    return { port, url: `${this.o.tls ? 'https' : 'http'}://${this.o.host ?? '127.0.0.1'}:${port}` };
  }

  async close(): Promise<void> {
    for (const c of this.running.values()) c.abort();
    await this.draining.catch(() => undefined);
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  async capabilities(): Promise<BuildWorkerCapabilities> {
    const c = await this.o.runner.capabilities();
    return {
      ...c,
      worker_id: this.store.state().worker_id,
      worker_version: BUILD_WORKER_VERSION,
      max_concurrent_jobs: this.o.maxConcurrentJobs ?? 1,
    };
  }

  private authorised(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') && this.store.isPairedToken(h.slice(7));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://worker');
    const path = url.pathname;

    if (req.method === 'POST' && path === '/v1/pair') {
      const body = PairRequest.safeParse(await readJson(req, 4096));
      if (!body.success) return send(res, 400, { error: 'invalid pairing request' });
      const r = this.store.pair(body.data.code, body.data.studio);
      if (!r) return send(res, 403, { error: 'invalid or expired pairing code' });
      return send(res, 200, r);
    }

    if (!this.authorised(req)) return send(res, 401, { error: 'unauthorised' });

    if (req.method === 'GET' && path === '/v1/health')
      return send(res, 200, {
        ok: true,
        worker_id: this.store.state().worker_id,
        version: BUILD_WORKER_VERSION,
        running: this.running.size,
        queued: this.queue.length,
        at: this.now(),
      });
    if (req.method === 'GET' && path === '/v1/capabilities') return send(res, 200, await this.capabilities());

    if (req.method === 'POST' && path === '/v1/jobs') {
      const parsed = BuildJobSpec.safeParse(await readJson(req, 64 * 1024));
      if (!parsed.success) return send(res, 400, { error: 'invalid job', issues: parsed.error.issues.slice(0, 5) });
      const spec = parsed.data;
      const existing = this.store.getJob(spec.job_id);
      if (existing) {
        // Idempotent: the same spec returns the same job; a different spec under the same id is a conflict.
        if (JSON.stringify(existing.spec) !== JSON.stringify(spec))
          return send(res, 409, { error: 'job_id already used for a different job' });
        return send(res, 200, existing.view);
      }
      const at = this.now();
      const job: StoredJob = {
        spec,
        view: {
          job_id: spec.job_id,
          state: 'awaiting_bundle',
          signed: false,
          failure: null,
          message: null,
          artifacts: [],
          log_tail: [],
          created_at: at,
          updated_at: at,
          run_seconds: 0,
        },
      };
      this.store.saveJob(job);
      return send(res, 201, job.view);
    }

    const m = /^\/v1\/jobs\/(bj_[0-9a-z]{26})(\/bundle|\/cancel|\/artifacts\/(.+))?$/.exec(path);
    if (!m) return send(res, 404, { error: 'not found' });
    const job = this.store.getJob(m[1]!);
    if (!job) return send(res, 404, { error: 'unknown job' });
    const sub = m[2];

    if (req.method === 'GET' && !sub) return send(res, 200, job.view);

    if (req.method === 'PUT' && sub === '/bundle') {
      if (job.view.state !== 'awaiting_bundle') return send(res, 200, job.view); // already uploaded: idempotent
      const cap = Math.min(job.spec.bundle.size, this.o.maxBundleBytes ?? 2 * 1024 ** 3);
      const dest = join(this.store.jobDir(job.spec.job_id), 'bundle');
      const got = await receiveFile(req, `${dest}.part`, cap);
      if (!got.ok || got.size !== job.spec.bundle.size || got.sha256 !== job.spec.bundle.sha256) {
        rmSync(`${dest}.part`, { force: true });
        return send(res, 400, { error: got.ok ? 'bundle size/sha256 does not match the job spec' : got.error });
      }
      renameSync(`${dest}.part`, dest);
      this.update(job, { state: 'queued' });
      this.queue.push(job.spec.job_id);
      this.kick();
      return send(res, 200, job.view);
    }

    if (req.method === 'POST' && sub === '/cancel') {
      if (TERMINAL_BUILD_JOB_STATES.has(job.view.state)) return send(res, 200, job.view);
      const ctl = this.running.get(job.spec.job_id);
      if (ctl) {
        ctl.abort();
        await this.draining.catch(() => undefined);
        return send(res, 200, this.store.getJob(job.spec.job_id)!.view);
      }
      const i = this.queue.indexOf(job.spec.job_id);
      if (i >= 0) this.queue.splice(i, 1);
      this.update(job, { state: 'cancelled', message: 'cancelled by the Studio' });
      return send(res, 200, job.view);
    }

    if (req.method === 'GET' && sub?.startsWith('/artifacts/')) {
      const name = decodeURIComponent(m[3]!);
      const a = job.view.artifacts.find((x) => x.name === name);
      const outDir = resolve(this.store.jobDir(job.spec.job_id), 'out');
      const file = resolve(outDir, name);
      if (!a || !file.startsWith(outDir + sep) || !existsSync(file)) return send(res, 404, { error: 'no artifact' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(file).size,
        'x-sha256': a.sha256,
      });
      createReadStream(file).pipe(res);
      return;
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  private update(job: StoredJob, patch: Partial<BuildJobView>): void {
    Object.assign(job.view, patch, { updated_at: this.now() });
    this.store.saveJob(job);
  }

  /** Start queued jobs up to the concurrency limit. */
  private kick(): void {
    const max = this.o.maxConcurrentJobs ?? 1;
    while (this.running.size < max && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.store.getJob(id);
      if (!job || job.view.state !== 'queued') continue;
      const ctl = new AbortController();
      this.running.set(id, ctl);
      const p = this.execute(job, ctl).finally(() => {
        this.running.delete(id);
        this.kick();
      });
      this.draining = Promise.all([this.draining, p]).then(() => undefined);
    }
  }

  private async execute(job: StoredJob, ctl: AbortController): Promise<void> {
    const dir = this.store.jobDir(job.spec.job_id);
    const workDir = join(dir, 'work');
    const outDir = join(dir, 'out');
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    const tail: string[] = [];
    const logFile = join(dir, 'log.txt');
    const log = (line: string) => {
      tail.push(line.slice(0, 500));
      if (tail.length > 40) tail.shift();
      void appendFile(logFile, `${line}\n`).catch(() => undefined);
    };
    this.update(job, { state: 'running' });
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), this.o.jobTimeoutMs ?? 60 * 60_000);
    try {
      const r = await this.o.runner.run({
        job: job.spec,
        bundlePath: join(dir, 'bundle'),
        workDir,
        outDir,
        log,
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) throw new RunnerError('export_failed', 'aborted');
      const artifacts = [];
      for (const p of r.artifacts)
        artifacts.push({ name: artifactName(outDir, p), size: fileSize(p), sha256: await hashFile(p) });
      this.update(job, {
        state: 'succeeded',
        signed: r.signed,
        artifacts,
        log_tail: tail,
        run_seconds: Math.round((Date.now() - started) / 1000),
      });
    } catch (e) {
      const aborted = ctl.signal.aborted;
      const timedOut = aborted && (ctl.signal.reason as Error | undefined)?.message === 'timeout';
      this.update(job, {
        state: aborted && !timedOut ? 'cancelled' : 'failed',
        failure: timedOut ? 'timeout' : aborted ? null : e instanceof RunnerError ? e.failure : 'export_failed',
        message: aborted && !timedOut ? 'cancelled by the Studio' : (e as Error).message,
        log_tail: tail,
        run_seconds: Math.round((Date.now() - started) / 1000),
      });
    } finally {
      clearTimeout(timer);
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, cap: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > cap) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return null;
  }
}

async function receiveFile(
  req: IncomingMessage,
  dest: string,
  cap: number,
): Promise<{ ok: true; size: number; sha256: string } | { ok: false; error: string }> {
  const h = createHash('sha256');
  const out = createWriteStream(dest);
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > cap) {
      out.destroy();
      return { ok: false, error: 'bundle larger than declared' };
    }
    h.update(c as Buffer);
    if (!out.write(c)) await new Promise<void>((r) => out.once('drain', () => r()));
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  return { ok: true, size, sha256: h.digest('hex') };
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}
