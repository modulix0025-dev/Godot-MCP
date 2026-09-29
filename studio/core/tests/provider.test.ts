// SPDX-License-Identifier: Apache-2.0
//
// Mode A provider against a mock Anthropic HTTP endpoint (no network, no real key). Covers Execution Patch 1 §39:
// valid request, invalid key, model unavailable, unsupported parameter, timeout — plus refusal and redaction.
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { MemoryVault, Redactor } from '../src/audit/secrets.js';
import { AnthropicProvider, FALLBACK_BETA } from '../src/providers/anthropic.js';

const KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY';

function setup(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  const redactor = new Redactor();
  const vault = new MemoryVault(redactor);
  vault.set('secret://llm/anthropic/api-key', KEY);
  const audit = new AuditLog(redactor);
  const p = new AnthropicProvider({
    model: 'claude-opus-5-5',
    effort: 'medium',
    maxTokens: 16000,
    apiKeyRef: 'secret://llm/anthropic/api-key',
    serverSideFallback: true,
    timeoutMs: 5000,
    vault,
    redactor,
    audit,
    fetch: fetchImpl,
    maxRetries: 0,
    ...over,
  });
  return { p, audit };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, type: string, message: string) =>
  json(status, { type: 'error', error: { type, message } });
const MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'Game spec drafted.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 5 },
};

describe('AnthropicProvider', () => {
  it('sends Opus 5.5 with effort medium, no thinking switch, fallbacks "default" + beta, and the key only in the header', async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const { p, audit } = setup(async (url, init) => {
      captured = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return json(200, MESSAGE);
    });
    const r = await p.complete({ system: 'You are ModuleX.', messages: [{ role: 'user', content: 'اعمل لعبة' }] });
    expect(r).toMatchObject({ status: 'SUCCESS', text: 'Game spec drafted.', model: 'claude-opus-5-5' });
    expect(captured!.url).toMatch(/\/v1\/messages/);
    expect(captured!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
    });
    expect(captured!.body).not.toHaveProperty('thinking');
    expect(captured!.body).not.toHaveProperty('betas');
    expect(captured!.headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    expect(captured!.headers.get('x-api-key')).toBe(KEY);
    expect(JSON.stringify(audit.list())).not.toContain(KEY);
    expect(audit.list({ type: 'claude_provider_call' })).toHaveLength(1);
  });

  it('can run without server-side fallbacks when the owner disables them', async () => {
    let body: Record<string, unknown> = {};
    const { p } = setup(async (_u, init) => ((body = JSON.parse(String(init?.body))), json(200, MESSAGE)), {
      serverSideFallback: false,
    });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body).not.toHaveProperty('fallbacks');
  });

  it.each([
    [401, 'authentication_error', 'PROVIDER_AUTH', false],
    [404, 'not_found_error', 'PROVIDER_MODEL_UNAVAILABLE', false],
    [400, 'invalid_request_error', 'PROVIDER_BAD_REQUEST', false],
    [429, 'rate_limit_error', 'PROVIDER_RATE_LIMIT', true],
    [529, 'overloaded_error', 'PROVIDER_UNAVAILABLE', true],
  ])('HTTP %i → %s', async (status, type, code, retryable) => {
    const { p, audit } = setup(async () => apiError(status, type, `boom ${KEY}`));
    const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toMatchObject({ code, retryable });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(audit.list({ type: 'claude_provider_error' })).toHaveLength(1);
  });

  it('timeout → PROVIDER_TIMEOUT (retryable)', async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      );
    const { p } = setup(hang, { timeoutMs: 1000 });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
  });

  it('rejects unsupported settings before sending anything', async () => {
    let called = false;
    const { p } = setup(async () => ((called = true), json(200, MESSAGE)), { effort: 'turbo' as never });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toMatchObject({
      code: 'PROVIDER_BAD_REQUEST',
    });
    expect(called).toBe(false);
  });

  it('missing key → PROVIDER_AUTH without a request', async () => {
    const { p } = setup(async () => json(200, MESSAGE), { apiKeyRef: 'secret://llm/anthropic/missing' });
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toMatchObject({
      status: 'BLOCKED',
      code: 'PROVIDER_AUTH',
    });
  });

  it('refusal stop reason → PROVIDER_REFUSAL with the category', async () => {
    const { p } = setup(async () =>
      json(200, {
        ...MESSAGE,
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    );
    expect(await p.complete({ messages: [{ role: 'user', content: 'hi' }] })).toMatchObject({
      code: 'PROVIDER_REFUSAL',
      details: { category: 'cyber' },
    });
  });
});
