// SPDX-License-Identifier: Apache-2.0
//
// Mode A configuration documents (Execution Patch 2 §2). Runtime configuration lives in versioned documents that
// Core reads live, so a change applies without rebuilding the application. Every document has a schema, a risk
// level and a history; policy and update settings are security-sensitive and can only change with the owner.
import { z } from 'zod';
import { isProtectedTool, TOOL_CATALOG } from './policy.js';
import { RoutingSchema } from './llm.js';
import { UpdateSettingsSchema } from './versions.js';
import type { RiskLevel } from './evolution.js';

/**
 * Approval policy overrides (§28). The owner can make specific studio-layer tools automatic — globally or per
 * project — and set the cost threshold. Hard limits enforced by the schema, whatever the owner or an agent asks:
 *   - raw engine tools and critical tools can never be auto-approved;
 *   - auto-approval never applies to Claude Desktop (enforced in `decide`);
 *   - System Evolution tools can never be auto-approved (§33: the controls that govern change are protected).
 */
export const PolicyConfigSchema = z
  .object({
    auto_approve: z
      .array(
        z
          .object({
            tool: z.string(),
            projects: z.union([z.literal('*'), z.array(z.string()).min(1)]),
          })
          .strict(),
      )
      .default([]),
    cost_threshold_usd: z.number().min(0).max(100).default(0.25),
    approval_ttl_minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(30),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.auto_approve.forEach((r, i) => {
      const spec = TOOL_CATALOG.get(r.tool);
      if (!spec)
        ctx.addIssue({ code: 'custom', path: ['auto_approve', i, 'tool'], message: `unknown tool '${r.tool}'` });
      else if (spec.layer === 'raw')
        ctx.addIssue({
          code: 'custom',
          path: ['auto_approve', i, 'tool'],
          message: 'raw engine tools cannot be auto-approved',
        });
      else if (spec.tier === 'critical')
        ctx.addIssue({
          code: 'custom',
          path: ['auto_approve', i, 'tool'],
          message: 'critical tools cannot be auto-approved',
        });
      else if (isProtectedTool(r.tool))
        ctx.addIssue({
          code: 'custom',
          path: ['auto_approve', i, 'tool'],
          message: 'System Evolution, extension and update tools cannot be auto-approved',
        });
      else if (spec.tier !== 'destructive' && spec.tier !== 'cost')
        ctx.addIssue({
          code: 'custom',
          path: ['auto_approve', i, 'tool'],
          message: `'${r.tool}' is already automatic (${spec.tier})`,
        });
    });
  });
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const BudgetsConfigSchema = z
  .object({
    monthly_usd: z.number().min(0),
    per_project_usd: z.number().min(0),
    gpu_hour_cap: z.number().min(0),
  })
  .strict();

export const WorkerSettingsSchema = z
  .object({
    health_interval_s: z.number().int().min(10).max(3600),
    quarantine_threshold: z.number().int().min(1).max(10),
    max_parallel_jobs: z.number().int().min(1).max(32),
  })
  .strict();

export const UiPreferencesSchema = z
  .object({
    theme: z.enum(['dark', 'light']),
    lang: z.enum(['en', 'ar']),
    density: z.enum(['comfortable', 'dense']),
  })
  .strict();

export const BuildPreferencesSchema = z
  .object({
    default_profile: z.enum(['DEV', 'QA', 'PREVIEW', 'RELEASE']),
    platforms: z.array(z.enum(['windows', 'android', 'ios'])).min(1),
  })
  .strict();

export const PromptsConfigSchema = z.record(z.string().regex(/^[a-z0-9_.-]+$/), z.string().max(20_000));

export const CONFIG_DOCS = {
  policy: { schema: PolicyConfigSchema, risk: 'CRITICAL', security: true },
  budgets: { schema: BudgetsConfigSchema, risk: 'MEDIUM', security: false },
  llm_routing: { schema: RoutingSchema, risk: 'MEDIUM', security: false },
  worker_settings: { schema: WorkerSettingsSchema, risk: 'MEDIUM', security: false },
  ui_preferences: { schema: UiPreferencesSchema, risk: 'LOW', security: false },
  build_preferences: { schema: BuildPreferencesSchema, risk: 'LOW', security: false },
  prompts: { schema: PromptsConfigSchema, risk: 'MEDIUM', security: false },
  update_settings: { schema: UpdateSettingsSchema, risk: 'CRITICAL', security: true },
} as const satisfies Record<string, { schema: z.ZodTypeAny; risk: RiskLevel; security: boolean }>;
export type ConfigDocId = keyof typeof CONFIG_DOCS;
export const CONFIG_DOC_IDS = Object.keys(CONFIG_DOCS) as ConfigDocId[];

export const DEFAULT_CONFIG: { [K in ConfigDocId]: z.input<(typeof CONFIG_DOCS)[K]['schema']> } = {
  policy: { auto_approve: [], cost_threshold_usd: 0.25, approval_ttl_minutes: 30 },
  budgets: { monthly_usd: 50, per_project_usd: 20, gpu_hour_cap: 10 },
  llm_routing: { primary: 'anthropic-api', fallback: null, fast: null, planning: null, qa: null },
  worker_settings: { health_interval_s: 60, quarantine_threshold: 3, max_parallel_jobs: 2 },
  ui_preferences: { theme: 'dark', lang: 'en', density: 'comfortable' },
  build_preferences: { default_profile: 'QA', platforms: ['windows'] },
  prompts: {},
  update_settings: { channel: 'stable', check_automatically: false, install_automatically: false },
};

export interface JsonChange {
  path: string;
  op: 'add' | 'remove' | 'replace';
  from?: unknown;
  to?: unknown;
}

/** Path-level diff of two JSON values — what the owner sees for a configuration change (§28 "exact policy diff"). */
export function jsonDiff(a: unknown, b: unknown, path = ''): JsonChange[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (obj(a) && obj(b)) {
    const out: JsonChange[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = `${path}/${k}`;
      if (!(k in a)) out.push({ path: p, op: 'add', to: b[k] });
      else if (!(k in b)) out.push({ path: p, op: 'remove', from: a[k] });
      else out.push(...jsonDiff(a[k], b[k], p));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: JsonChange[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}/${i}`;
      if (i >= a.length) out.push({ path: p, op: 'add', to: b[i] });
      else if (i >= b.length) out.push({ path: p, op: 'remove', from: a[i] });
      else out.push(...jsonDiff(a[i], b[i], p));
    }
    return out;
  }
  return [{ path: path || '/', op: 'replace', from: a, to: b }];
}
