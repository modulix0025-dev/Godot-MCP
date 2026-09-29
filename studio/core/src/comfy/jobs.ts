// SPDX-License-Identifier: Apache-2.0
//
// ComfyUI job system (Phase 7). The rules that matter:
//
//   1. Idempotency. A task's idempotency key maps to at most one COMPLETED job; calling again returns the cached
//      outputs. Every attempt gets a fresh prompt_id (uuid4) that is PERSISTED in comfy_jobs BEFORE it is sent.
//   2. Never blindly resubmit. If a submit or poll outcome is uncertain (connection dropped), the worker is asked
//      about the persisted prompt_id first. Only an 'unknown' answer allows a retry, and then with a NEW prompt_id
//      linked to the same idempotency key.
//   3. Only workers whose trust allows the job receive it (production → TRUSTED only), and only VERIFIED workflows
//      run production jobs.
//   4. Outputs are untrusted: size-capped download, sha256, magic-byte check; a malformed output is an anomaly that
//      lowers the worker's trust.
//   5. Every attempt records its failure class; GPU time goes to the cost ledger.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canRunJob, type Anomaly, type WorkerRecord, type WorkflowDefinition } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { StudioDb } from '../db/database.js';
import { ComfyClient, ComfyHttpError, ComfyNetworkError, type JobView } from './client.js';

export const FAILURE_CLASSES = [
  'validation_400',
  'node_error',
  'oom',
  'worker_lost',
  'timeout',
  'output_invalid',
  'no_worker',
  'workflow_unverified',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
const RETRYABLE: ReadonlySet<FailureClass> = new Set(['worker_lost', 'timeout']);

export interface WorkerHandle {
  record: WorkerRecord;
  client: ComfyClient;
  costPerHourUsd: number;
  priority: number;
  /** Node classes from the last health check (/object_info). */
  nodes: string[];
}

export interface JobRequest {
  idempotencyKey: string;
  projectId: string | null;
  assetId: string;
  workflow: WorkflowDefinition;
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  inputs: Record<string, unknown>;
  purpose: 'production' | 'test';
}

export interface JobOutput {
  name: string;
  path: string;
  filename: string;
  sha256: string;
  size: number;
}

export interface JobResult {
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  failure_class: FailureClass | null;
  message: string;
  worker_id: string | null;
  prompt_ids: string[];
  attempts: number;
  outputs: JobOutput[];
  gpu_seconds: number;
  usd: number;
  cached: boolean;
}

export interface JobSystemOptions {
  db: StudioDb;
  workers: () => WorkerHandle[];
  cacheDir: string;
  audit?: AuditLog | null;
  maxOutputBytes?: number;
  pollMs?: number;
  /** Consecutive failed polls before the worker counts as lost. */
  maxPollErrors?: number;
  onAnomaly?: (workerId: string, anomaly: Anomaly) => void;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Row {
  job_id: string;
  prompt_id: string;
  idempotency_key: string;
  worker_id: string;
  workflow_id: string;
  status: string;
  attempts: number;
  failure_class: string | null;
  data: string;
}

/** Deterministic seed from the idempotency key, so a retried task asks for the same image. */
export function seedFor(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0);
}

/** Write request inputs into a copy of the API graph through the workflow's bindings. */
export function bindGraph(
  req: Pick<JobRequest, 'workflow' | 'graph' | 'inputs' | 'idempotencyKey'>,
): JobRequest['graph'] {
  const graph = structuredClone(req.graph);
  const bindings = req.workflow.bindings ?? {};
  for (const [name, spec] of Object.entries(req.workflow.inputs)) {
    let value = req.inputs[name];
    if (value === undefined && spec.type === 'seed') value = seedFor(req.idempotencyKey);
    if (value === undefined) {
      if (spec.required) throw new Error(`input '${name}' is required`);
      continue;
    }
    const bind = bindings[name];
    if (!bind) throw new Error(`input '${name}' has no binding in ${req.workflow.id}`);
    const [node, , field] = bind.split('.');
    const target = graph[node!];
    if (!target) throw new Error(`binding ${bind}: node '${node}' is not in the graph`);
    target.inputs[field!] = value;
  }
  return graph;
}

/** Magic-byte checks on an untrusted output. Always applied, whatever the workflow's own validation list says. */
function outputProblem(bytes: Buffer, kind: 'images' | '3d'): string | null {
  if (bytes.length === 0) return 'empty output';
  if (kind === '3d') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') return 'not a GLB (bad magic)';
    if (bytes.readUInt32LE(4) !== 2) return `unsupported glTF container version ${bytes.readUInt32LE(4)}`;
    if (bytes.readUInt32LE(8) !== bytes.length) return 'GLB length header does not match the file size';
  }
  if (kind === 'images') {
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpg && !webp) return 'not an image (bad magic)';
  }
  return null;
}

function classify(v: JobView): FailureClass {
  const text = `${v.error?.type ?? ''} ${v.error?.message ?? ''}`;
  return /out of memory|OutOfMemory|\bOOM\b/i.test(text) ? 'oom' : 'node_error';
}

export class ComfyJobSystem {
  private readonly uuid: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly o: JobSystemOptions) {
    this.uuid = o.uuid ?? randomUUID;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  /** Eligible workers for a workflow, best first: priority, then cost, then (at run time) queue depth. */
  eligible(workflow: WorkflowDefinition, purpose: JobRequest['purpose']): WorkerHandle[] {
    return this.o
      .workers()
      .filter((w) => w.record.kind === 'comfyui' && canRunJob(w.record.trust, purpose))
      .filter((w) => workflow.worker_capabilities.every((c) => w.record.capabilities.includes(c)))
      .filter((w) => (workflow.required_nodes ?? []).every((n) => w.nodes.includes(n)))
      .filter((w) => !workflow.min_vram_gb || (w.record.vram_gb ?? 0) >= workflow.min_vram_gb)
      .sort((a, b) => b.priority - a.priority || a.costPerHourUsd - b.costPerHourUsd);
  }

  /** Pre-flight cost estimate on the cheapest eligible worker (null when none is eligible). */
  estimate(workflow: WorkflowDefinition, purpose: JobRequest['purpose']): { usd: number; gpu_seconds: number } | null {
    const w = this.eligible(workflow, purpose)[0];
    if (!w) return null;
    const s = workflow.cost_profile.est_gpu_seconds;
    return { gpu_seconds: s, usd: (s / 3600) * w.costPerHourUsd };
  }

  private rows(key: string): Row[] {
    return this.o.db.all<Row>('SELECT * FROM comfy_jobs WHERE idempotency_key = ? ORDER BY created_at, attempts', key);
  }

  private setRow(promptId: string, status: string, failure: FailureClass | null, data?: unknown): void {
    this.o.db.run(
      'UPDATE comfy_jobs SET status = ?, failure_class = ?, updated_at = ?, data = COALESCE(?, data) WHERE prompt_id = ?',
      status,
      failure,
      new Date(this.now()).toISOString(),
      data === undefined ? null : JSON.stringify(data),
      promptId,
    );
  }

  private anomaly(workerId: string, a: Anomaly): void {
    this.o.onAnomaly?.(workerId, a);
    this.o.audit?.append('worker_trust_changed', 'studio-jobs', { worker_id: workerId, anomaly: a });
  }

  private result(r: Partial<JobResult> & Pick<JobResult, 'status' | 'message'>): JobResult {
    return {
      failure_class: null,
      worker_id: null,
      prompt_ids: [],
      attempts: 0,
      outputs: [],
      gpu_seconds: 0,
      usd: 0,
      cached: false,
      ...r,
    };
  }

  async run(req: JobRequest): Promise<JobResult> {
    // 1. Idempotency: a completed job for this key is the answer.
    const prior = this.rows(req.idempotencyKey);
    const done = prior.find((r) => r.status === 'completed');
    if (done) {
      const data = JSON.parse(done.data) as { outputs: JobOutput[]; gpu_seconds: number; usd: number };
      return this.result({
        status: 'SUCCESS',
        message: 'already generated (idempotent)',
        worker_id: done.worker_id,
        prompt_ids: prior.map((r) => r.prompt_id),
        attempts: prior.length,
        outputs: data.outputs,
        gpu_seconds: data.gpu_seconds,
        usd: data.usd,
        cached: true,
      });
    }
    if (req.purpose === 'production' && req.workflow.verification?.status !== 'VERIFIED')
      return this.result({
        status: 'BLOCKED',
        failure_class: 'workflow_unverified',
        message: `${req.workflow.id}@${req.workflow.version} has not been verified on a real worker; it may only run test jobs.`,
      });
    const graph = bindGraph(req);
    const prompt_ids = prior.map((r) => r.prompt_id);
    const attempts = prior.length;

    // 2. An earlier attempt whose outcome is unknown (crash mid-job): ask its worker before anything else.
    for (const r of prior.filter((x) => ['prepared', 'submitted', 'uncertain'].includes(x.status))) {
      const w = this.o.workers().find((h) => h.record.worker_id === r.worker_id);
      if (!w) continue;
      const out = await this.follow(req, w, r.prompt_id, this.now());
      if (out) return { ...out, prompt_ids, attempts };
    }

    const candidates = this.eligible(req.workflow, req.purpose);
    if (!candidates.length)
      return this.result({
        status: 'BLOCKED',
        failure_class: 'no_worker',
        message: `No ${req.purpose === 'production' ? 'TRUSTED ' : ''}ComfyUI worker has ${req.workflow.worker_capabilities.join(', ')}${
          req.workflow.required_nodes?.length ? ` and nodes ${req.workflow.required_nodes.join(', ')}` : ''
        }.`,
        prompt_ids,
        attempts,
      });
    // Queue depth breaks ties between equal-priority, equal-cost workers.
    const depth = new Map<string, number>();
    for (const w of candidates) depth.set(w.record.worker_id, await w.client.queueDepth().catch(() => Infinity));
    candidates.sort(
      (a, b) =>
        b.priority - a.priority ||
        a.costPerHourUsd - b.costPerHourUsd ||
        depth.get(a.record.worker_id)! - depth.get(b.record.worker_id)!,
    );
    return this.attempts(req, candidates[0]!, graph, prompt_ids, attempts);
  }

  /** Run on one specific worker (onboarding test jobs). Trust still decides whether it may run at all. */
  async runOn(worker: WorkerHandle, req: JobRequest): Promise<JobResult> {
    if (!canRunJob(worker.record.trust, req.purpose))
      return this.result({
        status: 'BLOCKED',
        failure_class: 'no_worker',
        message: `worker ${worker.record.worker_id} is ${worker.record.trust}; it may not run ${req.purpose} jobs`,
      });
    return this.attempts(req, worker, bindGraph(req), [], 0);
  }

  private async attempts(
    req: JobRequest,
    worker: WorkerHandle,
    graph: JobRequest['graph'],
    prompt_ids: string[],
    attempts: number,
  ): Promise<JobResult> {
    const max = req.workflow.retry_policy.max_attempts;
    let last: JobResult | null = null;
    while (attempts < max) {
      attempts++;
      const promptId = this.uuid();
      prompt_ids.push(promptId);
      const at = new Date(this.now()).toISOString();
      // Persist BEFORE sending — the UNIQUE prompt_id makes a double record impossible.
      this.o.db.run(
        'INSERT INTO comfy_jobs (job_id, prompt_id, idempotency_key, worker_id, workflow_id, status, attempts, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        `cj_${promptId.slice(0, 8)}`,
        promptId,
        req.idempotencyKey,
        worker.record.worker_id,
        `${req.workflow.id}@${req.workflow.version}`,
        'prepared',
        attempts,
        at,
        at,
        JSON.stringify({ asset_id: req.assetId, project_id: req.projectId }),
      );
      const started = this.now();
      try {
        await worker.client.submit(graph, `modulex-${req.idempotencyKey.slice(0, 32)}`, promptId);
        this.setRow(promptId, 'submitted', null);
      } catch (e) {
        if (e instanceof ComfyHttpError) {
          const cls: FailureClass = e.status === 400 ? 'validation_400' : 'node_error';
          this.setRow(promptId, 'failed', cls, { error: JSON.stringify(e.body).slice(0, 2000) });
          return this.result({
            status: 'FAILED',
            failure_class: cls,
            message: `submit rejected (HTTP ${e.status}): ${JSON.stringify(e.body).slice(0, 300)}`,
            worker_id: worker.record.worker_id,
            prompt_ids,
            attempts,
          });
        }
        if (!(e instanceof ComfyNetworkError)) throw e;
        // Uncertain: the worker may or may not have accepted it. Ask before doing anything else.
        this.setRow(promptId, 'uncertain', null);
      }
      const out = await this.follow(req, worker, promptId, started);
      if (out) {
        out.prompt_ids = prompt_ids;
        out.attempts = attempts;
        if (out.status !== 'FAILED' || !out.failure_class || !RETRYABLE.has(out.failure_class)) return out;
        last = out;
      } else {
        // The worker does not know the prompt: it was never accepted, so a new prompt_id may be sent.
        this.setRow(promptId, 'lost', 'worker_lost');
        last = this.result({
          status: 'FAILED',
          failure_class: 'worker_lost',
          message: 'the worker never received the job',
          worker_id: worker.record.worker_id,
          prompt_ids,
          attempts,
        });
      }
      if (attempts < max) await this.sleep(req.workflow.retry_policy.backoff_s * 1000);
    }
    return (
      last ??
      this.result({ status: 'FAILED', failure_class: 'worker_lost', message: 'no attempt ran', prompt_ids, attempts })
    );
  }

  /**
   * Follow a prompt_id to a terminal state. Returns null when the worker does not know it at all (safe to retry);
   * otherwise a result. The timeout cancels the job on the worker.
   */
  private async follow(req: JobRequest, w: WorkerHandle, promptId: string, started: number): Promise<JobResult | null> {
    const timeoutMs = req.workflow.timeout_s * 1000;
    let errors = 0;
    let unknownSeen = 0;
    const base = { worker_id: w.record.worker_id };
    for (;;) {
      let v: JobView;
      try {
        v = await w.client.job(promptId);
        errors = 0;
      } catch (e) {
        if (!(e instanceof ComfyNetworkError) && !(e instanceof ComfyHttpError)) throw e;
        if (++errors >= (this.o.maxPollErrors ?? 5)) {
          this.setRow(promptId, 'uncertain', 'worker_lost');
          this.anomaly(w.record.worker_id, 'timeout');
          return this.result({
            ...base,
            status: 'FAILED',
            failure_class: 'worker_lost',
            message: `worker unreachable: ${(e as Error).message}`,
          });
        }
        await this.sleep(this.o.pollMs ?? 1000);
        continue;
      }
      if (v.state === 'unknown') {
        // Give a just-submitted prompt a moment to appear in the queue before calling it lost.
        if (++unknownSeen >= 3) return null;
      } else if (v.state === 'completed') {
        return this.collect(req, w, promptId, v, started);
      } else if (v.state === 'failed') {
        const cls = classify(v);
        this.setRow(promptId, 'failed', cls, { error: v.error });
        return this.result({
          ...base,
          status: 'FAILED',
          failure_class: cls,
          message: `${v.error?.node_type ?? 'node'}: ${v.error?.message ?? v.error?.type ?? 'failed'}`,
        });
      } else if (v.state === 'cancelled') {
        this.setRow(promptId, 'cancelled', 'timeout');
        return this.result({
          ...base,
          status: 'FAILED',
          failure_class: 'timeout',
          message: 'the job was cancelled on the worker',
        });
      }
      if (this.now() - started > timeoutMs) {
        await w.client.cancel(promptId).catch(() => undefined);
        this.setRow(promptId, 'cancelled', 'timeout');
        return this.result({
          ...base,
          status: 'FAILED',
          failure_class: 'timeout',
          message: `timed out after ${req.workflow.timeout_s}s; cancelled on the worker`,
        });
      }
      await this.sleep(this.o.pollMs ?? 1000);
    }
  }

  private async collect(
    req: JobRequest,
    w: WorkerHandle,
    promptId: string,
    v: JobView,
    started: number,
  ): Promise<JobResult> {
    const base = { worker_id: w.record.worker_id };
    const outputs: JobOutput[] = [];
    const dir = join(this.o.cacheDir, req.assetId);
    mkdirSync(dir, { recursive: true });
    for (const [name, spec] of Object.entries(req.workflow.output_nodes ?? {})) {
      const files = v.outputs[spec.node]?.[spec.ui_key] ?? [];
      if (!files.length) {
        this.setRow(promptId, 'failed', 'output_invalid');
        this.anomaly(w.record.worker_id, 'malformed_output');
        return this.result({
          ...base,
          status: 'FAILED',
          failure_class: 'output_invalid',
          message: `output '${name}' missing from node ${spec.node}`,
        });
      }
      for (const file of files) {
        let got: { bytes: Buffer; sha256: string };
        try {
          got = await w.client.view(file, this.o.maxOutputBytes ?? 200 * 1024 * 1024);
        } catch (e) {
          this.setRow(promptId, 'failed', 'output_invalid');
          this.anomaly(w.record.worker_id, 'file_validation_failure');
          return this.result({
            ...base,
            status: 'FAILED',
            failure_class: 'output_invalid',
            message: (e as Error).message,
          });
        }
        const problem = outputProblem(got.bytes, spec.ui_key);
        if (problem) {
          this.setRow(promptId, 'failed', 'output_invalid', { problem });
          this.anomaly(w.record.worker_id, 'malformed_output');
          return this.result({
            ...base,
            status: 'FAILED',
            failure_class: 'output_invalid',
            message: `${file.filename}: ${problem}`,
          });
        }
        const filename = basename(file.filename).replace(/[^A-Za-z0-9._-]/g, '_');
        const path = join(dir, filename);
        writeFileSync(path, got.bytes);
        outputs.push({ name, path, filename, sha256: got.sha256, size: got.bytes.length });
      }
    }
    const gpu_seconds = v.execution_s ?? (this.now() - started) / 1000;
    const usd = (gpu_seconds / 3600) * w.costPerHourUsd;
    this.o.db.addCost({
      project_id: req.projectId,
      kind: 'gpu',
      ref: promptId,
      quantity: gpu_seconds,
      unit: 'gpu_s',
      usd,
    });
    this.setRow(promptId, 'completed', null, { asset_id: req.assetId, outputs, gpu_seconds, usd });
    return this.result({ ...base, status: 'SUCCESS', message: 'generated', outputs, gpu_seconds, usd });
  }

  /** Read a cached output back (the import stage copies from here into res://). */
  static read(output: JobOutput): Buffer {
    return readFileSync(output.path);
  }
}
