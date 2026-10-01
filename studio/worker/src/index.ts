// SPDX-License-Identifier: Apache-2.0
//
// modulex-build-worker (Phase 11): the remote export/signing worker. A macOS worker produces SIGNED iOS builds; an
// optional Windows worker offloads desktop/Android exports. The protocol is in `@modulex/shared` (build-worker.ts).
import { isValidBuildJobId } from '@modulex/shared';

export { BUILD_WORKER_VERSION, WorkerService, type WorkerServiceOptions } from './service.js';
export { WorkerStore, type StoredJob, type WorkerState } from './store.js';
export {
  GodotExportRunner,
  RunnerError,
  setPresetOptions,
  type BuildRunner,
  type RunContext,
  type RunResult,
} from './runner.js';

/** Build job ids are client-generated and idempotent: `bj_` + 26 lowercase base32 chars (ULID-like). */
export function isValidJobId(id: string): boolean {
  return isValidBuildJobId(id);
}
