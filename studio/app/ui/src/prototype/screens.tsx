// SPDX-License-Identifier: Apache-2.0
//
// The nine destinations of the UI Direction Review (ANALYSIS.md §4.1/§4.2). Each screen renders its
// Normal layout plus Empty / Loading / Error / Blocked variants with screen-specific copy.
import type { ReactNode } from 'react';
import {
  BlockedState,
  Card,
  CostBadge,
  EmptyState,
  ErrorState,
  KeyValue,
  Progress,
  SkeletonRows,
  STAGE_TONE,
  StatusDot,
  StatusPill,
} from './components';
import {
  ACTIVITY,
  APPROVALS,
  ASSET_CHAIN,
  ASSETS,
  BUILDS,
  CHAT,
  CONSOLE_LINES,
  PROFILE_ROWS,
  PROJECTS,
  PROVENANCE,
  PROVIDERS,
  ROUTING,
  STAGES,
  TESTS,
  TRUST_TONE,
  WORKERS,
} from './data';
import type { Strings } from './i18n';
import { IconPause, IconPlay, IconPlus, IconSend } from './icons';

export type ViewState = 'normal' | 'empty' | 'loading' | 'error' | 'blocked';
export type ScreenProps = { t: Strings; state: ViewState };

function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
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

function Stateful({
  state,
  variants,
  children,
}: {
  state: ViewState;
  variants: Partial<Record<ViewState, ReactNode>>;
  children: ReactNode;
}) {
  if (state === 'normal') return <>{children}</>;
  if (state === 'loading') return <Card pad={false}>{variants.loading ?? <SkeletonRows />}</Card>;
  return <Card>{variants[state]}</Card>;
}

/* ---------------- Projects ---------------- */
export function ProjectsScreen({ t, state }: ScreenProps) {
  return (
    <Page
      title={t.nav.projects}
      actions={
        <>
          <button className="btn">{t.import}</button>
          <button className="btn btn--primary">
            <IconPlus size={14} /> {t.newGame}
          </button>
        </>
      }
    >
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="No games yet"
              purpose="Describe a game in Arabic or English; ModuleX builds it end to end."
              action={<button className="btn btn--primary">{t.newGame}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Could not read the project registry"
              evidence={['studio.db: SQLITE_BUSY (database is locked)', 'retry 3/3 failed after 4.2 s']}
              next={<button className="btn btn--primary">Retry</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Setup is not finished"
              missing={[
                'Godot 4.5.1 mono — not installed',
                '.NET 8 SDK — not installed',
                'Export templates 4.5.1.stable.mono — missing',
              ]}
              fix={<button className="btn btn--primary">Open Setup Assistant</button>}
            />
          ),
        }}
      >
        <Card pad={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Status</th>
                <th>Platforms</th>
                <th>Last build</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {PROJECTS.map((p) => (
                <tr key={p.name}>
                  <td>
                    <div dir="auto" style={{ fontWeight: 600 }}>
                      {p.name}
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {p.subtitle}
                    </div>
                  </td>
                  <td>
                    <StatusPill tone={p.status.tone}>{p.status.label}</StatusPill>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 12 }}>
                      {p.platforms.map((x) => (
                        <span
                          key={x.p}
                          className="muted"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        >
                          <StatusDot tone={x.tone} /> {x.p}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="num muted">{p.last}</td>
                  <td className="num">{p.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <Card title={t.recentActivity}>
            <ActivityList compact />
          </Card>
          <Card title={t.system}>
            <KeyValue
              rows={[
                ['Godot', <StatusPill tone="success">4.5.1 mono ✓</StatusPill>],
                ['.NET SDK', <StatusPill tone="success">8.0 ✓</StatusPill>],
                ['Export templates', <StatusPill tone="success">4.5.1.stable.mono ✓</StatusPill>],
                ['JDK / Android SDK', <StatusPill tone="neutral">Not installed</StatusPill>],
                ['MCP server', <StatusPill tone="success">9.2.9 · loopback · token</StatusPill>],
              ]}
            />
          </Card>
        </div>
      </Stateful>
    </Page>
  );
}

/* ---------------- Studio workspace ---------------- */
export function StudioScreen({ t, state }: ScreenProps) {
  if (state !== 'normal') {
    return (
      <Page title="جزيرة المستكشف · Island Explorer">
        <Stateful
          state={state}
          variants={{
            empty: (
              <EmptyState
                title="Start with a brief"
                purpose="Tell ModuleX what to build — the agent turns it into a design doc and a plan."
                action={<button className="btn btn--primary">Write a brief</button>}
              />
            ),
            error: (
              <ErrorState
                title="The Godot editor disconnected"
                evidence={[
                  'editor pid 18422 exited with code 139 (SIGSEGV)',
                  'last tool: scene-save res://levels/level_1.tscn',
                  'checkpoint mx-cp-14 is intact',
                ]}
                next={<button className="btn btn--primary">Restart editor</button>}
                copyLabel={t.copyDiagnostics}
              />
            ),
            blocked: (
              <BlockedState
                title="The agent is waiting for you"
                missing={['2 actions need approval (1 destructive, 1 over the cost threshold)']}
                fix={<button className="btn btn--primary">Review approvals</button>}
              />
            ),
          }}
        >
          {null}
        </Stateful>
      </Page>
    );
  }
  return (
    <div className="studio">
      <div className="studio__col">
        <div className="studio__colhead">
          <span className="section-label">{t.conversation}</span>
          <span style={{ flex: 1 }} />
          <StatusPill tone="running">Asset Producer</StatusPill>
        </div>
        <div className="chat">
          {CHAT.map((m, i) => (
            <div key={i} className={`msg${m.who === 'user' ? ' msg--user' : ''}`} dir="auto">
              <div className="msg__who">{m.who === 'user' ? 'You' : m.role}</div>
              {m.text}
            </div>
          ))}
          <div className="proposal">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>Replace Player mesh</strong>
              <span style={{ flex: 1 }} />
              <CostBadge value="est. $0.40" />
              <StatusPill tone="warning">Ask</StatusPill>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              studio_asset_generate · 3D_CHARACTER · hunyuan3d2 · Remote GPU #1 · checkpoint first
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn--primary btn--sm">{t.approve}</button>
              <button className="btn btn--sm">{t.edit}</button>
              <button className="btn btn--sm btn--ghost">{t.reject}</button>
            </div>
          </div>
        </div>
        <div className="composer">
          <div>
            <span className="chip" title="Pinned context: the current editor selection">
              <StatusDot tone="accent" /> {t.context}: Player (CharacterBody3D) ·
              res://assets/generated/3D_CHARACTER/hero.glb
            </span>
          </div>
          <textarea placeholder={t.describe} dir="auto" aria-label={t.describe} />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn--primary btn--sm">
              {t.send} <IconSend size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="studio__col">
        <div className="studio__colhead">
          <span className="section-label">{t.preview}</span>
          <div className="seg" style={{ marginInlineStart: 8 }}>
            {['Game', 'Editor', 'Scene tree', 'Asset', 'Logs'].map((x, i) => (
              <button key={x} aria-pressed={i === 0}>
                {x}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn--sm">
            <IconPause size={14} /> {t.pauseAgent}
          </button>
          <button className="btn btn--sm">{t.openInGodot}</button>
          <details className="menu">
            <summary className="btn btn--sm">Open in Claude Desktop ▾</summary>
            <div className="menu__list" role="menu">
              {['Continue task', 'Review failure', 'Review build', 'Review QA report'].map((x) => (
                <button
                  key={x}
                  className="menu__item"
                  role="menuitem"
                  title="Opens Claude Desktop with a context summary — no secrets"
                >
                  {x}
                </button>
              ))}
            </div>
          </details>
        </div>
        <div className="preview">
          <div className="preview__frame">
            <img
              src={`${import.meta.env.BASE_URL}prototype/game-shot.png`}
              alt="Latest game-screenshot from the playtest"
            />
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }} className="muted">
            <span>game-screenshot · 1280×720 · 14:01:40</span>
            <span style={{ flex: 1 }} />
            <span>
              Errors <strong style={{ color: 'var(--danger)' }}>1</strong>
            </span>
            <span>
              Warnings <strong style={{ color: 'var(--warning)' }}>2</strong>
            </span>
            <span className="num">FPS 60</span>
          </div>
          <div className="console" style={{ height: 130 }}>
            {CONSOLE_LINES.map((l, i) => (
              <div
                key={i}
                className="console__line"
                style={l.includes('ERROR') ? { color: 'var(--danger)' } : undefined}
              >
                {l}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="studio__col">
        <div className="studio__colhead">
          <span className="section-label">{t.pipeline}</span>
          <span style={{ flex: 1 }} />
          <span className="faint num">9 / {STAGES.length}</span>
        </div>
        <div className="pipeline">
          {STAGES.map((s) => (
            <div key={s.name} className="stage" aria-current={s.status === 'running' ? 'step' : undefined}>
              <StatusDot tone={STAGE_TONE[s.status]} pulse={s.status === 'running'} />
              <span style={s.status === 'pending' ? { color: 'var(--text-3)' } : undefined}>{s.name}</span>
              <span className="faint" style={{ fontSize: 11 }} dir="auto">
                {s.detail}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Activity ---------------- */
function ActivityList({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 0 }}>
      {ACTIVITY.slice(0, compact ? 4 : undefined).map((a) => (
        <div
          key={a.t}
          style={{
            display: 'grid',
            gridTemplateColumns: '70px 14px 150px 1fr',
            alignItems: 'center',
            gap: 8,
            minHeight: compact ? 0 : 'var(--row)',
            borderBlockEnd: compact ? 0 : '1px solid var(--border)',
          }}
        >
          <span className="num faint mono">{a.t}</span>
          <StatusDot tone={a.tone} />
          <span className="muted">{a.who}</span>
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.what}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ActivityScreen({ t, state }: ScreenProps) {
  return (
    <Page
      title={t.nav.activity}
      actions={<input className="btn" placeholder="Filter: role, tool, stage…" style={{ width: 260 }} />}
    >
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="Nothing has happened yet"
              purpose="Every stage, tool call, job and build appears here — append-only and secrets redacted."
              action={<button className="btn btn--primary">{t.newGame}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Audit chain verification failed"
              evidence={['audit_log row 4812: prev_hash mismatch', 'expected 7c1e…, found 00a3…']}
              next={<button className="btn btn--primary">Export audit log</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Select a project"
              missing={['Activity is project-scoped']}
              fix={<button className="btn btn--primary">{t.nav.projects}</button>}
            />
          ),
        }}
      >
        <Card pad={false}>
          <div style={{ padding: '0 16px' }}>
            <ActivityList />
          </div>
        </Card>
      </Stateful>
    </Page>
  );
}

/* ---------------- Assets ---------------- */
export function AssetsScreen({ t, state }: ScreenProps) {
  return (
    <Page
      title={t.nav.assets}
      actions={
        <>
          <div className="seg">
            {['All', '3D', 'Texture', 'Concept'].map((x, i) => (
              <button key={x} aria-pressed={i === 0}>
                {x}
              </button>
            ))}
          </div>
          <button className="btn btn--primary">
            <IconPlus size={14} /> {t.generate}
          </button>
        </>
      }
    >
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="No assets yet"
              purpose="Generated 3D models, textures and concepts land here with their validation report."
              action={<button className="btn btn--primary">{t.generate}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Chest generation failed"
              evidence={[
                'worker Remote GPU #2 · prompt_id 3f0c…',
                'execution_error: CUDA out of memory (node 12 VAEDecodeHunyuan3D)',
                'attempt 1/2 · no resubmit without a new prompt_id',
              ]}
              next={<button className="btn btn--primary">Retry on Remote GPU #1</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="No GPU worker can run 3D workflows"
              missing={['Remote GPU #1 — offline', 'Remote GPU #2 — missing node SaveGLB']}
              fix={<button className="btn btn--primary">{t.nav.workers}</button>}
            />
          ),
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
          {ASSETS.map((a) => (
            <section className="card asset" key={a.name}>
              <div className="asset__thumb">
                <img
                  src={`${import.meta.env.BASE_URL}prototype/icon.svg`}
                  width={56}
                  height={56}
                  alt=""
                  style={{ opacity: 0.35 }}
                />
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div className="faint mono">{a.category}</div>
                <StatusPill tone={a.tone}>{a.status}</StatusPill>
                {a.progress !== undefined && <Progress value={a.progress} />}
                <div className="faint" style={{ fontSize: 12 }}>
                  {a.tris ? `${a.tris} tris · ` : ''}
                  {a.worker}
                </div>
              </div>
            </section>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Card title="Player — explorer · detail drawer (preview)">
            <div className="chain">
              {ASSET_CHAIN.map((s) => (
                <span
                  key={s}
                  className="chain__step"
                  style={
                    s === 'Rig'
                      ? { borderColor: 'var(--warning)', color: 'var(--warning)' }
                      : ['Anim', 'Collision', 'LOD', 'GLB'].includes(s)
                        ? { opacity: 0.5 }
                        : undefined
                  }
                >
                  {s}
                </span>
              ))}
            </div>
            <p className="muted" style={{ marginBlockEnd: 0 }}>
              BLOCKED — requires rigging. The workflow produces a static mesh; ModuleX never presents it as a playable
              character.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
              <button className="btn btn--sm">{t.retryStage}</button>
              <button className="btn btn--sm">{t.replace}</button>
            </div>
          </Card>
          {PROVENANCE.map((p) => (
            <Card
              key={p.asset}
              title={`Provenance · ${p.asset}`}
              actions={<StatusPill tone={p.verdict.tone}>{p.verdict.label}</StatusPill>}
            >
              <KeyValue rows={p.rows} />
              <p className="muted" style={{ marginBlockEnd: 0, fontSize: 12 }}>
                {p.verdict.note}
              </p>
            </Card>
          ))}
        </div>
      </Stateful>
    </Page>
  );
}

/* ---------------- Test & Debug ---------------- */
export function TestScreen({ t, state }: ScreenProps) {
  return (
    <Page
      title={t.nav.test}
      actions={
        <>
          <div className="seg">
            {['Static', 'Playtest', 'Visual', 'All'].map((x, i) => (
              <button key={x} aria-pressed={i === 3}>
                {x}
              </button>
            ))}
          </div>
          <button className="btn btn--primary">
            <IconPlay size={14} /> {t.run}
          </button>
        </>
      }
    >
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="No test runs yet"
              purpose="Static checks, a real playtest and visual checks — every failure is evidenced and fingerprinted."
              action={<button className="btn btn--primary">{t.run}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Playtest could not start"
              evidence={[
                'gamedev-mcp-server (playtest) exited: port 24124 in use',
                'restart 3/3 within 10 min → BLOCKED (infra, no fix attempt used)',
              ]}
              next={<button className="btn btn--primary">Restart playtest server</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Fix loop escalated to you"
              missing={[
                'fingerprint 8d41…: “No fall-through after 2 s” recurred after 3/3 attempts',
                'checkpoint mx-cp-14 restored automatically',
              ]}
              fix={<button className="btn btn--primary">Review in Approvals</button>}
            />
          ),
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: '300px 1fr 260px' }}>
          <Card title={<span>Session #41 · ExportDebug</span>} pad={false}>
            {TESTS.map((x) => (
              <div key={x.name} className="stage" aria-current={x.name.startsWith('No fall') ? 'step' : undefined}>
                <StatusDot tone={STAGE_TONE[x.status]} />
                <span>{x.name}</span>
                <span className="faint num" style={{ fontSize: 11 }}>
                  {x.tier}
                </span>
              </div>
            ))}
          </Card>
          <Card title={<span>No fall-through after 2 s · gameplay_assertion</span>}>
            <KeyValue
              rows={[
                ['Fingerprint', <span className="mono">8d41c0…e2</span>],
                ['Assertion', <span className="mono">player.globalPosition.y (−38.2) &gt; killPlane (−10)</span>],
                ['Top frame', <span className="mono">res://player/player.gd:13 _physics_process</span>],
                ['Evidence', 'game-state-get ×3, game-screenshot, runtime-errors seq 1'],
              ]}
            />
            <div className="preview__frame" style={{ marginBlockStart: 12, height: 190 }}>
              <img src={`${import.meta.env.BASE_URL}prototype/game-shot.png`} alt="Failure screenshot" />
            </div>
          </Card>
          <Card title="Fix attempts">
            <KeyValue
              rows={[
                ['Attempts', <span className="num">1 / 3</span>],
                ['Run budget', <span className="num">1 / 8 fixes</span>],
                ['Checkpoint', 'mx-cp-14'],
                ['Role', 'Gameplay Engineer'],
              ]}
            />
            <div style={{ marginBlockStart: 12 }}>
              <Progress value={33} tone="warning" />
            </div>
          </Card>
        </div>
        <div className="console" style={{ height: 150 }}>
          {CONSOLE_LINES.map((l, i) => (
            <div key={i} className="console__line" style={l.includes('ERROR') ? { color: 'var(--danger)' } : undefined}>
              {l}
            </div>
          ))}
        </div>
      </Stateful>
    </Page>
  );
}

/* ---------------- Builds ---------------- */
export function BuildsScreen({ t, state }: ScreenProps) {
  return (
    <Page title={t.nav.builds} actions={<button className="btn btn--primary">{t.buildGame}</button>}>
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="No builds yet"
              purpose="Windows .exe, Android .apk/.aab and iOS preparation — each with sha256 and a smoke test."
              action={<button className="btn btn--primary">{t.buildGame}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Windows export produced no C# assemblies"
              evidence={[
                'godot --export-release "Windows Desktop" exited 0',
                'ERROR: Export .NET Project: no solution file was found',
                'data_IslandExplorer_windows_x86_64/ missing → build FAILED (exit code not trusted)',
              ]}
              next={<button className="btn btn--primary">Regenerate solution + rebuild</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Android requirements missing"
              missing={[
                'JDK 17 — not installed',
                'Android SDK — not configured in editor settings',
                'Release keystore — not set (debug builds only)',
              ]}
              fix={<button className="btn btn--primary">Install Android tools</button>}
            />
          ),
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: '1fr 320px' }}>
          <Card pad={false}>
            <table className="table">
              <thead>
                <tr>
                  <th>Build</th>
                  <th>Platform</th>
                  <th>Profile</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>sha256</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {BUILDS.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td>{b.platform}</td>
                    <td>
                      <span className="chain__step mono">{b.profile}</span>
                    </td>
                    <td className="num">{b.version}</td>
                    <td>
                      <StatusPill tone={b.tone}>{b.status}</StatusPill>
                    </td>
                    <td className="num">{b.size}</td>
                    <td className="mono faint">{b.sha}</td>
                    <td className="num muted">{b.created}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Build game · requirements">
            {[
              ['Windows', [['Export templates 4.5.1 mono', 'success']]],
              [
                'Android',
                [
                  ['JDK 17', 'success'],
                  ['Android SDK path', 'success'],
                  ['Release keystore (env only)', 'warning'],
                ],
              ],
              [
                'iOS',
                [
                  ['macOS worker online', 'danger'],
                  ['Team ID', 'danger'],
                  ['Signing identity (on worker)', 'neutral'],
                ],
              ],
            ].map(([p, reqs]) => (
              <div key={p as string} style={{ marginBlockEnd: 12 }}>
                <div style={{ fontWeight: 600, marginBlockEnd: 6 }}>{p as string}</div>
                {(reqs as string[][]).map(([r, tone]) => (
                  <div key={r} style={{ display: 'flex', gap: 8, alignItems: 'center', height: 24 }} className="muted">
                    <StatusDot tone={tone as 'success'} /> {r}
                  </div>
                ))}
              </div>
            ))}
            <p className="faint" style={{ fontSize: 12, margin: 0 }}>
              iOS without a signed build = PREPARED, never RELEASED. Release: BLOCKED — macOS/Xcode build worker
              required.
            </p>
          </Card>
        </div>
        <Card title="Build profiles" pad={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Export</th>
                <th>Debug bridges</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {PROFILE_ROWS.map(([name, exp, bridges, purpose]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className="muted">{exp}</td>
                  <td>
                    <StatusPill tone={bridges === 'none' ? 'success' : 'warning'}>{bridges}</StatusPill>
                  </td>
                  <td className="muted">{purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Stateful>
    </Page>
  );
}

/* ---------------- Workers ---------------- */
export function WorkersScreen({ t, state }: ScreenProps) {
  return (
    <Page title={t.nav.workers} actions={<button className="btn btn--primary">{t.addWorker}</button>}>
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="No workers connected"
              purpose="Add a ComfyUI GPU worker (behind an authenticating proxy) or a macOS build worker."
              action={<button className="btn btn--primary">{t.addWorker}</button>}
            />
          ),
          error: (
            <ErrorState
              title="Remote GPU #2 health check failed"
              evidence={[
                'GET https://gpu2.example.net/system_stats → 502 Bad Gateway',
                'offline for 6 min · backoff 4 min',
              ]}
              next={<button className="btn btn--primary">{t.test}</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Refused: plain HTTP remote worker"
              missing={['http://203.0.113.7:8188 is not HTTPS and not marked trusted (SSH / Tailscale)']}
              fix={<button className="btn btn--primary">Use the auth proxy guide</button>}
            />
          ),
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
          {WORKERS.map((w) => {
            const tone = TRUST_TONE[w.trust];
            return (
              <Card
                key={w.id}
                title={
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <StatusDot tone={tone} pulse={w.trust === 'TRUSTED'} />
                    <span className="mono">{w.id}</span>
                  </span>
                }
                actions={<StatusPill tone={tone}>{w.trust}</StatusPill>}
              >
                <KeyValue
                  rows={[
                    ['Hardware', w.gpu],
                    ['Provider', `${w.provider} · ${w.location}`],
                    ['Runtime', w.comfy],
                    ['Transport', w.transport],
                    [
                      'Capabilities',
                      <span style={{ display: 'flex', gap: 4 }}>
                        {w.caps.map((c) => (
                          <span className="chain__step" key={c}>
                            {c}
                          </span>
                        ))}
                      </span>,
                    ],
                    ['Rate', <span className="num">{w.rate}</span>],
                    ['Queue · failures', <span className="num">{`${w.queue} · ${w.failures}`}</span>],
                  ]}
                />
                {w.note && (
                  <p className="muted" style={{ fontSize: 12, marginBlockEnd: 0 }}>
                    {w.note}
                  </p>
                )}
                {w.onboarding && (
                  <div style={{ marginBlockStart: 12 }}>
                    <div className="section-label" style={{ marginBlockEnd: 6 }}>
                      Onboarding
                    </div>
                    {w.onboarding.map(([step, st]) => (
                      <div
                        key={step}
                        style={{ display: 'flex', gap: 8, alignItems: 'center', height: 22 }}
                        className="muted"
                      >
                        <StatusDot tone={st === 'passed' ? 'success' : st === 'failed' ? 'danger' : 'neutral'} /> {step}
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', height: 22 }} className="faint">
                      <StatusDot tone="neutral" /> Trust decision (owner)
                    </div>
                  </div>
                )}
                <div style={{ marginBlockStart: 12, display: 'flex', gap: 8 }}>
                  <button className="btn btn--sm">{t.test}</button>
                  {w.trust === 'QUARANTINED' && <button className="btn btn--sm">Re-enable (owner)</button>}
                  {w.trust === 'UNTRUSTED' && <button className="btn btn--sm">Continue onboarding</button>}
                </div>
              </Card>
            );
          })}
        </div>
      </Stateful>
    </Page>
  );
}

/* ---------------- Approvals ---------------- */
export function ApprovalsScreen({ t, state }: ScreenProps) {
  return (
    <Page title={t.nav.approvals}>
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="Nothing waiting for you"
              purpose="Destructive, costly or critical actions pause here until you decide."
              action={<button className="btn">Open policy settings</button>}
            />
          ),
          error: (
            <ErrorState
              title="Approval expired"
              evidence={[
                'approval ap-0031 (resource-delete) timed out after 30 min',
                'stage “Asset processing” reported BLOCKED',
              ]}
              next={<button className="btn btn--primary">Re-request</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Policy changes need you at the keyboard"
              missing={['The agent asked to enable reflection-method-call — refused and logged']}
              fix={<button className="btn">View audit entry</button>}
            />
          ),
        }}
      >
        {APPROVALS.map((a) => (
          <Card
            key={a.tool}
            title={
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="mono">{a.tool}</span>
                <StatusPill tone={a.tone}>{a.tier}</StatusPill>
              </span>
            }
            actions={a.cost === '—' ? undefined : <CostBadge value={a.cost} />}
          >
            <KeyValue
              rows={[
                ['Requested by', `${a.requester} · ${a.role}`],
                ['What', a.what],
                ['Why', a.why],
                ['Scope', a.scope],
                [
                  'Files',
                  <span className="mono" style={{ display: 'flex', flexDirection: 'column' }}>
                    {a.files.map((f) => (
                      <span key={f}>{f}</span>
                    ))}
                  </span>,
                ],
                ['Risk', <StatusPill tone={a.risk === 'high' ? 'danger' : 'neutral'}>{a.risk}</StatusPill>],
                ['Rollback', a.rollback],
              ]}
            />
            <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
              <button className="btn btn--primary">{t.approve}</button>
              <button className="btn">{t.reject}</button>
              {a.requester !== 'Claude Desktop' && <button className="btn btn--ghost">{t.alwaysAllow}</button>}
            </div>
          </Card>
        ))}
      </Stateful>
    </Page>
  );
}

/* ---------------- Settings ---------------- */
export const SETTINGS_SECTIONS = [
  ['appearance', 'Appearance & language'],
  ['ai-providers', 'AI Providers'],
  ['routing', 'Model routing'],
  ['godot', 'Godot installations'],
  ['autonomy', 'Autonomy policy'],
  ['budgets', 'Budgets'],
  ['secrets', 'Secrets'],
  ['updates', 'Updates'],
  ['developer', 'Developer Mode'],
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number][0];

function AppearanceSection({
  theme,
  lang,
  onTheme,
  onLang,
}: {
  theme: string;
  lang: string;
  onTheme: (v: 'dark' | 'light') => void;
  onLang: (v: 'en' | 'ar') => void;
}) {
  return (
    <Card title="Appearance & language">
      <KeyValue
        rows={[
          [
            'Theme',
            <div className="seg">
              {(['dark', 'light'] as const).map((v) => (
                <button key={v} aria-pressed={theme === v} onClick={() => onTheme(v)}>
                  {v === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>,
          ],
          [
            'Language',
            <div className="seg">
              {(['ar', 'en'] as const).map((v) => (
                <button key={v} aria-pressed={lang === v} onClick={() => onLang(v)}>
                  {v === 'ar' ? 'العربية' : 'English'}
                </button>
              ))}
            </div>,
          ],
          [
            'Density',
            <div className="seg">
              <button aria-pressed>Comfortable</button>
              <button aria-pressed={false}>Dense</button>
            </div>,
          ],
          [
            'Autonomy (defaults)',
            <span className="muted">
              Read Auto · Local write Auto + checkpoint · Destructive Ask · Cost Ask &gt; $0.25 · Critical Disabled
            </span>,
          ],
        ]}
      />
    </Card>
  );
}

function ProvidersSection() {
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
      {PROVIDERS.map((p) => (
        <Card key={p.name} title={p.name} actions={<StatusPill tone={p.tone}>{p.status}</StatusPill>}>
          <KeyValue rows={p.rows} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBlockStart: 12 }}>
            {p.actions.map((x, i) => (
              <button key={x} className={`btn btn--sm${i === 0 && p.tone !== 'neutral' ? '' : ''}`}>
                {x}
              </button>
            ))}
          </div>
          {p.name === 'Claude API' && (
            <div style={{ marginBlockStart: 12 }}>
              <div className="section-label" style={{ marginBlockEnd: 6 }}>
                Effort (claude-opus-5-5)
              </div>
              <div className="seg">
                {['Low', 'Medium', 'High', 'Max'].map((x) => (
                  <button key={x} aria-pressed={x === 'Medium'}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function RoutingSection() {
  return (
    <Card title="Model routing">
      <KeyValue rows={ROUTING} />
      <p className="faint" style={{ fontSize: 12, marginBlockEnd: 0 }}>
        Only models and effort levels each provider supports are offered; settings are validated before any request is
        sent. ModuleX Agent stays the orchestrator — Claude is a provider, not a second agent.
      </p>
    </Card>
  );
}

function DeveloperSection() {
  return (
    <Card title="Developer Mode" actions={<StatusPill tone="neutral">Off</StatusPill>}>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        Off by default. Agents see only the Agent-safe <span className="mono">studio_*</span> tools. Developer Mode lets
        the ModuleX Agent call raw Godot-MCP tools; every call is still policy-checked, approval-gated when destructive,
        and written to the audit log. Claude Desktop never receives raw tools.
      </p>
      <KeyValue
        rows={[
          [
            'raw-tools',
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" /> Raw Godot-MCP tools (node, scene, resource, script, …)
            </label>,
          ],
          [
            'reflection',
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" /> reflection-method-call (elevated · approval every call)
            </label>,
          ],
        ]}
      />
      <div className="dialog-inline" role="dialog" aria-label="Confirm Developer Mode">
        <strong>Enable Developer Mode?</strong>
        <p className="muted" style={{ margin: '6px 0 10px' }}>
          Agents can then reach raw editor tools. This is recorded in Activity with your confirmation.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--primary btn--sm">Enable for this session</button>
          <button className="btn btn--sm">Cancel</button>
        </div>
      </div>
    </Card>
  );
}

export function SettingsScreen({
  t,
  state,
  onTheme,
  onLang,
  onSection,
  section,
  theme,
  lang,
}: ScreenProps & {
  onTheme: (v: 'dark' | 'light') => void;
  onLang: (v: 'en' | 'ar') => void;
  onSection: (v: SettingsSection) => void;
  section: SettingsSection;
  theme: string;
  lang: string;
}) {
  const body = (() => {
    switch (section) {
      case 'ai-providers':
        return <ProvidersSection />;
      case 'routing':
        return <RoutingSection />;
      case 'developer':
        return <DeveloperSection />;
      default:
        return <AppearanceSection theme={theme} lang={lang} onTheme={onTheme} onLang={onLang} />;
    }
  })();
  return (
    <Page title={t.nav.settings}>
      <Stateful
        state={state}
        variants={{
          empty: (
            <EmptyState
              title="Default settings"
              purpose="Nothing customised yet."
              action={<button className="btn">Reset to defaults</button>}
            />
          ),
          error: (
            <ErrorState
              title="Could not save settings"
              evidence={['settings: EACCES %LOCALAPPDATA%\\ModuleXGameStudio\\studio.db']}
              next={<button className="btn btn--primary">Retry</button>}
              copyLabel={t.copyDiagnostics}
            />
          ),
          blocked: (
            <BlockedState
              title="Secrets store unavailable"
              missing={['Windows Credential Manager did not respond']}
              fix={<button className="btn btn--primary">Retry</button>}
            />
          ),
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: '220px 1fr', alignItems: 'start' }}>
          <Card pad={false}>
            {SETTINGS_SECTIONS.map(([id, label]) => (
              <button
                key={id}
                className="stage stage--link"
                aria-current={section === id ? 'step' : undefined}
                onClick={() => onSection(id)}
              >
                <span />
                <span>{label}</span>
                <span />
              </button>
            ))}
          </Card>
          {body}
        </div>
      </Stateful>
    </Page>
  );
}
