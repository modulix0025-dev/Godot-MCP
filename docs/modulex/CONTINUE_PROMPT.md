# Continuation prompt: finish ModuleX Game Studio

Paste everything below the line into Claude Code, or a Cowork session, opened on this repository. Work on the
branch `claude/practical-hawking-whz0fm`, or on a new branch cut from it.

---

You are continuing **ModuleX Game Studio** in the repository `modulix0025-dev/Godot-MCP`, on the branch
`claude/practical-hawking-whz0fm`. Reply to the owner in Egyptian Arabic. Write code, docs and commits in English.

## Read first, in this order

1. `CLAUDE.md`. These are hard repo rules:
   - Every `.cs` file starts with the Apache header.
   - Editor-only code goes behind `#if TOOLS`.
   - Never bump ReflectorNet 5.4.1, McpPlugin 8.6.0 or ServerVersion 9.2.9.
   - Never use `git add -A`.
   - Never commit `bin/`, `obj/`, `.godot/`, `*.uid` or `node_modules`.
   - Commits use `<type>(<scope>): …`.
   - After `npm ci`, run `git checkout -- cli/bin/godot-cli.js`.
2. `docs/modulex/EXECUTION_PROMPT.md`. This is the plan: Phases 0–15, Execution Patch 1 (security) and Execution
   Patch 2 (System Evolution).
3. `docs/modulex/PROGRESS.md` (what is done, with real gate output) and `docs/modulex/DECISIONS.md` (D-001…D-046;
   code wins over docs).
4. `docs/modulex/security.md` and `docs/modulex/system-evolution.md`.

## Where the work stands

- **Done and verified:**
  - Phases 0–8.
  - Patch 1 and Patch 2.
  - The Phase 3 UI direction, approved by the owner (D-022).
- **Gates that passed live:**
  - GATE 4: the Core drives a real Godot 4.5.1 editor.
  - GATE 6: GAME_SPEC → project → scenes → QA → Windows QA and RELEASE builds. It runs in CI and uploads the
    sample game.
  - GATE 7 against the mock ComfyUI. The live part is BLOCKED because no GPU worker exists (D-045).
  - GATE 8: GLB validation and import into a real editor, with the thumbnail rendered under Xvfb.
- **Phases 9–10, in progress** (the last commit, "QA runner, fix loop and build smoke tests"):
  - `studio/core/src/qa/*` holds failures and fingerprints, scenarios, the playtest runner, the QA runner, the fix
    loop and the generator-restore fixer. Unit tests pass (`tests/qa.test.ts`).
  - `tests/live-qa.test.ts` (GATE 9) is **NOT passing yet**. 7 of the 8 default scenarios pass on the clean game.
    `pause-resume` times out: once the game tree is paused, the in-game QA tool calls stop answering.
    Likely fix: the QA runtime's main-thread dispatch in `addons/modulex_studio` (and the node it uses in
    `addons/godot_mcp`) must run with `ProcessMode = Always`. Keep `addons/godot_mcp` diffs minimal and record each
    one in `DECISIONS.md`. Then re-run the whole GATE 9 test until it is green. It also covers injected-bug
    detection, the fix loop, and an unfixable bug that ends BLOCKED.
  - `src/build/smoke.ts` and `tests/live-windows-smoke.test.ts` (GATE 10 on Windows) are written but have never run.
    Add a `windows-latest` job to `.github/workflows/test_modulex_qa.yml` with these steps:
    1. `chickensoft-games/setup-godot@v2` with `include-templates: true`.
    2. Download `gamedev-mcp-server-win-x64.zip` v9.2.9 and verify it against SHA256SUMS.
    3. Run the test. If windowed fails on the runner, retry with `MODULEX_SMOKE_HEADLESS=1` and say so in the log.
  - Add GATE 9 to the Linux QA job under `xvfb-run`.
  - Record D-047 (the generator-restore fixer stands in for the unavailable agent) and D-048 (nuget.config without a
    local feed; the Setup Assistant adds it). Update PROGRESS.

## Remaining phases (see EXECUTION_PROMPT.md for the full requirements of each)

- **Phase 11:** remote build workers (`studio/worker`: HTTPS service, pairing, idempotent `bj_` jobs, export and
  signing runner). The macOS worker produces SIGNED iOS builds; without one, iOS stays PREPARED.
- **Phase 12:** resumability across a Core restart (pipeline + SQLite; replace the JSON `StudioStore` where the plan
  asks), the completion predicate wired to the pipeline, the cost ledger, budgets and the Ask tier.
- **Phase 13:**
  - The production desktop UI in `studio/app/ui`, implementing the approved prototype. The visual identity is
    monochrome: no Godot logo, and colour only for semantic state.
  - The Setup Assistant (resumable, checksum-verified downloads for Godot 4.5.1 mono, .NET, templates, the server
    and the Android tools).
  - The NSIS installer `ModuleXGameStudioSetup.exe` and an optional full installer.
  - The updater (never automatic; Stable is the default channel).
  - Secrets only in Windows Credential Manager (DPAPI).
- **Phase 14:** the self-test, the documentation and licence compliance (list every third-party licence, including
  gltf-transform MIT, meshoptimizer MIT, the Khronos glTF-Validator Apache-2.0 and the model licences in
  `studio/workflows`).
- **Phase 15:** the end-to-end acceptance scenarios with evidence (screenshots, logs, video where the plan asks).

## Non-negotiable rules (from the patches)

- Agents get Agent-safe `studio_*` tools only. Raw Godot-MCP tools need owner-confirmed Developer Mode, and Claude
  Desktop never gets them. Add every new `studio_*` tool to `studio/shared/src/policy.ts` first. Never hand-edit
  the Claude Desktop manifest; rebuild it.
- Secrets never go into SQLite, logs, events, prompts, git or project files. Never expose API keys, worker tokens,
  signing material or keystore passwords.
- Never expose an unauthenticated ComfyUI worker. Never scrape Claude Desktop sessions or use private endpoints.
- System Evolution: no silent removal of approval, audit, backup, rollback or tests. `patchGuard` blocks diffs that
  delete or skip tests or remove `audit.append`.
- Report honestly: SUCCESS / PARTIAL_SUCCESS / BLOCKED / FAILED / NEEDS_HUMAN with evidence. Never fake a gate. Live
  tests skip only with an explicit "not exercised / BLOCKED" message.

## How to work

- **Gates.** Run these before every commit:
  - `cd studio && npm ci && npm run lint && npm run format:check && npm run build && npm run typecheck && npm test`
  - `dotnet build Godot-MCP.sln` and `dotnet test Godot-MCP.Tests`
- **Live tests.** The live tests need `MODULEX_LIVE_GODOT` (Godot 4.5.1 mono), `MODULEX_LIVE_SERVER`
  (gamedev-mcp-server 9.2.9) and, for GATE 4 and GATE 8, `MODULEX_LIVE_PROJECT`. Use `xvfb-run` for rendering.
- **After each phase:**
  1. Commit with the session trailers.
  2. Push to the branch.
  3. Check CI and fix any red job before moving on.
  4. Update `PROGRESS.md` with the real gate output.
