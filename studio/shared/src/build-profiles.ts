// SPDX-License-Identifier: Apache-2.0
//
// Build profiles + platform matrix (Execution Patch 1 §12–13, docs/modulex/build-profiles.md).
// A profile decides what goes INTO the build; the platform decides how it is produced. The RELEASE profile is
// the customer build: no MCP stack, no QA bridge, no diagnostics, no development secrets.

export const BUILD_PROFILES = ['DEV', 'QA', 'PREVIEW', 'RELEASE'] as const;
export type BuildProfile = (typeof BUILD_PROFILES)[number];
export type Platform = 'windows' | 'android' | 'ios';

export interface ProfileSpec {
  profile: BuildProfile;
  purpose: string;
  /** Godot export mode. */
  exportMode: 'debug' | 'release';
  /** MSBuild configuration Godot compiles for the export (`ExportDebug` defines the QA/MCP code paths). */
  msbuildConfiguration: 'ExportDebug' | 'ExportRelease';
  /** Ship addons/godot_mcp + ModuleX runtime (McpPlugin/ReflectorNet/SignalR) in the build. */
  includeMcpRuntime: boolean;
  /** Ship the ModulexQa autoload (still env-gated by MODULEX_QA=1 at runtime). */
  includeQaAutoload: boolean;
  /** `debug/file_logging/enable_file_logging`. */
  fileLogging: boolean;
  /** Build may be handed to people outside the studio. */
  distributable: boolean;
}

export const PROFILES: Record<BuildProfile, ProfileSpec> = {
  DEV: {
    profile: 'DEV',
    purpose: 'Rapid development and debugging with MCP tools and editor integration.',
    exportMode: 'debug',
    msbuildConfiguration: 'ExportDebug',
    includeMcpRuntime: true,
    includeQaAutoload: true,
    fileLogging: true,
    distributable: false,
  },
  QA: {
    profile: 'QA',
    purpose: 'Automated tests: QA autoload, screenshots, runtime-error capture, test instrumentation.',
    exportMode: 'debug',
    msbuildConfiguration: 'ExportDebug',
    includeMcpRuntime: true,
    includeQaAutoload: true,
    fileLogging: true,
    distributable: false,
  },
  PREVIEW: {
    profile: 'PREVIEW',
    purpose: 'Owner/user previews: near-shipping, optional diagnostics (file logging), no MCP bridge.',
    exportMode: 'release',
    msbuildConfiguration: 'ExportRelease',
    includeMcpRuntime: false,
    includeQaAutoload: false,
    fileLogging: true,
    distributable: true,
  },
  RELEASE: {
    profile: 'RELEASE',
    purpose: 'Clean customer build: no MCP, no QA bridge, no development secrets, no internal diagnostics.',
    exportMode: 'release',
    msbuildConfiguration: 'ExportRelease',
    includeMcpRuntime: false,
    includeQaAutoload: false,
    fileLogging: false,
    distributable: true,
  },
};

export interface MatrixCell {
  platform: Platform;
  profile: BuildProfile;
  /** What the Studio can produce on Windows alone. */
  onWindows: 'artifact' | 'preparation';
  /** Human label for the Build Center. */
  label: string;
}

/** The supported matrix (§13). iOS on Windows is preparation only; a signed build needs the macOS worker. */
export const PLATFORM_MATRIX: MatrixCell[] = [
  ...BUILD_PROFILES.map((p) => ({
    platform: 'windows' as const,
    profile: p,
    onWindows: 'artifact' as const,
    label: `Windows ${p}`,
  })),
  ...BUILD_PROFILES.map((p) => ({
    platform: 'android' as const,
    profile: p,
    onWindows: 'artifact' as const,
    label: `Android ${p}`,
  })),
  ...(['QA', 'PREVIEW', 'RELEASE'] as const).map((p) => ({
    platform: 'ios' as const,
    profile: p,
    onWindows: 'preparation' as const,
    label: p === 'PREVIEW' ? 'iOS Preparation' : `iOS ${p === 'QA' ? 'QA' : 'Release'} Preparation`,
  })),
];

export type ArtifactStatus = 'BUILT' | 'PREPARED' | 'SIGNED' | 'BLOCKED' | 'FAILED';

/**
 * Honest artifact status. iOS without a signed .ipa is PREPARED (never "released"); an iOS RELEASE request
 * without a macOS worker is BLOCKED with the reason the owner must act on.
 */
export function iosStatus(opts: {
  preparationDone: boolean;
  macWorkerOnline: boolean;
  signedIpaSha256: string | null;
  releaseRequested: boolean;
}):
  | { status: 'SIGNED' }
  | { status: 'PREPARED'; note: string }
  | { status: 'BLOCKED'; code: 'MACOS_WORKER_REQUIRED'; reason: string } {
  if (opts.signedIpaSha256) return { status: 'SIGNED' };
  if (opts.releaseRequested && !opts.macWorkerOnline) {
    return { status: 'BLOCKED', code: 'MACOS_WORKER_REQUIRED', reason: 'macOS/Xcode build worker required' };
  }
  return { status: 'PREPARED', note: 'Final signed build requires the macOS worker.' };
}

/** MSBuild snippet that strips the MCP stack from ExportRelease (applied by the project template, Phase 10). */
export const RELEASE_EXCLUSION_CSPROJ = `<ItemGroup Condition="'$(Configuration)' == 'ExportRelease'">
  <Compile Remove="addons/godot_mcp/**/*.cs" />
  <Compile Remove="addons/modulex_studio/**/*.cs" />
</ItemGroup>`;

/** Files that must never be inside a distributable build (checked on the exported pck/data dir). */
export const FORBIDDEN_IN_DISTRIBUTABLE = [
  /McpPlugin\.dll$/i,
  /ReflectorNet\.dll$/i,
  /SignalR/i,
  /\.env$/i,
  /godot-mcp-config\.json$/i,
];

export function distributableViolations(files: string[], profile: BuildProfile): string[] {
  if (PROFILES[profile].includeMcpRuntime) return [];
  return files.filter((f) => FORBIDDEN_IN_DISTRIBUTABLE.some((re) => re.test(f)));
}
