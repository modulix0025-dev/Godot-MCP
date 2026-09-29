// SPDX-License-Identifier: Apache-2.0
//
// Self-diagnostics and repair (Execution Patch 2 §24): Inspect → Diagnose → Recommend → Repair (if authorized) →
// Verify. Repairs that touch security (credentials, network exposure, policy, worker authentication) are never
// applied here: they are reported with the owner action to take.
import { CONFIG_DOCS, REPAIR_ACTIONS, type ConfigDocId, type RepairAction } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { StudioStore } from '../store/studio-store.js';
import type { ConfigStore } from './config-store.js';
import type { ExtensionRegistry } from './extension-registry.js';
import type { UpdateManager } from './updates.js';

export interface Probe {
  (): Promise<{ ok: boolean; detail: string }>;
}

export interface Finding {
  check: 'core' | 'godot' | 'mcp_server' | 'workers' | 'extensions' | 'config' | 'updates' | 'safe_mode';
  status: 'ok' | 'warning' | 'error' | 'unknown';
  detail: string;
  recommendation: {
    action: RepairAction;
    target: string | null;
    automatic: boolean;
    security: boolean;
    note: string;
  } | null;
}

export interface DiagnosticsDeps {
  audit: AuditLog;
  store: StudioStore;
  config: ConfigStore;
  extensions: ExtensionRegistry;
  updates?: UpdateManager;
  probes?: { godot?: Probe; mcp_server?: Probe };
  hooks?: {
    restartCore?: () => Promise<void>;
    restartGodotServer?: () => Promise<void>;
    rebuildConnectionConfig?: () => Promise<void>;
  };
}

const rec = (action: RepairAction, target: string | null, note: string) => ({
  action,
  target,
  automatic: REPAIR_ACTIONS[action].automatic,
  security: REPAIR_ACTIONS[action].security,
  note,
});

export class Diagnostics {
  constructor(private readonly d: DiagnosticsDeps) {}

  async run(actor: string): Promise<Finding[]> {
    const f: Finding[] = [
      { check: 'core', status: 'ok', detail: `Studio Core running (pid ${process.pid})`, recommendation: null },
    ];

    for (const [check, probe] of [
      ['godot', this.d.probes?.godot],
      ['mcp_server', this.d.probes?.mcp_server],
    ] as const) {
      if (!probe) {
        f.push({
          check,
          status: 'unknown',
          detail: 'no probe configured in this build (Phase 4 Godot manager)',
          recommendation: null,
        });
        continue;
      }
      const r = await probe().catch((e: unknown) => ({ ok: false, detail: String(e) }));
      f.push({
        check,
        status: r.ok ? 'ok' : 'error',
        detail: r.detail,
        recommendation: r.ok
          ? null
          : check === 'godot'
            ? rec(
                'rebuild_connection_config',
                null,
                'Regenerate the Godot connection settings (GODOT_MCP_* env, token) and reconnect.',
              )
            : rec('restart_godot_server', null, 'Restart the local MCP server for this project.'),
      });
    }

    for (const id of Object.keys(CONFIG_DOCS) as ConfigDocId[]) {
      const ok = CONFIG_DOCS[id].schema.safeParse(this.d.config.get(id).value).success;
      if (!ok)
        f.push({
          check: 'config',
          status: 'error',
          detail: `${id} is invalid`,
          recommendation: CONFIG_DOCS[id].security
            ? rec(
                'change_policy',
                id,
                'Security configuration: restore a previous version yourself in System → Versions.',
              )
            : rec('rebuild_connection_config', id, `Restore the last valid version of ${id}.`),
        });
    }
    if (!f.some((x) => x.check === 'config'))
      f.push({ check: 'config', status: 'ok', detail: 'all configuration documents valid', recommendation: null });

    for (const e of this.d.extensions.list().filter((x) => x.enabled)) {
      const problems = this.d.extensions.verify(e.name);
      if (problems.length)
        f.push({
          check: 'extensions',
          status: 'error',
          detail: `${e.name} ${e.active_version}: ${problems[0]}`,
          recommendation: rec(
            'disable_extension',
            e.name,
            'Disable it, then roll back to the previous version or reinstall.',
          ),
        });
    }
    if (!f.some((x) => x.check === 'extensions'))
      f.push({ check: 'extensions', status: 'ok', detail: 'all enabled extensions verified', recommendation: null });

    for (const w of this.d.store.listWorkers()) {
      if (w.trust === 'QUARANTINED' || w.trust === 'OFFLINE')
        f.push({
          check: 'workers',
          status: 'warning',
          detail: `${w.worker_id} is ${w.trust}`,
          recommendation: {
            action: 'change_network_exposure',
            target: w.worker_id,
            automatic: false,
            security: true,
            note: 'Worker authentication/trust is owner-controlled: inspect it in Workers, fix the cause, then re-enable.',
          },
        });
    }

    const st = this.d.updates?.getState();
    if (st?.pending_health_check)
      f.push({
        check: 'updates',
        status: 'error',
        detail: `version ${st.current} never passed its health check`,
        recommendation: rec('enter_safe_mode', null, 'Start in Safe Mode and roll back the update.'),
      });
    if (this.d.extensions.isSafeMode())
      f.push({
        check: 'safe_mode',
        status: 'warning',
        detail: 'Safe Mode is active: non-core extensions are disabled',
        recommendation: null,
      });

    this.d.audit.append('diagnostics_run', actor, {
      errors: f.filter((x) => x.status === 'error').length,
      warnings: f.filter((x) => x.status === 'warning').length,
    });
    return f;
  }

  /** Apply one non-security repair. The caller (gateway approval or owner UI) has already authorized it. */
  async repair(
    action: RepairAction,
    target: string | null,
    actor: string,
  ): Promise<{ applied: boolean; detail: string }> {
    const meta = REPAIR_ACTIONS[action];
    if (meta.security)
      return {
        applied: false,
        detail: 'Security-critical repair: never applied automatically. Do it yourself in the Studio.',
      };
    let detail: string;
    switch (action) {
      case 'disable_extension':
        if (!target) throw new Error('target extension required');
        this.d.extensions.setEnabled(target, false);
        this.d.audit.append('extension_disabled', actor, { name: target, reason: 'repair' });
        detail = `${target} disabled`;
        break;
      case 'enter_safe_mode':
        this.d.extensions.setSafeMode(true);
        this.d.audit.append('safe_mode_entered', actor, { reasons: ['repair'] });
        detail = 'Safe Mode on';
        break;
      case 'restore_workflow_version': {
        if (!target) throw new Error('target extension required');
        const prev = this.d.extensions.previousVersion(target);
        if (!prev) return { applied: false, detail: `${target} has no previous version` };
        this.d.extensions.activate(target, prev);
        this.d.audit.append('extension_rolled_back', actor, { name: target, to: prev, reason: 'repair' });
        detail = `${target} → ${prev}`;
        break;
      }
      case 'restart_core':
      case 'restart_godot_server':
      case 'rebuild_connection_config': {
        const hook =
          action === 'restart_core'
            ? this.d.hooks?.restartCore
            : action === 'restart_godot_server'
              ? this.d.hooks?.restartGodotServer
              : this.d.hooks?.rebuildConnectionConfig;
        if (!hook) return { applied: false, detail: `${action} is not available in this build` };
        await hook();
        detail = `${action} done`;
        break;
      }
      default:
        return { applied: false, detail: `${action} is not a repair this build performs` };
    }
    this.d.audit.append('repair_applied', actor, { action, target });
    return { applied: true, detail };
  }
}
