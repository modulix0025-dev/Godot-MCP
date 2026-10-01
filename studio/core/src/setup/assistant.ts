// SPDX-License-Identifier: Apache-2.0
//
// The Setup Assistant (EXECUTION_PROMPT Phase 13, Execution Patch 1 §14). It installs what the installer did not
// bundle, for the platforms the owner targets: Godot 4.5.1 mono, the export templates, the private .NET 8 SDK,
// gamedev-mcp-server 9.2.9, Git, and for Android JDK 17 + the Android SDK.
//
// Rules:
//   - Every archive is checked against a checksum from an OFFICIAL source before it is extracted (fail-closed):
//     Godot SHA512-SUMS.txt; the SHA-512 in Microsoft's .NET releases.json; the server's SHA256SUMS; the Adoptium
//     API checksum; the Android repository manifest SHA-1; the GitHub release asset digest for MinGit.
//   - Downloads resume (`.part` + Range) and state is persisted after every step, so an interrupted install
//     continues where it stopped.
//   - Already-present components count: a component bundled by the full installer (MODULEX_GODOT, MODULEX_SERVER)
//     or found on the machine (git) is recorded as installed without a download.
//   - The Android SDK licence is the owner's to accept: without `acceptAndroidLicense` the component stops at
//     NEEDS_HUMAN and nothing is downloaded.
//   - Everything installs per user under the data directory; nothing needs admin rights.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { componentsNeeded, SETUP_COMPONENTS, type ComponentId, type Platform } from '@modulex/shared';
import { download, godotDownloads, parseChecksums, type DownloadProgress, type DownloadSpec } from './downloader.js';

const run = promisify(execFile);

export type HostOs = 'windows' | 'linux' | 'macos';

export interface ComponentState {
  id: ComponentId;
  status: 'missing' | 'installing' | 'installed' | 'failed' | 'needs_owner';
  version: string | null;
  /** Main path (executable or root folder). Shown to the owner only; never sent to agents. */
  path: string | null;
  /** How it got here. */
  origin: 'downloaded' | 'bundled' | 'detected' | null;
  /** Archive digest that was verified, `<alg>:<hex>`. */
  verified: string | null;
  message: string | null;
  updated_at: string;
}

/** Overridable endpoints (tests point them at a local server; production uses the official ones). */
export interface SetupSources {
  godotBase: string;
  serverBase: string;
  dotnetReleases: string;
  adoptiumApi: string;
  androidRepository: string;
  minGitRelease: string;
}

export const OFFICIAL_SOURCES: SetupSources = {
  godotBase: 'https://github.com/godotengine/godot-builds/releases/download/4.5.1-stable',
  serverBase: 'https://github.com/IvanMurzak/GameDev-MCP-Server/releases/download/v9.2.9',
  dotnetReleases: 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json',
  adoptiumApi: 'https://api.adoptium.net/v3/assets/latest/17/hotspot',
  androidRepository: 'https://dl.google.com/android/repository',
  minGitRelease: 'https://api.github.com/repos/git-for-windows/git/releases/latest',
};

/** Android SDK packages for Godot 4.5 exports (Godot docs: SDK Platform 35, Build-Tools 35.0.1, NDK r28b). */
export const ANDROID_PACKAGES = [
  'platform-tools',
  'build-tools;35.0.1',
  'platforms;android-35',
  'cmdline-tools;latest',
  'ndk;28.1.13356709',
  'cmake;3.10.2.4988404',
];

export interface SetupAssistantOptions {
  dataDir: string;
  os?: HostOs;
  /** Godot's export templates root (%APPDATA%\Godot\export_templates on Windows). */
  templatesDir: string;
  godotVersion?: string;
  serverVersion?: string;
  sources?: Partial<SetupSources>;
  /** Components already provided by the installer/shell (full installer: MODULEX_GODOT, MODULEX_SERVER). */
  bundled?: Partial<Record<ComponentId, string>>;
  extract?: (archive: string, dest: string) => Promise<void>;
  /** Detect a tool on PATH (git); returns its version line or null. */
  detect?: (cmd: string) => Promise<string | null>;
  /** Run a program (sdkmanager); stdin is fed `input` (licence answers). */
  exec?: (cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Promise<void>;
  now?: () => Date;
}

function hostOs(): HostOs {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

async function defaultExtract(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const lower = archive.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) await run('tar', ['-xzf', archive, '-C', dest]);
  else if (process.platform === 'win32')
    await run('tar', ['-xf', archive, '-C', dest]); // bsdtar reads zip
  else await run('unzip', ['-q', '-o', archive, '-d', dest]);
}

async function defaultDetect(cmd: string): Promise<string | null> {
  try {
    const r = await run(cmd, ['--version'], { timeout: 15_000 });
    return r.stdout.trim().split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

async function defaultExec(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(cmd, args, { env, timeout: 3_600_000, maxBuffer: 64 << 20 }, (e) =>
      e ? reject(e) : resolve(),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function findFile(dir: string, test: (name: string) => boolean, depth = 4): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (test(e.name)) return p;
    if (e.isDirectory()) {
      const found = findFile(p, test, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

export class SetupAssistant {
  private readonly os: HostOs;
  private readonly src: SetupSources;
  private readonly statePath: string;
  private readonly downloads: string;
  private readonly running = new Map<ComponentId, Promise<ComponentState>>();
  readonly progress = new Map<ComponentId, DownloadProgress>();

  constructor(private readonly o: SetupAssistantOptions) {
    this.os = o.os ?? hostOs();
    this.src = { ...OFFICIAL_SOURCES, ...o.sources };
    this.statePath = join(o.dataDir, 'setup', 'state.json');
    this.downloads = join(o.dataDir, 'setup', 'downloads');
    mkdirSync(this.downloads, { recursive: true });
  }

  private get godotVersion(): string {
    return this.o.godotVersion ?? '4.5.1';
  }

  private read(): Partial<Record<ComponentId, ComponentState>> {
    return existsSync(this.statePath)
      ? (JSON.parse(readFileSync(this.statePath, 'utf-8')) as Partial<Record<ComponentId, ComponentState>>)
      : {};
  }

  private write(st: ComponentState): ComponentState {
    const all = this.read();
    all[st.id] = { ...st, updated_at: (this.o.now ?? (() => new Date()))().toISOString() };
    const tmp = `${this.statePath}.tmp`;
    mkdirSync(join(this.o.dataDir, 'setup'), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, this.statePath);
    return all[st.id]!;
  }

  private blank(id: ComponentId): ComponentState {
    return {
      id,
      status: 'missing',
      version: null,
      path: null,
      origin: null,
      verified: null,
      message: null,
      updated_at: new Date(0).toISOString(),
    };
  }

  /** Every catalogue component with its current state (bundled components are recorded on first look). */
  status(): ComponentState[] {
    const all = this.read();
    return SETUP_COMPONENTS.map((c) => {
      const st = all[c.id];
      const bundled = this.o.bundled?.[c.id];
      if ((!st || st.status !== 'installed') && bundled && existsSync(bundled))
        return this.write({
          ...this.blank(c.id),
          status: 'installed',
          version: c.version,
          path: bundled,
          origin: 'bundled',
          message: 'bundled with the full installer',
        });
      return st ?? this.blank(c.id);
    });
  }

  /** Components still needed for the owner's target platforms, in install order. */
  plan(platforms: readonly Platform[]): ComponentId[] {
    const installed = new Set(
      this.status()
        .filter((s) => s.status === 'installed')
        .map((s) => s.id),
    );
    return componentsNeeded(platforms, installed).map((c) => c.id);
  }

  /** Environment for Core and the tools it spawns, from what is installed. */
  env(): Record<string, string> {
    const by = Object.fromEntries(this.status().map((s) => [s.id, s])) as Record<ComponentId, ComponentState>;
    const out: Record<string, string> = {};
    const ok = (id: ComponentId) => by[id]?.status === 'installed' && by[id].path;
    if (ok('godot-mono')) out.MODULEX_GODOT = by['godot-mono'].path!;
    if (ok('mcp-server')) out.MODULEX_SERVER = by['mcp-server'].path!;
    if (ok('dotnet-sdk')) out.DOTNET_ROOT = by['dotnet-sdk'].path!;
    if (ok('jdk')) out.JAVA_HOME = by.jdk.path!;
    if (ok('android-sdk')) out.MODULEX_ANDROID_SDK = by['android-sdk'].path!;
    if (ok('git')) out.MODULEX_GIT = by.git.path!;
    return out;
  }

  /** Install one component (idempotent; concurrent calls share one install). */
  install(id: ComponentId, opts: { acceptAndroidLicense?: boolean } = {}): Promise<ComponentState> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const p = this.doInstall(id, opts).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async doInstall(id: ComponentId, opts: { acceptAndroidLicense?: boolean }): Promise<ComponentState> {
    const current = this.status().find((s) => s.id === id)!;
    if (current.status === 'installed') return current;
    if (id === 'android-sdk' && !opts.acceptAndroidLicense)
      return this.write({
        ...current,
        status: 'needs_owner',
        message: 'The Android SDK licence must be accepted by the owner in the Setup Assistant before installing.',
      });
    this.write({ ...current, status: 'installing', message: null });
    try {
      const done = await this.installers()[id]();
      return this.write({ ...this.blank(id), status: 'installed', ...done, message: null });
    } catch (e) {
      return this.write({ ...current, status: 'failed', message: (e as Error).message.slice(0, 500) });
    }
  }

  private async fetchText(url: string): Promise<string> {
    const r = await fetch(url, { headers: { 'user-agent': 'ModuleX-Game-Studio-Setup' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
  }

  private async get(id: ComponentId, spec: Omit<DownloadSpec, 'dest'> & { name: string }): Promise<string> {
    return download({ ...spec, dest: join(this.downloads, spec.name) }, (p) => this.progress.set(id, p));
  }

  /** Extract into a fresh folder, atomically replacing the previous one (a half-extracted tree is never used). */
  private async unpack(archive: string, dest: string): Promise<void> {
    const tmp = `${dest}.extracting`;
    rmSync(tmp, { recursive: true, force: true });
    await (this.o.extract ?? defaultExtract)(archive, tmp);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }

  private installers(): Record<ComponentId, () => Promise<Partial<ComponentState>>> {
    const engine = join(this.o.dataDir, 'engine');
    const v = this.godotVersion;
    const godot = godotDownloads(v, this.os);
    const godotSums = async () => parseChecksums(await this.fetchText(`${this.src.godotBase}/${basename(godot.sums)}`));
    return {
      'godot-mono': async () => {
        const digest = (await godotSums()).get(godot.editor.name);
        if (!digest) throw new Error(`${godot.editor.name} is not listed in SHA512-SUMS.txt`);
        const zip = await this.get('godot-mono', {
          name: godot.editor.name,
          url: `${this.src.godotBase}/${godot.editor.name}`,
          algorithm: 'sha512',
          digest,
        });
        const dir = join(engine, 'godot');
        await this.unpack(zip, dir);
        const exe = findFile(dir, (n) =>
          this.os === 'windows'
            ? /^Godot_v.*_mono_win64\.exe$/.test(n) && !/console/i.test(n)
            : this.os === 'linux'
              ? /^Godot_v.*_mono_linux\.x86_64$/.test(n)
              : n === 'Godot_mono.app' || n === 'Godot.app',
        );
        if (!exe) throw new Error('the Godot archive did not contain the editor executable');
        return { version: `${v}-stable mono`, path: exe, origin: 'downloaded', verified: `sha512:${digest}` };
      },
      'export-templates': async () => {
        const digest = (await godotSums()).get(godot.templates.name);
        if (!digest) throw new Error(`${godot.templates.name} is not listed in SHA512-SUMS.txt`);
        const tpz = await this.get('export-templates', {
          name: godot.templates.name,
          url: `${this.src.godotBase}/${godot.templates.name}`,
          algorithm: 'sha512',
          digest,
        });
        const staging = join(this.o.dataDir, 'setup', 'templates-staging');
        await this.unpack(tpz, staging);
        const inner = existsSync(join(staging, 'templates')) ? join(staging, 'templates') : staging;
        const version = readFileSync(join(inner, 'version.txt'), 'utf-8').trim();
        if (version !== `${v}.stable.mono`)
          throw new Error(`export templates are '${version}', expected '${v}.stable.mono'`);
        const target = join(this.o.templatesDir, version);
        mkdirSync(this.o.templatesDir, { recursive: true });
        rmSync(target, { recursive: true, force: true });
        renameSync(inner, target);
        rmSync(staging, { recursive: true, force: true });
        return { version, path: target, origin: 'downloaded', verified: `sha512:${digest}` };
      },
      'dotnet-sdk': async () => {
        const meta = JSON.parse(await this.fetchText(this.src.dotnetReleases)) as {
          'latest-sdk': string;
          releases: { sdk?: { version: string; files: { rid?: string; name: string; url: string; hash: string }[] } }[];
        };
        const sdk = meta.releases.map((r) => r.sdk).find((s) => s?.version === meta['latest-sdk']);
        const rid = this.os === 'windows' ? 'win-x64' : this.os === 'linux' ? 'linux-x64' : 'osx-arm64';
        const file = sdk?.files.find(
          (f) => f.rid === rid && (f.name.endsWith('.zip') || f.name.endsWith('.tar.gz')) && /sdk/i.test(f.name),
        );
        if (!sdk || !file) throw new Error(`no .NET SDK ${meta['latest-sdk']} archive for ${rid} in releases.json`);
        const name = basename(new URL(file.url).pathname);
        const archive = await this.get('dotnet-sdk', {
          name,
          url: file.url,
          algorithm: 'sha512',
          digest: file.hash,
        });
        const dir = join(this.o.dataDir, 'dotnet');
        await this.unpack(archive, dir);
        const dotnet = join(dir, this.os === 'windows' ? 'dotnet.exe' : 'dotnet');
        if (!existsSync(dotnet)) throw new Error('the .NET archive did not contain the dotnet host');
        return { version: sdk.version, path: dir, origin: 'downloaded', verified: `sha512:${file.hash}` };
      },
      'mcp-server': async () => {
        const rid = this.os === 'windows' ? 'win-x64' : this.os === 'linux' ? 'linux-x64' : 'osx-arm64';
        const name = `gamedev-mcp-server-${rid}.zip`;
        const digest = parseChecksums(await this.fetchText(`${this.src.serverBase}/SHA256SUMS`)).get(name);
        if (!digest) throw new Error(`${name} is not listed in SHA256SUMS`);
        const zip = await this.get('mcp-server', {
          name,
          url: `${this.src.serverBase}/${name}`,
          algorithm: 'sha256',
          digest,
        });
        const dir = join(engine, 'server');
        await this.unpack(zip, dir);
        const bin = findFile(
          dir,
          (n) => n === (this.os === 'windows' ? 'gamedev-mcp-server.exe' : 'gamedev-mcp-server'),
        );
        if (!bin) throw new Error('the server archive did not contain gamedev-mcp-server');
        return {
          version: this.o.serverVersion ?? '9.2.9',
          path: bin,
          origin: 'downloaded',
          verified: `sha256:${digest}`,
        };
      },
      git: async () => {
        const found = await (this.o.detect ?? defaultDetect)('git');
        if (found) return { version: found, path: 'git', origin: 'detected', verified: null };
        if (this.os !== 'windows')
          throw new Error('git was not found on PATH; install it with the system package manager');
        const rel = JSON.parse(await this.fetchText(this.src.minGitRelease)) as {
          tag_name: string;
          assets: { name: string; browser_download_url: string; digest?: string }[];
        };
        const asset = rel.assets.find((a) => /^MinGit-[\d.]+-64-bit\.zip$/.test(a.name));
        const digest = asset?.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
        if (!asset || !digest) throw new Error('no MinGit 64-bit asset with a published sha256 digest');
        const zip = await this.get('git', {
          name: asset.name,
          url: asset.browser_download_url,
          algorithm: 'sha256',
          digest,
        });
        const dir = join(this.o.dataDir, 'mingit');
        await this.unpack(zip, dir);
        return {
          version: rel.tag_name,
          path: join(dir, 'cmd', 'git.exe'),
          origin: 'downloaded',
          verified: `sha256:${digest}`,
        };
      },
      jdk: async () => {
        const os = this.os === 'windows' ? 'windows' : this.os === 'linux' ? 'linux' : 'mac';
        const url = `${this.src.adoptiumApi}?architecture=x64&image_type=jdk&os=${os}&vendor=eclipse`;
        const list = JSON.parse(await this.fetchText(url)) as {
          binary: { package: { name: string; link: string; checksum: string } };
          version?: { semver?: string };
        }[];
        const pkg = list[0]?.binary.package;
        if (!pkg) throw new Error('Adoptium returned no JDK 17 package');
        const archive = await this.get('jdk', {
          name: pkg.name,
          url: pkg.link,
          algorithm: 'sha256',
          digest: pkg.checksum,
        });
        const dir = join(this.o.dataDir, 'jdk');
        await this.unpack(archive, dir);
        const home = readdirSync(dir)
          .map((d) => join(dir, d))
          .find((d) => existsSync(join(d, 'bin')));
        if (!home) throw new Error('the JDK archive has no bin/ folder');
        return {
          version: list[0]!.version?.semver ?? '17',
          path: home,
          origin: 'downloaded',
          verified: `sha256:${pkg.checksum}`,
        };
      },
      'android-sdk': async () => {
        const jdk = this.status().find((s) => s.id === 'jdk');
        if (jdk?.status !== 'installed' || !jdk.path) throw new Error('install JDK 17 first');
        const xml = await this.fetchText(`${this.src.androidRepository}/repository2-3.xml`);
        const host = this.os === 'windows' ? 'windows' : this.os === 'linux' ? 'linux' : 'macosx';
        const archive = cmdlineToolsArchive(xml, host);
        if (!archive) throw new Error(`no cmdline-tools archive for ${host} in the Android repository manifest`);
        const zip = await this.get('android-sdk', {
          name: archive.url,
          url: `${this.src.androidRepository}/${archive.url}`,
          algorithm: 'sha1',
          digest: archive.sha1,
        });
        const root = join(this.o.dataDir, 'android-sdk');
        const staging = join(this.o.dataDir, 'setup', 'cmdline-tools');
        await this.unpack(zip, staging);
        const latest = join(root, 'cmdline-tools', 'latest');
        mkdirSync(join(root, 'cmdline-tools'), { recursive: true });
        rmSync(latest, { recursive: true, force: true });
        renameSync(existsSync(join(staging, 'cmdline-tools')) ? join(staging, 'cmdline-tools') : staging, latest);
        rmSync(staging, { recursive: true, force: true });
        const sdkmanager = join(latest, 'bin', this.os === 'windows' ? 'sdkmanager.bat' : 'sdkmanager');
        const env = { ...process.env, JAVA_HOME: jdk.path, ANDROID_SDK_ROOT: root };
        // The owner accepted the licence in the Setup Assistant (opts.acceptAndroidLicense); answer sdkmanager's
        // prompts with that decision.
        await (this.o.exec ?? defaultExec)(sdkmanager, [`--sdk_root=${root}`, '--licenses'], env, 'y\n'.repeat(20));
        await (this.o.exec ?? defaultExec)(
          sdkmanager,
          [`--sdk_root=${root}`, ...ANDROID_PACKAGES],
          env,
          'y\n'.repeat(20),
        );
        return {
          version: ANDROID_PACKAGES.join(', '),
          path: root,
          origin: 'downloaded',
          verified: `sha1:${archive.sha1}`,
        };
      },
      'android-build-template': async () => {
        const t = this.status().find((s) => s.id === 'export-templates');
        const zip = t?.path ? join(t.path, 'android_source.zip') : null;
        if (!zip || !existsSync(zip))
          throw new Error('install the export templates first (they carry android_source.zip)');
        return {
          version: `${this.godotVersion}.stable.mono`,
          path: zip,
          origin: 'detected',
          verified: `size:${statSync(zip).size}`,
        };
      },
    };
  }
}

/** The cmdline-tools archive for a host from Google's repository2 manifest (latest revision listed first). */
export function cmdlineToolsArchive(
  xml: string,
  host: 'windows' | 'linux' | 'macosx',
): { url: string; sha1: string } | null {
  const pkg = /<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/.exec(xml)?.[1];
  if (!pkg) return null;
  for (const a of pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const body = a[1]!;
    if (!new RegExp(`<host-os>${host}</host-os>`).test(body)) continue;
    const url = /<url>([^<]+)<\/url>/.exec(body)?.[1];
    const sha1 = /<checksum[^>]*>([0-9a-f]{40})<\/checksum>/.exec(body)?.[1];
    if (url && sha1) return { url, sha1 };
  }
  return null;
}

/** Godot's export templates root for the current user. */
export function defaultTemplatesDir(os: HostOs = hostOs()): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  if (os === 'windows')
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Godot', 'export_templates');
  if (os === 'macos') return join(home, 'Library', 'Application Support', 'Godot', 'export_templates');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'godot', 'export_templates');
}
