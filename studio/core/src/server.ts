// SPDX-License-Identifier: Apache-2.0
//
// Studio Core process: loopback-only HTTP on one port, three bearer credentials, one per caller class:
//   owner token   (the Tauri UI session)   → owner endpoints (/approvals, /dev-mode, /audit, /claude-desktop/*)
//   agent token   (ModuleX Agent)          → /mcp as caller `modulex-agent`
//   desktop token (Claude Desktop bridge)  → /mcp as caller `claude-desktop`
// The handshake (one JSON line on stdout) hands all three to the shell, which stores the agent/desktop tokens in
// Windows Credential Manager and passes them back on the next launch (stable pairing). Tokens never reach logs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DevCapability } from '@modulex/shared';
import * as godotCli from 'godot-cli';
import { STUDIO_CORE_VERSION } from './version.js';
import { generateSessionToken } from './godot/server-args.js';
import { AuditLog } from './audit/audit-log.js';
import { Redactor } from './audit/secrets.js';
import { StudioStore } from './store/studio-store.js';
import { Gateway } from './gateway/gateway.js';
import { createHandlers } from './gateway/tool-handlers.js';
import { createStudioMcpServer } from './mcp/studio-mcp.js';

/** Proves the bundled sidecar carries the reused godot-cli library (Phase 0 spike 7). */
const GODOT_CLI_EXPORTS = Object.keys(godotCli)
  .filter((k) => typeof (godotCli as Record<string, unknown>)[k] === 'function')
  .sort();

export interface Handshake {
  type: 'modulex-core-handshake';
  version: string;
  port: number;
  token: string;
  agentToken: string;
  claudeDesktopToken: string;
  pid: number;
}

export interface CoreOptions {
  port?: number;
  ownerToken?: string;
  agentToken?: string;
  claudeDesktopToken?: string;
  auditPath?: string;
  storePath?: string;
}

export interface CoreServer {
  server: Server;
  handshake: Handshake;
  gateway: Gateway;
  redactor: Redactor;
  close(): Promise<void>;
}

type Principal = 'owner-ui' | 'modulex-agent' | 'claude-desktop';

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage, limit = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : undefined;
}

/** Start Core on 127.0.0.1 (random port unless `port` is given). */
export async function startCore(opts: CoreOptions = {}): Promise<CoreServer> {
  const tokens: Record<Principal, string> = {
    'owner-ui': opts.ownerToken ?? generateSessionToken(),
    'modulex-agent': opts.agentToken ?? generateSessionToken(),
    'claude-desktop': opts.claudeDesktopToken ?? generateSessionToken(),
  };
  const redactor = new Redactor();
  Object.values(tokens).forEach((t) => redactor.register(t));
  const audit = new AuditLog(redactor, opts.auditPath);
  const store = new StudioStore(opts.storePath);
  const handlers = createHandlers();
  const gateway = new Gateway({ audit, store, handlers });
  const startedAt = Date.now();
  let port = 0;

  const principalOf = (req: IncomingMessage): Principal | null => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    const t = h.slice(7);
    return (Object.keys(tokens) as Principal[]).find((p) => eq(t, tokens[p])) ?? null;
  };

  const claudeHealthTest = async () => {
    const steps: { step: string; ok: boolean; detail?: string }[] = [];
    const client = new Client({ name: 'modulex-health', version: STUDIO_CORE_VERSION });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${tokens['claude-desktop']}` } },
        }),
      );
      const tools = (await client.listTools()).tools.map((t) => t.name);
      steps.push({ step: 'list_tools', ok: tools.includes('studio_ping'), detail: `${tools.length} tools` });
      const ping = await client.callTool({ name: 'studio_ping', arguments: {} });
      steps.push({ step: 'safe_ping', ok: !ping.isError });
      const first = store.listProjects()[0];
      if (first) {
        const st = await client.callTool({
          name: 'studio_project_status',
          arguments: { project_id: first.project_id },
        });
        steps.push({ step: 'project_status', ok: !st.isError });
      } else steps.push({ step: 'project_status', ok: true, detail: 'no projects yet' });
    } catch (e) {
      steps.push({ step: 'connect', ok: false, detail: redactor.redact(String(e)) });
    } finally {
      await client.close().catch(() => undefined);
    }
    const ok = steps.every((s) => s.ok);
    audit.append('claude_health_test', 'owner-ui', { ok, steps });
    return { ok, steps };
  };

  const server = createServer(async (req, res) => {
    try {
      const who = principalOf(req);
      if (!who) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          version: STUDIO_CORE_VERSION,
          uptimeMs: Date.now() - startedAt,
          rssBytes: process.memoryUsage().rss,
          godotCli: GODOT_CLI_EXPORTS,
          principal: who,
        });
      }

      if (url.pathname === '/mcp') {
        if (who === 'owner-ui')
          return send(res, 403, { error: 'the owner session does not use the agent MCP surface' });
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const mcp = createStudioMcpServer(gateway, handlers, {
          caller: who,
          sessionId: req.headers['mcp-session-id'] as string | undefined,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // ----- owner-only endpoints -----
      if (who !== 'owner-ui') return send(res, 403, { error: 'owner only' });

      if (req.method === 'GET' && url.pathname === '/approvals') return send(res, 200, gateway.listApprovals());
      const ap = /^\/approvals\/(ap_[A-Za-z0-9-]+)$/.exec(url.pathname);
      if (req.method === 'POST' && ap) {
        const b = (await readJson(req)) as { action: 'approve' | 'reject'; always_for_project?: boolean };
        return send(res, 200, gateway.resolveApproval(ap[1]!, b.action, 'owner-ui', b.always_for_project === true));
      }
      if (url.pathname === '/dev-mode') {
        if (req.method === 'GET') return send(res, 200, gateway.getDevMode());
        const b = (await readJson(req)) as { enabled: boolean; capabilities?: DevCapability[]; confirmed?: boolean };
        return send(
          res,
          200,
          gateway.setDevMode(b.enabled, b.capabilities ?? [], { actor: 'owner-ui', confirmed: b.confirmed === true }),
        );
      }
      if (req.method === 'GET' && url.pathname === '/audit') return send(res, 200, audit.list());
      if (req.method === 'GET' && url.pathname === '/audit/verify')
        return send(res, 200, { broken_at: audit.verify() });
      if (req.method === 'POST' && url.pathname === '/claude-desktop/health-test')
        return send(res, 200, await claudeHealthTest());
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const err = e as { error?: unknown };
      if (err.error) return send(res, 400, err.error);
      return send(res, 500, { error: redactor.redact(e instanceof Error ? e.message : String(e)) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    gateway,
    redactor,
    handshake: {
      type: 'modulex-core-handshake',
      version: STUDIO_CORE_VERSION,
      port,
      token: tokens['owner-ui'],
      agentToken: tokens['modulex-agent'],
      claudeDesktopToken: tokens['claude-desktop'],
      pid: process.pid,
    },
    // closeAllConnections: MCP clients keep HTTP keep-alive sockets open; without it close() never resolves.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
