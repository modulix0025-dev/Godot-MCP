// SPDX-License-Identifier: Apache-2.0
//
// Playtest tier (Phase 9). Starts a PLAYTEST server (its own port + token), launches the game with MODULEX_QA=1 so
// the ModulexQa autoload connects the in-game runtime, waits for "[ModuleX-QA] connected" + a ping, then runs
// scenarios. After every step it polls runtime-errors-get from the last sequence — any error fails the step — and
// checks the frame counter (no advance for 5 s = hang). The process exiting mid-run is a crash.
//
// The game runs windowed when a display exists (screenshots need a GPU); headless otherwise, and screenshot steps
// are then reported as skipped, never as passed.
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor } from '../audit/secrets.js';
import type { StudioDb } from '../db/database.js';
import { GodotProcess } from '../godot/editor-supervisor.js';
import { GodotClient, type GodotToolResult } from '../godot/godot-call.js';
import { ServerSupervisor } from '../godot/server-supervisor.js';
import { pixelVariance } from '../assets/godot-import.js';
import { classifyGodotMessage, makeFailure, topFrame, type QaFailure } from './failures.js';
import type { Assertion, Scenario, Step } from './scenarios.js';

export interface PlaytestOptions {
  godot: string;
  serverBinary: string;
  projectDir: string;
  audit: AuditLog;
  redactor: Redactor;
  db?: StudioDb | null;
  windowed?: boolean;
  connectTimeoutMs?: number;
  hangMs?: number;
  /** Run an exported debug build instead of the project (Windows smoke test, Phase 10). */
  exportedExecutable?: string;
}

export interface StepResult {
  scenario: string;
  index: number;
  op: Step['op'];
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

export interface ScenarioResult {
  id: string;
  status: 'passed' | 'failed';
  steps: StepResult[];
  failures: QaFailure[];
  ms: number;
}

interface GameState {
  currentScene: string | null;
  frame: number;
  paused: boolean;
  playerFound: boolean;
  playerGlobalPosition: number[] | null;
  nodeCount: number;
}

export class PlaytestSession {
  readonly server: ServerSupervisor;
  readonly game: GodotProcess;
  readonly client: GodotClient;
  readonly log: string[] = [];
  private errSeq = 0;
  private lastFrame = { frame: -1, at: Date.now() };

  constructor(private readonly o: PlaytestOptions) {
    this.server = new ServerSupervisor({ binary: o.serverBinary, projectPath: `${o.projectDir}#playtest` });
    o.redactor.register(this.server.token);
    this.game = new GodotProcess({
      godot: o.exportedExecutable ?? o.godot,
      exported: Boolean(o.exportedExecutable),
      projectPath: o.projectDir,
      server: this.server,
      mode: 'game',
      headless: !o.windowed,
      extraEnv: { MODULEX_QA: '1' },
      onLog: (l) => this.log.push(l),
    });
    this.client = new GodotClient(this.server, { audit: o.audit, redactor: o.redactor, db: o.db, session: 'playtest' });
  }

  async start(): Promise<void> {
    await this.server.start();
    this.game.start();
    const end = Date.now() + (this.o.connectTimeoutMs ?? 120_000);
    while (Date.now() < end) {
      const status = this.log.find((l) => l.includes('[ModuleX-QA]'));
      if (status?.includes('connected')) break;
      if (status && /disabled|failed/.test(status)) throw new Error(`QA runtime did not connect: ${status}`);
      if (!this.game.running() && this.game.exitCode !== null)
        throw new Error(`game exited with ${this.game.exitCode} before connecting`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.game.waitConnected(30_000);
  }

  async stop(): Promise<void> {
    if (this.game.running()) {
      await this.client.call({ tool: 'game-quit', args: { exitCode: 0 }, role: 'qa' }).catch(() => undefined);
      for (let i = 0; i < 20 && this.game.running(); i++) await new Promise((r) => setTimeout(r, 250));
    }
    await this.game.stop();
    await this.server.stop();
  }

  private async tool(tool: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<GodotToolResult> {
    return this.client.call({ tool, args, role: 'qa', timeoutMs });
  }

  private async state(): Promise<GameState> {
    const r = await this.tool('game-state-get');
    return r.result as GameState;
  }

  /** New runtime errors since the last poll, as classified failures (warnings are ignored). */
  async newErrors(source: string): Promise<QaFailure[]> {
    const r = await this.tool('runtime-errors-get', { sinceSequence: this.errSeq });
    const res = (r.result ?? {}) as {
      highestSequence?: number;
      errors?: {
        sequence: number;
        message: string;
        type: string;
        file?: string;
        line?: number;
        frames?: { file?: string; line?: number }[];
      }[];
    };
    this.errSeq = Math.max(this.errSeq, res.highestSequence ?? 0);
    return (res.errors ?? [])
      .filter((e) => !/^warning$/i.test(e.type))
      .map((e) => {
        const frame =
          e.frames?.find((f) => f.file?.startsWith('res://')) ??
          (e.file ? { file: e.file, line: e.line } : topFrame(e.message));
        return makeFailure(classifyGodotMessage(e.message), e.message, source, frame.file ?? null, frame.line ?? null);
      });
  }

  private evaluate(
    a: Assertion,
    st: GameState,
    mark: number[] | null,
    extra: { nodes?: number; uiOk?: boolean; uiDetail?: string },
  ): { ok: boolean; detail: string } {
    if (a.kind === 'state') {
      const actual =
        a.field === 'playerY'
          ? (st.playerGlobalPosition?.[1] ?? Number.NaN)
          : (st as unknown as Record<string, unknown>)[a.field];
      const ok =
        a.op === 'eq'
          ? actual === a.value
          : a.op === 'ne'
            ? actual !== a.value
            : a.op === 'gt'
              ? Number(actual) > Number(a.value)
              : Number(actual) < Number(a.value);
      return { ok, detail: `${a.field}=${JSON.stringify(actual)} ${a.op} ${JSON.stringify(a.value)}` };
    }
    if (a.kind === 'player_moved') {
      const p = st.playerGlobalPosition;
      if (!mark || !p) return { ok: false, detail: 'no player position (mark missing or player absent)' };
      const d = Math.hypot(p[0]! - mark[0]!, p[2]! - mark[2]!);
      return { ok: d >= a.min, detail: `moved ${d.toFixed(3)} (min ${a.min})` };
    }
    if (a.kind === 'node')
      return { ok: (extra.nodes ?? 0) >= a.min, detail: `${extra.nodes ?? 0} node(s) (min ${a.min})` };
    return { ok: extra.uiOk === true, detail: extra.uiDetail ?? '' };
  }

  async runScenario(sc: Scenario): Promise<ScenarioResult> {
    const t = Date.now();
    const steps: StepResult[] = [];
    const failures: QaFailure[] = [];
    let mark: number[] | null = null;
    await this.newErrors(`${sc.id}:setup`); // drop errors from before this scenario
    this.lastFrame = { frame: -1, at: Date.now() };
    for (const [index, step] of sc.steps.entries()) {
      const src = `${sc.id}#${index} ${step.op}`;
      const push = (status: StepResult['status'], detail: string) =>
        steps.push({ scenario: sc.id, index, op: step.op, status, detail });
      if (!this.game.running()) {
        failures.push(makeFailure('crash', `game process exited with code ${this.game.exitCode}`, src));
        push('failed', 'game not running');
        break;
      }
      let ok = true;
      let detail = '';
      try {
        if (step.op === 'wait') {
          const r = await this.tool('game-wait', {
            frames: step.frames,
            seconds: step.seconds,
            untilSignal: step.untilSignal,
            untilNodePath: step.untilNodePath,
            pressAction: step.pressAction,
          });
          const satisfied = (r.result as { satisfied?: boolean } | null)?.satisfied === true;
          ok = r.ok && satisfied;
          detail = r.ok ? `satisfied=${satisfied}` : GodotClient.text(r);
          if (!ok)
            failures.push(
              makeFailure('gameplay_assertion', `wait not satisfied: ${JSON.stringify(step)} ${detail}`, src),
            );
        } else if (step.op === 'input') {
          const r = await this.tool('game-input-action', { action: step.action, holdFrames: step.frames });
          ok = r.ok;
          detail = r.ok ? 'held and released' : GodotClient.text(r);
          if (!ok) failures.push(makeFailure('gameplay_assertion', `input ${step.action} refused: ${detail}`, src));
        } else if (step.op === 'mark') {
          mark = (await this.state()).playerGlobalPosition;
          detail = `mark ${JSON.stringify(mark)}`;
        } else if (step.op === 'scene-change') {
          const r = await this.tool('game-scene-change', { scenePath: step.scene });
          ok = r.ok;
          detail = r.ok ? step.scene : GodotClient.text(r);
          if (!ok)
            failures.push(makeFailure('missing_resource', `scene-change ${step.scene}: ${detail}`, src, step.scene));
        } else if (step.op === 'screenshot') {
          if (!this.o.windowed) {
            push('skipped', 'headless run: no GPU render');
            continue;
          }
          const r = await this.tool('game-screenshot');
          const img = r.content.find((c) => c.type === 'image' && c.data);
          const variance = img?.data ? pixelVariance(Buffer.from(img.data, 'base64')) : 0;
          ok = step.check === 'none' || variance >= 4;
          detail = `luminance variance ${variance.toFixed(1)}`;
          if (!ok)
            failures.push(
              makeFailure('visual_regression', `screenshot is blank (variance ${variance.toFixed(1)})`, src),
            );
        } else {
          const a = step.assert;
          const deadline = Date.now() + (step.op === 'await' ? step.timeout_s * 1000 : 0);
          let res: { ok: boolean; detail: string };
          for (;;) {
            const st = await this.state();
            const extra: { nodes?: number; uiOk?: boolean; uiDetail?: string } = {};
            if (a.kind === 'node') {
              const r = await this.tool('game-node-find', { group: a.group, type: a.type, path: a.path });
              extra.nodes = (r.result as { count?: number } | null)?.count ?? 0;
            } else if (a.kind === 'ui_ok') {
              const r = await this.tool('game-ui-inspect');
              const u = (r.result ?? {}) as {
                ok?: boolean;
                interactiveOverlaps?: unknown[];
                outsideViewport?: string[];
              };
              extra.uiOk = u.ok === true;
              extra.uiDetail = `overlaps ${u.interactiveOverlaps?.length ?? '?'}, outside viewport ${u.outsideViewport?.length ?? '?'}`;
            }
            res = this.evaluate(a, st, mark, extra);
            if (res.ok || Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          ok = res.ok;
          detail = res.detail;
          if (!ok)
            failures.push(
              makeFailure(
                a.kind === 'ui_ok' ? 'visual_regression' : 'gameplay_assertion',
                `assert ${JSON.stringify(a)} failed: ${detail}`,
                src,
              ),
            );
        }
      } catch (e) {
        ok = false;
        detail = (e as Error).message;
        failures.push(makeFailure(this.game.running() ? 'infra' : 'crash', detail, src));
      }
      // Any runtime error during the step fails it.
      const errs = await this.newErrors(src).catch(() => [] as QaFailure[]);
      if (errs.length) {
        ok = false;
        failures.push(...errs);
        detail += `; ${errs.length} runtime error(s): ${errs[0]!.message.slice(0, 160)}`;
      }
      // Hang detection: the frame counter must advance.
      const st = await this.state().catch(() => null);
      if (st) {
        if (st.frame !== this.lastFrame.frame) this.lastFrame = { frame: st.frame, at: Date.now() };
        else if (Date.now() - this.lastFrame.at > (this.o.hangMs ?? 5000)) {
          ok = false;
          failures.push(
            makeFailure(
              'hang',
              `frame counter stuck at ${st.frame} for more than ${(this.o.hangMs ?? 5000) / 1000}s`,
              src,
            ),
          );
        }
      }
      push(ok ? 'passed' : 'failed', detail);
      if (!ok) break;
    }
    return { id: sc.id, status: failures.length ? 'failed' : 'passed', steps, failures, ms: Date.now() - t };
  }
}
