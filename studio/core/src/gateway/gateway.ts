// SPDX-License-Identifier: Apache-2.0
//
// Policy Gateway (EXECUTION_PROMPT Phase 5 + Execution Patch 1 §2, §27, §45). Every agent-facing call — ModuleX
// Agent or Claude Desktop — enters here: policy decision (`decide`, shared/policy.ts) → approval or refusal or
// execution → structured result → audit. The gateway is the ONLY enforcement point: addon-side tool disabling
// hides tools but does not block direct calls (DECISIONS D-010).
import { randomUUID } from 'node:crypto';
import {
  decide,
  DEV_MODE_OFF,
  injectionSignals,
  studioError,
  StudioFailure,
  type Caller,
  type DevCapability,
  type DevModeState,
  type Role,
  type StudioError,
} from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { StudioStore } from '../store/studio-store.js';
import type { ToolHandler } from './tool-handlers.js';
import type { SystemServices } from '../evolution/system.js';

/** What the owner sees for an approval (Execution Patch 1 §48: What / Why / Scope / Files / Risk / Rollback). */
export interface ApprovalImpact {
  what: string;
  why: string;
  scope: string;
  files: string[];
  risk: 'low' | 'medium' | 'high' | 'critical';
  rollback: string;
}

export interface Approval {
  approval_id: string;
  tool: string;
  args: Record<string, unknown>;
  requested_by: Caller;
  role: Role | null;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'executed';
  impact: ApprovalImpact;
  /** Structured result of the approved execution, once executed. */
  result: unknown;
}

export interface CallContext {
  caller: Exclude<Caller, 'owner-ui' | 'studio-internal'>;
  role?: Role;
  sessionId?: string;
}

export type GatewayResult =
  | { status: 'SUCCESS' | 'PARTIAL_SUCCESS'; tool: string; data: unknown }
  | { status: 'PENDING_APPROVAL'; tool: string; approval_id: string; impact: ApprovalImpact; message: string }
  | StudioError;

export interface GatewayOptions {
  audit: AuditLog;
  store: StudioStore;
  handlers: ReadonlyMap<string, ToolHandler>;
  approvalTtlMs?: number;
  costThresholdUsd?: number;
  /** System Evolution services; when present, the live `policy` configuration document drives approvals. */
  system?: SystemServices | null;
  now?: () => Date;
}

export class Gateway {
  private devMode: DevModeState = DEV_MODE_OFF;
  private readonly approvals = new Map<string, Approval>();
  private readonly alwaysAllow = new Map<string, Set<string>>(); // project_id → tool ids
  readonly audit: AuditLog;
  readonly store: StudioStore;
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private readonly ttl: number;
  private readonly costThreshold: number;
  private readonly now: () => Date;
  readonly system: SystemServices | null;

  constructor(o: GatewayOptions) {
    this.system = o.system ?? null;
    this.audit = o.audit;
    this.store = o.store;
    this.handlers = o.handlers;
    this.ttl = o.approvalTtlMs ?? 30 * 60_000;
    this.costThreshold = o.costThresholdUsd ?? 0.25;
    this.now = o.now ?? (() => new Date());
  }

  // ---------- Developer Mode (owner only) ----------

  getDevMode(): DevModeState {
    return { enabled: this.devMode.enabled, capabilities: [...this.devMode.capabilities] };
  }

  /**
   * Enable/disable Developer Mode. Only the owner UI calls this, and enabling any capability requires an explicit
   * confirmation flag (the UI shows the dangerous-capability dialog first). Always audited.
   */
  setDevMode(
    enabled: boolean,
    capabilities: DevCapability[],
    opts: { actor: 'owner-ui'; confirmed: boolean },
  ): DevModeState {
    if (opts.actor !== 'owner-ui') throw new Error('Developer Mode can only be changed by the owner in the Studio.');
    if (enabled && !opts.confirmed) throw new Error('Enabling Developer Mode requires explicit confirmation.');
    const next: DevModeState = enabled ? { enabled: true, capabilities: [...new Set(capabilities)] } : DEV_MODE_OFF;
    const added = next.capabilities.filter((c) => !this.devMode.capabilities.includes(c));
    this.devMode = next;
    this.audit.append(enabled ? 'developer_mode_enabled' : 'developer_mode_disabled', 'owner-ui', {
      capabilities: next.capabilities,
    });
    for (const c of added) this.audit.append('developer_capability_granted', 'owner-ui', { capability: c });
    return this.getDevMode();
  }

  // ---------- Tool calls (agents) ----------

  async call(tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<GatewayResult> {
    const claude = ctx.caller === 'claude-desktop';
    const projectId = typeof args.project_id === 'string' ? args.project_id : undefined;
    const handler = this.handlers.get(tool);
    const policy = this.livePolicy();
    const allowSet = new Set<string>(projectId ? (this.alwaysAllow.get(projectId) ?? []) : []);
    for (const r of policy?.auto_approve ?? [])
      if (r.projects === '*' || (projectId && r.projects.includes(projectId))) allowSet.add(r.tool);
    const decision = decide(tool, {
      caller: ctx.caller,
      role: ctx.role,
      devMode: this.devMode,
      alwaysAllow: allowSet.size ? allowSet : undefined,
      estimatedCostUsd: handler?.estimateCostUsd?.(args),
      costThresholdUsd: policy?.cost_threshold_usd ?? this.costThreshold,
    });
    if (claude)
      this.audit.append('claude_tool_call', ctx.caller, {
        tool,
        effect: decision.effect,
        session: ctx.sessionId ?? null,
      });

    this.flagUntrustedArgs(tool, args, ctx);

    if (decision.effect === 'deny') {
      this.audit.append('tool_call_denied', ctx.caller, { tool, code: decision.code, role: ctx.role ?? null });
      return studioError(
        'BLOCKED',
        decision.code,
        decision.reason,
        decision.code === 'DEVELOPER_MODE_REQUIRED'
          ? 'Use the high-level studio_* tools, or ask the owner to enable Developer Mode for this session.'
          : 'Use a tool from your advertised tool list; owner-only actions are done in the ModuleX Game Studio app.',
      );
    }
    if (!handler) {
      // Catalogued and allowed, but not implemented by this Core build (never advertised; direct call only).
      return studioError(
        'BLOCKED',
        'PIPELINE_ENGINE_UNAVAILABLE',
        `'${tool}' is not available in this Studio build yet.`,
        'Check studio_pipeline_status for what can run now.',
      );
    }

    const parsed = handler.input.safeParse(args);
    if (!parsed.success) {
      return studioError(
        'FAILED',
        'INVALID_ARGUMENTS',
        `Invalid arguments for '${tool}'.`,
        'Fix the arguments listed in details and call again.',
        false,
        {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      );
    }
    const input = parsed.data as Record<string, unknown>;

    if (decision.effect === 'ask') {
      const approvedId = typeof args.approval_id === 'string' ? args.approval_id : null;
      const approved = approvedId ? this.approvals.get(approvedId) : undefined;
      if (approved && approved.status === 'approved' && approved.tool === tool && sameArgs(approved.args, input)) {
        return this.execute(tool, handler, input, ctx, approved);
      }
      return this.requestApproval(
        tool,
        input,
        ctx,
        handler.impact ? handler.impact(input, this.store) : defaultImpact(tool, decision.reason),
      );
    }

    return this.execute(tool, handler, input, ctx);
  }

  private async execute(
    tool: string,
    handler: ToolHandler,
    input: Record<string, unknown>,
    ctx: CallContext,
    approval?: Approval,
  ): Promise<GatewayResult> {
    this.audit.append('tool_call_allowed', ctx.caller, { tool, approval_id: approval?.approval_id ?? null });
    try {
      const out = await handler.run(input, {
        gateway: this,
        system: this.system,
        store: this.store,
        caller: ctx.caller,
        role: ctx.role ?? null,
        approvalId: approval?.approval_id ?? null,
      });
      if (approval) {
        approval.status = 'executed';
        approval.result = out.data;
      }
      this.audit.append('tool_call_completed', ctx.caller, { tool, status: out.status });
      return { status: out.status, tool, data: out.data };
    } catch (e) {
      const err =
        e instanceof StudioFailure
          ? e.error
          : studioError(
              'FAILED',
              'INTERNAL',
              'The Studio failed to complete the call.',
              'Check the Activity log; retry once if the cause was transient.',
              true,
            );
      this.audit.append('tool_call_failed', ctx.caller, { tool, code: err.code });
      return err;
    }
  }

  // ---------- Approvals ----------

  requestApproval(
    tool: string,
    args: Record<string, unknown>,
    ctx: CallContext,
    impact: ApprovalImpact,
  ): GatewayResult {
    this.expireStale();
    const created = this.now();
    const approval: Approval = {
      approval_id: `ap_${randomUUID()}`,
      tool,
      args,
      requested_by: ctx.caller,
      role: ctx.role ?? null,
      created_at: created.toISOString(),
      expires_at: new Date(
        created.getTime() + (this.livePolicy()?.approval_ttl_minutes ?? this.ttl / 60_000) * 60_000,
      ).toISOString(),
      status: 'pending',
      impact,
      result: null,
    };
    this.approvals.set(approval.approval_id, approval);
    this.audit.append(
      ctx.caller === 'claude-desktop' ? 'claude_approval_requested' : 'approval_requested',
      ctx.caller,
      {
        approval_id: approval.approval_id,
        tool,
        risk: impact.risk,
      },
    );
    return {
      status: 'PENDING_APPROVAL',
      tool,
      approval_id: approval.approval_id,
      impact,
      message:
        'The owner must approve this in the ModuleX Game Studio app. After approval, call the same tool again with the same arguments plus approval_id.',
    };
  }

  listApprovals(filter?: { status?: Approval['status'] }): Approval[] {
    this.expireStale();
    return [...this.approvals.values()].filter((a) => !filter?.status || a.status === filter.status);
  }

  /** Owner decision (Studio UI only). Agents — including Claude — cannot approve or reject. */
  resolveApproval(id: string, action: 'approve' | 'reject', actor: Caller, alwaysForProject = false): Approval {
    if (actor !== 'owner-ui') {
      throw new StudioFailure(
        studioError(
          'BLOCKED',
          'APPROVAL_NOT_OWNER',
          'Only the owner can approve or reject, in the ModuleX Game Studio app.',
          'Ask the owner to review the request in Approvals.',
        ),
      );
    }
    this.expireStale();
    const a = this.approvals.get(id);
    if (!a)
      throw new StudioFailure(
        studioError('FAILED', 'NOT_FOUND', `Approval '${id}' not found.`, 'List approvals with studio_approval_list.'),
      );
    if (a.status !== 'pending')
      throw new StudioFailure(
        studioError('BLOCKED', 'APPROVAL_EXPIRED', `Approval '${id}' is ${a.status}.`, 'Request a new approval.'),
      );
    a.status = action === 'approve' ? 'approved' : 'rejected';
    const claude = a.requested_by === 'claude-desktop';
    this.audit.append(
      action === 'approve'
        ? claude
          ? 'claude_approval_granted'
          : 'approval_granted'
        : claude
          ? 'claude_approval_rejected'
          : 'approval_rejected',
      'owner-ui',
      { approval_id: id, tool: a.tool },
    );
    if (action === 'approve' && alwaysForProject && typeof a.args.project_id === 'string') {
      const set = this.alwaysAllow.get(a.args.project_id) ?? new Set<string>();
      set.add(a.tool);
      this.alwaysAllow.set(a.args.project_id, set);
      this.audit.append('policy_override_added', 'owner-ui', { project_id: a.args.project_id, tool: a.tool });
    }
    return a;
  }

  /** The requester may withdraw its own pending request. */
  withdrawApproval(id: string, caller: Caller): Approval {
    const a = this.approvals.get(id);
    if (!a)
      throw new StudioFailure(
        studioError('FAILED', 'NOT_FOUND', `Approval '${id}' not found.`, 'List approvals with studio_approval_list.'),
      );
    if (a.requested_by !== caller)
      throw new StudioFailure(
        studioError(
          'BLOCKED',
          'APPROVAL_NOT_OWNER',
          'You can only withdraw requests you made.',
          'Leave other requests to the owner.',
        ),
      );
    if (a.status !== 'pending')
      throw new StudioFailure(
        studioError('BLOCKED', 'APPROVAL_EXPIRED', `Approval '${id}' is ${a.status}.`, 'Nothing to withdraw.'),
      );
    a.status = 'withdrawn';
    this.audit.append('approval_withdrawn', caller, { approval_id: id });
    return a;
  }

  private expireStale(): void {
    const now = this.now().getTime();
    for (const a of this.approvals.values()) {
      if (a.status === 'pending' && Date.parse(a.expires_at) <= now) {
        a.status = 'expired';
        this.audit.append('approval_expired', 'studio', { approval_id: a.approval_id, tool: a.tool });
      }
    }
  }

  /** The live approval policy (Mode A configuration), or null when System services are not running. */
  private livePolicy() {
    try {
      return this.system?.policy() ?? null;
    } catch {
      return null; // an invalid document never loosens policy: fall back to built-in defaults
    }
  }

  /** Instruction-like text in agent-supplied content is flagged for the owner — never acted upon. */
  private flagUntrustedArgs(tool: string, args: Record<string, unknown>, ctx: CallContext): void {
    const text = JSON.stringify(args);
    const signals = injectionSignals(text);
    if (signals.length) this.audit.append('untrusted_content_flagged', ctx.caller, { tool, signals });
  }
}

function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (o: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => k !== 'approval_id')
          .sort(([x], [y]) => x.localeCompare(y)),
      ),
    );
  return strip(a) === strip(b);
}

function defaultImpact(tool: string, reason: string): ApprovalImpact {
  return {
    what: `Run ${tool}`,
    why: reason,
    scope: 'See arguments',
    files: [],
    risk: 'medium',
    rollback: 'Restore the automatic checkpoint taken before execution.',
  };
}
