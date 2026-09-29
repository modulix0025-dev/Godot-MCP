// SPDX-License-Identifier: Apache-2.0
//
// Godot installation registry (Phase 4). Candidates come from the owner's configured paths plus godot-cli's own
// resolution order (explicit path → GODOT_BIN/GODOT4_BIN → PATH → common install roots), and every candidate is
// VERIFIED by running `godot --version` against the compat.json pin. A mismatch is refused with the found and
// required versions — never silently used.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { findGodotBinary } from 'godot-cli';
import { checkGodotPin, type Compat } from '@modulex/shared';

const run = promisify(execFile);

export interface GodotInstallation {
  path: string;
  version: string | null;
  ok: boolean;
  reason: string | null;
}

/** Run `<bin> --version` (headless, 30 s cap) and check it against the pin. */
export async function verifyGodot(bin: string, compat: Compat): Promise<GodotInstallation> {
  const path = resolve(bin);
  if (!existsSync(path)) return { path, version: null, ok: false, reason: 'file not found' };
  let out: string;
  try {
    const r = await run(path, ['--version', '--headless'], { timeout: 30_000, windowsHide: true });
    out = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (!out.trim()) return { path, version: null, ok: false, reason: `could not run: ${err.message}` };
  }
  const pin = checkGodotPin(out, compat);
  if (pin.ok) return { path, version: pin.info.raw, ok: true, reason: null };
  return {
    path,
    version: pin.found,
    ok: false,
    reason: `${pin.reason} (found ${pin.found ?? 'unknown'}, required ${compat.godot.versionPrefix})`,
  };
}

/** Discover and verify every candidate; the first verified one is the default. */
export async function discoverGodot(compat: Compat, configured: string[] = []): Promise<GodotInstallation[]> {
  const candidates = new Set<string>();
  for (const c of configured) if (c.trim()) candidates.add(resolve(c));
  const found = findGodotBinary();
  if (found) candidates.add(found);
  const out: GodotInstallation[] = [];
  for (const c of candidates) out.push(await verifyGodot(c, compat));
  return out.sort((a, b) => Number(b.ok) - Number(a.ok));
}
