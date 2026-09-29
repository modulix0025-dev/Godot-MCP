// SPDX-License-Identifier: Apache-2.0
//
// ModuleX Game Studio — Claude Desktop extension server (Execution Patch 1 §19–22).
//
//   Claude Desktop ──stdio MCP──▶ this bridge ──HTTP MCP (bearer: pairing token)──▶ Studio Core /mcp
//                                                                                  (caller = claude-desktop)
//
// The bridge holds NO policy and NO tools of its own: it forwards tools/list and tools/call to the running
// Studio, where the Policy Gateway decides everything (safe high-level tools only, approvals owner-only, raw
// engine tools never). Configuration comes from the extension's user_config, which Claude Desktop stores
// (the pairing token is `sensitive`, i.e. kept in the OS keychain), exposed to this process as env vars:
//   MODULEX_CORE_URL        e.g. http://127.0.0.1:47821
//   MODULEX_PAIRING_TOKEN   the Claude Desktop pairing token shown in Studio → Settings → AI Providers
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { studioError } from '@modulex/shared';

const CORE_URL = (process.env.MODULEX_CORE_URL || 'http://127.0.0.1:47821').replace(/\/+$/, '');
const TOKEN = process.env.MODULEX_PAIRING_TOKEN ?? '';

function loopbackOnly(u: string): void {
  const host = new URL(u).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`MODULEX_CORE_URL must point to this machine (loopback); got '${host}'.`);
  }
}

let client: Client | null = null;

async function connect(): Promise<Client> {
  if (client) return client;
  loopbackOnly(CORE_URL);
  if (!TOKEN) throw new Error('No pairing token configured.');
  const c = new Client({ name: 'modulex-claude-desktop-bridge', version: '0.1.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  client = c;
  return c;
}

function unavailable(reason: string) {
  const err = studioError(
    'BLOCKED',
    'STUDIO_UNAVAILABLE',
    `ModuleX Game Studio is not reachable (${reason}).`,
    "Open the ModuleX Game Studio app, then use Settings → AI Providers → Claude Desktop → Verify Connection. If the pairing token changed, update it in this extension's settings.",
    true,
  );
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }],
    structuredContent: err,
    isError: true,
  };
}

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized/i.test(m)) return 'pairing token rejected';
  if (/ECONNREFUSED|fetch failed/i.test(m)) return 'the Studio app is not running';
  return m.replace(TOKEN, '<redacted>').slice(0, 200);
}

const server = new Server(
  { name: 'modulex-game-studio', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Tools of ModuleX Game Studio (a local desktop app). Create games with studio_game_create (write a complete GAME_SPEC first), follow progress with studio_project_status / studio_pipeline_status, and read manifests with the *_get tools. Destructive actions return PENDING_APPROVAL — the owner approves in the Studio app; you cannot.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await (await connect()).listTools();
  } catch (e) {
    client = null;
    // Keep Claude informed instead of failing the whole extension: a single diagnostic-free list.
    process.stderr.write(`[modulex-bridge] list_tools failed: ${reason(e)}\n`);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const c = await connect();
    return await c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} });
  } catch (e) {
    client = null; // reconnect on the next call (Studio restarted, token rotated, …)
    return unavailable(reason(e));
  }
});

await server.connect(new StdioServerTransport());
