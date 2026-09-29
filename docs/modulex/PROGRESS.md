# ModuleX Game Studio: Progress

This file follows the execution prompt's working protocol. For every phase it records what was built, the
**real** gate output, deviations and open risks. The evidence behind each decision is in
[`DECISIONS.md`](DECISIONS.md).

All work is on branch `claude/practical-hawking-whz0fm`.

| Phase | Status | Gate |
|---|---|---|
| 0 · Spikes | **Done.** Two live checks are BLOCKED by the environment: Android SDK download and Windows private .NET. | DECISIONS D-001…D-013: each spike VERIFIED, FAILED (with an alternative) or BLOCKED (with the reason) |
| 1 · Workspace, compat.json, CI | **Done** | green (below, and CI on the pushed branch) |
| 2 · `addons/modulex_studio` | **Done** | green; live harness 36/36 locally and on `ubuntu-latest` |
| 3 · UI Direction Review | **Delivered; STOPPED for owner approval** | GATE 3 = written owner approval: **pending** |
| 4–15 | Not started. They wait for the Phase 3 decision (the owner checkpoint). | — |

Phases 0–2 were built in the order 0 → 2 → 1, because Spike 3b needs the QA autoload (D-018).

---

## Phase 0: spikes

Every spike result, with its evidence, is in [`DECISIONS.md`](DECISIONS.md). Summary:

| Spike | Result |
|---|---|
| 1 · Engine + SDK + scaffold | VERIFIED: `[Godot-MCP] plugin loaded` on 4.5.1 mono; `godot --version` = `4.5.1.stable.mono.official.f62fdbde1`. Deviations: the SDK must be rewritten, there is no `.sln`, and `.claude/skills` is generated (D-002). |
| 2 · Private .NET | VERIFIED on Linux (`DOTNET_ROOT` + `PATH` only). The Windows proof is scheduled in the Phase 4 Windows CI (D-003). |
| 3 · Token server + MCP | VERIFIED: exact args `… auth=token token=…`; 401 without or with a wrong bearer; bound to 127.0.0.1 only; 39 tools via `@modelcontextprotocol/sdk`; images carried over both MCP and REST (D-004…D-006). |
| 3b · Multi-instance | FAILED: last connection wins on a shared server. The separate playtest server is **mandatory** (D-008). |
| 4 · GLB import | VERIFIED, but only with a **full scan**: a targeted reimport does not import a new file (D-007). |
| 5 · Exports | Windows cross-export VERIFIED; **exit code 0 even when C# is missing** (D-011). Android BLOCKED here (`dl.google.com` 403 at the proxy). iOS requires macOS (Godot's own message). |
| 6 · Rendering | VERIFIED: headless gives structured errors; Xvfb + opengl3 gives real pixels for editor and game screenshots (D-012). |
| 7 · Desktop packaging | VERIFIED on Linux **and** in Windows CI: NSIS install, installed self-test (handshake 119 ms, shell 9.5 MB, sidecar 42.9 MB), uninstall (D-013). |

Findings the plan did not anticipate, with the design changes they caused:

- **D-009.** Tool calls into one plugin run one at a time. `game-wait` gained `pressAction`.
- **D-010.** Addon-side tool disabling hides a tool but does not block it. The gateway is the only
  enforcement point.

## Phase 1: workspace, compat manifest, CI

**Built.**

- The `studio/` npm workspace (`shared`, `core`, `worker`, `app/ui`) with strict TypeScript, ESLint,
  Prettier and Vitest.
- `studio/compat.json`, with a zod schema, a `godot --version` parser and a pin check.
- The **parity test**, which checks the manifest against `ServerVersion`, the csproj NuGet pins (addon,
  xUnit, testbed), both `plugin.cfg` versions, the testbed SDK and the QA workflow pins.
- The Studio Core process entry: loopback, a random port, a session token, a stdout handshake, and shutdown
  when stdin closes. It is bundled with `godot-cli`.
- The Tauri 2 shell with the sidecar lifecycle and `--selftest`.
- The icon pipeline.
- `.github/workflows/modulex_studio.yml`: a Linux gate plus a Windows installer job.

**Deviation.** vitest is pinned to `~4.0.18` in the workspace because of an npm 10.9.7 crash (D-019). The
workspace runs as `cd studio && npm test`.

## Phase 2: `addons/modulex_studio`

**Built.**

- `Tool_Project` with 5 editor tools.
- `Tool_Game` with 8 runtime tools.
- `ModulexQaAutoload`, with an explicit tool set and no reflection or console tools.
- `ModulexStudioPlugin`, which registers the autoload and hides tools editor-side.
- 88 new xUnit tests.
- The boundary guard, extended to the new addon.
- The `Godot-Tests-Modulex` testbed.
- `scripts/modulex_qa_harness.py`, with 36 live checks.
- `.github/workflows/test_modulex_qa.yml`.

**The only upstream touch** is `GodotMcpPlugin.ActiveConnection` (D-015). `skills-addon-parity` is
unaffected (576/576 CLI tests), because it scans `addons/godot_mcp` only.

**Live harness on GitHub `ubuntu-latest`** (run 36557040143, commit `992a031`): `36/36 checks passed -> OK`.

- **Editor leg:** 401 without or with a wrong bearer; `project-*` listed; `reflection-method-call` and
  `game-*` hidden; allowlists enforced; the input action is persisted and then removed; a path outside
  `res://` is refused; resources validate; `game-*` is refused inside the editor.
- **Playtest leg:** `[ModuleX-QA] connected`; the tool list is exactly `game-*` + `runtime-errors-*`; 401
  without a bearer; state, frame advance, input moves the player, unknown actions are rejected; the
  `pressAction` + `untilSignal` wait; the in-game `push_error` is captured with its GDScript frame
  `res://Qa/player.gd`; node find; the UI overlap is detected; a scene path escape is refused; a 1280×720
  screenshot with real pixels; `game-quit` gives exit 0.

## Phase 3: UI Direction Review (STOPPED here)

**Delivered:** [`ui/UI_DIRECTION.md`](ui/UI_DIRECTION.md). It contains:

- the clickable prototype (`#/prototype`, real tokens, 9 screens × 5 states, dark/light, Arabic RTL,
  Ctrl+K);
- 58 screenshots, which `capture-prototype.mjs` reproduces;
- the design system;
- icon concepts A–D, with A recommended and its 16 px trade-off versus B stated.

The prototype also has 50 unit tests, covering every screen × state render, route round-trips, the RTL
switch and bilingual navigation labels.

**GATE 3 needs written owner approval. It is pending.** Execution is stopped per the plan: no production
screens, and no Phase 4+ work, until the owner decides.

---

## Gate output (fresh run, 2026-09-29, Linux container)

```
$ python scripts/check-runtime-boundary.py --verbose
warning   addons/godot_mcp/Runtime/Connection/GodotMcpConnection.cs:421: #if TOOLS guard in Runtime/ (body stripped from game build)
OK: runtime/editor boundary holds (112 runtime file(s) scanned in 3 dir(s), 0 violations).
$ dotnet restore Godot-MCP.sln && dotnet build Godot-MCP.sln -c Debug --no-restore
  All projects are up-to-date for restore.
    0 Warning(s)
    0 Error(s)
$ dotnet test Godot-MCP.Tests/Godot-MCP.Tests.csproj -c Debug --no-build
Passed!  - Failed:     0, Passed:  1450, Skipped:     0, Total:  1450, Duration: 7 s - Godot-MCP.Tests.dll (net8.0)
$ cd cli && npm ci && npm run build && npm test
 Test Files  51 passed (51)
      Tests  576 passed (576)
$ cd studio && npm ci && npm run lint && npm run format:check && npm run build && npm run typecheck && npm test
lint: 0 problems
All matched files use Prettier code style!
build: ok
typecheck: 0 errors
 Test Files  2 passed (2)      Tests  22 passed (22)     # @modulex/shared (incl. compat parity)
 Test Files  3 passed (3)      Tests  17 passed (17)     # @modulex/core
 Test Files  1 passed (1)      Tests  6 passed (6)       # @modulex/worker
 Test Files  2 passed (2)      Tests  50 passed (50)     # @modulex/ui (incl. prototype)
$ python3 studio/branding/build-ico.py --verify studio/app/src-tauri/icons/icon.ico
studio/app/src-tauri/icons/icon.ico: [16, 20, 24, 32, 40, 48, 64, 256]
OK: all required sizes present
```

Baseline before any change: xUnit 1362/1362 and CLI 576/576. The CLI suite also passes only when no stray
Godot binary sits under a scanned install root such as `/opt` (see D-001 for the environment note).

## Open risks carried forward

1. **Android is untested end to end.** The SDK download is blocked here; Phase 10's Windows CI must prove
   the C# Android export on 4.5.1.
2. **The private .NET install on Windows** (`dotnet-install.ps1` + `DOTNET_ROOT`) is only proven on Linux so
   far. It is part of GATE 4.
3. **GLB import requires a full scan.** Consider upstreaming a `ReimportClassifier` fix (D-007).
4. **The 16 px icon needs hand hinting** after the concept is approved.
5. **NSIS install path.** It should become `%LOCALAPPDATA%\Programs\ModuleX Game Studio` (Phase 13).
6. **Generated projects need attention in the Phase 10 template:** they need a `.sln`, the `ExportRelease`
   MCP exclusion, and `.claude/skills` handling.
