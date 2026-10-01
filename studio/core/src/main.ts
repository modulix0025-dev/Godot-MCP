// SPDX-License-Identifier: Apache-2.0
//
// `modulex-core` executable entry (bundled to dist/modulex-core.mjs and run by the Tauri shell's bundled Node
// sidecar). Prints the handshake line, then serves until stdin closes (the shell exiting or killing us closes the
// pipe) or a termination signal arrives.
//
// Environment (all optional, provided by the shell):
//   MODULEX_CORE_PORT               loopback port; default 47821 (the Claude Desktop extension's default URL).
//                                   If it is taken, Core falls back to a random port and reports it in the
//                                   handshake; the UI then shows "Claude Desktop: re-verify connection".
//   MODULEX_AGENT_TOKEN             stable ModuleX Agent credential (from Credential Manager)
//   MODULEX_CLAUDE_DESKTOP_TOKEN    stable Claude Desktop pairing credential (from Credential Manager)
//   MODULEX_DATA_DIR                %LOCALAPPDATA%\ModuleXGameStudio (audit log, store, config, extensions,
//                                   evolution sandboxes, install state)
//   MODULEX_SAFE_MODE=1             start in Safe Mode (the shell sets it after repeated failed starts)
//   MODULEX_SOURCE_REPO             a git checkout of the Studio source whose checked-out branch is the
//                                   production branch for core evolutions (developer installs). Unset → core
//                                   evolutions report BLOCKED; config and extension evolutions still work.
//   MODULEX_GODOT                   verified Godot 4.5.1 .NET binary (Setup Assistant). With MODULEX_PROJECTS_ROOT
//   MODULEX_PROJECTS_ROOT           and MODULEX_ADDONS_SOURCE it enables the pipeline engine; unset → games are
//   MODULEX_ADDONS_SOURCE           planned only (PIPELINE_ENGINE_UNAVAILABLE).
//   MODULEX_ANDROID_SDK             Android SDK root; unset → Android builds report BLOCKED.
//   MODULEX_SERVER                  verified gamedev-mcp-server binary; enables the QA tier (scripted playtest on
//                                   its own playtest server + the fix loop). Unset → boot-only playtest
//                                   (PARTIAL_SUCCESS, reason recorded).
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StudioDb } from './db/database.js';
import { startCore, type CoreOptions } from './server.js';
import { STUDIO_REPO_GATES } from './evolution/test-runner.js';
import type { SourceWorkspace } from './evolution/evolution-service.js';

export const DEFAULT_CORE_PORT = 47821;

const env = process.env;
const dataDir = env.MODULEX_DATA_DIR;

function sourceWorkspace(repo: string | undefined): SourceWorkspace | undefined {
  if (!repo) return undefined;
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
  return {
    repo,
    productionBranch: branch,
    gates: STUDIO_REPO_GATES,
    healthCheck: [...(STUDIO_REPO_GATES.packaging ?? []), ...(STUDIO_REPO_GATES.unit ?? [])],
    verify: STUDIO_REPO_GATES.self_test ?? [],
  };
}
const options: CoreOptions = {
  port: env.MODULEX_CORE_PORT ? Number(env.MODULEX_CORE_PORT) : DEFAULT_CORE_PORT,
  agentToken: env.MODULEX_AGENT_TOKEN || undefined,
  claudeDesktopToken: env.MODULEX_CLAUDE_DESKTOP_TOKEN || undefined,
  auditPath: dataDir ? join(dataDir, 'audit.jsonl') : undefined,
  storePath: dataDir ? join(dataDir, 'studio-store.json') : undefined,
  dataDir: dataDir || undefined,
  // studio.db: build worker pairings (handles only) and jobs, so a restart resumes them. The writable credential
  // store bridge (vault) is Phase 13: until then pairing reports BLOCKED (D-051).
  db: dataDir ? new StudioDb(join(dataDir, 'studio.db')) : null,
  // Known even before Godot is installed, so a Setup Assistant install can enable the pipeline without a restart.
  locations: {
    projectsRoot: env.MODULEX_PROJECTS_ROOT || undefined,
    addonsSource: env.MODULEX_ADDONS_SOURCE || undefined,
  },
  source: sourceWorkspace(env.MODULEX_SOURCE_REPO || undefined),
  forceSafeMode: env.MODULEX_SAFE_MODE === '1',
  pipeline:
    env.MODULEX_GODOT && env.MODULEX_PROJECTS_ROOT && env.MODULEX_ADDONS_SOURCE
      ? {
          godot: env.MODULEX_GODOT,
          projectsRoot: env.MODULEX_PROJECTS_ROOT,
          addonsSource: env.MODULEX_ADDONS_SOURCE,
          androidSdk: env.MODULEX_ANDROID_SDK || null,
          serverBinary: env.MODULEX_SERVER || null,
        }
      : undefined,
};
const core = await startCore(options).catch((e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  return startCore({ ...options, port: 0 });
});
process.stdout.write(JSON.stringify(core.handshake) + '\n');
console.error(`[modulex-core] listening on 127.0.0.1:${core.handshake.port}`);

const shutdown = async () => {
  await core.close();
  process.exit(0);
};
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
