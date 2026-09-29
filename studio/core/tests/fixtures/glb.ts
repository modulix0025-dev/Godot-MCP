// SPDX-License-Identifier: Apache-2.0
//
// Minimal GLB writer for fixtures (Phase 7/8 gates): a grid mesh with N×N quads, optionally with NaN positions,
// no meshes, a broken magic, or a skin. Produces spec-conformant glTF 2.0 binary containers.

export interface GlbOptions {
  /** Quads per side; triangles = 2 × n². */
  n?: number;
  size?: number;
  nan?: boolean;
  noMesh?: boolean;
  badMagic?: boolean;
  skin?: boolean;
  /** All triangles collapsed onto a line. */
  degenerate?: boolean;
}

function pad4(b: Buffer, fill: number): Buffer {
  const r = b.length % 4;
  return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b;
}

export function makeGlb(o: GlbOptions = {}): Buffer {
  const n = o.n ?? 4;
  const size = o.size ?? 1;
  const verts: number[] = [];
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++)
      verts.push(
        (x / n - 0.5) * size,
        o.degenerate ? 0 : (((x + z) % 2) * size) / 10,
        o.degenerate ? 0 : (z / n - 0.5) * size,
      );
  if (o.nan) verts[4] = Number.NaN;
  const idx: number[] = [];
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  const pos = Buffer.from(new Float32Array(verts).buffer);
  const ind = Buffer.from(new Uint32Array(idx).buffer);
  const min = [0, 1, 2].map((k) => Math.min(...verts.filter((_, i) => i % 3 === k).filter((v) => !Number.isNaN(v))));
  const max = [0, 1, 2].map((k) => Math.max(...verts.filter((_, i) => i % 3 === k).filter((v) => !Number.isNaN(v))));
  let bin = Buffer.concat([pos, ind]);
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'modulex-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [o.noMesh ? { name: 'empty' } : { name: 'grid', mesh: 0 }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: ind.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  if (!o.noMesh) json.meshes = [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }];
  if (o.skin) {
    const ibm = Buffer.from(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer);
    const offset = bin.length;
    bin = Buffer.concat([bin, ibm]);
    (json.buffers as { byteLength: number }[])[0]!.byteLength = bin.length;
    (json.bufferViews as unknown[]).push({ buffer: 0, byteOffset: offset, byteLength: ibm.length });
    (json.accessors as unknown[]).push({ bufferView: 2, componentType: 5126, count: 1, type: 'MAT4' });
    (json.nodes as unknown[]).push({ name: 'root_joint' });
    (json.scenes as { nodes: number[] }[])[0]!.nodes.push(1);
    json.skins = [{ joints: [1], inverseBindMatrices: 2 }];
    (json.nodes as Record<string, unknown>[])[0]!.skin = 0;
  }
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  bin = pad4(bin, 0);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.write(o.badMagic ? 'gltX' : 'glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
