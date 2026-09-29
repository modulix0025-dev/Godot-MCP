// SPDX-License-Identifier: Apache-2.0
//
// GATE 9 (live): a generated game passes its default scenarios; two injected bugs (a GDScript null call in
// _physics_process and a missing texture path) are detected by class, fixed within the limits, and the full
// regression is green; a bug in a file the generator does not own ends BLOCKED — never SUCCESS.
// Needs MODULEX_LIVE_GODOT + MODULEX_LIVE_SERVER; windowed (screenshots) when DISPLAY is set (Xvfb in CI).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_GAME_SPEC } from '@modulex/shared';
import { AuditLog } from '../src/audit/audit-log.js';
import { Redactor } from '../src/audit/secrets.js';
import { ProjectCheckpoints } from '../src/checkpoints/project-checkpoints.js';
import { StudioDb } from '../src/db/database.js';
import { ProjectFactory } from '../src/project/project-factory.js';
import { FixLoop } from '../src/qa/fix-loop.js';
import { GeneratorRestoreFixer } from '../src/qa/fixers.js';
import { PlaytestSession } from '../src/qa/playtest.js';
import { QaRunner, writeScenarios } from '../src/qa/qa-runner.js';
import { defaultScenarios } from '../src/qa/scenarios.js';

const GODOT = process.env.MODULEX_LIVE_GODOT;
const SERVER = process.env.MODULEX_LIVE_SERVER;
const live = Boolean(GODOT && SERVER && existsSync(GODOT) && existsSync(SERVER));
const windowed = Boolean(process.env.DISPLAY);

describe.runIf(live)('GATE 9 — QA runner, injected bugs and the fix loop', () => {
  it(
    'clean game green → injected bugs detected and fixed → unfixable bug BLOCKED',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'mx-gate9-'));
      const db = new StudioDb(':memory:');
      const redactor = new Redactor();
      const audit = new AuditLog(redactor);
      const factory = new ProjectFactory({
        projectsRoot: root,
        addonsSource: resolve(__dirname, '../../../addons'),
        godot: GODOT!,
        db,
      });
      const created = await factory.create(SAMPLE_GAME_SPEC);
      expect(created.ok).toBe(true);
      const dir = created.projectDir;
      const g = created.generated;
      writeScenarios(dir, defaultScenarios(SAMPLE_GAME_SPEC, g));
      const qa = new QaRunner({
        projectId: 'gate9',
        projectDir: dir,
        godot: GODOT!,
        solution: join(dir, `${g.assembly}.sln`),
        db,
        playtest: () =>
          new PlaytestSession({ godot: GODOT!, serverBinary: SERVER!, projectDir: dir, audit, redactor, db, windowed }),
      });
      const show = (label: string) => {
        const r = qa.lastReport!;
        console.log(`[gate9] ${label}: ${r.failures.length} failure(s)`);
        for (const s of r.playtest ?? [])
          console.log(
            `[gate9]   scenario ${s.id}: ${s.status} (${s.steps.filter((x) => x.status === 'passed').length}/${s.steps.length} steps${s.steps.some((x) => x.status === 'skipped') ? ', some skipped' : ''})`,
          );
        for (const f of r.failures)
          console.log(
            `[gate9]   ${f.class} ${f.fingerprint} ${f.file ?? ''}:${f.line ?? ''} — ${f.message.slice(0, 140)}`,
          );
      };

      // 1. Clean game: every default scenario passes.
      const clean = await qa.runSuite();
      show('clean');
      expect(clean).toEqual([]);
      expect(qa.lastReport!.playtest!.length).toBeGreaterThanOrEqual(8);

      // 2. Inject two bugs into generated files.
      const player = join(dir, 'scripts/player.gd');
      writeFileSync(
        player,
        readFileSync(player, 'utf-8').replace(
          'func _physics_process(delta: float) -> void:\n',
          'func _physics_process(delta: float) -> void:\n\tvar broken = null\n\tbroken.explode()\n',
        ),
      );
      const level = join(dir, g.levelScenes[0]!.slice('res://'.length));
      writeFileSync(
        level,
        readFileSync(level, 'utf-8').replace(
          /(\[ext_resource[^\n]*\]\n)/,
          '$1[ext_resource type="Texture2D" path="res://textures/missing_ground.png" id="99_missing"]\n',
        ),
      );
      const cp = new ProjectCheckpoints(dir, 'gate9', db);
      await cp.checkpoint('GATE 9: injected bugs');
      const broken = await qa.runSuite();
      show('injected');
      const classes = new Set(broken.map((f) => f.class));
      expect(classes).toContain('runtime_exception');
      expect(classes).toContain('missing_resource');
      expect(broken.some((f) => f.class === 'runtime_exception' && f.file === 'res://scripts/player.gd')).toBe(true);

      const loop = new FixLoop({
        projectId: 'gate9',
        checkpoints: cp,
        fixer: new GeneratorRestoreFixer(dir, g),
        runSuite: () => qa.runSuite(),
        db,
      });
      const fixed = await loop.run(broken);
      for (const a of fixed.attempts)
        console.log(`[gate9] fix ${a.class} #${a.attempt} (${a.checkpoint}): ${a.outcome} — ${a.proposal}`);
      console.log(`[gate9] fix loop: ${fixed.status} — ${fixed.summary}`);
      expect(fixed.status).toBe('SUCCESS');
      expect(fixed.attempts.length).toBeLessThanOrEqual(8);
      show('after fixes (full regression)');
      expect(qa.lastReport!.failures).toEqual([]);

      // 3. A bug in a file the generator does not own: the loop must stop BLOCKED with a suggested action.
      writeFileSync(
        join(dir, 'scripts/bonus.gd'),
        'extends Node3D\n\nfunc _ready() -> void:\n\tvar thing = null\n\tthing.spin()\n',
      );
      writeFileSync(
        join(dir, 'scenes/bonus.tscn'),
        '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/bonus.gd" id="1_bonus"]\n\n[node name="Bonus" type="Node3D"]\nscript = ExtResource("1_bonus")\n',
      );
      const unfixable = await new FixLoop({
        projectId: 'gate9',
        checkpoints: cp,
        fixer: new GeneratorRestoreFixer(dir, g),
        runSuite: () => qa.runSuite(),
        db,
      }).run();
      console.log(`[gate9] unfixable: ${unfixable.status} — ${unfixable.summary} → ${unfixable.suggested_action}`);
      expect(unfixable.status).toBe('BLOCKED');
      expect(unfixable.summary).toMatch(/bonus\.gd/);
      console.log('[gate9] injected bugs detected, fixed, regression green; unfixable bug BLOCKED: exercised');
    },
    45 * 60_000,
  );
});
