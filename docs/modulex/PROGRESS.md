# ModuleX Game Studio: Progress

This file follows the execution prompt's working protocol. For every phase it records what was built, the
**real** gate output, deviations and open risks. The evidence behind each decision is in
[`DECISIONS.md`](DECISIONS.md).

All work up to Phase 8 is on branch `claude/practical-hawking-whz0fm`. Work from Phase 9 continues on
`claude/nifty-allen-ipdy0k`, which was cut from it.

| Phase | Status | Gate |
|---|---|---|
| 0 · Spikes | **Done.** Two live checks are BLOCKED by the environment: Android SDK download and Windows private .NET. | DECISIONS D-001…D-013: each spike VERIFIED, FAILED (with an alternative) or BLOCKED (with the reason) |
| 1 · Workspace, compat.json, CI | **Done** | green (below, and CI on the pushed branch) |
| 2 · `addons/modulex_studio` | **Done** | green; live harness 36/36 locally and on `ubuntu-latest` |
| 3 · UI Direction Review | **Approved by the owner (2026-09-29, D-022)** | GATE 3 = written owner approval: **passed** |
| Execution Patch 1 · hardening | **Done up to the phase boundaries** (see below) | green (below) |
| Execution Patch 2 · System Evolution | **Done up to the phase boundaries** (see below) | green (below) |
| 4 · Core foundation | **Done** | GATE 4 live suite 6/6 against a real Godot 4.5.1 editor (locally and in CI) |
| 5–6 · Gateway + pipeline engine | **Done.** Playtest, visual and optimization stages report PARTIAL_SUCCESS until Phase 9. | GATE 6 live: spec → exported builds (locally and in CI job `studio-pipeline`) |
| 10 · Template + Build Service | **Done.** Windows, iOS-prep and Android-BLOCKED paths; GATE 10 green on `windows-latest` (windowed, 10/10 QA scenarios, RELEASE alive 10 s). | GATE 6 run; GATE 10 (`windows-smoke`, see below) |
| 7 · ComfyUI workers + jobs | **Done against the mock.** The live worker test is BLOCKED: no GPU worker (D-045). | GATE 7 mock suite 18/18; the live test reports BLOCKED |
| 8 · Asset factory + Godot import | **Done** (D-046) | GATE 8: 14 fixture tests; live import into a real editor (a thumbnail under Xvfb) |
| 9 · QA runner + fix loop | **Done** (D-047, D-049, D-050) | GATE 9 live: clean game 10/10 scenarios; 2 injected bugs detected, fixed, regression green; an unfixable bug ends BLOCKED |
| 11 · Remote build workers | **Done against a mock runner** (D-051). Pairing from the UI is BLOCKED until the credential store bridge exists (D-052). Live Mac: BLOCKED (no Mac). | GATE 11 mock suite 10/10 (stable 5×); the live macOS test reports BLOCKED |
| 12 · Resumability, completion predicate, cost | **Done** (D-053) | GATE 12: kill at scene 17/30 → resumes at 17; kill mid-generation → 1 ComfyUI job; kill mid-build → 1 worker job; predicate tested over all 131,072 missing-evidence combinations |
| 13 · Desktop app, Setup Assistant, installer, updates | **Mostly done.** Production UI (D-060), Setup Assistant (D-055), credential store bridge (D-056), code signing when the certificate exists (D-057), updater verification (D-058). Open: the updater restart handoff and the signing key (owner), shortcut/WebDriver install test, upgrade test. | Windows CI: both installers installed silently and self-tested; full installer `pipeline.available=true`, `qaTier=true`; `vault_ok=true` (a real Credential Manager round-trip) |
| 14 · Self-test, docs, licences | **Done.** Licences (D-059); the self-test runs in CI on both installers; the owner's guide is [`USER_GUIDE.md`](USER_GUIDE.md). | `licenses.test.ts`: the inventory matches the real bundle; no disallowed licence ships |
| 15 · Acceptance with evidence | **In progress.** A live end-to-end run of the bundled Core: Claude Desktop creates a game; the pipeline creates, builds, playtests (10/10) and regression-tests it; the build is honestly BLOCKED (no templates on this host). Screenshots of the production UI on that run (D-061). | `docs/modulex/ui/production/*.png`; Windows builds and the smoke test in CI (GATE 6 and GATE 10) |

**CI on `42527ca`: all three workflows green.**

| Workflow | Run | Jobs |
|---|---|---|
| CI | [36892847106](https://github.com/modulix0025-dev/Godot-MCP/actions/runs/36892847106) | build + xUnit + CLI |
| Test ModuleX QA (live) | [36892846762](https://github.com/modulix0025-dev/Godot-MCP/actions/runs/36892846762) | GATE 4, 8, 9 (Linux, Xvfb); GATE 6; `windows-smoke`: Setup Assistant live + GATE 10 |
| ModuleX Studio | [36892846995](https://github.com/modulix0025-dev/Godot-MCP/actions/runs/36892846995) | Linux lint/format/build/typecheck/tests; Windows tests, small + full installer silently installed, self-tested (`vault_ok`, full: `pipeline.available=True qaTier=True`), uninstalled (exit 0); both installers `NotSigned` (no certificate secret configured) |

The Windows licence test needed three attempts. The cause was the job's `CARGO_TERM_COLOR=always`: it wraps
`cargo tree`'s "(*)" marker in ANSI codes. The minisign fixtures are now pinned `-text`, because a CRLF checkout
changed the signed bytes.

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
| 2 | Claude Desktop: "make a 3D game about a kid's space journey, 5 levels, scores, a shop" | `core/tests/security.test.ts` "game spec + manifests over MCP": spec → 6 manifests → 21-task graph; manifests readable; the stage after planning reports BLOCKED `PIPELINE_ENGINE_UNAVAILABLE` | **Planning PASS. Execution PASS since Phase 6** (GATE 6, `core/tests/live-pipeline.test.ts`). Without Godot configured, it still reports `PIPELINE_ENGINE_UNAVAILABLE`. |
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

## Phase 4: Core foundation

The work is in commit `541cf07`:

- `studio.db` (node:sqlite), with a recorded migration and a backup.
- The Godot pin check.
- Supervisors for the MCP server and the editor.
- GodotCall.
- Git checkpoints for game projects.
- A resumable, checksum-verified downloader.

GATE 4 (`core/tests/live-godot.test.ts`) passes 6/6 on a real Godot 4.5.1 editor, both locally and in CI.

## Phases 5–6 and 10: from a Game Specification to builds

- **Game generator** (`core/src/project/game-generator.ts`). This is a deterministic GAME_SPEC → Godot 4.5.1 .NET project generator (D-043). It writes:
  - the scripts, the scenes and the input map;
  - the `GameState` autoload (score, lives, levels, shop, win/lose, save);
  - the `.sln`, and the `.csproj` with the ExportRelease exclusion (D-042);
  - `export_presets.cfg`.
- **Project factory.** It writes the files, the addons and the `.modulex` manifests. It then runs `godot --import` and `dotnet build`, and creates the first git checkpoint.
- **Scene runner.** It runs each scene headless as the main scene, with autoloads, and fails on project errors only.
- **Build Service.** The Godot exit code is never trusted:
  - Windows must produce the `.exe` and `data_<Asm>_windows_x86_64/<Asm>.dll`.
  - RELEASE and PREVIEW are exported from a git-worktree snapshot with the `ModulexQa` autoload removed. The output is then checked with `distributableViolations`.
  - Export logs are written next to the build, not inside it.
  - iOS on a non-macOS host is **PREPARED** (a git bundle).
  - Android without an SDK is **BLOCKED**.
- **Pipeline engine** (`core/src/pipeline/engine.ts`).
  - It is resumable, and runs one execution per project.
  - Each stage is persisted as RUNNING, then gets an outcome with evidence.
  - It stops at FAILED, BLOCKED or NEEDS_HUMAN.
  - Every PARTIAL_SUCCESS names what was not done.
  - `studio_game_create` now executes in the background, and `studio_pipeline_resume` is implemented and advertised to Claude Desktop.

GATE 6 (`core/tests/live-pipeline.test.ts`, run locally in 114 s with Godot 4.5.1 mono):

```
technical_specification … build: SUCCESS
asset_generation: SUCCESS (all SAMPLE_GAME_SPEC assets are procedural, provenance source=procedural)
playtest / visual_inspection / optimization: PARTIAL_SUCCESS (tier not wired yet, reason recorded)
export: PARTIAL_SUCCESS — windows RELEASE BUILT; android BLOCKED: Android SDK not configured;
        ios PREPARED — macOS/Xcode build worker required
windows-release/data_SpaceKidJourney_windows_x86_64: SpaceKidJourney.dll, no McpPlugin/ReflectorNet/SignalR
```

A Linux RELEASE export of the same project, done by hand, boots and runs 300 frames with no errors.

CI job `studio-pipeline` runs the same gate. It uploads the Windows RELEASE build as the artifact `sample-game-space-kid-journey-windows`.

## Phase 7: ComfyUI workers, workflow registry and job system

- **Client** (`core/src/comfy/client.ts`). It uses the documented endpoints only, over HTTP (ComfyUI is GPL-3.0 and is never bundled):
  - `/api/jobs`, with a `/history` + `/queue` fallback;
  - cancel, with an interrupt + queue-delete fallback;
  - size-capped `/view`.
- **Job system** (D-044). It chooses a worker by trust, capabilities, required nodes, VRAM, priority, cost and queue depth. It then persists the job before sending it, and queries the worker before any resend. Every failure is classified, and the cost goes into the ledger.
- **Onboarding runner.** It runs all eight steps. A remote worker that answers without credentials fails authentication and can never become TRUSTED.
- **Reference proxy.** `worker/comfy-proxy/Caddyfile`: TLS, a bearer token, and ComfyUI-Manager and the user-data routes closed.
- **Workflow registry.** `studio/workflows/` holds 2 built-in workflows, both UNVERIFIED (D-045), and cross-checks each definition against its graph.
- **GATE 7.** The mock suite passes 18/18. The live test prints `live: BLOCKED — no ComfyUI worker configured`.

## Phase 8: asset validation, processing and Godot import

- The validator, processing, the stage machine and the importer are described in D-046.
- Live evidence (Godot 4.5.1 mono under Xvfb):
  ```
  container, khronos_validator (0 errors), mesh, finite, surface, triangle_budget, scale: ok
  checkpoint mx-cp-1 → copy res://assets/generated/prop/crate/crate.glb → reimport → resource_find (1.1s)
  → validate_resources → instance → scene_tree: MeshInstance3D → thumbnail: 2859-byte PNG, variance 6080.8
  ```
- CI runs the same test in the QA workflow (step "GATE 8").

## Phase 9: QA runner, fix loop and the QA tier in the pipeline

- **QA runner** (`core/src/qa/`). It has two tiers:
  - Static: `dotnet build` errors, every scene run headless, and the editor's `script-validate` /
    `project-validate-resources`.
  - Scripted playtest: the default scenarios, plus any in `.modulex/tests/*.json`, through the in-game QA runtime
    on the project's own playtest server.

  Failures are classified and fingerprinted, then recorded in `studio.db`.
- **Fix loop.** A checkpoint before every attempt, generator restore as the fixer (D-047), a restore on regression,
  and the limits 3 per fingerprint / 8 per run / 30 minutes.
- **The `pause-resume` hang** is fixed in `addons/modulex_studio` only, with zero diff in `addons/godot_mcp` (D-049).
- **Failure attribution.** A `SCRIPT ERROR` keeps its `at: (res://…:N)` frame (D-050). The fix loop now fixes
  `player.gd` on the first attempt, and the BLOCKED summary names `bonus.gd`.
- **Pipeline.** With `MODULEX_SERVER` set:
  - `playtest` runs the QA tier, and `bug_fixes` runs the fix loop.
  - `/health` reports `pipeline: { available, qaTier }`.
  - The shell's `--selftest` passes the bundled env.
  - CI asserts that the small installer reports `available=false` and the full installer reports `available=true`
    and `qaTier=true` (D-050).

**GATE 9** (`core/tests/live-qa.test.ts`, Godot 4.5.1 mono plus gamedev-mcp-server 9.2.9 under Xvfb, 273 s).
CI runs the same test in the QA workflow, step "GATE 9".

```
[gate9] clean: 0 failure(s)        boot, hud, interact-and-jump, level-2, lose, no-fall-through,
                                   pause-resume (7/7), player-moves, save-load, win: passed
[gate9] injected: 4 failure(s)
  missing_resource  res://textures/missing_ground.png — Resource file not found (expected type: Texture2D)
  runtime_exception res://scripts/player.gd:33 — Invalid call. Nonexistent function 'explode' in base 'Nil'.
[gate9] fix missing_resource #1 (mx-cp-3): fixed — restored res://scenes/level_1.tscn from the generator
[gate9] fix runtime_exception #1 (mx-cp-4): fixed — restored res://scripts/player.gd from the generator
[gate9] fix loop: SUCCESS — all tests pass after 2 fix(es)
[gate9] after fixes (full regression): 0 failure(s)     (all 10 scenarios passed)
[gate9] unfixable: BLOCKED — could not fix runtime_exception after 3 attempts: SCRIPT ERROR: Invalid call.
        Nonexistent function 'spin' in base 'Nil'. at: _ready (res://scripts/bonus.gd:5)
        → Fix res://scripts/bonus.gd manually or ask the ModuleX Agent with the evidence, then resume the pipeline.
 ✓ GATE 9 — QA runner, injected bugs and the fix loop  272894ms
```

## Phase 10: Windows-host smoke (GATE 10)

CI job `windows-smoke` (`.github/workflows/test_modulex_qa.yml`, `windows-latest`) runs these steps:

1. Set up Godot 4.5.1 mono with export templates.
2. Download the win-x64 gamedev-mcp-server 9.2.9 and verify it against SHA256SUMS (fail-closed).
3. Run `tests/live-windows-smoke.test.ts`.

The test exports the sample game as Windows QA and RELEASE builds. The QA exe must pass every default scenario
through its in-game runtime. The RELEASE exe, which has no MCP inside, must stay alive for 10 s. If the windowed run
fails on the runner, the job retries with `MODULEX_SMOKE_HEADLESS=1`, and both the log and a workflow warning say so.

**GATE 10: green on `windows-latest`, windowed (no headless fallback needed)**, run
[36888838055](https://github.com/modulix0025-dev/Godot-MCP/actions/runs/36888838055), commit `2c94c4a`:

```
[gate10] godot --import: ok
[gate10] dotnet build: ok
[gate10] QA: BUILT SpaceKidJourney.exe 94643712B ec7518a28cff, SpaceKidJourney.pck 388236B 89c231c4f174
[gate10] RELEASE: BUILT SpaceKidJourney.exe 96823808B 3f1ecc1545ce, SpaceKidJourney.pck 388060B 5e76011e093e
[gate10] mode: windowed
[gate10] QA scenario boot / player-moves / no-fall-through / interact-and-jump / hud / pause-resume /
         lose / win / level-2 / save-load: passed (10/10)
[gate10] RELEASE alive true for 10000 ms (exit null)
[gate10] Windows QA + RELEASE smoke: exercised
 ✓ GATE 10 — Windows export + smoke test (QA and RELEASE)  208361ms
```

The same job runs the Setup Assistant against the live official sources first (`MODULEX_LIVE_SETUP=1`); every
download is checksum-verified and the installed tools are run:

```
[setup-live] godot-mono: installed 4.5.1-stable mono sha512:168fb2502fe979f7a…
[setup-live] mcp-server: installed 9.2.9 sha256:8878a10a32fe01670…
[setup-live] dotnet-sdk: installed 8.0.425 sha512:f0b6f15bf6f1a0507…
[setup-live] git: installed git version 2.55.0.windows.5
[setup-live] godot --version: 4.5.1.stable.mono.official.f62fdbde1
[setup-live] dotnet --version: 8.0.425
[setup-live] official sources: exercised
```

## Phase 11: remote build workers

- **`studio/worker`** (`modulex-build-worker`): an HTTPS service, mandatory unless loopback-only.
  - one-time-code pairing, with hashed tokens;
  - idempotent `bj_` jobs and sha256-verified bundle upload;
  - cancel, heartbeat (`/v1/health`) and capabilities (profile names only);
  - recovery after a worker restart;
  - the Godot export runner, plus `xcodebuild archive` / `-exportArchive` for signed iOS;
  - a macOS LaunchAgent plist.

  Worker unit tests: 14/14.
- **Core.**
  - `RemoteBuildWorkerClient`, `pairBuildWorker` (token in the vault, handle in `studio.db`) and `BuildJobs`
    (persist-before-send, `resume()`, one retry for `worker_restarted`, verified downloads, cost ledger).
  - Schema v2 (`build_workers`, `build_jobs`).
  - `BuildService` iOS gives SIGNED with a worker, otherwise PREPARED.
  - Owner endpoints `GET /build-workers`, `POST /build-workers/pair` (503 BLOCKED without the vault, D-052) and
    `POST /build-workers/ios-signing-profile`.

**GATE 11** (`core/tests/build-workers.test.ts`: the real worker service, with a fake runner because no Mac is
available):

```
✓ pairing keeps the token in the vault only; the database holds the handle
✓ idempotency: one worker job per key; the second call returns the cached, verified result
✓ cancel: an aborted build cancels the worker job
✓ kill -9 of Core mid-build: resume follows the same job; no duplicate job on the worker
✓ kill -9 between "row written" and "worker answered": resume submits the SAME job id once
✓ a worker restart mid-job is retried once with a new job id for the same key
✓ a tampered artifact is rejected (sha256 mismatch)
✓ a runner failure is FAILED with its class, never retried as a lost job
✓ BuildService iOS: SIGNED through a paired macOS worker; PREPARED without one
✓ live macOS worker: [gate11] live macOS signing: not exercised — BLOCKED (no macOS build worker available)
Tests 10 passed (10)   — repeated 5×: 10/10 each time
```

## Phase 12: resumability, completion predicate, cost

- **Resume.**
  - On start: `resumeInterrupted()` for pipeline runs and `BuildJobs.resume()` for worker jobs.
  - Inside a stage: idempotent tasks with post-conditions in `studio.db`.
  - `StudioStore` saves atomically.
- **Completion.** The verdict is computed from the recorded evidence after every execution, and returned by
  `studio_pipeline_status`. Nothing can set it.
- **Budgets.**
  - Per-project and monthly caps, from the versioned `budgets` config.
  - A stage pre-flight over the cap stops NEEDS_HUMAN.
  - A tool call over the cap becomes an Ask.
  - Worker minutes and GPU seconds go to the ledger.

**GATE 12:**

```
core/tests/resume.test.ts
✓ Core killed at scene 17 of 30: the next Core resumes at scene 17, scenes 1-16 are not re-run
✓ a re-run stage skips verified scenes and runs only what is new or unverified
✓ Core killed mid-generation: the next Core follows the persisted prompt_id — the worker saw one job
✓ every stage SUCCESS is still not a complete game without platform evidence
✓ SUCCESS only with every evidence row: builds with sha256, a launch smoke, a signed iOS release
✓ Budget: per-project and monthly caps, with the numbers
✓ a stage whose estimate crosses the budget stops NEEDS_HUMAN with the numbers; nothing runs
✓ an over-budget tool call becomes an owner approval (Ask); within budget it runs
core/tests/build-workers.test.ts
✓ kill -9 of Core mid-build: resume follows the same job; no duplicate job on the worker
shared/tests/completion.test.ts
✓ all 131072 combinations: SUCCESS iff nothing is missing; missing names exactly the gaps
✓ every single proven-failing row is FAILED and named
✓ a second platform done while the first is incomplete is PARTIAL_SUCCESS, never SUCCESS
✓ an owner decision pending is NEEDS_HUMAN even with every row proven
```

## Phase 13: desktop app, Setup Assistant, installers, credential store, signing, updater

**Installers, live on `windows-latest`** (run 36884167845, commit `844ba56`, job "studio tests + Tauri NSIS
installer (windows)": green):

```
ModuleXGameStudioSetup.exe      silent install → --selftest ok, health 200, vault_ok=true
                                vault steps: store ✓ · read back ✓ · delete ✓ · gone ✓   (Windows Credential Manager)
                                pipeline.available=false (no engine bundled: reported honestly) → uninstall exit 0
ModuleXGameStudioFullSetup.exe  135.3 MB (engine payload 319.5 MB before compression)
                                installed: …\ModuleX Game Studio\engine\godot\Godot_v4.5.1-stable_mono_win64.exe
                                           …\ModuleX Game Studio\engine\server\gamedev-mcp-server.exe
                                --selftest: pipeline.available=True pipeline.qaTier=True vault_ok=true → uninstall exit 0
```

**What was built.**

- **Setup Assistant (D-055).** Official sources with fail-closed checksums, resumable downloads, atomic
  extraction, and a licence gate for the Android SDK. Live on Linux: Godot (sha512) and the server (sha256)
  installed, and `godot --version` ran from the installed copy.
  - On Windows CI the live step found a real bug: Git's GNU `tar` earlier on PATH read `C:\…` as a remote host.
    Extraction now uses `%SystemRoot%\System32\tar.exe`.
- **Credential store bridge (D-056).** Build worker pairing works in the app, and the token lives only in
  Credential Manager.
- **Production UI (D-060).** Live screens on the approved design system, with Core CORS restricted to the UI's
  origins.
- **Authenticode signing (D-057).** It runs only with the owner's certificate secret. Until then the build is
  unsigned, and CI says so.
- **Updater verification (D-058).** minisign by the built-in key, fail-closed. The key pair, the feed and the
  restart handoff need the owner.

## Phase 14: licences

`docs/modulex/THIRD_PARTY_LICENSES.md` is generated from the esbuild metafile, the lockfile, `cargo tree`, the
NuGet pins, the runtimes and the workflow licence facts (D-059):

- shipped: 21 npm packages in Core, 6 in the UI, 229 Rust crates;
- listed but not yet bundled: 104 packages that Core declares;
- 2 model licence facts.

The installers ship the licence texts, and CI checks that they are installed.

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
6. **Generated projects:** the `.sln`, the ExportRelease exclusion (D-042) and the `ModulexQa` strip
   (D-032) are done. The generated Windows build still needs a smoke run on a real Windows host, which is
   planned for Phase 10 Windows CI.
7. **The ModuleX Agent codebase is not accessible** (D-030). Scenario #1 cannot run until it connects to
   `/mcp`.
8. **The Windows Credential Manager bridge** passes `cargo check` for the Windows target. It is exercised
   for real only by the Windows CI install and self-test, and later by manual pairing.
9. **Live System Evolution pieces.** These still need live verification:
   - the workflow test job (needs a TRUSTED ComfyUI worker and the Phase 7 client);
   - the Godot and MCP diagnostics probes (Phase 4 Godot manager);
   - the update platform steps (Tauri updater signing key and feed, Phase 13);
   - core evolutions on a developer install (`MODULEX_SOURCE_REPO`).
