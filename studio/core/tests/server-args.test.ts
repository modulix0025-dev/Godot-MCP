// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildServerArgs, generateSessionToken, godotSessionEnv, redactSecrets } from '../src/godot/server-args.js';

describe('buildServerArgs', () => {
  it('reproduces McpPlugin 8.6.0 BuildCommandLine(token) exactly', () => {
    const token = 'A'.repeat(43);
    expect(buildServerArgs({ port: 24123, token }).join(' ')).toBe(
      `port=24123 plugin-timeout=10000 client-transport=streamableHttp auth=token token=${token}`,
    );
  });

  it.each([0, 70000, 1.5])('rejects port %s', (port) => {
    expect(() => buildServerArgs({ port, token: generateSessionToken() })).toThrow();
  });

  it('rejects short or non-base64url tokens', () => {
    expect(() => buildServerArgs({ port: 1, token: 'short' })).toThrow();
    expect(() => buildServerArgs({ port: 1, token: 'x'.repeat(40) + ' ;rm' })).toThrow();
  });
});

describe('session secrets', () => {
  it('generates distinct 43-char base64url tokens', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('redacts every occurrence', () => {
    const t = generateSessionToken();
    expect(redactSecrets(`token=${t} again ${t}`, [t])).toBe('token=<redacted> again <redacted>');
  });

  it('builds Custom/loopback/token env for Godot', () => {
    expect(godotSessionEnv(24123, 'tok')).toEqual({
      GODOT_MCP_CONNECTION_MODE: 'Custom',
      GODOT_MCP_HOST: 'http://127.0.0.1:24123',
      GODOT_MCP_AUTH_OPTION: 'token',
      GODOT_MCP_TOKEN: 'tok',
    });
  });
});
