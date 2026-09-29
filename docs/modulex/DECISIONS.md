# ModuleX Game Studio: Decisions and Spike Results

This is the record the execution prompt requires. It holds every Phase 0 spike result, each deviation from
the plan (reality wins), and each decision taken without the owner.

The companion documents are:

- [`ANALYSIS.md`](ANALYSIS.md): the evidence behind the plan.
- [`EXECUTION_PROMPT.md`](EXECUTION_PROMPT.md): the plan itself.
- [`PROGRESS.md`](PROGRESS.md): phase status and gate output.

Status values:

- **VERIFIED**: observed working, with evidence.
- **FAILED**: observed not working, with the alternative.
- **BLOCKED**: could not be run here, with the reason and owner instructions.
- **DECIDED**: a choice made without a spike.

All Phase 0 spikes ran on 2026-09-29 in a Linux x86_64 cloud container with these components:

| Component | Version / detail |
|---|---|
| Ubuntu | 24.04 |
| Godot | `4.5.1.stable.mono.official.f62fdbde1`, SHA-512 checked against `SHA512-SUMS.txt` |
| gamedev-mcp-server | 9.2.9 `linux-x64`, SHA-256 checked against `SHA256SUMS` |
| .NET SDK | 8.0.131 |
| Node | 22.22 |
| X server | Xvfb, with Mesa llvmpipe for rendering |

Windows-only items (NSIS, WebView2, `%LOCALAPPDATA%` layout, Windows Credential Manager) run in the
`windows-latest` CI job instead. That job is in [`.github/workflows/modulex_studio.yml`](../../.github/workflows/modulex_studio.yml).

---

## D-001 · Where the spikes ran (DECIDED)

The implementing session has no Windows host. Every spike that does not depend on the OS ran live on Linux,
against the same pinned Godot and server builds. The Windows-specific parts run in the CI job:

- the installer;
- the sidecar packaging;
- the private .NET install under `%LOCALAPPDATA%`.

Linux results transfer to Windows for all Godot and server behaviour, because the engine, the addon and the
server are the same builds. Paths and process APIs do not transfer; they are covered by Windows CI.

## D-002 · Spike 1: engine, SDK and scaffold (VERIFIED, with 3 deviations)

**Steps run:**

1. `createProject({dotnet:true})`.
2. Rewrite the SDK to `Godot.NET.Sdk/4.5.1`.
3. `installPlugin({source:'<repo>/addons/godot_mcp'})`.
4. `godot --headless --import --quit`, then `dotnet build`, then `godot --headless --editor --quit`, as three
   separate processes (the safe pattern).

**Result:** `[Godot-MCP] plugin loaded`, with no `FileNotFoundException`.

**`godot --version` output:** `4.5.1.stable.mono.official.f62fdbde1`. The parser and pin check are in
`studio/shared/src/compat.ts` (`parseGodotVersion` / `checkGodotPin`). They handle Godot dropping the patch
digit for `.0` releases (`4.3.stable…` is read as `4.3.0`).

**Deviations the Studio must handle:**

1. `createProject` writes `Godot.NET.Sdk/4.3.0` and `config/features=("4.3","C#")`. Both must be rewritten
   to 4.5.1 (G8, confirmed).
2. `createProject` writes **no `.sln`**. Godot's C# export needs `<Name>.sln`. Without it the export still
   **exits 0** but ships no assemblies (see D-011). The Studio template must create the solution
   (`dotnet new sln` + `dotnet sln add`).
3. On boot the addon writes `.claude/skills/*` into the project (`auto-generate skills`). Generated games
   must either gitignore it or disable skill auto-generation. This is left to the Phase 10 template.

## D-003 · Spike 2: private .NET (VERIFIED on Linux; Windows is validated in Phase 4 CI)

**Setup.** The system .NET was removed from every default location:

- `/usr/lib/dotnet` moved away;
- `/etc/dotnet` hidden;
- the `dotnet` symlink on `PATH` hidden.

**Without `DOTNET_ROOT`:**

```
ERROR: .NET: One of the dependent libraries is missing. Typically when the `hostfxr`, `hostpolicy` or
`coreclr` dynamic libraries are not present in the expected locations.
Unable to load .NET runtime, specifically hostfxr.
```

**With `DOTNET_ROOT=<private dir>` and `PATH=<private dir>:$PATH`:** `dotnet build` succeeded (0 errors) and
the editor printed `[Godot-MCP] plugin loaded`.

**Mechanism:** Godot resolves `hostfxr` through `DOTNET_ROOT`, and falls back to running `dotnet` from
`PATH`. Both are set by the Studio for every spawned Godot process. Windows needs the same proof with
`dotnet-install.ps1 -InstallDir %LOCALAPPDATA%\ModuleXGameStudio\runtimes\dotnet`; it is part of the
GATE 4 Windows CI.

## D-004 · Spike 3: exact token-mode command line (VERIFIED)

A tiny `net8.0` console referencing `com.IvanMurzak.McpPlugin` 8.6.0 printed
`ServerLaunchArguments.BuildCommandLine(24123, 10000, streamableHttp, <auth>, <token>)`:

```
none:  port=24123 plugin-timeout=10000 client-transport=streamableHttp auth=none
token: port=24123 plugin-timeout=10000 client-transport=streamableHttp auth=token token=TOKEN_PLACEHOLDER
```

The key is **`auth=`**. The CI harness form `authorization=none` is a different spelling; the Studio uses
McpPlugin's. This is implemented as `buildServerArgs` in `studio/core/src/godot/server-args.ts` and
unit-tested byte-for-byte.

## D-005 · Spike 3: auth and loopback bind (VERIFIED)

The server was started in token mode with a 32-byte base64url token, and the editor was booted with:

```
GODOT_MCP_CONNECTION_MODE=Custom
GODOT_MCP_HOST=http://127.0.0.1:<port>
GODOT_MCP_AUTH_OPTION=token
GODOT_MCP_TOKEN=<token>
```

Results:

| Request | Result |
|---|---|
| `POST /api/system-tools/ping` with the bearer | `{"status":"success","structured":{"result":"mx"}}` (ready 2 s after editor boot) |
| No bearer | `HTTP 401 {"error":"Unauthorized","message":"A valid Bearer token is required…"}` |
| Wrong bearer | `HTTP 401` |
| MCP `/mcp` without the bearer | refused (`Streamable HTTP error … Unauthorized`) |
| Bind address | `/proc/net/tcp` shows the listen socket on `0100007F` (127.0.0.1) only |

## D-006 · Spike 3: MCP client, tool surface, REST vs MCP (VERIFIED)

`@modelcontextprotocol/sdk` 1.x `StreamableHTTPClientTransport` with an `Authorization` header connected to
`/mcp`.

**`tools/list` returns 39 tools.** That is the 42 built-ins minus the 3 System tools (`ping`,
`godot-skill-create`, `godot-skill-generate`), which live only on `/api/system-tools/`. The live schemas and
annotations are summarised in [`PROGRESS.md`](PROGRESS.md).

**Argument names differ from the prompt shorthand.** The real ones are:

- `scene-create {resourcePath, rootTypeClassName, rootName}`
- `node-create {name, typeClassName, instanceScenePath, parentNodeRef, index}`
- `scene-save {path}`
- `filesystem-reimport {files}`

**Annotations confirm G11.** `node-delete` and `resource-delete` carry no `destructiveHint`, while
`script-update` does. Tiering must not trust these hints.

**Images over REST and MCP match.** Over MCP, `screenshot-viewport` returns
`content:[{type:'text'}, {type:'image', mimeType:'image/png', data:<base64>}]`. REST
`POST /api/tools/screenshot-viewport` returns `{"status":"success","content":[…same items…]}`. Either path
can carry images, so Core may use REST (`runTool`) for image tools.

**Editor node paths are internal.** `scene-get-data` reports node `path` values under the editor's internal
tree (`/root/@EditorNode@…/World/Crate`). The Studio must address nodes by `nodeRef` / instance id, never by
these paths.

## D-007 · Spike 4: GLB import (VERIFIED, with a deviation)

The sample is a generated 932-byte cube `.glb`, copied to `res://assets/generated/test/`.

**The targeted reimport does not import a new file.** `filesystem-reimport {files:[…glb]}` returned
"Refreshed 1 native file(s) (no importer)". `ReimportClassifier` treats any path without a `.import`
sidecar as native, and a brand-new asset has no sidecar yet. `resource-find` then reported "No resource
exists".

**A full scan works.** `filesystem-reimport {}` (no `files`) returned "Full filesystem scan; filesystem
settled." Then:

1. `resource-find` returned `{type: PackedScene, uid: uid://…}`.
2. `node-create {instanceScenePath:'res://…/crate.glb'}` instanced it.
3. `scene-save` wrote `[ext_resource type="PackedScene" … path="res://assets/generated/test/crate.glb"]`.

**Decision.** The Phase 8 import step uses a **full scan** (`filesystem-reimport {}`) for new files. A
targeted reimport is used only for files that already have a `.import` sidecar.

**Upstreamable fix, not made here.** The classifier could treat a path whose extension has a registered
importer (via `ResourceFormatImporter`) as importable even without a sidecar.

## D-008 · Spike 3b: multi-instance routing on one server (FAILED; separate playtest server is mandatory)

**Setup.** The editor was connected to server A. A QA game was then connected to the **same** server with
the **same** token.

**Result.** The server keeps one token → connection mapping ("Token mapping added: hash[…] -> connectionId
…"), so **the last plugin to connect wins**.

- `tools/list` then showed only the game's tools.
- `scene-list-opened` returned "Tool with Name 'scene-list-opened' not found".
- This held for more than 30 s: the editor does not steal the route back, and there is no flapping.

**Decision.** Every playtest gets its **own server process, port and token**, as the plan assumed. The live
harness (`scripts/modulex_qa_harness.py`) builds exactly this topology.

A shared server with **distinct** tokens per plugin was not tested. It is not needed, and the separate
server is simpler to supervise.

## D-009 · Tool calls into one plugin are serialized (VERIFIED; the design changed)

`game-wait {seconds:4}` was sent with a `game-state-get` 0.3 s behind it. The second call returned at 4.04 s,
right after the wait finished. The McpPlugin client runs one tool call at a time.

**Consequence.** A separate `game-input-action` call can never trigger a condition that a running
`game-wait` is watching. The first live attempt (`untilSignal: Player:jumped`, then a jump sent by a
separate call) timed out.

**Change.** `game-wait` gained `pressAction` / `pressHoldFrames`. The condition is armed first, then the
action is pressed and auto-released **inside the same call**.

**Verification.** Live (`satisfied: true`) and in the CI harness check "game-wait(pressAction=jump,
untilSignal=Player:jumped) is satisfied".

## D-010 · Addon-side tool disabling hides a tool but does not block it (VERIFIED; the design is confirmed)

`GodotMcpConnection.SetFeatureEnabled(Tools, "reflection-method-call", false)` was applied by
`ModulexStudioPlugin` through a new `GodotMcpPlugin.ActiveConnection` accessor.

- The tool **disappears from `tools/list`**.
- A **direct `tools/call reflection-method-call` still executes**: it returned the method-resolution error
  "Method not found", which only the running handler produces.
- The same happened for `game-state-get` in the editor, where `Tool_Game`'s own guard refused it.

**Decision.** The Studio Policy Gateway is the only enforcement point. Addon-side disabling is defence in
depth and noise reduction only (G11 and G19 confirmed). The Agent never gets the Godot-MCP URL or token.

## D-011 · Spike 5: exports (Windows VERIFIED from Linux; Android BLOCKED; iOS requires macOS)

**Windows.** `godot --headless --path <p> --export-release "Windows Desktop" out/win/Game.exe` produced:

- `Game.exe` (97 MB)
- `Game.pck`
- `data_SpikeGame_windows_x86_64/` (all managed assemblies)

The export took 14.7 s, cross-exported from Linux with 4.5.1 mono templates. The Linux export also works.

**A Godot export can report success without the C# code.** Without a `.sln` (D-002), Godot logged
`ERROR: Export .NET Project: … no solution file was found` and **still exited 0**, shipping no `data_*`
folder. The Build Service therefore:

- never trusts the exit code alone;
- scans the log for `ERROR:` lines;
- verifies that the `data_<Assembly>_<platform>_<arch>` folder (with `<Assembly>.dll`) exists next to the
  binary.

**Release exports include the MCP stack by default.** The release export shipped
`McpPlugin.dll`, `ReflectorNet.dll` and the SignalR client. The `ExportRelease` exclusion in the Phase 10
template is required, not optional.

**A minimal `export_presets.cfg` works but logs noise.** Without `include_filter`/`exclude_filter`, Godot
logs `Couldn't find the given section … include_filter`. The template writes full presets.

**Android: BLOCKED in this environment.** `dl.google.com` (Android SDK, cmdline-tools) is refused by the
container's egress proxy (HTTP 403). JDK 17 is available from apt, but the SDK is not.

*Owner action:* none. It is re-run in the Phase 10 Windows CI job, which downloads the SDK.

**iOS: macOS is required (VERIFIED).** On a non-macOS host with the templates installed, Godot 4.5.1 refuses:

> `Exporting to an Apple Embedded platform when using C#/.NET is experimental and requires macOS.`
> `ERROR: Project export for preset "iOS" failed.`

On Windows, "Prepare iOS" can only validate and package a snapshot. The final export is macOS-worker-only.

## D-012 · Spike 6: headless vs rendering (VERIFIED)

**`--headless`:**

- `screenshot-viewport` returns the structured error "Viewport texture read back an empty image — …
  '--headless' …".
- `game-screenshot` returns "The game runs with the headless display server (no renderer)…".

**Under Xvfb with `--rendering-driver opengl3`** (Mesa llvmpipe, OpenGL 4.5):

- `screenshot-viewport` returned a 202 KB PNG.
- `screenshot-isolated {nodeRef:{path:'Crate'}, cameraView:'Front'}` returned a 512×512 PNG.
- `game-screenshot` returned a 1280×720 PNG. The sampled pixels were non-uniform; the evidence image is
  uploaded by CI.

**Decision.**

- Visual playtests run windowed.
- On Linux CI they run under Xvfb with `--rendering-driver opengl3`.
- On Windows they run as a real (small or off-screen) window.

## D-013 · Spike 7: desktop packaging (Linux VERIFIED; Windows NSIS in CI)

**Stack.**

- Tauri 2 shell (`studio/app/src-tauri`).
- A bundled Node sidecar (`externalBin: binaries/node`) running `studio/core/dist/modulex-core.mjs`. This is
  Studio Core bundled by esbuild into one 234 KB ESM file, which **includes the reused `godot-cli` library**.
- The sidecar prints one handshake line `{type, version, port, token, pid}`, then serves
  `127.0.0.1:<random>` behind the session token.

**Measured on Linux.**

- The bundled Core's `/health` lists all 16 `godot-cli` exports.
- Core RSS is about 61 MB.
- Without the bearer, `/health` returns 401.

**Windows.** The `windows` CI job:

1. builds the unsigned NSIS installer;
2. installs it silently (`/S`);
3. runs the **installed** app with `--selftest <report.json>` (resolves the bundled `node.exe` + Core,
   handshakes, calls `/health`, records `shell_to_handshake_ms` and both RSS values);
4. uninstalls silently.

The numbers are recorded in `PROGRESS.md` once the job has run.

**Shutdown.** Core exits when its stdin closes, so a crashed shell never leaves an orphaned sidecar. The
shell also kills it on window destroy.

## D-014 · Namespace, headers and plugin identity (DECIDED)

- The new addon uses the C# namespace `ModuleX.Studio.*`, so ModuleX code never collides with upstream
  `com.IvanMurzak.Godot.MCP.*` types.
- `plugin.cfg`: name "ModuleX Studio", author "ModuleX", version 0.1.0.
- Every new `.cs` starts with the ASCII Apache-2.0 header **copied verbatim** from a neighbouring file, as
  `CLAUDE.md` requires.
- New TypeScript/Rust files carry `SPDX-License-Identifier: Apache-2.0`.

*Owner decision:* whether ModuleX-authored files should add a "Copyright (c) 2026 ModuleX" line.

## D-015 · Upstream diff in `addons/godot_mcp/` (DECIDED; kept minimal)

There is exactly one change:

- `Editor/GodotMcpPlugin.cs`: `internal static GodotMcpConnection? ActiveConnection => Current?._connection;`
  lets a sibling editor addon compiled into the same assembly reach the live connection. It is read-only and
  upstreamable.

Changes outside the addon:

- `scripts/check-runtime-boundary.py` also scans `addons/modulex_studio/{Runtime,Common}` when they exist.
  It is a no-op upstream.
- `Godot-MCP.csproj` has two `Compile Remove` guards: `Godot-Tests-Modulex/**` and `studio/**`.
- `Godot-MCP.Tests.csproj` links the ModuleX sources.

## D-016 · QA runtime tool set (DECIDED, verified live)

`ModulexQaAutoload` registers `Tool_Game`, `Tool_Ping` and `Tool_RuntimeErrors` explicitly. It excludes:

- **`Tool_Reflection`**: arbitrary method calls;
- **`Tool_Console`**: its collector is only installed by the editor plugin, so in a game it reports nothing.
  Its own description says the game's output "will NEVER appear here".

**Live `tools/list` of a playtest session:** the 8 `game-*` tools + `runtime-errors-get` +
`runtime-errors-clear`, and nothing else. `ping` is on the system surface.

## D-017 · `game-*` inside the editor (DECIDED)

The editor connection auto-discovers `Tool_Game`, because Godot compiles one assembly. Inside the editor
those tools would act on the editor's own SceneTree, and `game-quit` would close the editor. Two guards
prevent this:

1. Every `game-*` handler refuses when `Engine.IsEditorHint()` is true.
2. `ModulexStudioPlugin` hides them on the editor connection.

The persisted `features` map is read only by the editor, never by the in-game runtime
(`GodotMcpRuntime.Build` starts from a fresh config), so playtests keep their tools.

## D-018 · Phase order: Phase 2 before Phase 1 (DECIDED)

Spike 3b (multi-instance routing) needs a game that connects through the QA autoload. So the
`modulex_studio` addon (Phase 2) was built and verified live first. Phase 1 followed in the same session.

## D-019 · Workspace tooling (DECIDED)

**vitest is pinned to `~4.0.18` in `studio/`.** npm 10.9.7 crashes
(`Cannot read properties of null (reading 'edgesOut')`) when vitest 4.1.x sits in a workspace root. This was
bisected; 4.0.18 and 3.2.x install cleanly. `cli/` is standalone, not a workspace, and keeps `^4.1.8`.

**The workspace is run as `cd studio && npm test`**, not `npm -w studio`. There is no repo-root
`package.json`, and adding one would turn `cli/` into a workspace member and change its install behaviour.

**Studio Core depends on `godot-cli` via `file:../../cli`.** CI builds `cli/` first.

## D-020 · Engine pin vs the addon's own SDK (DECIDED)

`Godot-MCP.csproj` keeps `Godot.NET.Sdk/4.3.0`, the upstream engine floor. The **4.5.1** pin applies to
generated games and to `Godot-Tests-Modulex`, and `compat.json` records it (`godotNetSdk`). The parity test
enforces it for the testbed.

## D-021 · Icon pipeline (DECIDED; the concept awaits owner approval in Phase 3)

`studio/branding/generate-icons.py` writes three SVGs:

- `icon.svg` (master);
- the hand-simplified `icon-24.svg`;
- the hand-simplified `icon-16.svg`.

`build-ico.py` builds the Windows `.ico` from these three SVGs, so the 16/20/24 px entries use the
hand-tuned variants. It covers every required size (16, 20, 24, 32, 40, 48, 64, 256) and `--verify` checks
them in CI. The PNG sizes come from `tauri icon`.
