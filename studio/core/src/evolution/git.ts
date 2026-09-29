// SPDX-License-Identifier: Apache-2.0
//
// Minimal git runner for System Evolution sandboxes and checkpoints. Arguments are passed as an array (no shell),
// so user-supplied text never reaches a command line unescaped. Uses the bundled or detected git (Phase 4).
import { execFileSync } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
}

export function git(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message: string };
    throw new GitError(args, String(err.stderr ?? err.message));
  }
}

export const gitHead = (cwd: string, ref = 'HEAD'): string => git(cwd, ['rev-parse', ref]).trim();
