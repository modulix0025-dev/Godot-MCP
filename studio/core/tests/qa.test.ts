// SPDX-License-Identifier: Apache-2.0
//
// Phase 9 without Godot: fingerprints, classification, MSBuild parsing, the default scenarios, the generator's QA
// hooks, the fix loop's limits / restore / escalation rules, and the generator-restore fixer.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_GAME_SPEC } from '@modulex/shared';
import { StudioDb } from '../src/db/database.js';
import { generateProject, QA_ACTIONS } from '../src/project/game-generator.js';
import { classifyGodotMessage, fingerprint, makeFailure, recordFailures, type QaFailure } from '../src/qa/failures.js';
import { FixLoop, type Fixer } from '../src/qa/fix-loop.js';
import { GeneratorRestoreFixer } from '../src/qa/fixers.js';
import { parseMsbuildErrors } from '../src/qa/qa-runner.js';
import { defaultScenarios, ScenarioSchema } from '../src/qa/scenarios.js';

describe('failure fingerprints', () => {
  it('ignore instance ids, addresses, numbers and absolute paths; keep class and top frame', () => {
    const a = fingerprint(
      'runtime_exception',
      "Invalid call. Nonexistent function 'explode' in base 'Nil' <Object#123>",
      'res://scripts/player.gd',
      30,
    );
    const b = fingerprint(
      'runtime_exception',
      "Invalid call. Nonexistent function 'explode' in base 'Nil' <Object#987>",
      'res://scripts/player.gd',
      30,
    );
    expect(a).toBe(b);
    expect(fingerprint('hang', 'x', null, null)).not.toBe(fingerprint('crash', 'x', null, null));
    expect(fingerprint('runtime_exception', 'm', 'res://a.gd', 1)).not.toBe(
      fingerprint('runtime_exception', 'm', 'res://b.gd', 1),
    );
  });

  it('classifies Godot messages', () => {
    expect(classifyGodotMessage('SCRIPT ERROR: Parse Error: Unexpected token')).toBe('script_parse');
    expect(classifyGodotMessage('ERROR: Failed loading resource: res://textures/x.png.')).toBe('missing_resource');
    expect(classifyGodotMessage("SCRIPT ERROR: Invalid call. Nonexistent function 'x' in base 'Nil'.")).toBe(
      'runtime_exception',
    );
  });

  it('records failures and marks a recurrence of a fixed one', () => {
    const db = new StudioDb(':memory:');
    const f = makeFailure('runtime_exception', 'boom', 'test', 'res://a.gd', 3);
    recordFailures(db, 'p', [f]);
    db.run("UPDATE failures SET status = 'fixed'");
    recordFailures(db, 'p', [f]);
    expect(db.get<{ status: string }>('SELECT status FROM failures')!.status).toBe('recurred');
  });
});

it('parses MSBuild errors into {file, line, code, message}', () => {
  const log = [
    '/p/Scripts/Foo.cs(12,5): error CS1002: ; expected [/p/Game.csproj]',
    '/p/Scripts/Foo.cs(12,5): error CS1002: ; expected [/p/Game.csproj]',
    'Build FAILED.',
  ].join('\n');
  expect(parseMsbuildErrors(log)).toEqual([
    { file: '/p/Scripts/Foo.cs', line: 12, code: 'CS1002', message: '; expected' },
  ]);
});

describe('default scenarios', () => {
  const g = generateProject(SAMPLE_GAME_SPEC);
  const s = defaultScenarios(SAMPLE_GAME_SPEC, g);
  it('cover the Phase 9 list and validate against the schema', () => {
    expect(s.map((x) => x.id)).toEqual(
      expect.arrayContaining([
        'boot',
        'player-moves',
        'no-fall-through',
        'interact-and-jump',
        'hud',
        'pause-resume',
        'win',
        'lose',
        'level-2',
        'save-load',
      ]),
    );
    for (const x of s) expect(() => ScenarioSchema.parse(x)).not.toThrow();
  });

  it('the generated game carries the QA hooks the scenarios use, gated to debug + MODULEX_QA', () => {
    const pg = g.files.find((f) => f.path === 'project.godot')!.content;
    for (const a of QA_ACTIONS) expect(pg).toMatch(new RegExp(`^${a}=\\{\\n"deadzone": 0.2,\\n"events": \\[\\]`, 'm'));
    const gs = g.files.find((f) => f.path === 'scripts/game_state.gd')!.content;
    expect(gs).toContain('OS.is_debug_build() and OS.get_environment("MODULEX_QA") == "1"');
    expect(g.files.find((f) => f.path === 'scripts/player.gd')!.content).toMatch(/signal interacted/);
  });
});

function fakeSuite(state: { bugs: Set<string> }) {
  return async (): Promise<QaFailure[]> =>
    [...state.bugs].map((b) =>
      makeFailure(b.startsWith('infra') ? 'infra' : 'runtime_exception', `bug ${b}`, 't', `res://${b}.gd`, 1),
    );
}
const cps = () => {
  let n = 0;
  const restored: string[] = [];
  return {
    restored,
    checkpoint: async () => ({ name: `mx-cp-${++n}` }) as never,
    restore: async (name: string) => (restored.push(name), {}) as never,
  };
};

describe('fix loop', () => {
  it('fixes bugs one fingerprint at a time and ends SUCCESS with a green regression', async () => {
    const state = { bugs: new Set(['a', 'b']) };
    const fixer: Fixer = {
      name: 'test',
      propose: async (f) => (
        state.bugs.delete(f.file!.slice(6, -3)),
        { changed: true, description: 'fixed', files: [] }
      ),
    };
    const r = await new FixLoop({ projectId: 'p', checkpoints: cps(), fixer, runSuite: fakeSuite(state) }).run();
    expect(r.status).toBe('SUCCESS');
    expect(r.attempts.map((a) => a.outcome)).toEqual(['fixed', 'fixed']);
  });

  it('stops after 3 attempts per fingerprint: BLOCKED with a suggested owner action', async () => {
    const state = { bugs: new Set(['stubborn']) };
    const fixer: Fixer = { name: 'test', propose: async () => ({ changed: true, description: 'tried', files: [] }) };
    const r = await new FixLoop({ projectId: 'p', checkpoints: cps(), fixer, runSuite: fakeSuite(state) }).run();
    expect(r.status).toBe('BLOCKED');
    expect(r.attempts).toHaveLength(3);
    expect(r.summary).toMatch(/after 3 attempts/);
    expect(r.suggested_action).toBeTruthy();
  });

  it('a fix that breaks something else is restored from the checkpoint', async () => {
    const state = { bugs: new Set(['a']) };
    const c = cps();
    let first = true;
    const fixer: Fixer = {
      name: 'test',
      propose: async () => {
        if (first) {
          first = false;
          state.bugs.add('collateral');
          return { changed: true, description: 'bad fix', files: [] };
        }
        state.bugs.delete('a');
        return { changed: true, description: 'good fix', files: [] };
      },
    };
    const suite = fakeSuite(state);
    const r = await new FixLoop({
      projectId: 'p',
      checkpoints: {
        ...c,
        restore: async (n: string) => (c.restored.push(n), state.bugs.delete('collateral'), {}) as never,
      },
      fixer,
      runSuite: suite,
    }).run();
    expect(c.restored).toEqual(['mx-cp-1']);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['regressed_restored', 'fixed']);
    expect(r.status).toBe('SUCCESS');
  });

  it('a recurrence after "fixed" escalates at once; infra failures consume no attempts', async () => {
    const state = { bugs: new Set(['a', 'b']) };
    const fixer: Fixer = {
      name: 'test',
      propose: async (f) => {
        const bug = f.file!.slice(6, -3);
        state.bugs.delete(bug);
        if (bug === 'b') state.bugs.add('a'); // fixing b brings a back
        return { changed: true, description: `fix ${bug}`, files: [] };
      },
    };
    const r = await new FixLoop({ projectId: 'p', checkpoints: cps(), fixer, runSuite: fakeSuite(state) }).run();
    expect(r.status).toBe('BLOCKED');
    expect(r.summary).toMatch(/recurred/);

    const infra = await new FixLoop({
      projectId: 'p',
      checkpoints: cps(),
      fixer: { name: 'never', propose: async () => ({ changed: false, description: '', files: [] }) },
      runSuite: fakeSuite({ bugs: new Set(['infra-server']) }),
    }).run();
    expect(infra).toMatchObject({ status: 'BLOCKED', attempts: [] });
    expect(infra.summary).toMatch(/infrastructure/);
  });

  it('respects the per-run fix budget', async () => {
    const state = { bugs: new Set(['a', 'b', 'c']) };
    const fixer: Fixer = {
      name: 'test',
      propose: async (f) => (
        state.bugs.delete(f.file!.slice(6, -3)),
        { changed: true, description: 'fixed', files: [] }
      ),
    };
    const r = await new FixLoop({
      projectId: 'p',
      checkpoints: cps(),
      fixer,
      runSuite: fakeSuite(state),
      limits: { perRun: 2 },
    }).run();
    expect(r.status).toBe('BLOCKED');
    expect(r.summary).toMatch(/budget/);
  });
});

describe('generator-restore fixer', () => {
  const g = generateProject(SAMPLE_GAME_SPEC);
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mx-fixer-'));
    for (const f of g.files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    return dir;
  };

  it('restores a drifted generated script named by the top frame', async () => {
    const dir = setup();
    writeFileSync(join(dir, 'scripts/player.gd'), 'broken');
    const r = await new GeneratorRestoreFixer(dir, g).propose(
      makeFailure('runtime_exception', 'x', 't', 'res://scripts/player.gd', 3),
    );
    expect(r).toMatchObject({ changed: true, files: ['res://scripts/player.gd'] });
    expect(readFileSync(join(dir, 'scripts/player.gd'), 'utf-8')).toBe(
      g.files.find((f) => f.path === 'scripts/player.gd')!.content,
    );
  });

  it('restores the scene that references a missing resource', async () => {
    const dir = setup();
    const level = g.levelScenes[0]!.slice(6);
    writeFileSync(
      join(dir, level),
      readFileSync(join(dir, level), 'utf-8') + '\n[ext_resource path="res://textures/missing.png"]\n',
    );
    const r = await new GeneratorRestoreFixer(dir, g).propose(
      makeFailure('missing_resource', 'x', 't', 'res://textures/missing.png'),
    );
    expect(r.files).toEqual([`res://${level}`]);
  });

  it('cannot fix a file the generator does not own', async () => {
    const dir = setup();
    const r = await new GeneratorRestoreFixer(dir, g).propose(
      makeFailure('runtime_exception', 'x', 't', 'res://scripts/bonus.gd', 4),
    );
    expect(r.changed).toBe(false);
    expect(r.description).toMatch(/not a generated file/);
  });
});
