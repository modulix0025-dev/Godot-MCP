// SPDX-License-Identifier: Apache-2.0
//
// Remote build workers, Studio side (EXECUTION_PROMPT Phase 11).
//
//   RemoteBuildWorkerClient  the HTTPS client for `modulex-build-worker` (protocol in @modulex/shared).
//   pairBuildWorker          one-time code → worker token, kept ONLY in the secret vault (`secret://buildworker/…`);
//                            the database row holds the handle, never the token.
//   BuildJobs                the job system, with the same rules as the ComfyUI jobs (D-044):
//     1. A build_jobs row (job_id, idempotency key, spec) is persisted BEFORE the job is sent.
//     2. Job ids are idempotent on the worker: re-sending the same spec returns the same job. After a Core restart
//        `resume()` asks the worker about every non-terminal row; it never creates a second job for one key.
//     3. A job the worker lost (`worker_restarted`) is retried once with a NEW job id linked to the same key.
//     4. Artifacts are downloaded size-capped and checked against the worker's sha256 before they are recorded.
//     5. Worker minutes go to the cost ledger.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  isAllowedWorkerUrl,
  newBuildJobId,
  TERMINAL_BUILD_JOB_STATES,
  type BuildJobSpec,
  type BuildJobView,
  type BuildWorkerCapabilities,
} from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor, SecretVault } from '../audit/secrets.js';
import type { StudioDb } from '../db/database.js';

export class BuildWorkerError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'unauthorised' | 'rejected' | 'conflict' | 'not_found' | 'artifact_invalid',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class RemoteBuildWorkerClient {
  constructor(
    readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    if (!isAllowedWorkerUrl(url)) throw new BuildWorkerError('rejected', `worker URL must be https:// (got ${url})`);
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.url}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` },
      });
    } catch (e) {
      throw new BuildWorkerError('unreachable', `worker unreachable: ${(e as Error).message}`);
    }
    if (r.status === 401) throw new BuildWorkerError('unauthorised', 'worker rejected the token', 401);
    if (r.status === 404) throw new BuildWorkerError('not_found', `${path}: not found`, 404);
    if (r.status === 409) throw new BuildWorkerError('conflict', `${path}: job id conflict`, 409);
    if (r.status >= 400) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new BuildWorkerError('rejected', `${path}: ${body.error ?? r.status}`, r.status);
    }
    return r;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  health(): Promise<{ ok: boolean; worker_id: string; running: number; queued: number }> {
    return this.json('/v1/health');
  }

  capabilities(): Promise<BuildWorkerCapabilities> {
    return this.json('/v1/capabilities');
  }

  submit(spec: BuildJobSpec): Promise<BuildJobView> {
    return this.json('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
  }

  upload(jobId: string, bundlePath: string): Promise<BuildJobView> {
    return this.json(`/v1/jobs/${jobId}/bundle`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(statSync(bundlePath).size) },
      body: Readable.toWeb(createReadStream(bundlePath)) as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
  }

  get(jobId: string): Promise<BuildJobView> {
    return this.json(`/v1/jobs/${jobId}`);
  }

  cancel(jobId: string): Promise<BuildJobView> {
    return this.json(`/v1/jobs/${jobId}/cancel`, { method: 'POST' });
  }

  /** Download one artifact into `dest`, refusing anything larger than `size` or with a different sha256. */
  async download(jobId: string, a: { name: string; size: number; sha256: string }, dest: string): Promise<void> {
    const r = await this.req(`/v1/jobs/${jobId}/artifacts/${encodeURIComponent(a.name)}`);
    if (!r.body) throw new BuildWorkerError('artifact_invalid', `${a.name}: empty response`);
    mkdirSync(dirname(dest), { recursive: true });
    const h = createHash('sha256');
    let size = 0;
    const part = `${dest}.part`;
    try {
      await pipeline(
        Readable.fromWeb(r.body as never),
        async function* (src: AsyncIterable<Buffer>) {
          for await (const c of src) {
            size += c.length;
            if (size > a.size) throw new BuildWorkerError('artifact_invalid', `${a.name}: larger than declared`);
            h.update(c);
            yield c;
          }
        },
        createWriteStream(part),
      );
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    if (size !== a.size || h.digest('hex') !== a.sha256) {
      rmSync(part, { force: true });
      throw new BuildWorkerError('artifact_invalid', `${a.name}: size or sha256 does not match the worker's record`);
    }
    renameSync(part, dest);
  }
}

export interface BuildWorkerRecord {
  worker_id: string;
  url: string;
  name: string;
  token_ref: string;
  paired_at: string;
  capabilities: BuildWorkerCapabilities | null;
}

export interface WritableVault extends SecretVault {
  set(ref: string, value: string): void;
}

export function tokenRefFor(workerId: string): string {
  return `secret://buildworker/${workerId.replace(/[^a-z0-9]/g, '').slice(0, 40) || 'worker'}/token`;
}

/** Pair with a worker: exchange the one-time code, keep the token in the vault, record only the handle. */
export async function pairBuildWorker(o: {
  url: string;
  code: string;
  name: string;
  db: StudioDb;
  vault: WritableVault;
  redactor?: Redactor;
  audit?: AuditLog | null;
  fetchImpl?: Fetch;
}): Promise<BuildWorkerRecord> {
  if (!isAllowedWorkerUrl(o.url)) throw new BuildWorkerError('rejected', 'worker URL must be https://');
  let r: Response;
  try {
    r = await (o.fetchImpl ?? fetch)(`${o.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: o.code.trim().toUpperCase(), studio: 'ModuleX Game Studio' }),
    });
  } catch (e) {
    throw new BuildWorkerError('unreachable', `worker unreachable: ${(e as Error).message}`);
  }
  if (!r.ok) throw new BuildWorkerError('rejected', 'pairing refused (wrong or expired code)', r.status);
  const { worker_id, token } = (await r.json()) as { worker_id: string; token: string };
  o.redactor?.register(token);
  const token_ref = tokenRefFor(worker_id);
  o.vault.set(token_ref, token);
  const client = new RemoteBuildWorkerClient(o.url, token, o.fetchImpl);
  const capabilities = await client.capabilities().catch(() => null);
  const now = new Date().toISOString();
  o.db.run(
    `INSERT INTO build_workers (worker_id, url, name, token_ref, data, paired_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (worker_id) DO UPDATE SET url = excluded.url, name = excluded.name, token_ref = excluded.token_ref,
       data = excluded.data, updated_at = excluded.updated_at`,
    worker_id,
    o.url,
    o.name,
    token_ref,
    JSON.stringify({ capabilities }),
    now,
    now,
  );
  o.audit?.append('worker_registered', 'owner', { worker_id, kind: 'build', platforms: capabilities?.platforms ?? [] });
  return { worker_id, url: o.url, name: o.name, token_ref, paired_at: now, capabilities };
}

export function listBuildWorkers(db: StudioDb): BuildWorkerRecord[] {
  return db
    .all<{ worker_id: string; url: string; name: string; token_ref: string; data: string; paired_at: string }>(
      'SELECT worker_id, url, name, token_ref, data, paired_at FROM build_workers ORDER BY paired_at',
    )
    .map((r) => ({
      worker_id: r.worker_id,
      url: r.url,
      name: r.name,
      token_ref: r.token_ref,
      paired_at: r.paired_at,
      capabilities: (JSON.parse(r.data) as { capabilities: BuildWorkerCapabilities | null }).capabilities,
    }));
}

export interface RemoteBuildRequest {
  /** Stable per build intent, e.g. `<project>|ios|RELEASE|1.2.0|<bundle sha>`; one completed job per key. */
  idempotencyKey: string;
  projectId: string;
  platform: BuildJobSpec['platform'];
  profile: BuildJobSpec['profile'];
  preset: string;
  version: string;
  assembly: string;
  godotVersion: string;
  bundlePath: string;
  signingProfile: string | null;
  /** Where verified artifacts are written (never inside res://). */
  outDir: string;
}

export interface RemoteBuildResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
  job_id: string | null;
  worker_id: string | null;
  signed: boolean;
  artifacts: { path: string; sha256: string; size: number }[];
  message: string;
  attempts: number;
  cached: boolean;
}

interface JobRow {
  job_id: string;
  idempotency_key: string;
  worker_id: string;
  project_id: string;
  platform: string;
  state: string;
  attempt: number;
  spec: string;
  view: string | null;
  local: string;
}

export interface BuildJobsOptions {
  db: StudioDb;
  vault: SecretVault;
  redactor?: Redactor;
  audit?: AuditLog | null;
  fetchImpl?: Fetch;
  pollMs?: number;
  /** USD per worker minute for the cost ledger (0 for an owner-run Mac). */
  usdPerMinute?: (workerId: string) => number;
  /** Max wall time to follow one job (default 2 h). */
  followTimeoutMs?: number;
}

const MAX_ATTEMPTS = 2;

export class BuildJobs {
  constructor(private readonly o: BuildJobsOptions) {}

  private async client(workerId: string): Promise<RemoteBuildWorkerClient> {
    const w = listBuildWorkers(this.o.db).find((x) => x.worker_id === workerId);
    if (!w) throw new BuildWorkerError('not_found', `build worker ${workerId} is not paired`);
    const token = await this.o.vault.resolve(w.token_ref);
    if (!token) throw new BuildWorkerError('unauthorised', `no credential for build worker ${workerId}`);
    this.o.redactor?.register(token);
    return new RemoteBuildWorkerClient(w.url, token, this.o.fetchImpl);
  }

  /** A paired worker that is online and supports the platform (and the signing profile, when one is named). */
  async pickWorker(platform: BuildJobSpec['platform'], signingProfile: string | null): Promise<string | null> {
    for (const w of listBuildWorkers(this.o.db)) {
      try {
        const c = await (await this.client(w.worker_id)).capabilities();
        if (!c.platforms.includes(platform)) continue;
        if (signingProfile && !c.signing_profiles.includes(signingProfile)) continue;
        return w.worker_id;
      } catch {
        // offline / unauthorised workers are skipped; the caller reports BLOCKED when none is usable
      }
    }
    return null;
  }

  rows(idempotencyKey?: string): JobRow[] {
    return idempotencyKey
      ? this.o.db.all<JobRow>('SELECT * FROM build_jobs WHERE idempotency_key = ? ORDER BY attempt', idempotencyKey)
      : this.o.db.all<JobRow>('SELECT * FROM build_jobs ORDER BY created_at');
  }

  private save(row: JobRow): void {
    const now = new Date().toISOString();
    this.o.db.run(
      `INSERT INTO build_jobs (job_id, idempotency_key, worker_id, project_id, platform, state, attempt, spec, view, local,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET state = excluded.state, view = excluded.view, local = excluded.local,
         updated_at = excluded.updated_at`,
      row.job_id,
      row.idempotency_key,
      row.worker_id,
      row.project_id,
      row.platform,
      row.state,
      row.attempt,
      row.spec,
      row.view,
      row.local,
      now,
      now,
    );
  }

  /** Run (or join, or return the cached result of) the build for this idempotency key. */
  async run(req: RemoteBuildRequest, signal?: AbortSignal): Promise<RemoteBuildResult> {
    const prior = this.rows(req.idempotencyKey);
    const done = prior.find((r) => r.state === 'succeeded' && downloaded(r));
    if (done) return this.resultOf(done);
    const open = prior.find((r) => unfinished(r));
    if (open) return this.follow(open, req, signal);

    const workerId = await this.pickWorker(req.platform, req.signingProfile);
    if (!workerId)
      return {
        status: 'BLOCKED',
        job_id: null,
        worker_id: null,
        signed: false,
        artifacts: [],
        message:
          req.platform === 'ios'
            ? 'macOS/Xcode build worker required (none paired and online with this signing profile)'
            : `no paired build worker online for ${req.platform}`,
        attempts: prior.length,
        cached: false,
      };
    return this.follow(this.newRow(req, workerId, prior.length + 1), req, signal);
  }

  private newRow(req: RemoteBuildRequest, workerId: string, attempt: number): JobRow {
    const bytes = readFileSync(req.bundlePath);
    const spec: BuildJobSpec = {
      job_id: newBuildJobId(),
      project_id: req.projectId,
      platform: req.platform,
      profile: req.profile,
      godot_version: req.godotVersion,
      preset: req.preset,
      version: req.version,
      assembly: req.assembly,
      bundle: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
      signing_profile: req.signingProfile,
    };
    const row: JobRow = {
      job_id: spec.job_id,
      idempotency_key: req.idempotencyKey,
      worker_id: workerId,
      project_id: req.projectId,
      platform: req.platform,
      state: 'submitting',
      attempt,
      spec: JSON.stringify(spec),
      view: null,
      local: JSON.stringify({ bundlePath: req.bundlePath, outDir: req.outDir }),
    };
    this.save(row); // persisted BEFORE the worker hears about it
    this.o.audit?.append('build_job_submitted', 'system', {
      job_id: spec.job_id,
      worker_id: workerId,
      project_id: req.projectId,
      platform: req.platform,
      attempt,
    });
    return row;
  }

  /** Drive one job to a terminal state: (re)submit idempotently, upload, poll, download + verify. */
  private async follow(
    row: JobRow,
    given: RemoteBuildRequest | null,
    signal?: AbortSignal,
  ): Promise<RemoteBuildResult> {
    const spec = JSON.parse(row.spec) as BuildJobSpec;
    const local = JSON.parse(row.local) as { bundlePath: string; outDir: string };
    const req: RemoteBuildRequest = given ?? {
      idempotencyKey: row.idempotency_key,
      projectId: spec.project_id,
      platform: spec.platform,
      profile: spec.profile,
      preset: spec.preset,
      version: spec.version,
      assembly: spec.assembly,
      godotVersion: spec.godot_version,
      bundlePath: local.bundlePath,
      signingProfile: spec.signing_profile,
      outDir: local.outDir,
    };
    let client: RemoteBuildWorkerClient;
    try {
      client = await this.client(row.worker_id);
    } catch (e) {
      return this.blocked(row, (e as Error).message);
    }
    const deadline = Date.now() + (this.o.followTimeoutMs ?? 2 * 3600_000);
    let view: BuildJobView;
    try {
      // POST is idempotent by job_id: after a restart it returns the job the worker already has.
      view = row.state === 'submitting' ? await client.submit(spec) : await client.get(spec.job_id);
    } catch (e) {
      if (e instanceof BuildWorkerError && e.kind === 'not_found') view = await client.submit(spec);
      else if (e instanceof BuildWorkerError && e.kind === 'unreachable') return this.blocked(row, e.message);
      else throw e;
    }
    this.record(row, view);
    while (!TERMINAL_BUILD_JOB_STATES.has(view.state)) {
      if (signal?.aborted) {
        view = await client.cancel(spec.job_id);
        this.record(row, view);
        break;
      }
      if (Date.now() > deadline)
        return this.blocked(row, 'build worker did not finish in time; resume to keep following');
      try {
        if (view.state === 'awaiting_bundle') view = await client.upload(spec.job_id, local.bundlePath);
        else {
          await new Promise((r) => setTimeout(r, this.o.pollMs ?? 2000));
          view = await client.get(spec.job_id);
        }
      } catch (e) {
        if (e instanceof BuildWorkerError && e.kind === 'unreachable') return this.blocked(row, e.message);
        throw e;
      }
      this.record(row, view);
    }

    if (view.state === 'cancelled') return this.finish(row, 'CANCELLED', view, [], view.message ?? 'cancelled');
    if (view.state === 'failed') {
      if (view.failure === 'worker_restarted' && row.attempt < MAX_ATTEMPTS) {
        // The worker lost the job: retry ONCE with a new job id linked to the same idempotency key.
        return this.follow(this.newRow(req, row.worker_id, row.attempt + 1), req, signal);
      }
      return this.finish(row, 'FAILED', view, [], `${view.failure ?? 'failed'}: ${view.message ?? ''}`.trim());
    }

    const artifacts: RemoteBuildResult['artifacts'] = [];
    const root = resolve(local.outDir);
    for (const a of view.artifacts) {
      const dest = resolve(root, a.name);
      if (!dest.startsWith(root + sep)) throw new BuildWorkerError('artifact_invalid', `bad artifact name ${a.name}`);
      await client.download(spec.job_id, a, dest);
      artifacts.push({ path: dest, sha256: a.sha256, size: a.size });
    }
    const minutes = view.run_seconds / 60;
    this.o.db.addCost({
      project_id: row.project_id,
      kind: 'build_worker_minutes',
      ref: spec.job_id,
      quantity: Math.round(minutes * 100) / 100,
      unit: 'minute',
      usd: minutes * (this.o.usdPerMinute?.(row.worker_id) ?? 0),
    });
    return this.finish(row, 'SUCCEEDED', view, artifacts, view.signed ? 'signed build' : 'built');
  }

  private record(row: JobRow, view: BuildJobView): void {
    row.state = view.state;
    row.view = JSON.stringify(view);
    this.save(row);
  }

  private blocked(row: JobRow, message: string): RemoteBuildResult {
    return {
      status: 'BLOCKED',
      job_id: row.job_id,
      worker_id: row.worker_id,
      signed: false,
      artifacts: [],
      message,
      attempts: row.attempt,
      cached: false,
    };
  }

  private finish(
    row: JobRow,
    status: RemoteBuildResult['status'],
    view: BuildJobView,
    artifacts: RemoteBuildResult['artifacts'],
    message: string,
  ): RemoteBuildResult {
    const local = { ...(JSON.parse(row.local) as object), artifacts };
    row.local = JSON.stringify(local);
    this.save(row);
    this.o.audit?.append('build_completed', 'system', {
      job_id: row.job_id,
      worker_id: row.worker_id,
      project_id: row.project_id,
      platform: row.platform,
      status,
      signed: view.signed,
    });
    return {
      status,
      job_id: row.job_id,
      worker_id: row.worker_id,
      signed: view.signed,
      artifacts,
      message,
      attempts: row.attempt,
      cached: false,
    };
  }

  private resultOf(row: JobRow): RemoteBuildResult {
    const view = JSON.parse(row.view ?? '{}') as Partial<BuildJobView>;
    const local = JSON.parse(row.local) as { artifacts?: RemoteBuildResult['artifacts'] };
    return {
      status: 'SUCCEEDED',
      job_id: row.job_id,
      worker_id: row.worker_id,
      signed: Boolean(view.signed),
      artifacts: local.artifacts ?? [],
      message: view.signed ? 'signed build' : 'built',
      attempts: row.attempt,
      cached: true,
    };
  }

  /**
   * Core start: follow every job that was not terminal when Core stopped. Uses the persisted job ids only, so a
   * kill -9 between "row written" and "worker answered" never produces a second job.
   */
  async resume(): Promise<RemoteBuildResult[]> {
    const out: RemoteBuildResult[] = [];
    for (const row of this.rows()) if (unfinished(row)) out.push(await this.follow(row, null));
    return out;
  }
}

/** Artifacts verified and written locally (the last step of a successful job). */
function downloaded(row: JobRow): boolean {
  return Array.isArray((JSON.parse(row.local) as { artifacts?: unknown }).artifacts);
}

/** Not terminal on the worker, or succeeded there but not yet downloaded here. */
function unfinished(row: JobRow): boolean {
  return !TERMINAL_BUILD_JOB_STATES.has(row.state as never) || (row.state === 'succeeded' && !downloaded(row));
}
