// SPDX-License-Identifier: Apache-2.0
//
// Clickable static prototype for the Phase 3 UI Direction Review. Route:
//   #/prototype/<screen>?state=normal|empty|loading|error|blocked&theme=dark|light&lang=en|ar
// Everything is driven from the URL so each screen × state × theme × language can be reviewed and
// screenshotted deterministically. The dashed "review bar" is prototype chrome, not product UI.
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import '../design/tokens.css';
import '../design/components.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import { StatusDot } from './components';
import { STRINGS, type Lang, type Strings } from './i18n';
import type { Tone } from './data';
import {
  IconActivity,
  IconApprovals,
  IconAssets,
  IconBuilds,
  IconHome,
  IconSearch,
  IconSettings,
  IconStudio,
  IconTest,
  IconWorkers,
  KeystoneMark,
} from './icons';
import {
  ActivityScreen,
  ApprovalsScreen,
  AssetsScreen,
  BuildsScreen,
  ProjectsScreen,
  SETTINGS_SECTIONS,
  SettingsScreen,
  StudioScreen,
  TestScreen,
  WorkersScreen,
  type ScreenProps,
  type SettingsSection,
  type ViewState,
} from './screens';

export const SCREENS = [
  'projects',
  'studio',
  'activity',
  'assets',
  'test',
  'builds',
  'workers',
  'approvals',
  'settings',
] as const;
export type ScreenId = (typeof SCREENS)[number];
export const VIEW_STATES: ViewState[] = ['normal', 'empty', 'loading', 'error', 'blocked'];

const ICONS: Record<ScreenId, ComponentType<{ size?: number }>> = {
  projects: IconHome,
  studio: IconStudio,
  activity: IconActivity,
  assets: IconAssets,
  test: IconTest,
  builds: IconBuilds,
  workers: IconWorkers,
  approvals: IconApprovals,
  settings: IconSettings,
};

/** Top-bar health cluster (Execution Patch 1 §27): compact dots, detail on hover. */
const HEALTH: [keyof Strings['health'], Tone, string][] = [
  ['agent', 'success', 'ModuleX Agent connected · studio MCP 127.0.0.1:47821'],
  ['godot', 'success', 'Godot 4.5.1 mono editor running · addon godot_mcp + modulex_studio'],
  ['mcp', 'success', 'gamedev-mcp-server 9.2.9 · token auth · 54 raw tools (Developer Mode only)'],
  ['comfyui', 'warning', '1 TRUSTED · 1 QUARANTINED · 1 onboarding'],
  ['buildWorkers', 'neutral', 'No macOS worker — iOS release BLOCKED'],
  ['claude', 'success', 'Claude API ok · Claude Desktop paired (health test 13:50)'],
];

export interface Route {
  screen: ScreenId;
  state: ViewState;
  theme: 'dark' | 'light';
  lang: Lang;
  section: SettingsSection;
}

const SECTION_IDS = SETTINGS_SECTIONS.map(([id]) => id) as SettingsSection[];

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const screen = path.split('/')[1] as ScreenId;
  const q = new URLSearchParams(query);
  const state = q.get('state') as ViewState;
  return {
    screen: SCREENS.includes(screen) ? screen : 'studio',
    state: VIEW_STATES.includes(state) ? state : 'normal',
    theme: q.get('theme') === 'light' ? 'light' : 'dark',
    lang: q.get('lang') === 'ar' ? 'ar' : 'en',
    section: SECTION_IDS.includes(q.get('section') as SettingsSection)
      ? (q.get('section') as SettingsSection)
      : 'appearance',
  };
}

export function routeToHash(r: Route): string {
  const section = r.screen === 'settings' && r.section !== 'appearance' ? `&section=${r.section}` : '';
  return `#/prototype/${r.screen}?state=${r.state}&theme=${r.theme}&lang=${r.lang}${section}`;
}

export function Prototype() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [palette, setPalette] = useState(false);
  const t = STRINGS[route.lang];

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = route.theme;
    root.lang = route.lang;
    root.dir = route.lang === 'ar' ? 'rtl' : 'ltr';
  }, [route.theme, route.lang]);

  const go = useCallback((patch: Partial<Route>) => {
    const next = { ...parseRoute(window.location.hash), ...patch };
    window.location.hash = routeToHash(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') {
        setPalette(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const props: ScreenProps = { t, state: route.state };
  const screen: ReactNode = (() => {
    switch (route.screen) {
      case 'projects':
        return <ProjectsScreen {...props} />;
      case 'studio':
        return <StudioScreen {...props} />;
      case 'activity':
        return <ActivityScreen {...props} />;
      case 'assets':
        return <AssetsScreen {...props} />;
      case 'test':
        return <TestScreen {...props} />;
      case 'builds':
        return <BuildsScreen {...props} />;
      case 'workers':
        return <WorkersScreen {...props} />;
      case 'approvals':
        return <ApprovalsScreen {...props} />;
      case 'settings':
        return (
          <SettingsScreen
            {...props}
            theme={route.theme}
            lang={route.lang}
            onTheme={(theme) => go({ theme })}
            onLang={(lang) => go({ lang })}
            section={route.section}
            onSection={(section) => go({ section })}
          />
        );
    }
  })();

  return (
    <div className="mx-app">
      <nav className="mx-rail" aria-label="Primary">
        <div className="mx-rail__logo">
          <KeystoneMark size={32} />
        </div>
        {SCREENS.filter((s) => s !== 'settings').map((s) => {
          const Icon = ICONS[s];
          return (
            <button
              key={s}
              className="mx-rail__btn"
              title={t.nav[s]}
              aria-label={t.nav[s]}
              aria-current={route.screen === s ? 'page' : undefined}
              onClick={() => go({ screen: s })}
            >
              <Icon />
              {s === 'approvals' && <span className="mx-rail__badge">2</span>}
            </button>
          );
        })}
        <span className="mx-rail__spacer" />
        <button
          className="mx-rail__btn"
          title={t.nav.settings}
          aria-label={t.nav.settings}
          aria-current={route.screen === 'settings' ? 'page' : undefined}
          onClick={() => go({ screen: 'settings' })}
        >
          <IconSettings />
        </button>
      </nav>

      <header className="mx-topbar">
        <span className="mx-topbar__title">
          ModuleX{' '}
          <span style={{ fontWeight: 400 }} className="muted">
            Game Studio
          </span>
        </span>
        <button className="btn btn--sm" dir="auto">
          جزيرة المستكشف ▾
        </button>
        <span className="mx-topbar__grow" />
        <div className="health" aria-label="Connection health">
          {HEALTH.map(([key, tone, tip]) => (
            <span key={key} className="health__item" title={tip}>
              <StatusDot tone={tone} /> {t.health[key]}
            </span>
          ))}
        </div>
        <button
          className="pill tone-neutral dev-pill"
          title="Developer Mode is off — agents see only Agent-safe studio_* tools"
          onClick={() => go({ screen: 'settings', section: 'developer' })}
        >
          Dev mode · off
        </button>
        <div className="budget num" title={t.budget}>
          <span>$3.20 / $50</span>
          <div className="meter">
            <span style={{ width: '6.4%' }} />
          </div>
        </div>
        <button className="btn btn--sm" onClick={() => go({ screen: 'approvals' })}>
          <IconApprovals size={14} /> 2
        </button>
        <button className="btn btn--sm" onClick={() => setPalette(true)}>
          <IconSearch size={14} /> <span className="kbd">Ctrl K</span>
        </button>
      </header>

      <main className="mx-main">{screen}</main>

      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onGo={(screen) => {
            go({ screen });
            setPalette(false);
          }}
          placeholder={t.search}
          labels={t.nav}
        />
      )}

      <div className="proto-bar" role="toolbar" aria-label="Prototype review controls">
        <strong className="muted">Prototype</strong>
        <div className="seg">
          {VIEW_STATES.map((s) => (
            <button key={s} aria-pressed={route.state === s} onClick={() => go({ state: s })}>
              {t.states[s]}
            </button>
          ))}
        </div>
        <div className="seg">
          <button aria-pressed={route.theme === 'dark'} onClick={() => go({ theme: 'dark' })}>
            Dark
          </button>
          <button aria-pressed={route.theme === 'light'} onClick={() => go({ theme: 'light' })}>
            Light
          </button>
        </div>
        <div className="seg">
          <button aria-pressed={route.lang === 'en'} onClick={() => go({ lang: 'en' })}>
            EN
          </button>
          <button aria-pressed={route.lang === 'ar'} onClick={() => go({ lang: 'ar' })}>
            ع
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandPalette({
  onClose,
  onGo,
  placeholder,
  labels,
}: {
  onClose: () => void;
  onGo: (s: ScreenId) => void;
  placeholder: string;
  labels: Record<ScreenId, string>;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = SCREENS.filter((s) => labels[s].toLowerCase().includes(q.toLowerCase()) || s.includes(q.toLowerCase()));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, items.length - 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
            if (e.key === 'Enter' && items[sel]) onGo(items[sel]);
          }}
        />
        {items.map((s, i) => {
          const Icon = ICONS[s];
          return (
            <div
              key={s}
              className="palette__item"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => onGo(s)}
            >
              <Icon size={16} />
              <span>{labels[s]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
