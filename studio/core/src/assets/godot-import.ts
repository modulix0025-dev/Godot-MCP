// SPDX-License-Identifier: Apache-2.0
//
// Godot import (Phase 8). A model reaches res:// ONLY after `validateGlb` passes — the importer re-validates the
// exact bytes it copies, so a caller cannot skip it. Then, through the policy-gated GodotClient:
//
//   1 checkpoint  2 copy to res://assets/generated/<category>/<assetId>/<name>.glb  3 filesystem-reimport (full
//   scan, D-007)  4 resource-find  5 project-validate-resources scoped to the file  6 instance it into a scratch
//   scene  7 scene-get-data shows a MeshInstance3D  8 screenshot-isolated thumbnail, rejected when blank
//   9 reopen the scene that was open before. The scratch scene is per-import and lives in the git-ignored
//   res://.modulex/scratch/ (hidden from Godot's filesystem dock); node-delete is destructive-tier and would need
//   an owner approval, which a scratch clean-up must never ask for.
//
// A failure after the copy restores the pre-import checkpoint, so a half-imported asset never stays in the project.
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { ProjectCheckpoints } from '../checkpoints/project-checkpoints.js';
import { GodotClient, type GodotToolResult } from '../godot/godot-call.js';
import { validateGlb, type AssetCategory, type ValidateOptions, type ValidationRow } from './validate.js';

export interface ImportRequest {
  projectDir: string;
  assetId: string;
  category: AssetCategory;
  name: string;
  bytes: Uint8Array;
  validation?: Omit<ValidateOptions, 'category'>;
  /** Render a thumbnail (needs a GPU / a non-headless editor). */
  thumbnail?: boolean;
}

export interface ImportResult {
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL_SUCCESS';
  res_path: string | null;
  rows: ValidationRow[];
  thumbnail_png: Buffer | null;
  reason: string | null;
}

export const scratchScene = (assetId: string) => `res://.modulex/scratch/inspect-${assetId}.tscn`;

/** Decode an 8-bit, non-interlaced PNG (greyscale/RGB/RGBA) to raw pixels. Enough for editor screenshots. */
export function decodePng(png: Buffer): { width: number; height: number; channels: number; pixels: Uint8Array } {
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      if (depth !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs are supported');
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour!] ?? 0;
      if (!channels) throw new Error(`unsupported PNG colour type ${colour}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const pred =
        f === 0
          ? 0
          : f === 1
            ? a
            : f === 2
              ? b
              : f === 3
                ? (a + b) >> 1
                : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
                  ? a
                  : Math.abs(p - b) <= Math.abs(p - c)
                    ? b
                    : c;
      out[y * stride + x] = (src[x]! + pred) & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

/** Luminance variance of an image; a thumbnail with (almost) no variance shows nothing. */
export function pixelVariance(png: Buffer): number {
  const { channels, pixels } = decodePng(png);
  let sum = 0;
  let sq = 0;
  const n = pixels.length / channels;
  for (let i = 0; i < pixels.length; i += channels) {
    const l = channels >= 3 ? 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]! : pixels[i]!;
    sum += l;
    sq += l * l;
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

export function looksBlank(png: Buffer, minVariance = 4): boolean {
  try {
    return pixelVariance(png) < minVariance;
  } catch {
    return true;
  }
}

function findNode(tree: unknown, type: string): boolean {
  if (!tree || typeof tree !== 'object') return false;
  const n = tree as { type?: string; children?: unknown[] };
  return n.type === type || (n.children ?? []).some((c) => findNode(c, type));
}

export class GodotAssetImporter {
  constructor(
    private readonly godot: {
      client: Pick<GodotClient, 'call'>;
      checkpoints: Pick<ProjectCheckpoints, 'checkpoint' | 'restore'>;
    },
    private readonly opts: { importWaitMs?: number } = {},
  ) {}

  private async call(tool: string, args: Record<string, unknown>): Promise<GodotToolResult> {
    return this.godot.client.call({ tool, args, role: '3d-asset-producer' });
  }

  async import(req: ImportRequest): Promise<ImportResult> {
    const rows: ValidationRow[] = [];
    const add = (check: string, ok: boolean, detail: string) => rows.push({ check, ok, detail });
    const fail = (reason: string, res_path: string | null = null): ImportResult => ({
      status: 'FAILED',
      res_path,
      rows,
      thumbnail_png: null,
      reason,
    });

    const verdict = await validateGlb(req.bytes, { category: req.category, ...req.validation });
    rows.push(...verdict.rows);
    if (verdict.status !== 'SUCCESS')
      return fail(
        `validation failed: ${verdict.rows
          .filter((r) => !r.ok)
          .map((r) => r.check)
          .join(', ')}`,
      );

    const safeName = req.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'model';
    const res_path = `res://assets/generated/${req.category}/${req.assetId}/${safeName}.glb`;
    const cp = await this.godot.checkpoints.checkpoint(`before importing ${req.assetId}`);
    add('checkpoint', true, cp.name);
    const file = join(req.projectDir, res_path.slice('res://'.length));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, req.bytes);
    add('copy', true, res_path);

    const rollback = async (reason: string) => {
      await this.godot.checkpoints.restore(cp.name).catch(() => undefined);
      return fail(`${reason} (restored ${cp.name})`, null);
    };

    const scan = await this.call('filesystem-reimport', {});
    add('reimport', scan.ok, scan.ok ? 'full filesystem scan' : GodotClient.text(scan));
    if (!scan.ok) return rollback('filesystem-reimport failed');

    // A windowed editor scans and imports asynchronously; poll until Godot resolves the file (bounded).
    let known = false;
    let foundText = '';
    const started = Date.now();
    for (let attempt = 0; !known && Date.now() - started < (this.opts.importWaitMs ?? 60_000); attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        if (attempt % 10 === 0) await this.call('filesystem-reimport', {});
      }
      const found = await this.call('resource-find', { resourcePath: res_path });
      foundText = JSON.stringify(found.result ?? GodotClient.text(found));
      known = found.ok && foundText.includes(res_path);
    }
    add(
      'resource_find',
      known,
      known
        ? `Godot resolves the imported scene (${Math.round((Date.now() - started) / 100) / 10}s)`
        : foundText.slice(0, 200),
    );
    if (!known) return rollback('Godot did not import the file');

    const check = await this.call('project-validate-resources', { scope: res_path });
    const checkOk = check.ok && (check.result as { ok?: boolean } | null)?.ok !== false;
    add(
      'validate_resources',
      checkOk,
      checkOk ? 'loads, no missing dependencies' : JSON.stringify(check.result).slice(0, 300),
    );
    if (!checkOk) return rollback('project-validate-resources reported problems');

    const opened = ((await this.call('scene-list-opened', {})).result ?? null) as unknown;
    const previous = JSON.stringify(opened).match(/res:\/\/[^"]+\.tscn/)?.[0] ?? null;
    const scratch = await this.call('scene-create', {
      resourcePath: scratchScene(req.assetId),
      rootTypeClassName: 'Node3D',
      rootName: 'Inspect',
    });
    if (!scratch.ok) return rollback(`scratch scene: ${GodotClient.text(scratch)}`);
    const inst = await this.call('node-create', { name: 'Candidate', instanceScenePath: res_path });
    const instData = inst.result as { instanceId?: number; path?: string } | null;
    add('instance', inst.ok, inst.ok ? `instanced as ${instData?.path ?? 'Candidate'}` : GodotClient.text(inst));
    if (!inst.ok) return rollback('the model could not be instanced');

    const tree = await this.call('scene-get-data', { hierarchyDepth: -1 });
    const hasMesh = findNode(tree.result, 'MeshInstance3D');
    add('scene_tree', hasMesh, hasMesh ? 'MeshInstance3D present' : 'no MeshInstance3D in the instanced model');
    if (req.validation?.rigged) {
      const rig = findNode(tree.result, 'Skeleton3D');
      add('scene_rig', rig, rig ? 'Skeleton3D present' : 'no Skeleton3D');
      if (!rig) return rollback('rig missing after import');
    }
    if (!hasMesh) return rollback('no mesh after import');

    let thumbnail_png: Buffer | null = null;
    let partial: string | null = null;
    const nodeRef = instData?.instanceId
      ? { instanceId: instData.instanceId }
      : { path: instData?.path ?? 'Candidate' };
    if (req.thumbnail !== false) {
      const shot = await this.call('screenshot-isolated', { nodeRef, cameraView: 'Front', resolution: 512 });
      const img = shot.content.find((c) => c.type === 'image' && c.data);
      if (shot.ok && img?.data) {
        thumbnail_png = Buffer.from(img.data, 'base64');
        const variance = (() => {
          try {
            return pixelVariance(thumbnail_png);
          } catch {
            return 0;
          }
        })();
        const blank = variance < 4;
        add(
          'thumbnail',
          !blank,
          `${thumbnail_png.length}-byte PNG, luminance variance ${variance.toFixed(1)}${blank ? ' (blank)' : ''}`,
        );
        if (blank) return rollback('the thumbnail is blank (nothing visible)');
      } else {
        partial = `thumbnail not rendered: ${GodotClient.text(shot).slice(0, 200)}`;
        add('thumbnail', true, `skipped — ${partial}`);
      }
    }
    if (previous) await this.call('scene-open', { resourcePath: previous });
    add('cleanup', true, previous ? `reopened ${previous}` : 'scratch scene left in .modulex/scratch');
    return { status: partial ? 'PARTIAL_SUCCESS' : 'SUCCESS', res_path, rows, thumbnail_png, reason: partial };
  }
}
