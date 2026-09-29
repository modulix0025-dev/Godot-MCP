// SPDX-License-Identifier: Apache-2.0
//
// One live Godot editor session for a project (Phase 4): its own MCP server (token mode), the editor process,
// the GodotCall client and the checkpoint hooks that save/reopen scenes through the editor.
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor } from '../audit/secrets.js';
import { ProjectCheckpoints } from '../checkpoints/project-checkpoints.js';
import type { StudioDb } from '../db/database.js';
import { GodotProcess } from './editor-supervisor.js';
import { GodotClient } from './godot-call.js';
import { ServerSupervisor } from './server-supervisor.js';

export interface GodotSessionOptions {
  projectId: string;
  projectPath: string;
  godot: string;
  serverBinary: string;
  audit: AuditLog;
  redactor: Redactor;
  db?: StudioDb | null;
  headless?: boolean;
  connectTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export class GodotSession {
  readonly server: ServerSupervisor;
  readonly editor: GodotProcess;
  readonly client: GodotClient;
  readonly checkpoints: ProjectCheckpoints;

  constructor(private readonly o: GodotSessionOptions) {
    this.server = new ServerSupervisor({ binary: o.serverBinary, projectPath: o.projectPath });
    o.redactor.register(this.server.token);
    this.editor = new GodotProcess({
      godot: o.godot,
      projectPath: o.projectPath,
      server: this.server,
      mode: 'editor',
      headless: o.headless ?? true,
      onLog: o.onLog,
    });
    this.client = new GodotClient(this.server, {
      audit: o.audit,
      redactor: o.redactor,
      db: o.db,
      session: `editor:${o.projectId}`,
    });
    this.checkpoints = new ProjectCheckpoints(o.projectPath, o.projectId, o.db, {
      beforeCheckpoint: () => this.saveOpenScenes(),
      afterRestore: () => this.reloadAfterRestore(),
    });
  }

  async start(): Promise<void> {
    await this.server.start();
    this.editor.start();
    await this.editor.waitConnected(this.o.connectTimeoutMs ?? 120_000);
    // A crashed-and-restarted server loses the plugin connection until the editor reconnects on its own.
    this.server.on('state', (s) =>
      this.o.audit.append('tool_call_completed', 'studio', { event: 'server_state', state: s }),
    );
  }

  /** Scenes open in the editor (`scene-list-opened`), as res:// paths. */
  async openScenes(): Promise<string[]> {
    const r = await this.client.call({ tool: 'scene-list-opened' });
    const text = JSON.stringify(r.result ?? r.content);
    return [...new Set(text.match(/res:\/\/[^"'\s\\]+\.tscn/g) ?? [])];
  }

  /**
   * Save before a checkpoint. `scene-save` without a path saves the currently EDITED scene back to its own file;
   * with a path it is a save-as of the edited scene, so it must never be called per open scene. Studio edits
   * always target the edited scene, so saving it is sufficient.
   */
  private async saveOpenScenes(): Promise<void> {
    if (!this.editor.running()) return;
    if ((await this.openScenes()).length) await this.client.call({ tool: 'scene-save', args: {} });
  }

  private async reloadAfterRestore(): Promise<void> {
    if (!this.editor.running()) return;
    // New or deleted files need a full scan (D-007); then reopen what was open.
    await this.client.call({ tool: 'filesystem-reimport', args: {} });
    for (const path of await this.openScenes())
      await this.client.call({ tool: 'scene-open', args: { resourcePath: path } });
  }

  async stop(): Promise<void> {
    await this.editor.stop();
    await this.server.stop();
  }
}
