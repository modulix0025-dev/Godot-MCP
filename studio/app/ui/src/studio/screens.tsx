// SPDX-License-Identifier: Apache-2.0
//
// Production screens (Phase 13), built on the approved Phase 3 design system: the same tokens, layout classes and
// components as the review prototype, fed only with live Core data. Rules carried over from the review:
//   - colour only for semantic state (tones); monochrome otherwise; no Godot logo;
//   - every screen has its Empty / Loading / Error / Blocked variant, with what is missing and the fix;
//   - nothing is invented: what Core does not report is shown as "not reported".
import { useEffect, useState, type ReactNode } from 'react';
import {
  BlockedState,
  Card,
  CostBadge,
  EmptyState,
  ErrorState,
  KeyValue,
  Progress,
  SkeletonRows,
  StatusDot,
  StatusPill,
} from '../prototype/components';
import type { Strings } from '../prototype/i18n';
import type { Tone } from '../prototype/data';
import type { CoreClient } from './client';
import {
  BUILD_TONE,
  OUTCOME_TONE,
  stageLabel,
  usd,
  type Approval,
  type ProjectDetail,
  type ProjectSummary,
  type SetupComponentState,
  type Snapshot,
} from './types';

export interface LiveProps {
  t: Strings;
  snap: Snapshot;
  loaded: boolean;
  client: CoreClient;
  refresh: () => Promise<void>;
  projectId: string | null;
  go: (screen: string, projectId?: string | null) => void;
}

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-page">
      <div className="mx-page__head">
        <h1>{title}</h1>
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
    </div>
  );
}

function copy(lines: string[]) {
  void navigator.clipboard?.writeText(lines.join('\n')).catch(() => undefined);
}

/** Loading → skeleton, error → evidence + retry, otherwise the content. */
function Live({
  loaded,
  error,
  t,
  retry,
  children,
}: {
  loaded: boolean;
  error: string | undefined;
  t: Strings;
  retry: () => void;
  children: ReactNode;
}) {
  if (!loaded)
    return (
      <Card pad={false}>
        <SkeletonRows />
      </Card>
    );
  if (error)
    return (
      <Card>
        <ErrorState
          title="Studio Core did not answer this request"
          evidence={[error]}
          next={
            <button className="btn btn--primary" onClick={retry}>
              Retry
            </button>
          }
          copyLabel={t.copyDiagnostics}
        />
      </Card>
    );
  return <>{children}</>;
}

function runStatus(p: ProjectSummary): { label: string; tone: Tone } {
  if (p.executing) {
    const i = p.run?.stages.findIndex((s) => s.status === 'RUNNING') ?? -1;
    return { label: `Running · stage ${i + 1}/${p.run?.stages.length ?? 0}`, tone: 'running' };
  }
  const c = p.run?.completion;
  if (c)
    return {
      label: c.isGameComplete ? 'Complete' : c.status.replace('_', ' ').toLowerCase(),
      tone: OUTCOME_TONE[c.status],
    };
  if (p.run?.blocked) return { label: 'Stopped', tone: 'warning' };
  return { label: p.run ? 'Planned' : 'No run', tone: 'info' };
}

function setupMissing(snap: Snapshot): SetupComponentState[] {
  const plan = new Set(snap.setup?.plan ?? []);
  return (snap.setup?.components ?? []).filter((c) => plan.has(c.id));
}

/* ---------------- Projects ---------------- */
export function ProjectsScreen({ t, snap, loaded, refresh, go }: LiveProps) {
  const projects = snap.projects ?? [];
  const missing = setupMissing(snap);
  return (
    <Page title={t.nav.projects}>
      <Live loaded={loaded} error={snap.errors.projects} t={t} retry={() => void refresh()}>
        {snap.setup && !snap.setup.pipeline.available && (
          <Card>
            <BlockedState
              title="Setup is not finished: games are planned but not built yet"
              missing={missing.map((c) => `${c.id} — ${c.status === 'failed' ? `failed: ${c.message}` : c.status}`)}
              fix={
                <button className="btn btn--primary" onClick={() => go('setup')}>
                  Open Setup Assistant
                </button>
              }
            />
          </Card>
        )}
        {projects.length === 0 ? (
          <Card>
            <EmptyState
              title="No games yet"
              purpose="Describe a game to the ModuleX Agent or to Claude Desktop (connected to this Studio); it appears here with its pipeline."
              action={null}
            />
          </Card>
        ) : (
          <Card pad={false}>
            <table className="table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Status</th>
                  <th>Platforms</th>
                  <th>Builds</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const st = runStatus(p);
                  return (
                    <tr key={p.project_id} style={{ cursor: 'pointer' }} onClick={() => go('studio', p.project_id)}>
                      <td>
                        <div dir="auto" style={{ fontWeight: 600 }}>
                          {p.name}
                        </div>
                        <div className="faint mono" style={{ fontSize: 12 }}>
                          {p.project_id}
                        </div>
                      </td>
                      <td>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 12 }}>
                          {p.platforms.map((pl) => {
                            const b = [...p.builds].reverse().find((x) => x.platform === pl);
                            return (
                              <span
                                key={pl}
                                className="muted"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                              >
                                <StatusDot tone={b ? BUILD_TONE[b.status] : 'neutral'} /> {pl}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="num muted">{p.builds.length}</td>
                      <td className="num">{usd(p.spent_usd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </Live>
    </Page>
  );
}

/* ---------------- Studio: one project's pipeline ---------------- */
export function StudioScreen(props: LiveProps) {
  const { t, snap, loaded, refresh, projectId, go } = props;
  const p = snap.projects?.find((x) => x.project_id === projectId) ?? snap.projects?.[0] ?? null;
  return (
    <Page title={p ? p.name : t.nav.studio}>
      <Live loaded={loaded} error={snap.errors.projects} t={t} retry={() => void refresh()}>
        {!p ? (
          <Card>
            <EmptyState
              title="No game selected"
              purpose="Games created by the ModuleX Agent or Claude Desktop show their 19-stage pipeline here."
              action={
                <button className="btn" onClick={() => go('projects')}>
                  {t.nav.projects}
                </button>
              }
            />
          </Card>
        ) : !p.run ? (
          <Card>
            <EmptyState
              title="No pipeline run yet"
              purpose="The Game Specification is stored; no run was created."
              action={null}
            />
          </Card>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <Card title="Pipeline" actions={<span className="faint mono">{p.run.run_id}</span>}>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {p.run.stages.map((s) => (
                  <li key={s.stage} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                    <StatusDot tone={OUTCOME_TONE[s.status]} pulse={s.status === 'RUNNING'} />
                    <span style={{ minWidth: 180 }}>{stageLabel(s.stage)}</span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {s.status === 'PENDING' ? '' : s.status.replace('_', ' ').toLowerCase()}
                      {s.reason ? ` — ${s.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
            <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
              <CompletionCard p={p} />
              {p.run.blocked && (
                <Card title="Why it stopped">
                  <p className="muted" style={{ margin: 0 }}>
                    {p.run.blocked.message}
                  </p>
                </Card>
              )}
              <Card title={t.nav.builds}>
                <BuildList builds={p.builds} />
              </Card>
            </div>
          </div>
        )}
      </Live>
    </Page>
  );
}

function CompletionCard({ p }: { p: ProjectSummary }) {
  const c = p.run?.completion;
  if (!c)
    return (
      <Card title="Completion">
        <p className="muted" style={{ margin: 0 }}>
          Not evaluated yet: the verdict is computed from recorded evidence after the pipeline runs.
        </p>
      </Card>
    );
  return (
    <Card
      title="Completion"
      actions={
        <StatusPill tone={OUTCOME_TONE[c.status]}>{c.isGameComplete ? 'complete' : c.status.toLowerCase()}</StatusPill>
      }
    >
      {c.isGameComplete ? (
        <p className="muted" style={{ margin: 0 }}>
          Every evidence row is proven.
        </p>
      ) : (
        <KeyValue
          rows={[
            ...(c.failed.length ? ([['Failed', c.failed.join(', ')]] as [string, string][]) : []),
            ...(c.missing.length ? ([['No evidence', c.missing.join(', ')]] as [string, string][]) : []),
            ...c.notes.map((n) => ['Note', n] as [string, string]),
          ]}
        />
      )}
    </Card>
  );
}

function BuildList({ builds }: { builds: ProjectSummary['builds'] }) {
  if (!builds.length)
    return (
      <p className="muted" style={{ margin: 0 }}>
        No builds yet.
      </p>
    );
  return (
    <table className="table">
      <tbody>
        {[...builds].reverse().map((b) => (
          <tr key={b.build_id}>
            <td>{b.platform}</td>
            <td className="mono faint">{b.profile}</td>
            <td>
              <StatusPill tone={BUILD_TONE[b.status]}>{b.status.toLowerCase()}</StatusPill>
            </td>
            <td className="mono faint" title={b.sha256 ?? undefined}>
              {b.sha256 ? `sha256 ${b.sha256.slice(0, 12)}…` : (b.note ?? '')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- Builds ---------------- */
export function BuildsScreen({ t, snap, loaded, refresh, go }: LiveProps) {
  const rows = (snap.projects ?? []).flatMap((p) => p.builds.map((b) => ({ p, b })));
  return (
    <Page title={t.nav.builds}>
      <Live loaded={loaded} error={snap.errors.projects} t={t} retry={() => void refresh()}>
        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No builds yet"
              purpose="Exports appear here with their sha256 once a pipeline reaches Build and Export."
              action={null}
            />
          </Card>
        ) : (
          <Card pad={false}>
            <table className="table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Platform</th>
                  <th>Profile</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Size</th>
                  <th>sha256 / note</th>
                </tr>
              </thead>
              <tbody>
                {rows.reverse().map(({ p, b }) => (
                  <tr key={b.build_id} onClick={() => go('studio', p.project_id)} style={{ cursor: 'pointer' }}>
                    <td dir="auto">{p.name}</td>
                    <td>{b.platform}</td>
                    <td className="mono">{b.profile}</td>
                    <td>
                      <StatusPill tone={BUILD_TONE[b.status]}>{b.status.toLowerCase()}</StatusPill>
                    </td>
                    <td className="num">{b.version}</td>
                    <td className="num muted">{b.size_bytes ? `${(b.size_bytes / 1048576).toFixed(1)} MB` : '—'}</td>
                    <td className="mono faint" style={{ fontSize: 12 }}>
                      {b.sha256 ?? b.note ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Live>
    </Page>
  );
}

/* ---------------- Activity (the hash-chained audit log) ---------------- */
export function ActivityScreen({ t, snap, loaded, refresh }: LiveProps) {
  const entries = [...(snap.audit ?? [])].reverse().slice(0, 300);
  return (
    <Page title={t.nav.activity}>
      <Live loaded={loaded} error={snap.errors.audit} t={t} retry={() => void refresh()}>
        {entries.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing has happened yet"
              purpose="Every tool call, approval and pipeline step is recorded here."
              action={null}
            />
          </Card>
        ) : (
          <Card pad={false}>
            <table className="table">
              <tbody>
                {entries.map((e) => (
                  <tr key={e.seq}>
                    <td className="num faint" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(e.ts).toLocaleTimeString()}
                    </td>
                    <td className="mono">{e.type}</td>
                    <td className="muted">{e.actor}</td>
                    <td className="mono faint" style={{ fontSize: 12 }}>
                      {summarise(e.data)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Live>
    </Page>
  );
}

function summarise(d: Record<string, unknown>): string {
  return Object.entries(d)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
    .slice(0, 160);
}

/* ---------------- Approvals ---------------- */
export function ApprovalsScreen({ t, snap, loaded, refresh, client }: LiveProps) {
  const pending = (snap.approvals ?? []).filter((a) => a.status === 'pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (a: Approval, action: 'approve' | 'reject', always = false) => {
    setBusy(a.approval_id);
    setError(null);
    try {
      await client.post(`/approvals/${a.approval_id}`, { action, always_for_project: always });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Page title={t.nav.approvals}>
      <Live loaded={loaded} error={snap.errors.approvals} t={t} retry={() => void refresh()}>
        {error && (
          <Card>
            <ErrorState
              title="The decision was not recorded"
              evidence={[error]}
              next={null}
              copyLabel={t.copyDiagnostics}
            />
          </Card>
        )}
        {pending.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing waiting for you"
              purpose="Destructive, costly or critical actions pause here until you decide."
              action={null}
            />
          </Card>
        ) : (
          pending.map((a) => (
            <Card
              key={a.approval_id}
              title={
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono">{a.tool}</span>
                  <StatusPill tone={a.impact.risk === 'high' || a.impact.risk === 'critical' ? 'danger' : 'neutral'}>
                    {a.impact.risk}
                  </StatusPill>
                </span>
              }
              actions={<span className="faint num">expires {new Date(a.expires_at).toLocaleTimeString()}</span>}
            >
              <KeyValue
                rows={[
                  ['Requested by', `${a.requested_by}${a.role ? ` · ${a.role}` : ''}`],
                  ['What', a.impact.what],
                  ['Why', a.impact.why],
                  ['Scope', a.impact.scope],
                  [
                    'Files',
                    <span className="mono" style={{ display: 'flex', flexDirection: 'column' }}>
                      {a.impact.files.length ? a.impact.files.map((f) => <span key={f}>{f}</span>) : '—'}
                    </span>,
                  ],
                  ['Rollback', a.impact.rollback],
                ]}
              />
              <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
                <button className="btn btn--primary" disabled={busy !== null} onClick={() => void decide(a, 'approve')}>
                  {t.approve}
                </button>
                <button className="btn" disabled={busy !== null} onClick={() => void decide(a, 'reject')}>
                  {t.reject}
                </button>
                {a.requested_by === 'modulex-agent' && (
                  <button
                    className="btn btn--ghost"
                    disabled={busy !== null}
                    onClick={() => void decide(a, 'approve', true)}
                  >
                    {t.alwaysAllow}
                  </button>
                )}
              </div>
            </Card>
          ))
        )}
      </Live>
    </Page>
  );
}

/* ---------------- Workers ---------------- */
const TRUST_TONE: Record<string, Tone> = {
  TRUSTED: 'success',
  DEGRADED: 'warning',
  UNTRUSTED: 'neutral',
  QUARANTINED: 'danger',
  OFFLINE: 'neutral',
};

export function WorkersScreen({ t, snap, loaded, refresh, client }: LiveProps) {
  const [pair, setPair] = useState({ url: '', code: '', name: '' });
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const doPair = async () => {
    setMsg(null);
    try {
      await client.post('/build-workers/pair', pair);
      setMsg({ tone: 'success', text: 'Paired. The worker token is stored in Windows Credential Manager.' });
      setPair({ url: '', code: '', name: '' });
      await refresh();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  return (
    <Page title={t.nav.workers}>
      <Live loaded={loaded} error={snap.errors.workers ?? snap.errors.buildWorkers} t={t} retry={() => void refresh()}>
        <Card title="ComfyUI workers (assets)">
          {(snap.workers ?? []).length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No ComfyUI worker registered. Generated 3D assets need a TRUSTED worker; until then games use procedural
              placeholders and say so.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {snap.workers!.map((w) => (
                  <tr key={w.worker_id}>
                    <td className="mono">{w.worker_id}</td>
                    <td>
                      <StatusPill tone={TRUST_TONE[w.trust] ?? 'neutral'}>{w.trust.toLowerCase()}</StatusPill>
                    </td>
                    <td className="muted">{w.gpu ?? '—'}</td>
                    <td className="faint">{w.quarantine_reason ?? (w.capabilities ?? []).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Build workers (macOS for signed iOS)">
          {(snap.buildWorkers ?? []).length === 0 ? (
            <p className="muted" style={{ marginBlockStart: 0 }}>
              No build worker paired. iOS stays PREPARED until a macOS worker signs it.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {snap.buildWorkers!.map((w) => (
                  <tr key={w.worker_id}>
                    <td dir="auto">{w.name}</td>
                    <td className="mono faint">{w.worker_id}</td>
                    <td>{w.capabilities?.platforms.join(', ') ?? 'not reported'}</td>
                    <td className="faint">{w.capabilities?.signing_profiles.join(', ') || 'no signing profiles'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, marginBlockStart: 12 }}>
            <input
              className="input"
              placeholder="https://mac-mini.local:47830"
              value={pair.url}
              onChange={(e) => setPair({ ...pair, url: e.target.value })}
              aria-label="Worker URL"
            />
            <input
              className="input"
              placeholder="ABCD-EFGH"
              value={pair.code}
              onChange={(e) => setPair({ ...pair, code: e.target.value })}
              aria-label="Pairing code"
            />
            <input
              className="input"
              placeholder="Name"
              value={pair.name}
              onChange={(e) => setPair({ ...pair, name: e.target.value })}
              aria-label="Worker name"
            />
            <button className="btn btn--primary" disabled={!pair.url || !pair.code} onClick={() => void doPair()}>
              Pair
            </button>
          </div>
          {msg && (
            <p style={{ marginBlockEnd: 0 }}>
              <StatusPill tone={msg.tone}>{msg.text}</StatusPill>
            </p>
          )}
        </Card>
      </Live>
    </Page>
  );
}

/* ---------------- Setup Assistant ---------------- */
const COMPONENT_LABEL: Record<string, string> = {
  'godot-mono': 'Godot 4.5.1 (.NET) editor',
  'export-templates': 'Export templates 4.5.1 (.NET)',
  'dotnet-sdk': '.NET 8 SDK (private)',
  'mcp-server': 'gamedev-mcp-server 9.2.9',
  git: 'Git',
  jdk: 'JDK 17 (Android)',
  'android-sdk': 'Android SDK (Android)',
  'android-build-template': 'Android build template',
};
const SETUP_TONE: Record<SetupComponentState['status'], Tone> = {
  installed: 'success',
  installing: 'running',
  missing: 'neutral',
  failed: 'danger',
  needs_owner: 'accent',
};

export function SetupScreen({ t, snap, loaded, refresh, client }: LiveProps) {
  const [acceptAndroid, setAcceptAndroid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = async (id: string) => {
    setError(null);
    try {
      await client.post('/setup/install', {
        component: id,
        accept_android_license: id === 'android-sdk' ? acceptAndroid : false,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const plan = new Set(snap.setup?.plan ?? []);
  return (
    <Page
      title="Setup Assistant"
      actions={
        plan.size > 0 ? (
          <button
            className="btn btn--primary"
            onClick={() => void Promise.all([...plan].filter((id) => id !== 'android-sdk').map(install))}
          >
            Install everything needed
          </button>
        ) : undefined
      }
    >
      <Live loaded={loaded} error={snap.errors.setup} t={t} retry={() => void refresh()}>
        {error && (
          <Card>
            <ErrorState
              title="The install did not start"
              evidence={[error]}
              next={null}
              copyLabel={t.copyDiagnostics}
            />
          </Card>
        )}
        <Card pad={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Status</th>
                <th>Version</th>
                <th>Verified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(snap.setup?.components ?? []).map((c) => {
                const prog = snap.setup?.progress[c.id];
                return (
                  <tr key={c.id}>
                    <td>
                      <div>{COMPONENT_LABEL[c.id] ?? c.id}</div>
                      {c.message && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {c.message}
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusPill tone={SETUP_TONE[c.status]}>
                        {c.status === 'installed' && c.origin ? `${c.origin}` : c.status.replace('_', ' ')}
                      </StatusPill>
                      {c.status === 'installing' && prog?.total ? (
                        <Progress value={Math.round((prog.received / prog.total) * 100)} />
                      ) : null}
                    </td>
                    <td className="num muted">{c.version ?? '—'}</td>
                    <td className="mono faint" style={{ fontSize: 12 }} title={c.verified ?? undefined}>
                      {c.verified ? `${c.verified.slice(0, 18)}…` : '—'}
                    </td>
                    <td>
                      {c.status !== 'installed' &&
                        c.status !== 'installing' &&
                        (plan.has(c.id) || c.status === 'failed' || c.status === 'needs_owner') && (
                          <button
                            className="btn btn--sm"
                            disabled={c.id === 'android-sdk' && !acceptAndroid}
                            onClick={() => void install(c.id)}
                          >
                            {c.status === 'failed' ? 'Retry' : 'Install'}
                          </button>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        {(plan.has('android-sdk') ||
          snap.setup?.components.some((c) => c.id === 'android-sdk' && c.status === 'needs_owner')) && (
          <Card title="Android SDK licence">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={acceptAndroid} onChange={(e) => setAcceptAndroid(e.target.checked)} />I
              have read and accept the Android Software Development Kit License Agreement.
            </label>
          </Card>
        )}
        <Card title="Pipeline">
          <KeyValue
            rows={[
              [
                'Builds games',
                <StatusPill tone={snap.setup?.pipeline.available ? 'success' : 'warning'}>
                  {snap.setup?.pipeline.available ? 'yes' : 'not yet'}
                </StatusPill>,
              ],
              [
                'Scripted playtests',
                <StatusPill tone={snap.setup?.pipeline.qaTier ? 'success' : 'warning'}>
                  {snap.setup?.pipeline.qaTier ? 'yes' : 'not yet'}
                </StatusPill>,
              ],
            ]}
          />
        </Card>
      </Live>
    </Page>
  );
}

/* ---------------- Assets / Test & Debug (from the selected project's record) ---------------- */
function useProject(client: CoreClient, id: string | null) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    client
      .get<ProjectDetail>(`/projects/${id}`)
      .then((x) => live && setP(x))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [client, id]);
  return { p, error };
}

export function AssetsScreen(props: LiveProps) {
  const { t, snap, client, projectId, loaded } = props;
  const id = projectId ?? snap.projects?.[0]?.project_id ?? null;
  const { p, error } = useProject(client, id);
  return (
    <Page title={t.nav.assets}>
      <Live
        loaded={loaded && (Boolean(p) || Boolean(error) || !id)}
        error={error ?? undefined}
        t={t}
        retry={() => void props.refresh()}
      >
        {!p || p.provenance.length === 0 ? (
          <Card>
            <EmptyState
              title="No assets recorded"
              purpose="Every generated or procedural asset is listed with its provenance and commercial-use verdict."
              action={null}
            />
          </Card>
        ) : (
          <Card pad={false}>
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Source</th>
                  <th>Licence</th>
                </tr>
              </thead>
              <tbody>
                {p.provenance.map((a) => (
                  <tr key={a.asset_id}>
                    <td className="mono">{a.asset_id}</td>
                    <td>{a.source}</td>
                    <td className="faint">
                      {(a.license_facts ?? []).map((f) => `${f.license} (${f.commercial_use})`).join('; ') ||
                        'not reported'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Live>
    </Page>
  );
}

export function TestScreen(props: LiveProps) {
  const { t, snap, client, projectId, loaded } = props;
  const id = projectId ?? snap.projects?.[0]?.project_id ?? null;
  const { p, error } = useProject(client, id);
  const run = p?.runs.at(-1);
  const qaStages = (run?.stages ?? []).filter((s) =>
    ['qa', 'playtest', 'visual_inspection', 'bug_fixes', 'regression'].includes(s.stage),
  );
  return (
    <Page title={t.nav.test}>
      <Live
        loaded={loaded && (Boolean(p) || Boolean(error) || !id)}
        error={error ?? undefined}
        t={t}
        retry={() => void props.refresh()}
      >
        {!run ? (
          <Card>
            <EmptyState
              title="No test results yet"
              purpose="Static checks, scripted playtests and the fix loop report here with their evidence."
              action={null}
            />
          </Card>
        ) : (
          <>
            {qaStages.map((s) => (
              <Card
                key={s.stage}
                title={stageLabel(s.stage)}
                actions={<StatusPill tone={OUTCOME_TONE[s.status]}>{s.status.toLowerCase()}</StatusPill>}
              >
                {s.reason && <p className="muted">{s.reason}</p>}
                <div className="console">
                  {(s.evidence.length ? s.evidence : ['no evidence recorded']).map((l, i) => (
                    <div className="console__line" key={i}>
                      {l}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
            {p!.recent_errors.length > 0 && (
              <Card
                title="Recent errors"
                actions={
                  <button
                    className="btn btn--sm"
                    onClick={() => copy(p!.recent_errors.map((e) => `${e.at} ${e.source}: ${e.message}`))}
                  >
                    {t.copyDiagnostics}
                  </button>
                }
              >
                <div className="console">
                  {p!.recent_errors.slice(-20).map((e, i) => (
                    <div className="console__line" key={i}>
                      {e.source}: {e.message}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </Live>
    </Page>
  );
}

/* ---------------- Settings ---------------- */
export function SettingsScreen({
  t,
  snap,
  client,
  refresh,
  theme,
  lang,
  onTheme,
  onLang,
}: LiveProps & {
  theme: 'dark' | 'light';
  lang: 'en' | 'ar';
  onTheme: (t: 'dark' | 'light') => void;
  onLang: (l: 'en' | 'ar') => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dev = snap.devMode;
  const setDev = async (enabled: boolean) => {
    setError(null);
    try {
      await client.post('/dev-mode', { enabled, capabilities: enabled ? ['raw-tools'] : [], confirmed: true });
      setConfirming(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Page title={t.nav.settings}>
      <Card title="Appearance">
        <div style={{ display: 'flex', gap: 16 }}>
          <div className="seg">
            <button aria-pressed={theme === 'dark'} onClick={() => onTheme('dark')}>
              Dark
            </button>
            <button aria-pressed={theme === 'light'} onClick={() => onTheme('light')}>
              Light
            </button>
          </div>
          <div className="seg">
            <button aria-pressed={lang === 'en'} onClick={() => onLang('en')}>
              English
            </button>
            <button aria-pressed={lang === 'ar'} onClick={() => onLang('ar')}>
              العربية
            </button>
          </div>
        </div>
      </Card>
      <Card title="Budget">
        {snap.budget ? (
          <KeyValue
            rows={[
              ['This month', `${usd(snap.budget.month_usd)} of ${usd(snap.budget.caps.monthly_usd)}`],
              ['Per project cap', usd(snap.budget.caps.per_project_usd)],
              ['Spend beyond a cap', 'always asks you first'],
            ]}
          />
        ) : (
          <p className="muted">Budget not reported.</p>
        )}
      </Card>
      <Card
        title="Developer Mode"
        actions={<StatusPill tone={dev?.enabled ? 'warning' : 'neutral'}>{dev?.enabled ? 'on' : 'off'}</StatusPill>}
      >
        <p className="muted" style={{ marginBlockStart: 0 }}>
          Off: agents see only the Agent-safe studio_* tools. On: the ModuleX Agent may also call raw Godot-MCP tools.
          Claude Desktop never gets raw tools.
        </p>
        {error && <StatusPill tone="danger">{error}</StatusPill>}
        {dev?.enabled ? (
          <button className="btn" onClick={() => void setDev(false)}>
            Turn off
          </button>
        ) : confirming ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--primary" onClick={() => void setDev(true)}>
              Yes, enable for this session
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setConfirming(true)}>
            Enable…
          </button>
        )}
      </Card>
      <Card title="Version">
        <KeyValue rows={[['Studio Core', snap.health?.version ?? 'not reported']]} />
      </Card>
    </Page>
  );
}

export { CostBadge };
