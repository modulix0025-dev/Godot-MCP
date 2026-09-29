// SPDX-License-Identifier: Apache-2.0
//
// Claude Desktop MCP mode (Execution Patch 1 §39): package generated, manifest valid, server starts, tool
// discovery, safe tool invocation, authentication/permissions, disconnect/reconnect. The bridge is exercised
// exactly as Claude Desktop runs it: a child process speaking MCP over stdio, configured through env vars.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advertisedTools, DEV_MODE_OFF, RAW_TOOLS, SAMPLE_GAME_SPEC } from '@modulex/shared';
import { startCore, type CoreServer } from '@modulex/core/dist/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(root, 'bundle');
// Run the CLI's JS entry through Node: node_modules/.bin/mcpb is a .cmd shim on Windows (spawn → ENOENT).
const mcpbCli = resolve(root, '../node_modules/@anthropic-ai/mcpb/dist/cli/cli.js');
const mcpb = (args: string[]) => execFileSync(process.execPath, [mcpbCli, ...args], { encoding: 'utf-8' });

beforeAll(() => {
  if (!existsSync(resolve(bundle, 'server/index.mjs')) || !existsSync(resolve(root, 'dist/modulex-game-studio.mcpb'))) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  }
}, 120_000);

async function bridge(env: Record<string, string>): Promise<Client> {
  const c = new Client({ name: 'claude-desktop-sim', version: '0' });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(bundle, 'server/index.mjs')],
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'ignore',
    }),
  );
  return c;
}

describe('package', () => {
  it('manifest is a valid MCPB manifest (official validator)', () => {
    const out = mcpb(['validate', resolve(bundle, 'manifest.json')]);
    expect(out).toMatch(/valid/i);
  });

  it('declares exactly the Claude Desktop tool set, no raw engine tools, and a sensitive pairing token', () => {
    const m = JSON.parse(readFileSync(resolve(bundle, 'manifest.json'), 'utf-8'));
    const names = m.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(advertisedTools('claude-desktop', DEV_MODE_OFF).map((t) => t.id));
    for (const raw of RAW_TOOLS) expect(names).not.toContain(raw.id);
    expect(m.user_config.pairing_token).toMatchObject({ sensitive: true, required: true });
    expect(m.server.mcp_config.env.MODULEX_PAIRING_TOKEN).toBe('${user_config.pairing_token}');
  });

  it('the .mcpb bundle is produced', () => {
    expect(existsSync(resolve(root, 'dist/modulex-game-studio.mcpb'))).toBe(true);
    const info = mcpb(['info', resolve(root, 'dist/modulex-game-studio.mcpb')]);
    expect(info).toMatch(/modulex-game-studio/);
  });
});

describe('bridge ↔ Studio Core', () => {
  let core: CoreServer;
  let port: number;
  const token = 'T'.repeat(43);

  beforeAll(async () => {
    core = await startCore({ claudeDesktopToken: token });
    port = core.handshake.port;
  });
  afterAll(async () => {
    await core.close();
  });

  it('discovers the Studio tools and calls a safe tool', async () => {
    const c = await bridge({ MODULEX_CORE_URL: `http://127.0.0.1:${port}`, MODULEX_PAIRING_TOKEN: token });
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('studio_game_create');
    expect(tools).not.toContain('reflection-method-call');
    const ping = await c.callTool({ name: 'studio_ping', arguments: {} });
    expect(ping.isError).toBe(false);
    expect((ping.structuredContent as { data: { pong: boolean } }).data.pong).toBe(true);
    // Scenario #2: the same Studio pipeline, through the same policies.
    const created = await c.callTool({ name: 'studio_game_create', arguments: { spec: SAMPLE_GAME_SPEC } });
    expect((created.structuredContent as { status: string }).status).toBe('PARTIAL_SUCCESS');
    const del = await c.callTool({
      name: 'studio_asset_delete',
      arguments: { project_id: 'space-kid-journey', all: true, reason: 'test approval' },
    });
    expect((del.structuredContent as { status: string }).status).toBe('PENDING_APPROVAL');
    // Raw engine tools are not even registered on the Claude Desktop surface: refused before the gateway.
    const raw = await c.callTool({ name: 'node-delete', arguments: {} });
    expect(raw.isError).toBe(true);
    await c.close();
    expect(core.gateway.audit.list({ type: 'claude_tool_call' }).map((e) => e.data.tool)).toEqual([
      'studio_ping',
      'studio_game_create',
      'studio_asset_delete',
    ]);
  });

  it('a wrong pairing token gets a structured STUDIO_UNAVAILABLE (token rejected), never Studio data', async () => {
    const c = await bridge({ MODULEX_CORE_URL: `http://127.0.0.1:${port}`, MODULEX_PAIRING_TOKEN: 'wrong-token' });
    expect((await c.listTools()).tools).toEqual([]);
    const r = await c.callTool({ name: 'studio_project_list', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 'BLOCKED', code: 'STUDIO_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(r)).toMatch(/pairing token rejected/);
    await c.close();
  });

  it('refuses a non-loopback Studio address', async () => {
    const c = await bridge({ MODULEX_CORE_URL: 'http://203.0.113.9:47821', MODULEX_PAIRING_TOKEN: token });
    const r = await c.callTool({ name: 'studio_ping', arguments: {} });
    expect(JSON.stringify(r)).toMatch(/loopback/);
    await c.close();
  });

  it('reports the Studio as down, then reconnects when it comes back', async () => {
    const c = await bridge({ MODULEX_CORE_URL: `http://127.0.0.1:${port}`, MODULEX_PAIRING_TOKEN: token });
    expect((await c.callTool({ name: 'studio_ping', arguments: {} })).isError).toBe(false);
    await core.close();
    const down = await c.callTool({ name: 'studio_ping', arguments: {} });
    expect(down.structuredContent).toMatchObject({ code: 'STUDIO_UNAVAILABLE' });
    core = await startCore({ claudeDesktopToken: token, port });
    const back = await c.callTool({ name: 'studio_ping', arguments: {} });
    expect(back.isError).toBe(false);
    await c.close();
  });
});
