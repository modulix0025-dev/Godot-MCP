// SPDX-License-Identifier: Apache-2.0
//
// Worker onboarding runner (Execution Patch 1 §7, Phase 7). Runs every ONBOARDING_STEP against a real worker
// and derives trust with `onboardingDecision`. A remote worker that answers WITHOUT authentication fails the
// authentication step (and so can never be TRUSTED): a public, unauthenticated ComfyUI is exactly what the
// rules forbid. Credentials are only read through `authHeaders` and never stored in the record.
import {
  ONBOARDING_STEPS,
  onboardingDecision,
  transportProblem,
  WorkerRecordSchema,
  type OnboardingStep,
  type WorkerRecord,
} from '@modulex/shared';
import { capabilityTags, ComfyClient, ComfyHttpError } from './client.js';
import type { ComfyJobSystem, WorkerHandle } from './jobs.js';
import type { LoadedWorkflow } from './registry.js';

export interface OnboardingReport {
  record: WorkerRecord;
  steps: { step: OnboardingStep; status: 'passed' | 'failed'; detail: string }[];
  reasons: string[];
  nodes: string[];
}

function isLoopback(url: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname);
}

export async function onboardWorker(opts: {
  record: WorkerRecord;
  authHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  jobs: ComfyJobSystem;
  /** A small test workflow + inputs, run as a TEST job (never production). */
  test: { workflow: LoadedWorkflow; inputs: Record<string, unknown> } | null;
  costPerHourUsd?: number;
  fetch?: typeof fetch;
}): Promise<OnboardingReport> {
  const record: WorkerRecord = structuredClone(opts.record);
  const steps: OnboardingReport['steps'] = [];
  const mark = (step: OnboardingStep, ok: boolean, detail: string) => {
    steps.push({ step, status: ok ? 'passed' : 'failed', detail });
    record.onboarding[step] = ok ? 'passed' : 'failed';
    return ok;
  };
  for (const s of ONBOARDING_STEPS) record.onboarding[s] = 'pending';
  const client = new ComfyClient({
    baseUrl: record.base_url,
    authHeaders: opts.authHeaders,
    fetch: opts.fetch,
    timeoutMs: 15_000,
  });
  const bare = new ComfyClient({ baseUrl: record.base_url, fetch: opts.fetch, timeoutMs: 15_000 });
  let nodes: string[] = [];

  const valid = WorkerRecordSchema.safeParse(record);
  const tp = transportProblem(record.base_url, record.transport);
  if (!mark('register', valid.success && !tp, tp ?? (valid.success ? 'record valid' : valid.error.message)))
    return finish();

  let stats: Awaited<ReturnType<ComfyClient['systemStats']>>;
  try {
    stats = await client.systemStats();
    mark('connectivity', true, 'GET /system_stats answered');
  } catch (e) {
    mark('connectivity', false, (e as Error).message);
    return finish();
  }

  if (isLoopback(record.base_url)) {
    mark('authentication', true, 'loopback worker (not reachable from the network)');
  } else {
    try {
      await bare.systemStats();
      mark('authentication', false, 'the worker answers WITHOUT credentials — put it behind the authenticating proxy');
    } catch (e) {
      const status = e instanceof ComfyHttpError ? e.status : 0;
      mark(
        'authentication',
        status === 401 || status === 403,
        status === 401 || status === 403
          ? `unauthenticated request refused (${status}); authenticated request accepted`
          : (e as Error).message,
      );
    }
    record.auth_status = record.onboarding.authentication === 'passed' ? 'ok' : 'failed';
  }

  try {
    nodes = await client.nodeClasses();
    record.capabilities = capabilityTags(nodes);
    mark(
      'capability_discovery',
      nodes.length > 0,
      `${nodes.length} node classes → ${record.capabilities.join(', ') || 'no capabilities'}`,
    );
  } catch (e) {
    mark('capability_discovery', false, (e as Error).message);
  }

  record.comfy_version = stats.comfyui_version;
  mark('version_discovery', Boolean(stats.comfyui_version), `ComfyUI ${stats.comfyui_version ?? 'unknown'}`);

  const gpu = stats.devices.find((d) => d.type !== 'cpu');
  record.gpu = gpu?.name ?? null;
  record.vram_gb = gpu ? Math.round((gpu.vram_total / 2 ** 30) * 10) / 10 : null;
  record.last_health_at = new Date().toISOString();
  mark('health_check', Boolean(gpu), gpu ? `${gpu.name}, ${record.vram_gb} GB VRAM` : 'no GPU device reported');

  if (!opts.test) {
    mark('test_generation', false, 'no test workflow configured');
    mark('output_validation', false, 'no test output');
    return finish();
  }
  const handle: WorkerHandle = { record, client, costPerHourUsd: opts.costPerHourUsd ?? 0, priority: 0, nodes };
  const r = await opts.jobs.runOn(handle, {
    idempotencyKey: `onboarding:${record.worker_id}:${Date.now()}`,
    projectId: null,
    assetId: `onboarding-${record.worker_id}`,
    workflow: opts.test.workflow.definition,
    graph: opts.test.workflow.graph,
    inputs: opts.test.inputs,
    purpose: 'test',
  });
  mark('test_generation', r.status === 'SUCCESS' || r.failure_class === 'output_invalid', `${r.status}: ${r.message}`);
  mark(
    'output_validation',
    r.status === 'SUCCESS',
    r.status === 'SUCCESS' ? `${r.outputs.length} output(s), sha256 ${r.outputs[0]?.sha256.slice(0, 12)}` : r.message,
  );
  return finish();

  function finish(): OnboardingReport {
    const d = onboardingDecision(record);
    record.trust = d.trust;
    record.failure_count = 0;
    return { record, steps, reasons: d.reasons, nodes };
  }
}
