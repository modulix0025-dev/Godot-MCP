// SPDX-License-Identifier: Apache-2.0
//
// The completion predicate, wired to the pipeline (EXECUTION_PROMPT Phase 12). `collectEvidence` turns what the
// pipeline actually recorded (stage outcomes, build records, provenance) into the `CompletionEvidence` rows that
// `evaluateCompletion` (shared) judges. Nothing here can claim more than the records show:
//
//   - a stage that ended PARTIAL_SUCCESS proves nothing for the evidence it stands for (null = "no evidence"), e.g.
//     a boot-only playtest does not prove the smoke scenarios, and a visual tier that did not run proves nothing;
//   - a platform counts only through its latest export build record: BUILT + sha256, SIGNED for an iOS release,
//     and a recorded launch smoke for Windows;
//   - a run that stopped for the owner (NEEDS_HUMAN) is awaitingHuman.
//
// There is no API, tool or UI path that sets SUCCESS: the verdict is recomputed from these rows every time.
import {
  evaluateCommercialUse,
  type CompletionEvidence,
  type CompletionVerdict,
  type Evidence,
  type PlatformEvidence,
  evaluateCompletion,
} from '@modulex/shared';
import type { BuildRecord, PipelineRun, ProjectRecord } from '../store/studio-store.js';

function stage(run: PipelineRun, name: string): { status: string; reason: string | null } {
  const s = run.stages.find((x) => x.stage === name);
  return { status: s?.status ?? 'PENDING', reason: s?.reason ?? null };
}

/** SUCCESS proves it, FAILED disproves it, anything else (PARTIAL_SUCCESS, PENDING, BLOCKED…) is no evidence. */
function proven(run: PipelineRun, name: string): Evidence {
  const s = stage(run, name).status;
  if (s === 'SUCCESS') return true;
  if (s === 'FAILED') return false;
  return null;
}

function latest(builds: BuildRecord[], platform: BuildRecord['platform'], profile: string): BuildRecord | null {
  const rows = builds.filter((b) => b.platform === platform && b.profile === profile);
  return rows.length ? rows[rows.length - 1]! : null;
}

export function collectEvidence(p: ProjectRecord, run: PipelineRun, exportProfile: string): CompletionEvidence {
  const spec = p.manifests.gameSpec;
  const required = (p.manifests.assetManifest?.assets ?? []).filter((a) => a.required);
  const provenanceFor = (id: string) => p.provenance.find((x) => x.asset_id === id);
  const allProvenance = required.length > 0 && required.every((a) => provenanceFor(a.id));
  const commercial =
    required.length === 0
      ? true
      : allProvenance
        ? required.every((a) => evaluateCommercialUse(provenanceFor(a.id)).status === 'ALLOWED')
        : null;

  const platforms: PlatformEvidence[] = (spec?.platforms ?? []).map((platform) => {
    const b = latest(p.builds, platform, exportProfile);
    if (platform === 'windows')
      return {
        platform,
        exeExists: b ? b.status === 'BUILT' : null,
        checksumRecorded: b ? Boolean(b.sha256) : null,
        launchSmokePassed: b?.smoke ?? null,
      };
    if (platform === 'android')
      return {
        platform,
        packageExists: b ? b.status === 'BUILT' : null,
        checksumRecorded: b ? Boolean(b.sha256) : null,
        metadataValid: b ? b.status === 'BUILT' : null,
        deviceSmokePassed: null,
        deviceAvailable: false,
      };
    return {
      platform: 'ios',
      releaseRequested: exportProfile === 'RELEASE',
      preparationComplete: b ? b.status === 'PREPARED' || b.status === 'SIGNED' : null,
      signedBuildExists: b ? b.status === 'SIGNED' : null,
      macWorkerAvailable: Boolean(b && (b.status === 'SIGNED' || /build worker \S+ \(job/.test(b.note ?? ''))),
    };
  });

  const needsHuman = run.stages.find((s) => s.status === 'NEEDS_HUMAN');
  return {
    project: {
      exists: proven(run, 'project_creation'),
      manifestsValid: spec && p.manifests.taskGraph ? true : null,
      noBlockingValidationFailures: proven(run, 'qa'),
    },
    assets: {
      requiredExist: proven(run, 'asset_generation'),
      importsSucceeded: proven(run, 'asset_processing'),
      provenanceComplete: required.length === 0 ? true : allProvenance ? true : null,
      commercialUseCleared: commercial,
      noUnresolvedDependencies: proven(run, 'scene_construction'),
    },
    gameplay: {
      scriptsValid: proven(run, 'qa'),
      buildClean: proven(run, 'build'),
      requiredSystemsPresent: proven(run, 'gameplay'),
    },
    qa: {
      smokeTestsPass: proven(run, 'playtest'),
      noUnhandledRuntimeErrors: proven(run, 'regression'),
      criticalVisualChecksPass: proven(run, 'visual_inspection'),
    },
    platforms,
    awaitingHuman: needsHuman ? `${needsHuman.stage}: ${needsHuman.reason ?? 'owner decision needed'}` : null,
  };
}

export function completionOf(p: ProjectRecord, run: PipelineRun, exportProfile: string): CompletionVerdict {
  return evaluateCompletion(collectEvidence(p, run, exportProfile));
}
