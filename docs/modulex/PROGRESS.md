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
| 3 · UI Direction Review | **Approved by the owner (2026-09-29, D-022)** | GATE 3 = written owner approval: **passed** |
| Execution Patch 1 · hardening | **Done up to the phase boundaries** (see below) | green (below) |
| Execution Patch 2 · System Evolution | **Done up to the phase boundaries** (see below) | green (below) |
| 4–15 | Not started as phases. Patch 1 moved the Phase 5 gateway, Phase 12 predicate and parts of Phase 13 forward as contracts and tests. Production UI still waits for GATE 3. | — |

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

## Execution Patch 1: hardening

This patch amends the plan (`EXECUTION_PROMPT.md` § Execution Patch 1). The decisions are D-023…D-033.
The detail is in [`security.md`](security.md), [`claude-integration.md`](claude-integration.md),
[`asset-provenance.md`](asset-provenance.md) and [`build-profiles.md`](build-profiles.md).

### Built

**Shared contracts** (`studio/shared/src/`):

- structured errors and the five outcome statuses;
- the two-layer policy (`decide`, `advertisedTools`);
- asset provenance and the commercial-use verdict;
- worker trust and onboarding;
- the game spec, the six manifests, the task graph and the 19-stage pipeline;
- build profiles, the platform matrix and the iOS/Android honesty rules;
- the completion predicate;
- the Claude model catalogue, routing and settings validation;
- the setup components (bootstrapper);
- untrusted-content fencing;
- the audit event catalogue.

**Studio Core** (`studio/core/src/`):

- the Policy Gateway, with approval impact, single-use argument-bound approvals, owner-only resolution,
  Developer Mode and Claude audit events;
- the redactor and the SHA-256 hash-chained audit log;
- the store with deterministic manifest derivation;
- the Studio MCP server, stateless streamable HTTP on `/mcp`, with three principals;
- the owner endpoints;
- the Claude Desktop health test;
- the Anthropic API provider (Mode A);
- the deep-link handoff builder.

**Claude Desktop extension** (`studio/claude-desktop/`):

- the stdio→HTTP bridge;
- the generated manifest v0.3 (16 safe tools, a `sensitive` pairing token);
- `mcpb validate` + `mcpb pack` producing `modulex-game-studio.mcpb`, which CI uploads.

**Shell:** the Windows Credential Manager bridge (`keyring`) for the stable agent and pairing tokens.

**UI:**

- monochrome tokens;
- the six-signal health cluster and the Developer Mode pill;
- Settings → AI Providers, Model routing and Developer Mode;
- the 19-stage pipeline and the Claude handoff menu;
- provenance, worker trust with onboarding, approval impact, and the build profile column and matrix;
- 65 recaptured screenshots.

**Icon:** pure-grey Module Keystone; `render-icons.py` for PNG 16…1024, hinting at 16/20 px, and the ICO,
verified in CI.

**CI:** the icon verification, the `.mcpb` artifact, and the installer shipped as
`ModuleXGameStudioSetup.exe`.

### Acceptance scenarios (Patch 1)

| # | Scenario | Evidence | State |
|---|---|---|---|
| 1 | The ModuleX Agent builds a game end to end with Agent-safe tools only | Policy tests show that the default agent sees only `studio_*` tools and that raw calls are refused | **Boundary only.** It needs the ModuleX Agent (D-030) and Phases 6–10. |
| 2 | Claude Desktop: "make a 3D game about a kid's space journey, 5 levels, scores, a shop" | `core/tests/security.test.ts` "game spec + manifests over MCP": spec → 6 manifests → 21-task graph; manifests readable; the stage after planning reports BLOCKED `PIPELINE_ENGINE_UNAVAILABLE` | **Planning PASS. Execution BLOCKED** (Phase 6+). |
| 3 | Claude Desktop: "delete all generated assets" | The acceptance test: PENDING_APPROVAL with What/Why/Scope/Files/Risk/Rollback; Claude cannot approve; after the owner approves, the files move to `.modulex/trash/<approval_id>/` (restorable); the approval cannot be reused | **PASS** |
| 4 | An iOS release on Windows | `evaluateCompletion` / `iosStatus`: BLOCKED "macOS/Xcode build worker required", or PARTIAL_SUCCESS with other platforms | **Contract PASS.** Real exports come in Phase 10/11. |
| 5 | A prompt injection inside content | The acceptance test: the content is stored as data, `untrusted_content_flagged` is audited, and no policy changes | **PASS** |

### Deviations

- Mode C is not offered (D-025).
- "MarketX" is read as the Studio UI (D-031).
- The owner-facing effort list is Low/Medium/High/Max; `xhigh` is not shown (D-033).
- The Setup Assistant downloader, `ModuleXGameStudioFullSetup.exe`, the production Settings screens and
  the RELEASE autoload strip are not built yet. Their phases are noted in the plan section.

---

## Execution Patch 2: System Evolution

This patch amends the plan (`EXECUTION_PROMPT.md` § Execution Patch 2). The decisions are D-034…D-041. The
detail is in [`system-evolution.md`](system-evolution.md).

### Built

- **Shared contracts:**
  - the three modes and six change kinds;
  - an Arabic and English request classifier (Core keeps the stricter mode);
  - risk levels with component risk floors;
  - protected controls;
  - the 19-stage workflow;
  - the change proposal and owner review;
  - the patch guard;
  - declarative extension manifests with a permission catalogue;
  - workflow, provider and UI-panel schemas;
  - versioned configuration documents, where the policy can never auto-approve raw, critical or evolution
    tools;
  - version and project compatibility;
  - update channels (Stable default, never automatic);
  - migrations;
  - Safe Mode.
- **Core** (`studio/core/src/evolution/`):
  - `ConfigStore`: versioned, applied live;
  - `ExtensionRegistry`: sandbox staging, hash verification, versions kept for rollback, workflow pinning,
    Safe Mode;
  - `EvolutionService`: all three modes; git-worktree sandbox; risk-based gates; diff-bound owner approval;
    typed confirmation for CRITICAL; checkpoint tag plus data backup; fast-forward deploy; health check with
    automatic revert; verify; rollback; history; changelog from real commits only;
  - `UpdateManager`: verify → backup → install → migrate → health → healthy, else rollback; Roll Back
    Update;
  - `migrateJsonFile`: backup → copy → validate → atomic replace → integrity check;
  - `Diagnostics`: checks plus non-security repairs.
- **MCP tools.** 24 policy-gated tools are now live (42 of 63 studio tools in total). Claude Desktop gets
  only `studio_system_status`.
- **Owner-only System endpoints.** The gateway reads the live policy.
- **Hardening.** "Always allow" and policy auto-approval now apply only to the ModuleX Agent, never to
  Claude Desktop or protected tools (D-038).
- **Shell.** It passes `MODULEX_DATA_DIR` and retries a failed Core start in Safe Mode (`cargo check` passes
  for Linux and Windows).
- **UI prototype.** A new **System** destination with Overview, Versions, Extensions, Skills, Workflows,
  Providers, Updates, Evolution History, Diagnostics and Developer Mode. It includes the owner review, the
  CRITICAL policy diff with a typed confirmation, Roll Back Update, and Safe Mode as the blocked state.
  81 screenshots.
- **CI fix.** The Windows studio job had failed because `node_modules/.bin/mcpb` is a `.cmd` shim; the test
  now runs the mcpb CLI through Node.

### Evolution scenarios (§27–29)

| # | Scenario | Evidence (`studio/core/tests/evolution.test.ts`) | State |
|---|---|---|---|
| 1 | "ضيف دعم لـ Workflow جديدة للـ3D characters." | sandbox → schema → test job on a TRUSTED worker → GLB, non-empty and provenance checks → owner approval → registry backup → install → re-hash → SUCCESS; version 1.1.0 activates while a project stays pinned to 1.0.0; no trusted worker gives BLOCKED; a bad output gives TESTS_FAILED | **PASS** (fake worker; a live run needs Phase 7) |
| 2 | "غير سياسة الـapproval بحيث العمليات دي تبقى Auto." | exact diff `add /auto_approve/0 …`, risk CRITICAL, agent cannot approve or deploy, typed confirmation, a new versioned write, verify, `config_changed` audit, rollback as a new version; over MCP the live gateway then auto-approves for the ModuleX Agent while Claude Desktop is still asked | **PASS** |
| 3 | "ثبت إضافة جديدة." | manifest, permissions, licence, dependencies and hashes → sandbox → validation → risk → owner approval (HIGH permission not granted unless ticked) → install → verify → update 1.1.0 → rollback to 1.0.0; tampered, forbidden-permission, non-commercial, missing-dependency and executable packages are BLOCKED before staging | **PASS** |
| — | Core patch | real git repo: worktree sandbox, gates, review counts, hash-bound approval, checkpoint tag at the base, ff deploy, SUCCESS; failed health gives an automatic revert and ROLLED_BACK; failing tests stop before review; a patch removing an audit call is BLOCKED; protected changes are CRITICAL, owner-only, and run all 7 gates; a change after approval voids it | **PASS** |

### Deviations

- Extensions are declarative. Executable additions are core changes (D-036).
- `studio_evolution_approve` submits for review and does not approve (D-037).
- Core evolutions need `MODULEX_SOURCE_REPO`; without it they are BLOCKED (D-040).

---

## Gate output (fresh run, 2026-09-29, after Execution Patch 2)

```
$ python scripts/check-runtime-boundary.py --verbose
OK: runtime/editor boundary holds (112 runtime file(s) scanned in 3 dir(s), 0 violations).
$ dotnet restore Godot-MCP.sln && dotnet build Godot-MCP.sln -c Debug --no-restore
    0 Warning(s)
    0 Error(s)
$ dotnet test Godot-MCP.Tests/Godot-MCP.Tests.csproj -c Debug --no-build
Passed!  - Failed:     0, Passed:  1450, Skipped:     0, Total:  1450 - Godot-MCP.Tests.dll (net8.0)
$ cd cli && npm ci && npm run build && npm test
 Test Files  51 passed (51)
      Tests  576 passed (576)
$ cd studio && npm ci && npm run lint && npm run format:check && npm run build && npm run typecheck && npm test
lint: 0 problems
All matched files use Prettier code style!
build: ok (mcpb validate + pack: 17 Claude Desktop tools)
typecheck: 0 errors
 Tests  217 passed (217)   # @modulex/shared (policy, contracts, evolution, compat parity)
 Tests   81 passed (81)    # @modulex/core (security, server, provider, handoff, evolution scenarios)
 Tests    6 passed (6)     # @modulex/worker
 Tests    7 passed (7)     # @modulex/claude-desktop
 Tests   65 passed (65)    # @modulex/ui (prototype incl. System section)
$ python3 studio/branding/render-icons.py --verify
OK: every PNG size and every ICO entry present
$ cd studio/app/src-tauri && cargo check && cargo check --target x86_64-pc-windows-msvc
Finished (both targets)
```

The earlier gate outputs are in this file's git history.

## Open risks carried forward

1. **Android is untested end to end.** The SDK download is blocked here; Phase 10's Windows CI must prove
   the C# Android export on 4.5.1.
2. **The private .NET install on Windows** (`dotnet-install.ps1` + `DOTNET_ROOT`) is only proven on Linux so
   far. It is part of GATE 4.
3. **GLB import requires a full scan.** Consider upstreaming a `ReimportClassifier` fix (D-007).
4. **The 16 px icon** is now pixel-hinted (Patch 1). It still needs the owner's review.
5. **NSIS install path.** It should become `%LOCALAPPDATA%\Programs\ModuleX Game Studio` (Phase 13).
6. **Generated projects need attention in the Phase 10 template:** they need a `.sln`, the `ExportRelease`
   MCP exclusion, **the `ModulexQa` autoload strip for PREVIEW/RELEASE (D-032)**, and `.claude/skills`
   handling.
7. **The ModuleX Agent codebase is not accessible** (D-030). Scenario #1 cannot run until it connects to
   `/mcp`.
8. **The Windows Credential Manager bridge** passes `cargo check` for the Windows target. It is exercised
   for real only by the Windows CI install and self-test, and later by manual pairing.
9. **Live System Evolution pieces.** These still need live verification:
   - the workflow test job (needs a TRUSTED ComfyUI worker and the Phase 7 client);
   - the Godot and MCP diagnostics probes (Phase 4 Godot manager);
   - the update platform steps (Tauri updater signing key and feed, Phase 13);
   - core evolutions on a developer install (`MODULEX_SOURCE_REPO`).
