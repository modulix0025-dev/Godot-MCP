// SPDX-License-Identifier: Apache-2.0
//
// modulex-build-worker command line.
//
//   modulex-build-worker serve --state <dir> --godot <bin> [--host 0.0.0.0 --tls-cert <pem> --tls-key <pem>]
//                              [--port 47830] [--signing <dir>]
//   modulex-build-worker pair  --state <dir>       print a one-time pairing code (valid 10 minutes)
//   modulex-build-worker revoke --state <dir>      forget every paired Studio
//
// macOS: install as a LaunchAgent (see launchd/com.modulex.build-worker.plist). The pairing code is printed on the
// worker host only; the Studio exchanges it once for a worker token, which the Studio keeps in the OS credential
// store and the worker keeps as a SHA-256 hash.
import { readFileSync } from 'node:fs';
import { GodotExportRunner } from './runner.js';
import { WorkerService } from './service.js';
import { WorkerStore } from './store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];
const state = arg('state');
if (!state) {
  console.error('usage: modulex-build-worker <serve|pair|revoke> --state <dir> …');
  process.exit(2);
}

if (cmd === 'pair') {
  console.log(new WorkerStore(state).newPairingCode());
} else if (cmd === 'revoke') {
  new WorkerStore(state).revokeAll();
  console.log('all paired Studios revoked');
} else if (cmd === 'serve') {
  const godot = arg('godot');
  if (!godot) {
    console.error('--godot <Godot 4.5.1 mono binary> is required');
    process.exit(2);
  }
  const cert = arg('tls-cert');
  const key = arg('tls-key');
  const service = new WorkerService({
    stateDir: state,
    runner: new GodotExportRunner({ godot, signingDir: arg('signing') ?? null }),
    host: arg('host') ?? '127.0.0.1',
    port: Number(arg('port') ?? 47830),
    tls: cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : null,
  });
  const { url } = await service.listen();
  console.log(`[modulex-build-worker] listening on ${url} (worker ${service.store.state().worker_id})`);
  const stop = () => void service.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  console.error(`unknown command '${cmd ?? ''}'`);
  process.exit(2);
}
