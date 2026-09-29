// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoute, Prototype, routeToHash, SCREENS, VIEW_STATES } from '../src/prototype/Prototype';
import { SETTINGS_SECTIONS, SYSTEM_SECTIONS } from '../src/prototype/screens';
import { STRINGS } from '../src/prototype/i18n';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('prototype routing', () => {
  it('round-trips every route', () => {
    for (const s of SCREENS)
      for (const st of VIEW_STATES) {
        const r = {
          screen: s,
          state: st,
          theme: 'light' as const,
          lang: 'ar' as const,
          section: 'appearance' as const,
          sys: 'overview' as const,
        };
        expect(parseRoute(routeToHash(r))).toEqual(r);
      }
  });

  it('falls back to safe defaults for unknown values', () => {
    expect(parseRoute('#/prototype/nope?state=weird&theme=x&lang=fr')).toEqual({
      screen: 'studio',
      state: 'normal',
      theme: 'dark',
      lang: 'en',
      section: 'appearance',
      sys: 'overview',
    });
  });

  it('round-trips every settings section', () => {
    for (const [section] of SETTINGS_SECTIONS) {
      const r = {
        screen: 'settings' as const,
        state: 'normal' as const,
        theme: 'dark' as const,
        lang: 'en' as const,
        section,
        sys: 'overview' as const,
      };
      expect(parseRoute(routeToHash(r))).toEqual(r);
    }
  });
});

describe('prototype rendering', () => {
  it.each(SCREENS.flatMap((s) => VIEW_STATES.map((st) => [s, st] as const)))('renders %s in state %s', (s, st) => {
    window.location.hash = `#/prototype/${s}?state=${st}`;
    render(<Prototype />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('switches the document to RTL Arabic', () => {
    window.location.hash = '#/prototype/studio?lang=ar&theme=light';
    act(() => {
      render(<Prototype />);
    });
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: STRINGS.ar.nav.projects })).toBeTruthy();
  });

  it('shows all six health signals in the top bar', () => {
    window.location.hash = '#/prototype/studio';
    render(<Prototype />);
    const health = screen.getByLabelText('Connection health');
    for (const k of ['agent', 'godot', 'mcp', 'comfyui', 'buildWorkers', 'claude'] as const)
      expect(health.textContent).toContain(STRINGS.en.health[k]);
    expect(screen.getByText('Dev mode · off')).toBeTruthy();
  });

  it('AI Providers lists the five providers; Local Agent SDK is unavailable; effort defaults to Medium', () => {
    window.location.hash = '#/prototype/settings?section=ai-providers';
    render(<Prototype />);
    for (const n of ['ModuleX Agent', 'Claude Desktop', 'Claude API', 'Local Agent SDK', 'Other providers'])
      expect(screen.getByText(n)).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(/thinking.*(on|off) switch/i)).toBeNull();
  });

  it('assets show provenance and block unknown licences', () => {
    window.location.hash = '#/prototype/assets';
    render(<Prototype />);
    expect(screen.getByText('BLOCKED — licence unknown')).toBeTruthy();
  });

  it('Claude Desktop approvals never offer "always allow"', () => {
    window.location.hash = '#/prototype/approvals';
    render(<Prototype />);
    expect(screen.getAllByRole('button', { name: STRINGS.en.alwaysAllow })).toHaveLength(1);
  });

  it('round-trips every System section', () => {
    for (const [sys] of SYSTEM_SECTIONS) {
      const r = {
        screen: 'system' as const,
        state: 'normal' as const,
        theme: 'dark' as const,
        lang: 'en' as const,
        section: 'appearance' as const,
        sys,
      };
      expect(parseRoute(routeToHash(r))).toEqual(r);
    }
  });

  it('System overview asks the agent, and the owner review shows the version transition and the three decisions', () => {
    window.location.hash = '#/prototype/system';
    render(<Prototype />);
    expect(screen.getByText('Ask ModuleX Agent to modify the system')).toBeTruthy();
    expect(screen.getByText('v0.1.0 → v0.2.0')).toBeTruthy();
    for (const b of ['Approve Update', 'Reject', 'Inspect Diff'])
      expect(screen.getByRole('button', { name: b })).toBeTruthy();
  });

  it('Evolution History shows every column, and CRITICAL policy changes need a typed confirmation', () => {
    window.location.hash = '#/prototype/system?section=history';
    render(<Prototype />);
    for (const h of [
      'Version',
      'Date',
      'Change',
      'Requested by',
      'AI/Manual',
      'Status',
      'Tests',
      'Approval',
      'Rollback',
    ])
      expect(screen.getAllByRole('columnheader', { name: h }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Confirmation')).toBeTruthy();
    expect(screen.getByText('ROLLED_BACK')).toBeTruthy();
  });

  it('Updates: Stable by default, never automatic, and Roll Back Update shows current/previous/reason/backup/health', () => {
    window.location.hash = '#/prototype/system?section=updates';
    render(<Prototype />);
    expect(screen.getByRole('button', { name: 'Stable' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Never — you start every update')).toBeTruthy();
    for (const k of ['Current', 'Previous', 'Reason', 'Backup', 'Health state'])
      expect(screen.getByText(k)).toBeTruthy();
  });

  it('Safe Mode offers rollback, disable extension, logs, repair and retry', () => {
    window.location.hash = '#/prototype/system?state=blocked';
    render(<Prototype />);
    for (const b of ['Roll back to 0.1.0', 'Disable extension', 'Inspect logs', 'Repair configuration', 'Retry update'])
      expect(screen.getByRole('button', { name: b })).toBeTruthy();
  });

  it('every navigation label exists in both languages', () => {
    for (const s of SCREENS) {
      expect(STRINGS.en.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).not.toBe(STRINGS.en.nav[s]);
    }
  });
});
