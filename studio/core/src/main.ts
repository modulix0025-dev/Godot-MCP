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
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
  source: sourceWorkspace(env.MODULEX_SOURCE_REPO || undefined),
  forceSafeMode: env.MODULEX_SAFE_MODE === '1',
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
