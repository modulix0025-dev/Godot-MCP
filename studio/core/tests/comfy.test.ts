// SPDX-License-Identifier: Apache-2.0
//
// GATE 7 (mock part): the ComfyUI client, the idempotent job system and worker onboarding against a mock ComfyUI
// with failure injection. The headline property: under an injected network drop there is never a double
// submission — the persisted prompt_id is queried first, and only a prompt the worker never saw is resent (with a
// NEW prompt_id). The live part (a real worker producing a GLB) is in comfy-live.test.ts.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, type Anomaly, type WorkerRecord } from '@modulex/shared';
import { capabilityTags, ComfyClient } from '../src/comfy/client.js';
import { bindGraph, ComfyJobSystem, seedFor, type JobRequest, type WorkerHandle } from '../src/comfy/jobs.js';
import { onboardWorker } from '../src/comfy/onboarding.js';
import { loadWorkflows, workflowProblems, type LoadedWorkflow } from '../src/comfy/registry.js';
import { StudioDb } from '../src/db/database.js';
import { startMockComfy, type MockComfy, type MockComfyOptions } from './fixtures/mock-comfy.js';

const WORKFLOWS = resolve(__dirname, '../../workflows');
const builtin = loadWorkflows(WORKFLOWS);
const mesh = builtin.find((w) => w.definition.id === '3D_PROP.hunyuan3d2')!;
const concept = builtin.find((w) => w.definition.id === 'CONCEPT_IMAGE.sdxl')!;
const verified = (w: LoadedWorkflow): LoadedWorkflow => ({
  ...w,
  definition: { ...w.definition, verification: { status: 'VERIFIED', evidence: 'test' } },
});

function record(url: string, over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    worker_id: 'gpu-1',
    kind: 'comfyui',
    provider: 'local',
    location: 'test',
    base_url: url,
    transport: 'loopback',
    secret_ref: null,
    gpu: 'RTX 4090',
    comfy_version: '0.3.60',
    vram_gb: 24,
    capabilities: ['3d', 'image', 'texture'],
    auth_status: 'ok',
    last_health_at: null,
    trust: 'TRUSTED',
    failure_count: 0,
    cost_class: 'low',
    onboarding: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, 'passed'])) as WorkerRecord['onboarding'],
    quarantine_reason: null,
    ...over,
  };
}

const mocks: MockComfy[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});

async function setup(o: MockComfyOptions = {}, rec: Partial<WorkerRecord> = {}) {
  const mock = await startMockComfy(o);
  mocks.push(mock);
  const db = new StudioDb(':memory:');
  const anomalies: Anomaly[] = [];
  let t = 0;
  const handle: WorkerHandle = {
    record: record(mock.url, rec),
    client: new ComfyClient({ baseUrl: mock.url }),
    costPerHourUsd: 1.8,
    priority: 1,
    nodes: [...(mesh.definition.required_nodes ?? []), ...(concept.definition.required_nodes ?? [])],
  };
  const jobs = new ComfyJobSystem({
    db,
    workers: () => [handle],
    cacheDir: mkdtempSync(join(tmpdir(), 'mx-comfy-')),
    onAnomaly: (_, a) => anomalies.push(a),
    pollMs: 1000,
    sleep: async (ms) => void (t += ms),
    now: () => t,
  });
  return { mock, db, jobs, handle, anomalies };
}

const req = (w: LoadedWorkflow, key = 'p1:asset:crate', purpose: JobRequest['purpose'] = 'production'): JobRequest => ({
  idempotencyKey: key,
  projectId: 'p1',
  assetId: 'crate',
  workflow: w.definition,
  graph: w.graph,
  inputs: { reference_image: 'crate.png', prompt: 'a wooden crate' },
  purpose,
});

describe('workflow registry', () => {
  it('loads the built-in workflows and they are internally consistent', () => {
    expect(builtin.map((w) => w.definition.id)).toEqual(['3D_PROP.hunyuan3d2', 'CONCEPT_IMAGE.sdxl']);
    expect(mesh.definition.produces).toEqual(['mesh']); // honest: no texture, no rig
    for (const w of builtin) expect(w.definition.verification?.status).toBe('UNVERIFIED');
  });

  it('catches a broken binding, a missing output node and a node-class mismatch', () => {
    const graph = structuredClone(mesh.graph);
    delete graph['9'];
    const p = workflowProblems(
      { ...mesh.definition, bindings: { ...mesh.definition.bindings, seed: '99.inputs.seed' } },
      graph,
    );
    expect(p.join('\n')).toMatch(/node '99' is not in the graph/);
    expect(p.join('\n')).toMatch(/output 'mesh' → node '9' is not in the graph/);
    expect(p.join('\n')).toMatch(/required_nodes/);
  });

  it('binds inputs; the default seed is derived from the idempotency key', () => {
    const g = bindGraph(req(mesh));
    expect(g['2']!.inputs.image).toBe('crate.png');
    expect(g['7']!.inputs.seed).toBe(seedFor('p1:asset:crate'));
    expect(mesh.graph['2']!.inputs.image).toBe('reference.png'); // the registry graph is never mutated
    expect(() => bindGraph({ ...req(mesh), inputs: {} })).toThrow(/reference_image/);
  });

  it('derives capability tags from node classes', () => {
    expect(capabilityTags(['SaveGLB', 'VAEDecodeHunyuan3D', 'KSampler', 'VAEDecode', 'SaveImage'])).toEqual([
      '3d',
      'image',
    ]);
    expect(capabilityTags(['KSampler'])).toEqual([]);
  });
});

describe('job system', () => {
  it('generates, downloads, hashes and costs a GLB; a second call is idempotent', async () => {
    const { mock, db, jobs } = await setup();
    const r = await jobs.run(req(verified(mesh)));
    expect(r).toMatchObject({ status: 'SUCCESS', attempts: 1, gpu_seconds: 42 });
    expect(readFileSync(r.outputs[0]!.path).toString('ascii', 0, 4)).toBe('glTF');
    expect(r.outputs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(db.spent('p1')).toBeCloseTo((42 / 3600) * 1.8);
    const again = await jobs.run(req(verified(mesh)));
    expect(again).toMatchObject({ status: 'SUCCESS', cached: true });
    expect(mock.accepted).toHaveLength(1);
  });

  it('falls back to /history and /queue on a worker without the jobs API', async () => {
    const { jobs } = await setup({ legacyOnly: true, output: 'png' });
    const r = await jobs.run(req(verified(concept)));
    expect(r.status).toBe('SUCCESS');
    expect(r.gpu_seconds).toBe(42);
  });

  it('a dropped submit response is resolved by querying the prompt_id — never a double submission', async () => {
    const { mock, jobs, db } = await setup({ dropSubmitResponses: 1 });
    const r = await jobs.run(req(verified(mesh)));
    expect(r.status).toBe('SUCCESS');
    expect(mock.accepted).toHaveLength(1);
    expect(r.prompt_ids).toEqual(mock.accepted);
    expect(db.all('SELECT status FROM comfy_jobs')).toEqual([{ status: 'completed' }]);
  });

  it('a submit the worker never saw is resent with a NEW prompt_id linked to the same key', async () => {
    const { mock, jobs, db } = await setup({ dropSubmitsUnseen: 1 });
    const r = await jobs.run(req(verified(mesh)));
    expect(r.status).toBe('SUCCESS');
    expect(r.prompt_ids).toHaveLength(2);
    expect(new Set(r.prompt_ids).size).toBe(2);
    expect(mock.accepted).toEqual([r.prompt_ids[1]]);
    expect(db.all('SELECT status, failure_class FROM comfy_jobs ORDER BY attempts')).toEqual([
      { status: 'lost', failure_class: 'worker_lost' },
      { status: 'completed', failure_class: null },
    ]);
  });

  it('after a Studio crash mid-job, the persisted prompt_id is followed instead of resubmitting', async () => {
    const { mock, jobs, db, handle } = await setup();
    const promptId = '11111111-2222-4333-8444-555555555555';
    await handle.client.submit(bindGraph(req(verified(mesh))), 'x', promptId);
    db.run(
      "INSERT INTO comfy_jobs (job_id, prompt_id, idempotency_key, worker_id, workflow_id, status, attempts, created_at, updated_at) VALUES ('cj_1', ?, 'p1:asset:crate', 'gpu-1', 'wf', 'submitted', 1, 'now', 'now')",
      promptId,
    );
    const r = await jobs.run(req(verified(mesh)));
    expect(r.status).toBe('SUCCESS');
    expect(mock.accepted).toEqual([promptId]);
  });

  it('validation 400 and node errors fail without retry; OOM is classified', async () => {
    const a = await setup({ reject400: true });
    expect(await a.jobs.run(req(verified(mesh)))).toMatchObject({
      status: 'FAILED',
      failure_class: 'validation_400',
      attempts: 1,
    });
    const b = await setup({
      fail: { exception_type: 'RuntimeError', exception_message: 'bad tensor', node_type: 'KSampler' },
    });
    expect(await b.jobs.run(req(verified(mesh)))).toMatchObject({ status: 'FAILED', failure_class: 'node_error' });
    const c = await setup({
      fail: {
        exception_type: 'torch.OutOfMemoryError',
        exception_message: 'CUDA out of memory',
        node_type: 'VAEDecodeHunyuan3D',
      },
    });
    const r = await c.jobs.run(req(verified(mesh)));
    expect(r).toMatchObject({ status: 'FAILED', failure_class: 'oom', attempts: 1 });
    expect(c.mock.accepted).toHaveLength(1);
  });

  it('a hung job times out, is cancelled on the worker, and retried within the policy', async () => {
    const { mock, jobs } = await setup({ hang: true });
    const quick = verified(mesh);
    // A short timeout keeps the number of (real HTTP) polls small; the clock itself is virtual.
    const r = await jobs.run(req({ ...quick, definition: { ...quick.definition, timeout_s: 20 } }));
    expect(r).toMatchObject({ status: 'FAILED', failure_class: 'timeout', attempts: 2 });
    expect(mock.cancelled).toEqual(mock.accepted);
    expect(mock.accepted).toHaveLength(2);
  });

  it('malformed or oversized outputs never reach the cache and count as anomalies', async () => {
    const a = await setup({ output: 'garbage' });
    const r = await a.jobs.run(req(verified(mesh)));
    expect(r).toMatchObject({ status: 'FAILED', failure_class: 'output_invalid' });
    expect(r.message).toMatch(/bad magic/);
    expect(a.anomalies).toEqual(['malformed_output']);
    const b = await setup({ output: 'huge' });
    const big = await b.jobs.run(req(verified(mesh)));
    expect(big).toMatchObject({ status: 'FAILED', failure_class: 'output_invalid' });
    expect(big.message).toMatch(/cap/);
  });

  it('UNVERIFIED workflows and untrusted workers never run production jobs', async () => {
    const a = await setup();
    expect(await a.jobs.run(req(mesh))).toMatchObject({ status: 'BLOCKED', failure_class: 'workflow_unverified' });
    expect(a.mock.accepted).toHaveLength(0);
    const b = await setup({}, { trust: 'DEGRADED' });
    expect(await b.jobs.run(req(verified(mesh)))).toMatchObject({ status: 'BLOCKED', failure_class: 'no_worker' });
    expect((await b.jobs.run(req(mesh, 'k2', 'test'))).status).toBe('SUCCESS'); // test jobs may use DEGRADED
    const c = await setup({}, { trust: 'QUARANTINED' });
    expect((await c.jobs.run(req(mesh, 'k3', 'test'))).status).toBe('BLOCKED');
  });

  it('estimates cost before running', async () => {
    const { jobs } = await setup();
    expect(jobs.estimate(mesh.definition, 'production')).toEqual({ gpu_seconds: 90, usd: (90 / 3600) * 1.8 });
  });
});

describe('worker onboarding', () => {
  const blank = (url: string, over: Partial<WorkerRecord> = {}) =>
    record(url, {
      trust: 'UNTRUSTED',
      capabilities: [],
      gpu: null,
      vram_gb: null,
      comfy_version: null,
      auth_status: 'untested',
      onboarding: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, 'pending'])) as WorkerRecord['onboarding'],
      ...over,
    });

  it('a loopback worker that passes every step, including a real test generation, becomes TRUSTED', async () => {
    const { mock, jobs } = await setup();
    const r = await onboardWorker({
      record: blank(mock.url),
      jobs,
      test: { workflow: mesh, inputs: { reference_image: 'ref.png' } },
    });
    expect(r.steps.map((s) => s.status)).toEqual(ONBOARDING_STEPS.map(() => 'passed'));
    expect(r.record).toMatchObject({ trust: 'TRUSTED', comfy_version: '0.3.60', vram_gb: 24 });
    expect(r.record.capabilities).toContain('3d');
  });

  it('a remote worker behind the authenticating proxy passes authentication; an open one never becomes TRUSTED', async () => {
    const proxy =
      (target: string): typeof fetch =>
      (input, init) =>
        fetch(String(input).replace('https://comfy.example.test', target), init);
    const secure = await setup({ bearer: 'worker-secret' });
    const ok = await onboardWorker({
      record: blank('https://comfy.example.test', { transport: 'https-auth-proxy', provider: 'runpod' }),
      authHeaders: () => ({ Authorization: 'Bearer worker-secret' }),
      jobs: secure.jobs,
      test: null,
      fetch: proxy(secure.mock.url),
    });
    expect(ok.steps.find((s) => s.step === 'authentication')).toMatchObject({ status: 'passed' });
    expect(JSON.stringify(ok.record)).not.toContain('worker-secret');
    expect(ok.record.trust).toBe('UNTRUSTED'); // no test generation → not TRUSTED

    const open = await setup();
    const bad = await onboardWorker({
      record: blank('https://comfy.example.test', { transport: 'https-auth-proxy', provider: 'runpod' }),
      jobs: open.jobs,
      test: null,
      fetch: proxy(open.mock.url),
    });
    expect(bad.steps.find((s) => s.step === 'authentication')).toMatchObject({ status: 'failed' });
    expect(bad.record.trust).toBe('UNTRUSTED');
    expect(bad.reasons.join('\n')).toMatch(/authentication/);
  });

  it('refuses plain http for a proxy transport at registration', async () => {
    const { jobs } = await setup();
    const r = await onboardWorker({
      record: blank('http://203.0.113.9:8188', { transport: 'https-auth-proxy' }),
      jobs,
      test: null,
    });
    expect(r.steps).toEqual([expect.objectContaining({ step: 'register', status: 'failed' })]);
    expect(r.record.trust).toBe('UNTRUSTED');
  });
});

it('the reference proxy config exists and requires TLS + a bearer token', () => {
  const caddy = resolve(__dirname, '../../worker/comfy-proxy/Caddyfile');
  expect(existsSync(caddy)).toBe(true);
  const text = readFileSync(caddy, 'utf-8');
  expect(text).toMatch(/Authorization/);
  expect(text).toMatch(/reverse_proxy 127\.0\.0\.1:8188/);
});
