// SPDX-License-Identifier: Apache-2.0
//
// Post-processing (Phase 8) with glTF-Transform (MIT) + meshoptimizer (MIT): weld, dedup, prune, simplify to the
// category triangle budget, normalise scale, and ground/centre at the origin. Each operation reports what it did.
// Texture resizing needs an image codec and is reported as skipped; UV unwrap, rigging and animation are never
// faked — they need an external adapter (Blender) or a workflow with that capability.
import { NodeIO, getBounds, type Document } from '@gltf-transform/core';
import { dedup, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { AssetCategory } from './validate.js';
import { DEFAULT_RULES } from './validate.js';

export interface ProcessStep {
  step: string;
  status: 'done' | 'skipped';
  detail: string;
}

export interface ProcessOptions {
  category: AssetCategory;
  /** Target size in metres: character height, or the largest dimension otherwise. */
  targetSize?: number;
  maxTriangles?: number;
}

const DEFAULT_TARGET: Record<AssetCategory, number> = { character: 1.7, prop: 1, environment: 20 };

function triangles(doc: Document): number {
  let t = 0;
  for (const m of doc.getRoot().listMeshes())
    for (const p of m.listPrimitives()) {
      if (p.getMode() !== 4) continue;
      t += Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3);
    }
  return t;
}

export async function processGlb(
  bytes: Uint8Array,
  o: ProcessOptions,
): Promise<{ bytes: Uint8Array; steps: ProcessStep[] }> {
  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const steps: ProcessStep[] = [];
  const before = triangles(doc);
  await doc.transform(weld(), dedup(), prune());
  steps.push({
    step: 'cleanup',
    status: 'done',
    detail: `weld + dedup + prune (${before} → ${triangles(doc)} triangles)`,
  });

  const budget = o.maxTriangles ?? DEFAULT_RULES[o.category].maxTriangles;
  const tris = triangles(doc);
  if (tris > budget) {
    await MeshoptSimplifier.ready;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: (budget / tris) * 0.95, error: 0.01 }));
    steps.push({
      step: 'optimisation',
      status: 'done',
      detail: `simplified ${tris} → ${triangles(doc)} triangles (budget ${budget})`,
    });
  } else steps.push({ step: 'optimisation', status: 'skipped', detail: `${tris} triangles within budget ${budget}` });

  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (scene) {
    const { min, max } = getBounds(scene);
    const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const measured = o.category === 'character' ? dims[1]! : Math.max(...dims);
    const target = o.targetSize ?? DEFAULT_TARGET[o.category];
    if (measured > 0 && Number.isFinite(measured)) {
      const k = target / measured;
      const cx = (min[0] + max[0]) / 2;
      const cz = (min[2] + max[2]) / 2;
      // Wrap the scene's roots in one node that scales and moves the model: feet on y=0, centred in x/z.
      const wrapper = doc
        .createNode('modulex_normalised')
        .setScale([k, k, k])
        .setTranslation([-cx * k, -min[1] * k, -cz * k]);
      for (const child of scene.listChildren()) {
        scene.removeChild(child);
        wrapper.addChild(child);
      }
      scene.addChild(wrapper);
      steps.push({
        step: 'normalise',
        status: 'done',
        detail: `scaled ×${k.toPrecision(4)} to ${target} m, grounded and centred`,
      });
    } else steps.push({ step: 'normalise', status: 'skipped', detail: 'empty bounds' });
  }
  steps.push({
    step: 'texture_resize',
    status: 'skipped',
    detail: 'no image codec configured (textures kept as generated)',
  });
  return { bytes: await io.writeBinary(doc), steps };
}
