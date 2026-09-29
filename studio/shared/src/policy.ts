// SPDX-License-Identifier: Apache-2.0
//
// Tool catalogue + policy decision (EXECUTION_PROMPT Phase 5, hardened by Execution Patch 1 §2).
//
// Two layers:
//   Layer A "studio" — high-level, Agent-safe tools (`studio_*`). The ONLY layer an agent sees by default.
//   Layer B "raw"    — the real Godot-MCP / ModuleX addon tool ids. Called by Studio Core internally while it
//                      implements a studio tool; exposed to the ModuleX Agent only in Developer Mode, and never
//                      to Claude Desktop.
//
// Hints in the addon's [AiTool] attributes are NOT trusted for tiering (node-delete / resource-delete carry no
// DestructiveHint — DECISIONS D-006), so every tier below is assigned here explicitly.

export type ToolLayer = 'studio' | 'raw';
export type Tier = 'read' | 'write' | 'destructive' | 'cost' | 'critical';
/** Who is calling. `studio-internal` = Core itself; `owner-ui` = the human in the desktop app. */
export type Caller = 'modulex-agent' | 'claude-desktop' | 'studio-internal' | 'owner-ui';
export type DevCapability = 'raw-tools' | 'raw-diagnostics' | 'reflection' | 'server-logs';
export type Role =
  | 'game-director'
  | 'gameplay-engineer'
  | 'level-designer'
  | 'technical-artist'
  | '3d-asset-producer'
  | 'qa'
  | 'build-release'
  | 'studio-maintainer';

export interface ToolSpec {
  id: string;
  layer: ToolLayer;
  tier: Tier;
  /** Exposed through the Claude Desktop extension (safe, high-level subset). */
  claudeDesktop?: boolean;
  /** Implemented by the current Core build. Unimplemented tools are catalogued but never advertised. */
  implemented?: boolean;
  summary: string;
}

const S = (id: string, tier: Tier, summary: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  layer: 'studio',
  tier,
  summary,
  ...extra,
});
const R = (id: string, tier: Tier, summary: string): ToolSpec => ({ id, layer: 'raw', tier, summary });

/** Layer A — Agent-safe studio tools. */
export const STUDIO_TOOLS: ToolSpec[] = [
  S('studio_ping', 'read', 'Health probe of the Studio MCP surface.', { claudeDesktop: true, implemented: true }),
  S('studio_project_list', 'read', 'List Studio projects.', { claudeDesktop: true, implemented: true }),
  S('studio_project_status', 'read', 'Structured status of one project (stage, errors, workers, builds, approvals).', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_project_create', 'write', 'Create a Godot 4.5.1 (.NET) project from the ModuleX template.'),
  S('studio_project_inspect', 'read', 'Inspect scenes/resources/settings of a project.'),
  S(
    'studio_game_create',
    'write',
    'Start a new game: validate + store the Game Specification, then queue the pipeline.',
    {
      claudeDesktop: true,
      implemented: true,
    },
  ),
  S('studio_game_spec_create', 'write', 'Create or replace the Game Specification (game-spec.json).', {
    implemented: true,
  }),
  S('studio_game_spec_get', 'read', 'Read the Game Specification.', { claudeDesktop: true, implemented: true }),
  S('studio_scene_manifest_get', 'read', 'Read the scene manifest.', { claudeDesktop: true, implemented: true }),
  S('studio_asset_manifest_get', 'read', 'Read the asset manifest (incl. provenance).', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_test_manifest_get', 'read', 'Read the test manifest.', { claudeDesktop: true, implemented: true }),
  S('studio_task_graph_get', 'read', 'Read the task graph.', { claudeDesktop: true, implemented: true }),
  S('studio_pipeline_status', 'read', 'Pipeline stages and statuses.', { claudeDesktop: true, implemented: true }),
  S('studio_pipeline_resume', 'write', 'Resume a paused/blocked pipeline run.', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_pipeline_cancel', 'write', 'Cancel a pipeline run.'),
  S('studio_asset_generate', 'cost', 'Generate an asset on a trusted ComfyUI worker (costs GPU time).', {
    claudeDesktop: true,
  }),
  S('studio_asset_import', 'write', 'Validate + import an asset into the Godot project.'),
  S('studio_asset_status', 'read', 'Asset states incl. provenance and license status.', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_asset_delete', 'destructive', 'Delete generated assets (checkpointed; requires owner approval).', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_scene_create', 'write', 'Create a scene from the scene manifest.'),
  S('studio_gameplay_implement', 'write', 'Implement a gameplay system from the spec.'),
  S('studio_project_validate', 'read', 'Static validation (build, scripts, resources).'),
  S('studio_test_run', 'write', 'Run test tiers (static / playtest / visual).', { claudeDesktop: true }),
  S('studio_playtest', 'write', 'Launch a QA playtest session.'),
  S('studio_visual_inspect', 'read', 'Deterministic + advisory visual checks.'),
  S('studio_fix_failure', 'write', 'Bounded, checkpointed fix attempt for a fingerprinted failure.'),
  S('studio_checkpoint_create', 'write', 'Create a git checkpoint.'),
  S('studio_checkpoint_restore', 'destructive', 'Restore a checkpoint (never rewrites history).'),
  S('studio_build', 'write', 'Build for a platform + profile.', { claudeDesktop: true }),
  S('studio_export', 'write', 'Export an artifact for a platform + profile.', { claudeDesktop: true }),
  S('studio_build_status', 'read', 'Build and artifact status (sha256, profile, PREPARED vs SIGNED).', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_worker_status', 'read', 'Worker ids, trust levels and health (never credentials).', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_request_approval', 'read', 'Ask the owner to approve an action (creates a pending approval).', {
    implemented: true,
  }),
  S('studio_approval_list', 'read', 'List pending approvals.', { claudeDesktop: true, implemented: true }),
  S('studio_approval_action', 'read', 'Withdraw your own approval request. Approve/reject is owner-only (Studio UI).', {
    claudeDesktop: true,
    implemented: true,
  }),
  // ---- System Evolution (Execution Patch 2 §30). Approval of an evolution is owner-only (Studio UI); agents can
  // propose, plan, test, diff and REQUEST review. Deploy/rollback/installs always pause for the owner.
  S('studio_system_status', 'read', 'Versions, health, Safe Mode, extensions and the evolution summary.', {
    claudeDesktop: true,
    implemented: true,
  }),
  S('studio_config_get', 'read', 'Read a configuration document (policy, budgets, routing, …) and its version.', {
    implemented: true,
  }),
  S('studio_config_propose', 'write', 'Propose a configuration change (Mode A); the owner approves the exact diff.', {
    implemented: true,
  }),
  S('studio_evolution_propose', 'write', 'Classify a change request and open a System Evolution proposal.', {
    implemented: true,
  }),
  S('studio_evolution_plan', 'write', 'Attach the implementation plan, files and risks to a core evolution.', {
    implemented: true,
  }),
  S('studio_evolution_test', 'write', 'Run the risk-based test gates for an evolution in its sandbox.', {
    implemented: true,
  }),
  S('studio_evolution_diff', 'read', 'The exact diff and change report of an evolution.', { implemented: true }),
  S('studio_evolution_approve', 'read', 'Submit an evolution for OWNER review (you cannot approve it yourself).', {
    implemented: true,
  }),
  S(
    'studio_evolution_deploy',
    'write',
    'Deploy an OWNER-APPROVED evolution (approval bound to its diff): checkpoint, deploy, health check, verify.',
    {
      implemented: true,
    },
  ),
  S('studio_evolution_rollback', 'destructive', 'Roll back a deployed evolution to its checkpoint.', {
    implemented: true,
  }),
  S('studio_evolution_history', 'read', 'Evolution history (version, change, requester, tests, approval, rollback).', {
    implemented: true,
  }),
  S('studio_extension_list', 'read', 'Installed extensions, Skills, workflows and providers.', { implemented: true }),
  S('studio_extension_install', 'write', 'Install an extension package (inspected, sandboxed, owner-approved).', {
    implemented: true,
  }),
  S('studio_extension_enable', 'destructive', 'Enable an installed extension (grants its approved permissions).', {
    implemented: true,
  }),
  S('studio_extension_disable', 'write', 'Disable an extension (a safe, reversible action).', { implemented: true }),
  S('studio_extension_update', 'write', 'Update an extension to a new version (old version kept for rollback).', {
    implemented: true,
  }),
  S('studio_skill_install', 'write', 'Install a Skill (an extension of kind skill).', { implemented: true }),
  S('studio_skill_update', 'write', 'Update a Skill.', { implemented: true }),
  S('studio_workflow_register', 'write', 'Register a new workflow version (validated + test job in sandbox).', {
    implemented: true,
  }),
  S('studio_workflow_update', 'write', 'Activate or pin a workflow version.', { implemented: true }),
  S('studio_provider_register', 'write', 'Register a provider on a built-in adapter family.', {
    implemented: true,
  }),
  S('studio_provider_update', 'write', 'Update a provider definition.', { implemented: true }),
  S('studio_diagnostics_run', 'read', 'Diagnose the Studio itself (Core, Godot, MCP, workers, extensions, config).', {
    implemented: true,
  }),
  S('studio_system_repair', 'destructive', 'Apply a recommended non-security repair (restart, disable extension, …).', {
    implemented: true,
  }),
  S('studio_policy_change', 'critical', 'Change policy (owner UI only).'),
  S('studio_secret_set', 'critical', 'Store a credential (owner UI only).'),
  S('studio_worker_register', 'critical', 'Register/trust a worker (owner UI only).'),
  S('studio_project_delete', 'critical', 'Delete a project (owner UI only).'),
];

/** Layer B — raw engine tools (exact ids verified live: DECISIONS D-006, D-016). */
export const RAW_TOOLS: ToolSpec[] = [
  ...[
    'node-find',
    'scene-get-data',
    'scene-list-opened',
    'resource-find',
    'resource-get-data',
    'filesystem-list',
    'script-read',
    'script-validate',
    'screenshot-viewport',
    'screenshot-camera',
    'screenshot-isolated',
    'editor-application-get-state',
    'editor-selection-get',
    'console-get-logs',
    'runtime-errors-get',
    'reflection-method-find',
    'project-settings-get',
    'project-validate-resources',
    'game-state-get',
    'game-screenshot',
    'game-node-find',
    'game-ui-inspect',
    'game-wait',
  ].map((id) => R(id, 'read', 'raw engine read')),
  ...[
    'node-create',
    'node-modify',
    'node-set-parent',
    'node-reorder',
    'node-duplicate',
    'scene-create',
    'scene-open',
    'scene-save',
    'script-create',
    'script-update',
    'script-attach-to-node',
    'resource-create',
    'resource-modify',
    'filesystem-reimport',
    'editor-selection-set',
    'editor-application-set-state',
    'console-clear-logs',
    'runtime-errors-clear',
    'project-input-action-set',
    'game-input-action',
    'game-scene-change',
    'game-quit',
  ].map((id) => R(id, 'write', 'raw engine write')),
  ...[
    'node-delete',
    'resource-delete',
    'script-delete',
    'resource-move',
    'project-settings-set',
    'project-autoload-set',
  ].map((id) => R(id, 'destructive', 'raw engine destructive')),
  ...['reflection-method-call', 'godot-skill-create', 'godot-skill-generate'].map((id) =>
    R(id, 'critical', 'arbitrary code execution / code generation'),
  ),
];

export const TOOL_CATALOG: ReadonlyMap<string, ToolSpec> = new Map(
  [...STUDIO_TOOLS, ...RAW_TOOLS].map((t) => [t.id, t]),
);

/** Role allowlists for the ModuleX Agent (Phase 5). Studio-layer only; `*` = every read tool. */
export const ROLE_TOOLS: Record<Role, string[]> = {
  'game-director': [
    'studio_project_',
    'studio_game_',
    'studio_pipeline_',
    'studio_request_approval',
    'studio_approval_',
  ],
  'gameplay-engineer': [
    'studio_scene_',
    'studio_gameplay_',
    'studio_project_validate',
    'studio_checkpoint_',
    'studio_fix_failure',
    'studio_playtest',
  ],
  'level-designer': ['studio_scene_', 'studio_checkpoint_create'],
  'technical-artist': ['studio_asset_import', 'studio_asset_status', 'studio_visual_inspect'],
  '3d-asset-producer': ['studio_asset_'],
  qa: ['studio_test_', 'studio_playtest', 'studio_visual_inspect', 'studio_fix_failure'],
  'build-release': ['studio_build', 'studio_export'],
  'studio-maintainer': [
    'studio_config_',
    'studio_evolution_',
    'studio_extension_',
    'studio_skill_',
    'studio_workflow_',
    'studio_provider_',
    'studio_system_',
    'studio_diagnostics_',
  ],
};

/**
 * Tools whose approval can never be relaxed by configuration or "always allow" (Execution Patch 2 §33): the
 * controls that govern how the Studio changes itself.
 */
export const PROTECTED_TOOL_PREFIXES = [
  'studio_evolution_',
  'studio_extension_',
  'studio_skill_',
  'studio_workflow_',
  'studio_provider_',
  'studio_system_repair',
  'studio_config_',
] as const;
export const isProtectedTool = (toolId: string): boolean => PROTECTED_TOOL_PREFIXES.some((p) => toolId.startsWith(p));

export interface DevModeState {
  enabled: boolean;
  capabilities: DevCapability[];
}

export const DEV_MODE_OFF: DevModeState = { enabled: false, capabilities: [] };

export interface PolicyContext {
  caller: Caller;
  role?: Role;
  devMode: DevModeState;
  /** Owner "always allow for this project" overrides (studio-layer destructive tools only). */
  alwaysAllow?: ReadonlySet<string>;
  /** Estimated cost of this call in USD (for `cost` tier tools). */
  estimatedCostUsd?: number;
  /** Per-call cost threshold above which a `cost` tool needs approval. */
  costThresholdUsd?: number;
  /** Approved approval id carried by a studio-internal destructive raw call. */
  approvalId?: string;
}

export type Decision =
  | { effect: 'allow'; tier: Tier; checkpoint: boolean }
  | { effect: 'ask'; tier: Tier; reason: string }
  | {
      effect: 'deny';
      tier: Tier | null;
      code: 'TOOL_UNKNOWN' | 'TOOL_NOT_ALLOWED' | 'TOOL_DISABLED' | 'DEVELOPER_MODE_REQUIRED';
      reason: string;
    };

const allow = (tier: Tier): Decision => ({
  effect: 'allow',
  tier,
  checkpoint: tier === 'write' || tier === 'destructive',
});

/**
 * The single policy decision. Pure and total: every (tool, context) pair maps to allow / ask / deny.
 * Table-driven tests cover every catalogue entry × caller × dev-mode state (security.test.ts).
 */
export function decide(toolId: string, ctx: PolicyContext): Decision {
  const spec = TOOL_CATALOG.get(toolId);
  if (!spec) return { effect: 'deny', tier: null, code: 'TOOL_UNKNOWN', reason: `Unknown tool '${toolId}'.` };
  const { tier } = spec;

  if (ctx.caller === 'owner-ui') {
    // The human at the keyboard: everything is possible, but critical actions still get a confirm dialog.
    return tier === 'critical'
      ? { effect: 'ask', tier, reason: 'Critical action — confirm in the Studio.' }
      : allow(tier);
  }

  if (ctx.caller === 'studio-internal') {
    if (tier === 'critical') {
      return ctx.devMode.enabled && ctx.devMode.capabilities.includes('reflection')
        ? { effect: 'ask', tier, reason: 'Reflection/code generation — every call needs owner confirmation.' }
        : { effect: 'deny', tier, code: 'TOOL_DISABLED', reason: `'${toolId}' is disabled (critical tier).` };
    }
    if (tier === 'destructive' && !ctx.approvalId) {
      return { effect: 'ask', tier, reason: 'Destructive engine operation without an approved studio action.' };
    }
    return allow(tier);
  }

  // Agent callers: modulex-agent and claude-desktop.
  if (spec.layer === 'raw') {
    if (ctx.caller === 'claude-desktop') {
      return {
        effect: 'deny',
        tier,
        code: 'TOOL_NOT_ALLOWED',
        reason: 'Raw engine tools are never exposed to Claude Desktop.',
      };
    }
    if (!ctx.devMode.enabled || !ctx.devMode.capabilities.includes('raw-tools')) {
      return {
        effect: 'deny',
        tier,
        code: 'DEVELOPER_MODE_REQUIRED',
        reason: `'${toolId}' is a raw engine tool; enable Developer Mode (raw tools) in the Studio to use it.`,
      };
    }
    if (tier === 'critical') {
      return ctx.devMode.capabilities.includes('reflection')
        ? { effect: 'ask', tier, reason: 'Reflection/code generation — every call needs owner confirmation.' }
        : {
            effect: 'deny',
            tier,
            code: 'DEVELOPER_MODE_REQUIRED',
            reason: `'${toolId}' needs the elevated 'reflection' capability.`,
          };
    }
    if (tier === 'destructive') return { effect: 'ask', tier, reason: 'Destructive raw tool (Developer Mode).' };
    return allow(tier);
  }

  // Studio layer.
  if (ctx.caller === 'claude-desktop' && !spec.claudeDesktop) {
    return {
      effect: 'deny',
      tier,
      code: 'TOOL_NOT_ALLOWED',
      reason: `'${toolId}' is not part of the Claude Desktop tool set.`,
    };
  }
  if (tier === 'critical') {
    return {
      effect: 'deny',
      tier,
      code: 'TOOL_NOT_ALLOWED',
      reason: `'${toolId}' can only be performed by the owner in the Studio UI.`,
    };
  }
  if (ctx.caller === 'modulex-agent' && ctx.role && !roleAllows(ctx.role, toolId, tier)) {
    return { effect: 'deny', tier, code: 'TOOL_NOT_ALLOWED', reason: `Role '${ctx.role}' may not call '${toolId}'.` };
  }
  if (tier === 'destructive') {
    // "Always allow" overrides apply to the ModuleX Agent only — never to Claude Desktop — and never to the
    // protected System Evolution / extension tools.
    return ctx.caller === 'modulex-agent' && !isProtectedTool(toolId) && ctx.alwaysAllow?.has(toolId)
      ? allow(tier)
      : { effect: 'ask', tier, reason: 'Destructive action — owner approval required.' };
  }
  if (tier === 'cost') {
    const cost = ctx.estimatedCostUsd;
    const threshold = ctx.costThresholdUsd ?? 0.25;
    if (ctx.caller === 'modulex-agent' && ctx.alwaysAllow?.has(toolId)) return allow(tier);
    if (cost === undefined) return { effect: 'ask', tier, reason: 'Cost unknown — owner approval required.' };
    return cost > threshold
      ? { effect: 'ask', tier, reason: `Estimated $${cost.toFixed(2)} exceeds the $${threshold.toFixed(2)} threshold.` }
      : allow(tier);
  }
  return allow(tier);
}

function roleAllows(role: Role, toolId: string, tier: Tier): boolean {
  if (tier === 'read') return true; // every role may read
  return ROLE_TOOLS[role].some((p) => (p.endsWith('_') ? toolId.startsWith(p) : toolId === p));
}

/** Tools advertised in `tools/list` for a caller (implemented + policy may ever allow them). */
export function advertisedTools(caller: 'modulex-agent' | 'claude-desktop', devMode: DevModeState): ToolSpec[] {
  const studio = STUDIO_TOOLS.filter(
    (t) => t.implemented && t.tier !== 'critical' && (caller !== 'claude-desktop' || t.claudeDesktop),
  );
  if (caller === 'modulex-agent' && devMode.enabled && devMode.capabilities.includes('raw-tools')) {
    return [
      ...studio,
      ...RAW_TOOLS.filter((t) => t.tier !== 'critical' || devMode.capabilities.includes('reflection')),
    ];
  }
  return studio;
}
