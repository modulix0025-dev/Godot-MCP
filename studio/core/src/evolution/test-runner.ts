// SPDX-License-Identifier: Apache-2.0
//
// Test gates for System Evolution (Execution Patch 2 §18). Each gate is a configured command run in the evolution's
// sandbox (never in the live installation). Results keep only an output tail, redacted by the caller.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { TestGate, TestResult } from '@modulex/shared';

export interface GateCommand {
  /** argv; the first element is the executable. No shell. */
  cmd: string[];
  /** Relative to the sandbox root. */
  cwd?: string;
  timeout_ms?: number;
}

export type GateCommands = Partial<Record<TestGate, GateCommand[]>>;

/** The Studio repository's own gates (mirrors .github/workflows/modulex_studio.yml + ci.yml). */
export const STUDIO_REPO_GATES: GateCommands = {
  static: [
    { cmd: ['npm', 'run', 'lint'], cwd: 'studio' },
    { cmd: ['npm', 'run', 'typecheck'], cwd: 'studio' },
  ],
  unit: [{ cmd: ['npm', 'test'], cwd: 'studio' }],
  integration: [{ cmd: ['npm', 'test', '-w', '@modulex/core'], cwd: 'studio' }],
  security: [{ cmd: ['npx', 'vitest', 'run', 'tests/security.test.ts'], cwd: 'studio/core' }],
  packaging: [{ cmd: ['npm', 'run', 'build'], cwd: 'studio' }],
  self_test: [{ cmd: ['python3', 'studio/branding/render-icons.py', '--verify'] }],
  e2e: [{ cmd: ['npx', 'vitest', 'run', 'tests/evolution.test.ts'], cwd: 'studio/core' }],
};

/** Extract pass/fail/skip counts from vitest, dotnet test or plain output. */
export function parseCounts(out: string): TestResult['counts'] {
  // eslint-disable-next-line no-control-regex
  const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
  const dotnet = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(clean);
  if (dotnet) return { failed: Number(dotnet[1]), passed: Number(dotnet[2]), skipped: Number(dotnet[3]) };
  const lines = clean.split('\n').filter((l) => /^\s*Tests\s+/.test(l));
  if (!lines.length) return null;
  const sum = { passed: 0, failed: 0, skipped: 0 };
  for (const l of lines) {
    sum.passed += Number(/(\d+) passed/.exec(l)?.[1] ?? 0);
    sum.failed += Number(/(\d+) failed/.exec(l)?.[1] ?? 0);
    sum.skipped += Number(/(\d+) skipped/.exec(l)?.[1] ?? 0);
  }
  return sum;
}

export function runGate(
  root: string,
  gate: TestGate,
  commands: GateCommand[],
  redact: (s: string) => string,
): TestResult {
  const started = Date.now();
  let out = '';
  let passed = true;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let sawCounts = false;
  for (const c of commands) {
    // npm/npx/yarn/pnpm are .cmd shims on Windows and can only be started through cmd.exe; everything else
    // (node, python, git, dotnet) is spawned directly so cmd.exe never re-parses its arguments.
    const shim = process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$/i.test(c.cmd[0]!);
    const [exe, args] = shim ? [c.cmd.map(winQuote).join(' '), [] as string[]] : [c.cmd[0]!, c.cmd.slice(1)];
    const r = spawnSync(exe, args, {
      cwd: join(root, c.cwd ?? '.'),
      encoding: 'utf-8',
      timeout: c.timeout_ms ?? 15 * 60_000,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      shell: shim,
    });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
    out += `$ ${c.cmd.join(' ')}\n${text}\n`;
    const n = parseCounts(text);
    if (n) {
      sawCounts = true;
      counts.passed += n.passed;
      counts.failed += n.failed;
      counts.skipped += n.skipped;
    }
    if (r.status !== 0) {
      passed = false;
      break;
    }
  }
  return {
    gate,
    command: commands.map((c) => c.cmd.join(' ')).join(' && '),
    passed,
    counts: sawCounts ? counts : null,
    duration_ms: Date.now() - started,
    output_tail: redact(out.split('\n').slice(-40).join('\n')),
  };
}

/** Quote one argument for cmd.exe (gate commands come from configuration, never from agent input). */
function winQuote(a: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}
