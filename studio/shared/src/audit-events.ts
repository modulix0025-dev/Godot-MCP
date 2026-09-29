// SPDX-License-Identifier: Apache-2.0
//
// Audit event vocabulary. Every agent-facing action, policy decision, Developer Mode change and Claude
// integration event is recorded with one of these types in the append-only, hash-chained audit log
// (studio/core/src/audit/audit-log.ts). Payloads are redacted before they are written; secrets never appear.

export const AUDIT_EVENTS = [
  // policy + tools
  'tool_call_allowed',
  'tool_call_denied',
  'tool_call_completed',
  'tool_call_failed',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'approval_withdrawn',
  'approval_expired',
  'policy_override_added',
  'untrusted_content_flagged',
  // developer mode
  'developer_mode_enabled',
  'developer_mode_disabled',
  'developer_capability_granted',
  // workers
  'worker_registered',
  'worker_trust_changed',
  'worker_quarantined',
  'worker_released_by_owner',
  // provenance
  'asset_provenance_recorded',
  'asset_license_blocked',
  // Claude integration (Execution Patch 1 §38)
  'claude_desktop_connected',
  'claude_desktop_disconnected',
  'claude_tool_call',
  'claude_approval_requested',
  'claude_approval_granted',
  'claude_approval_rejected',
  'claude_provider_call',
  'claude_provider_error',
  'claude_session_opened',
  'claude_health_test',
  // pipeline
  'game_spec_created',
  'pipeline_run_created',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];
