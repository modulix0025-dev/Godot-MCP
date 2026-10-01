// SPDX-License-Identifier: Apache-2.0
//
// minisign signature verification (the format the Tauri updater signs releases with), on Node's built-in crypto:
// Ed25519 and BLAKE2b-512. Used by the release-feed update platform before an installer is ever run.
//
//   public key   "untrusted comment: …\n" + base64( "Ed" | key_id[8] | ed25519_pk[32] )
//   signature    "untrusted comment: …\n" + base64( alg[2] | key_id[8] | sig[64] ) + "\n"
//                "trusted comment: …\n"    + base64( global_sig[64] )
//
// alg "ED" signs BLAKE2b-512(file) (the default since minisign 0.8, used by Tauri); legacy "Ed" signs the raw
// bytes. The global signature covers sig[64] | trusted_comment and is always checked. Tauri wraps both files in
// one more layer of base64; that wrapper is accepted transparently.
import { createHash, createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function unwrap(text: string): string {
  const t = text.trim();
  if (t.startsWith('untrusted comment:')) return t;
  const decoded = Buffer.from(t, 'base64').toString('utf-8').trim();
  if (decoded.startsWith('untrusted comment:')) return decoded;
  throw new Error('not a minisign key or signature');
}

function lines(text: string): string[] {
  return unwrap(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface MinisignPublicKey {
  keyId: Buffer;
  key: Buffer;
}

export function parsePublicKey(text: string): MinisignPublicKey {
  const l = lines(text);
  const raw = Buffer.from(l[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw new Error('invalid minisign public key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

function ed25519Verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  return verify(null, message, key, signature);
}

/** True only when the signature is by this key, over these bytes, and its trusted comment is intact. */
export function verifyMinisign(data: Buffer, signatureText: string, publicKeyText: string): boolean {
  try {
    const pk = parsePublicKey(publicKeyText);
    const l = lines(signatureText);
    const sigRaw = Buffer.from(l[1] ?? '', 'base64');
    const trusted = l[2] ?? '';
    const globalSig = Buffer.from(l[3] ?? '', 'base64');
    if (sigRaw.length !== 74 || globalSig.length !== 64 || !trusted.startsWith('trusted comment: ')) return false;
    const alg = sigRaw.toString('latin1', 0, 2);
    const keyId = sigRaw.subarray(2, 10);
    const sig = sigRaw.subarray(10, 74);
    if (!keyId.equals(pk.keyId)) return false;
    let message: Buffer;
    if (alg === 'ED') message = createHash('blake2b512').update(data).digest();
    else if (alg === 'Ed') message = data;
    else return false;
    if (!ed25519Verify(pk.key, message, sig)) return false;
    const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf-8');
    return ed25519Verify(pk.key, Buffer.concat([sig, comment]), globalSig);
  } catch {
    return false;
  }
}
