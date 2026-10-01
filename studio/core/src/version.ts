// SPDX-License-Identifier: Apache-2.0
import type { VersionSet } from '@modulex/shared';

export const STUDIO_CORE_VERSION = '0.1.0';

/**
 * The versions this Core build ships with (Execution Patch 2 §16). Mirrors studio/compat.json — the bundled sidecar
 * cannot read that file at runtime, so core/tests/evolution.test.ts fails if the two drift.
 */
export const STUDIO_VERSIONS: VersionSet = {
  studio: STUDIO_CORE_VERSION,
  schema: 2,
  godot: '4.5.1',
  addons: { godot_mcp: '0.25.1', modulex_studio: '0.1.0' },
  worker_protocol: 1,
  workflows: {},
};
