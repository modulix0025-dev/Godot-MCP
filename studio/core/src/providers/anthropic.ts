// SPDX-License-Identifier: Apache-2.0
//
// Mode A — Anthropic API provider (Execution Patch 1 §17–18, docs/modulex/claude-integration.md).
// Official SDK only (`@anthropic-ai/sdk`). Model default `claude-opus-5-5`. Opus 5.5 always thinks adaptively,
// so no thinking switch is sent; depth is controlled by `output_config.effort` (default `medium`), validated
// against the model's supported values BEFORE the request is sent. Server-side refusal fallbacks
// (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are on by default — the owner can disable
// them in Settings. The API key comes from the credential store via a `secret://` handle, is registered with the
// redactor, and never appears in results, errors, logs or audit rows.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { studioError, validateModelSettings, type Effort, type StudioError } from '@modulex/shared';
import type { AuditLog } from '../audit/audit-log.js';
import type { Redactor, SecretVault } from '../audit/secrets.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  model: string;
  effort: Effort;
  maxTokens: number;
  apiKeyRef: string;
  serverSideFallback: boolean;
  timeoutMs: number;
  vault: SecretVault;
  redactor: Redactor;
  audit: AuditLog;
  /** Test seam: custom fetch / base URL (never set in production). */
  fetch?: typeof fetch;
  baseURL?: string;
  maxRetries?: number;
}

export interface CompletionRequest {
  system?: string;
  messages: BetaMessageParam[];
}

export type CompletionResult =
  | {
      status: 'SUCCESS';
      text: string;
      stop_reason: string | null;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    }
  | StudioError;

export class AnthropicProvider {
  constructor(private readonly o: AnthropicProviderOptions) {}

  /** The request body the provider sends (exported for tests and the Settings "preview request" view). */
  buildParams(req: CompletionRequest) {
    return {
      model: this.o.model,
      max_tokens: this.o.maxTokens,
      output_config: { effort: this.o.effort },
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
      ...(this.o.serverSideFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const problems = validateModelSettings(this.o.model, this.o.effort);
    if (problems.length) {
      return studioError(
        'FAILED',
        'PROVIDER_BAD_REQUEST',
        problems.join(' '),
        'Choose a supported model/effort in Settings → AI Providers → Claude API.',
      );
    }
    const apiKey = await this.o.vault.resolve(this.o.apiKeyRef);
    if (!apiKey) {
      return studioError(
        'BLOCKED',
        'PROVIDER_AUTH',
        'No Anthropic API key is configured.',
        'Add an API key in Settings → AI Providers → Claude API (stored in Windows Credential Manager).',
      );
    }
    this.o.redactor.register(apiKey);
    const client = new Anthropic({
      apiKey,
      timeout: this.o.timeoutMs,
      maxRetries: this.o.maxRetries ?? 2,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      ...(this.o.baseURL ? { baseURL: this.o.baseURL } : {}),
    });
    const started = Date.now();
    try {
      const msg = await client.beta.messages.create(this.buildParams(req));
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      this.o.audit.append('claude_provider_call', 'studio', {
        model: msg.model,
        effort: this.o.effort,
        stop_reason: msg.stop_reason,
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        ms: Date.now() - started,
      });
      if (msg.stop_reason === 'refusal') {
        const category = msg.stop_details && 'category' in msg.stop_details ? msg.stop_details.category : null;
        return studioError(
          'BLOCKED',
          'PROVIDER_REFUSAL',
          'The model declined this request.',
          'Rephrase the task or route it to the owner.',
          false,
          { category },
        );
      }
      return {
        status: 'SUCCESS',
        text,
        stop_reason: msg.stop_reason,
        model: msg.model,
        usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      };
    } catch (e) {
      const err = mapError(e);
      this.o.audit.append('claude_provider_error', 'studio', {
        code: err.code,
        model: this.o.model,
        ms: Date.now() - started,
      });
      return { ...err, message: this.o.redactor.redact(err.message) };
    }
  }
}

/** Most-specific-first mapping of the SDK's typed errors to structured Studio errors. */
export function mapError(e: unknown): StudioError {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return studioError(
      'BLOCKED',
      'PROVIDER_AUTH',
      'The Anthropic API rejected the API key.',
      'Check the key in Settings → AI Providers → Claude API.',
    );
  }
  if (e instanceof Anthropic.NotFoundError) {
    return studioError(
      'BLOCKED',
      'PROVIDER_MODEL_UNAVAILABLE',
      'The configured model is not available to this API key.',
      'Select an available model in Settings → AI Providers → Claude API.',
    );
  }
  if (e instanceof Anthropic.BadRequestError) {
    return studioError(
      'FAILED',
      'PROVIDER_BAD_REQUEST',
      `The API rejected a request parameter: ${e.message}`,
      'Reset the provider settings to defaults; report this if it persists.',
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return studioError(
      'FAILED',
      'PROVIDER_RATE_LIMIT',
      'Rate limited by the Anthropic API.',
      'Wait and retry, or route this work to the fallback provider.',
      true,
    );
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return studioError(
      'FAILED',
      'PROVIDER_TIMEOUT',
      'The Anthropic API did not respond in time.',
      'Retry; raise the timeout for long tasks.',
      true,
    );
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return studioError(
      'FAILED',
      'PROVIDER_UNAVAILABLE',
      'Could not reach the Anthropic API.',
      'Check the network connection and retry.',
      true,
    );
  }
  if (e instanceof Anthropic.APIError) {
    const retry = typeof e.status === 'number' && e.status >= 500;
    return studioError(
      'FAILED',
      'PROVIDER_UNAVAILABLE',
      `Anthropic API error (${e.status ?? 'unknown'}).`,
      retry ? 'Retry shortly.' : 'Check the provider settings.',
      retry,
    );
  }
  return studioError('FAILED', 'INTERNAL', 'Unexpected provider failure.', 'See the Activity log.', false);
}
