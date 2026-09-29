// SPDX-License-Identifier: Apache-2.0
//
// The exact gamedev-mcp-server command line for a Studio session. Recovered in Phase 0 (DECISIONS.md D-004)
// from McpPlugin 8.6.0 `ServerLaunchArguments.BuildCommandLine(port, 10000, streamableHttp, AuthOption.token,
// token)` — the same builder the addon's own "Start Server" button uses:
//
//   port=<port> plugin-timeout=10000 client-transport=streamableHttp auth=token token=<token>
//
// NOTE the key is `auth=`, not `authorization=` (the CI harness's `authorization=none` form is a different,
// legacy spelling). The token is a secret: callers must never log the returned argv.
import { randomBytes } from 'node:crypto';

export const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;

export interface ServerLaunchOptions {
  port: number;
  token: string;
  pluginTimeoutMs?: number;
}

export function buildServerArgs({
  port,
  token,
  pluginTimeoutMs = DEFAULT_PLUGIN_TIMEOUT_MS,
}: ServerLaunchOptions): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`invalid port ${port}`);
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('token must be >= 32 base64url characters');
  if (!Number.isInteger(pluginTimeoutMs) || pluginTimeoutMs <= 0) throw new RangeError('invalid plugin timeout');
  return [
    `port=${port}`,
    `plugin-timeout=${pluginTimeoutMs}`,
    'client-transport=streamableHttp',
    'auth=token',
    `token=${token}`,
  ];
}

/** A fresh per-session secret: 32 random bytes, base64url (43 chars). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Replace every occurrence of the given secrets in a string (logs, errors, events). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

/** The GODOT_MCP_* env for a Studio-launched editor or playtest game (Custom mode, loopback, token). */
export function godotSessionEnv(port: number, token: string): Record<string, string> {
  return {
    GODOT_MCP_CONNECTION_MODE: 'Custom',
    GODOT_MCP_HOST: `http://127.0.0.1:${port}`,
    GODOT_MCP_AUTH_OPTION: 'token',
    GODOT_MCP_TOKEN: token,
  };
}
