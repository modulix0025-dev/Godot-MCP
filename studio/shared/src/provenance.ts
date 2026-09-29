// SPDX-License-Identifier: Apache-2.0
//
// Asset provenance (Execution Patch 1 §6, docs/modulex/asset-provenance.md). Every generated or imported asset
// carries where it came from and under which terms it may be used. The commercial-use verdict is derived, never
// asserted: anything the system cannot establish from known licence facts is BLOCKED, not "probably fine".
import { z } from 'zod';

export const ASSET_SOURCES = ['generated', 'imported', 'procedural', 'manual'] as const;
export const ASSET_TYPES = [
  'character',
  'prop',
  'environment',
  'texture',
  'material',
  'concept_image',
  'animation',
  'audio',
  'ui',
] as const;

const iso = z.string().datetime({ offset: true });

/** One licence fact about a component that contributed to the asset (model weights, checkpoint, source file). */
export const LicenseFactSchema = z
  .object({
    subject: z.string().min(1), // e.g. "model:Hunyuan3D-2", "checkpoint:sdxl-base-1.0", "source:kenney-pack"
    license: z.string().min(1), // SPDX id or a licence name the owner recorded; "UNKNOWN" if not known
    commercial_use: z.enum(['allowed', 'forbidden', 'conditional', 'unknown']),
    conditions: z.string().optional(), // e.g. "< 1M MAU", "attribution required"
    evidence_url: z.string().url().optional(),
    recorded_by: z.enum(['workflow-registry', 'owner', 'import']),
  })
  .strict();
export type LicenseFact = z.infer<typeof LicenseFactSchema>;

export const AssetProvenanceSchema = z
  .object({
    asset_id: z.string().min(1),
    asset_type: z.enum(ASSET_TYPES),
    source: z.enum(ASSET_SOURCES),
    generator: z.string().min(1).nullable(), // "ComfyUI" for generated; null for manual/imported
    workflow_id: z.string().nullable(),
    workflow_version: z.string().nullable(),
    model: z.string().nullable(),
    checkpoint: z.string().nullable(),
    custom_nodes: z.array(z.string()),
    worker_id: z.string().nullable(), // an id only — never a worker URL or token
    generated_at: iso,
    source_reference: z.string().nullable(), // prompt id, original file name, store URL…
    human_modified: z.boolean(),
    license_facts: z.array(LicenseFactSchema),
    /** sha256 of the artifact the provenance describes. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.source === 'generated') {
      for (const f of ['generator', 'workflow_id', 'workflow_version', 'worker_id'] as const) {
        if (!p[f])
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: `${f} is required for generated assets` });
      }
    }
  });
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;

export type CommercialVerdict =
  | { status: 'ALLOWED'; licenses: string[]; conditions: string[] }
  | {
      status: 'BLOCKED';
      code: 'PROVENANCE_MISSING' | 'LICENSE_UNKNOWN' | 'COMMERCIAL_USE_FORBIDDEN';
      reasons: string[];
    };

/**
 * Derive the commercial-use verdict for an asset. ALLOWED only when provenance is valid, at least one licence
 * fact exists, and every fact is `allowed` or `conditional` (conditions are surfaced for the owner).
 * Missing provenance, an unknown licence, or any forbidden component → BLOCKED.
 */
export function evaluateCommercialUse(provenance: unknown): CommercialVerdict {
  const parsed = AssetProvenanceSchema.safeParse(provenance);
  if (!parsed.success) {
    return {
      status: 'BLOCKED',
      code: 'PROVENANCE_MISSING',
      reasons: parsed.error.issues.map((i) => `${i.path.join('.') || 'provenance'}: ${i.message}`),
    };
  }
  const p = parsed.data;
  if (p.license_facts.length === 0) {
    return { status: 'BLOCKED', code: 'LICENSE_UNKNOWN', reasons: ['No licence facts recorded for this asset.'] };
  }
  const forbidden = p.license_facts.filter((f) => f.commercial_use === 'forbidden');
  if (forbidden.length) {
    return {
      status: 'BLOCKED',
      code: 'COMMERCIAL_USE_FORBIDDEN',
      reasons: forbidden.map((f) => `${f.subject} (${f.license}) forbids commercial use.`),
    };
  }
  const unknown = p.license_facts.filter(
    (f) => f.commercial_use === 'unknown' || f.license.toUpperCase() === 'UNKNOWN',
  );
  if (unknown.length) {
    return {
      status: 'BLOCKED',
      code: 'LICENSE_UNKNOWN',
      reasons: unknown.map((f) => `${f.subject}: commercial-use status unknown (${f.license}).`),
    };
  }
  // A generated asset must name the model it came from, and that model must have a licence fact.
  if (p.source === 'generated' && p.model && !p.license_facts.some((f) => f.subject === `model:${p.model}`)) {
    return { status: 'BLOCKED', code: 'LICENSE_UNKNOWN', reasons: [`No licence fact for model:${p.model}.`] };
  }
  return {
    status: 'ALLOWED',
    licenses: [...new Set(p.license_facts.map((f) => f.license))],
    conditions: p.license_facts.flatMap((f) => (f.conditions ? [`${f.subject}: ${f.conditions}`] : [])),
  };
}
