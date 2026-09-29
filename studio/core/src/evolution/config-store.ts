// SPDX-License-Identifier: Apache-2.0
//
// Mode A — versioned configuration documents (Execution Patch 2 §2, §28). Core reads these live, so a change
// applies without a rebuild. Every write creates a new immutable version (the previous versions are the backup),
// is validated against the document schema first, and is audited. Nothing here decides WHO may write: the
// EvolutionService only calls `apply` after the owner approved the exact diff.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_DOCS, DEFAULT_CONFIG, jsonDiff, type ConfigDocId, type JsonChange } from '@modulex/shared';

export interface ConfigVersion {
  version: number;
  value: unknown;
  at: string;
  by: string;
  evolution_id: string | null;
  reason: string;
}

type Snapshot = Record<ConfigDocId, ConfigVersion[]>;

export class ConfigStore {
  private docs: Snapshot;

  constructor(
    private readonly path?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const initial = Object.fromEntries(
      (Object.keys(CONFIG_DOCS) as ConfigDocId[]).map((id) => [
        id,
        [
          {
            version: 1,
            value: CONFIG_DOCS[id].schema.parse(DEFAULT_CONFIG[id]),
            at: new Date(0).toISOString(),
            by: 'defaults',
            evolution_id: null,
            reason: 'built-in defaults',
          },
        ],
      ]),
    ) as Snapshot;
    this.docs = initial;
    if (path && existsSync(path)) {
      const loaded = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Snapshot>;
      for (const id of Object.keys(initial) as ConfigDocId[]) if (loaded[id]?.length) this.docs[id] = loaded[id]!;
    }
  }

  /** The current value (typed by the caller via the shared schema). */
  get<T = unknown>(id: ConfigDocId): { version: number; value: T } {
    const h = this.docs[id];
    const cur = h[h.length - 1]!;
    return { version: cur.version, value: cur.value as T };
  }

  history(id: ConfigDocId): ConfigVersion[] {
    return this.docs[id].map((v) => ({ ...v }));
  }

  /** Validate a candidate value and compute the exact diff against the current version. Writes nothing. */
  preview(
    id: ConfigDocId,
    candidate: unknown,
  ): { ok: true; value: unknown; diff: JsonChange[] } | { ok: false; issues: string[] } {
    const parsed = CONFIG_DOCS[id].schema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || id}: ${i.message}`) };
    return { ok: true, value: parsed.data, diff: jsonDiff(this.get(id).value, parsed.data) };
  }

  /** Write a new version. `expectedVersion` makes the write fail if the document changed since the preview. */
  apply(
    id: ConfigDocId,
    candidate: unknown,
    meta: { by: string; evolutionId: string | null; reason: string; expectedVersion: number },
  ): ConfigVersion {
    const cur = this.get(id);
    if (cur.version !== meta.expectedVersion)
      throw new Error(
        `config '${id}' changed (v${cur.version}) since the proposal (v${meta.expectedVersion}); re-propose`,
      );
    const p = this.preview(id, candidate);
    if (!p.ok) throw new Error(`invalid ${id}: ${p.issues.join('; ')}`);
    const v: ConfigVersion = {
      version: cur.version + 1,
      value: p.value,
      at: this.now().toISOString(),
      by: meta.by,
      evolution_id: meta.evolutionId,
      reason: meta.reason,
    };
    this.docs[id].push(v);
    this.save();
    return v;
  }

  /** Restore an earlier version by writing it again as a NEW version (history is never rewritten). */
  rollback(id: ConfigDocId, toVersion: number, by: string, reason: string): ConfigVersion {
    const target = this.docs[id].find((v) => v.version === toVersion);
    if (!target) throw new Error(`config '${id}' has no version ${toVersion}`);
    return this.apply(id, target.value, { by, evolutionId: null, reason, expectedVersion: this.get(id).version });
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.docs, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
