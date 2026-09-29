// SPDX-License-Identifier: Apache-2.0
//
// Studio Core process entry: binds a loopback-only HTTP server on a random port, protected by a random
// per-launch session token, and hands {port, token} to the Tauri shell as ONE JSON line on stdout (the
// handshake). Everything after the handshake goes to stderr, so the shell can read stdout line-by-line.
// Phase 1 serves only /health; the UI API, event stream and the modulex-studio MCP endpoint land in Phase 4/6.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { STUDIO_CORE_VERSION } from './index.js';
import { generateSessionToken } from './godot/server-args.js';
import * as godotCli from 'godot-cli';

/** Proves the bundled sidecar carries the reused godot-cli library (Phase 0 spike 7). */
const GODOT_CLI_EXPORTS = Object.keys(godotCli)
  .filter((k) => typeof (godotCli as Record<string, unknown>)[k] === 'function')
  .sort();

export interface Handshake {
  type: 'modulex-core-handshake';
  version: string;
  port: number;
  token: string;
  pid: number;
}

/** JSON response with an explicit Content-Length (no chunked encoding: the Rust shell reads raw HTTP/1.1). */
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface CoreServer {
  server: Server;
  handshake: Handshake;
  close(): Promise<void>;
}

/** Start Core on 127.0.0.1 with a random port (or `port`) and a fresh token. */
export async function startCore(port = 0): Promise<CoreServer> {
  const token = generateSessionToken();
  const startedAt = Date.now();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req, token)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      const body = {
        ok: true,
        version: STUDIO_CORE_VERSION,
        uptimeMs: Date.now() - startedAt,
        rssBytes: process.memoryUsage().rss,
        godotCli: GODOT_CLI_EXPORTS,
      };
      send(res, 200, body);
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    handshake: {
      type: 'modulex-core-handshake',
      version: STUDIO_CORE_VERSION,
      port: addr.port,
      token,
      pid: process.pid,
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
