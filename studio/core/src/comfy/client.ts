// SPDX-License-Identifier: Apache-2.0
//
// ComfyUI HTTP client (EXECUTION_PROMPT F6 / Phase 7). ComfyUI is GPL-3.0: the Studio only talks to it over HTTP
// and never bundles or links it. The client is a thin, typed view of the documented endpoints:
//
//   GET  /system_stats, /object_info                         discovery + health
//   POST /prompt {prompt, client_id, prompt_id}              submit (prompt_id is ours, persisted before sending)
//   GET  /api/jobs/{id}   (fallback GET /history/{id})       job state — the source of truth after any reconnect
//   GET  /queue                                              queue depth
//   POST /api/jobs/{id}/cancel  (fallback /interrupt + POST /queue {delete})
//   GET  /view?filename&subfolder&type=output               outputs, streamed with a size cap
//   POST /upload/image (multipart)                           reference images
//
// Auth headers come from the host's credential store through `authHeaders()` and are never logged or returned.
import { createHash } from 'node:crypto';

export class ComfyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

/** The request could not be completed and its effect on the worker is unknown (connection reset, timeout). */
export class ComfyNetworkError extends Error {}

export interface ComfyClientOptions {
  baseUrl: string;
  authHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SystemStats {
  comfyui_version: string | null;
  devices: { name: string; type: string; vram_total: number; vram_free: number }[];
}

export type JobState = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface JobView {
  prompt_id: string;
  state: JobState;
  /** node id → ui key ('images' | '3d') → files */
  outputs: Record<string, Record<string, OutputFile[]>>;
  error: { type: string; message: string; node_type: string | null } | null;
  execution_s: number | null;
}

type Json = Record<string, unknown>;

export class ComfyClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: ComfyClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.f = o.fetch ?? fetch;
  }

  private async req(path: string, init: RequestInit = {}, raw = false): Promise<Response> {
    const headers = { ...(await this.o.authHeaders?.()), ...(init.headers as Record<string, string> | undefined) };
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new ComfyNetworkError(`${init.method ?? 'GET'} ${path}: ${(e as Error).message}`);
    }
    if (!raw && !res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw new ComfyHttpError(res.status, body, `${init.method ?? 'GET'} ${path} → HTTP ${res.status}`);
    }
    return res;
  }

  private async json<T = Json>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.req(path, init);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) throw new ComfyHttpError(res.status, null, `${path}: expected JSON, got '${ct}'`);
    return (await res.json()) as T;
  }

  async systemStats(): Promise<SystemStats> {
    const s = await this.json<{ system?: { comfyui_version?: string }; devices?: SystemStats['devices'] }>(
      '/system_stats',
    );
    return { comfyui_version: s.system?.comfyui_version ?? null, devices: s.devices ?? [] };
  }

  /** Node class names installed on the worker. */
  async nodeClasses(): Promise<string[]> {
    return Object.keys(await this.json('/object_info'));
  }

  async queueDepth(): Promise<number> {
    const q = await this.json<{ queue_running?: unknown[]; queue_pending?: unknown[] }>('/queue');
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
  }

  /** Submit with OUR prompt_id. 400 → ComfyHttpError with node_errors; a dropped connection → ComfyNetworkError. */
  async submit(prompt: unknown, clientId: string, promptId: string): Promise<{ prompt_id: string; number: number }> {
    const r = await this.json<{ prompt_id: string; number: number; node_errors?: Json }>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId, prompt_id: promptId }),
    });
    if (r.prompt_id !== promptId)
      throw new ComfyHttpError(200, r, `worker answered with prompt_id ${r.prompt_id}, expected ${promptId}`);
    return { prompt_id: r.prompt_id, number: r.number };
  }

  /** Job state by prompt_id: /api/jobs/{id} first, then the legacy /history/{id} + /queue. */
  async job(promptId: string): Promise<JobView> {
    try {
      const j = await this.json<Json>(`/api/jobs/${encodeURIComponent(promptId)}`);
      return this.fromJobsApi(promptId, j);
    } catch (e) {
      if (!(e instanceof ComfyHttpError) || e.status !== 404) throw e;
    }
    const h = await this.json<Record<string, Json>>(`/history/${encodeURIComponent(promptId)}`);
    const entry = h[promptId];
    if (entry) return this.fromHistory(promptId, entry);
    const q = await this.json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>('/queue');
    const inQ = (l?: unknown[][]) => (l ?? []).some((item) => item[1] === promptId);
    const state: JobState = inQ(q.queue_running) ? 'in_progress' : inQ(q.queue_pending) ? 'pending' : 'unknown';
    return { prompt_id: promptId, state, outputs: {}, error: null, execution_s: null };
  }

  private fromJobsApi(promptId: string, j: Json): JobView {
    const status = String(j.status ?? 'unknown');
    const state: JobState = (
      ['pending', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status) ? status : 'unknown'
    ) as JobState;
    const err = (j.execution_error ?? j.error) as Json | undefined;
    return {
      prompt_id: promptId,
      state,
      outputs: (j.outputs as JobView['outputs']) ?? {},
      error: err
        ? {
            type: String(err.exception_type ?? err.type ?? 'error'),
            message: String(err.exception_message ?? err.message ?? ''),
            node_type: err.node_type ? String(err.node_type) : null,
          }
        : null,
      execution_s: typeof j.execution_time === 'number' ? j.execution_time : null,
    };
  }

  private fromHistory(promptId: string, entry: Json): JobView {
    const status = (entry.status ?? {}) as { status_str?: string; completed?: boolean; messages?: [string, Json][] };
    const msgs = status.messages ?? [];
    const errMsg = msgs.find((m) => m[0] === 'execution_error')?.[1];
    const interrupted = msgs.some((m) => m[0] === 'execution_interrupted');
    const start = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp as number | undefined;
    const end = msgs.find((m) => m[0] === 'execution_success' || m[0] === 'execution_error')?.[1]?.timestamp as
      number | undefined;
    const state: JobState = interrupted
      ? 'cancelled'
      : status.status_str === 'error'
        ? 'failed'
        : status.completed
          ? 'completed'
          : 'in_progress';
    return {
      prompt_id: promptId,
      state,
      outputs: (entry.outputs as JobView['outputs']) ?? {},
      error: errMsg
        ? {
            type: String(errMsg.exception_type ?? 'error'),
            message: String(errMsg.exception_message ?? ''),
            node_type: errMsg.node_type ? String(errMsg.node_type) : null,
          }
        : null,
      execution_s: start && end ? (end - start) / 1000 : null,
    };
  }

  /** Cancel: the jobs API first, then the legacy interrupt + queue delete. */
  async cancel(promptId: string): Promise<void> {
    try {
      await this.req(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST' });
      return;
    } catch (e) {
      if (!(e instanceof ComfyHttpError) || (e.status !== 404 && e.status !== 405)) throw e;
    }
    await this.req('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    await this.req('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    });
  }

  /** Download one output, refusing anything above `maxBytes` (checked on the header AND while streaming). */
  async view(file: OutputFile, maxBytes: number): Promise<{ bytes: Buffer; sha256: string }> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await this.req(`/view?${q}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes)
      throw new ComfyHttpError(413, null, `output ${file.filename} is ${declared} bytes (cap ${maxBytes})`);
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new ComfyHttpError(res.status, null, 'empty body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ComfyHttpError(413, null, `output ${file.filename} exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async uploadImage(name: string, bytes: Buffer): Promise<{ name: string; subfolder: string }> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), name);
    form.append('overwrite', 'true');
    const r = await this.json<{ name: string; subfolder?: string }>('/upload/image', { method: 'POST', body: form });
    return { name: r.name, subfolder: r.subfolder ?? '' };
  }
}

/** Capability tags derived from installed node classes (Phase 7 "health checks"). */
export function capabilityTags(nodes: readonly string[]): string[] {
  const has = (n: string) => nodes.includes(n);
  const tags = new Set<string>();
  if (has('SaveGLB') && (has('VAEDecodeHunyuan3D') || has('VoxelToMesh') || has('VoxelToMeshBasic'))) tags.add('3d');
  if (has('SaveImage') && has('KSampler') && has('VAEDecode')) tags.add('image');
  if (has('SaveImage') && (has('LoadImage') || has('ImageScale'))) tags.add('texture');
  if (has('SaveAnimatedWEBP') || has('SaveWEBM') || has('SaveVideo')) tags.add('video');
  if (nodes.some((n) => /rig|skeleton/i.test(n))) tags.add('rig');
  return [...tags].sort();
}
