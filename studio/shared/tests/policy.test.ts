// SPDX-License-Identifier: Apache-2.0
// Table-driven: every catalogue tool × caller × Developer Mode state (Execution Patch 1 §2, §45).
import { describe, expect, it } from 'vitest';
import {
  advertisedTools,
  decide,
  DEV_MODE_OFF,
  RAW_TOOLS,
  STUDIO_TOOLS,
  TOOL_CATALOG,
  type Caller,
  type DevModeState,
} from '../src/policy.js';

const DEV_RAW: DevModeState = { enabled: true, capabilities: ['raw-tools'] };
const DEV_REFLECT: DevModeState = { enabled: true, capabilities: ['raw-tools', 'reflection'] };
const AGENTS: Caller[] = ['modulex-agent', 'claude-desktop'];

describe('catalogue', () => {
  it('has unique ids and puts every real Godot-MCP / ModuleX tool id in the raw layer', () => {
    expect(TOOL_CATALOG.size).toBe(STUDIO_TOOLS.length + RAW_TOOLS.length);
    for (const id of ['node-delete', 'resource-delete', 'reflection-method-call', 'game-quit', 'project-settings-set'])
      expect(TOOL_CATALOG.get(id)?.layer).toBe('raw');
    expect(RAW_TOOLS).toHaveLength(54); // 39 Godot-MCP standard + 2 skill + 5 project-* + 8 game-*
  });
  it('treats node-delete / resource-delete as destructive although the addon has no DestructiveHint', () => {
    expect(TOOL_CATALOG.get('node-delete')!.tier).toBe('destructive');
    expect(TOOL_CATALOG.get('resource-delete')!.tier).toBe('destructive');
  });
});

describe('raw tools are unreachable for agents by default', () => {
  for (const tool of RAW_TOOLS)
    for (const caller of AGENTS)
      it(`${caller} → ${tool.id} denied without Developer Mode`, () => {
        const d = decide(tool.id, { caller, devMode: DEV_MODE_OFF });
        expect(d.effect).toBe('deny');
      });
});

describe('Developer Mode', () => {
  it('opens raw read/write tools to the ModuleX Agent only', () => {
    expect(decide('node-find', { caller: 'modulex-agent', devMode: DEV_RAW }).effect).toBe('allow');
    expect(decide('node-create', { caller: 'modulex-agent', devMode: DEV_RAW }).effect).toBe('allow');
    expect(decide('node-find', { caller: 'claude-desktop', devMode: DEV_REFLECT }).effect).toBe('deny');
  });
  it('still asks for destructive raw tools', () => {
    expect(decide('node-delete', { caller: 'modulex-agent', devMode: DEV_RAW }).effect).toBe('ask');
  });
  it('reflection needs the elevated capability and is still asked per call', () => {
    const noCap = decide('reflection-method-call', { caller: 'modulex-agent', devMode: DEV_RAW });
    expect(noCap).toMatchObject({ effect: 'deny', code: 'DEVELOPER_MODE_REQUIRED' });
    expect(decide('reflection-method-call', { caller: 'modulex-agent', devMode: DEV_REFLECT }).effect).toBe('ask');
  });
  it('is required even for internal reflection', () => {
    expect(decide('reflection-method-call', { caller: 'studio-internal', devMode: DEV_MODE_OFF }).effect).toBe('deny');
  });
});

describe('studio layer', () => {
  it('reads and writes are automatic for the agent', () => {
    expect(decide('studio_project_status', { caller: 'modulex-agent', devMode: DEV_MODE_OFF }).effect).toBe('allow');
    expect(decide('studio_game_create', { caller: 'claude-desktop', devMode: DEV_MODE_OFF }).effect).toBe('allow');
  });
  it('destructive studio tools need approval for every agent caller (Claude cannot bypass)', () => {
    for (const caller of AGENTS)
      expect(decide('studio_asset_delete', { caller, devMode: DEV_REFLECT }).effect).toBe('ask');
  });
  it('an owner "always allow" override lifts only studio-layer destructive tools', () => {
    const alwaysAllow = new Set(['studio_asset_delete', 'node-delete', 'studio_policy_change']);
    expect(decide('studio_asset_delete', { caller: 'modulex-agent', devMode: DEV_MODE_OFF, alwaysAllow }).effect).toBe(
      'allow',
    );
    expect(decide('node-delete', { caller: 'modulex-agent', devMode: DEV_RAW, alwaysAllow }).effect).toBe('ask');
    expect(decide('studio_policy_change', { caller: 'modulex-agent', devMode: DEV_MODE_OFF, alwaysAllow }).effect).toBe(
      'deny',
    );
  });
  it('critical actions (policy, secrets, worker trust, project delete) are owner-UI only', () => {
    for (const id of ['studio_policy_change', 'studio_secret_set', 'studio_worker_register', 'studio_project_delete']) {
      for (const caller of AGENTS) expect(decide(id, { caller, devMode: DEV_REFLECT }).effect).toBe('deny');
      expect(decide(id, { caller: 'owner-ui', devMode: DEV_MODE_OFF }).effect).toBe('ask');
    }
  });
  it('cost tier asks above the threshold and when the cost is unknown', () => {
    const base = { caller: 'modulex-agent' as const, devMode: DEV_MODE_OFF };
    expect(decide('studio_asset_generate', { ...base, estimatedCostUsd: 0.1 }).effect).toBe('allow');
    expect(decide('studio_asset_generate', { ...base, estimatedCostUsd: 0.4 }).effect).toBe('ask');
    expect(decide('studio_asset_generate', base).effect).toBe('ask');
  });
  it('Claude Desktop only reaches its safe subset', () => {
    expect(decide('studio_fix_failure', { caller: 'claude-desktop', devMode: DEV_MODE_OFF })).toMatchObject({
      effect: 'deny',
      code: 'TOOL_NOT_ALLOWED',
    });
  });
  it('roles restrict writes but not reads', () => {
    expect(decide('studio_build', { caller: 'modulex-agent', role: 'qa', devMode: DEV_MODE_OFF }).effect).toBe('deny');
    expect(
      decide('studio_build', { caller: 'modulex-agent', role: 'build-release', devMode: DEV_MODE_OFF }).effect,
    ).toBe('allow');
    expect(decide('studio_build_status', { caller: 'modulex-agent', role: 'qa', devMode: DEV_MODE_OFF }).effect).toBe(
      'allow',
    );
  });
  it('unknown tools are denied', () => {
    expect(decide('rm-rf', { caller: 'owner-ui', devMode: DEV_MODE_OFF })).toMatchObject({
      effect: 'deny',
      code: 'TOOL_UNKNOWN',
    });
  });
});

describe('advertised tool lists', () => {
  it('default agent list is studio-only; Claude Desktop is a subset; no critical tool is ever advertised', () => {
    const agent = advertisedTools('modulex-agent', DEV_MODE_OFF).map((t) => t.id);
    const desktop = advertisedTools('claude-desktop', DEV_REFLECT).map((t) => t.id);
    expect(agent.every((id) => id.startsWith('studio_'))).toBe(true);
    expect(desktop.every((id) => agent.includes(id))).toBe(true);
    expect(desktop).not.toContain('reflection-method-call');
    for (const id of [...agent, ...desktop]) expect(TOOL_CATALOG.get(id)!.tier).not.toBe('critical');
  });
  it('Developer Mode adds raw tools, and reflection only with its capability', () => {
    expect(advertisedTools('modulex-agent', DEV_RAW).map((t) => t.id)).not.toContain('reflection-method-call');
    expect(advertisedTools('modulex-agent', DEV_REFLECT).map((t) => t.id)).toContain('reflection-method-call');
  });
});
