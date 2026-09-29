// SPDX-License-Identifier: Apache-2.0
//
// Setup Assistant back-end (Phase 4, Execution Patch 1 §7): resumable, checksum-verified downloads of the heavy
// runtimes (Godot 4.5.1 mono, export templates, .NET 8 SDK, JDK, Android SDK). The installer stays small; these
// are fetched on demand.
//   - resume: a partial `<file>.part` continues with an HTTP Range request (falls back to a full download when
//     the server ignores Range);
//   - verify: the digest must match the official checksum file (SHA-512 for Godot's SHA512-SUMS.txt, SHA-256
//     elsewhere) BEFORE the file is renamed into place — an unverified file is never used;
//   - progress events for the UI.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadSpec {
  url: string;
  dest: string;
  algorithm: 'sha256' | 'sha512';
  /** Expected hex digest (from the official checksum file). */
  digest: string;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
  resumed: boolean;
}

export async function fileDigest(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const h = createHash(algorithm);
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/** Parse a `<hex>  <filename>` checksum file (sha256sum / sha512sum / Godot SHA512-SUMS.txt format). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64,128})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

export async function download(spec: DownloadSpec, onProgress?: (p: DownloadProgress) => void): Promise<string> {
  mkdirSync(dirname(spec.dest), { recursive: true });
  if (existsSync(spec.dest) && (await fileDigest(spec.dest, spec.algorithm)) === spec.digest.toLowerCase())
    return spec.dest;
  const part = `${spec.dest}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(spec.url, { headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${spec.url}`);
  const resumed = res.status === 206 && have > 0;
  if (!resumed && have) rmSync(part);
  const length = Number(res.headers.get('content-length') ?? NaN);
  const total = Number.isFinite(length) ? length + (resumed ? have : 0) : null;
  let received = resumed ? have : 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (c: Buffer) => {
    received += c.length;
    onProgress?.({ received, total, resumed });
  });
  await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  const got = await fileDigest(part, spec.algorithm);
  if (got !== spec.digest.toLowerCase()) {
    rmSync(part);
    throw new Error(
      `checksum mismatch for ${spec.url}: got ${got.slice(0, 16)}…, expected ${spec.digest.slice(0, 16)}… (file discarded)`,
    );
  }
  renameSync(part, spec.dest);
  return spec.dest;
}

/** Official download locations for the pinned Godot build (GitHub release assets + SHA512-SUMS.txt). */
export function godotDownloads(version: string, platform: 'windows' | 'linux' | 'macos') {
  const base = `https://github.com/godotengine/godot-builds/releases/download/${version}-stable`;
  const editor =
    platform === 'windows'
      ? `Godot_v${version}-stable_mono_win64.zip`
      : platform === 'linux'
        ? `Godot_v${version}-stable_mono_linux_x86_64.zip`
        : `Godot_v${version}-stable_mono_macos.universal.zip`;
  return {
    sums: `${base}/SHA512-SUMS.txt`,
    editor: { name: editor, url: `${base}/${editor}` },
    templates: {
      name: `Godot_v${version}-stable_mono_export_templates.tpz`,
      url: `${base}/Godot_v${version}-stable_mono_export_templates.tpz`,
    },
  };
}
