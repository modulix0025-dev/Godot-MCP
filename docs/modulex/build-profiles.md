# ModuleX Game Studio: build profiles

Every export uses exactly one of four profiles. The profile decides what is compiled in, what is shipped,
and whether the result may be given to anyone.

Contract: `studio/shared/src/build-profiles.ts`. Tests: `studio/shared/tests/contracts.test.ts` ("build
profiles", "completion predicate").

## 1. Profiles

| Profile | Export | MSBuild configuration | MCP runtime | QA bridge (`ModulexQa`) | File logging | Distributable | Purpose |
|---|---|---|---|---|---|---|---|
| **DEV** | debug | `ExportDebug` | yes | yes | yes | **no** | Rapid development, editor integration |
| **QA** | debug | `ExportDebug` | yes | yes | yes | **no** | Automated tests, screenshots, runtime-error capture |
| **PREVIEW** | release | `ExportRelease` | **no** | **no** | yes | yes | Owner and user previews, near-shipping |
| **RELEASE** | release | `ExportRelease` | **no** | **no** | **no** | yes | The clean customer build |

A **RELEASE** build contains:

- no MCP (`godot_mcp` and `modulex_studio` C#, McpPlugin, ReflectorNet or SignalR);
- no QA bridge;
- no development secrets (`.env`, `godot-mcp-config.json`);
- no internal diagnostics.

### How the exclusion works

**Compile time.** The project template (Phase 10) adds `RELEASE_EXCLUSION_CSPROJ` to the generated game's
`.csproj`:

```xml
<ItemGroup Condition="'$(Configuration)' == 'ExportRelease'">
  <Compile Remove="addons/godot_mcp/**/*.cs" />
  <Compile Remove="addons/modulex_studio/**/*.cs" />
</ItemGroup>
```

**After export.** `distributableViolations(files, profile)` scans the exported file list for
`McpPlugin.dll`, `ReflectorNet.dll`, `SignalR*`, `.env` and `godot-mcp-config.json`. For PREVIEW and
RELEASE, any hit fails the build.

**Open item for Phase 10: the autoload reference.** `ModulexStudioPlugin` registers the `ModulexQa`
autoload in `project.godot`. In an `ExportRelease` build, the autoload's C# script is compiled out, but the
`[autoload]` entry would still point at it, and the game would log a missing-script error on start. Phase 10
must also do one of the following for PREVIEW and RELEASE:

- strip `autoload/ModulexQa` from the exported project settings (an export preset override); or
- use a GDScript shim that is excluded by the export filter.

It must also add a check that the exported `project.binary` has no `ModulexQa` entry. This is recorded as
D-032. Until it is verified, a RELEASE build is not claimed to be clean.

## 2. Platform matrix

Built on Windows:

| Platform | DEV | QA | PREVIEW | RELEASE |
|---|---|---|---|---|
| Windows | artifact | artifact | artifact | artifact |
| Android | artifact | artifact | artifact | artifact (needs a release keystore) |
| iOS | — | **Preparation** | **Preparation** | **Release Preparation** |

### iOS honesty rule

`iosStatus()` decides what an iOS build may be called:

- **SIGNED** only when a signed `.ipa` exists, identified by its sha256.
- **PREPARED** when the Xcode project and export were prepared. It is **never** called released.
- **BLOCKED** (`MACOS_WORKER_REQUIRED`, "macOS/Xcode build worker required") when a release is requested
  and no macOS worker is online.

The completion predicate follows the same rule:

- An iOS release without a Mac makes the run **BLOCKED**, or **PARTIAL_SUCCESS** when the other requested
  platforms succeeded.
- iOS preparation adds a note. It never counts as a release.

### Android honesty rule

With no device or emulator, a build is reported as **"built, not device-tested"**. That is a note, not a
pass.

## 3. Completion statuses

`evaluateCompletion()` returns one of:

- **SUCCESS**: all evidence rows are proven;
- **PARTIAL_SUCCESS**: some requested platforms succeeded and others are blocked;
- **BLOCKED**: an external prerequisite is missing, such as a macOS worker, a keystore or a licence;
- **FAILED**: a proven failure;
- **NEEDS_HUMAN**: the pipeline escalated a decision to the owner.

Neither the UI nor any agent can set SUCCESS. It is computed only from evidence.

## 4. Status

- **Implemented and tested:** the profile contract, the matrix, the iOS and Android honesty rules, the
  completion predicate, the csproj exclusion snippet and the distributable scan.
- **Not yet built** (Phase 10):
  - the export presets per profile;
  - applying the csproj snippet in the project template;
  - the `ModulexQa` autoload strip;
  - running the scan on real exports;
  - the `build-manifest.json` writer.

The build screens show the Profile column and the matrix (`docs/modulex/ui/screens/builds-*.png`).
