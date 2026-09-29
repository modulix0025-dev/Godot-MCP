// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoute, Prototype, routeToHash, SCREENS, VIEW_STATES } from '../src/prototype/Prototype';
import { SETTINGS_SECTIONS } from '../src/prototype/screens';
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

  it('every navigation label exists in both languages', () => {
    for (const s of SCREENS) {
      expect(STRINGS.en.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).not.toBe(STRINGS.en.nav[s]);
    }
  });
});
