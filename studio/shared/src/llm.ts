// SPDX-License-Identifier: Apache-2.0
//
// LLM provider configuration (Execution Patch 1 §15–25, docs/modulex/claude-integration.md).
// ModuleX Agent is not hard-wired to one provider: providers are configured here and selected per purpose
// (primary / fallback / fast / planning / qa). Secrets are never part of this config — only credential-store
// handles (`secret://…`).
import { z } from 'zod';

export const PROVIDER_KINDS = ['anthropic-api', 'claude-desktop-mcp', 'local-agent-sdk', 'other'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Effort levels accepted by the Claude Messages API (`output_config.effort`). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ModelCapabilities {
  id: string;
  label: string;
  efforts: readonly Effort[];
  defaultEffort: Effort;
  /** Thinking is always on (adaptive); the UI must not offer an on/off switch. */
  thinkingAlwaysOn: boolean;
  /** `fallbacks: "default"` (beta server-side-fallback-2026-07-01) is supported on the Claude API. */
  serverSideFallbackDefault: boolean;
}

/**
 * Known Claude models and the settings the Studio may offer for them. Opus 5.5: adaptive thinking always on,
 * effort low→max with default `medium`, fallbacks "default" supported. The list is a UI hint; the provider
 * re-validates against it before every request and the API remains the final authority.
 */
export const CLAUDE_MODELS: Record<string, ModelCapabilities> = {
  'claude-opus-5-5': {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    efforts: EFFORT_LEVELS,
    defaultEffort: 'medium',
    thinkingAlwaysOn: true,
    serverSideFallbackDefault: true,
  },
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    efforts: EFFORT_LEVELS,
    defaultEffort: 'high',
    thinkingAlwaysOn: false,
    serverSideFallbackDefault: true,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    efforts: [],
    defaultEffort: 'medium',
    thinkingAlwaysOn: false,
    serverSideFallbackDefault: false,
  },
};

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const secretRef = z.string().regex(/^secret:\/\/llm\/[a-z0-9-]+\/[a-z0-9-]+$/);

export const ProviderConfigSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('anthropic-api'),
      id: z.string().min(1),
      model: z.string().min(1),
      effort: z.enum(EFFORT_LEVELS),
      maxTokens: z.number().int().min(1).max(128000),
      apiKeyRef: secretRef,
      /** Server-side refusal fallbacks (`fallbacks: "default"`); on by default, owner may disable. */
      serverSideFallback: z.boolean(),
      timeoutMs: z.number().int().min(1000).max(3_600_000),
    })
    .strict(),
  z.object({ kind: z.literal('claude-desktop-mcp'), id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('local-agent-sdk'),
      id: z.string().min(1),
      model: z.string().min(1),
      apiKeyRef: secretRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('other'),
      id: z.string().min(1),
      label: z.string().min(1),
      model: z.string().min(1),
      secretRef: secretRef.nullable(),
    })
    .strict(),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ROUTING_PURPOSES = ['primary', 'fallback', 'fast', 'planning', 'qa'] as const;
export type RoutingPurpose = (typeof ROUTING_PURPOSES)[number];

export const RoutingSchema = z
  .object({
    primary: z.string().min(1),
    fallback: z.string().min(1).nullable(),
    fast: z.string().min(1).nullable(),
    planning: z.string().min(1).nullable(),
    qa: z.string().min(1).nullable(),
  })
  .strict();
export type Routing = z.infer<typeof RoutingSchema>;

/** Resolve a purpose to a provider id (unset purposes fall back to primary). */
export function routeFor(routing: Routing, purpose: RoutingPurpose): string {
  return (purpose === 'primary' ? routing.primary : routing[purpose]) ?? routing.primary;
}

/** Validate settings BEFORE a request is sent (Patch 1 §18). Returns problems; empty = valid. */
export function validateModelSettings(model: string, effort: Effort | undefined): string[] {
  const caps = CLAUDE_MODELS[model];
  if (!caps) return [`Model '${model}' is not in the Studio's known-model list; verify it in Settings → AI Providers.`];
  const problems: string[] = [];
  if (effort !== undefined) {
    if (caps.efforts.length === 0) problems.push(`${caps.label} does not accept an effort setting.`);
    else if (!caps.efforts.includes(effort)) problems.push(`${caps.label} does not support effort '${effort}'.`);
  }
  return problems;
}

/** Which effort choices the Settings UI may show for a model (Patch 1 §18: only supported values). */
export function effortChoices(model: string): { values: readonly Effort[]; default: Effort | null } {
  const caps = CLAUDE_MODELS[model];
  if (!caps || caps.efforts.length === 0) return { values: [], default: null };
  return { values: caps.efforts, default: caps.defaultEffort };
}
