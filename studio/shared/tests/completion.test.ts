// SPDX-License-Identifier: Apache-2.0
//
// GATE 12 (predicate): EVERY combination of missing evidence over the 17 evidence rows of a Windows game
// (2^17 = 131,072 cases), plus every proven-failing single row and the platform rules. The verdict is SUCCESS in
// exactly one case — all rows proven — and `missing` always names exactly the rows that have no evidence.
import { describe, expect, it } from 'vitest';
import { evaluateCompletion, type CompletionEvidence, type Evidence } from '../src/index.js';

const ROWS = [
  'project.exists',
  'project.manifestsValid',
  'project.noBlockingValidationFailures',
  'assets.requiredExist',
  'assets.importsSucceeded',
  'assets.provenanceComplete',
  'assets.commercialUseCleared',
  'assets.noUnresolvedDependencies',
  'gameplay.scriptsValid',
  'gameplay.buildClean',
  'gameplay.requiredSystemsPresent',
  'qa.smokeTestsPass',
  'qa.noUnhandledRuntimeErrors',
  'qa.criticalVisualChecksPass',
  'windows.exeExists',
  'windows.checksumRecorded',
  'windows.launchSmokePassed',
] as const;

function evidence(value: (row: string) => Evidence): CompletionEvidence {
  const v = (r: string) => value(r);
  return {
    project: {
      exists: v('project.exists'),
      manifestsValid: v('project.manifestsValid'),
      noBlockingValidationFailures: v('project.noBlockingValidationFailures'),
    },
    assets: {
      requiredExist: v('assets.requiredExist'),
      importsSucceeded: v('assets.importsSucceeded'),
      provenanceComplete: v('assets.provenanceComplete'),
      commercialUseCleared: v('assets.commercialUseCleared'),
      noUnresolvedDependencies: v('assets.noUnresolvedDependencies'),
    },
    gameplay: {
      scriptsValid: v('gameplay.scriptsValid'),
      buildClean: v('gameplay.buildClean'),
      requiredSystemsPresent: v('gameplay.requiredSystemsPresent'),
    },
    qa: {
      smokeTestsPass: v('qa.smokeTestsPass'),
      noUnhandledRuntimeErrors: v('qa.noUnhandledRuntimeErrors'),
      criticalVisualChecksPass: v('qa.criticalVisualChecksPass'),
    },
    platforms: [
      {
        platform: 'windows',
        exeExists: v('windows.exeExists'),
        checksumRecorded: v('windows.checksumRecorded'),
        launchSmokePassed: v('windows.launchSmokePassed'),
      },
    ],
  };
}

describe('completion predicate — every missing-evidence combination', () => {
  it(`all ${2 ** ROWS.length} combinations: SUCCESS iff nothing is missing; missing names exactly the gaps`, () => {
    let successes = 0;
    for (let mask = 0; mask < 2 ** ROWS.length; mask++) {
      const missingRows = ROWS.filter((_, i) => mask & (1 << i));
      const v = evaluateCompletion(evidence((r) => (missingRows.includes(r as never) ? null : true)));
      if (v.isGameComplete) successes++;
      if (mask === 0) expect(v).toMatchObject({ isGameComplete: true, status: 'SUCCESS' });
      else {
        if (v.isGameComplete || v.status === 'SUCCESS') throw new Error(`mask ${mask} judged complete`);
        if (v.missing.length !== missingRows.length || v.missing.some((m) => !missingRows.includes(m as never)))
          throw new Error(`mask ${mask}: missing ${v.missing.join(',')} ≠ ${missingRows.join(',')}`);
        // Only platform rows missing → PARTIAL_SUCCESS is impossible here (the one platform is incomplete) → BLOCKED.
        if (v.status !== 'BLOCKED') throw new Error(`mask ${mask}: status ${v.status}`);
      }
    }
    expect(successes).toBe(1);
  });

  it('every single proven-failing row is FAILED and named', () => {
    for (const row of ROWS) {
      const v = evaluateCompletion(evidence((r) => (r === row ? false : true)));
      expect(v.isGameComplete, row).toBe(false);
      expect(v.status, row).toBe('FAILED');
      expect(v.failed, row).toEqual([row]);
    }
  });

  it('a second platform done while the first is incomplete is PARTIAL_SUCCESS, never SUCCESS', () => {
    const e = evidence(() => true);
    e.platforms.push({
      platform: 'ios',
      releaseRequested: true,
      preparationComplete: true,
      signedBuildExists: null,
      macWorkerAvailable: false,
    });
    const v = evaluateCompletion(e);
    expect(v).toMatchObject({ isGameComplete: false, status: 'PARTIAL_SUCCESS' });
    expect(v.failed.join()).toMatch(/macOS\/Xcode build worker required/);
    e.platforms[1] = { ...e.platforms[1]!, signedBuildExists: true, macWorkerAvailable: true } as never;
    expect(evaluateCompletion(e).isGameComplete).toBe(true);
  });

  it('an owner decision pending is NEEDS_HUMAN even with every row proven', () => {
    expect(evaluateCompletion({ ...evidence(() => true), awaitingHuman: 'fix loop exhausted' })).toMatchObject({
      isGameComplete: false,
      status: 'NEEDS_HUMAN',
    });
  });
});
