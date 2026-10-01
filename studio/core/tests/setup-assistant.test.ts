// SPDX-License-Identifier: Apache-2.0
//
// Setup Assistant (Phase 13) against a local server that mirrors the official sources: Godot SHA512-SUMS.txt,
// Microsoft's releases.json, the server's SHA256SUMS, Adoptium, the Android repository manifest and the MinGit
// release digest. Archive extraction is injected (the archive bytes name what they contain), so the suite runs
// the same on Linux and Windows CI.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCore } from '../src/server.js';
import {
  ANDROID_PACKAGES,
  cmdlineToolsArchive,
  SetupAssistant,
  type SetupAssistantOptions,
} from '../src/setup/assistant.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'mx-setup-'));
const h = (alg: string, b: Buffer | string) => createHash(alg).update(b).digest('hex');

// "Archives": their content lists the files the fake extractor creates (path=content per line).
const archives: Record<string, string> = {
  'Godot_v4.5.1-stable_mono_win64.zip':
    'Godot_v4.5.1-stable_mono_win64/Godot_v4.5.1-stable_mono_win64.exe=exe\nGodot_v4.5.1-stable_mono_win64/Godot_v4.5.1-stable_mono_win64_console.exe=c',
  'Godot_v4.5.1-stable_mono_export_templates.tpz':
    'templates/version.txt=4.5.1.stable.mono\ntemplates/windows_release_x86_64.exe=t\ntemplates/android_source.zip=a',
  'dotnet-sdk-8.0.414-win-x64.zip': 'dotnet.exe=d\nsdk/8.0.414/dotnet.dll=s',
  'gamedev-mcp-server-win-x64.zip': 'gamedev-mcp-server.exe=srv',
  'OpenJDK17U-jdk_x64_windows_hotspot_17.0.16_8.zip': 'jdk-17.0.16+8/bin/java.exe=j',
  'commandlinetools-win-13114758_latest.zip': 'cmdline-tools/bin/sdkmanager.bat=sm',
  'MinGit-2.51.0-64-bit.zip': 'cmd/git.exe=g',
};
let tamper = false;
let servedBytes = 0;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const name = url.pathname.split('/').pop()!;
    const send = (body: string | Buffer, status = 200) => {
      res.writeHead(status);
      res.end(body);
    };
    if (name === 'SHA512-SUMS.txt')
      return send(
        ['Godot_v4.5.1-stable_mono_win64.zip', 'Godot_v4.5.1-stable_mono_export_templates.tpz']
          .map((n) => `${h('sha512', archives[n]!)}  ${n}`)
          .join('\n'),
      );
    if (name === 'SHA256SUMS')
      return send(`${h('sha256', archives['gamedev-mcp-server-win-x64.zip']!)}  gamedev-mcp-server-win-x64.zip\n`);
    if (name === 'releases.json')
      return send(
        JSON.stringify({
          'latest-sdk': '8.0.414',
          releases: [
            {
              sdk: {
                version: '8.0.414',
                files: [
                  {
                    rid: 'win-x64',
                    name: 'dotnet-sdk-win-x64.zip',
                    url: `${base}/dotnet/dotnet-sdk-8.0.414-win-x64.zip`,
                    hash: h('sha512', archives['dotnet-sdk-8.0.414-win-x64.zip']!),
                  },
                ],
              },
            },
          ],
        }),
      );
    if (url.pathname.startsWith('/adoptium'))
      return send(
        JSON.stringify([
          {
            binary: {
              package: {
                name: 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.16_8.zip',
                link: `${base}/jdk/OpenJDK17U-jdk_x64_windows_hotspot_17.0.16_8.zip`,
                checksum: h('sha256', archives['OpenJDK17U-jdk_x64_windows_hotspot_17.0.16_8.zip']!),
              },
            },
            version: { semver: '17.0.16+8' },
          },
        ]),
      );
    if (name === 'repository2-3.xml')
      return send(
        `<sdk:sdk-repository><remotePackage path="cmdline-tools;latest"><archives><archive><complete><size>1</size><checksum type="sha1">${h('sha1', archives['commandlinetools-win-13114758_latest.zip']!)}</checksum><url>commandlinetools-win-13114758_latest.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage></sdk:sdk-repository>`,
      );
    if (name === 'latest')
      return send(
        JSON.stringify({
          tag_name: 'v2.51.0.windows.1',
          assets: [
            {
              name: 'MinGit-2.51.0-64-bit.zip',
              browser_download_url: `${base}/git/MinGit-2.51.0-64-bit.zip`,
              digest: `sha256:${h('sha256', archives['MinGit-2.51.0-64-bit.zip']!)}`,
            },
          ],
        }),
      );
    const body = archives[name];
    if (!body) return send('not found', 404);
    const bytes = Buffer.from(tamper ? `${body}!` : body);
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    servedBytes += bytes.length - start;
    res.writeHead(range ? 206 : 200, { 'content-length': bytes.length - start });
    res.end(bytes.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function fakeExtract(archive: string, dest: string): Promise<void> {
  for (const line of readFileSync(archive, 'utf-8').split('\n')) {
    const [path, content] = line.split('=');
    const file = join(dest, path!);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content ?? '');
  }
}

function assistant(over: Partial<SetupAssistantOptions> = {}) {
  const dataDir = over.dataDir ?? tmp();
  const execs: { cmd: string; args: string[]; input?: string }[] = [];
  const a = new SetupAssistant({
    dataDir,
    os: 'windows',
    templatesDir: join(dataDir, 'export_templates'),
    sources: {
      godotBase: `${base}/godot`,
      serverBase: `${base}/server`,
      dotnetReleases: `${base}/dotnet/releases.json`,
      adoptiumApi: `${base}/adoptium`,
      androidRepository: `${base}/android`,
      minGitRelease: `${base}/git/latest`,
    },
    extract: fakeExtract,
    detect: async () => null,
    exec: async (cmd, args, _env, input) => void execs.push({ cmd, args, input }),
    ...over,
  });
  return { a, dataDir, execs };
}

describe('Setup Assistant', () => {
  it('plans only what the targets need and installs each component checksum-verified', async () => {
    const { a, dataDir } = assistant();
    expect(a.plan(['windows'])).toEqual(['godot-mono', 'export-templates', 'dotnet-sdk', 'mcp-server', 'git']);
    for (const id of a.plan(['windows'])) {
      const st = await a.install(id);
      expect(st, id).toMatchObject({ status: 'installed', origin: 'downloaded' });
      expect(st.verified, id).toMatch(/^sha(256|512):[0-9a-f]+$/);
    }
    expect(a.plan(['windows'])).toEqual([]);
    const env = a.env();
    expect(env.MODULEX_GODOT).toMatch(/Godot_v4\.5\.1-stable_mono_win64\.exe$/);
    expect(env.MODULEX_GODOT).not.toMatch(/console/);
    expect(env.MODULEX_SERVER).toMatch(/gamedev-mcp-server\.exe$/);
    expect(existsSync(join(env.DOTNET_ROOT!, 'dotnet.exe'))).toBe(true);
    expect(env.MODULEX_GIT).toMatch(/git\.exe$/);
    const tpl = join(dataDir, 'export_templates', '4.5.1.stable.mono');
    expect(readFileSync(join(tpl, 'version.txt'), 'utf-8')).toBe('4.5.1.stable.mono');
    // State survives a restart of Core.
    expect(assistant({ dataDir }).a.plan(['windows'])).toEqual([]);
  });

  it('a tampered archive is never installed (checksum mismatch, nothing extracted)', async () => {
    const { a, dataDir } = assistant();
    tamper = true;
    try {
      const st = await a.install('mcp-server');
      expect(st.status).toBe('failed');
      expect(st.message).toMatch(/checksum mismatch/);
      expect(existsSync(join(dataDir, 'engine', 'server'))).toBe(false);
      expect(a.env().MODULEX_SERVER).toBeUndefined();
    } finally {
      tamper = false;
    }
    expect((await a.install('mcp-server')).status).toBe('installed');
  });

  it('an interrupted download resumes from the partial file', async () => {
    const { a, dataDir } = assistant();
    const name = 'Godot_v4.5.1-stable_mono_win64.zip';
    const full = archives[name]!;
    mkdirSync(join(dataDir, 'setup', 'downloads'), { recursive: true });
    writeFileSync(join(dataDir, 'setup', 'downloads', `${name}.part`), full.slice(0, 20));
    servedBytes = 0;
    expect((await a.install('godot-mono')).status).toBe('installed');
    expect(servedBytes).toBe(full.length - 20);
    expect(a.progress.get('godot-mono')).toMatchObject({ resumed: true });
  });

  it('bundled components (full installer) are installed without a download; git on PATH is detected', async () => {
    const dir = tmp();
    const exe = join(dir, 'Godot_v4.5.1-stable_mono_win64.exe');
    writeFileSync(exe, 'x');
    const { a } = assistant({ bundled: { 'godot-mono': exe }, detect: async () => 'git version 2.51.0' });
    expect(a.status().find((s) => s.id === 'godot-mono')).toMatchObject({ status: 'installed', origin: 'bundled' });
    expect(await a.install('git')).toMatchObject({ status: 'installed', origin: 'detected', path: 'git' });
    expect(a.plan(['windows'])).toEqual(['export-templates', 'dotnet-sdk', 'mcp-server']);
  });

  it('Android: NEEDS_HUMAN until the owner accepts the licence; then JDK + SDK packages for Godot 4.5', async () => {
    const { a, execs } = assistant();
    expect(a.plan(['android'])).toEqual(expect.arrayContaining(['jdk', 'android-sdk', 'android-build-template']));
    expect((await a.install('android-sdk')).status).toBe('needs_owner');
    expect(execs).toHaveLength(0);
    expect((await a.install('jdk')).status).toBe('installed');
    const st = await a.install('android-sdk', { acceptAndroidLicense: true });
    expect(st).toMatchObject({ status: 'installed' });
    expect(st.verified).toMatch(/^sha1:/);
    expect(execs.map((e) => e.args.slice(1))).toEqual([['--licenses'], ANDROID_PACKAGES]);
    expect(a.env()).toMatchObject({ MODULEX_ANDROID_SDK: st.path, JAVA_HOME: expect.stringMatching(/jdk-17/) });
    expect((await a.install('android-build-template')).status).toBe('failed'); // needs the export templates first
    await a.install('export-templates');
    expect((await a.install('android-build-template')).status).toBe('installed');
  });

  it('parses the cmdline-tools archive per host from the repository manifest', () => {
    const xml =
      '<remotePackage path="cmdline-tools;latest"><archive><complete><checksum type="sha1">' +
      'a'.repeat(40) +
      '</checksum><url>linux.zip</url></complete><host-os>linux</host-os></archive></remotePackage>';
    expect(cmdlineToolsArchive(xml, 'linux')).toEqual({ url: 'linux.zip', sha1: 'a'.repeat(40) });
    expect(cmdlineToolsArchive(xml, 'windows')).toBeNull();
  });
});

describe('Setup Assistant in Core (owner endpoints)', () => {
  it('installing Godot from /setup enables the pipeline without restarting Core; agents cannot call it', async () => {
    const dataDir = tmp();
    const core = await startCore({
      dataDir,
      locations: { projectsRoot: tmp(), addonsSource: tmp() },
      setupOverrides: {
        os: 'windows',
        sources: {
          godotBase: `${base}/godot`,
          serverBase: `${base}/server`,
          dotnetReleases: `${base}/dotnet/releases.json`,
          adoptiumApi: `${base}/adoptium`,
          androidRepository: `${base}/android`,
          minGitRelease: `${base}/git/latest`,
        },
        extract: fakeExtract,
        detect: async () => null,
      },
    });
    try {
      const call = (path: string, body?: unknown, token = core.handshake.token) =>
        fetch(`http://127.0.0.1:${core.handshake.port}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
      expect((await call('/setup', undefined, core.handshake.agentToken)).status).toBe(403);
      const before = (await (await call('/setup')).json()) as { plan: string[]; pipeline: { available: boolean } };
      expect(before.plan).toContain('godot-mono');
      expect(before.pipeline.available).toBe(false);
      expect((await call('/setup/install', { component: 'godot-mono' })).status).toBe(202);
      expect((await call('/setup/install', { component: 'mcp-server' })).status).toBe(202);
      let health: { pipeline: { available: boolean; qaTier: boolean } } = {
        pipeline: { available: false, qaTier: false },
      };
      for (let i = 0; i < 100 && !(health.pipeline.available && health.pipeline.qaTier); i++) {
        await new Promise((r) => setTimeout(r, 20));
        health = (await (await call('/health')).json()) as typeof health;
      }
      expect(health.pipeline).toEqual({ available: true, qaTier: true });
      expect((await call('/setup/install', { component: 'nope' })).status).toBe(400);
    } finally {
      await core.close();
    }
  });
});
