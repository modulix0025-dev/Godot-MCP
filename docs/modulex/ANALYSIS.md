# ModuleX Game Studio: Repository Analysis and Architecture Proposal

> What this is: the architect's analysis of the `modulix0025-dev/Godot-MCP` fork, based on reading the code.
> It covers Sections 1–4, 6 and 7 of the requested deliverable.
> Section 5, the execution prompt for the implementing Claude, is in
> [`EXECUTION_PROMPT.md`](EXECUTION_PROMPT.md).
>
> The snapshot is `main` @ `44ec555` (addon/CLI v0.25.1, analysed 2026-09-29).
> File references are repository-relative.

---

## SECTION 1 — CURRENT REPOSITORY ANALYSIS

### 1.1 What the repository is

| Sub-project | Path | Language | Role |
|---|---|---|---|
| Godot editor addon | `addons/godot_mcp/` | C# (`Godot.NET.Sdk/4.3.0`, `net8.0`) | A `[Tool]` `EditorPlugin` (`Editor/GodotMcpPlugin.cs`) that connects the live Godot editor to an MCP server over SignalR and exposes 42 tools. |
| CLI and embeddable library | `cli/` | TypeScript, ESM, Node `^20.19 \|\| >=22.12` | The `godot-cli` npm package. It can be used as a CLI, or as a library with side-effect-free `{kind:'success'\|'failure'}` functions, "so a GUI (the app) can render the same list" (`cli/README.md`). |
| Unit tests | `Godot-MCP.Tests/` | xUnit | 63 files, 744 `[Fact]` and 138 `[Theory]`. The project compiles a pure-managed subset of addon sources by `<Compile Include>` links. |
| Headless CI testbed | `Godot-Tests/` | Godot C# project | Has an addon-load smoke test, and a runtime harness (`Harness/RuntimeHarness.cs`, issue #186) that boots a headless game and connects it to a local MCP server. |
| CI / release | `.github/workflows/`, `scripts/` | YAML, Python, Node | Covers Godot 4.3.0 / 4.4.0 / 4.5.1 / 4.6.3 / 4.7.0 (mono), Linux runners only. Release publishes the addon zip, the npm `godot-cli` package, and an Asset Library edit. |

The MCP server is not in this repository. It is the shared, engine-agnostic
[GameDev-MCP-Server](https://github.com/IvanMurzak/GameDev-MCP-Server) (Apache-2.0).
The version is pinned by `ServerVersion = "9.2.9"` in `addons/godot_mcp/Runtime/Connection/GodotMcpServerView.cs:69`.
The addon's MCP and reflection stack is consumed from NuGet and must never be bumped in this repository:

- `com.IvanMurzak.ReflectorNet` 5.4.1
- `com.IvanMurzak.McpPlugin` 8.6.0

### 1.2 Runtime topology (as built today)

```
AI client (Claude Code, Cursor, …)
   │  MCP (streamableHttp) → http://<host>/mcp   (optionally pinned …/mcp/p/<pin>)
   ▼
gamedev-mcp-server 9.2.9
   ├─ REST:  POST /api/tools/<tool>          (standard tools)
   ├─ REST:  POST /api/system-tools/<tool>   (System tools: ping, godot-skill-*)
   ├─ GET /help                               (liveness; used by CI)
   └─ SignalR hub ← plugin connects to <host>/hub/mcp-server (path owned by McpPlugin)
          ▲
          │  McpPlugin client; KeepConnected=true, 4 consecutive failures max, 5 s connect timeout
          │
Godot editor process ── GodotMcpPlugin ([Tool] EditorPlugin, #if TOOLS)
   └─ tools run on the editor main thread via MainThreadDispatcher / GodotMainThread

Optional second plugin: an exported/running GAME that calls GodotMcpRuntime.Initialize(...).Build().Connect()
(opt-in, zero tools by default)
```

- **Connection modes.** `GodotMcpConnectionMode { Custom, Cloud }` (`GodotMcpConfig.cs:23-30`). The default is **Cloud** (`https://ai-game.dev` + `/mcp`).
  Custom mode uses `GODOT_MCP_HOST`. If that is not configured, the host becomes `http://localhost:<port derived from project identity>`, in the 20000–29999 range, via `GodotProjectIdentity`.
- **Environment contract.** `Runtime/GodotMcpEnv.cs` defines these variables. They are read live on every access and override code and persisted config:
  - `GODOT_MCP_CONNECTION_MODE`, `GODOT_MCP_HOST`, `GODOT_MCP_CLOUD_URL`, `GODOT_MCP_TOKEN`
  - `GODOT_MCP_AUTH_OPTION` (`none` / `oauth` / `token`; the legacy value `required` maps to `token`)
  - `GODOT_MCP_LOG_LEVEL`
  - `GODOT_MCP_SERVER_PATH` (use a local server binary instead of downloading one)
  - `GODOT_MCP_DEV_CONTROL` and `GODOT_MCP_DEV_CONTROL_PORT` (dev-only loopback bridge, port 9920)
- **Config precedence (editor).** `GodotMcpConnection.ResolveConfig`, lowest to highest:
  1. Project marker `.ai-game-dev/project.json` `serverTarget`. A non-loopback target forces Cloud.
  2. `user://godot-mcp-config.json`, which stores tokens in plaintext (`docs/runtime-security.md`).
  3. `res://.env`.
  4. Derived-port seed.
  5. The process environment, which wins over everything.
- **Local server hosting.** The addon can download, checksum-verify (`SHA256SUMS`, fail-closed) and launch `gamedev-mcp-server`.
  - The binary is cached under `res://.godot/mcp-server/<rid>/`.
  - Transport is always `streamableHttp`.
  - Launch only happens when the user presses **Start Server** in the dock (`ConnectionPanel.cs:800-833`). Nothing starts it automatically.
  - The health check is only "the process has not exited after 5 s". There is no HTTP probe (`GodotMcpServerManager.cs:700-734`).
  - Server stdout/stderr is discarded on purpose, because it echoes the token.
- **Server auth.** The server's own modes are `none` and `oauth` (JWT from ai-game.dev). The addon's `token` option passes a shared bearer through McpPlugin's `ServerLaunchArguments.BuildCommandLine`.
  - The exact argument string is produced inside McpPlugin, not in this repository.
  - CI launches the server as `gamedev-mcp-server port=5400 plugin-timeout=10000 client-transport=streamableHttp authorization=none` (`test_godot_runtime_harness.yml`).
  - The server README documents `--port`, `--client-transport`, `--auth`, and `--bind loopback|any` (default loopback), plus Origin validation.
- **Hot reload.** C# assembly reload is handled by `GodotMcpAssemblyResolver` (`[ModuleInitializer]`) and an idempotent `Teardown(fromReload)` that works around godot#78513.

### 1.3 The actual tool surface (42 tools, 12 families)

Tool names come from the `public const string …ToolId` constants. Families marked `#if TOOLS` exist only in the editor build.

| Family | Tools (exact ids) | Notes that matter for ModuleX |
|---|---|---|
| `Tool_Ping` | `ping` | System tool, served only at `/api/system-tools/ping`. Readiness probe. |
| `Tool_Node` (editor) | `node-find`, `node-create`, `node-modify`, `node-set-parent`, `node-reorder`, `node-duplicate`, `node-delete` | `node-create` can instance any `PackedScene` path (`ResourceLoader.Load<PackedScene>`, no extension check), so an imported `.glb` should instance; this must be verified. `node-modify` supports RFC 7396 `jsonPatch` and path patches. None of these tools save the scene. `node-delete` has no `DestructiveHint`. |
| `Tool_Scene` (editor) | `scene-open`, `scene-save`, `scene-create`, `scene-list-opened`, `scene-get-data` | `scene-get-data` returns a `NodeData` tree (`hierarchyDepth=-1` means the full tree). |
| `Tool_Resource` (editor) | `resource-find`, `resource-get-data`, `resource-modify`, `resource-create`, `resource-move`, `resource-delete` | `resource-move` does **not** rewrite references. `resource-delete` has no `DestructiveHint`. |
| `Tool_FileSystem` (editor) | `filesystem-list`, `filesystem-reimport` | Reimport waits up to 5 s for the scan, using `Thread.Sleep` on the main thread. |
| `Tool_Script` (editor) | `script-read`, `script-create`, `script-update`, `script-delete`, `script-attach-to-node`, `script-validate` | `script-validate` handles **GDScript only**. It reports `Precise` diagnostics on Godot 4.5+ (engine logger) and `Coarse` otherwise. For C#, it tells the caller to use the project build. Writes run a GDScript parse pre-check. |
| `Tool_Screenshot` (editor) | `screenshot-viewport`, `screenshot-camera`, `screenshot-isolated` | Returns MCP image content (`image/png`, longest edge ≤ 3840). **Returns an empty-image error under `--headless`.** Captures only the editor viewport, not the running game. |
| `Tool_Editor` (editor) | `editor-application-get-state`, `editor-application-set-state`, `editor-selection-get`, `editor-selection-set` | `set-state(isPlaying, scene='main'\|'current'\|res://…)` calls `PlayMainScene`/`PlayCurrentScene`/`PlayCustomScene`/`StopPlayingScene`. The game runs as a **separate OS process**. There is no pause state. |
| `Tool_Console` | `console-get-logs`, `console-clear-logs` | Covers the **editor process only** (plugin logs plus engine errors on 4.5+). The running game's output "will NEVER appear here" (`Tool_Console.GetLogs.cs:34-41`). |
| `Tool_Reflection` | `reflection-method-find`, `reflection-method-call` | Calls **any** method, public or private, in any loaded assembly. There is no allowlist and no destructive hint. This is effectively arbitrary code execution. |
| `Tool_RuntimeErrors` | `runtime-errors-get`, `runtime-errors-clear` | Only works **inside a game process** that opted in with `GodotMcpRuntime.Initialize(b => b.WithRuntimeErrorCapture())`. Captures GDScript runtime errors, `push_error`/`push_warning`, shader errors, and C# unhandled / unobserved-Task exceptions with stacks. Paging is by monotonic `sinceSequence`. |
| `Tool_Skills` | `godot-skill-create`, `godot-skill-generate` | System tools, `Enabled=false`. `godot-skill-create` writes a C# tool file (overwrites) that becomes executable after rebuild. |

Other existing mechanisms:

- **Tools from any assembly are discovered automatically.** The editor connection scans `GodotAssemblyUtils.AllAssemblies`, and Godot compiles every `.cs` in the project into one assembly. So a new `[AiToolType]` family placed in any addon folder of the project is registered with no other change.
- **Per-feature enable/disable.** `GodotMcpConnection.SetFeatureEnabled` / `GodotMcpFeatureMap` is persisted as `features` in `user://godot-mcp-config.json`.
  - The CLI separately writes `<project>/.godot-mcp/features.json` (`cli/src/utils/config.ts`).
  - The addon does not reference that path in its C#, so the link between the two is unverified.
- **In-game runtime entry point.** `GodotMcpRuntime.Initialize(b => b.WithConfig(...).WithTools(...).WithRuntimeErrorCapture()).Build()` returns a handle.
  - The handle is default-OFF: it does nothing until `handle.Connect()` is called.
  - It has zero tools by default.
  - It lives in `Runtime/` and compiles into exports.
- **Editor/Runtime boundary.** `scripts/check-runtime-boundary.py` guards `addons/godot_mcp/Runtime/**`. `#if TOOLS` code is stripped from `ExportDebug`/`ExportRelease` (`docs/ARCHITECTURE.md`).
- **Extension catalog.** `addons/godot_mcp/extensions.catalog.json` lists 10 optional NuGet tool packs: Particles, Tilemap, Navigation, **Animation**, CSG, GridMap, PhantomCamera, Beehave, Dialogic, Terrain3D. They are installed by `godot-cli install-extension` (a csproj `PackageReference`).
- **A proven pattern for game QA already exists.** `Godot-Tests/Harness/RuntimeHarness.cs` does the following:
  - It is an env-gated (`GODOT_MCP_HARNESS=1`) node in the main scene.
  - It connects the running game to a local server, raises faults and reads them back.
  - It writes a JSON result and exits with a pass/fail code.
  - CI calls `/api/system-tools/ping` while the game holds the connection.

### 1.4 The CLI library that can be reused as-is (`cli/src/lib.ts`)

| Function | What it really does |
|---|---|
| `createProject({projectPath,name,dotnet})` | Pure filesystem work. Writes `icon.svg`, `<Name>.csproj` and `project.godot`. The csproj is **hard-coded to `Godot.NET.Sdk/4.3.0`** and `config/features=("4.3","C#")`. It does **not** install the addon. Rolls back on failure. |
| `installPlugin({godotProjectPath,source?,version?})` | Downloads (or copies from `source`) `addons/godot_mcp/`, patches the csproj pins and the catalog `EmbeddedResource`, and enables the plugin in `project.godot`. Idempotent. |
| `installServer({godotProjectPath,source?,version?,rid?})` | Downloads `gamedev-mcp-server-<rid>.zip` (https github.com only, `SHA256SUMS`, fail-closed) into `<project>/.ai-game-dev/server/`. **Does not start it.** |
| `buildProject({projectPath,configuration})` | Runs `dotnet build <csproj> --configuration <cfg>` only. **No Godot export.** |
| `openProject({... mode, url, token, auth:'None'\|'Required', build})` | Resolves the editor, builds, then spawns `godot --editor --path <p>` detached with the `GODOT_MCP_*` env vars. Short-circuits if the editor is already running. |
| `runTool` / `runSystemTool({toolName,url,token,input,timeoutMs})` | `POST <url>/api/tools/<t>` or `/api/system-tools/<t>` with an optional `Authorization: Bearer`. Failures are classified (`connection-refused`, `timeout`, `http-error`, …). |
| `setupMcp`, `setupSkills`, `installExtension`, `enrollPlugin`, `configureAgentViaServer` | Write agent configs, generate SKILL.md files, add extension packages, handle cloud enrollment, configure agents through the server. |

Editor resolution (`utils/godot-editor.ts`) checks, in order:

1. The explicit `editorPath`.
2. `GODOT_BIN` / `GODOT4_BIN`.
3. `PATH`.
4. Common install roots.

Candidates are ranked by file-name version. **There is no `godot --version` check anywhere.** `close`, the readiness probe and URL resolution exist only as CLI internals (`utils/godot-shutdown.ts`, `utils/probe.ts`, `utils/connection.ts`), not as library exports. The dependency `@baizor/gamedev-cli-core@0.6.0` requires Node `>=22.14.0`.

### 1.5 Licenses observed

- **This repository:** Apache-2.0. Every source file carries the ASCII header "Copyright (c) 2026 Ivan Murzak". The `LICENSE` appendix placeholder is unfilled. There is no `NOTICE` file.
- **GameDev-MCP-Server:** Apache-2.0.
- **Godot:** MIT.
- **ComfyUI** (v0.37.0 at `Comfy-Org/ComfyUI` master): **GPL-3.0**.

### 1.6 ComfyUI API (verified in `Comfy-Org/ComfyUI/server.py`, v0.37.0)

- **Submit.** `POST /prompt` with body `{prompt: <API-format graph>, client_id?, prompt_id?, extra_data?}`.
  - Response: `{prompt_id, number, node_errors}`.
  - A **client-supplied `prompt_id`** (canonical lowercase UUID) is accepted. This is the basis for idempotent submission.
  - Invalid graphs return 400 with `error` and `node_errors`.
- **Job endpoints:**
  - `GET /api/jobs?status=pending,in_progress,completed,failed,cancelled`
  - `GET /api/jobs/{id}`
  - `POST /api/jobs/{id}/cancel`
  - `POST /api/jobs/cancel`
  - Legacy equivalents: `GET /history/{id}`, `GET /queue`, `POST /queue {delete}`, `POST /interrupt`.
- **Progress over WebSocket** (`/ws?clientId=`). Events: `status`, `execution_start`, `execution_cached`, `executing`, `progress`, `executed`, `execution_success`, `execution_error`, `execution_interrupted`.
- **Outputs and inputs:**
  - Download outputs with `GET /view?filename=&subfolder=&type=output`.
  - The 3D save node `SaveGLB` reports `ui: {"3d": [{filename, subfolder, type}]}` and can write GLB/GLTF/OBJ/FBX/STL/USDZ/PLY/splat.
  - Upload inputs with `POST /upload/image` (multipart).
- **Capability discovery:** `GET /object_info` (installed node classes) and `GET /system_stats` (devices/VRAM).
- **Core 3D nodes present:** `EmptyLatentHunyuan3Dv2`, `Hunyuan3Dv2Conditioning`, `Hunyuan3Dv2ConditioningMultiView`, `VAEDecodeHunyuan3D`, `VoxelToMesh`, `SaveGLB`, and `sam3d_body` exporters, including `glb_skeletal` and `bvh`.
- **No built-in authentication.** Options are `--listen` (default `127.0.0.1`), `--tls-*`, `--enable-cors-header` and `--multi-user`. A remote worker **must** sit behind an authenticated proxy or tunnel.
- All routes are also served under an `/api` prefix.

---

## SECTION 2 — ARCHITECTURE GAPS (concrete, discovered)

| # | Gap | Evidence | Consequence for ModuleX |
|---|---|---|---|
| G1 | **No game export / build tool.** | Neither the tools nor `buildProject` export; `buildProject` is `dotnet build` only. CI uses `include-templates: false`. | ModuleX must implement the export pipeline: `godot --headless --export-release/--export-debug`, export presets, and export templates. |
| G2 | **No test-execution tool.** | No `run-tests` or similar in the tool catalogue. | A QA runner and a game-side QA tool family are needed. |
| G3 | **The editor cannot see the running game.** | Game output does not reach `console-get-logs` (editor only). `runtime-errors-*` only works if the game hosts `GodotMcpRuntime`. Screenshots cover the editor viewport only. | A **game-side QA runtime** (autoload + runtime tools) is required, plus stdout/stderr capture of the game process. |
| G4 | **No in-game screenshot, input injection, or game-state tool.** | Absent. | Visual and gameplay tests are impossible without new runtime tools. |
| G5 | **Headless rendering gives no images.** | `Tool_Screenshot.cs:68-74` returns an explicit `--headless` error. | Visual QA must run with a real renderer: a desktop window on Windows, or xvfb in Linux CI. |
| G6 | **The local server is only started by a dock button.** | `ConnectionPanel.OnServerStartStopPressed`. The CLI's `installServer` never starts it. Health is "process alive after 5 s". | The Studio must supervise `gamedev-mcp-server` itself and probe `/help` plus `/api/system-tools/ping`. |
| G7 | **Cloud is the default mode.** | `ConnectionMode = Cloud` (`GodotMcpConfig.cs:118`). A non-loopback marker forces Cloud. Assisted sign-in may auto-open a browser. | The Studio must always force `Custom` + loopback + `token` through env vars, so it never depends on ai-game.dev. |
| G8 | **Scaffold targets the wrong SDK.** | `createProject` writes `Godot.NET.Sdk/4.3.0`. `GODOT4_5_OR_GREATER` (engine logger, `Precise` script diagnostics, multi-frame backtraces) depends on the **SDK version**. | Generated projects must use an SDK that matches the pinned editor, 4.5.1 or later. |
| G9 | **No engine-version verification.** | The CLI ranks by file name only and never runs `--version`. | The Studio needs a Godot installation manager with a hard version pin and `--version` verification. |
| G10 | **`createProject` does not install the addon or a game template.** | `lib/create-project.ts`. | The Studio must compose `createProject → installPlugin(source=bundled) → template overlay → build`. |
| G11 | **`reflection-method-call` is unrestricted, and delete tools lack destructive hints.** | `Tool_Reflection.MethodCall.cs`. `node-delete` and `resource-delete` have no `DestructiveHint`. | A **policy gateway** between the agent and Godot-MCP is mandatory. The hints cannot be relied on for approvals. |
| G12 | **Plaintext tokens at rest.** | `user://godot-mcp-config.json`. The DevControl bridge is unauthenticated (env-gated). | The Studio must inject tokens by environment only, never persist them in project or `user://` files, and store secrets in Windows Credential Manager/DPAPI. |
| G13 | **No project-settings / input-map / autoload tools.** | Only `reflection-method-call` could do this today. | New allowlisted editor tools are needed, such as `project-settings-*` and `project-input-action-*`. |
| G14 | **No asset validation or import pipeline.** | `filesystem-reimport` exists, but there is no GLB inspection. | A Studio-side validator (glTF validator + inspection) is needed, followed by Godot import verification. |
| G15 | **Multi-instance routing on one server is unverified.** | Instance metadata (`instance_id`, `engine`, `project_path_hash`) is sent, but how the server routes a tool call when both the editor and a game are connected is not visible in this repository. | By default, playtest sessions should use a **separate server instance on a separate port**. Shared-server routing is a Phase-0 spike. |
| G16 | **Env inheritance would misroute the game.** | Games started by `editor-application-set-state` inherit the editor's `GODOT_MCP_*` env, and env overrides `WithConfig`. | QA playtests must launch the game process **directly from the Studio** with their own env, not through the editor. |
| G17 | **No persistence, jobs, checkpoints, cost, approvals or audit anywhere.** | Absent. | All of these are new, in Studio Core. |
| G18 | **No Windows CI, no export templates, no mobile.** | All jobs run on `ubuntu-latest`. | ModuleX needs a Windows CI leg for the desktop app and exports. |
| G19 | **The feature-toggle linkage is unverified.** | Addon `features` in `user://` config versus the CLI's `.godot-mcp/features.json`. | Enforcement must happen in the Studio gateway. Addon-side toggles are defence in depth only. |
| G20 | **Doc and code drift.** | Per the subagent reports, several docs and comments disagree with the code (for example, `res://.env` not being read by the runtime path). | The implementer must trust the code over the docs and fix the docs it touches. |

---

## SECTION 3 — RECOMMENDED PRODUCT ARCHITECTURE

### 3.1 Product name

**ModuleX Game Studio.** It is the product name and the installer brand, installed as `ModuleXGameStudioSetup.exe`.

It says what the product is (a studio that produces games), keeps the ModuleX family brand, and does not suggest that it *is* Godot. The About screen, license page and docs say "Built with the Godot Engine (MIT)". The Godot logo is never used as product identity.

### 3.2 Layered architecture (responsibilities stay separated)

```
┌──────────────────────── ModuleX Agent (Hermes-based, existing) ────────────────────────┐
│ reasoning · planning · role prompts (Director, Gameplay Eng, Level Designer, Tech Artist,│
│ 3D Asset Producer, QA, Build/Release) · decides WHAT to do                              │
└──────────────▲──────────────────────────────────────────────────────────────────────────┘
               │ MCP (streamableHttp, loopback, bearer) → "modulex-studio" MCP server
               │ (fallback: Studio REST + WebSocket event stream)
┌──────────────┴────────────────── ModuleX Game Studio (desktop) ──────────────────────────┐
│ UI (Tauri 2 + React/TS)  ⇄  Studio Core (Node 22/24 service, TypeScript)                  │
│   • Policy Gateway (role→tool allowlist, Auto/Ask/Disabled, audit, injection fencing)     │
│   • Pipeline Engine (stages, validation gates, resumable state machine, SQLite)           │
│   • Godot Manager (engine pin, editor/server supervision, godot-cli lib reuse)            │
│   • QA Runner (static checks, playtest sessions, visual checks, failure classification)   │
│   • Asset Factory (workflow registry, ComfyUI job system, validation, import)             │
│   • Build Service (export presets/templates, local Windows/Android, remote macOS)         │
│   • Checkpoints (git), Cost ledger, Secrets (Windows Credential Manager via Rust shell)    │
└───────┬───────────────────────────┬───────────────────────────────┬──────────────────────┘
        │ MCP client / REST         │ HTTPS + WS (provider-agnostic) │ HTTPS job protocol
        ▼                           ▼                                ▼
gamedev-mcp-server (loopback,  ComfyUI workers (local / Vast.ai /   Build workers
 token auth, per-project port)  RunPod / AWS) behind auth proxy      (local Windows; remote macOS/Xcode)
        │ SignalR
        ▼
Godot 4.5.1 mono editor + addons/godot_mcp (unchanged core) + addons/modulex_studio (new tools)
        │ (Studio-launched playtest process, own env, own server port)
        ▼
Running game (ExportDebug / editor-run) + ModuleX QA autoload → GodotMcpRuntime + QA runtime tools
```

### 3.3 Key decisions and why

1. **Keep `addons/godot_mcp/` close to upstream.** Add ModuleX capabilities in a **new addon, `addons/modulex_studio/`**, with the same conventions: `[AiToolType]` families, Apache header, and the `Runtime/` vs `Editor/` split. Tools are auto-discovered because Godot compiles one assembly. This keeps the fork mergeable with upstream and avoids breaking `skills-addon-parity`, which scans `addons/godot_mcp/{Runtime,Editor}/Tools/` only. **Do not fork the Godot engine.** Nothing found requires an engine change.
2. **The Studio is the only MCP client of `gamedev-mcp-server`.** The ModuleX Agent never gets the Godot-MCP URL or token. It talks to the Studio's own MCP server, which enforces role scopes, approvals, audit and prompt-injection fencing before proxying the actual Godot-MCP tools, under their real ids.
3. **Local-first.** The server is bundled (win-x64 zip, checksum-verified at app build time) and launched by the Studio via `GODOT_MCP_SERVER_PATH`, bound to loopback, with a per-project port (the same derivation as `GodotProjectIdentity` / cli-core) and a per-session random token.
   - The editor is launched with `GODOT_MCP_CONNECTION_MODE=Custom`, `GODOT_MCP_HOST=http://127.0.0.1:<port>`, `GODOT_MCP_AUTH_OPTION=token` and `GODOT_MCP_TOKEN=<token>`.
   - Cloud mode exists only as an explicit, off-by-default "Remote/Cloud connection" setting.
4. **Playtests are launched by the Studio, not the editor.** The game process gets its own env: `MODULEX_QA=1`, its own server port and token. The Studio captures stdout/stderr, the exit code and crashes. The owner's interactive "Play in editor" still uses `editor-application-set-state`.
5. **Desktop stack: Tauri 2 + React/TypeScript UI, with Studio Core as a Node (TypeScript) sidecar.**
   - **Why TypeScript:** the reusable orchestration code in this repository (`godot-cli` library: editor resolution, addon install with csproj patching, checksum-verified server install, process scanning, tool calls) is TypeScript and was explicitly designed for app embedding. Rewriting it in Rust or C# would duplicate logic that parity tests keep in sync with the addon.
   - **Why Tauri over Electron:** WebView2 is part of Windows 10/11, the Rust shell uses little memory and starts fast, and the built-in NSIS bundler produces a branded setup `.exe` with shortcuts, uninstall and upgrade. The Rust shell also gives native Windows Credential Manager access for secrets.
   - **Cost:** a bundled Node runtime (~40–80 MB) as a sidecar. That is still smaller than Electron's Chromium, and it keeps one application language (TS) for the UI and Core.
   - **Why not WPF/WinUI/Avalonia:** they would reuse the C# addon models but lose the CLI library. The UI tooling for a premium, dense, themable interface (plus a GLB preview via three.js/`<model-viewer>`) is stronger on the web stack.
   - **Fallback:** if the Phase-0 spike shows the Node sidecar cannot be packaged reliably, switch to Electron and keep the same TS code.
6. **Mandatory runtimes, bundled or managed by the Setup Assistant** (never "install it yourself"). These cannot be avoided, because the addon is C#: every generated project is a Godot .NET project that needs the .NET 8 SDK to compile.
   - Godot 4.5.1 **mono** editor and matching **mono** export templates.
   - .NET 8 SDK, installed privately under `%LOCALAPPDATA%\ModuleXGameStudio\runtimes\dotnet`, with `DOTNET_ROOT`/`PATH` injected into spawned processes.
   - A local NuGet feed holding `Godot.NET.Sdk`/`GodotSharp` 4.5.1, ReflectorNet 5.4.1, McpPlugin 8.6.0 and transitive packages, so the first build works offline.
   - JDK 17 and the Android SDK, installed on demand.
7. **Engine pin: Godot 4.5.1-stable mono.**
   - It is the lowest version with the engine logger (`GODOT4_5_OR_GREATER`) that gives precise script diagnostics and multi-frame runtime backtraces.
   - It is the version used in this repository's documented runbook and a CI leg.
   - 4.6.3 and 4.7.0 are CI-covered upgrade candidates.
   - One pin per Studio release, recorded per project. A mismatch blocks with a clear message.
8. **Gameplay language defaults to GDScript** for agent-generated gameplay. It has precise `script-validate`, needs no rebuild, and avoids C# assembly reload churn (godot#78513). C# is used for the ModuleX addon tools and the QA runtime. The project stays a .NET project because the addon requires it.
9. **Shipping builds exclude MCP.** `ExportRelease` excludes `addons/godot_mcp` and `addons/modulex_studio` using the exact csproj snippet in `docs/ARCHITECTURE.md`. Smoke-test builds use `ExportDebug` with the QA runtime compiled in but env-gated.

### 3.4 Capability mapping: ModuleX commands → real mechanisms

| ModuleX command | Implemented by |
|---|---|
| `create_game_project` | Studio: `createProject` (then rewrite SDK to 4.5.1) → `installPlugin({source: bundled addon})` → copy `addons/modulex_studio` + template overlay (main scene, input map, autoload, `export_presets.cfg`, `nuget.config`) → `buildProject` → `git init` + checkpoint → `openProject` with Custom/token env. |
| `inspect_project` | `filesystem-list`, `scene-list-opened`, `scene-get-data`, `resource-find`, `editor-application-get-state`, new `project-settings-get`. |
| `create_scene` / `modify_scene` | `scene-create`, `node-create`, `node-modify`, `node-set-parent`, `node-reorder`, `node-duplicate`, `node-delete`, `scene-save`. |
| `create_script` / `validate_script` | `script-create`/`script-update`/`script-attach-to-node`, then `script-validate` (GDScript) and `buildProject` (C#). |
| `run_game` / `stop_game` (interactive) | `editor-application-set-state {isPlaying:true, scene}` / `{isPlaying:false}`. |
| `run_game` (QA) | Studio spawns `godot --path <proj> [scene]` with `MODULEX_QA=1` + playtest server env → QA autoload → `GodotMcpRuntime.Initialize(b=>b.WithTools(QA families).WithRuntimeErrorCapture()).Build().Connect()`. |
| `capture_screenshot` | Editor: `screenshot-viewport`/`-camera`/`-isolated`. Game: new runtime tool `game-screenshot`. |
| `read_runtime_errors` | `runtime-errors-get {sinceSequence}` from the game session, plus `console-get-logs` (editor), plus captured stdout/stderr. |
| `generate_asset` | Studio Asset Factory → ComfyUI `POST /prompt` (client `prompt_id`) → WS/`/api/jobs/{id}` → `/view`. |
| `import_asset` | Studio: validate GLB → copy to `res://assets/generated/<id>/` → `filesystem-reimport {files}` → `resource-find` → `node-create {instanceScenePath}` → `screenshot-isolated` → `scene-get-data` (skeleton/animation check). |
| `run_tests` | QA Runner: static tier → playtest tier (`game-*` tools) → visual tier. |
| `build_windows` / `build_android` | Build Service: `godot --headless --path <p> --export-release "<preset>" <out>` (templates `4.5.1.stable.mono`). |
| `prepare_ios_export` | Build Service: preset, bundle id, icons and capability validation on Windows. The final export, `xcodebuild` and signing go to the macOS worker. |

### 3.5 Repository layout (target)

```
addons/godot_mcp/            # upstream addon — minimal, upstreamable changes only
addons/modulex_studio/       # NEW Godot addon (C#): Editor/Tools (project-*, validate), Runtime/Tools (game-*), QA autoload
studio/
  app/                       # Tauri 2 shell (src-tauri/, Rust) + ui/ (React, TS, design system)
  core/                      # Studio Core (Node/TS): gateway, pipeline, godot, qa, assets, builds, db
  shared/                    # zod schemas, API/event types, tool policy matrix
  worker/                    # remote build worker (macOS) + ComfyUI-side auth proxy notes
  workflows/                 # ComfyUI workflow registry (manifest.json + api-format graph per workflow)
  templates/game-3d-basic/   # project template overlay
  installer/                 # NSIS customisations, branding, license bundle, third-party notices
  branding/                  # icon SVG master, generated PNG/ICO
cli/                         # unchanged; consumed as a workspace dependency (file:../../cli)
docs/modulex/                # all ModuleX docs
```

---

## SECTION 4 — UI PROPOSAL (to be approved before deep UI implementation)

### 4.1 Information architecture and navigation

A left **icon rail**, collapsible to labels, with 9 destinations. A **top bar** holds the project switcher, a **connection-health cluster** (Agent · Godot · MCP · Workers), a budget meter, the **Approvals** badge and `Ctrl+K` (command palette).

```
Rail:  ⌂ Projects  ◧ Studio  ≡ Activity  ◆ Assets  ✓ Test & Debug  ⬇ Builds  ⚙︎ Workers  ⚑ Approvals  ⋯ Settings
```

- **Projects** is the home screen. **Studio** is the per-project main workspace.
- Everything else is project-scoped, except Workers and Settings.
- The whole UI supports **Arabic RTL and English LTR**: bidi-correct chat, mirrored layouts, and fonts with Arabic coverage.

### 4.2 Wireframes

**Projects (dashboard)**
```
┌ ModuleX Game Studio ─ [Projects ▾]        ● Agent  ● Godot 4.5.1  ● MCP  ● 2 GPU   $3.20/$50  ⚑2  ⌘K ┐
│ Projects                                                  [ + New game ]  [ Import ]                  │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ▣ Island Explorer   ● Building (Stage 12/20)   Win ✓ Android ● iOS ○   Last build 14:02   ⋯      │ │
│ │ ▣ Space Runner      ◐ Partial success          Win ✓ Android ✕          2 errors            ⋯      │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ Recent activity (compact timeline)      │  System: Godot 4.5.1 mono ✓  .NET 8 ✓  Templates ✓  JDK ○    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Studio (game workspace)**: conversation, live state and the pipeline side by side.
```
┌ Island Explorer ▾ │ Brief · Design Doc · Plan                                    [⏸ Pause agent] [Build ▾]┐
│ CONVERSATION (RTL-aware)   │ PREVIEW  [Game ▾|Editor|Scene tree|Asset|Logs]      │ PIPELINE              │
│ you: غير الشخصية دي         │ ┌─────────────────────────────────────────────────┐ │ ✓ Brief               │
│ agent: I'll regenerate …   │ │   latest screenshot / GLB viewer / tree         │ │ ✓ Design doc          │
│  ┌ proposed action ─────┐  │ │                                                 │ │ ✓ Project created     │
│  │ Replace Player mesh  │  │ └─────────────────────────────────────────────────┘ │ ● Importing character │
│  │ est. $0.40 · Ask     │  │ Context: Player (CharacterBody3D) · res://…/hero.glb│ ○ Level 1             │
│  │ [Approve] [Edit] [✕] │  │ Errors 0 · Warnings 2 · FPS 60                      │ ○ Playtest            │
│  └──────────────────────┘  │                                                     │ ○ Windows build       │
│ [ Describe a change…  ⏎ ]  │                                                     │ Inspector ▸ stage log │
└────────────────────────────┴─────────────────────────────────────────────────────┴───────────────────────┘
```
When the user says "change this one", the reference resolves to the **pinned context chip**. The chip shows the currently selected node or asset (from `editor-selection-get` or the Assets selection), so pronouns are never ambiguous.

**Assets**
```
Filters: [Category ▾][Status ▾][Worker ▾]   [ + Generate ]
Grid of asset cards (thumbnail from screenshot-isolated) · status: Queued/Generating 63%/Validating/Needs rig/Imported/Failed
Detail drawer: 3D viewer (three.js) · pipeline chain Reference→Mesh→Texture→Cleanup→UV→Rig→Anim→Collision→LOD→GLB
               validation report (tris, materials, textures, bounds, skeleton) · job history · cost · [Retry stage] [Replace]
```

**Test & Debug**
```
Run: [Static] [Playtest] [Visual] [All]   Session: #41 ● running 00:38   Build: ExportDebug
Left: test list with status  | Center: failure detail (class, fingerprint, stack frames, screenshot diff) | Right: fix attempts 1/3, escalation
Bottom dock: live console (game stdout · runtime-errors · editor logs) with filters
```

**Builds**
```
[ Build game ▾ ]  → modal: ☐ Windows ☐ Android ☐ iOS  (requirements checklist per platform, blocking items in red) [Build all]
Table: Build · Platform · Version · Status · Size · Created · [Download] [Reveal] [Logs] [Smoke test result]
iOS row states explicitly: "Prepared (no macOS worker)" vs "Signed .ipa"
```

**Workers**
```
GPU WORKERS [+ Add]                               BUILD WORKERS [+ Add]
┌ Remote GPU #1 · RTX 5090 · Vast.ai · ComfyUI 0.37 · 3D ✓ Video ✓ · ● Online · p1 · $0.60/h ┐
│ capabilities (from /object_info): Hunyuan3Dv2 ✓ SaveGLB ✓ …   VRAM 32 GB   queue 0  [Test] ⋯ │
Build worker: macOS · Xcode 26 · Godot 4.5.1 mono · signing identity ✓ · ● Online
```

**Approvals.** A queue of pending actions: who (role), what (tool + args summary), why, risk tier, cost, diff preview, and **Approve / Reject / Always allow for this project**.

**Activity.** An append-only timeline of every stage, tool call, job and build, with a filter, and a drill-down to the exact request/response. Secrets are redacted.

**Settings.** General, Appearance (Dark/Light/System, density), Language (العربية/English), Agent connection, Godot installations, Autonomy policy matrix, Budgets, Secrets, Updates, Developer mode (exposes server logs, DevControl, raw MCP console).

**States.** Every view defines:
- **Empty:** a one-line purpose and a primary action.
- **Loading:** a skeleton matching the final layout, never a spinner-only screen.
- **Error:** what failed, the evidence, the next action, and "copy diagnostics".
- **Blocked:** what is missing, and a button to fix it.

### 4.3 Design system

- **Tokens.** Neutral "ink" scale (`#0B0D12` → `#F5F7FA`). One brand accent, **ModuleX Cobalt `#4C6FFF`**. Semantic colours: success `#2FB67C`, warning `#E5A13A`, danger `#E5484D`, info `#3E9BE0`, running `#8B7CF6`. Borders are 1 px at 8–12 % contrast. Shadows only on overlays.
- **Typography.** Inter (UI) with IBM Plex Sans Arabic / Noto Sans Arabic for Arabic, and JetBrains Mono for code and logs.
  - Scale: 12 / 13 (base, dense) / 14 / 16 / 20 / 24.
  - Tabular numerals for metrics.
- **Layout.** 4 px grid, radius 6, 40 px rows (dense 32). Three-pane resizable workspace. Minimum window 1280×760.
- **Motion.** 120–180 ms ease-out, only for state change and progress. Honours reduced-motion.
- **Components** (build once, reuse): StatusDot/StatusPill, PipelineTimeline, StageCard, ApprovalCard, ActionProposal, LogConsole (virtualised), DataTable, AssetCard, ModelViewer, ScreenshotViewer (with diff), CostBadge, HealthCluster, CommandPalette, Drawer, Modal, Toast, EmptyState, Skeleton, KeyValue, CodeBlock, DiffView, BidiText.
- **Libraries:** React + TypeScript, Radix primitives (MIT) for accessibility, TanStack Table/Virtual, three.js (MIT) for GLB, CSS variables for theming. No heavy UI kit look.

### 4.4 Visual identity and icon concepts

| Concept | Description | Verdict |
|---|---|---|
| **A. "Module Keystone"** | An isometric cube built from three interlocking modules. The negative space between the top and front faces forms an **X**. One module is slightly offset, suggesting assembly in progress. | **Selected.** It carries modularity, 3D and building, it is distinctive, and it reduces cleanly to 16 px (a two-tone cube with an X notch). |
| B. "Forge X" | Two chevrons forming an X around a spark. | Reads as generic "AI spark". |
| C. "Stage Frame" | A viewport frame with a play cursor. | Too close to media players. |
| D. "Node Graph X" | Four connected nodes in an X. | Too similar to many dev tools; weak at 16 px. |

- **Palette:** ink cube `#12151C` / `#1C2130`, cobalt X-edge `#4C6FFF`, highlight `#8FA5FF`.
- **Masters:** an SVG master, plus a **hand-simplified 16/24 px variant** (thicker X, no offset module).
- **Required outputs:** PNG at 16, 20, 24, 32, 40, 48, 64, 128, 256 and 512, and a multi-resolution `.ico` (16, 20, 24, 32, 40, 48, 64, 256). The same mark is used for the installer, taskbar, Start Menu, tray and the in-app wordmark ("ModuleX" in semibold, "Game Studio" in regular).

---

## SECTION 6 — RISKS (real, technical)

1. **C# mobile export maturity.** Godot 4.x .NET support for Android and especially iOS is newer and has historically been flagged experimental. iOS .NET export needs macOS. Mitigation: a Phase-0 spike exporting the template on 4.5.1 to Android; iOS is designed as macOS-worker-only.
2. **Heavy mandatory runtimes.** The .NET 8 SDK (~200 MB), Godot mono and mono export templates (hundreds of MB), and the Android SDK/JDK (GBs). First-run time and disk use are significant, and offline first build needs the local NuGet feed.
3. **Godot finding the private .NET SDK.** The Godot mono editor must locate a privately installed SDK through `DOTNET_ROOT`/`PATH`. This is unverified and needs a spike.
4. **Multi-instance routing on one `gamedev-mcp-server`** (editor plus game) is unverified. The separate-server design avoids it, at the cost of one extra process per playtest.
5. **Screenshots need a real renderer.** Visual QA cannot run with `--headless`. Studio playtests on Windows open a real window (it can be off-screen or minimised with care). CI needs xvfb or GPU runners.
6. **C# hot-reload fragility** (godot#78513, #51626). Writing C# while the editor is open triggers assembly reloads. The addon has mitigations, but frequent reloads remain a stability risk, which is why gameplay defaults to GDScript.
7. **Exporting while the editor holds the project.** A concurrent `.godot/` import cache can race. The Build Service must save scenes, then run the export in a separate process, or on a snapshot copy for release builds.
8. **Quality of generated 3D.** ComfyUI core has Hunyuan3D v2 mesh generation and `SaveGLB`, but no guaranteed texturing, retopology or rigging for arbitrary creatures. Rigging and animation depend on custom nodes or external tools that may not exist on a given worker. The pipeline must report **BLOCKED / needs manual step** rather than pretend.
9. **ComfyUI has no authentication and runs arbitrary custom-node code.** Remote workers are a trust boundary. Downloaded outputs are untrusted files, so parsers and validators must be hardened and size-capped.
10. **Arbitrary code paths:** `reflection-method-call`, `godot-skill-create`, and generated GDScript/C# that runs in the editor (`[Tool]` scripts) or the game. Mitigation: the gateway disables the first two, flags `@tool` / `[Tool]` in generated code as Ask, and playtests run the game as a separate process.
11. **LLM cost and loop runaway** in the fix loop. This needs hard budgets, per-fingerprint retry caps and escalation.
12. **Vision-based visual QA** can hallucinate. Deterministic checks (non-empty frame, node visibility, rect overlap) must gate, and vision is advisory.
13. **Upstream drift.** The fork must keep `addons/godot_mcp` mergeable. NuGet and server pins are owned upstream, and a server bump requires matching release assets.
14. **Git with large binaries.** Checkpoints of GLB and texture files grow the repository. Git LFS or size policies may be needed.

## SECTION 7 — MISSING DEPENDENCIES (actual external requirements)

| Dependency | Needed for | Source / license note |
|---|---|---|
| Godot **4.5.1-stable mono** editor (win64) | Everything | Official godotengine releases, MIT (bundle or download with SHA-512). |
| Godot **4.5.1 mono export templates** (`.tpz`) | Windows, Android, iOS export | Official, MIT. |
| **.NET 8 SDK** | Compiling every generated C# project and the addon | Microsoft, MIT. Private install via `dotnet-install.ps1`. |
| NuGet packages: `Godot.NET.Sdk` / `GodotSharp` 4.5.1, `com.IvanMurzak.ReflectorNet` 5.4.1, `com.IvanMurzak.McpPlugin` 8.6.0 + transitive | Offline first build | nuget.org; bundle into a local feed. |
| `gamedev-mcp-server` **9.2.9** `win-x64` (and `osx-arm64` for the Mac worker) | Local MCP | GameDev-MCP-Server releases, Apache-2.0, `SHA256SUMS`. |
| Node.js runtime (22.14+ LTS or 24 LTS) | Studio Core sidecar | MIT; bundled, not user-installed. |
| Rust toolchain + Tauri 2 CLI + WebView2 runtime | Building and running the desktop app | Developer only (Rust/Tauri); WebView2 via the bootstrapper in the installer. |
| **ComfyUI worker(s)** with 3D-capable custom nodes and models (for example Hunyuan3D-2 weights) | Asset generation | User-provided GPU (Vast.ai, RunPod, AWS or local). GPL-3.0; used only over HTTP, never bundled. |
| An authenticating reverse proxy or tunnel in front of each remote ComfyUI (Caddy/nginx bearer, SSH, Tailscale) | Remote worker security | User infrastructure. |
| JDK 17 + Android SDK (platform-tools, build-tools, platform, cmdline-tools) + debug keystore | Android APK/AAB | On-demand download; the release keystore is supplied by the owner. |
| `adb` device or emulator (optional) | Android install test | Owner hardware. Never claimed if absent. |
| macOS machine with Xcode, Godot 4.5.1 mono and templates, an Apple Developer account, certificates and provisioning profiles | Signed iOS build | Owner provided. |
| Git for Windows (MinGit, GPLv2, shipped unmodified as a separate program with its license) **or** an installed git | Checkpoints | Bundled or detected. |
| glTF tooling: `gltf-validator` (Apache-2.0), `@gltf-transform/core` + `functions` (MIT), meshoptimizer (MIT) | Asset validation and optimisation | npm. |
| Optional **Blender** (GPL, external process, user-installed or downloaded separately) | Mesh cleanup, UV and retopology post-processing where ComfyUI lacks it | Invoked as a separate program. |
| The **ModuleX Agent** (Hermes-based) with MCP-client support, or an adapter | Orchestration | The owner's existing project. |
| Code-signing certificate (Authenticode) — optional but recommended | Avoiding SmartScreen warnings on `ModuleXGameStudioSetup.exe` | Owner purchase. |
