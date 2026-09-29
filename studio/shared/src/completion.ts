// SPDX-License-Identifier: Apache-2.0
//
// The completion predicate (EXECUTION_PROMPT Phase 12, strengthened by Execution Patch 1 §43–44).
// `isGameComplete` is computed server-side from evidence rows only. Neither the UI nor any agent can set SUCCESS;
// a missing piece of evidence always downgrades the verdict and names exactly what is missing.
import type { OutcomeStatus } from './errors.js';

export type Evidence = boolean | null; // true = proven, false = proven failing, null = no evidence recorded

export interface CompletionEvidence {
  project: { exists: Evidence; manifestsValid: Evidence; noBlockingValidationFailures: Evidence };
  assets: {
    requiredExist: Evidence;
    importsSucceeded: Evidence;
    provenanceComplete: Evidence;
    commercialUseCleared: Evidence;
    noUnresolvedDependencies: Evidence;
  };
  gameplay: { scriptsValid: Evidence; buildClean: Evidence; requiredSystemsPresent: Evidence };
  qa: { smokeTestsPass: Evidence; noUnhandledRuntimeErrors: Evidence; criticalVisualChecksPass: Evidence };
  /** One entry per REQUESTED platform target. */
  platforms: PlatformEvidence[];
  /** Set when the pipeline escalated a decision to the owner (fix loop exhausted, approval pending…). */
  awaitingHuman?: string | null;
}

export type PlatformEvidence =
  | { platform: 'windows'; exeExists: Evidence; checksumRecorded: Evidence; launchSmokePassed: Evidence }
  | {
      platform: 'android';
      packageExists: Evidence;
      checksumRecorded: Evidence;
      metadataValid: Evidence;
      /** null when no device/emulator is available (then honestly "built, not device-tested"). */
      deviceSmokePassed: Evidence;
      deviceAvailable: boolean;
    }
  | {
      platform: 'ios';
      releaseRequested: boolean;
      preparationComplete: Evidence;
      signedBuildExists: Evidence;
      macWorkerAvailable: boolean;
    };

export interface CompletionVerdict {
  isGameComplete: boolean;
  status: Exclude<OutcomeStatus, 'PENDING_APPROVAL'>;
  missing: string[];
  failed: string[];
  notes: string[];
}

function collect(prefix: string, group: Record<string, Evidence>, missing: string[], failed: string[]) {
  for (const [k, v] of Object.entries(group)) {
    if (v === null) missing.push(`${prefix}.${k}`);
    else if (v === false) failed.push(`${prefix}.${k}`);
  }
}

export function evaluateCompletion(e: CompletionEvidence): CompletionVerdict {
  const missing: string[] = [];
  const failed: string[] = [];
  const notes: string[] = [];
  const blocked: string[] = [];

  collect('project', e.project, missing, failed);
  collect('assets', e.assets, missing, failed);
  collect('gameplay', e.gameplay, missing, failed);
  collect('qa', e.qa, missing, failed);

  let platformsOk = 0;
  for (const p of e.platforms) {
    const before = missing.length + failed.length + blocked.length;
    if (p.platform === 'windows') {
      collect(
        'windows',
        { exeExists: p.exeExists, checksumRecorded: p.checksumRecorded, launchSmokePassed: p.launchSmokePassed },
        missing,
        failed,
      );
    } else if (p.platform === 'android') {
      collect(
        'android',
        { packageExists: p.packageExists, checksumRecorded: p.checksumRecorded, metadataValid: p.metadataValid },
        missing,
        failed,
      );
      if (p.deviceAvailable) collect('android', { deviceSmokePassed: p.deviceSmokePassed }, missing, failed);
      else notes.push('Android: built, not device-tested (no device/emulator available).');
    } else {
      if (p.releaseRequested) {
        if (p.signedBuildExists === true) {
          /* signed .ipa exists — satisfied */
        } else if (!p.macWorkerAvailable) blocked.push('ios.signedBuild: macOS/Xcode build worker required');
        else collect('ios', { signedBuildExists: p.signedBuildExists }, missing, failed);
      } else {
        collect('ios', { preparationComplete: p.preparationComplete }, missing, failed);
        if (p.preparationComplete === true) notes.push('iOS: PREPARED — preparation is not a release.');
      }
    }
    if (missing.length + failed.length + blocked.length === before) platformsOk++;
  }
  if (e.platforms.length === 0) missing.push('platforms: no build target requested');

  const isGameComplete = missing.length === 0 && failed.length === 0 && blocked.length === 0 && !e.awaitingHuman;
  let status: CompletionVerdict['status'];
  if (isGameComplete) status = 'SUCCESS';
  else if (e.awaitingHuman) status = 'NEEDS_HUMAN';
  else if (blocked.length) status = platformsOk > 0 ? 'PARTIAL_SUCCESS' : 'BLOCKED';
  else if (failed.length)
    status = platformsOk > 0 && failed.every((f) => /^(windows|android|ios)\./.test(f)) ? 'PARTIAL_SUCCESS' : 'FAILED';
  else
    status =
      platformsOk > 0 && missing.every((m) => /^(windows|android|ios)\./.test(m)) ? 'PARTIAL_SUCCESS' : 'BLOCKED';

  if (e.awaitingHuman) notes.push(`Waiting for the owner: ${e.awaitingHuman}`);
  return { isGameComplete, status, missing, failed: [...failed, ...blocked], notes };
}
