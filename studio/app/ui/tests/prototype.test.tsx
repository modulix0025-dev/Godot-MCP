// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoute, Prototype, routeToHash, SCREENS, VIEW_STATES } from '../src/prototype/Prototype';
import { STRINGS } from '../src/prototype/i18n';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('prototype routing', () => {
  it('round-trips every route', () => {
    for (const s of SCREENS)
      for (const st of VIEW_STATES) {
        const r = { screen: s, state: st, theme: 'light' as const, lang: 'ar' as const };
        expect(parseRoute(routeToHash(r))).toEqual(r);
      }
  });

  it('falls back to safe defaults for unknown values', () => {
    expect(parseRoute('#/prototype/nope?state=weird&theme=x&lang=fr')).toEqual({
      screen: 'studio',
      state: 'normal',
      theme: 'dark',
      lang: 'en',
    });
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

  it('every navigation label exists in both languages', () => {
    for (const s of SCREENS) {
      expect(STRINGS.en.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).toBeTruthy();
      expect(STRINGS.ar.nav[s]).not.toBe(STRINGS.en.nav[s]);
    }
  });
});
