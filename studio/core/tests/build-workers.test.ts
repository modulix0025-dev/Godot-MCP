// SPDX-License-Identifier: Apache-2.0
//
// GATE 11 (mock worker suite). The REAL modulex-build-worker service runs in-process on loopback with a fake export
// runner (there is no macOS host here; the live Mac test is BLOCKED and says so below). Covers: pairing (token only
// in the vault), idempotency (one job per key, cached result), cancel, resume after a Core kill (no duplicate job),
// a worker restart mid-job (one retry with a new job id), artifact sha256 verification, the cost ledger, and the
// BuildService iOS path: SIGNED with a worker, PREPARED without one.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerError, WorkerService, type BuildRunner, type RunContext } from '../../worker/src/index.js';
import { MemoryVault, Redactor } from '../src/audit/secrets.js';
import { BuildJobs, listBuildWorkers, pairBuildWorker, type RemoteBuildRequest } from '../src/build/build-workers.js';
import { BuildService } from '../src/build/build-service.js';
import { StudioDb } from '../src/db/database.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-g11-'));

class FakeMacRunner implements BuildRunner {
  runs: string[] = [];
  hold: Promise<void> = Promise.resolve();
  fail: RunnerError | null = null;
  async capabilities() {
    return {
      os: 'darwin',
      platforms: ['ios' as const, 'macos' as const],
      godot_version: '4.5.1.stable.mono.official',
      xcode_version: 'Xcode 16.0',
      signing_profiles: ['AppStore'],
    };
  }
  async run(ctx: RunContext) {
    this.runs.push(ctx.job.job_id);
    // The bundle really is a git bundle of the project: clone it like the real runner does.
    execFileSync('git', ['clone', '-q', ctx.bundlePath, join(ctx.workDir, 'src')]);
    await Promise.race([
      this.hold,
      new Promise((_, j) => ctx.signal.addEventListener('abort', () => j(new Error('aborted')))),
    ]);
    if (this.fail) throw this.fail;
    const ipa = join(ctx.outDir, `${ctx.job.assembly}.ipa`);
    writeFileSync(ipa, `signed:${ctx.job.job_id}`);
    return { signed: true, artifacts: [ipa] };
  }
}

const services: WorkerService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
});

async function worker(dir = tmp(), runner = new FakeMacRunner(), port = 0) {
  const svc = new WorkerService({ stateDir: dir, runner, port });
  services.push(svc);
  const { url, port: p } = await svc.listen();
  return { svc, url, runner, dir, port: p };
}

function project(): { dir: string; bundle: string } {
  const dir = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'project.godot'), '[application]\nconfig/name="Space Kid"\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  const bundle = join(tmp(), 'ios-prep.bundle');
  execFileSync('git', ['-C', dir, 'bundle', 'create', bundle, 'HEAD'], { stdio: 'ignore' });
  return { dir, bundle };
}

function request(bundle: string, out = tmp(), key = 'space-kid|ios|RELEASE|1.0.0|abc'): RemoteBuildRequest {
  return {
    idempotencyKey: key,
    projectId: 'space-kid',
    platform: 'ios',
    profile: 'RELEASE',
    preset: 'iOS',
    version: '1.0.0',
    assembly: 'SpaceKid',
    godotVersion: '4.5.1',
    bundlePath: bundle,
    signingProfile: 'AppStore',
    outDir: out,
  };
}

async function paired(url: string, svc: WorkerService, dbPath = join(tmp(), 'studio.db')) {
  const db = new StudioDb(dbPath);
  const redactor = new Redactor();
  const vault = new MemoryVault(redactor);
  const rec = await pairBuildWorker({ url, code: svc.store.newPairingCode(), name: 'Mac mini', db, vault, redactor });
  return { db, vault, redactor, rec, dbPath };
}

describe('GATE 11 — remote build workers (mock worker suite)', () => {
  it('pairing keeps the token in the vault only; the database holds the handle', async () => {
    const { svc, url } = await worker();
    const { db, vault, rec } = await paired(url, svc);
    expect(rec.token_ref).toMatch(/^secret:\/\/buildworker\/[a-z0-9]+\/token$/);
    const token = await vault.resolve(rec.token_ref);
    expect(token).toMatch(/^mxw_/);
    const dump = JSON.stringify(db.all('SELECT * FROM build_workers'));
    expect(dump).not.toContain(token!);
    expect(listBuildWorkers(db)[0]!.capabilities).toMatchObject({ platforms: ['ios', 'macos'] });
    await expect(pairBuildWorker({ url, code: 'AAAA-AAAA', name: 'x', db, vault })).rejects.toThrow(/pairing refused/);
    await expect(
      pairBuildWorker({ url: 'http://10.0.0.5:47830', code: 'AAAA-AAAA', name: 'x', db, vault }),
    ).rejects.toThrow(/https/);
  });

  it('idempotency: one worker job per key; the second call returns the cached, verified result', async () => {
    const { svc, url, runner } = await worker();
    const { db, vault } = await paired(url, svc);
    const jobs = new BuildJobs({ db, vault, pollMs: 20 });
    const { bundle } = project();
    const out = tmp();
    const first = await jobs.run(request(bundle, out));
    expect(first).toMatchObject({ status: 'SUCCEEDED', signed: true, cached: false, attempts: 1 });
    const ipa = first.artifacts[0]!;
    expect(createHash('sha256').update(readFileSync(ipa.path)).digest('hex')).toBe(ipa.sha256);
    const again = await jobs.run(request(bundle, out));
    expect(again).toMatchObject({ status: 'SUCCEEDED', cached: true, job_id: first.job_id });
    expect(runner.runs).toHaveLength(1);
    expect(db.all('SELECT job_id FROM build_jobs')).toHaveLength(1);
    expect(db.all("SELECT * FROM cost_ledger WHERE kind = 'build_worker_minutes'")).toHaveLength(1);
  });

  it('cancel: an aborted build cancels the worker job', async () => {
    const runner = new FakeMacRunner();
    runner.hold = new Promise(() => undefined);
    const { svc, url } = await worker(tmp(), runner);
    const { db, vault } = await paired(url, svc);
    const jobs = new BuildJobs({ db, vault, pollMs: 20 });
    const ctl = new AbortController();
    const p = jobs.run(request(project().bundle), ctl.signal);
    for (let i = 0; i < 200 && runner.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    const r = await p;
    expect(r.status).toBe('CANCELLED');
    expect(svc.store.getJob(r.job_id!)!.view.state).toBe('cancelled');
  });

  it('kill -9 of Core mid-build: resume follows the same job; no duplicate job on the worker', async () => {
    const runner = new FakeMacRunner();
    let release!: () => void;
    runner.hold = new Promise((r) => (release = r));
    const { svc, url, dir } = await worker(tmp(), runner);
    const { db, vault, dbPath } = await paired(url, svc);
    // "Core #1": its network dies the moment the job is running (the process is gone; nothing more is sent).
    let dead = false;
    const deadFetch: typeof fetch = (input, init) =>
      dead ? Promise.reject(new Error('core killed')) : fetch(input, init);
    const core1 = new BuildJobs({ db, vault, pollMs: 20, fetchImpl: deadFetch });
    const p1 = core1.run(request(project().bundle));
    for (let i = 0; i < 300 && runner.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    dead = true;
    expect((await p1).status).toBe('BLOCKED');
    db.close();

    // "Core #2": a fresh process on the same studio.db and credential store.
    release();
    const db2 = new StudioDb(dbPath);
    const core2 = new BuildJobs({ db: db2, vault, pollMs: 20 });
    const resumed = await core2.resume();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ status: 'SUCCEEDED', signed: true });
    expect(runner.runs).toHaveLength(1);
    expect(readdirSync(join(dir, 'jobs'))).toHaveLength(1);
    expect(db2.all('SELECT job_id FROM build_jobs')).toHaveLength(1);
  });

  it('kill -9 between "row written" and "worker answered": resume submits the SAME job id once', async () => {
    const { svc, url, runner, dir } = await worker();
    const { db, vault } = await paired(url, svc);
    let calls = 0;
    const dropFirstPost: typeof fetch = (input, init) =>
      init?.method === 'POST' && String(input).endsWith('/v1/jobs') && calls++ === 0
        ? Promise.reject(new Error('connection reset'))
        : fetch(input, init);
    const jobs = new BuildJobs({ db, vault, pollMs: 20, fetchImpl: dropFirstPost });
    const r1 = await jobs.run(request(project().bundle));
    expect(r1.status).toBe('BLOCKED');
    const [row] = db.all<{ job_id: string; state: string }>('SELECT job_id, state FROM build_jobs');
    expect(row!.state).toBe('submitting');
    const [r2] = await jobs.resume();
    expect(r2).toMatchObject({ status: 'SUCCEEDED', job_id: row!.job_id });
    expect(runner.runs).toEqual([row!.job_id]);
    expect(readdirSync(join(dir, 'jobs'))).toEqual([row!.job_id]);
  });

  it('a worker restart mid-job is retried once with a new job id for the same key', async () => {
    const dir = tmp();
    const r1 = new FakeMacRunner();
    r1.hold = new Promise(() => undefined);
    const w1 = await worker(dir, r1);
    const { db, vault } = await paired(w1.url, w1.svc);
    const jobs = new BuildJobs({ db, vault, pollMs: 20 });
    const p = jobs.run(request(project().bundle));
    for (let i = 0; i < 300 && r1.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // The worker host restarts: the old process stops answering; a new one starts on the same state and port.
    const old = w1.svc.store.getJob(r1.runs[0]!)!;
    services.splice(services.indexOf(w1.svc), 1);
    await w1.svc.close();
    w1.svc.store.saveJob({ ...old, view: { ...old.view, state: 'running' } });
    const w2 = await worker(dir, new FakeMacRunner(), w1.port);
    const r = await p.catch((e: Error) => ({ status: `threw ${e.message}` }) as never);
    if ((r as { status: string }).status === 'BLOCKED') {
      // The poll may have hit the restart window: resume continues on the new worker process.
      const [again] = await jobs.resume();
      expect(again).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    } else expect(r).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    const rows = db.all<{ attempt: number }>('SELECT attempt FROM build_jobs ORDER BY attempt');
    expect(rows.map((x) => x.attempt)).toEqual([1, 2]);
    void w2;
  });

  it('a tampered artifact is rejected (sha256 mismatch)', async () => {
    const { svc, url } = await worker();
    const { db, vault } = await paired(url, svc);
    const tamper: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      return String(input).includes('/artifacts/') ? new Response('tampered!', { status: 200 }) : r;
    };
    const jobs = new BuildJobs({ db, vault, pollMs: 20, fetchImpl: tamper });
    await expect(jobs.run(request(project().bundle))).rejects.toThrow(/sha256|larger/);
  });

  it('a runner failure is FAILED with its class, never retried as a lost job', async () => {
    const runner = new FakeMacRunner();
    runner.fail = new RunnerError('signing_failed', 'xcodebuild -exportArchive exited with 70');
    const { svc, url } = await worker(tmp(), runner);
    const { db, vault } = await paired(url, svc);
    const r = await new BuildJobs({ db, vault, pollMs: 20 }).run(request(project().bundle));
    expect(r).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(r.message).toMatch(/signing_failed/);
  });

  it('BuildService iOS: SIGNED through a paired macOS worker; PREPARED without one', async () => {
    const { svc, url } = await worker();
    const { db, vault } = await paired(url, svc);
    const { dir } = project();
    const req = {
      projectId: 'space-kid',
      projectDir: dir,
      assembly: 'SpaceKid',
      platform: 'ios' as const,
      profile: 'RELEASE' as const,
      version: '1.0.0',
    };
    const signed = await new BuildService({
      godot: 'unused',
      db,
      remote: new BuildJobs({ db, vault, pollMs: 20 }),
      iosSigningProfile: 'AppStore',
    }).build(req);
    expect(signed.status).toBe('SIGNED');
    expect(signed.artifacts.some((a) => a.path.endsWith('.ipa') && existsSync(a.path))).toBe(true);

    await svc.close();
    services.splice(services.indexOf(svc), 1);
    const offline = await new BuildService({
      godot: 'unused',
      db: new StudioDb(':memory:'),
      remote: new BuildJobs({ db: new StudioDb(':memory:'), vault, pollMs: 20 }),
      iosSigningProfile: 'AppStore',
    }).build({ ...req, version: '1.0.1' });
    expect(offline.status).toBe('PREPARED');
    expect(offline.note).toMatch(/macOS\/Xcode build worker required/);
  });

  it('live macOS worker: BLOCKED — no Mac host in this environment', () => {
    if (!process.env.MODULEX_LIVE_MAC_WORKER) {
      console.log('[gate11] live macOS signing: not exercised — BLOCKED (no macOS build worker available)');
      return;
    }
    throw new Error('MODULEX_LIVE_MAC_WORKER is set but the live Mac test is not implemented in this build');
  });
});
