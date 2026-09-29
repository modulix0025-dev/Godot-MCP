// SPDX-License-Identifier: Apache-2.0
//
// Data migrations (Execution Patch 2 §8): backup → run on a COPY → validate the copy → apply atomically →
// integrity check. The production file is only replaced by a copy that already passed validation; on any failure
// the backup stays authoritative. Every migration has an id, from/to schema, and a rollback strategy.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { migrationPath, type Migration } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';

export interface MigrationStep {
  meta: Migration;
  up: (doc: Record<string, unknown>) => Record<string, unknown>;
}

export interface MigrationResult {
  applied: string[];
  backup: string;
  from_schema: number;
  to_schema: number;
}

export function migrateJsonFile(
  file: string,
  steps: MigrationStep[],
  targetSchema: number,
  validate: (doc: unknown) => string[],
  audit: AuditLog,
  actor: string,
): MigrationResult {
  if (!existsSync(file)) throw new Error(`nothing to migrate: ${file}`);
  const original = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  const from = typeof original.schema_version === 'number' ? original.schema_version : 1;
  const path = migrationPath(
    steps.map((s) => s.meta),
    from,
    targetSchema,
  );
  const backup = `${file}.bak-schema${from}-${Date.now()}`;
  copyFileSync(file, backup);

  let doc = structuredClone(original);
  for (const m of path) {
    const step = steps.find((s) => s.meta.id === m.id)!;
    doc = step.up(doc);
    doc.schema_version = m.to_schema;
  }
  const problems = validate(doc);
  if (problems.length)
    throw new Error(`migration produced an invalid document (production untouched): ${problems.join('; ')}`);

  const tmp = `${file}.migrating`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8');
  const reread = JSON.parse(readFileSync(tmp, 'utf-8')) as unknown;
  const integrity = validate(reread);
  if (integrity.length) throw new Error(`integrity check failed (production untouched): ${integrity.join('; ')}`);
  renameSync(tmp, file);
  for (const m of path)
    audit.append('migration_applied', actor, { id: m.id, from: m.from_schema, to: m.to_schema, backup });
  return { applied: path.map((m) => m.id), backup, from_schema: from, to_schema: targetSchema };
}
