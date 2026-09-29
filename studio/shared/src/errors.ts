// SPDX-License-Identifier: Apache-2.0
//
// Structured outcomes for every Studio operation (stage, tool call, job, build). Agents — ModuleX Agent and
// Claude via the Studio MCP — always receive one of these shapes, never a vague error string, so they can
// decide deterministically whether to retry, ask the owner, or stop.
import { z } from 'zod';

/** Terminal/stage statuses (EXECUTION_PROMPT rule 4 + Patch 1 §44) plus the approval-wait state. */
export const OUTCOME_STATUSES = [
  'SUCCESS',
  'PARTIAL_SUCCESS',
  'BLOCKED',
  'FAILED',
  'NEEDS_HUMAN',
  'PENDING_APPROVAL',
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Stable machine-readable error codes. Add new codes here; never reuse one with a different meaning. */
export const ERROR_CODES = [
  'TOOL_NOT_ALLOWED',
  'TOOL_DISABLED',
  'TOOL_UNKNOWN',
  'DEVELOPER_MODE_REQUIRED',
  'APPROVAL_REQUIRED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_OWNER',
  'INVALID_ARGUMENTS',
  'NOT_FOUND',
  'WORKER_UNTRUSTED',
  'WORKER_QUARANTINED',
  'WORKER_OFFLINE',
  'PROVENANCE_MISSING',
  'LICENSE_UNKNOWN',
  'COMMERCIAL_USE_FORBIDDEN',
  'SPEC_INVALID',
  'PIPELINE_ENGINE_UNAVAILABLE',
  'MACOS_WORKER_REQUIRED',
  'PROVIDER_AUTH',
  'PROVIDER_MODEL_UNAVAILABLE',
  'PROVIDER_BAD_REQUEST',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSAL',
  'SECRET_ACCESS_DENIED',
  'STUDIO_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const StudioErrorSchema = z
  .object({
    status: z.enum(OUTCOME_STATUSES),
    code: z.enum(ERROR_CODES),
    message: z.string().min(1),
    suggested_action: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type StudioError = z.infer<typeof StudioErrorSchema>;

export function studioError(
  status: Exclude<OutcomeStatus, 'SUCCESS' | 'PARTIAL_SUCCESS'>,
  code: ErrorCode,
  message: string,
  suggested_action: string,
  retryable = false,
  details?: Record<string, unknown>,
): StudioError {
  return details
    ? { status, code, message, suggested_action, retryable, details }
    : { status, code, message, suggested_action, retryable };
}

/** Thrown inside Core; converted to a StudioError at every agent-facing boundary. */
export class StudioFailure extends Error {
  constructor(readonly error: StudioError) {
    super(error.message);
    this.name = 'StudioFailure';
  }
}
