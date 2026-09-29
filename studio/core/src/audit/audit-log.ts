// SPDX-License-Identifier: Apache-2.0
//
// Append-only, hash-chained audit log. Each entry commits to the previous one (sha256 over the canonical JSON of
// the entry + prev hash), so any edit or deletion breaks `verify()`. Payloads are redacted BEFORE hashing and
// writing — the chain never contains a secret. Phase 4 persists the same rows in SQLite `audit_log`; the JSONL
// sink here keeps the log durable until then.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { AuditEventType } from '@modulex/shared';
import type { Redactor } from './secrets.js';

export interface AuditEntry {
  seq: number;
  ts: string;
  type: AuditEventType;
  actor: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashOf(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly listeners = new Set<(e: AuditEntry) => void>();

  constructor(
    private readonly redactor: Redactor,
    private readonly sinkPath?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(type: AuditEventType, actor: string, data: Record<string, unknown> = {}): AuditEntry {
    const prev = this.entries.at(-1);
    const base = {
      seq: (prev?.seq ?? 0) + 1,
      ts: this.now().toISOString(),
      type,
      actor,
      data: this.redactor.redactValue(data),
      prev_hash: prev?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    if (this.sinkPath) appendFileSync(this.sinkPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    for (const l of this.listeners) l(entry);
    return entry;
  }

  list(filter?: { type?: AuditEventType; actor?: string }): AuditEntry[] {
    return this.entries.filter(
      (e) => (!filter?.type || e.type === filter.type) && (!filter?.actor || e.actor === filter.actor),
    );
  }

  onAppend(listener: (e: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-derive the chain. Returns the first broken seq, or null when the log is intact. */
  static verify(entries: readonly AuditEntry[]): number | null {
    let prev = GENESIS;
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (e.prev_hash !== prev || hashOf(rest) !== hash) return e.seq;
      prev = hash;
    }
    return null;
  }

  verify(): number | null {
    return AuditLog.verify(this.entries);
  }
}
