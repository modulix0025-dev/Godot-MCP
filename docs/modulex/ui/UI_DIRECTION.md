# UI Direction Review: ModuleX Game Studio (Phase 3)

> **Status: APPROVED by the owner on 2026-09-29** ([`../DECISIONS.md`](../DECISIONS.md) D-022). Production
> screens implement this direction.
>
> **Revised by Execution Patch 1 (D-029).** The identity is now **monochrome**: black, white and greys only,
> with colour reserved for semantic state. The Cobalt accent is gone. The prototype also gained the six-signal
> health cluster, the Developer Mode pill, Settings → AI Providers / Model routing / Developer Mode, the
> 19-stage creation pipeline, the "Open in Claude Desktop" handoff menu, asset provenance, worker trust with
> onboarding, approval impact (What / Why / Scope / Files / Risk / Rollback) and build profiles.
>
> **Extended by Execution Patch 2 (D-034…D-041).** A tenth destination, **System**, has these sections:
> Overview (with "Ask ModuleX Agent to modify the system"), Versions (with project compatibility and
> "Upgrade Project"), Extensions, Skills, Workflows, Providers, Updates (channel and Roll Back Update),
> Evolution History (the owner review `vX → vY` with Approve Update / Reject / Inspect Diff, and the CRITICAL
> policy diff with a typed confirmation), Diagnostics, and Developer Mode. Its blocked state is **Safe Mode**.

This review covers:

- the information architecture;
- the nine screens, each in its normal, empty, loading, error and blocked states;
- the design system;
- Arabic right-to-left (RTL) support;
- the app icon.

Everything shown is a **clickable static prototype** in the real app code. It uses the real design tokens,
not mock-ups. The sample content is illustrative. The one exception is the game frame in the preview panes:
it is a real `game-screenshot` captured by the Phase 2 live QA harness.

**Run the prototype:**

```bash
cd studio && npm ci && npm run dev -w @modulex/ui
# open http://localhost:1420/#/prototype/studio
```

**Re-capture every screenshot** (81 images, written to `docs/modulex/ui/screens/`):

```bash
npm run build -w @modulex/ui && node app/ui/scripts/capture-prototype.mjs
```

The URL fully describes the view, for example `#/prototype/<screen>?state=<state>&theme=dark|light&lang=en|ar`.

- `<screen>` is one of `projects`, `studio`, `activity`, `assets`, `test`, `builds`, `workers`, `approvals`,
  `system`, `settings`.
- `<state>` is one of `normal`, `empty`, `loading`, `error`, `blocked`.
- On `settings`, `&section=ai-providers|routing|developer|…` selects the Settings section.
- On `system`, `&section=versions|extensions|skills|workflows|providers|updates|history|diagnostics|developer`
  selects the System section.

A dashed "Prototype" bar in the corner switches state, theme and language. It is review chrome, not part of
the product. **Ctrl+K** opens the command palette.

---

## 1. Information architecture and navigation

**Left icon rail (9 destinations, it moves to the right in Arabic):**

1. **Projects:** the home screen.
2. **Studio:** the per-project workspace.
3. **Activity.**
4. **Assets.**
5. **Test & Debug.**
6. **Builds.**
7. **Workers.**
8. **Approvals:** shows a badge with the pending count.
9. **Settings:** pinned to the bottom of the rail.

Everything except Workers and Settings is project-scoped.

**Top bar, from start to end:**

- the wordmark;
- the **project switcher**;
- the **connection-health cluster**: Agent · Godot · MCP · ComfyUI · Build Workers · Claude. Each is a compact
  dot with the detail in its tooltip;
- the **Developer Mode pill** ("Dev mode · off"), which opens Settings → Developer Mode;
- the **budget meter** (spend / cap);
- the **Approvals** shortcut;
- **Ctrl+K**.

| Screen | Screenshot (dark) | Light |
|---|---|---|
| Projects | ![](screens/projects-dark.png) | ![](screens/projects-light.png) |
| Studio | ![](screens/studio-dark.png) | ![](screens/studio-light.png) |
| Activity | ![](screens/activity-dark.png) | ![](screens/activity-light.png) |
| Assets | ![](screens/assets-dark.png) | ![](screens/assets-light.png) |
| Test & Debug | ![](screens/test-dark.png) | ![](screens/test-light.png) |
| Builds | ![](screens/builds-dark.png) | ![](screens/builds-light.png) |
| Workers | ![](screens/workers-dark.png) | ![](screens/workers-light.png) |
| Approvals | ![](screens/approvals-dark.png) | ![](screens/approvals-light.png) |
| Settings | ![](screens/settings-dark.png) | ![](screens/settings-light.png) |

## 2. Screens (what each one is for)

**Projects** (home) lists every game with:

- its status pill ("Building · stage 9/20", "Partial success", "Complete");
- per-platform dots (Windows / Android / iOS);
- the last build time;
- the money spent.

Next to the list sit a recent-activity feed and a **System** panel (Godot, .NET, templates, Android tools,
MCP server).

**Studio** (the workspace) has three resizable panes: **Conversation | Preview | Pipeline.**

- **Conversation** is bidi-aware chat. The agent's **proposed actions** appear inline as cards with cost, a
  policy tier badge (Auto / Ask / Disabled) and Approve / Edit / Reject.
- A **pinned context chip** above the composer shows the current editor selection or asset. "Change this
  one" always resolves to the chip, so a pronoun is never ambiguous.
- **Preview** has five tabs: Game / Editor / Scene tree / Asset / Logs. Under the image it shows the error
  and warning counts, the fps and a live log console. "Pause agent" and "Open in Godot" are in its header.
  (The Godot editor is never re-implemented.)
- **Pipeline** shows the 20 real stages with their status. The running stage is highlighted.

**Activity** is an append-only timeline of every stage, tool call, job, build and policy decision, with a
filter. Tool calls are shown by their real ids, and secrets are redacted.

**Assets** is a grid of cards with a thumbnail, category, status and triangle count. The status shows
`Queued`, `Generating 63%`, `Validating`, `Needs rig`, `Imported` or `Failed · oom`.

- The detail drawer shows the stage chain Reference → Mesh → … → GLB.
- It states it plainly when rigging is missing: *"BLOCKED — requires rigging … never presents it as a
  playable character."*

**Test & Debug** has three columns: the test list, the failure detail, and the fix attempts.

- The failure detail shows the class, fingerprint, assertion, top frame and a screenshot.
- The fix-attempts column shows the attempt count (1/3), the run budget and the checkpoint.
- A console strip sits underneath.

**Builds** is a table showing each build's:

- platform and version;
- status, which is honest: "Smoke-tested", "Built, not device-tested", or
  "Prepared (no macOS worker)";
- size and sha256.

A **requirements checklist** per platform is shown *before* building.

**Workers** has one card per GPU or build worker, showing:

- hardware and provider;
- the ComfyUI or Godot version;
- capability tags;
- rate and queue;
- a **Test** button.

**Approvals** has one card per pending action, showing:

- the tool id and the role that asked;
- the arguments, the reason and the cost;
- the tier: *Destructive* or *External cost*.

The actions are **Approve / Reject / Always allow for this project**.

**Settings** has ten sections:

- General
- Appearance
- Language
- Agent connection
- Godot installations
- Autonomy policy
- Budgets
- Secrets
- Updates
- Developer mode

The theme and language switches work live.

### Command palette (Ctrl+K)

![](screens/palette-dark.png)

## 3. States: every screen has four more

The rules for each state are:

- **Empty:** a one-line purpose and one primary action.
- **Loading:** a skeleton of the final layout, never a lone spinner.
- **Error:** what failed, the **evidence** (monospace), the next action, and **Copy diagnostics**.
- **Blocked:** exactly what is missing, and a button that fixes it.

The copy is specific to each screen and is taken from real failure modes found in Phase 0. For example, the
Builds error state is the "export exited 0 but no C# assemblies" case (D-011), and the Assets error state is
an OOM on a named worker with the "no resubmit without a new prompt_id" rule.

| Screen | Empty | Loading | Error | Blocked |
|---|---|---|---|---|
| Projects | ![](screens/state-projects-empty.png) | ![](screens/state-projects-loading.png) | ![](screens/state-projects-error.png) | ![](screens/state-projects-blocked.png) |
| Studio | ![](screens/state-studio-empty.png) | ![](screens/state-studio-loading.png) | ![](screens/state-studio-error.png) | ![](screens/state-studio-blocked.png) |
| Activity | ![](screens/state-activity-empty.png) | ![](screens/state-activity-loading.png) | ![](screens/state-activity-error.png) | ![](screens/state-activity-blocked.png) |
| Assets | ![](screens/state-assets-empty.png) | ![](screens/state-assets-loading.png) | ![](screens/state-assets-error.png) | ![](screens/state-assets-blocked.png) |
| Test & Debug | ![](screens/state-test-empty.png) | ![](screens/state-test-loading.png) | ![](screens/state-test-error.png) | ![](screens/state-test-blocked.png) |
| Builds | ![](screens/state-builds-empty.png) | ![](screens/state-builds-loading.png) | ![](screens/state-builds-error.png) | ![](screens/state-builds-blocked.png) |
| Workers | ![](screens/state-workers-empty.png) | ![](screens/state-workers-loading.png) | ![](screens/state-workers-error.png) | ![](screens/state-workers-blocked.png) |
| Approvals | ![](screens/state-approvals-empty.png) | ![](screens/state-approvals-loading.png) | ![](screens/state-approvals-error.png) | ![](screens/state-approvals-blocked.png) |
| Settings | ![](screens/state-settings-empty.png) | ![](screens/state-settings-loading.png) | ![](screens/state-settings-error.png) | ![](screens/state-settings-blocked.png) |

## 4. Arabic and RTL

| Studio (Arabic, dark) | Studio (Arabic, light) | Projects (Arabic) |
|---|---|---|
| ![](screens/studio-rtl-ar-dark.png) | ![](screens/studio-rtl-ar-light.png) | ![](screens/projects-rtl-ar-dark.png) |

**How the mirroring works.**

- Switching to Arabic sets `<html dir="rtl" lang="ar">`.
- The whole layout mirrors with **no per-component overrides**, because every style uses logical CSS
  properties (`inline-start/end`, `padding-inline`, `inset-inline`, `border-inline-end`).
- The rail moves to the right, and the panes reverse.
- Directional glyphs (send, chevrons) flip. Symbolic ones (play, check, gear) do not.

**Chat.** The chat and the composer use `dir="auto"` + `unicode-bidi: plaintext`. So mixed text renders
correctly in either UI direction, for example «اعمل لعبة 3D للأطفال…», or an English agent reply containing
«(العربية + English)».

**Numbers.** Numbers, ratios, money and versions are bidi-isolated (`.num`), so they keep their order inside
Arabic text: "9 / 20", "$3.20 / $50", "3 scenes".

**Code and logs.** Consoles are always left-to-right and monospace, even in the Arabic UI.

**Font.** Arabic uses IBM Plex Sans Arabic. It is set once on `body`, so code fonts still win.

**Translation.** Every chrome string exists in both languages (`src/prototype/i18n.ts`). A unit test fails
if a navigation label is missing in either.

## 5. Design system

**Colour tokens** live in `studio/app/ui/src/design/tokens.css`, and components read only these variables.

- **Identity: monochrome** (Execution Patch 1 §2). There is no brand hue. Emphasis is contrast: near-white
  on ink in the dark theme, ink on white in the light theme. The primary button is `#F5F6F7` on ink (dark) or
  ink on white (light).
- **Ink scale:** pure greys with no blue cast, `#0B0C0E` → `#F5F6F7` (10 steps).
- **Semantic colours — the only colours in the product:**
  - success `#2FB67C`
  - warning `#E5A13A`
  - danger `#E5484D`
  - info `#3E9BE0`
  - running `#8B7CF6`
- **Themes:** Dark (the default) and Light are pure token swaps. The meaning of each colour is identical
  across themes; only the surfaces and text change.
- **Borders and shadows:** borders are 1 px at 8–12 % contrast. Shadows appear only on overlays.

**Type.**

- Inter (UI), IBM Plex Sans Arabic (Arabic) and JetBrains Mono (code and logs).
- All are **bundled** through `@fontsource` (SIL OFL), so the desktop app needs no network for fonts.
- The scale is 12 / **13 (base, dense)** / 14 / 16 / 20 / 24.
- Metrics use tabular numerals.

**Layout.**

- A 4 px spacing grid.
- Radius 6.
- Row height 40, or 32 in the dense setting.
- The rail is 56 px and the top bar 48 px.
- The minimum window is 1280×760.

**Motion.** 120–180 ms ease-out, used only for state changes and progress (the running pulse, shimmer).
It honours `prefers-reduced-motion`.

**Components** are built once and reused:

- StatusDot and StatusPill, in every tone;
- PipelineTimeline / stage rows;
- Card;
- KeyValue;
- DataTable;
- AssetCard;
- the ActionProposal card, with its cost and tier;
- ApprovalCard;
- the log console, which is always left-to-right;
- HealthCluster;
- the budget meter;
- CommandPalette;
- Skeleton;
- the four state components: EmptyState, ErrorState, BlockedState and Loading;
- Progress;
- CostBadge;
- the segmented control;
- chips.

The following are specified but not yet in the static prototype: ModelViewer (three.js GLB),
ScreenshotViewer with diff, Drawer/Modal, Toast and DiffView. They are built in Phase 13, once approved.

**Accessibility.**

- The rail buttons carry `aria-label` / `aria-current`.
- Loading regions carry `aria-busy`.
- Error states use `role="alert"`.
- The palette is a labelled dialog with keyboard navigation (↑/↓/Enter/Esc).
- There is a visible `:focus-visible` ring.

## 6. App icon

![](icon-concepts.png)

The rows, top to bottom, are A–D. The columns are 256 / 48 / 24 / 16 px on a light background, then the same
on a dark one.

| Concept | Idea | Assessment |
|---|---|---|
| **A · Module Keystone** | An isometric cube. Its two long diagonals are carved out as an X of negative space, splitting it into four modules; the front module is offset ("assembly in progress"). Rendered in greys only. | **Recommended.** It says modular, 3D and building, it is distinctive, and it is legible from 24 px up on light and dark. **The trade-off is 16 px:** the hand-simplified master reads as a gem-with-X, softer than B. The 16 and 20 px renders are now pixel-hinted to a four-tone palette. |
| B · Forge X | Two chevrons forming an X around a spark. | The crispest at 16 px, but it reads as a generic "AI spark" or close button. It is not distinctive. |
| C · Stage Frame | A viewport frame with a play cursor. | It reads as a media player; "ModuleX" is lost. |
| D · Node Graph X | Four connected nodes in an X. | It looks like many developer tools and loses its nodes below 24 px. |

**Concept A at every shipped size:**

![](icon-sizes.png)

The icon files are:

- `studio/branding/icon.svg` (master);
- `icon-24.svg` and `icon-16.svg`: hand-simplified, with a wider channel and no offset;
- `generate-icons.py`: regenerates the three masters;
- `render-icons.py`: renders `png/icon-{16,20,24,32,40,48,64,128,256,512,1024}.png`, pixel-hints 16 and
  20 px, writes the Windows multi-resolution `.ico` (16, 20, 24, 32, 40, 48, 64, 256) and the Tauri icons.
  `--verify` checks every PNG size and every ICO entry, and runs in CI. (It replaces `build-ico.py`.)
- `concepts/`: A–D.

## 7. What I am asking the owner

Please **approve or adjust** each item:

1. **Navigation:** the 9-destination rail and the top-bar contents.
2. **The Studio workspace:** the three-pane layout, the inline proposal cards, and the pinned context chip.
3. **The visual language:** dark as the default theme, the monochrome identity (colour only for state), the
   density (13 px base), and the four state treatments.
4. **Arabic:** full RTL mirroring, with code and logs kept left-to-right.
5. **The icon: concept A, monochrome.** Also: should the 16 px size favour a simplified "X-gem" (as now) or
   borrow B's crisper chevrons at 16 px only?
6. **The Patch 1 surfaces:** the health cluster, the Developer Mode pill and dialog, the AI Providers cards,
   provenance, worker trust and approval impact.

Any change requested here is applied to the tokens and components before Phase 13 builds the production
screens. Until approval, `App.tsx` renders only a placeholder plus the prototype route.
