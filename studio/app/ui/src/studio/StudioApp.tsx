// SPDX-License-Identifier: Apache-2.0
//
// The production desktop UI (Phase 13): the approved Phase 3 shell — icon rail, top bar with the six-signal health
// cluster, Developer Mode pill, budget meter, approvals badge and Ctrl+K — wired to live Core data. Routes are
// `#/<screen>[/<project_id>]`; theme and language persist per viewer. The review prototype stays at #/prototype.
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import '../design/tokens.css';
import '../design/components.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import { StatusDot } from '../prototype/components';
import type { Tone } from '../prototype/data';
import { STRINGS, type Lang } from '../prototype/i18n';
import {
  IconActivity,
  IconApprovals,
  IconAssets,
  IconBuilds,
  IconHome,
  IconSearch,
  IconSettings,
  IconStudio,
  IconSystem,
  IconTest,
  IconWorkers,
  KeystoneMark,
} from '../prototype/icons';
import { bootStatus, CoreClient, errorText, shellInvoke, type CoreBoot, type CoreConnection } from './client';
import {
  ActivityScreen,
  ApprovalsScreen,
  AssetsScreen,
  BuildsScreen,
  ProjectsScreen,
  SettingsScreen,
  SetupScreen,
  StudioScreen,
  TestScreen,
  WorkersScreen,
  type LiveProps,
} from './screens';
import { usd, type Snapshot } from './types';
import { useSnapshot } from './useSnapshot';

export const LIVE_SCREENS = [
  'projects',
  'studio',
  'activity',
  'assets',
  'test',
  'builds',
  'workers',
  'approvals',
  'setup',
  'settings',
] as const;
export type LiveScreen = (typeof LIVE_SCREENS)[number];

const ICONS: Record<LiveScreen, ComponentType<{ size?: number }>> = {
  projects: IconHome,
  studio: IconStudio,
  activity: IconActivity,
  assets: IconAssets,
  test: IconTest,
  builds: IconBuilds,
  workers: IconWorkers,
  approvals: IconApprovals,
  setup: IconSystem,
  settings: IconSettings,
};

export function parseLiveRoute(hash: string): { screen: LiveScreen; projectId: string | null } {
  const [screen, projectId] = hash.replace(/^#\/?/, '').split('?')[0]!.split('/');
  return {
    screen: LIVE_SCREENS.includes(screen as LiveScreen) ? (screen as LiveScreen) : 'projects',
    projectId: projectId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId) ? projectId : null,
  };
}

function pref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* per-viewer convenience only */
  }
}

/** The six-signal health cluster, derived only from what Core reports. */
export function healthSignals(s: Snapshot): { key: string; label: string; tone: Tone; tip: string }[] {
  const comp = (id: string) => s.setup?.components.find((c) => c.id === id);
  const godot = comp('godot-mono');
  const server = comp('mcp-server');
  const trusted = (s.workers ?? []).filter((w) => w.trust === 'TRUSTED').length;
  const mac = (s.buildWorkers ?? []).some((w) => w.capabilities?.platforms.includes('ios'));
  return [
    {
      key: 'agent',
      label: 'Core',
      tone: s.health?.ok ? 'success' : 'danger',
      tip: s.health ? `Studio Core ${s.health.version} · studio MCP on loopback` : 'Studio Core is not answering',
    },
    {
      key: 'godot',
      label: 'Godot',
      tone: godot?.status === 'installed' ? 'success' : godot?.status === 'failed' ? 'danger' : 'warning',
      tip:
        godot?.status === 'installed'
          ? `Godot ${godot.version ?? '4.5.1'} (${godot.origin})`
          : 'Godot 4.5.1 (.NET) not installed — Setup Assistant',
    },
    {
      key: 'mcp',
      label: 'MCP',
      tone: server?.status === 'installed' ? 'success' : 'warning',
      tip:
        server?.status === 'installed'
          ? `gamedev-mcp-server ${server.version ?? ''}`
          : 'gamedev-mcp-server not installed — scripted playtests unavailable',
    },
    {
      key: 'comfyui',
      label: 'ComfyUI',
      tone: trusted > 0 ? 'success' : 'neutral',
      tip:
        trusted > 0 ? `${trusted} TRUSTED worker(s)` : 'No TRUSTED ComfyUI worker — assets are procedural placeholders',
    },
    {
      key: 'buildWorkers',
      label: 'Build Workers',
      tone: mac ? 'success' : 'neutral',
      tip: mac ? 'macOS worker paired — signed iOS available' : 'No macOS worker — iOS stays PREPARED',
    },
    {
      key: 'pipeline',
      label: 'Pipeline',
      tone: s.setup?.pipeline.available ? (s.setup.pipeline.qaTier ? 'success' : 'warning') : 'warning',
      tip: s.setup?.pipeline.available
        ? s.setup.pipeline.qaTier
          ? 'Games are built and playtested'
          : 'Games are built; scripted playtests need the MCP server'
        : 'Games are planned only until Godot is installed',
    },
  ];
}

export function StudioApp({ connection }: { connection?: CoreConnection | null }) {
  const [conn, setConn] = useState<CoreConnection | null>(connection ?? null);
  const [boot, setBoot] = useState<CoreBoot>({ status: 'starting', elapsedS: 0 });
  const [attempt, setAttempt] = useState(0);
  // Core starts in the background: poll the shell until it is ready or reports why it failed.
  useEffect(() => {
    if (conn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let b: CoreBoot;
      try {
        b = await bootStatus();
      } catch (e) {
        b = { status: 'failed', error: errorText(e), log: null };
      }
      if (stopped) return;
      if (b.status === 'ready') setConn(b.connection);
      else setBoot(b);
      if (b.status === 'starting') timer = setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [conn, attempt]);
  const retry = useCallback(async () => {
    setBoot({ status: 'starting', elapsedS: 0 });
    try {
      await shellInvoke('restart_core');
    } catch (e) {
      setBoot({ status: 'failed', error: errorText(e), log: null });
      return;
    }
    setAttempt((a) => a + 1);
  }, []);
  const client = useMemo(() => (conn ? new CoreClient(conn) : null), [conn]);
  const { snap, loaded, refresh } = useSnapshot(client);

  const [route, setRoute] = useState(() => parseLiveRoute(window.location.hash));
  const [theme, setTheme] = useState<'dark' | 'light'>(() => pref('mx.theme', ['dark', 'light'] as const, 'dark'));
  const [lang, setLang] = useState<Lang>(() => pref('mx.lang', ['en', 'ar'] as const, 'en'));
  const [palette, setPalette] = useState(false);
  const t = STRINGS[lang];

  useEffect(() => {
    const onHash = () => setRoute(parseLiveRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [theme, lang]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // First run: nothing installed yet → open the Setup Assistant once.
  useEffect(() => {
    if (loaded && snap.setup && !snap.setup.pipeline.available && !window.location.hash)
      window.location.hash = '#/setup';
  }, [loaded, snap.setup]);

  const go = useCallback((screen: string, projectId?: string | null) => {
    window.location.hash = `#/${screen}${projectId ? `/${projectId}` : ''}`;
  }, []);

  if (!client) return <BootScreen boot={boot} onRetry={() => void retry()} />;

  const props: LiveProps = { t, snap, loaded, client, refresh, projectId: route.projectId, go };
  const pending = (snap.approvals ?? []).filter((a) => a.status === 'pending').length;
  const selected = snap.projects?.find((p) => p.project_id === route.projectId) ?? null;
  const budget = snap.budget;
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
      case 'setup':
        return <SetupScreen {...props} />;
      case 'settings':
        return (
          <SettingsScreen
            {...props}
            theme={theme}
            lang={lang}
            onTheme={(v) => {
              setTheme(v);
              save('mx.theme', v);
            }}
            onLang={(v) => {
              setLang(v);
              save('mx.lang', v);
            }}
          />
        );
    }
  })();
  const label = (s: LiveScreen) => (s === 'setup' ? (lang === 'ar' ? 'الإعداد' : 'Setup') : t.nav[s]);

  return (
    <div className="mx-app">
      <nav className="mx-rail" aria-label="Primary">
        <div className="mx-rail__logo">
          <KeystoneMark size={32} />
        </div>
        {LIVE_SCREENS.filter((s) => s !== 'settings').map((s) => {
          const Icon = ICONS[s];
          return (
            <button
              key={s}
              className="mx-rail__btn"
              title={label(s)}
              aria-label={label(s)}
              aria-current={route.screen === s ? 'page' : undefined}
              onClick={() => go(s, s === 'studio' || s === 'assets' || s === 'test' ? route.projectId : null)}
            >
              <Icon />
              {s === 'approvals' && pending > 0 && <span className="mx-rail__badge">{pending}</span>}
            </button>
          );
        })}
        <span className="mx-rail__spacer" />
        <button
          className="mx-rail__btn"
          title={t.nav.settings}
          aria-label={t.nav.settings}
          aria-current={route.screen === 'settings' ? 'page' : undefined}
          onClick={() => go('settings')}
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
        {selected && (
          <button className="btn btn--sm" dir="auto" onClick={() => go('projects')}>
            {selected.name} ▾
          </button>
        )}
        <span className="mx-topbar__grow" />
        <div className="health" aria-label="Connection health">
          {healthSignals(snap).map((h) => (
            <span key={h.key} className="health__item" title={h.tip}>
              <StatusDot tone={h.tone} /> {h.label}
            </span>
          ))}
        </div>
        <button
          className={`pill tone-${snap.devMode?.enabled ? 'warning' : 'neutral'} dev-pill`}
          title={
            snap.devMode?.enabled
              ? 'Developer Mode is on — the ModuleX Agent may call raw Godot-MCP tools'
              : 'Developer Mode is off — agents see only Agent-safe studio_* tools'
          }
          onClick={() => go('settings')}
        >
          Dev mode · {snap.devMode?.enabled ? 'on' : 'off'}
        </button>
        {budget && (
          <div className="budget num" title={t.budget}>
            <span>
              {usd(budget.month_usd)} / {usd(budget.caps.monthly_usd)}
            </span>
            <div className="meter">
              <span
                style={{
                  width: `${Math.min(100, (budget.month_usd / Math.max(budget.caps.monthly_usd, 0.01)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
        <button className="btn btn--sm" onClick={() => go('approvals')} aria-label={`${t.nav.approvals}: ${pending}`}>
          <IconApprovals size={14} /> {pending}
        </button>
        <button className="btn btn--sm" onClick={() => setPalette(true)}>
          <IconSearch size={14} /> <span className="kbd">Ctrl K</span>
        </button>
      </header>

      <main className="mx-main">{screen}</main>

      {palette && (
        <div className="overlay" onClick={() => setPalette(false)}>
          <Palette
            items={[
              ...LIVE_SCREENS.map((s) => ({ id: s, label: label(s), run: () => go(s) })),
              ...(snap.projects ?? []).map((p) => ({
                id: p.project_id,
                label: p.name,
                run: () => go('studio', p.project_id),
              })),
            ]}
            placeholder={t.search}
            onDone={() => setPalette(false)}
          />
        </div>
      )}
    </div>
  );
}

function Palette({
  items,
  placeholder,
  onDone,
}: {
  items: { id: string; label: string; run: () => void }[];
  placeholder: string;
  onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const shown = items.filter((i) => `${i.label} ${i.id}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const pick = (i: (typeof items)[number] | undefined) => {
    if (!i) return;
    i.run();
    onDone();
  };
  return (
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
          if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, shown.length - 1));
          if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
          if (e.key === 'Enter') pick(shown[sel]);
        }}
      />
      {shown.map((i, n) => (
        <div
          key={i.id}
          className="palette__item"
          aria-selected={n === sel}
          onMouseEnter={() => setSel(n)}
          onClick={() => pick(i)}
        >
          <span dir="auto">{i.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Before Studio Core answers: its startup progress, or why it did not start (with the log) and a retry. */
export function BootScreen({ boot, onRetry }: { boot: CoreBoot; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <main className="mx-page" style={{ padding: 32, maxWidth: 880 }}>
      <h1>ModuleX Game Studio</h1>
      {boot.status === 'starting' && (
        <>
          <p className="muted">
            Starting Studio Core…{boot.elapsedS > 0 ? ` (${boot.elapsedS} s)` : ''}
            <br />
            <span dir="rtl">جاري تشغيل Studio Core…</span>
          </p>
          {boot.elapsedS >= 20 && (
            <p className="faint">
              The first launch can take up to a minute while Windows scans the app. If it fails, this screen shows why.
            </p>
          )}
        </>
      )}
      {boot.status === 'failed' && (
        <section role="alert">
          <h2>Studio Core did not start</h2>
          <p dir="rtl">Studio Core ما اشتغلش. السبب تحت، والتفاصيل في ملف الـ log.</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} dir="ltr">
            {boot.error}
          </pre>
          {boot.log && (
            <p className="muted" dir="ltr" style={{ overflowWrap: 'anywhere' }}>
              Log: <code>{boot.log}</code>
            </p>
          )}
          <p style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--primary" onClick={onRetry}>
              Retry
            </button>
            <button
              className="btn"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(
                    `ModuleX Game Studio: Studio Core did not start\n${boot.error}\nLog: ${boot.log ?? 'n/a'}`,
                  )
                  .then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy diagnostics'}
            </button>
          </p>
        </section>
      )}
      {boot.status === 'outside' && (
        <p className="muted">Studio Core connection is only available inside the ModuleX Game Studio app.</p>
      )}
      <p className="faint">Built with the Godot Engine (MIT).</p>
    </main>
  );
}
