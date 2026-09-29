// SPDX-License-Identifier: Apache-2.0
//
// Secret handling inside Core. Secrets live in the OS credential store (Windows Credential Manager / DPAPI via
// the Tauri shell — Phase 4); Core holds only `secret://…` handles and resolves them just in time. This module
// provides the in-process vault interface and the redactor that every log line, audit payload, event and
// agent-facing result passes through.

export interface SecretVault {
  /** Resolve a handle to its value. Only Core internals may call this; values never leave Core. */
  resolve(ref: string): Promise<string | null>;
}

/** Test/dev vault. The production vault is the shell's Credential Manager bridge. */
export class MemoryVault implements SecretVault {
  private readonly values = new Map<string, string>();
  constructor(private readonly redactor?: Redactor) {}
  set(ref: string, value: string): void {
    if (!/^secret:\/\/[a-z]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(ref)) throw new Error(`invalid secret ref '${ref}'`);
    this.values.set(ref, value);
    this.redactor?.register(value);
  }
  async resolve(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
}

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys
  /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|token|password|passwd|secret|keystore[_-]?pass(?:word)?)\s*["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi,
];

/** Replaces known secret values and secret-shaped substrings. Register every secret Core ever resolves. */
export class Redactor {
  private readonly known = new Set<string>();

  register(value: string): void {
    if (value && value.length >= 6) this.known.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.known) out = out.split(v).join('<redacted>');
    for (const re of PATTERNS)
      out = out.replace(re, (_m, prefix?: string) =>
        typeof prefix === 'string' ? `${prefix}<redacted>` : '<redacted>',
      );
    return out;
  }

  /** Deep-redact any JSON-serialisable value (keys named like secrets are blanked entirely). */
  redactValue<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (key, v) => {
        if (
          /^(api_?key|apiKey|token|password|secret|authorization|keystore_?password)$/i.test(key) &&
          typeof v === 'string'
        )
          return '<redacted>';
        return typeof v === 'string' ? this.redact(v) : v;
      }),
    ) as T;
  }

  /** True when the text still contains a registered secret or a secret-shaped substring. */
  containsSecret(text: string): boolean {
    return this.redact(text) !== text;
  }
}
