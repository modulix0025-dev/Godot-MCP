// SPDX-License-Identifier: Apache-2.0
//
// Reusable building blocks from the §4.3 component inventory, implemented once on the design tokens.
import type { ReactNode } from 'react';
import type { StageStatus, Tone } from './data';
import { IconAlert, IconCopy, IconInbox, IconLock } from './icons';

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span className={`dot tone-${tone}${pulse ? ' dot--pulse' : ''}`} />;
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill tone-${tone}`}>
      <StatusDot tone={tone} pulse={tone === 'running'} />
      {children}
    </span>
  );
}

export const STAGE_TONE: Record<StageStatus, Tone> = {
  done: 'success',
  running: 'running',
  pending: 'neutral',
  blocked: 'warning',
  failed: 'danger',
  partial: 'warning',
};

export function Card({
  title,
  actions,
  children,
  pad = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <section className="card">
      {title !== undefined && (
        <header className="card__head">
          {title}
          <span style={{ flex: 1 }} />
          {actions}
        </header>
      )}
      <div className={pad ? 'card__body' : undefined}>{children}</div>
    </section>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>
            <bdi>{v}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Skeleton({ w = '100%', h = 12 }: { w?: number | string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

/** Loading = a skeleton of the final layout, never a lone spinner (§4.2 States). */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Skeleton w={28} h={28} />
          <Skeleton w={`${30 + ((i * 17) % 40)}%`} />
          <span style={{ flex: 1 }} />
          <Skeleton w={80} />
        </div>
      ))}
    </div>
  );
}

/** Empty: one-line purpose + one primary action. */
export function EmptyState({ title, purpose, action }: { title: string; purpose: string; action: ReactNode }) {
  return (
    <div className="state">
      <div className="state__icon tone-neutral">
        <IconInbox size={22} />
      </div>
      <div className="state__title">{title}</div>
      <div className="muted">{purpose}</div>
      {action}
    </div>
  );
}

/** Error: what failed, the evidence, the next action, and "copy diagnostics". */
export function ErrorState({
  title,
  evidence,
  next,
  copyLabel,
}: {
  title: string;
  evidence: string[];
  next: ReactNode;
  copyLabel: string;
}) {
  return (
    <div className="state" role="alert">
      <div className="state__icon tone-danger">
        <IconAlert size={22} />
      </div>
      <div className="state__title">{title}</div>
      <div className="console state__evidence">
        {evidence.map((l, i) => (
          <div className="console__line" key={i}>
            {l}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {next}
        <button className="btn">
          <IconCopy size={14} />
          {copyLabel}
        </button>
      </div>
    </div>
  );
}

/** Blocked: what is missing and a button that fixes it. */
export function BlockedState({ title, missing, fix }: { title: string; missing: string[]; fix: ReactNode }) {
  return (
    <div className="state">
      <div className="state__icon tone-warning">
        <IconLock size={22} />
      </div>
      <div className="state__title">{title}</div>
      <ul className="state__evidence muted" style={{ margin: 0, paddingInlineStart: 18 }}>
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      {fix}
    </div>
  );
}

export function Progress({ value, tone = 'running' }: { value: number; tone?: Tone }) {
  return (
    <div
      className={`progress tone-${tone}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${value}%`, background: 'var(--tone)' }} />
    </div>
  );
}

export function CostBadge({ value }: { value: string }) {
  return <span className="pill tone-neutral num">{value}</span>;
}
