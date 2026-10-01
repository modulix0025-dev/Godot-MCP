// SPDX-License-Identifier: Apache-2.0
//
// Third-party licence inventory (EXECUTION_PROMPT Phase 14). Lists what ModuleX Game Studio actually SHIPS or
// installs, from the real sources, never by hand:
//
//   core     npm packages inside the bundled Core (esbuild metafile of the production bundle — tree-shaken code
//            that never ships, such as `sharp`, is not listed)
//   ui       npm packages of the desktop UI (production dependency graph from package-lock.json)
//   cargo    Rust crates of the Windows shell (`cargo tree -e normal --target x86_64-pc-windows-msvc`); kept from
//            the previous inventory when cargo is not installed
//   nuget    packages the generated games and the addons reference (pinned in Godot-MCP.csproj)
//   binaries runtimes the installers bundle or the Setup Assistant installs
//   models   generative model licences declared by the built-in ComfyUI workflows (studio/workflows)
//
// Writes studio/third-party-licenses.json and docs/modulex/THIRD_PARTY_LICENSES.md. `--check` exits 1 when the
// committed files are stale. core/tests/licenses.test.ts enforces the licence policy on the JSON.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(studio, '..');
const JSON_OUT = join(studio, 'third-party-licenses.json');
const MD_OUT = join(repo, 'docs/modulex/THIRD_PARTY_LICENSES.md');

const lock = JSON.parse(readFileSync(join(studio, 'package-lock.json'), 'utf-8')).packages;
const cliLock = existsSync(join(repo, 'cli/package-lock.json'))
  ? JSON.parse(readFileSync(join(repo, 'cli/package-lock.json'), 'utf-8')).packages
  : {};

function meta(name) {
  const key = `node_modules/${name}`;
  const e = lock[key] ?? cliLock[key];
  let license = e?.license;
  let version = e?.version;
  for (const dir of [join(studio, key), join(repo, 'cli', key)]) {
    if ((license && version) || !existsSync(join(dir, 'package.json'))) continue;
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    license ??= typeof pj.license === 'string' ? pj.license : pj.license?.type;
    version ??= pj.version;
  }
  return { name, version: version ?? 'unknown', license: typeof license === 'string' ? license : 'UNKNOWN' };
}

export async function corePackages() {
  const r = await build({
    entryPoints: [join(studio, 'core/src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    metafile: true,
    logLevel: 'silent',
    absWorkingDir: join(studio, 'core'),
  });
  const names = new Set();
  for (const input of Object.keys(r.metafile.inputs)) {
    const all = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
    if (all.length) names.add(all[all.length - 1][1]);
    else if (/(^|\/)cli\/(dist|src)\//.test(input)) names.add('godot-cli');
  }
  names.delete('@modulex/shared');
  return [...names].sort().map((n) =>
    n === 'godot-cli'
      ? {
          name: 'godot-cli',
          version: JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf-8')).version,
          license: 'Apache-2.0',
        }
      : meta(n),
  );
}

export function uiPackages() {
  const seen = new Set();
  const walk = (deps) => {
    for (const d of Object.keys(deps ?? {})) {
      if (seen.has(d) || d.startsWith('@modulex/')) continue;
      seen.add(d);
      walk(lock[`node_modules/${d}`]?.dependencies);
    }
  };
  walk(lock['app/ui']?.dependencies);
  return [...seen].sort().map(meta);
}

/**
 * Core's declared runtime dependencies (and their own dependencies) that are NOT in the current bundle because no
 * code path from main.ts reaches them yet (e.g. the asset factory). Listed so the inventory is complete the moment
 * they are wired in; the test moves them to `core` automatically.
 */
export function coreDeclaredNotBundled(bundled) {
  const pj = JSON.parse(readFileSync(join(studio, 'core/package.json'), 'utf-8'));
  const inBundle = new Set(bundled.map((b) => b.name));
  const seen = new Set();
  const walk = (deps) => {
    for (const d of Object.keys(deps ?? {})) {
      if (seen.has(d) || d.startsWith('@modulex/') || d === 'godot-cli') continue;
      seen.add(d);
      walk(lock[`node_modules/${d}`]?.dependencies);
    }
  };
  walk(pj.dependencies);
  return [...seen]
    .filter((n) => !inBundle.has(n) && !lock[`node_modules/${n}`]?.optional)
    .sort()
    .map(meta);
}

function cargoCrates(previous) {
  try {
    const out = execFileSync(
      'cargo',
      ['tree', '-e', 'normal', '--target', 'x86_64-pc-windows-msvc', '--prefix', 'none', '-f', '{p}\t{l}'],
      { cwd: join(studio, 'app/src-tauri'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = new Map();
    for (const raw of out.split(/\r?\n/)) {
      // `cargo tree` marks repeated subtrees with "(*)". Remove it wherever it lands: on Windows the line does not
      // end with it (CI saw "MIT (*)" survive an end-anchored strip), so never rely on its position.
      const [p, l] = raw
        .replace(/\s*\(\*\)/g, '')
        .trim()
        .split('\t');
      const m = /^(\S+) v(\S+)/.exec(p ?? '');
      if (m && m[1] !== 'modulex-game-studio')
        rows.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2], license: (l ?? '').trim() || 'UNKNOWN' });
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  } catch {
    return previous ?? [];
  }
}

function models() {
  const dir = join(studio, 'workflows');
  const out = [];
  for (const id of readdirSync(dir).filter((d) => existsSync(join(dir, d, 'workflow.json')))) {
    const wf = JSON.parse(readFileSync(join(dir, id, 'workflow.json'), 'utf-8'));
    for (const f of wf.license_facts ?? [])
      out.push({
        workflow: id,
        subject: f.subject,
        license: f.license,
        commercial_use: f.commercial_use,
        conditions: f.conditions ?? null,
        evidence: f.evidence_url ?? null,
      });
  }
  return out;
}

const NUGET = [
  {
    name: 'com.IvanMurzak.ReflectorNet',
    version: '5.4.1',
    license: 'Apache-2.0',
    shipped:
      'referenced by the addons; restored from nuget.org into the user cache, stripped from RELEASE builds (D-042)',
  },
  {
    name: 'com.IvanMurzak.McpPlugin',
    version: '8.6.0',
    license: 'Apache-2.0',
    shipped: 'as above (its own transitive packages — SignalR client, Microsoft.Extensions — are MIT)',
  },
  {
    name: 'Godot.NET.Sdk / GodotSharp',
    version: '4.5.1',
    license: 'MIT',
    shipped: 'restored from nuget.org when a game is built',
  },
];

const BINARIES = [
  {
    name: 'Node.js runtime (Studio Core sidecar)',
    version: '22.20.0',
    license: 'MIT (plus the licences of its bundled deps, shipped as NODE_LICENSE.txt)',
    how: 'bundled in both installers',
  },
  {
    name: 'Microsoft Edge WebView2 bootstrapper',
    version: 'evergreen',
    license: 'Microsoft redistributable licence',
    how: 'embedded bootstrapper (installs the system WebView2 runtime when missing)',
  },
  {
    name: 'Godot Engine 4.5.1 (.NET)',
    version: '4.5.1-stable',
    license: "MIT (third-party components listed in Godot's COPYRIGHT.txt)",
    how: 'bundled in the full installer; otherwise installed by the Setup Assistant',
  },
  { name: 'Godot export templates 4.5.1 (.NET)', version: '4.5.1.stable.mono', license: 'MIT', how: 'Setup Assistant' },
  {
    name: 'gamedev-mcp-server',
    version: '9.2.9',
    license: 'Apache-2.0',
    how: 'bundled in the full installer; otherwise Setup Assistant',
  },
  { name: '.NET 8 SDK', version: '8.0 (latest)', license: 'MIT', how: 'Setup Assistant (private, per-user install)' },
  {
    name: 'MinGit (Git for Windows)',
    version: 'latest',
    license: 'GPL-2.0 — a separate, unmodified program run as a subprocess; never linked',
    how: 'Setup Assistant, only when no git is on PATH',
  },
  {
    name: 'Eclipse Temurin JDK 17',
    version: '17',
    license: 'GPL-2.0 with Classpath Exception — separate program',
    how: 'Setup Assistant, Android targets only',
  },
  {
    name: 'Android SDK (cmdline-tools, platform-tools, build-tools, platform, NDK, CMake)',
    version: 'Godot 4.5 set',
    license: 'Android Software Development Kit License (accepted by the owner)',
    how: 'Setup Assistant, Android targets only, after explicit licence acceptance',
  },
  {
    name: 'ComfyUI',
    version: 'worker-side',
    license: "GPL-3.0 — never bundled; reached over HTTP on the owner's worker",
    how: 'not distributed',
  },
];

export async function inventory(previous) {
  const core = await corePackages();
  return {
    generated_by: 'studio/scripts/third-party-licenses.mjs',
    core,
    core_declared_not_bundled: coreDeclaredNotBundled(core),
    ui: uiPackages(),
    cargo: cargoCrates(previous?.cargo),
    nuget: NUGET,
    binaries: BINARIES,
    models: models(),
  };
}

function markdown(inv) {
  const table = (rows, cols) =>
    [
      `| ${cols.join(' | ')} |`,
      `|${cols.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
    ].join('\n');
  return `# Third-party licences

Generated by \`studio/scripts/third-party-licenses.mjs\` from the real sources (esbuild metafile, package-lock.json,
\`cargo tree\`, the NuGet pins, the workflow definitions). Do not edit by hand; run \`node studio/scripts/third-party-licenses.mjs\`.
\`core/tests/licenses.test.ts\` fails when this inventory is stale or a shipped package has a licence outside the policy
(copyleft such as GPL/LGPL/AGPL/SSPL, or an unknown licence, is never linked into what ModuleX ships).

ModuleX Game Studio itself and both Godot addons are Apache-2.0.

## Runtimes and tools (bundled or installed by the Setup Assistant)

${table(inv.binaries, ['name', 'version', 'license', 'how'])}

## Generative models (built-in ComfyUI workflows, run on the owner's own workers)

${table(inv.models, ['workflow', 'subject', 'license', 'commercial_use', 'conditions'])}

The commercial-use verdict of every generated asset is derived from these facts (asset-provenance.md).

## NuGet packages

${table(inv.nuget, ['name', 'version', 'license', 'shipped'])}

## npm packages inside the bundled Studio Core (${inv.core.length})

${table(inv.core, ['name', 'version', 'license'])}

## npm packages Core declares but the current bundle does not reach (${inv.core_declared_not_bundled.length})

Not shipped today (no code path from Core's entry point reaches them yet, so esbuild leaves them out). They are listed
so the inventory is complete as soon as they are wired in.

${table(inv.core_declared_not_bundled, ['name', 'version', 'license'])}

## npm packages of the desktop UI (${inv.ui.length})

${table(inv.ui, ['name', 'version', 'license'])}

## Rust crates of the Windows shell (${inv.cargo.length})

${table(inv.cargo, ['name', 'version', 'license'])}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const previous = existsSync(JSON_OUT) ? JSON.parse(readFileSync(JSON_OUT, 'utf-8')) : null;
  const inv = await inventory(previous);
  const json = `${JSON.stringify(inv, null, 2)}\n`;
  const md = markdown(inv);
  if (process.argv.includes('--check')) {
    const stale =
      (existsSync(JSON_OUT) ? readFileSync(JSON_OUT, 'utf-8') : '') !== json ||
      (existsSync(MD_OUT) ? readFileSync(MD_OUT, 'utf-8') : '') !== md;
    if (stale) {
      console.error('third-party licence inventory is stale: run node studio/scripts/third-party-licenses.mjs');
      process.exit(1);
    }
    console.log('third-party licence inventory is up to date');
  } else {
    writeFileSync(JSON_OUT, json);
    writeFileSync(MD_OUT, md);
    console.log(
      `wrote ${inv.core.length} core, ${inv.ui.length} ui, ${inv.cargo.length} crates, ${inv.models.length} model facts`,
    );
  }
}
