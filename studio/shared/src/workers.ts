// SPDX-License-Identifier: Apache-2.0
//
// ComfyUI / build worker trust system (Execution Patch 1 §7–8). A worker is a security boundary: it runs
// arbitrary custom-node code and returns files the Studio must treat as untrusted. Trust is earned through the
// onboarding checks, lost automatically on anomalies, and only restored by the owner.
import { z } from 'zod';

export const TRUST_LEVELS = ['TRUSTED', 'DEGRADED', 'UNTRUSTED', 'QUARANTINED', 'OFFLINE'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Onboarding steps, in order. Every one must pass before a worker can become TRUSTED. */
export const ONBOARDING_STEPS = [
  'register',
  'connectivity',
  'authentication',
  'capability_discovery',
  'version_discovery',
  'health_check',
  'test_generation',
  'output_validation',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const TRANSPORTS = [
  'https-auth-proxy',
  'tailscale',
  'ssh-tunnel',
  'private-network',
  'zero-trust-tunnel',
  'loopback',
] as const;

export const WorkerRecordSchema = z
  .object({
    worker_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    kind: z.enum(['comfyui', 'build']),
    provider: z.enum(['local', 'vastai', 'runpod', 'aws', 'other']),
    location: z.string().min(1),
    base_url: z.string().url(),
    transport: z.enum(TRANSPORTS),
    /** A handle into the OS credential store (never the secret itself). */
    secret_ref: z
      .string()
      .regex(/^secret:\/\/worker\/[a-z0-9-]+\/[a-z0-9-]+$/)
      .nullable(),
    gpu: z.string().nullable(),
    comfy_version: z.string().nullable(),
    vram_gb: z.number().nonnegative().nullable(),
    capabilities: z.array(z.string()),
    auth_status: z.enum(['ok', 'failed', 'untested']),
    last_health_at: z.string().datetime({ offset: true }).nullable(),
    trust: z.enum(TRUST_LEVELS),
    failure_count: z.number().int().nonnegative(),
    cost_class: z.enum(['free', 'low', 'medium', 'high']),
    onboarding: z.record(z.enum(ONBOARDING_STEPS), z.enum(['passed', 'failed', 'pending'])),
    quarantine_reason: z.string().nullable(),
  })
  .strict();
export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;

/** Transport rule (§8): a remote worker is never reached over unauthenticated public HTTP. */
export function transportProblem(baseUrl: string, transport: (typeof TRANSPORTS)[number]): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return 'base_url is not a valid URL';
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  if (transport === 'loopback') return loopback ? null : 'transport "loopback" requires a loopback host';
  if (transport === 'https-auth-proxy' || transport === 'zero-trust-tunnel') {
    return u.protocol === 'https:'
      ? null
      : `${transport} requires an https:// URL (the proxy/tunnel terminates TLS + auth)`;
  }
  // tailscale / ssh-tunnel / private-network: HTTP is acceptable only because the channel itself is authenticated.
  return null;
}

/** The trust decision at the end of onboarding: TRUSTED only when every step passed and transport is sound. */
export function onboardingDecision(w: Pick<WorkerRecord, 'onboarding' | 'base_url' | 'transport'>): {
  trust: TrustLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  const t = transportProblem(w.base_url, w.transport);
  if (t) reasons.push(t);
  for (const step of ONBOARDING_STEPS) {
    const s = w.onboarding[step];
    if (s !== 'passed') reasons.push(`onboarding step '${step}' is ${s ?? 'missing'}`);
  }
  if (w.onboarding.connectivity === 'failed') return { trust: 'OFFLINE', reasons };
  return { trust: reasons.length ? 'UNTRUSTED' : 'TRUSTED', reasons };
}

export const ANOMALIES = [
  'malformed_output',
  'unexpected_api_behavior',
  'auth_anomaly',
  'file_validation_failure',
  'unexpected_response_type',
  'crash',
  'timeout',
] as const;
export type Anomaly = (typeof ANOMALIES)[number];

/** Anomalies that quarantine immediately (security-relevant), and the repeat threshold for the others. */
const IMMEDIATE: ReadonlySet<Anomaly> = new Set(['auth_anomaly', 'unexpected_response_type']);
export const QUARANTINE_THRESHOLD = 3;

export interface TrustTransition {
  trust: TrustLevel;
  failure_count: number;
  quarantine_reason: string | null;
  /** True when production work must be moved off this worker now. */
  evacuate: boolean;
}

/** Apply one observed anomaly. Owner action (not this function) is the only way back from QUARANTINED. */
export function recordAnomaly(w: Pick<WorkerRecord, 'trust' | 'failure_count'>, anomaly: Anomaly): TrustTransition {
  const failure_count = w.failure_count + 1;
  if (w.trust === 'QUARANTINED')
    return { trust: 'QUARANTINED', failure_count, quarantine_reason: null, evacuate: false };
  if (IMMEDIATE.has(anomaly) || failure_count >= QUARANTINE_THRESHOLD) {
    return {
      trust: 'QUARANTINED',
      failure_count,
      quarantine_reason: `${anomaly} (failure ${failure_count})`,
      evacuate: true,
    };
  }
  return {
    trust: w.trust === 'TRUSTED' ? 'DEGRADED' : w.trust,
    failure_count,
    quarantine_reason: null,
    evacuate: false,
  };
}

/** A clean health check lifts DEGRADED back to TRUSTED and resets the counter; it never lifts QUARANTINED. */
export function recordHealthy(w: Pick<WorkerRecord, 'trust'>): Pick<TrustTransition, 'trust' | 'failure_count'> {
  if (w.trust === 'QUARANTINED' || w.trust === 'UNTRUSTED') return { trust: w.trust, failure_count: 0 };
  return { trust: 'TRUSTED', failure_count: 0 };
}

/** Only TRUSTED (and, for non-production test jobs, DEGRADED) workers receive work. */
export function canRunJob(trust: TrustLevel, purpose: 'production' | 'test'): boolean {
  if (trust === 'TRUSTED') return true;
  return purpose === 'test' && (trust === 'DEGRADED' || trust === 'UNTRUSTED');
}

/** The worker view that may leave Core (agents, events, UI lists): ids and health, never URLs or secrets. */
export function publicWorkerView(w: WorkerRecord) {
  return {
    worker_id: w.worker_id,
    kind: w.kind,
    provider: w.provider,
    location: w.location,
    gpu: w.gpu,
    comfy_version: w.comfy_version,
    vram_gb: w.vram_gb,
    capabilities: w.capabilities,
    trust: w.trust,
    last_health_at: w.last_health_at,
    cost_class: w.cost_class,
  };
}
