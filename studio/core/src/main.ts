// SPDX-License-Identifier: Apache-2.0
//
// `modulex-core` executable entry (bundled to dist/modulex-core.mjs and run by the Tauri shell's bundled
// Node sidecar). Prints the handshake line, then serves until stdin closes (the shell exiting or killing us
// closes the pipe) or a termination signal arrives.
import { startCore } from './server.js';

const core = await startCore();
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
