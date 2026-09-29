// SPDX-License-Identifier: Apache-2.0
//
// Git checkpoints for generated game projects (Phase 4). The game project is its own repository on branch
// `modulex/work`; every checkpoint is a commit tagged `mx-cp-<n>`.
//   - `.godot/`, `build/`, `.modulex/tmp/` are ignored; `*.import` sidecars are TRACKED (they carry the import
//     settings Godot 4 needs for reproducible imports, per Godot's version-control guidance) and
//     `export_presets.cfg` is tracked (it holds no secrets: keystores come from env).
//   - `checkpoint(reason)` saves open scenes first (hook), then commits (empty commits allowed) and tags.
//   - `restore(name)` never rewrites history: it checkpoints the current state, restores the target tree into
//     the index and working tree, commits "restore to …", then calls the reopen/reimport hook.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitHead } from '../evolution/git.js';
import type { StudioDb } from '../db/database.js';

export const PROJECT_GITIGNORE = `# ModuleX Game Studio — generated project
.godot/
build/
build-output/
.modulex/tmp/
.modulex/scratch/
*.tmp
# NOTE: *.import sidecars and export_presets.cfg are intentionally tracked.
`;

const ID = ['-c', 'user.name=ModuleX Game Studio', '-c', 'user.email=studio@modulex.invalid'];

export interface CheckpointHooks {
  /** Save every open scene before committing (scene-list-opened + scene-save). */
  beforeCheckpoint?: () => Promise<void>;
  /** After a restore: reopen scenes and reimport changed files. */
  afterRestore?: (changedFiles: string[]) => Promise<void>;
}

export interface Checkpoint {
  name: string;
  commit: string;
  reason: string;
  created_at: string;
}

export class ProjectCheckpoints {
  constructor(
    readonly projectDir: string,
    private readonly projectId: string,
    private readonly db?: StudioDb | null,
    private readonly hooks: CheckpointHooks = {},
  ) {}

  private g(args: string[], input?: string): string {
    return git(this.projectDir, [...ID, ...args], input);
  }

  /** Initialise the repository (idempotent). */
  init(): void {
    if (!existsSync(join(this.projectDir, '.git'))) this.g(['init', '-q', '-b', 'modulex/work']);
    const gi = join(this.projectDir, '.gitignore');
    const current = existsSync(gi) ? readFileSync(gi, 'utf-8') : '';
    if (!current.includes('ModuleX Game Studio'))
      writeFileSync(gi, PROJECT_GITIGNORE + (current ? `\n${current}` : ''));
    let hasCommit = true;
    try {
      gitHead(this.projectDir);
    } catch {
      hasCommit = false;
    }
    if (!hasCommit) {
      this.g(['add', '-A']);
      this.g(['commit', '-q', '--allow-empty', '-m', 'ModuleX: initial project state']);
    }
  }

  list(): Checkpoint[] {
    const out = this.g([
      'for-each-ref',
      '--sort=creatordate',
      '--format=%(refname:short)|%(objectname)|%(contents:subject)|%(creatordate:iso-strict)',
      'refs/tags/mx-cp-*',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, commit, subject, at] = l.split('|') as [string, string, string, string];
        return { name, commit, reason: subject.replace(/^ModuleX checkpoint: /, ''), created_at: at };
      })
      .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));
  }

  async checkpoint(reason: string): Promise<Checkpoint> {
    await this.hooks.beforeCheckpoint?.();
    this.g(['add', '-A']);
    this.g(['commit', '-q', '--allow-empty', '-m', `ModuleX checkpoint: ${reason}`]);
    const n = this.list().reduce((m, c) => Math.max(m, Number(c.name.slice(6))), 0) + 1;
    const name = `mx-cp-${n}`;
    this.g(['tag', '-a', name, '-m', `ModuleX checkpoint: ${reason}`]);
    const commit = gitHead(this.projectDir);
    const cp = { name, commit, reason, created_at: new Date().toISOString() };
    this.db?.run(
      'INSERT OR REPLACE INTO checkpoints (project_id, name, commit_sha, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      this.projectId,
      name,
      commit,
      reason,
      cp.created_at,
    );
    return cp;
  }

  /** Restore a checkpoint without rewriting history. Returns the safety checkpoint taken first. */
  async restore(name: string): Promise<{ safety: Checkpoint; restored_to: string; changed: string[] }> {
    const target = this.list().find((c) => c.name === name);
    if (!target) throw new Error(`checkpoint ${name} not found`);
    const safety = await this.checkpoint(`before restore to ${name}`);
    const changed = this.g(['diff', '--name-only', target.commit, 'HEAD']).split('\n').filter(Boolean);
    this.g(['restore', `--source=${target.commit}`, '--staged', '--worktree', ':/']);
    this.g(['commit', '-q', '--allow-empty', '-m', `ModuleX: restore to ${name} (${target.reason})`]);
    await this.hooks.afterRestore?.(changed);
    return { safety, restored_to: name, changed };
  }
}
