// SPDX-License-Identifier: Apache-2.0
//
// System Evolution tools (Execution Patch 2 §30). High-level and policy-gated: an agent can inspect the system,
// propose changes, attach a patch to a SANDBOX, run tests, read the diff and submit it for review. It cannot
// approve, cannot touch production directly, and has no raw filesystem or process tool. Approval, and the deploy
// of anything HIGH/CRITICAL/protected, belong to the owner in the Studio UI.
import { z } from 'zod';
import {
  CONFIG_DOC_IDS,
  REPAIR_ACTIONS,
  REQUEST_CATEGORIES,
  studioError,
  StudioFailure,
  type ConfigDocId,
  type RepairAction,
  type RequestCategory,
} from '@modulex/shared';
import type { EvolutionRecord } from '../evolution/evolution-service.js';
import type { SystemServices } from '../evolution/system.js';
import { footer, type HandlerContext, type ToolHandler } from './tool-handlers.js';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const evolutionId = z
  .string()
  .regex(/^evo_[a-z0-9-]+$/)
  .describe('Evolution id (from a propose/install call).');
const pkg = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .describe('Package folder name inside the owner-managed extensions/incoming folder (see studio_extension_list).');
const approvalId = z
  .string()
  .startsWith('ap_')
  .optional()
  .describe('Set only when re-calling after the owner approved.');

function sys(ctx: HandlerContext): SystemServices {
  if (!ctx.system)
    throw new StudioFailure(
      studioError(
        'BLOCKED',
        'PIPELINE_ENGINE_UNAVAILABLE',
        'System services are not running in this Core.',
        'Start Core with a data directory.',
      ),
    );
  return ctx.system;
}

const actor = (ctx: HandlerContext) =>
  (ctx.caller === 'owner-ui' ? 'owner-ui' : 'modulex-agent') as 'owner-ui' | 'modulex-agent';

/** Compact, secret-free view of an evolution for agents. */
function summary(r: EvolutionRecord) {
  const next: Record<string, string> = {
    PROPOSED:
      r.proposal.classification === 'core'
        ? 'studio_evolution_plan (attach plan + patch)'
        : r.proposal.classification === 'config'
          ? 'studio_config_propose'
          : 'studio_extension_install / studio_workflow_register / studio_provider_register',
    IN_SANDBOX: 'studio_evolution_test, then studio_evolution_approve (submits for owner review)',
    TESTS_FAILED: 'fix the patch (studio_evolution_plan) and re-test; never remove or skip tests',
    AWAITING_APPROVAL: 'wait: the owner reviews the exact change in System → Evolution',
    APPROVED:
      r.review?.confirmation_required || r.proposal.risk === 'HIGH' || r.proposal.risk === 'CRITICAL'
        ? 'wait: the owner deploys HIGH/CRITICAL/protected changes'
        : 'studio_evolution_deploy',
    SUCCESS: 'done (verified)',
    ROLLED_BACK: 'inspect r.problems / rollback reason',
    BLOCKED: 'see problems',
    REJECTED: 'closed by the owner',
    FAILED: 'see problems',
    TESTING: 'tests running',
    DEPLOYING: 'deploying',
  };
  return {
    evolution_id: r.evolution_id,
    status: r.status,
    classification: r.proposal.classification,
    category: r.proposal.category,
    risk: r.proposal.risk,
    version: `${r.proposal.base_version} → ${r.proposal.target_version}`,
    affected_components: r.proposal.affected_components,
    tests_required: r.proposal.tests,
    tests: r.tests.map((t) => ({ gate: t.gate, passed: t.passed, counts: t.counts })),
    stages: r.stages.map((s) => `${s.stage}:${s.status}`),
    problems: r.problems,
    review: r.review,
    next_step: next[r.status],
  };
}

export function evolutionHandlers(): ToolHandler[] {
  const installLike = (
    id: string,
    title: string,
    kind: 'skill' | 'workflow' | 'provider' | undefined,
    what: string,
  ): ToolHandler => ({
    id,
    title,
    description: footer(
      id,
      `${what} From a package the owner placed in the extensions/incoming folder. The Studio inspects the manifest (permissions, licence, compatibility, dependencies, file hashes), stages it in a sandbox, validates its content${kind === 'workflow' ? ' and runs one test job on a TRUSTED worker whose output is validated' : ''}, and opens an evolution for OWNER review. Nothing becomes live until the owner approves in the Studio and it is deployed. High-risk permissions are never granted automatically.\nArgs: package, reason.\nOutput: evolution summary (status AWAITING_APPROVAL, or BLOCKED with problems).`,
    ),
    input: z.object({ package: pkg, reason: z.string().max(2000).optional() }),
    annotations: RW,
    run: async (a, ctx) => {
      const r = await sys(ctx).evolution.proposeExtension({
        package: String(a.package),
        by: actor(ctx),
        reason: a.reason as string | undefined,
        expectKind: kind,
      });
      return { status: r.status === 'AWAITING_APPROVAL' ? 'SUCCESS' : 'PARTIAL_SUCCESS', data: summary(r) };
    },
  });

  return [
    {
      id: 'studio_system_status',
      title: 'System / Status',
      description: footer(
        'studio_system_status',
        'Versions (Studio, schema, Godot, addons, worker protocol, workflows), install state, Safe Mode, update channel, extension/Skill/workflow/provider counts, and the evolution summary. Changes nothing.\nArgs: none.',
      ),
      input: z.object({}),
      annotations: RO,
      run: async (_a, ctx) => ({ status: 'SUCCESS', data: sys(ctx).status() }),
    },
    {
      id: 'studio_config_get',
      title: 'System / Config get',
      description: footer(
        'studio_config_get',
        `Read a configuration document and its version history summary. Changes nothing.\nArgs: doc (${CONFIG_DOC_IDS.join(' | ')}).`,
      ),
      input: z.object({ doc: z.enum(CONFIG_DOC_IDS as [ConfigDocId, ...ConfigDocId[]]) }),
      annotations: RO,
      run: async (a, ctx) => {
        const c = sys(ctx).config;
        const doc = a.doc as ConfigDocId;
        return {
          status: 'SUCCESS',
          data: {
            ...c.get(doc),
            history: c.history(doc).map((v) => ({ version: v.version, at: v.at, by: v.by, reason: v.reason })),
          },
        };
      },
    },
    {
      id: 'studio_config_propose',
      title: 'System / Config propose',
      description: footer(
        'studio_config_propose',
        'Propose a new value for a configuration document (Mode A — applies without a rebuild once approved). The Studio validates it against the schema and shows the owner the exact path-level diff; the owner approves in System → Evolution, then it is written as a new version (old versions kept for rollback). Security documents (policy, update_settings) are CRITICAL: owner-typed confirmation and owner-only deploy. Hard limits the schema enforces: raw, critical and System Evolution tools can never be auto-approved.\nArgs: doc, value (the COMPLETE new document), reason.\nOutput: evolution summary with review.changes.',
      ),
      input: z.object({
        doc: z.enum(CONFIG_DOC_IDS as [ConfigDocId, ...ConfigDocId[]]),
        value: z.unknown(),
        reason: z.string().min(1).max(2000),
      }),
      annotations: RW,
      run: async (a, ctx) => {
        const r = sys(ctx).evolution.proposeConfig({
          doc: a.doc as ConfigDocId,
          value: a.value,
          reason: String(a.reason),
          by: actor(ctx),
        });
        return { status: r.status === 'AWAITING_APPROVAL' ? 'SUCCESS' : 'PARTIAL_SUCCESS', data: summary(r) };
      },
    },
    {
      id: 'studio_evolution_propose',
      title: 'Evolution / Propose',
      description: footer(
        'studio_evolution_propose',
        `Open a System Evolution for a change to ModuleX Game Studio itself. The Studio classifies the request (${REQUEST_CATEGORIES.join(', ')}) — your category is used only when it is at least as controlled as the Studio's own classification — and returns the mode (config | extension | core), risk floor, required test gates and the next step. Never modifies anything.\nArgs: request (the owner's words, verbatim), category?, reason?.`,
      ),
      input: z.object({
        request: z.string().min(1).max(4000),
        category: z.enum(REQUEST_CATEGORIES).optional(),
        reason: z.string().max(2000).optional(),
      }),
      annotations: RW,
      run: async (a, ctx) => {
        const r = sys(ctx).evolution.propose({
          request: String(a.request),
          by: actor(ctx),
          category: a.category as RequestCategory | undefined,
          reason: a.reason as string | undefined,
        });
        return { status: r.status === 'BLOCKED' ? 'PARTIAL_SUCCESS' : 'SUCCESS', data: summary(r) };
      },
    },
    {
      id: 'studio_evolution_plan',
      title: 'Evolution / Plan + patch (sandbox)',
      description: footer(
        'studio_evolution_plan',
        'Core evolutions only. Attach the implementation plan and a unified diff (git format, paths relative to the repository root). The Studio creates a sandbox git worktree on a new branch from the production base, applies the patch THERE and commits it. Production is untouched. Files, components and risk are recomputed from the actual diff (you can raise risk, never lower it). Calling again replaces the plan and adds another commit.\nArgs: evolution_id, plan, patch?, message?.',
      ),
      input: z.object({
        evolution_id: evolutionId,
        plan: z.string().min(1).max(20_000),
        patch: z.string().max(2_000_000).optional(),
        message: z.string().max(500).optional(),
      }),
      annotations: RW,
      run: async (a, ctx) => ({
        status: 'SUCCESS',
        data: summary(
          sys(ctx).evolution.plan(String(a.evolution_id), {
            plan: String(a.plan),
            patch: a.patch as string | undefined,
            message: a.message as string | undefined,
            by: actor(ctx),
          }),
        ),
      }),
    },
    {
      id: 'studio_evolution_test',
      title: 'Evolution / Test (sandbox)',
      description: footer(
        'studio_evolution_test',
        'Run the risk-based test gates (static, unit, integration, security, packaging, self-test, e2e — as required by the risk level) in the evolution sandbox. Fails fast. Never weaken tests to pass: patches that delete or skip tests, or remove audit calls, are blocked at review.\nArgs: evolution_id.',
      ),
      input: z.object({ evolution_id: evolutionId }),
      annotations: RW,
      run: async (a, ctx) => {
        const r = sys(ctx).evolution.test(String(a.evolution_id), actor(ctx));
        return { status: r.status === 'TESTS_FAILED' ? 'PARTIAL_SUCCESS' : 'SUCCESS', data: summary(r) };
      },
    },
    {
      id: 'studio_evolution_diff',
      title: 'Evolution / Diff',
      description: footer(
        'studio_evolution_diff',
        'The exact change of an evolution (git diff, config diff or extension manifest), the patch-guard findings and the change report. Changes nothing.\nArgs: evolution_id.',
      ),
      input: z.object({ evolution_id: evolutionId }),
      annotations: RO,
      run: async (a, ctx) => ({ status: 'SUCCESS', data: sys(ctx).evolution.diff(String(a.evolution_id)) }),
    },
    {
      id: 'studio_evolution_approve',
      title: 'Evolution / Submit for owner review',
      description: footer(
        'studio_evolution_approve',
        'Submit a tested core evolution for OWNER review. This does NOT approve anything: the owner sees What / Why / Files / Dependencies / Migrations / Security / Cost / Rollback / Tests / Version and decides in the Studio. The approval is bound to the SHA-256 of the exact diff; any later change voids it.\nArgs: evolution_id.\nOutput: the review the owner will see.',
      ),
      input: z.object({ evolution_id: evolutionId }),
      annotations: RO,
      run: async (a, ctx) => ({
        status: 'SUCCESS',
        data: sys(ctx).evolution.requestReview(String(a.evolution_id), actor(ctx)),
      }),
    },
    {
      id: 'studio_evolution_deploy',
      title: 'Evolution / Deploy',
      description: footer(
        'studio_evolution_deploy',
        'Deploy an owner-APPROVED evolution: checkpoint (git tag + data backup) → deploy → health check → verify; any failure reverts automatically. Agents may deploy only LOW/MEDIUM evolutions that touch no protected control; everything else is deployed by the owner. Final status is SUCCESS only when verification passed.\nArgs: evolution_id.',
      ),
      input: z.object({ evolution_id: evolutionId }),
      annotations: RW,
      run: async (a, ctx) => {
        const r = await sys(ctx).evolution.deploy(String(a.evolution_id), actor(ctx));
        return { status: r.status === 'SUCCESS' ? 'SUCCESS' : 'PARTIAL_SUCCESS', data: summary(r) };
      },
    },
    {
      id: 'studio_evolution_rollback',
      title: 'Evolution / Roll back',
      description: footer(
        'studio_evolution_rollback',
        'Roll back a deployed evolution (config → previous version; extension → previous version or disabled; core → revert commits). Audited. Protected evolutions are rolled back by the owner only.\nArgs: evolution_id, reason, approval_id?.',
      ),
      input: z.object({ evolution_id: evolutionId, reason: z.string().min(1).max(2000), approval_id: approvalId }),
      annotations: DESTRUCTIVE,
      impact: (a) => ({
        what: `Roll back evolution ${String(a.evolution_id)}`,
        why: String(a.reason),
        scope: 'The deployed change of that evolution only',
        files: [],
        risk: 'medium',
        rollback: 'Re-deploying the evolution restores it.',
      }),
      run: async (a, ctx) => ({
        status: 'SUCCESS',
        data: summary(sys(ctx).evolution.rollback(String(a.evolution_id), actor(ctx), String(a.reason))),
      }),
    },
    {
      id: 'studio_evolution_history',
      title: 'Evolution / History',
      description: footer(
        'studio_evolution_history',
        'Evolution History: version, date, change, requester, AI/manual, status, tests, approval, rollback. Changes nothing.',
      ),
      input: z.object({}),
      annotations: RO,
      run: async (_a, ctx) => ({ status: 'SUCCESS', data: sys(ctx).evolution.history() }),
    },
    {
      id: 'studio_extension_list',
      title: 'Extensions / List',
      description: footer(
        'studio_extension_list',
        'Installed extensions (version, enabled, permissions, licence, health), Skills, workflows (with versions), providers, and packages waiting in extensions/incoming. Changes nothing.',
      ),
      input: z.object({}),
      annotations: RO,
      run: async (_a, ctx) => {
        const x = sys(ctx).extensions;
        return {
          status: 'SUCCESS',
          data: {
            safe_mode: x.isSafeMode(),
            extensions: x.list(),
            skills: x.skills(),
            workflows: x.workflows().map((w) => ({
              id: w.definition.id,
              version: w.definition.version,
              kind: w.definition.kind,
              versions: w.versions,
              enabled: w.enabled,
              worker_capabilities: w.definition.worker_capabilities,
            })),
            providers: x
              .providers()
              .map((p) => ({
                id: p.definition.id,
                kind: p.definition.kind,
                family: p.definition.family,
                enabled: p.enabled,
              })),
            incoming: x.incoming(),
          },
        };
      },
    },
    installLike('studio_extension_install', 'Extensions / Install', undefined, 'Install an extension.'),
    installLike(
      'studio_extension_update',
      'Extensions / Update',
      undefined,
      'Update an installed extension to the packaged version (the old version is kept for rollback).',
    ),
    installLike('studio_skill_install', 'Skills / Install', 'skill', 'Install a Skill.'),
    installLike('studio_skill_update', 'Skills / Update', 'skill', 'Update a Skill.'),
    installLike(
      'studio_workflow_register',
      'Workflows / Register',
      'workflow',
      'Register a new workflow (or a new version of one).',
    ),
    installLike(
      'studio_provider_register',
      'Providers / Register',
      'provider',
      'Register a provider configured on a built-in adapter family (anthropic, openai-compatible-http, comfyui-http, local-build, filesystem-storage). A new adapter family is a core change.',
    ),
    installLike('studio_provider_update', 'Providers / Update', 'provider', 'Update a provider definition.'),
    {
      id: 'studio_workflow_update',
      title: 'Workflows / Pin or activate',
      description: footer(
        'studio_workflow_update',
        'action="pin": keep a project on a known-good installed workflow version (reversible, audited). action="activate": install/activate the packaged version through an owner-reviewed evolution.\nArgs: action, workflow_id, project_id + version (pin) | package (activate).',
      ),
      input: z.object({
        action: z.enum(['pin', 'activate']),
        workflow_id: z.string().optional(),
        project_id: z.string().optional(),
        version: z.string().optional(),
        package: pkg.optional(),
      }),
      annotations: RW,
      run: async (a, ctx) => {
        const s = sys(ctx);
        if (a.action === 'pin') {
          if (!a.workflow_id || !a.project_id || !a.version)
            throw new StudioFailure(
              studioError(
                'FAILED',
                'INVALID_ARGUMENTS',
                'pin needs workflow_id, project_id and version.',
                'Pass all three.',
              ),
            );
          s.extensions.pinWorkflow(String(a.project_id), String(a.workflow_id), String(a.version));
          ctx.gateway.audit.append('workflow_pinned', ctx.caller, {
            project_id: a.project_id,
            workflow_id: a.workflow_id,
            version: a.version,
          });
          return { status: 'SUCCESS', data: s.extensions.resolveWorkflow(String(a.project_id), String(a.workflow_id)) };
        }
        if (!a.package)
          throw new StudioFailure(
            studioError('FAILED', 'INVALID_ARGUMENTS', 'activate needs package.', 'Pass the package folder name.'),
          );
        const r = await s.evolution.proposeExtension({
          package: String(a.package),
          by: actor(ctx),
          expectKind: 'workflow',
        });
        return { status: r.status === 'AWAITING_APPROVAL' ? 'SUCCESS' : 'PARTIAL_SUCCESS', data: summary(r) };
      },
    },
    {
      id: 'studio_extension_enable',
      title: 'Extensions / Enable',
      description: footer(
        'studio_extension_enable',
        'Re-enable an installed extension with the permissions the owner already granted.\nArgs: name, approval_id?.',
      ),
      input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), approval_id: approvalId }),
      annotations: DESTRUCTIVE,
      impact: (a) => ({
        what: `Enable extension ${String(a.name)}`,
        why: 'Requested by the ModuleX Agent',
        scope: 'That extension, with its previously granted permissions',
        files: [],
        risk: 'medium',
        rollback: 'Disable it again (studio_extension_disable).',
      }),
      run: async (a, ctx) => {
        const e = sys(ctx).extensions.setEnabled(String(a.name), true);
        ctx.gateway.audit.append('extension_enabled', ctx.caller, { name: e.name, version: e.active_version });
        return { status: 'SUCCESS', data: e };
      },
    },
    {
      id: 'studio_extension_disable',
      title: 'Extensions / Disable',
      description: footer(
        'studio_extension_disable',
        'Disable an extension (safe and reversible).\nArgs: name, reason.',
      ),
      input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), reason: z.string().min(1).max(2000) }),
      annotations: RW,
      run: async (a, ctx) => {
        const e = sys(ctx).extensions.setEnabled(String(a.name), false);
        ctx.gateway.audit.append('extension_disabled', ctx.caller, { name: e.name, reason: a.reason });
        return { status: 'SUCCESS', data: e };
      },
    },
    {
      id: 'studio_diagnostics_run',
      title: 'System / Diagnostics',
      description: footer(
        'studio_diagnostics_run',
        'Inspect the Studio itself (Core, Godot connection, MCP server, workers, extensions, configuration, updates, Safe Mode) and recommend repairs. Security repairs are recommendations for the owner only. Changes nothing.',
      ),
      input: z.object({}),
      annotations: RO,
      run: async (_a, ctx) => ({ status: 'SUCCESS', data: await sys(ctx).diagnostics.run(ctx.caller) }),
    },
    {
      id: 'studio_system_repair',
      title: 'System / Repair',
      description: footer(
        'studio_system_repair',
        `Apply one recommended repair after owner approval. Allowed: ${Object.entries(REPAIR_ACTIONS)
          .filter(([, m]) => !m.security)
          .map(([k]) => k)
          .join(', ')}. Security repairs (${Object.entries(REPAIR_ACTIONS)
          .filter(([, m]) => m.security)
          .map(([k]) => k)
          .join(', ')}) are never applied by tools.\nArgs: action, target?, approval_id?.`,
      ),
      input: z.object({
        action: z.enum(Object.keys(REPAIR_ACTIONS) as [RepairAction, ...RepairAction[]]),
        target: z.string().max(200).optional(),
        approval_id: approvalId,
      }),
      annotations: DESTRUCTIVE,
      impact: (a) => ({
        what: `Repair: ${String(a.action)}${a.target ? ` (${String(a.target)})` : ''}`,
        why: 'Recommended by Studio diagnostics',
        scope: 'The named component only',
        files: [],
        risk: REPAIR_ACTIONS[a.action as RepairAction]?.security ? 'critical' : 'low',
        rollback: 'Re-enable / re-activate the previous state from System.',
      }),
      run: async (a, ctx) => {
        if (REPAIR_ACTIONS[a.action as RepairAction].security)
          throw new StudioFailure(
            studioError(
              'BLOCKED',
              'TOOL_NOT_ALLOWED',
              'Security repairs are owner-only.',
              'Ask the owner to do it in the Studio.',
            ),
          );
        return {
          status: 'SUCCESS',
          data: await sys(ctx).diagnostics.repair(
            a.action as RepairAction,
            (a.target as string | undefined) ?? null,
            ctx.caller,
          ),
        };
      },
    },
  ];
}
