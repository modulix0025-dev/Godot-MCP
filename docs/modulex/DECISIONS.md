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

**Windows result (VERIFIED, run 36558456489 on `windows-latest`).**

| Measure | Value |
|---|---|
| NSIS installer | built, unsigned |
| Silent install (`/S`) | exit 0, into `C:\Users\<user>\AppData\Local\ModuleX Game Studio\` |
| Installed layout | `ModuleX Game Studio.exe`, `node.exe`, `core\modulex-core.mjs`, `uninstall.exe` |
| Installed `--selftest` | `ok: true` |
| Sidecar handshake (cold) | **119 ms** |
| Authenticated `/health` | 200, all 16 `godot-cli` exports present |
| Shell RSS | **9.5 MB** |
| Sidecar (Node + Core) RSS | **42.9 MB** |
| Silent uninstall | exit 0 |

**Decision.** Keep Tauri 2 + a Node sidecar. There is no need for the Electron fallback.

**Open item for Phase 13.** Tauri's per-user NSIS default installs to `%LOCALAPPDATA%\ModuleX Game Studio`.
The plan asks for `%LOCALAPPDATA%\Programs\ModuleX Game Studio`, which needs a custom NSIS
`INSTALLDIR`/template hook.

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

## D-022 · Phase 3 UI Direction Review (APPROVED by the owner, 2026-09-29)

The review package is [`ui/UI_DIRECTION.md`](ui/UI_DIRECTION.md). It contains:

- the clickable prototype at `#/prototype`;
- 58 screenshots: 9 screens × dark/light, 36 state variants, 3 Arabic RTL views and the command palette;
- icon concepts A–D, with A recommended. Its 16 px trade-off versus B is stated explicitly.

**Execution is stopped here, as the plan requires** (owner checkpoint 1). The owner's decision will be
recorded below, and only then does production UI work start.

- Owner decision: **APPROVED as presented**, including the Execution Patch 1 monochrome revision and the
  Patch 2 System section (owner message: "موافق كمل بقيت المراحل" — "approved, continue the remaining
  phases").
- Date: 2026-09-29
- Consequence: GATE 3 is passed. Phases 4–15 proceed in order, and the production screens implement the
  approved prototype.

---

# Execution Patch 1 (2026-09-29)

## D-023 · Two tool layers (DECIDED, built)

**Layer A** is the Agent-safe `studio_*` set: 39 declared, 18 live. It is the default for every agent.

**Layer B** is the 54 raw Godot-MCP tool ids. They are reachable only:

- inside Studio Core; or
- by the ModuleX Agent in owner-confirmed **Developer Mode**, with the `raw-tools` capability.

**`reflection-method-call`** needs the separate `reflection` capability, and even then it asks for approval
on every call.

**Claude Desktop** never receives Layer B.

**What an agent is shown.** The tools advertised to an agent are advertised ∩ implemented, so a declared
but unbuilt tool is never listed.

**Code and tests:** `shared/src/policy.ts` (`decide`, `advertisedTools`) and
`core/src/gateway/gateway.ts`. Tests: `shared/tests/policy.test.ts`, `core/tests/security.test.ts`.

## D-024 · D-010 re-confirmed: the gateway is the only enforcement point (DECIDED)

Addon-side hiding stays as noise reduction. Security never depends on it. The ModuleX Agent and Claude
Desktop never receive the Godot-MCP URL or token. A test calls a raw tool directly through the gateway and
proves that it is refused.

## D-025 · Mode C (local Agent SDK) is not offered (DECIDED, policy)

The Agent SDK overview (code.claude.com/docs/en/agent-sdk/overview) says: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
products, including agents built on the Claude Agent SDK. Please use the API key authentication methods
described in this document instead."

- A subscription-login mode is therefore not permitted.
- An API-key Agent SDK mode would duplicate Mode A's billing. It would also bring file and shell tools that
  work outside the Policy Gateway.

**Decision.** Settings shows "Local Agent SDK: Unavailable" with the reason, and routes to Mode A.

## D-026 · Claude Desktop handoff uses the documented deep link (VERIFIED from docs)

The link is `claude://claude.ai/new?q=<url-encoded prompt>` (Claude Help Center, "Open Claude Desktop with
a link", support.claude.com/en/articles/14729294). The prompt:

- is pre-filled and never auto-sent;
- is capped at 13,500 characters, under the documented limit of about 14,000;
- trims the context before the instructions;
- is refused if a secret is detected.

Code: `core/src/claude/handoff.ts`.

## D-027 · Approvals are decided only in the Studio (DECIDED)

- `resolveApproval` accepts only the `owner-ui` principal.
- `studio_approval_action` over MCP supports **withdraw** only. Approve and reject return
  `APPROVAL_NOT_OWNER`.
- An approval is single-use and bound to identical arguments, and it expires after 30 minutes.
- "Always allow for this project" is an owner choice. The UI never offers it for Claude Desktop requests.

## D-028 · Core port and stable credentials (DECIDED, built)

- Core binds `127.0.0.1:47821` by default, which is the port the Claude Desktop extension's `core_url`
  defaults to. If that port is taken, it falls back to a random port.
- There is one bearer token per principal: owner UI, ModuleX Agent and Claude Desktop.
- The owner token is per launch. The agent and pairing tokens are stable. The Tauri shell stores them in
  **Windows Credential Manager** through the `keyring` crate's native Windows backend
  (`app/src-tauri/src/credentials.rs`) and passes them back to Core in the child's environment.
- On other operating systems the shell keeps no store, and the credentials are per launch.
- Verification: `cargo check` passes for `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`, and
  `core/tests/server.test.ts` checks that stable tokens are reused.

## D-029 · Monochrome identity replaces the Cobalt direction (DECIDED by the patch; supersedes part of D-022)

- **Tokens.** Pure grey ink (`#0B0C0E` … `#F5F6F7`). The primary emphasis is near-white on ink (dark) or
  ink on white (light). The five semantic colours are unchanged and are the only hues.
- **Icon.** Concept A is now rendered in pure greys. `render-icons.py` replaces `build-ico.py` (D-021). It:
  - renders PNGs at 16/20/24/32/40/48/64/128/256/512/1024;
  - pixel-hints 16 and 20 px to a four-tone palette;
  - writes the ICO (16–256) and the Tauri icons.

  `--verify` runs in CI.
- **Screenshots.** They are recaptured: 65 images.
- **The Phase 3 owner decision (D-022) is still pending.** It now covers the monochrome direction.

## D-030 · The ModuleX Agent codebase is not accessible (BLOCKED, external)

No ModuleX Agent (Hermes) repository is available to this session. The integration contract is the Studio
MCP surface, `/mcp` as `modulex-agent` with the agent token, plus the structured errors. The agent side
must be connected by the owner or in that repository. The UI calls it "ModuleX Agent", and the Studio does
not duplicate it.

## D-031 · "MarketX" read as the ModuleX Game Studio UI (DECIDED, interpretation)

The patch mentions "MarketX" in UI contexts where every other reference is the ModuleX Game Studio app, so
it is treated as the same product. If the owner meant a separate product, only UI copy changes.

## D-032 · RELEASE must also strip the `ModulexQa` autoload (OPEN, Phase 10)

`ExportRelease` removes the addon C# (`RELEASE_EXCLUSION_CSPROJ`), but `project.godot` still lists
`autoload/ModulexQa`. A PREVIEW or RELEASE export must remove that entry, through the export preset or a
post-export check of `project.binary`. Until this is verified, no RELEASE build is claimed clean. Details
are in `build-profiles.md` §1.

## D-033 · Claude API request shape for Opus 5.5 (DECIDED, built)

- No `thinking` parameter is sent, and no on/off switch is shown: Opus 5.5 always thinks adaptively.
- `output_config.effort` defaults to `medium`.
- The UI offers Low/Medium/High/Max, each filtered by what the model supports. The SDK and the model also
  accept `xhigh`; routing may use it, but it is not in the owner-facing list the patch specifies.
- Settings are validated before the request is sent.
- Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is on by
  default.

---

# Execution Patch 2: System Evolution (2026-09-29)

## D-034 · Three modes with a single lifecycle (DECIDED, built)

Config, extension and core changes share one `EvolutionRecord` and history, one owner-review format and one
audit trail. The difference is where a change lands:

- a config version;
- an extension version;
- a git branch on the Studio source.

**Classification.** The ModuleX Agent's classification is honoured only when it is at least as controlled as
Core's keyword classifier (Arabic and English). An unknown request routes to core.

## D-035 · Approval is bound to the exact change (DECIDED, built)

The review carries `diff_sha256`, computed over one of:

- the git diff (core);
- the JSON config diff plus the base version (config);
- the manifest, permissions and file hashes (extension).

`decide` and `deploy` recompute the hash. A change after approval voids the approval (tested by committing
into the sandbox after approval). CRITICAL and protected changes also require the owner to type the
evolution id.

## D-036 · Extensions are declarative; executable code is a core change (DECIDED)

Core never loads extension JavaScript, and the UI never renders remote code.

**Declarative extension kinds:**

- Skills (Markdown);
- workflows (JSON plus graph);
- providers (configuration of built-in adapter families: `anthropic`, `openai-compatible-http`,
  `comfyui-http`, `local-build`, `filesystem-storage`);
- UI panels (JSON blocks bound to `studio_*` read tools).

**What goes through Mode C instead.** Build adapters, exporters, asset processors, MCP adapters and new
adapter families all need executable code. They go through Mode C, so the code is reviewed as a diff,
tested and approved.

**Why.** An in-process plugin runtime cannot be sandboxed well enough to honour "untrusted extensions must
never receive unrestricted access". The patch pipeline can.

## D-037 · Agent deployment limits (DECIDED, built)

The ModuleX Agent may deploy only **owner-approved LOW/MEDIUM evolutions that touch no protected
control**. HIGH, CRITICAL and protected evolutions are deployed and rolled back by the owner. This covers
the updater, rollback and compatibility controls, as §26 requires.

`studio_evolution_approve` **submits** an evolution for owner review. The name comes from the patch; it
cannot approve anything (consistent with D-027).

## D-038 · Claude Desktop and System Evolution (DECIDED)

Claude Desktop receives only `studio_system_status`, the read-only summary. It receives none of the
evolution, extension, config or repair tools.

The hardening is in `decide`: "always allow" and policy auto-approval now apply **only** to the ModuleX
Agent, and never to protected tools. Before Patch 2, an `alwaysAllow` entry would also have let Claude
Desktop skip approval at the policy level. The UI never offered this, but the code allowed it; it is now
closed and tested.

## D-039 · Configuration is versioned, never overwritten (DECIDED, built)

`ConfigStore` keeps every version. A rollback writes the old value again as a **new** version. A write
fails if the document changed since the proposal (the stale-approval test). The gateway reads the policy
live; an invalid policy document falls back to the defaults and never loosens anything.

## D-040 · Core evolutions need a source workspace (DECIDED; BLOCKED on non-developer installs)

A core change needs the Studio source: `MODULEX_SOURCE_REPO`, a git checkout whose checked-out branch is the
production branch. Installed end-user copies have no source tree. For them, a verified evolution branch
ships as a normal signed release through the update pipeline (Phase 13). Without a source workspace, core
evolutions report BLOCKED honestly, while config and extension evolutions work.

## D-041 · Deferred and live-only items (OPEN)

- **§23 changelog generation: built after all.** `EvolutionService.changelog()` (exposed as
  `studio_evolution_history format="changelog"`) lists only deployed evolutions, and for core changes only
  the commit subjects captured at deploy time. Rolled-back changes are marked as such.
- **Live pieces.** The live workflow test job needs a TRUSTED ComfyUI worker and the Phase 7 client (tests
  use a fake worker). The Godot and MCP diagnostics probes need the Phase 4 Godot manager. The update
  platform steps (download, signature, install, restore) are the Tauri updater's (Phase 13).
- **Production UI.** The production System screens wait for the Phase 3 UI decision; the prototype covers
  every section.

## D-042 · RELEASE must drop the MCP NuGet references, not only the sources (DECIDED, built)

Excluding the addon `.cs` files from ExportRelease is not enough. The Windows RELEASE build still shipped
`McpPlugin.dll`, `ReflectorNet.dll` and the SignalR assemblies. Godot copies every PackageReference into
`data_<Asm>_*`, whether or not the code uses it.

The generated `.csproj` now puts the two PackageReferences and the `extensions.catalog.json`
EmbeddedResource in `<ItemGroup Condition="'$(Configuration)' != 'ExportRelease'">`.

Verified on the sample game: RELEASE is BUILT, and its data folder holds `SpaceKidJourney.dll` with no MCP,
Reflector or SignalR assemblies. The QA build keeps them. The pins are unchanged.

## D-043 · A deterministic game generator stands in for the unavailable agent (DECIDED, built)

The ModuleX Agent repository is not accessible (D-030). So the Studio now turns a GAME_SPEC into a playable
Godot 4.5.1 .NET project on its own, with a deterministic generator:

- one scene per level;
- collectibles, hazards, an exit, a HUD with pause;
- a menu and a shop when the spec asks for them;
- a win screen and a JSON save.

3D assets are procedural placeholders built from Godot primitives, recorded with provenance
`source: procedural`. Assets that need a model (textures, concept images, audio) are marked `blocked` with the
reason. The stage then reports PARTIAL_SUCCESS; it never reports SUCCESS for them.

Claude, or the agent once it connects, improves the game through the Studio tools. The generator is only the
starting point, and the same input always gives the same files.

## D-044 · ComfyUI jobs: persist before send, query before resend (DECIDED, built)

The job system (`core/src/comfy/jobs.ts`) follows these rules:

- Every attempt gets a fresh uuid4 `prompt_id`, and it is written to `comfy_jobs` **before** the POST.
- When the outcome of a submit or a poll is uncertain (for example the connection drops), the Studio asks the
  worker about that `prompt_id`.
- A new attempt, with a **new** `prompt_id` under the same idempotency key, is sent only when the worker
  reports the prompt as unknown.
- A completed job for a key returns the cached outputs.

Mock evidence (`core/tests/comfy.test.ts`):

- Response dropped after the worker accepted the job: 1 accepted submission, and the job completes.
- Submit dropped before the worker saw it: 2 `prompt_id`s, 1 accepted submission.
- A crash mid-job: the persisted `prompt_id` is followed, and nothing is resubmitted.

Retries apply only to `worker_lost` and `timeout`. A timeout also cancels the job on the worker. Outputs are
size-capped, hashed and checked by magic bytes. A malformed output is a worker anomaly.

## D-045 · Built-in workflows ship UNVERIFIED (DECIDED; live verification BLOCKED)

The plan requires registry entries that come from real, tested workflows. There is no GPU worker in this
environment. `CONCEPT_IMAGE.sdxl` and `3D_PROP.hunyuan3d2` (the ComfyUI core Hunyuan3D v2 nodes, mesh only)
therefore ship as **UNVERIFIED**:

- They run only test jobs, such as onboarding and the GATE 7 live test.
- Production jobs report `BLOCKED workflow_unverified`.

A workflow becomes VERIFIED only after a real generation passes validation. The GATE 7 live test
(`comfy-live.test.ts`, `MODULEX_COMFY_URL`) currently reports **BLOCKED — no ComfyUI worker configured**.

The Hunyuan3D-2 licence is recorded as `conditional`: not licensed in the EU, UK or South Korea, and a separate
licence is needed above 1M MAU.

## D-046 · GLB validation, processing and Godot import (DECIDED, built)

**Validator.** `core/src/assets/validate.ts` runs the Khronos glTF-Validator (Apache-2.0) and glTF-Transform
(MIT). Every check writes an evidence row. Checks: container, size, Khronos errors, mesh, finite positions,
surface area and degenerate ratio, triangle budget, scale, and the rig checks.

**Processing.** `process.ts` uses gltf-transform and meshoptimizer (MIT). It does:

- weld, dedup and prune;
- simplify to the category budget;
- normalise the scale, then ground and centre the model.

Texture resizing, UV unwrap, rigging and animation report `skipped` or `blocked`. They are never faked.

**Stage machine.** An unrigged character that needs a rig ends BLOCKED with "requires rigging".

**Importer.** `godot-import.ts` re-validates the exact bytes before copying them. A failure after the copy
restores the pre-import checkpoint.

Deviations:

- **Scratch clean-up.** `node-delete` is a destructive-tier tool, so a clean-up would need an owner approval.
  The importer instead uses a per-import scratch scene in the git-ignored `res://.modulex/scratch/` and
  reopens the previous scene.
- **Asynchronous import.** A windowed editor scans and imports asynchronously, so `resource-find` is polled
  (bounded to 60 s, with a rescan every 10 s).
- **Blank thumbnails.** These are detected by decoding the PNG and measuring luminance variance. The live crate
  render measured 6080.8; a flat image measures 0.
- **Over-budget fixture.** It has 24,200 triangles, over the 20,000 prop budget, instead of 5M. The code path is
  the same, and it keeps the fixture small.

**GATE 8.**

- 14 fixture tests pass.
- Live against a real editor:
  - Headless: PARTIAL_SUCCESS, because the thumbnail cannot render without a GPU. This is stated, not hidden.
  - Windowed under Xvfb: SUCCESS, with the thumbnail and a MeshInstance3D.
- A malformed GLB never reaches `res://`, and no editor call is made for it.

## D-047 · Generator restore stands in for the unavailable agent fixer (DECIDED, built)

The Phase 9 fix loop needs a fixer. The ModuleX Agent is not reachable (D-030), so the loop's only automatic
fixer is **generator restore** (`core/src/qa/fixers.ts`). Every generated file has a known-good version: the
deterministic generator's output (D-043).

- A failure that points at a generated file is fixed by restoring that file. The file can be named directly (the
  top frame) or through a reference to a missing resource, and it must have drifted from the generator.
- A failure in a file the generator does not own cannot be fixed this way. The loop ends **BLOCKED**, naming the
  file and suggesting an action.
- The limits are unchanged: 3 attempts per fingerprint, 8 per run, 30 minutes. A checkpoint is taken before
  every attempt, and a regression restores it.

When the agent connects, it becomes a second `Fixer`, tried after generator restore. The loop does not change.

## D-048 · Generated projects ship a nuget.config without a local feed (DECIDED, built)

Every generated project gets a `nuget.config` that clears inherited sources and lists nuget.org only. A machine-wide
`NuGet.Config` with a dead private feed therefore cannot break `dotnet restore` of a game.

The plan also asks for an offline-capable local feed, holding the pinned ReflectorNet 5.4.1, McpPlugin 8.6.0 and
GodotSharp packages. That feed is **not** in the template: its path is only known on the owner's machine. The Setup
Assistant (Phase 13) will create it and add it to the project's `nuget.config` as a second source.

## D-049 · The QA runtime owns a pause-proof main-thread dispatcher (DECIDED, built)

**Finding (GATE 9).** `pause-resume` timed out. After `get_tree().paused = true`, every in-game QA tool call stopped
answering. Each call marshals onto the main thread through the `MainThreadDispatcher` queue, which drains in
`Node._Process`. The runtime adds its dispatcher under the tree root with the default process mode
(Inherit → Pausable). A paused tree therefore never drains the queue.

**Fix.** The fix is in `addons/modulex_studio` only, with **zero diff in `addons/godot_mcp`**.

1. Before `GodotMcpRuntime.Initialize(...).Build()`, `ModulexQaAutoload._Ready` adds its own
   `MainThreadDispatcher` as a child, with `ProcessMode = Always`. The autoload already runs with `Always`.
2. `AddChild` enters the tree synchronously, so `MainThreadDispatcher.Instance` is set.
3. `GodotMcpRuntime.EnsureMainThreadDispatcher` then takes its documented "already pumped" path and adds nothing.

`Engine.GetProcessFrames()` keeps counting while the tree is paused, so frame-bounded waits still finish.

**Evidence.** GATE 9: `scenario pause-resume: passed (7/7 steps)`. Before the fix, 7 of 8 scenarios passed.

## D-050 · The QA tier is wired into the pipeline when MODULEX_SERVER is set (DECIDED, built)

`createPipelineEngine` builds a `QaTier` when `PipelineHostConfig.serverBinary` is set. `main.ts` sets it from
`MODULEX_SERVER`, which the shell sets only when the bundled server exists. The tier consists of `QaRunner` (static
tier plus a scripted playtest on the project's own playtest server) and the `FixLoop` with generator restore.

- **playtest.** The default scenarios are written to `.modulex/tests/` if none exist.
  - No failures: SUCCESS.
  - Failures: PARTIAL_SUCCESS with "N QA failure(s) found; handed to bug_fixes".
  - A playtest that could not run: FAILED.
- **bug_fixes.** Runs the fix loop. All fixed: SUCCESS. Otherwise BLOCKED, with the loop's summary. After a Core
  restart, the loop re-runs the suite itself.
- **Without `MODULEX_SERVER`.** The stage stays a boot-only PARTIAL_SUCCESS, and its reason says the scripted
  scenarios did not run.
- **`/health`.** It reports `pipeline: { available, qaTier }`: capabilities only, never paths.
- **`--selftest`.** The shell now passes the same `bundled_env` as the GUI. CI asserts:
  - the small installer reports `available=false`;
  - the full installer reports `available=true` and `qaTier=true`.

**Failure attribution.** `godotErrors` now keeps the GDScript `at: … (res://…:N)` frame on a `SCRIPT ERROR`
line. Without the frame, a headless scene-run failure had no file. The fix loop then logged "names no file",
spent its attempts, and could not name the unfixable script in its BLOCKED summary.

## D-051 · Remote build workers: protocol, trust and resumability (DECIDED, built)

**Worker** (`studio/worker`, `modulex-build-worker`). A Node HTTP(S) service. Its protocol lives in
`@modulex/shared` (`build-worker.ts`), so Core and the worker validate the same shapes.

- **TLS is mandatory** unless the worker binds to loopback only. There is no flag for plain HTTP on a reachable
  interface. The Studio client refuses `http://` for anything but loopback, and refuses URLs that carry
  credentials.
- **Pairing.**
  1. `modulex-build-worker pair` prints a one-time code (`XXXX-XXXX`) on the worker host. It is valid for
     10 minutes, works once, and is burnt after 5 wrong attempts.
  2. The Studio exchanges the code once for a `mxw_` token.
  3. The worker stores only the token's SHA-256 and compares hashes in constant time. A copied state directory is
     therefore not a credential.
- **Jobs.**
  - `bj_` ids are client-generated and idempotent. The same spec returns the same job; a different spec under the
    same id is refused with 409.
  - The bundle upload must match the size and sha256 in the spec before the job is queued.
  - Artifact names resolve inside the job's `out/` only.
- **Restart.** A job that was `running` when the worker died becomes `failed/worker_restarted`, because its outcome
  is unknown. Queued jobs run again.
- **Signing.** The worker exports with Godot, verifying `godot --version` against the pinned version. For iOS with
  a signing profile it then runs `xcodebuild archive` and `xcodebuild -exportArchive`. The profile is a NAME the
  Studio sends; its directory (`ExportOptions.plist`, team id) lives on the worker. Certificates and provisioning
  profiles stay in the worker's keychain. Capabilities list profile names only.
- **Install.** On macOS the worker runs as a LaunchAgent (`launchd/com.modulex.build-worker.plist`): a user
  session, so `xcodebuild` can reach the login keychain.

**Studio** (`core/src/build/build-workers.ts`). Same rules as the ComfyUI jobs (D-044):

- The `build_jobs` row (schema v2, `m0002_build_jobs`) is written **before** the worker hears about the job.
- `resume()` at Core start follows every unfinished row by its persisted job id. Re-POSTing is idempotent, so a
  kill -9 at any point never creates a second job.
- `worker_restarted` is retried **once** with a new job id under the same idempotency key.
- Artifacts are downloaded size-capped and checked against the worker's sha256.
- Worker minutes go to `cost_ledger` (`build_worker_minutes`).
- `BuildService`: iOS with a paired macOS worker and a selected signing profile gives **SIGNED** (`iosStatus`,
  with the .ipa sha256). Without either, iOS stays **PREPARED**, and the note says why.

**GATE 11.**

- **Mock suite** (`core/tests/build-workers.test.ts`): the real worker service in-process with a fake export
  runner. 10/10, stable over 5 consecutive runs. It covers pairing, idempotency, cancel, a Core kill mid-build, a
  Core kill between "row written" and "worker answered", a worker restart, a tampered artifact, a runner failure,
  and SIGNED vs PREPARED.
- **Live macOS test:** **BLOCKED**. There is no Mac in this environment, and the test prints that.

## D-052 · Build worker tokens need the credential store bridge; until then pairing is BLOCKED (DECIDED)

The worker token is a secret, so it may live only in Windows Credential Manager (Execution Patch 1). Core holds a
`secret://buildworker/<id>/token` handle, and `studio.db` stores that handle only.

The Rust shell can already read and write Credential Manager (`keyring`, used for the stable agent and pairing
tokens). However, Core has no channel yet to ask the shell to **store** a new secret at runtime.

- Until that bridge exists (Phase 13), `POST /build-workers/pair` answers **503 BLOCKED**: "credential store bridge
  not available". It never falls back to a file, the database or an environment variable.
- `startCore({ vault })` accepts the bridge as soon as it exists. The tests use `MemoryVault`.
- `studio.db` itself is now opened by `main.ts` under `MODULEX_DATA_DIR`. This is a prerequisite of Phase 12.

## D-053 · Resumability, the completion predicate and budgets (DECIDED, built)

**Storage split.** The plan asks for SQLite "where it asks". `studio.db` now holds everything resumability depends
on:

- the intra-stage tasks (`tasks`, idempotency key plus post-condition);
- ComfyUI jobs (`comfy_jobs`) and build worker jobs (`build_jobs`);
- the cost ledger and budgets.

The project record (manifests, the stage list, provenance, build records) stays in the JSON `StudioStore`. Its
`save()` is now an **atomic replace** (temp file, then rename), so a kill -9 mid-write leaves the previous complete
file. Moving the project record itself into SQLite is a mechanical migration with no behaviour change. It is left
until the production UI needs queries over it.

**Resume.**

- **Core start.** `resumeInterrupted()` continues every project whose latest run has a stage left RUNNING.
  `BuildJobs.resume()` follows unfinished worker jobs.
- **Within a stage.** Units of work claim `run|stage|unit` in `tasks`. A unit that is DONE, and whose
  post-condition still holds (the scene file exists), is skipped. A run killed at "scene 17 of 30" therefore
  resumes at scene 17.
- **ComfyUI.** Follows the persisted `prompt_id` (D-044).
- **Builds.** Follow the persisted `job_id` (D-051).

**Completion predicate.**

- `core/src/pipeline/completion.ts` maps the recorded evidence to `CompletionEvidence`, and the engine stores the
  verdict on the run after every execution. `studio_pipeline_status` returns it; nothing can set it.
- **The mapping is strict.** A PARTIAL_SUCCESS stage proves nothing. For example, a boot-only playtest leaves
  `qa.smokeTestsPass` missing. Platforms count only through their latest export build record.
- **Windows launch smoke.** It runs only on a Windows host. Elsewhere it stays missing, so a pipeline on Linux can
  never report a complete Windows game.

**Budgets.**

- `Budget` reads the caps from the versioned `budgets` config document and the spend from the ledger, both
  per project and per calendar month (UTC).
- A stage pre-flight estimate that would cross a cap stops the stage as NEEDS_HUMAN, with the numbers.
- A tool call whose estimate would cross a cap becomes an **Ask** (owner approval), even for an auto-approved or
  always-allowed tool.

**GATE 12.**

- `core/tests/resume.test.ts` (8 tests): Core killed at scene 17/30, then resumed at 17; Core killed
  mid-generation, after which the worker accepted exactly one prompt; the predicate wired to the pipeline; budgets
  and Ask.
- "Kill mid-build" is in `build-workers.test.ts` (GATE 11).
- `shared/tests/completion.test.ts`: all 131,072 combinations of missing evidence, every single failing row, the
  platform rules and NEEDS_HUMAN.

## D-054 · Frame-bounded QA waits tolerate 2 fps (DECIDED, built)

**Finding (GATE 10, first Windows run, `windows-latest`).** The exported QA build connected, and `boot` and
`level-2` passed. Every scenario with a `wait frames=30` step failed: `wait not satisfied`. The tool's wall-clock
budget assumed at least 10 fps (30 frames in 5 s). A windowed game on the runner's software renderer, with no GPU,
runs slower than that.

**Fix** (`addons/modulex_studio` only):

- `GameToolSpecs.FrameBudgetSeconds(frames, slack, cap)` assumes `MinBudgetFps = 2`.
  - `game-wait` is capped at `MaxWaitSeconds` (30 s).
  - The `game-input-action` hold is capped at 120 s.
- The frame counter still decides, so a normal game returns as soon as the frames have elapsed. A really stuck game
  is still caught by the runner's hang detection: the frame counter not moving for 5 s.
- xUnit covers the budget.

**CI.** The windowed attempt's failure never reached the headless retry, because the Actions bash runs with `-e`.
The step now uses `set +e`, so the documented fallback (`MODULEX_SMOKE_HEADLESS=1`, with a workflow warning)
really runs.

## D-055 · Setup Assistant: sources, checksums, state and runtime enablement (DECIDED, built)

`core/src/setup/assistant.ts` installs, per user and without admin rights, what the installer did not bundle.

| Component | Source | Checksum (fail-closed) |
|---|---|---|
| Godot 4.5.1 mono | godot-builds release | `SHA512-SUMS.txt` |
| Export templates (`.tpz`, the `version.txt` must say `4.5.1.stable.mono`) | godot-builds release | `SHA512-SUMS.txt` |
| .NET 8 SDK (private, `DOTNET_ROOT`) | Microsoft `releases.json`, latest SDK | its published SHA-512 |
| gamedev-mcp-server 9.2.9 | GameDev-MCP-Server release | `SHA256SUMS` |
| Git | on PATH, or MinGit (Windows) | the GitHub release asset `digest` |
| JDK 17 | Adoptium API | its sha256 |
| Android SDK (cmdline-tools, then `sdkmanager` for the Godot 4.5 set) | Google `repository2-3.xml` | its SHA-1 |
| Android build template | `android_source.zip` from the export templates | — |

**How it installs.**

- Downloads resume (`.part` + Range).
- Archives are extracted into a temp folder and renamed into place, so a half-extracted tree is never used.
- State is persisted after every step (`setup/state.json`, atomic).
- Components the full installer bundled (`MODULEX_GODOT`, `MODULEX_SERVER`) are recorded as `bundled`, without a
  download.
- The Android SDK licence is the owner's to accept. Without `accept_android_license`, the component stays
  `needs_owner` and nothing runs.

**Core.**

- Owner-only `GET /setup` returns the components, the plan for the `build_preferences` platforms, the progress and
  the pipeline capabilities. `POST /setup/install` takes `{component, accept_android_license}` and is audited.
- Once Godot is installed, and the shell has passed the projects root and the addons source, Core builds the
  pipeline engine and hands it to the Gateway **without a restart**. It never swaps an engine under a running
  pipeline.

**Evidence.**

- 7 tests against a local mirror of every source: checksum, tampering, resume, bundled/detected, Android consent,
  and the endpoint enabling the pipeline.
- Live against the official sources on Linux: Godot (sha512 verified) and the server (sha256 verified) installed,
  and `godot --version` = `4.5.1.stable.mono.official.f62fdbde1` from the installed copy.
- `.NET` is refused by this environment's egress proxy (`builds.dotnet.microsoft.com` 403). The Windows CI job runs
  the live test with `godot-mono,mcp-server,dotnet-sdk,git`.

## D-056 · The credential store bridge over the sidecar's stdio (DECIDED, built; supersedes the BLOCKED part of D-052)

Core never touches Credential Manager directly. The Tauri shell does, through `keyring` (DPAPI, per user).

**Protocol.**

- **Request.** Core writes one line to its stdout:
  `{"type":"vault-request","id":n,"op":"set|get|delete","ref":"secret://a/b/c","value"?}`.
- **Response.** The shell answers on Core's stdin: `{"type":"vault-response","id":n,"ok",…}`.
- **Pipe.** The pipe is private to the parent/child pair. The shell ignores every other stdout line, and never
  echoes or logs any of them.

**Shell** (`src-tauri/src/vault.rs`).

- **Accepted refs.** Only `secret://<seg>/<seg>/<seg>` (lowercase, digits and `-`, up to 64 characters each). It
  maps to the entry `vault/<path>` under the "ModuleX Game Studio" service.
- **Non-Windows.** It answers `ok=false` ("no credential store on this OS").
- **Reading Core's stdout.** One thread now reads Core's stdout for its whole lifetime, starting with the
  handshake. This also removes a latent bug: after the handshake nothing read Core's stdout, so a full pipe could
  have blocked Core.

**Core** (`audit/stdio-vault.ts`).

- **Bridge.** `StdioVault` is enabled only when the shell sets `MODULEX_VAULT_BRIDGE=1`.
- **Stored values.** They are registered with the redactor.
- **A refused or unanswered request.** It throws, or times out, and never falls back to another store.
- **Pairing.** `/build-workers/pair` therefore works in the app. The worker token lives only in Credential
  Manager, and `studio.db` holds the handle.
- **Self-test.** The owner endpoint `POST /vault/selftest` stores, reads back and deletes a random probe.

**Evidence.**

- Rust unit tests: ref mapping, and non-requests ignored.
- Core: 3 tests with a fake shell that implements the same protocol: round-trip, refusal without a fallback, a
  timeout, and pairing through the bridge with the token only in the store.
- `--selftest` calls `/vault/selftest`, and **Windows CI requires `vault_ok == true`** for both installers. That
  is a real Credential Manager round-trip on `windows-latest`.

## D-057 · Authenticode signing in CI, only with the owner's certificate (DECIDED, built)

Signing runs through Tauri's `bundle.windows.signCommand`, so the app executable, the bundled binaries and the NSIS
installer are each signed.

- **The config file.** CI generates `tauri.sign.conf.json` only when the `WINDOWS_SIGNING_PFX_BASE64` secret
  exists. It points `signCommand` at `studio/app/scripts/sign-windows.ps1`.
- **The script.** It runs `signtool` with SHA-256 and an RFC 3161 timestamp, and fails unless
  `Get-AuthenticodeSignature` reports `Valid`.
- **The status step.** A final step prints the Authenticode status of both installers. It fails if signing was
  enabled and a file is not validly signed.
- **Without the secret.** The build is unsigned, with an explicit notice. Nothing is faked.

The certificate never enters the repository (security.md §4).

## D-058 · Updater: signed release feed, verified before anything runs (DECIDED, partly built)

**Built.**

- `evolution/minisign.ts` verifies minisign signatures on Node's own crypto (Ed25519, plus BLAKE2b-512 for the
  prehashed `ED` form). It accepts Tauri's base64 wrapping. The trusted-comment global signature is always
  checked.
- `evolution/release-feed.ts` supplies `fetchFeed`, `download` and `verifySignature` to the Patch 2
  `UpdateManager`:
  - the feed and the installer download are size-capped;
  - downloads must use https;
  - the signature must be by the public key built into the app.
- **No key configured means every update fails `verify`, before backup or install.** Checking never installs.
  Applying is owner-only, and Stable is the default channel and never sees Beta.

**Evidence.** The minisign fixtures were generated with an **independent implementation** (py-minisign). The tests
cover:

- prehashed and legacy signatures, accepted;
- tampered bytes, a tampered trusted comment, a foreign key and garbage, all rejected;
- a signed release that installs through `UpdateManager`;
- a foreign signature or a missing key, which ends FAILED at `verify` with nothing installed.

**Open (needs the owner).**

1. **The update signing key pair.** The private key goes into CI secrets; the public key is built into the app.
2. **Publishing the per-channel feed** from the release workflow.
3. **The restart handoff to the shell.** An NSIS installer cannot replace the running app, so the shell must run
   the verified installer and exit. The health check then runs on the next boot (`pending_health_check`).

Until all three exist, the in-app updater stays disabled. That is the documented default: never automatic, and
"check for updates" offers nothing it cannot verify.

## D-059 · Licence inventory from the real sources, enforced by a test (DECIDED, built)

`studio/scripts/third-party-licenses.mjs` generates `studio/third-party-licenses.json` and
`docs/modulex/THIRD_PARTY_LICENSES.md`. Nothing is listed by hand except the runtimes and the NuGet pins, which have
no machine source.

| Section | Source |
|---|---|
| Core | the **esbuild metafile** of the production bundle: exactly what ships |
| Core-declared-but-not-bundled | Core's `package.json` graph, minus the bundle |
| UI | the lockfile graph of `app/ui` |
| Rust crates | `cargo tree -e normal --target x86_64-pc-windows-msvc` |
| Models | the workflow `license_facts` |
| Bundled/installed runtimes | listed, with how each is shipped |

`core/tests/licenses.test.ts` fails when:

- the committed inventory differs from a fresh one (bundle, lockfile, models; crates when cargo exists);
- any shipped npm package or Rust crate is outside the policy. The policy is permissive licences, plus MPL-2.0
  (crates, unmodified) and OFL-1.1 (UI fonts). It excludes GPL, LGPL, AGPL, SSPL and unknown licences.

Copyleft runtimes are separate programs, never linked, and are listed as such:

- MinGit and the JDK, both GPL-2.0;
- ComfyUI, GPL-3.0, which is never distributed.

The installers ship `licenses/LICENSE.txt`, `THIRD_PARTY_LICENSES.md` and `NODE_LICENSE.txt`, and CI checks that
they are installed.

**Finding.** The metafile shows that the bundled Core does not reach `@gltf-transform/functions`, `meshoptimizer`
or `@anthropic-ai/sdk`. The Phase 8 asset processing (`assets/process.ts`) and the Mode A provider are library code
exercised by tests, but no path from `main.ts` reaches them yet. They are listed under "declared but not bundled",
and they move to the shipped section automatically once wired. Wiring the asset factory into
`asset_generation`/`asset_processing`, behind a TRUSTED ComfyUI worker, is open work (see PROGRESS).

## D-060 · The production UI: the approved design system, fed only with live Core data (DECIDED, built)

**What.** `app/ui/src/studio/` is the production desktop UI. It reuses the approved Phase 3 design system unchanged:
tokens, layout classes, components and icons. The shell is the same as the prototype: the icon rail, the top bar
with the health cluster, the Dev Mode pill, the budget meter, the approvals badge, Ctrl+K, dark/light, and Arabic
RTL. The screens are new and focused, and they read only Core's owner endpoints:

- **Projects** · **Studio** (the 19-stage pipeline and the completion verdict) · **Activity** (the audit log)
- **Assets** (provenance) · **Test & Debug** (the QA stages' evidence and recent errors)
- **Builds** (with sha256) · **Workers** (ComfyUI trust, build workers, pairing) · **Approvals** (the owner decides)
- **Setup Assistant** · **Settings** (appearance, budget, Developer Mode with a second confirmation)

The review prototype stays at `#/prototype`, and its 65 tests are unchanged.

**Rules.**

- **Nothing is invented.** A field Core does not report is shown as "not reported". The health cluster is derived
  only from `/health`, `/setup`, `/workers` and `/build-workers`.
- **Errors are per endpoint.** Every endpoint is polled independently (2.5 s), so one failing request shows its own
  error state with the evidence while the rest keeps working.
- **The owner token.** It comes from the shell's `core_connection` command and lives only in memory: never in the
  URL, storage or logs. `?core&token` works in `vite dev` only.
- **CORS.** Core now answers CORS for the UI's exact origins only: `tauri://localhost`, `http(s)://tauri.localhost`
  and `http://localhost:1420`. A preflight gets no data, other origins get 403, and every request still needs its
  bearer.
- **New owner endpoints, all read-only.** `GET /projects`, `GET /projects/:id`, `GET /workers` (secret refs
  stripped) and `GET /budget`.

**Tests.** 9 new UI tests against a fake Core with the real shapes:

- live projects and pipeline;
- the verdict shown verbatim;
- an approval posted, and no "always allow" for Claude Desktop;
- Setup installs, and the Android licence gate;
- per-endpoint error states;
- RTL persistence;
- the Developer Mode double confirmation;
- the health derivation;
- route parsing that rejects traversal.

Plus a Core CORS test.

**Not yet.** These need agent-side APIs that do not exist yet: the Conversation panel (the chat with the ModuleX
Agent, which is not reachable, D-030), the live editor Preview, and the 3D asset viewer. Their screens say so; they
are not faked.

## D-061 · Live end-to-end run of the bundled Core, and what it found (DECIDED, fixed)

**The run.** On this Linux host, the production bundle (`core/dist/modulex-core.mjs`, exactly what the installer
ships) ran with the shell's environment: Godot 4.5.1 mono, the 9.2.9 server, the addons and a projects root.

- **Claude Desktop** (its pairing token, over `/mcp`) called `studio_game_create` with `SAMPLE_GAME_SPEC`.
- **The pipeline ran in the background:**
  - project creation, `godot --import` and `dotnet build`;
  - scenes, then gameplay and static QA;
  - the scripted **playtest through the QA tier**, all 10 default scenarios passing, windowed under Xvfb;
  - the fix loop, with nothing to fix;
  - regression.
- **Then `build` stopped BLOCKED** with the exact fix. This host has no export templates.

**The UI.** It ran in `vite dev` against that Core. The screenshots are in `docs/modulex/ui/production/` (12
screens, plus light and Arabic RTL).

**Defects found by the run, all fixed with tests:**

1. **Playtest launched windowed with no display.** The game exited before connecting, the fix loop called it a
   crash, and the run ended BLOCKED. Now it is windowed only on Windows or with `DISPLAY`; otherwise headless, and
   screenshot steps are "skipped".
2. **The build path never checked the export templates.** Missing templates produced a FAILED export blamed on
   "C# assemblies missing". Now that is BLOCKED, with "install Export templates 4.5.1 (.NET) in the Setup
   Assistant".
3. **A BLOCKED build stage was reported as PARTIAL_SUCCESS**, and the run continued. It now stops the run.
4. **The approval impact of `studio_asset_delete` listed scene files** (the procedural placeholders) that `run`
   never moves. The owner would have decided on a false impact. It now lists only files under
   `res://assets/generated/`, and the scope says which assets are only reset in the manifest.
5. **UI layout and bidi.** Long hashes and paths overflowed the Studio columns, and English sentences rendered
   with reordered punctuation inside the Arabic (RTL) layout.

## D-062 · Studio Core starts in the background; startup failures are shown, logged and retryable (DECIDED, built)

**The report.** On the owner's Windows PC, the installed app stayed on "Connecting to Studio Core…" for 15 minutes.

**The causes in the app.**

1. **The error was hidden.** Tauri rejects a command with a plain string, but the UI read `e.message` from it. That
   is `undefined`, so the screen fell back to "Connecting…" forever and the real error never showed.
2. **There was no log.** Core's stderr was inherited by a GUI process that has no console, so it was lost.
3. **The self-test did not run the GUI's configuration.** It started Core without the data directory and the
   stored credentials, so a GUI-only failure could pass CI.

**The root cause, found from the owner's `core.log`.** The log said `Error: EISDIR: illegal operation on a directory,
lstat 'C:'` from Node's `resolveMainPath`. Tauri canonicalizes its own executable path, so on Windows
`resource_dir()` is a verbatim path (`\\?\C:\Users\…\core\modulex-core.mjs`), and Node cannot start an entry
script given that way. The self-test and the installed-app test built the path from `current_exe()` without
canonicalizing it, so they never saw the `\\?\` form. The fix is `plain_path()`: every path handed to Core (the
script, the resources, the data dir, home) is ordinary (`C:\…`, or `\\server\share\…` for UNC). The self-test now
resolves its resources from a canonicalized exe path, as Tauri does, so Windows CI exercises the verbatim form. A
unit test covers the conversion.

Before that log arrived, the failure was not reproduced. Linux runs of the bundle with the GUI's exact
environment hand off in 0.25 s: first run, no data folder yet, and stored tokens. The changes below make the next
occurrence show its cause.

**The changes.**

- The shell starts Core on a background thread. `core_connection` returns `starting` (with elapsed seconds),
  `ready` or `failed` (with the error and the log path). A new `restart_core` command backs **Retry**.
- The handshake timeout goes from 20 s to 90 s, because a first-launch antivirus scan of the unsigned bundle can be
  slow. If Core exits before its handshake, that is reported at once ("exited during startup (exit code)"), not
  after the timeout.
- Core's stderr and the shell's startup errors go to `logs\core.log` in the app data folder. The file starts over
  past 5 MB, and it holds no tokens.
- The UI polls while Core is starting. On failure it shows the error, the log path, **Retry** and **Copy
  diagnostics**, and any rejection value is converted to text.
- One function, `core_environment`, builds Core's environment for both the GUI and `--selftest`. The Windows CI
  self-test now also asserts that the log was written.

