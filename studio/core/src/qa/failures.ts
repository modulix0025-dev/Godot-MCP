// SPDX-License-Identifier: Apache-2.0
//
// Failure classification + fingerprints (Phase 9). A fingerprint is sha1(class + normalised message + top frame
// file:line): the same bug seen twice gets the same fingerprint, so fix attempts are counted per bug and a
// recurrence after "fixed" is recognised. Normalisation removes what changes between runs (instance ids, object
// addresses, numbers inside messages, absolute paths).
import { createHash } from 'node:crypto';
import type { StudioDb } from '../db/database.js';

export const FAILURE_CLASSES = [
  'compile_error',
  'script_parse',
  'runtime_exception',
  'missing_resource',
  'import_error',
  'asset_invalid',
  'hang',
  'crash',
  'gameplay_assertion',
  'visual_regression',
  'infra',
] as const;
export type QaFailureClass = (typeof FAILURE_CLASSES)[number];

export interface QaFailure {
  class: QaFailureClass;
  message: string;
  /** Top frame (res:// file and line) when known. */
  file: string | null;
  line: number | null;
  /** Which test / scenario step surfaced it. */
  source: string;
  fingerprint: string;
}

export function normaliseMessage(m: string): string {
  return m
    .replace(/<[A-Za-z0-9_]+#-?\d+>/g, '<obj>')
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'":]+[\\/])+/g, '/') // absolute directories
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function fingerprint(cls: QaFailureClass, message: string, file: string | null, line: number | null): string {
  return createHash('sha1')
    .update(`${cls}|${normaliseMessage(message)}|${file ?? ''}:${line ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

export function makeFailure(
  cls: QaFailureClass,
  message: string,
  source: string,
  file: string | null = null,
  line: number | null = null,
): QaFailure {
  return { class: cls, message, file, line, source, fingerprint: fingerprint(cls, message, file, line) };
}

/** Classify one Godot log / runtime-error message. */
export function classifyGodotMessage(message: string): QaFailureClass {
  if (/Parse Error|Parser Error|Compile Error|Failed to compile/i.test(message)) return 'script_parse';
  if (/error CS\d{4}/.test(message)) return 'compile_error';
  if (/Failed loading resource|Cannot load|Resource file not found|No loader found|Failed to load/i.test(message))
    return 'missing_resource';
  if (/import/i.test(message) && /fail|error/i.test(message)) return 'import_error';
  return 'runtime_exception';
}

/** First `res://file:line` in a message or its frames. */
export function topFrame(text: string): { file: string | null; line: number | null } {
  const m = /(res:\/\/[^\s:()'"]+)(?::(\d+))?/.exec(text);
  return { file: m?.[1] ?? null, line: m?.[2] ? Number(m[2]) : null };
}

/** Upsert failures into studio.db (attempt counting lives in the fix loop). */
export function recordFailures(db: StudioDb | null | undefined, projectId: string, failures: QaFailure[]): void {
  if (!db) return;
  const now = new Date().toISOString();
  for (const f of failures)
    db.run(
      `INSERT INTO failures (fingerprint, project_id, class, message, attempts, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, 0, 'open', ?, ?)
       ON CONFLICT (project_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen,
         status = CASE WHEN failures.status = 'fixed' THEN 'recurred' ELSE failures.status END`,
      f.fingerprint,
      projectId,
      f.class,
      f.message.slice(0, 2000),
      now,
      now,
    );
}
