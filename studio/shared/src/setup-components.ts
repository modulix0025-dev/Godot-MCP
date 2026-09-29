// SPDX-License-Identifier: Apache-2.0
//
// Bootstrapper + Setup Assistant component catalogue (Execution Patch 1 §14). The small
// `ModuleXGameStudioSetup.exe` installs only the app (+ bundled Node sidecar and Core). Heavy runtimes are
// fetched on first run — and only the ones the owner's targets actually need. The optional
// `ModuleXGameStudioFullSetup.exe` pre-bundles the components marked `inFullInstaller`.
import type { Platform } from './build-profiles.js';

export type ComponentId =
  'godot-mono' | 'export-templates' | 'dotnet-sdk' | 'jdk' | 'android-sdk' | 'android-build-template' | 'git';

export interface SetupComponent {
  id: ComponentId;
  label: string;
  version: string;
  /** Where the Setup Assistant fetches it, and where the checksum comes from (fail-closed). */
  source: string;
  checksumSource: string;
  approxSizeMb: number;
  licence: string;
  requiredFor: 'always' | Platform[];
  inFullInstaller: boolean;
}

export const SETUP_COMPONENTS: SetupComponent[] = [
  {
    id: 'godot-mono',
    label: 'Godot 4.5.1 (.NET) editor',
    version: '4.5.1-stable',
    source: 'https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_mono_win64.zip',
    checksumSource: 'https://github.com/godotengine/godot/releases/download/4.5.1-stable/SHA512-SUMS.txt',
    approxSizeMb: 130,
    licence: 'MIT',
    requiredFor: 'always',
    inFullInstaller: true,
  },
  {
    id: 'export-templates',
    label: 'Godot 4.5.1 (.NET) export templates',
    version: '4.5.1.stable.mono',
    source:
      'https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_mono_export_templates.tpz',
    checksumSource: 'https://github.com/godotengine/godot/releases/download/4.5.1-stable/SHA512-SUMS.txt',
    approxSizeMb: 1218,
    licence: 'MIT',
    requiredFor: ['windows', 'android', 'ios'],
    inFullInstaller: true,
  },
  {
    id: 'dotnet-sdk',
    label: '.NET 8 SDK (private install)',
    version: '8.0',
    source: 'https://dot.net/v1/dotnet-install.ps1 (channel 8.0)',
    checksumSource: 'dotnet-install verifies the official release manifest',
    approxSizeMb: 220,
    licence: 'MIT',
    requiredFor: 'always',
    inFullInstaller: true,
  },
  {
    id: 'git',
    label: 'Git for checkpoints (MinGit, or a detected git)',
    version: '2.x',
    source: 'https://github.com/git-for-windows/git/releases (MinGit)',
    checksumSource: 'release SHA-256 published with each asset',
    approxSizeMb: 50,
    licence: 'GPL-2.0 (separate program, unmodified)',
    requiredFor: 'always',
    inFullInstaller: true,
  },
  {
    id: 'jdk',
    label: 'JDK 17',
    version: '17',
    source: 'Eclipse Temurin 17 (Adoptium API)',
    checksumSource: 'Adoptium release checksum',
    approxSizeMb: 190,
    licence: 'GPL-2.0 with Classpath Exception',
    requiredFor: ['android'],
    inFullInstaller: false,
  },
  {
    id: 'android-sdk',
    label: 'Android SDK (cmdline-tools, platform-tools, build-tools, platform)',
    version: 'per Godot 4.5 requirements',
    source: 'https://dl.google.com/android/repository/ (sdkmanager)',
    checksumSource: 'repository2 manifest SHA-1/SHA-256',
    approxSizeMb: 1500,
    licence: 'Android SDK License (accepted by the owner in the Setup Assistant)',
    requiredFor: ['android'],
    inFullInstaller: false,
  },
  {
    id: 'android-build-template',
    label: 'Godot Android build template (for AAB)',
    version: '4.5.1.stable.mono',
    source: 'bundled in export templates (android_source.zip)',
    checksumSource: 'export templates checksum',
    approxSizeMb: 0,
    licence: 'MIT',
    requiredFor: ['android'],
    inFullInstaller: false,
  },
];

/** Components the Setup Assistant must install for the owner's requested platforms (in install order). */
export function componentsNeeded(
  platforms: readonly Platform[],
  installed: ReadonlySet<ComponentId>,
): SetupComponent[] {
  return SETUP_COMPONENTS.filter(
    (c) => !installed.has(c.id) && (c.requiredFor === 'always' || c.requiredFor.some((p) => platforms.includes(p))),
  );
}

export const INSTALLER_NAMES = {
  bootstrapper: 'ModuleXGameStudioSetup.exe',
  full: 'ModuleXGameStudioFullSetup.exe',
} as const;
