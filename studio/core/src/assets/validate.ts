// SPDX-License-Identifier: Apache-2.0
//
// GLB validation (Phase 8). Every generated or imported model passes here BEFORE it may be copied into res://.
// Each check yields an evidence row; any failed row makes the verdict FAILED and the file is not imported.
//
//   container   magic "glTF", version 2, length header = file size, a JSON chunk first
//   khronos     the Khronos glTF-Validator (Apache-2.0) reports no errors
//   mesh        at least one mesh primitive with POSITION data
//   material    materials/textures present when the stage says "textured"
//   finite      no NaN/Infinity positions
//   surface     non-zero surface area; degenerate-triangle ratio under the threshold
//   budget      triangle count within the category budget; file size under the cap
//   scale       bounding box within the category range (after normalisation)
//   rig         when rigged: a skin exists, its joints form one hierarchy, animations target existing nodes
import { NodeIO, type Document } from '@gltf-transform/core';
import { validateBytes } from 'gltf-validator';

export type AssetCategory = 'character' | 'prop' | 'environment';

export interface CategoryRules {
  maxTriangles: number;
  /** Largest bounding-box dimension, in metres. For characters this is the height (Y). */
  size: { min: number; max: number; axis: 'max' | 'y' };
}

export const DEFAULT_RULES: Record<AssetCategory, CategoryRules> = {
  character: { maxTriangles: 60_000, size: { min: 0.5, max: 3, axis: 'y' } },
  prop: { maxTriangles: 20_000, size: { min: 0.05, max: 10, axis: 'max' } },
  environment: { maxTriangles: 200_000, size: { min: 1, max: 1000, axis: 'max' } },
};

export interface ValidationRow {
  check: string;
  ok: boolean;
  detail: string;
}

export interface GlbStats {
  bytes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  skins: number;
  animations: number;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  surfaceArea: number;
  degenerateRatio: number;
}

export interface GlbVerdict {
  status: 'SUCCESS' | 'FAILED';
  rows: ValidationRow[];
  stats: GlbStats | null;
}

export interface ValidateOptions {
  category: AssetCategory;
  rules?: Partial<CategoryRules>;
  maxBytes?: number;
  textured?: boolean;
  rigged?: boolean;
  /** Skip the scale check (raw worker output, before normalisation). */
  checkScale?: boolean;
  maxDegenerateRatio?: number;
}

/** Container-level checks that need no parser (also used on download). */
export function glbContainerProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 20) return 'file too small to be a GLB';
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString('ascii', 0, 4) !== 'glTF') return 'bad magic (not a GLB)';
  if (b.readUInt32LE(4) !== 2) return `unsupported container version ${b.readUInt32LE(4)}`;
  if (b.readUInt32LE(8) !== b.length) return `length header ${b.readUInt32LE(8)} ≠ file size ${b.length}`;
  if (b.readUInt32LE(16) !== 0x4e4f534a) return 'first chunk is not JSON';
  return null;
}

function stats(doc: Document, bytes: number): GlbStats {
  const root = doc.getRoot();
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;
  let area = 0;
  let degenerate = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let nonFinite = false;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      primitives++;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      if (!arr) continue;
      const count = pos.getCount();
      vertices += count;
      for (let i = 0; i < count * 3; i++) {
        const v = arr[i]!;
        if (!Number.isFinite(v)) {
          nonFinite = true;
          continue;
        }
        const k = i % 3;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const idx = prim.getIndices()?.getArray() ?? null;
      const n = idx ? idx.length : count;
      const tri = Math.floor(n / 3);
      triangles += tri;
      const at = (j: number) => (idx ? idx[j]! : j);
      for (let t = 0; t < tri; t++) {
        const a = at(3 * t) * 3;
        const b = at(3 * t + 1) * 3;
        const c = at(3 * t + 2) * 3;
        const ux = arr[b]! - arr[a]!;
        const uy = arr[b + 1]! - arr[a + 1]!;
        const uz = arr[b + 2]! - arr[a + 2]!;
        const vx = arr[c]! - arr[a]!;
        const vy = arr[c + 1]! - arr[a + 1]!;
        const vz = arr[c + 2]! - arr[a + 2]!;
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        const s = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
        if (!Number.isFinite(s) || s < 1e-12) degenerate++;
        else area += s;
      }
    }
  const s: GlbStats = {
    bytes,
    meshes: root.listMeshes().length,
    primitives,
    triangles,
    vertices,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    skins: root.listSkins().length,
    animations: root.listAnimations().length,
    bbox: Number.isFinite(min[0]) ? { min, max } : null,
    surfaceArea: area,
    degenerateRatio: triangles ? degenerate / triangles : 0,
  };
  if (nonFinite) (s as GlbStats & { nonFinite?: boolean }).nonFinite = true;
  return s;
}

export async function validateGlb(bytes: Uint8Array, o: ValidateOptions): Promise<GlbVerdict> {
  const rows: ValidationRow[] = [];
  const add = (check: string, ok: boolean, detail: string) => rows.push({ check, ok, detail });
  const rules = { ...DEFAULT_RULES[o.category], ...o.rules };
  const maxBytes = o.maxBytes ?? 50 * 1024 * 1024;

  const container = glbContainerProblem(bytes);
  add('container', !container, container ?? 'glTF 2.0 binary container');
  if (container) return { status: 'FAILED', rows, stats: null };
  add('file_size', bytes.length <= maxBytes, `${bytes.length} bytes (cap ${maxBytes})`);

  const report = await validateBytes(new Uint8Array(bytes), { maxIssues: 50 });
  const errs = report.issues.messages.filter((m) => m.severity === 0);
  add(
    'khronos_validator',
    report.issues.numErrors === 0,
    report.issues.numErrors === 0
      ? `0 errors, ${report.issues.numWarnings} warnings`
      : `${report.issues.numErrors} errors: ${errs
          .slice(0, 3)
          .map((m) => `${m.code}${m.pointer ? ` at ${m.pointer}` : ''}`)
          .join('; ')}`,
  );

  let doc: Document;
  try {
    doc = await new NodeIO().readBinary(new Uint8Array(bytes));
  } catch (e) {
    add('parse', false, (e as Error).message);
    return { status: 'FAILED', rows, stats: null };
  }
  const s = stats(doc, bytes.length);
  add(
    'mesh',
    s.primitives > 0 && s.vertices > 0,
    `${s.meshes} mesh(es), ${s.primitives} primitive(s), ${s.vertices} vertices`,
  );
  if (o.textured)
    add('material', s.materials > 0 && s.textures > 0, `${s.materials} material(s), ${s.textures} texture(s)`);
  const nonFinite = (s as GlbStats & { nonFinite?: boolean }).nonFinite === true;
  add('finite', !nonFinite, nonFinite ? 'NaN or infinite vertex positions' : 'all positions finite');
  const maxDeg = o.maxDegenerateRatio ?? 0.1;
  add(
    'surface',
    s.surfaceArea > 0 && s.degenerateRatio <= maxDeg,
    `area ${s.surfaceArea.toPrecision(4)} m², degenerate ${(s.degenerateRatio * 100).toFixed(1)}% (max ${maxDeg * 100}%)`,
  );
  add('triangle_budget', s.triangles <= rules.maxTriangles, `${s.triangles} triangles (budget ${rules.maxTriangles})`);
  if (o.checkScale !== false && s.bbox) {
    const dims = [0, 1, 2].map((k) => s.bbox!.max[k]! - s.bbox!.min[k]!);
    const measured = rules.size.axis === 'y' ? dims[1]! : Math.max(...dims);
    add(
      'scale',
      measured >= rules.size.min && measured <= rules.size.max,
      `${rules.size.axis === 'y' ? 'height' : 'largest dimension'} ${measured.toFixed(3)} m (range ${rules.size.min}–${rules.size.max} m)`,
    );
  }
  if (o.rigged) {
    const skin = doc.getRoot().listSkins()[0];
    const joints = skin?.listJoints() ?? [];
    const jointSet = new Set(joints);
    const roots = joints.filter((j) => !j.getParentNode() || !jointSet.has(j.getParentNode()!));
    add('rig_skin', Boolean(skin) && joints.length > 0, skin ? `${joints.length} joint(s)` : 'no skin');
    add('rig_hierarchy', joints.length > 0 && roots.length === 1, `${roots.length} root joint(s)`);
    const nodes = new Set(doc.getRoot().listNodes());
    const broken = doc
      .getRoot()
      .listAnimations()
      .flatMap((a) => a.listChannels())
      .filter((c) => !c.getTargetNode() || !nodes.has(c.getTargetNode()!));
    add(
      'rig_animations',
      broken.length === 0,
      `${s.animations} animation(s), ${broken.length} channel(s) without a valid target`,
    );
  }
  return { status: rows.every((r) => r.ok) ? 'SUCCESS' : 'FAILED', rows, stats: s };
}
