// SPDX-License-Identifier: Apache-2.0
//
// Mock ComfyUI (GATE 7): the documented endpoints the Studio uses, with failure injection. It records every
// accepted prompt_id so tests can prove there is never a double submission.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeGlb, TINY_PNG } from './glb.js';

export interface MockComfyOptions {
  bearer?: string;
  /** No /api/jobs routes (older ComfyUI): the client must fall back to /history + /queue. */
  legacyOnly?: boolean;
  /** Accept the first N submissions, then drop the connection before answering (the uncertain case). */
  dropSubmitResponses?: number;
  /** Drop the first N submissions BEFORE accepting them (the worker never saw them). */
  dropSubmitsUnseen?: number;
  reject400?: boolean;
  fail?: { exception_type: string; exception_message: string; node_type: string };
  hang?: boolean;
  output?: 'glb' | 'png' | 'garbage' | 'none' | 'huge';
  pollsToComplete?: number;
  nodes?: string[];
  executionTime?: number;
}

interface Job {
  id: string;
  polls: number;
  state: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
}

export interface MockComfy {
  url: string;
  accepted: string[];
  cancelled: string[];
  requests: string[];
  unauthorised: number;
  close(): Promise<void>;
}

const OUTPUT_NODE = '9';

export async function startMockComfy(o: MockComfyOptions = {}): Promise<MockComfy> {
  const jobs = new Map<string, Job>();
  const state: MockComfy = {
    url: '',
    accepted: [],
    cancelled: [],
    requests: [],
    unauthorised: 0,
    close: async () => {},
  };
  let dropped = 0;
  let unseen = 0;
  const is3d = (o.output ?? 'glb') !== 'png';
  const send = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  };
  const advance = (j: Job) => {
    if (j.state === 'cancelled' || j.state === 'completed' || j.state === 'failed') return;
    j.polls++;
    if (o.hang) {
      j.state = 'in_progress';
      return;
    }
    if (j.polls >= (o.pollsToComplete ?? 2)) j.state = o.fail ? 'failed' : 'completed';
    else j.state = 'in_progress';
  };
  const outputs = (j: Job) =>
    j.state === 'completed' && o.output !== 'none'
      ? {
          [OUTPUT_NODE]: {
            [is3d ? '3d' : 'images']: [
              { filename: `${j.id.slice(0, 8)}.${is3d ? 'glb' : 'png'}`, subfolder: 'mesh', type: 'output' },
            ],
          },
        }
      : {};

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (o.bearer && req.headers.authorization !== `Bearer ${o.bearer}`) {
      state.unauthorised++;
      return send(res, 401, { error: 'unauthorised' });
    }
    const p = url.pathname;
    if (p === '/system_stats')
      return send(res, 200, {
        system: { comfyui_version: '0.3.60', os: 'posix' },
        devices: [{ name: 'cuda:0 NVIDIA RTX 4090', type: 'cuda', vram_total: 24 * 2 ** 30, vram_free: 20 * 2 ** 30 }],
      });
    if (p === '/object_info') {
      const nodes = o.nodes ?? [
        'KSampler',
        'VAEDecode',
        'SaveImage',
        'LoadImage',
        'SaveGLB',
        'VAEDecodeHunyuan3D',
        'VoxelToMeshBasic',
      ];
      return send(res, 200, Object.fromEntries(nodes.map((n) => [n, { name: n }])));
    }
    if (p === '/queue' && req.method === 'GET') {
      const list = [...jobs.values()];
      return send(res, 200, {
        queue_running: list.filter((j) => j.state === 'in_progress').map((j, i) => [i, j.id, {}, {}, []]),
        queue_pending: list.filter((j) => j.state === 'pending').map((j, i) => [i, j.id, {}, {}, []]),
      });
    }
    if (p === '/queue' && req.method === 'POST') {
      const b = JSON.parse(await body(req)) as { delete?: string[] };
      for (const id of b.delete ?? []) {
        const j = jobs.get(id);
        if (j && j.state !== 'completed') {
          j.state = 'cancelled';
          state.cancelled.push(id);
        }
      }
      return send(res, 200, {});
    }
    if (p === '/interrupt') return send(res, 200, {});
    if (p === '/prompt' && req.method === 'POST') {
      const b = JSON.parse(await body(req)) as { prompt_id: string; prompt: unknown };
      if (unseen < (o.dropSubmitsUnseen ?? 0)) {
        unseen++;
        return req.socket.destroy();
      }
      if (o.reject400)
        return send(res, 400, { error: { type: 'prompt_outputs_failed_validation' }, node_errors: { '3': {} } });
      if (jobs.has(b.prompt_id)) return send(res, 400, { error: 'duplicate prompt_id' });
      jobs.set(b.prompt_id, { id: b.prompt_id, polls: 0, state: 'pending' });
      state.accepted.push(b.prompt_id);
      if (dropped < (o.dropSubmitResponses ?? 0)) {
        dropped++;
        return req.socket.destroy();
      }
      return send(res, 200, { prompt_id: b.prompt_id, number: state.accepted.length, node_errors: {} });
    }
    const jobsMatch = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(p);
    if (jobsMatch) {
      if (o.legacyOnly) return send(res, 404, { error: 'not found' });
      const j = jobs.get(jobsMatch[1]!);
      if (!j) return send(res, 404, { error: 'not found' });
      if (jobsMatch[2]) {
        if (j.state !== 'completed') j.state = 'cancelled';
        state.cancelled.push(j.id);
        return send(res, 200, {});
      }
      advance(j);
      return send(res, 200, {
        id: j.id,
        status: j.state,
        outputs: outputs(j),
        execution_time: j.state === 'completed' ? (o.executionTime ?? 42) : undefined,
        execution_error: j.state === 'failed' ? o.fail : undefined,
      });
    }
    const hist = /^\/history\/([^/]+)$/.exec(p);
    if (hist) {
      const j = jobs.get(hist[1]!);
      if (!j) return send(res, 200, {});
      advance(j);
      if (j.state === 'pending' || j.state === 'in_progress') return send(res, 200, {});
      return send(res, 200, {
        [j.id]: {
          outputs: outputs(j),
          status: {
            status_str: j.state === 'failed' ? 'error' : 'success',
            completed: j.state === 'completed',
            messages: [
              ['execution_start', { timestamp: 1000 }],
              ...(j.state === 'failed' ? [['execution_error', { ...o.fail, timestamp: 3000 }]] : []),
              ...(j.state === 'cancelled' ? [['execution_interrupted', { timestamp: 2000 }]] : []),
              ...(j.state === 'completed' ? [['execution_success', { timestamp: 43000 }]] : []),
            ],
          },
        },
      });
    }
    if (p === '/view') {
      const kind = o.output ?? 'glb';
      if (kind === 'huge') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(300 * 2 ** 20) });
        return res.end();
      }
      const bytes =
        kind === 'garbage' ? Buffer.from('<html>not a model</html>') : kind === 'png' ? TINY_PNG : makeGlb();
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
      return res.end(bytes);
    }
    if (p === '/upload/image') {
      await body(req);
      return send(res, 200, { name: 'ref.png', subfolder: '', type: 'input' });
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
