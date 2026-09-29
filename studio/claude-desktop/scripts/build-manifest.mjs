// SPDX-License-Identifier: Apache-2.0
//
// Generates bundle/manifest.json (MCPB manifest v0.3) from the Studio policy catalogue, so the tools declared to
// Claude Desktop are exactly the Claude-Desktop-exposed, implemented studio tools — never raw engine tools.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advertisedTools, DEV_MODE_OFF } from '@modulex/shared';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
mkdirSync(resolve(root, 'bundle/server'), { recursive: true });

const tools = advertisedTools('claude-desktop', DEV_MODE_OFF).map((t) => ({ name: t.id, description: t.summary }));

const manifest = {
  manifest_version: '0.3',
  name: 'modulex-game-studio',
  display_name: 'ModuleX Game Studio',
  version: pkg.version,
  description: 'Create, test and build games with ModuleX Game Studio from Claude.',
  long_description:
    "Connects Claude Desktop to the ModuleX Game Studio app running on this computer. Claude can plan a game (Game Specification), start and follow the build pipeline, read manifests, and check workers and builds. Destructive actions always require the owner's approval inside ModuleX Game Studio; raw engine tools, credentials and worker secrets are never exposed.",
  author: { name: 'ModuleX' },
  license: 'Apache-2.0',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.mjs'],
      env: { MODULEX_CORE_URL: '${user_config.core_url}', MODULEX_PAIRING_TOKEN: '${user_config.pairing_token}' },
    },
  },
  tools,
  tools_generated: false,
  keywords: ['game', 'godot', 'game-development', 'modulex'],
  compatibility: { platforms: ['win32', 'darwin'], runtimes: { node: '>=18.0.0' } },
  user_config: {
    pairing_token: {
      type: 'string',
      title: 'Pairing token',
      description: 'From ModuleX Game Studio → Settings → AI Providers → Claude Desktop → "Copy pairing token".',
      sensitive: true,
      required: true,
    },
    core_url: {
      type: 'string',
      title: 'Studio address',
      description: 'Local address of ModuleX Game Studio. Change only if Settings shows a different port.',
      default: 'http://127.0.0.1:47821',
      required: true,
    },
  },
};

writeFileSync(resolve(root, 'bundle/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(resolve(repo, 'studio/branding/png/icon-512.png'), resolve(root, 'bundle/icon.png'));
copyFileSync(resolve(repo, 'LICENSE'), resolve(root, 'bundle/LICENSE'));
console.log(`manifest.json: ${tools.length} tools (${tools.map((t) => t.name).join(', ')})`);
