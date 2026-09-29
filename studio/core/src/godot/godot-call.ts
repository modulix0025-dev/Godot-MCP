// SPDX-License-Identifier: Apache-2.0
//
// GodotCall (Phase 4): the ONLY way Core invokes a raw Godot-MCP tool. Every call goes
//   policy decision (caller = studio-internal) → audit → execute over the session's server → record in the DB.
// Execution uses the server's REST tool API (`POST /api/tools/<tool>`), which Phase 0 showed carries the same
// results as MCP, images included (D-006). Destructive raw tools need an approved studio action (approvalId).
import { decide, DEV_MODE_OFF, studioError, StudioFailure, type Role } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor } from '../audit/secrets.js';
import type { StudioDb } from '../db/database.js';
import type { ServerSupervisor } from './server-supervisor.js';

export interface GodotCallRequest {
  tool: string;
  args?: Record<string, unknown>;
  role?: Role | null;
  taskId?: string | null;
  /** Approved studio-level approval that covers this destructive engine call. */
  approvalId?: string | null;
  timeoutMs?: number;
}

export interface GodotToolResult {
  ok: boolean;
  /** `structured.result` when the tool returns structured content. */
  result: unknown;
  /** Raw content items (text / image) as returned by the server. */
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  raw: Record<string, unknown>;
}

export class GodotClient {
  constructor(
    private readonly server: ServerSupervisor,
    private readonly deps: { audit: AuditLog; redactor: Redactor; db?: StudioDb | null; session: string },
  ) {
    deps.redactor.register(server.token);
  }

  async call(req: GodotCallRequest): Promise<GodotToolResult> {
    const d = decide(req.tool, {
      caller: 'studio-internal',
      role: req.role ?? undefined,
      devMode: DEV_MODE_OFF,
      approvalId: req.approvalId ?? undefined,
    });
    const record = (effect: string, extra: { duration_ms?: number; status?: string; error_code?: string } = {}) =>
      this.deps.db?.recordToolCall({
        session: this.deps.session,
        caller: 'studio-internal',
        role: req.role ?? null,
        tool: req.tool,
        tier: d.tier,
        effect,
        task_id: req.taskId ?? null,
        ...extra,
      });
    if (d.effect !== 'allow') {
      this.deps.audit.append('tool_call_denied', 'studio', {
        tool: req.tool,
        effect: d.effect,
        session: this.deps.session,
      });
      record(d.effect);
      throw new StudioFailure(
        d.effect === 'ask'
          ? studioError(
              'PENDING_APPROVAL',
              'APPROVAL_REQUIRED',
              `'${req.tool}' needs an approved studio action.`,
              'Request owner approval first.',
            )
          : studioError('BLOCKED', d.code, d.reason, 'Use an allowed tool.'),
      );
    }
    this.deps.audit.append('tool_call_allowed', 'studio', {
      tool: req.tool,
      session: this.deps.session,
      task: req.taskId ?? null,
    });
    const started = Date.now();
    let status = 0;
    let body: Record<string, unknown> = {};
    try {
      const r = await fetch(`${this.server.baseUrl}/api/tools/${encodeURIComponent(req.tool)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.server.token}` },
        body: JSON.stringify(req.args ?? {}),
        signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      });
      status = r.status;
      const text = await r.text();
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: this.deps.redactor.redact(text) };
      }
    } catch (e) {
      record('allow', { duration_ms: Date.now() - started, status: 'error', error_code: 'STUDIO_UNAVAILABLE' });
      this.deps.audit.append('tool_call_failed', 'studio', { tool: req.tool, code: 'STUDIO_UNAVAILABLE' });
      throw new StudioFailure(
        studioError(
          'FAILED',
          'STUDIO_UNAVAILABLE',
          `Godot MCP server unreachable: ${this.deps.redactor.redact(String(e))}`,
          'Check the Godot session in Diagnostics.',
          true,
        ),
      );
    }
    const ok = status === 200 && body.status === 'success';
    const structured = (body.structured as { result?: unknown } | undefined)?.result;
    record('allow', {
      duration_ms: Date.now() - started,
      status: ok ? 'success' : 'error',
      error_code: ok ? undefined : `HTTP_${status}`,
    });
    this.deps.audit.append(ok ? 'tool_call_completed' : 'tool_call_failed', 'studio', { tool: req.tool, http: status });
    return {
      ok,
      result: structured ?? null,
      content: (body.content as GodotToolResult['content']) ?? [],
      raw: body,
    };
  }

  /** Text of the first text content item (most editor tools report there). */
  static text(r: GodotToolResult): string {
    return (
      r.content.find((c) => c.type === 'text')?.text ??
      (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? r.raw))
    );
  }
}
