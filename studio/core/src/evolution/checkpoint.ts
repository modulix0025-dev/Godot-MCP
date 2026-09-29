// SPDX-License-Identifier: Apache-2.0
//
// Backups and checkpoints (Execution Patch 2 §7, §8, §15). Before any deployment: a git tag on the production
// source (when the change touches source) plus a byte copy of the Studio's data files (store, config, extension
// registry). Restores copy the backup back; git history is never rewritten (rollback reverts).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git } from './git.js';

export interface Backup {
  id: string;
  dir: string;
  files: string[];
  git_tag: string | null;
  created_at: string;
}

/** Copy each existing file/dir into `<backupRoot>/<id>/`. Missing paths are recorded as absent, not errors. */
export function createBackup(backupRoot: string, id: string, paths: string[], now = new Date()): Backup {
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const dst = join(dir, basename(p));
    if (statSync(p).isDirectory()) cpSync(p, dst, { recursive: true });
    else copyFileSync(p, dst);
    files.push(p);
  }
  return { id, dir, files, git_tag: null, created_at: now.toISOString() };
}

/** Put every backed-up path back exactly as it was. */
export function restoreBackup(b: Backup): void {
  for (const p of b.files) {
    const src = join(b.dir, basename(p));
    if (statSync(src).isDirectory()) {
      rmSync(p, { recursive: true, force: true });
      cpSync(src, p, { recursive: true });
    } else copyFileSync(src, p);
  }
}

export function listBackups(backupRoot: string): string[] {
  return existsSync(backupRoot) ? readdirSync(backupRoot) : [];
}

/** Tag the current production commit so the pre-deploy state is always addressable. */
export function tagCheckpoint(repo: string, tag: string, ref = 'HEAD'): string {
  git(repo, ['tag', '-f', tag, ref]);
  return tag;
}
