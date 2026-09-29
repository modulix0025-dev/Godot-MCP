// SPDX-License-Identifier: Apache-2.0
//
// The System section's services, wired once per Core process (Execution Patch 2 §31): versioned configuration,
// the extension/Skill/workflow/provider registry, the update manager + Safe Mode, diagnostics and the System
// Evolution service. Layout under the data directory (%LOCALAPPDATA%\ModuleXGameStudio):
//
//   config.json             versioned configuration documents
//   extensions/             registry.json, <name>/<version>/…, incoming/<package>/ (owner drop folder)
//   evolution/              history.json, evo_<id>/{worktree,extension,backup,test-output}
//   install-state.json      current / previous / last-known-good versions, boot + update history
import { join } from 'node:path';
import { PolicyConfigSchema, type PolicyConfig, type VersionSet } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor } from '../audit/secrets.js';
import type { StudioStore } from '../store/studio-store.js';
import { ConfigStore } from './config-store.js';
import { Diagnostics, type DiagnosticsDeps } from './diagnostics.js';
import { EvolutionService, type SourceWorkspace, type WorkflowTester } from './evolution-service.js';
import { ExtensionRegistry } from './extension-registry.js';
import { UpdateManager } from './updates.js';

export interface SystemOptions {
  dataDir: string;
  studioVersion: string;
  versions: VersionSet;
  audit: AuditLog;
  redactor: Redactor;
  store: StudioStore;
  source?: SourceWorkspace;
  workflowTester?: WorkflowTester;
  probes?: DiagnosticsDeps['probes'];
  hooks?: DiagnosticsDeps['hooks'];
  /** Start in Safe Mode regardless of the install state (shell flag MODULEX_SAFE_MODE=1). */
  forceSafeMode?: boolean;
  now?: () => Date;
}

export interface SystemServices {
  config: ConfigStore;
  extensions: ExtensionRegistry;
  updates: UpdateManager;
  diagnostics: Diagnostics;
  evolution: EvolutionService;
  versions: VersionSet;
  safeMode: { active: boolean; reasons: string[] };
  policy(): PolicyConfig;
  status(): Record<string, unknown>;
}

export function createSystem(o: SystemOptions): SystemServices {
  const configPath = join(o.dataDir, 'config.json');
  const config = new ConfigStore(configPath, o.now);
  const extensions = new ExtensionRegistry(join(o.dataDir, 'extensions'), o.now);
  const updates = new UpdateManager(join(o.dataDir, 'install-state.json'), o.studioVersion, o.audit, o.now);
  const boot = updates.boot(o.forceSafeMode === true);
  const safeMode = { active: boot.mode === 'safe', reasons: boot.mode === 'safe' ? boot.reasons : [] };
  extensions.setSafeMode(safeMode.active);
  const diagnostics = new Diagnostics({
    audit: o.audit,
    store: o.store,
    config,
    extensions,
    updates,
    probes: o.probes,
    hooks: o.hooks,
  });
  const evolution = new EvolutionService({
    dataDir: o.dataDir,
    studioVersion: o.studioVersion,
    audit: o.audit,
    redactor: o.redactor,
    config,
    configPath,
    extensions,
    store: o.store,
    updates,
    source: o.source,
    workflowTester: o.workflowTester,
    onConfigApplied: (doc) =>
      doc === 'policy'
        ? PolicyConfigSchema.safeParse(config.get('policy').value).success
          ? []
          : ['policy did not reload']
        : [],
    now: o.now,
  });
  const sys: SystemServices = {
    config,
    extensions,
    updates,
    diagnostics,
    evolution,
    versions: o.versions,
    safeMode,
    policy: () => PolicyConfigSchema.parse(config.get('policy').value),
    status: () => {
      const st = updates.getState();
      const list = extensions.list();
      const hist = evolution.history();
      return {
        versions: o.versions,
        install: {
          current: st.current,
          previous: st.previous,
          last_known_good: st.last_known_good,
          pending_health_check: st.pending_health_check,
        },
        safe_mode: sys.safeMode,
        update_channel: (config.get('update_settings').value as { channel: string }).channel,
        extensions: {
          installed: list.length,
          enabled: list.filter((e) => e.effective_enabled).length,
          failing: list.filter((e) => e.health === 'failing').map((e) => e.name),
        },
        skills: extensions.skills().length,
        workflows: extensions.workflows().map((w) => `${w.definition.id}@${w.definition.version}`),
        providers: extensions.providers().map((p) => `${p.definition.id} (${p.definition.family})`),
        evolutions: {
          total: hist.length,
          awaiting_approval: hist.filter((h) => h.status === 'AWAITING_APPROVAL').length,
          last: hist[0] ?? null,
        },
        config_versions: Object.fromEntries(
          (['policy', 'budgets', 'llm_routing', 'update_settings'] as const).map((d) => [d, config.get(d).version]),
        ),
        core_source_workspace: o.source ? 'configured' : 'not configured (core evolutions are BLOCKED)',
      };
    },
  };
  return sys;
}
