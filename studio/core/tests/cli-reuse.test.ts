// SPDX-License-Identifier: Apache-2.0
//
// Studio Core reuses the godot-cli library (workspace dependency file:../../cli) instead of re-implementing
// project scaffolding, addon install and tool calls. This pins the functions Core depends on.
import { describe, expect, it } from 'vitest';
import * as cli from 'godot-cli';

describe('godot-cli library reuse', () => {
  it.each([
    'createProject',
    'installPlugin',
    'installServer',
    'buildProject',
    'openProject',
    'runTool',
    'runSystemTool',
  ])('exports %s', (name) => {
    expect(typeof (cli as Record<string, unknown>)[name]).toBe('function');
  });
});
