// SPDX-License-Identifier: Apache-2.0
//
// The release-feed half of the production UpdatePlatform (Phase 13, D-058). UpdateManager owns the order and the
// safety rules; this supplies the steps that decide whether an installer may run at all:
//
//   fetchFeed         GET the channel feed (a JSON array of ReleaseManifest), size-capped
//   download          GET the installer, size-capped, into memory
//   verifySignature   minisign (Ed25519 + BLAKE2b-512) by the PUBLIC key embedded in this build; the manifest's
//                     sha256 is checked by UpdateManager as well
//
// The public key is built into the app (it stays empty until the owner creates the update signing key; the private
// key lives only in the owner's CI secrets). With no key configured every signature check fails closed, so an
// unsigned or foreign update can never be installed. Updates are never automatic: UpdateManager.apply is owner-only.
import type { ReleaseManifest } from '@modulex/shared';
import { verifyMinisign } from './minisign.js';
import type { UpdatePlatform } from './updates.js';

export interface ReleaseFeedOptions {
  feedUrl: string;
  /** minisign public key text (or Tauri's base64 wrapper). Empty → updates cannot be verified (fail-closed). */
  publicKey: string;
  maxFeedBytes?: number;
  maxInstallerBytes?: number;
  fetchImpl?: typeof fetch;
}

async function capped(r: Response, max: number, what: string): Promise<Buffer> {
  if (!r.ok || !r.body) throw new Error(`${what}: HTTP ${r.status}`);
  const declared = Number(r.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error(`${what}: ${declared} bytes exceeds ${max}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new Error(`${what}: larger than ${max} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

export function releaseFeedSteps(
  o: ReleaseFeedOptions,
): Pick<UpdatePlatform, 'fetchFeed' | 'download' | 'verifySignature'> {
  const f = o.fetchImpl ?? fetch;
  return {
    async fetchFeed() {
      const body = await capped(await f(o.feedUrl), o.maxFeedBytes ?? 1 << 20, 'update feed');
      const parsed = JSON.parse(body.toString('utf-8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('update feed: expected a JSON array of releases');
      return parsed;
    },
    async download(r: ReleaseManifest) {
      if (!r.url.startsWith('https://')) throw new Error('update download must use https');
      return capped(await f(r.url), o.maxInstallerBytes ?? 512 * 1024 * 1024, `download ${r.version}`);
    },
    async verifySignature(bytes: Buffer, r: ReleaseManifest) {
      if (!o.publicKey.trim()) return false;
      return verifyMinisign(bytes, r.signature, o.publicKey);
    },
  };
}
