// SPDX-License-Identifier: Apache-2.0
//
// GATE 7 (live part): onboard a REAL ComfyUI worker and generate a GLB with the built-in Hunyuan3D v2 workflow.
//
//   MODULEX_COMFY_URL        worker base URL (loopback, SSH tunnel, or the authenticating proxy)
//   MODULEX_COMFY_TRANSPORT  loopback | ssh-tunnel | tailscale | private-network | https-auth-proxy
//   MODULEX_COMFY_TOKEN      bearer token for https-auth-proxy (CI secret; never printed)
//   MODULEX_COMFY_REFERENCE  a reference image already uploaded to the worker's input folder
//
// Without a worker the suite reports "GATE 7 live: BLOCKED" and is never faked.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, TRANSPORTS, type WorkerRecord } from '@modulex/shared';
import { ComfyJobSystem, type WorkerHandle } from '../src/comfy/jobs.js';
import { onboardWorker } from '../src/comfy/onboarding.js';
import { loadWorkflows } from '../src/comfy/registry.js';
import { StudioDb } from '../src/db/database.js';

const URL_ = process.env.MODULEX_COMFY_URL;
const TOKEN = process.env.MODULEX_COMFY_TOKEN;
const live = Boolean(URL_);

it.runIf(!live)('GATE 7 live: BLOCKED — no ComfyUI worker configured (MODULEX_COMFY_URL unset)', () => {
  console.log('[gate7] live: BLOCKED — no ComfyUI worker configured; the mock suite (comfy.test.ts) ran instead');
});

describe.runIf(live)('GATE 7 live — a real ComfyUI worker produces a GLB', () => {
  it(
    'onboards the worker and generates a valid GLB with 3D_PROP.hunyuan3d2',
    async () => {
      const transport = (process.env.MODULEX_COMFY_TRANSPORT ?? 'loopback') as (typeof TRANSPORTS)[number];
      const auth = TOKEN ? () => ({ Authorization: `Bearer ${TOKEN}` }) : undefined;
      const mesh = loadWorkflows(resolve(__dirname, '../../workflows')).find(
        (w) => w.definition.id === '3D_PROP.hunyuan3d2',
      )!;
      const db = new StudioDb(':memory:');
      const workers: WorkerHandle[] = [];
      const jobs = new ComfyJobSystem({
        db,
        workers: () => workers,
        cacheDir: mkdtempSync(join(tmpdir(), 'mx-gate7-')),
        pollMs: 2000,
      });
      const record: WorkerRecord = {
        worker_id: 'live-worker',
        kind: 'comfyui',
        provider: 'other',
        location: 'gate7',
        base_url: URL_!,
        transport,
        secret_ref: TOKEN ? 'secret://worker/live-worker/token' : null,
        gpu: null,
        comfy_version: null,
        vram_gb: null,
        capabilities: [],
        auth_status: 'untested',
        last_health_at: null,
        trust: 'UNTRUSTED',
        failure_count: 0,
        cost_class: 'low',
        onboarding: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, 'pending'])) as WorkerRecord['onboarding'],
        quarantine_reason: null,
      };
      const report = await onboardWorker({
        record,
        authHeaders: auth,
        jobs,
        test: { workflow: mesh, inputs: { reference_image: process.env.MODULEX_COMFY_REFERENCE ?? 'example.png' } },
      });
      for (const s of report.steps) console.log(`[gate7] ${s.step}: ${s.status} — ${s.detail}`);
      expect(report.record.trust).toBe('TRUSTED');
      const row = db.get<{ data: string }>("SELECT data FROM comfy_jobs WHERE status = 'completed'");
      const out = (JSON.parse(row!.data) as { outputs: { path: string; sha256: string }[] }).outputs[0]!;
      expect(readFileSync(out.path).toString('ascii', 0, 4)).toBe('glTF');
      console.log(
        `[gate7] live GLB sha256 ${out.sha256} from ComfyUI ${report.record.comfy_version} on ${report.record.gpu}`,
      );
    },
    30 * 60_000,
  );
});
