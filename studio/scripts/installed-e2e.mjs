// SPDX-License-Identifier: Apache-2.0
//
// Installed-app acceptance test: does the app a user installs actually make a game?
//
// Runs against an INSTALLED ModuleX Game Studio (the full installer, on a clean Windows runner), never against the
// source tree:
//   1. Starts the installed Studio Core exactly as the shell does: the installed Node runtime on the installed
//      core/modulex-core.mjs, with the shell's environment (bundled Godot, bundled MCP server, bundled addons,
//      "%USERPROFILE%\ModuleX Games" as the projects root, the app data folder).
//      The system .NET SDK is hidden from Core, so the build must use what the Setup Assistant installs.
//   2. Owner: the Setup Assistant installs what Windows games need (export templates, the private .NET 8 SDK, Git
//      when absent), each from the official source and checksum-verified.
//   3. Claude Desktop: over /mcp with its pairing token, calls studio_game_create with the sample Game
//      Specification. It uses the Agent-safe studio_* surface only, as the real extension does.
//   4. Waits for the pipeline and asserts the evidence: every creation stage SUCCESS, the scripted playtest passed,
//      Windows QA and RELEASE builds BUILT with a sha256, the RELEASE build passed its launch smoke test, and the
//      release build ships no MCP or reflection code.
//
// Usage: node installed-e2e.mjs --install <installed app dir> --out <evidence dir>
// Exit code 0 only when every assertion holds; the report is written either way.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SAMPLE_GAME_SPEC } from '@modulex/shared';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const install = resolve(args.install ?? '');
const out = resolve(args.out ?? join(fileURLToPath(new URL('.', import.meta.url)), 'installed-e2e-out'));
mkdirSync(out, { recursive: true });

const report = { ok: false, steps: [], stages: [], builds: [], completion: null, error: null };
const log = (msg) => {
  console.log(`[installed-e2e] ${msg}`);
  report.steps.push(msg);
};
const save = () => writeFileSync(join(out, 'installed-e2e.json'), JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function find(dir, test, depth = 4) {
  if (depth < 0 || !existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if ((e.isFile() || e.isSymbolicLink()) && test(e.name)) return p;
    if (e.isDirectory()) {
      const hit = find(p, test, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

let core;
try {
  // ---- 1. the installed layout, resolved the way the shell's bundled_env() does --------------------------------
  const node = join(install, process.platform === 'win32' ? 'node.exe' : 'node');
  const script = join(install, 'core', 'modulex-core.mjs');
  const godot = find(join(install, 'engine', 'godot'), (n) => /^Godot_v.*_win64\.exe$/.test(n), 1);
  const server = join(install, 'engine', 'server', 'gamedev-mcp-server.exe');
  const addons = join(install, 'addons');
  for (const [what, p] of [
    ['node runtime', node],
    ['Core bundle', script],
    ['bundled Godot', godot],
    ['bundled MCP server', server],
    ['addons/godot_mcp', join(addons, 'godot_mcp')],
    ['addons/modulex_studio', join(addons, 'modulex_studio')],
  ])
    must(p && existsSync(p), `installed app is missing the ${what} (${p})`);
  const projectsRoot = join(homedir(), 'ModuleX Games');
  const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'com.modulex.gamestudio');
  log(`installed app: ${install}`);
  log(`Godot: ${godot}`);

  // Hide the runner's system .NET so the pipeline must use the Setup Assistant's private SDK, as on a clean PC.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^DOTNET_/i.test(k)) delete env[k];
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = (env[pathKey] ?? '')
    .split(delimiter)
    .filter((p) => !/[\\/]dotnet[\\/]?$/i.test(p))
    .join(delimiter);
  Object.assign(env, {
    MODULEX_GODOT: godot,
    MODULEX_SERVER: server,
    MODULEX_ADDONS_SOURCE: addons,
    MODULEX_PROJECTS_ROOT: projectsRoot,
    MODULEX_DATA_DIR: dataDir,
    MODULEX_CORE_PORT: '0',
  });

  core = spawn(node, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  core.stderr.on('data', (d) => process.stderr.write(d));
  const lines = createInterface({ input: core.stdout });
  const hs = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no handshake from the installed Core within 60 s')), 60_000);
    lines.once('line', (l) => {
      clearTimeout(t);
      res(JSON.parse(l));
    });
    core.once('exit', (c) => rej(new Error(`installed Core exited before its handshake (exit ${c})`)));
  });
  must(hs.type === 'modulex-core-handshake', 'unexpected first line from Core');
  const base = `http://127.0.0.1:${hs.port}`;
  log(`installed Core ${hs.version} up on ${base}`);

  const owner = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${hs.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };

  const health = await owner('GET', '/health');
  log(`health: pipeline.available=${health.pipeline?.available} qaTier=${health.pipeline?.qaTier}`);
  must(health.pipeline?.available === true, 'installed Core reports the pipeline as unavailable');
  must(health.pipeline?.qaTier === true, 'installed Core reports no QA tier');

  // ---- 2. Setup Assistant: what a Windows game needs ----------------------------------------------------------
  let setup = await owner('GET', '/setup');
  const wanted = setup.plan.filter((id) => !/^(android|jdk)/.test(id));
  log(`Setup Assistant plan for Windows: ${wanted.join(', ') || '(nothing)'}`);
  for (const id of wanted) await owner('POST', '/setup/install', { component: id, accept_android_license: false });
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    setup = await owner('GET', '/setup');
    const st = wanted.map((id) => setup.components.find((c) => c.id === id));
    const failed = st.filter((c) => c?.status === 'failed');
    must(failed.length === 0, `Setup Assistant failed: ${failed.map((c) => `${c.id}: ${c.message}`).join('; ')}`);
    if (st.every((c) => c?.status === 'installed')) break;
    must(Date.now() < deadline, 'Setup Assistant did not finish within 40 minutes');
    await sleep(5_000);
  }
  for (const id of wanted) {
    const c = setup.components.find((x) => x.id === id);
    log(`  ${id}: installed ${c.version ?? ''} ${c.verified ?? ''} (${c.origin})`);
  }

  // ---- 3. Claude Desktop asks for a game ------------------------------------------------------------------------
  const client = new Client({ name: 'installed-e2e-claude-desktop', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${hs.claudeDesktopToken}` } },
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  must(
    tools.every((t) => t.startsWith('studio_')),
    `Claude Desktop sees a non-studio tool: ${tools.join(', ')}`,
  );
  log(`Claude Desktop sees ${tools.length} studio_* tools, no raw Godot tools`);
  const id = SAMPLE_GAME_SPEC.project.id;
  const created = await client.callTool({ name: 'studio_game_create', arguments: { spec: SAMPLE_GAME_SPEC } });
  const text = created.content?.map((c) => c.text ?? '').join('') ?? '';
  must(!created.isError, `studio_game_create failed: ${text}`);
  log(`studio_game_create("${SAMPLE_GAME_SPEC.project.name}") accepted`);
  await client.close();

  // ---- 4. the pipeline makes the game ---------------------------------------------------------------------------
  const pDeadline = Date.now() + 45 * 60_000;
  let project;
  for (;;) {
    await sleep(10_000);
    project = await owner('GET', `/projects/${id}`);
    const run = project.runs.at(-1);
    const where = run?.stages.find((s) => s.status === 'RUNNING')?.stage ?? '…';
    console.log(`[installed-e2e] pipeline: ${project.executing ? `running (${where})` : 'finished'}`);
    if (!project.executing && run) break;
    must(Date.now() < pDeadline, 'pipeline did not finish within 45 minutes');
  }
  const run = project.runs.at(-1);
  report.stages = run.stages.map((s) => ({ stage: s.stage, status: s.status, reason: s.reason, evidence: s.evidence }));
  report.builds = project.builds;
  report.completion = run.completion ?? null;
  for (const s of run.stages) log(`stage ${s.stage}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`);
  for (const b of project.builds)
    log(
      `build ${b.platform} ${b.profile}: ${b.status} ${b.sha256 ? `sha256 ${b.sha256.slice(0, 16)}…` : ''} ${b.size_bytes ?? ''}${b.smoke != null ? ` smoke=${b.smoke}` : ''}${b.note ? ` (${b.note})` : ''}`,
    );

  must(!run.blocked, `run BLOCKED: ${run.blocked?.code} ${run.blocked?.message}`);
  const status = (st) => run.stages.find((s) => s.stage === st)?.status;
  for (const st of ['project_creation', 'scene_construction', 'gameplay', 'qa', 'playtest', 'regression', 'build'])
    must(status(st) === 'SUCCESS', `stage ${st} is ${status(st)}, not SUCCESS`);
  const qa = project.builds.find((b) => b.platform === 'windows' && b.profile === 'QA');
  const rel = project.builds.find((b) => b.platform === 'windows' && b.profile === 'RELEASE');
  must(qa?.status === 'BUILT', `Windows QA build is ${qa?.status}`);
  must(rel?.status === 'BUILT' && rel.sha256, `Windows RELEASE build is ${rel?.status}`);
  must(rel.smoke === true, `Windows RELEASE launch smoke is ${rel.smoke}`);

  const relDir = join(projectsRoot, id, 'build-output', rel.version, 'windows-release');
  const data = readdirSync(relDir).find((f) => f.startsWith('data_'));
  const dlls = data ? readdirSync(join(relDir, data)) : [];
  must(
    dlls.filter((f) => /mcp|reflector|signalr/i.test(f)).length === 0,
    'the RELEASE build ships MCP/reflection code',
  );
  // The game is a normal Godot project with its own git history: editable later, by the Studio or by hand.
  must(existsSync(join(projectsRoot, id, 'project.godot')), 'no project.godot in the generated game');
  must(existsSync(join(projectsRoot, id, '.git')), 'the generated game has no git history');
  cpSync(relDir, join(out, 'game-windows-release'), { recursive: true });
  log(`the game: ${relDir} (copied to the evidence folder)`);

  report.ok = true;
  log('installed app → Setup Assistant → Claude Desktop → playable Windows game: exercised');
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  console.error(`[installed-e2e] FAILED: ${report.error}`);
} finally {
  save();
  if (core) {
    core.stdin.end();
    core.kill();
  }
  process.exit(report.ok ? 0 : 1);
}
