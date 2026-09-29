// SPDX-License-Identifier: Apache-2.0
//
// Built-in fixer (D-047). Until the ModuleX Agent is reachable (D-030), the fix loop's only automatic fixer is
// GENERATOR RESTORE: every generated file has a known-good version (the deterministic generator's output). When a
// failure points at a generated file — directly (the top frame) or through a reference to the missing resource —
// and that file no longer matches the generator, the file is restored. A failure in a file the generator does
// not own cannot be fixed this way: the fixer says so and the loop ends BLOCKED with evidence.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedProject } from '../project/game-generator.js';
import type { QaFailure } from './failures.js';
import type { Fixer, FixProposal } from './fix-loop.js';

export class GeneratorRestoreFixer implements Fixer {
  readonly name = 'generator-restore';
  constructor(
    private readonly projectDir: string,
    private readonly generated: GeneratedProject,
  ) {}

  private drifted(): { path: string; content: string }[] {
    return this.generated.files.filter((f) => {
      const p = join(this.projectDir, f.path);
      return !existsSync(p) || readFileSync(p, 'utf-8') !== f.content;
    });
  }

  async propose(failure: QaFailure): Promise<FixProposal> {
    const drift = this.drifted();
    const res = (p: string) => `res://${p}`;
    const direct = failure.file ? drift.filter((f) => res(f.path) === failure.file) : [];
    // A missing resource is reported at the missing path; the file to restore is the one that references it.
    const referrers =
      failure.file && !direct.length
        ? drift.filter((f) => {
            const p = join(this.projectDir, f.path);
            return existsSync(p) && readFileSync(p, 'utf-8').includes(failure.file!);
          })
        : [];
    const targets = [...direct, ...referrers];
    if (!targets.length)
      return {
        changed: false,
        description: failure.file
          ? `${failure.file} is not a generated file that drifted from the generator; no automatic fix`
          : 'the failure names no file; no automatic fix',
        files: [],
      };
    for (const t of targets) writeFileSync(join(this.projectDir, t.path), t.content, 'utf-8');
    return {
      changed: true,
      description: `restored ${targets.map((t) => res(t.path)).join(', ')} from the generator (known-good version)`,
      files: targets.map((t) => res(t.path)),
    };
  }
}
