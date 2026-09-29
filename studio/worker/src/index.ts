// SPDX-License-Identifier: Apache-2.0
//
// modulex-build-worker (Phase 11). Phase 1 ships only the job-id contract so the Studio and the worker agree on
// idempotency keys from day one; the HTTPS service, pairing and export/signing runner land in Phase 11.
export const BUILD_WORKER_VERSION = '0.1.0';

/** Build job ids are client-generated and idempotent: `bj_` + 26 lowercase base32 chars (ULID-like). */
export function isValidJobId(id: string): boolean {
  return /^bj_[0-9a-hjkmnp-tv-z]{26}$/.test(id);
}
