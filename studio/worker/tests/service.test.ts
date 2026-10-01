// SPDX-License-Identifier: Apache-2.0
//
// modulex-build-worker service over real loopback HTTP with a fake runner: pairing, auth, idempotent jobs, bundle
// verification, cancel, artifact download, worker restart, and the TLS-or-loopback rule.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newBuildJobId, type BuildJobSpec, type BuildJobView } from '@modulex/shared';
import { RunnerError, setPresetOptions, WorkerService, type BuildRunner, type RunContext } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-bw-'));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

class FakeRunner implements BuildRunner {
  runs: string[] = [];
  gate: Promise<void> = Promise.resolve();
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
    ctx.log('exporting');
    await Promise.race([
      this.gate,
      new Promise((_, j) => ctx.signal.addEventListener('abort', () => j(new Error('aborted')))),
    ]);
    if (this.fail) throw this.fail;
    const ipa = join(ctx.outDir, `${ctx.job.assembly}.ipa`);
    writeFileSync(ipa, `signed ipa for ${ctx.job.job_id}`);
    return { signed: ctx.job.signing_profile !== null, artifacts: [ipa] };
  }
}

const services: WorkerService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
});

async function start(dir = tmp(), runner = new FakeRunner()) {
  const svc = new WorkerService({ stateDir: dir, runner });
  services.push(svc);
  const { url } = await svc.listen();
  return { svc, url, runner, dir };
}

async function pair(svc: WorkerService, url: string): Promise<string> {
  const code = svc.store.newPairingCode();
  const r = await fetch(`${url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, studio: 'test' }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

function spec(bundle: Buffer, over: Partial<BuildJobSpec> = {}): BuildJobSpec {
  return {
    job_id: newBuildJobId(),
    project_id: 'space-kid',
    platform: 'ios',
    profile: 'RELEASE',
    godot_version: '4.5.1',
    preset: 'iOS',
    version: '1.0.0',
    assembly: 'SpaceKid',
    bundle: { sha256: sha(bundle), size: bundle.length },
    signing_profile: 'AppStore',
    ...over,
  };
}

const api =
  (url: string, token: string) =>
  async (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });

async function until(get: () => Promise<BuildJobView>, states: string[]): Promise<BuildJobView> {
  for (let i = 0; i < 200; i++) {
    const v = await get();
    if (states.includes(v.state)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

describe('pairing and auth', () => {
  it('a one-time code yields a token once; wrong, reused and burnt codes are refused', async () => {
    const { svc, url } = await start();
    expect((await fetch(`${url}/v1/health`)).status).toBe(401);
    const code = svc.store.newPairingCode();
    const post = (c: string) =>
      fetch(`${url}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c, studio: 'test' }),
      });
    expect((await post('ZZZZ-ZZZZ')).status).toBe(403);
    const ok = await post(code);
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    expect((await post(code)).status).toBe(403); // single use
    expect((await api(url, token)('/v1/health')).status).toBe(200);
    expect((await api(url, 'mxw_wrong')('/v1/health')).status).toBe(401);
    // Only the hash is stored.
    expect(JSON.stringify(svc.store.state())).not.toContain(token);

    const code2 = svc.store.newPairingCode();
    for (let i = 0; i < 5; i++) await post('AAAA-AAAA');
    expect((await post(code2)).status).toBe(403); // burnt after 5 wrong attempts
  });

  it('an expired code is refused', async () => {
    const { svc } = await start();
    const code = svc.store.newPairingCode(1000, Date.now() - 5000);
    expect(svc.store.pair(code, 'x')).toBeNull();
  });

  it('refuses plain HTTP on a reachable interface', () => {
    expect(() => new WorkerService({ stateDir: tmp(), runner: new FakeRunner(), host: '0.0.0.0' })).toThrow(/TLS/);
  });

  it('capabilities list signing profiles by name only', async () => {
    const { svc, url } = await start();
    const c = (await (await api(url, await pair(svc, url))('/v1/capabilities')).json()) as Record<string, unknown>;
    expect(c).toMatchObject({ platforms: ['ios', 'macos'], signing_profiles: ['AppStore'], worker_version: '0.1.0' });
  });
});

describe('jobs', () => {
  it('idempotent submit, sha-checked upload, run, artifact download with sha256', async () => {
    const { svc, url, runner } = await start();
    const call = api(url, await pair(svc, url));
    const bundle = Buffer.from('git bundle bytes');
    const s = spec(bundle);
    const post = (body: unknown) =>
      call('/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(s)).status).toBe(201);
    expect((await post(s)).status).toBe(200); // same spec, same job
    expect((await post({ ...s, version: '2.0.0' })).status).toBe(409); // different spec, same id
    expect((await post({ ...s, job_id: 'bj_bad' })).status).toBe(400);

    const bad = await call(`/v1/jobs/${s.job_id}/bundle`, { method: 'PUT', body: Buffer.from('tampered bytes!!') });
    expect(bad.status).toBe(400);
    const up = await call(`/v1/jobs/${s.job_id}/bundle`, { method: 'PUT', body: bundle });
    expect(up.status).toBe(200);
    const v = await until(
      async () => (await (await call(`/v1/jobs/${s.job_id}`)).json()) as BuildJobView,
      ['succeeded', 'failed'],
    );
    expect(v).toMatchObject({ state: 'succeeded', signed: true });
    expect(v.artifacts).toHaveLength(1);
    expect(runner.runs).toEqual([s.job_id]);
    const a = v.artifacts[0]!;
    const got = Buffer.from(await (await call(`/v1/jobs/${s.job_id}/artifacts/${a.name}`)).arrayBuffer());
    expect(sha(got)).toBe(a.sha256);
    expect((await call(`/v1/jobs/${s.job_id}/artifacts/..%2Fjob.json`)).status).toBe(404);
    // Re-uploading after the job ran is a no-op, never a second run.
    await call(`/v1/jobs/${s.job_id}/bundle`, { method: 'PUT', body: bundle });
    expect(runner.runs).toHaveLength(1);
    void svc;
  });

  it('cancel stops a running job; runner failures carry their class', async () => {
    const runner = new FakeRunner();
    let release!: () => void;
    runner.gate = new Promise((r) => (release = r));
    const { svc, url } = await start(tmp(), runner);
    const call = api(url, await pair(svc, url));
    const bundle = Buffer.from('b');
    const s = spec(bundle);
    await call('/v1/jobs', { method: 'POST', body: JSON.stringify(s) });
    await call(`/v1/jobs/${s.job_id}/bundle`, { method: 'PUT', body: bundle });
    await until(async () => (await (await call(`/v1/jobs/${s.job_id}`)).json()) as BuildJobView, ['running']);
    const c = (await (await call(`/v1/jobs/${s.job_id}/cancel`, { method: 'POST' })).json()) as BuildJobView;
    expect(c.state).toBe('cancelled');
    release();

    runner.fail = new RunnerError('signing_profile_missing', "signing profile 'X' is not configured");
    const s2 = spec(bundle);
    await call('/v1/jobs', { method: 'POST', body: JSON.stringify(s2) });
    await call(`/v1/jobs/${s2.job_id}/bundle`, { method: 'PUT', body: bundle });
    const f = await until(async () => (await (await call(`/v1/jobs/${s2.job_id}`)).json()) as BuildJobView, ['failed']);
    expect(f).toMatchObject({ failure: 'signing_profile_missing' });
  });

  it('a worker restart marks a running job worker_restarted and re-queues queued ones', async () => {
    const dir = tmp();
    const runner = new FakeRunner();
    runner.gate = new Promise(() => undefined); // never finishes
    const first = await start(dir, runner);
    const token = await pair(first.svc, first.url);
    const call = api(first.url, token);
    const bundle = Buffer.from('b');
    const a = spec(bundle);
    const b = spec(bundle);
    for (const s of [a, b]) {
      await call('/v1/jobs', { method: 'POST', body: JSON.stringify(s) });
      await call(`/v1/jobs/${s.job_id}/bundle`, { method: 'PUT', body: bundle });
    }
    await until(async () => (await (await call(`/v1/jobs/${a.job_id}`)).json()) as BuildJobView, ['running']);
    // Simulate a crash: the stored state says running/queued, then a new process starts on the same state dir.
    first.svc.store.saveJob({
      ...first.svc.store.getJob(a.job_id)!,
      view: { ...first.svc.store.getJob(a.job_id)!.view, state: 'running' },
    });
    const second = await start(dir, new FakeRunner());
    const call2 = api(second.url, token); // the pairing survives the restart
    expect(((await (await call2(`/v1/jobs/${a.job_id}`)).json()) as BuildJobView).failure).toBe('worker_restarted');
    const vb = await until(
      async () => (await (await call2(`/v1/jobs/${b.job_id}`)).json()) as BuildJobView,
      ['succeeded'],
    );
    expect(vb.state).toBe('succeeded');
  });
});

describe('setPresetOptions', () => {
  it('edits only the named preset', () => {
    const p = join(tmp(), 'export_presets.cfg');
    writeFileSync(
      p,
      '[preset.0]\n\nname="Windows Desktop"\n\n[preset.0.options]\n\na=1\n\n[preset.1]\n\nname="iOS"\n\n[preset.1.options]\n\napplication/export_project_only=false\n',
    );
    setPresetOptions(p, 'iOS', { 'application/export_project_only': 'true', 'application/app_store_team_id': '"T"' });
    const t = readFileSync(p, 'utf-8');
    expect(t).toContain('[preset.0.options]\n\na=1\n');
    expect(t).toContain('application/export_project_only=true');
    expect(t).toContain('application/app_store_team_id="T"');
    expect(() => setPresetOptions(p, 'Android', { x: '1' })).toThrow(/not found/);
  });
});
