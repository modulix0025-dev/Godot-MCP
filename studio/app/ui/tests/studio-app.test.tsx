// SPDX-License-Identifier: Apache-2.0
//
// The production UI against a fake Studio Core (the real owner endpoint shapes): live projects and pipeline,
// owner decisions on approvals, the Setup Assistant (including Android licence consent), the health cluster
// derived only from reported data, per-endpoint error states, RTL, and the owner token never leaving memory.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootScreen, healthSignals, parseLiveRoute, StudioApp } from '../src/studio/StudioApp';
import { EMPTY_SNAPSHOT } from '../src/studio/useSnapshot';

const TOKEN = 'owner-token-secret-value';
const conn = { base: 'http://127.0.0.1:47821', token: TOKEN };

const stages = [
  'user_request',
  'game_specification',
  'project_creation',
  'asset_generation',
  'scene_construction',
  'playtest',
  'build',
  'export',
];

function fakeCore(over: Record<string, unknown> = {}, fail: string[] = []) {
  const posts: { path: string; body: unknown }[] = [];
  const data: Record<string, unknown> = {
    '/health': { ok: true, version: '0.1.0', pipeline: { available: true, qaTier: true } },
    '/projects': [
      {
        project_id: 'space-kid-journey',
        name: 'رحلة طفل في الفضاء',
        created_at: '2026-10-01T10:00:00Z',
        platforms: ['windows', 'ios'],
        executing: false,
        run: {
          run_id: 'run_abc',
          stages: stages.map((s, i) => ({
            stage: s,
            status: i < 6 ? 'SUCCESS' : i === 6 ? 'SUCCESS' : 'PARTIAL_SUCCESS',
            reason: s === 'export' ? 'ios PREPARED — macOS/Xcode build worker required' : null,
          })),
          blocked: null,
          completion: {
            isGameComplete: false,
            status: 'PARTIAL_SUCCESS',
            missing: ['windows.launchSmokePassed'],
            failed: ['ios.signedBuild: macOS/Xcode build worker required'],
            notes: [],
          },
        },
        builds: [
          {
            build_id: 'b_1',
            platform: 'windows',
            profile: 'RELEASE',
            status: 'BUILT',
            version: '0.1.0',
            sha256: 'a'.repeat(64),
            size_bytes: 96823808,
            created_at: '2026-10-01T10:30:00Z',
            note: null,
          },
        ],
        spent_usd: 0,
      },
    ],
    '/approvals': [
      {
        approval_id: 'ap_1',
        tool: 'studio_assets_delete_generated',
        requested_by: 'claude-desktop',
        role: null,
        created_at: '2026-10-01T10:00:00Z',
        expires_at: '2026-10-01T10:30:00Z',
        status: 'pending',
        impact: {
          what: 'Delete all generated assets',
          why: 'Asked by Claude Desktop',
          scope: 'space-kid-journey',
          files: ['res://assets/generated/'],
          risk: 'high',
          rollback: 'moved to .modulex/trash',
        },
      },
    ],
    '/audit': [
      {
        seq: 1,
        ts: '2026-10-01T10:00:00Z',
        type: 'pipeline_run_created',
        actor: 'claude-desktop',
        data: { project_id: 'space-kid-journey' },
      },
    ],
    '/setup': {
      components: [
        {
          id: 'godot-mono',
          status: 'installed',
          version: '4.5.1-stable mono',
          path: 'C:/x',
          origin: 'bundled',
          verified: null,
          message: null,
        },
        {
          id: 'export-templates',
          status: 'missing',
          version: null,
          path: null,
          origin: null,
          verified: null,
          message: null,
        },
        {
          id: 'mcp-server',
          status: 'installed',
          version: '9.2.9',
          path: 'C:/s',
          origin: 'bundled',
          verified: null,
          message: null,
        },
        {
          id: 'android-sdk',
          status: 'needs_owner',
          version: null,
          path: null,
          origin: null,
          verified: null,
          message: 'licence',
        },
      ],
      plan: ['export-templates', 'android-sdk'],
      progress: {},
      pipeline: { available: true, qaTier: true },
    },
    '/build-workers': [],
    '/workers': [],
    '/budget': { caps: { monthly_usd: 50, per_project_usd: 20 }, month_usd: 3.2, total_usd: 3.2, ledger: true },
    '/dev-mode': { enabled: false, capabilities: [] },
    ...over,
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(conn.base, '');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: path.startsWith('/setup') ? 202 : 200 });
    }
    if (fail.includes(path)) return new Response(JSON.stringify({ error: `boom on ${path}` }), { status: 500 });
    const body = data[path];
    return body === undefined
      ? new Response('{"error":"not found"}', { status: 404 })
      : new Response(JSON.stringify(body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts, fetchMock };
}

beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.dir = 'ltr';
});

describe('production UI (live Core)', () => {
  it('Projects shows live games with their status, platforms and spend; the token is not stored anywhere', async () => {
    fakeCore();
    window.location.hash = '#/projects';
    render(<StudioApp connection={conn} />);
    expect(await screen.findByText('رحلة طفل في الفضاء')).toBeTruthy();
    expect(screen.getByText('partial success')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('Studio shows the pipeline and the completion verdict exactly as Core computed it', async () => {
    fakeCore();
    window.location.hash = '#/studio/space-kid-journey';
    render(<StudioApp connection={conn} />);
    expect(await screen.findByText('Asset generation')).toBeTruthy();
    // In the export stage's reason and in the completion verdict's failed row.
    expect(screen.getAllByText(/macOS\/Xcode build worker required$/)).toHaveLength(2);
    expect(screen.getByText('windows.launchSmokePassed')).toBeTruthy();
    expect(screen.getByText(/sha256 aaaaaaaaaaaa/)).toBeTruthy();
  });

  it('Approvals: the owner decision is posted; Claude Desktop requests have no "always allow"', async () => {
    const { posts } = fakeCore();
    window.location.hash = '#/approvals';
    render(<StudioApp connection={conn} />);
    expect(await screen.findByText('studio_assets_delete_generated')).toBeTruthy();
    expect(screen.queryByText('Always allow for this project')).toBeNull();
    await act(async () => fireEvent.click(screen.getByText('Approve')));
    expect(posts).toContainEqual({ path: '/approvals/ap_1', body: { action: 'approve', always_for_project: false } });
  });

  it('Setup Assistant: installs on request; the Android SDK needs the licence checkbox first', async () => {
    const { posts } = fakeCore();
    window.location.hash = '#/setup';
    render(<StudioApp connection={conn} />);
    const row = (await screen.findByText('Export templates 4.5.1 (.NET)')).closest('tr')!;
    await act(async () => fireEvent.click(within(row).getByText('Install')));
    expect(posts).toContainEqual({
      path: '/setup/install',
      body: { component: 'export-templates', accept_android_license: false },
    });
    const android = screen.getByText('Android SDK (Android)').closest('tr')!;
    const btn = within(android).getByText('Install') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(btn.disabled).toBe(false);
    await act(async () => fireEvent.click(btn));
    expect(posts).toContainEqual({
      path: '/setup/install',
      body: { component: 'android-sdk', accept_android_license: true },
    });
  });

  it('a failing endpoint shows its own error state with the evidence; the rest still works', async () => {
    fakeCore({}, ['/projects']);
    window.location.hash = '#/projects';
    render(<StudioApp connection={conn} />);
    expect(await screen.findByText('Studio Core did not answer this request')).toBeTruthy();
    expect(screen.getByText('boom on /projects')).toBeTruthy();
    expect(screen.getByText(/\$3\.20 \/ \$50\.00/)).toBeTruthy();
  });

  it('Settings switches to Arabic (RTL) and persists the choice', async () => {
    fakeCore();
    window.location.hash = '#/settings';
    render(<StudioApp connection={conn} />);
    fireEvent.click(await screen.findByText('العربية'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(localStorage.getItem('mx.lang')).toBe('ar');
  });

  it('Developer Mode needs an explicit second confirmation', async () => {
    const { posts } = fakeCore();
    window.location.hash = '#/settings';
    render(<StudioApp connection={conn} />);
    fireEvent.click(await screen.findByText('Enable…'));
    expect(posts).toEqual([]);
    await act(async () => fireEvent.click(screen.getByText('Yes, enable for this session')));
    expect(posts).toContainEqual({
      path: '/dev-mode',
      body: { enabled: true, capabilities: ['raw-tools'], confirmed: true },
    });
  });
});

describe('Settings → Claude Desktop', () => {
  it('copies the pairing token from the shell to the clipboard without ever displaying it', async () => {
    fakeCore();
    const invoke = vi.fn(async (cmd: string) =>
      cmd === 'claude_desktop_pairing_token'
        ? 'PAIRING-TOKEN-VALUE-123'
        : 'C:/app/claude-desktop/modulex-game-studio.mcpb',
    );
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      window.location.hash = '#/settings';
      render(<StudioApp connection={conn} />);
      await act(async () => fireEvent.click(await screen.findByText('2 · Copy pairing token')));
      expect(writeText).toHaveBeenCalledWith('PAIRING-TOKEN-VALUE-123');
      expect(document.body.textContent).not.toContain('PAIRING-TOKEN-VALUE-123');
      expect(screen.getByText(/Pairing token copied/)).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByText('1 · Show the extension file')));
      expect(invoke).toHaveBeenCalledWith('reveal_claude_extension', undefined);
      expect(screen.getByText(/modulex-game-studio\.mcpb/)).toBeTruthy();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

describe('health cluster and routing', () => {
  it('derives every signal from reported data only', () => {
    const none = healthSignals(EMPTY_SNAPSHOT);
    expect(none.find((h) => h.key === 'agent')!.tone).toBe('danger');
    expect(none.find((h) => h.key === 'godot')!.tone).toBe('warning');
    expect(none.find((h) => h.key === 'buildWorkers')!.tip).toMatch(/iOS stays PREPARED/);
  });

  it('parses #/<screen>/<project> and rejects anything else', () => {
    expect(parseLiveRoute('#/studio/space-kid')).toEqual({ screen: 'studio', projectId: 'space-kid' });
    expect(parseLiveRoute('#/nope')).toEqual({ screen: 'projects', projectId: null });
    expect(parseLiveRoute('#/studio/../../etc')).toEqual({ screen: 'studio', projectId: null });
  });
});

describe('startup: Studio Core starts in the background', () => {
  const setShell = (invoke: (cmd: string) => Promise<unknown>) =>
    ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke });
  const clearShell = () => delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  it('polls while Core is starting, then opens the app when it is ready', async () => {
    fakeCore();
    let calls = 0;
    setShell(async (cmd) => {
      expect(cmd).toBe('core_connection');
      calls++;
      return calls < 3
        ? { status: 'starting', elapsed_s: calls }
        : { status: 'ready', port: 47821, token: TOKEN, version: '0.1.0' };
    });
    try {
      window.location.hash = '#/projects';
      render(<StudioApp />);
      expect(await screen.findByText(/Starting Studio Core/)).toBeTruthy();
      expect(await screen.findByText('رحلة طفل في الفضاء', {}, { timeout: 5000 })).toBeTruthy();
      expect(calls).toBe(3);
    } finally {
      clearShell();
    }
  });

  it('shows why Core did not start, where the log is, and retries through the shell', async () => {
    const invoke = vi.fn(async (cmd: string) =>
      cmd === 'restart_core'
        ? null
        : { status: 'failed', error: 'Studio Core exited during startup (exit code: 1)', log: 'C:/x/logs/core.log' },
    );
    setShell(invoke);
    try {
      render(<StudioApp />);
      expect(await screen.findByText('Studio Core did not start')).toBeTruthy();
      expect(screen.getByText(/exited during startup/)).toBeTruthy();
      expect(screen.getByText('C:/x/logs/core.log')).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByText('Retry')));
      expect(invoke).toHaveBeenCalledWith('restart_core', undefined);
    } finally {
      clearShell();
    }
  });

  it('a shell rejection (a plain string, as Tauri sends it) is shown, never an endless "Starting"', async () => {
    setShell(async () => {
      throw 'command core_connection not allowed';
    });
    try {
      render(<StudioApp />);
      expect(await screen.findByText('command core_connection not allowed')).toBeTruthy();
    } finally {
      clearShell();
    }
  });

  it('after 20 s of starting, explains the first-launch scan', () => {
    render(<BootScreen boot={{ status: 'starting', elapsedS: 25 }} onRetry={() => undefined} />);
    expect(screen.getByText(/first launch can take up to a minute/)).toBeTruthy();
  });
});
