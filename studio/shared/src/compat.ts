// SPDX-License-Identifier: Apache-2.0
//
// The Studio compatibility manifest (studio/compat.json) is the single source of truth for every version
// the Studio pins: the Godot engine build, the .NET SDKs, both addons, the MCP server and the reused NuGet
// packages. Nothing else in the Studio may hard-code these; compat-parity.test.ts proves the manifest agrees
// with the repository files that actually pin them.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected MAJOR.MINOR.PATCH');

export const CompatSchema = z
  .object({
    studioVersion: semver,
    godot: z
      .object({
        version: semver,
        flavor: z.literal('mono'),
        versionPrefix: z.string().min(1),
      })
      .strict(),
    dotnetSdk: z.string().regex(/^\d+\.\d+$/),
    godotNetSdk: semver,
    addon: z.object({ godot_mcp: semver, modulex_studio: semver }).strict(),
    server: z.object({ name: z.literal('gamedev-mcp-server'), version: semver }).strict(),
    nuget: z.record(z.string(), semver),
    dbSchema: z.number().int().positive(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.godot.versionPrefix !== `${c.godot.version}.stable.${c.godot.flavor}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['godot', 'versionPrefix'],
        message: `versionPrefix must be '${c.godot.version}.stable.${c.godot.flavor}'`,
      });
    }
    if (c.godotNetSdk !== c.godot.version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['godotNetSdk'],
        message: 'Godot.NET.Sdk must match the pinned engine version (GODOT4_5_OR_GREATER depends on it)',
      });
    }
  });

export type Compat = z.infer<typeof CompatSchema>;

/** Parse and validate a compat manifest; throws a readable error on any mismatch. */
export function parseCompat(json: unknown): Compat {
  const r = CompatSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      'Invalid compat.json: ' + r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

/** Load studio/compat.json from disk (the Studio ships it next to Core). */
export function loadCompat(path: string | URL): Compat {
  return parseCompat(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Parsed `godot --version` output, e.g. `4.5.1.stable.mono.official.f62fdbde1`. */
export interface GodotVersionInfo {
  raw: string;
  version: string;
  status: string;
  flavor: 'mono' | 'standard';
  build: string | null;
  hash: string | null;
}

const VERSION_RE = /^(\d+\.\d+(?:\.\d+)?)\.([a-z]+\d*)(?:\.(mono))?(?:\.([a-z_]+))?(?:\.([0-9a-f]{6,40}))?$/;

/**
 * Parse the first line of `godot --version`. Godot omits the patch for `.0` releases (`4.3.stable.mono…`);
 * the result normalises that to `4.3.0`. Returns null for output that is not a Godot version line.
 */
export function parseGodotVersion(output: string): GodotVersionInfo | null {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+\.\d+/.test(l));
  if (!line) return null;
  const m = VERSION_RE.exec(line);
  if (!m) return null;
  const [, ver, status, mono, build, hash] = m;
  const version = ver!.split('.').length === 2 ? `${ver}.0` : ver!;
  return {
    raw: line,
    version,
    status: status!,
    flavor: mono ? 'mono' : 'standard',
    build: build ?? null,
    hash: hash ?? null,
  };
}

export type GodotPinCheck = { ok: true; info: GodotVersionInfo } | { ok: false; reason: string; found: string | null };

/** Check a `godot --version` output against the manifest pin. The Studio refuses anything but an exact match. */
export function checkGodotPin(output: string, compat: Compat): GodotPinCheck {
  const info = parseGodotVersion(output);
  const required = `${compat.godot.version} ${compat.godot.flavor} (stable)`;
  if (!info)
    return {
      ok: false,
      found: null,
      reason: `Unrecognised 'godot --version' output; ModuleX Studio requires Godot ${required}.`,
    };
  const found = `${info.version} ${info.flavor} (${info.status})`;
  if (info.version !== compat.godot.version || info.flavor !== compat.godot.flavor || info.status !== 'stable') {
    return { ok: false, found, reason: `Godot ${found} found, but ModuleX Studio requires Godot ${required}.` };
  }
  return { ok: true, info };
}
