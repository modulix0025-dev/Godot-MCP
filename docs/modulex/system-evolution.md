# ModuleX Game Studio: System Evolution

System Evolution lets the owner change ModuleX Game Studio itself after release. That covers adding a
provider, a workflow, a Skill or an export target, changing policy, fixing a bug, or upgrading an
integration. Every change is sandboxed, tested, shown to the owner as the exact change, approved, backed up,
deployed, health-checked and verified, and it can be rolled back.

**The rule that governs everything else (§33):** the Studio may change itself, but it can never *silently*
remove or weaken the controls that govern that ability. Those controls are approvals, audit, backup,
rollback, the updater and the policy gateway.

**Code:**

- `studio/shared/src/{evolution,extensions,versions,config-docs}.ts` (contracts);
- `studio/core/src/evolution/` (services);
- `studio/core/src/gateway/evolution-handlers.ts` (MCP tools);
- `studio/app/src-tauri/src/lib.rs` (Safe Mode start).

**Tests:**

- `studio/shared/tests/evolution.test.ts` (37);
- `studio/core/tests/evolution.test.ts` (33);
- the UI System tests in `studio/app/ui/tests/prototype.test.tsx`.

## 1. Three modification modes

| Mode | Used for | How it lands | Rebuild? |
|---|---|---|---|
| **A · config** | policy, budgets, LLM routing, worker settings, prompts, UI and build preferences, update settings | A new **version** of a configuration document (`ConfigStore`). Core reads it live. | No |
| **B · extension** | Skills, workflows, provider configurations, declarative UI panels | Installed into `extensions/<name>/<version>/`. Older versions are kept. | No |
| **C · core** | source code, schema, security model, policy engine, Core, the Tauri shell, the Godot integration, the build system | A patch in a **git worktree sandbox**, then fast-forwarded onto the production branch | Yes (through the update pipeline) |

**How requests are classified (§32).** The ModuleX Agent classifies each request as CONFIG, EXTENSION,
WORKFLOW, PROVIDER, BUGFIX or CORE_CHANGE. Core re-runs its own classifier (Arabic and English keywords)
and **keeps the more controlled mode**, so a request can never be routed around the patch pipeline. An
unknown request goes to the most controlled path, core.

**What counts as an extension.** Extensions are **declarative**. Core never loads extension JavaScript, and
the UI never runs remote code. A package that needs executable code is refused and must go through Mode C
(see D-036). This covers a new adapter family, a build adapter, an exporter or an MCP adapter.

## 2. The core workflow (§3)

The stages are:

request → analyze → proposal → affected files → risks → plan → **sandbox** → implement → unit tests →
integration tests → build → self-test → **diff** → change report → **owner approval** → **checkpoint** →
**deploy** → **health check** → **verify**

- **Sandbox.** `git worktree add -b evolution/<id> <data>/evolution/<id>/worktree <production base>`. The
  agent's patch is applied **there** with `git apply --index` and committed. Production is untouched.
- **Scope is computed from the actual diff.** Files map to components, and components set a risk floor. The
  agent can raise the risk level but never lower it.
- **Test gates depend on risk (§18, §19):**

  | Risk | Gates |
  |---|---|
  | LOW | static, unit |
  | MEDIUM | + integration |
  | HIGH | + security, packaging |
  | CRITICAL | all seven gates |

  Gates fail fast. Their output is redacted.
- **Patch guard (§17).** A diff that does any of the following is **BLOCKED** outright, whatever anyone
  approves:
  - deletes or skips tests;
  - removes `audit.append` calls;
  - hard-codes a credential;
  - opens a service on `0.0.0.0`;
  - bypasses owner approval.
- **Owner approval.**
  - The review (§6) shows: What, Why, Files (modified/added/deleted), Dependencies, Database migrations,
    Security (including protected components), Cost, Rollback, Test results, Version transition, and Risk.
  - The approval is **bound to the SHA-256 of the exact diff**. Any later change voids it.
  - CRITICAL and protected changes need the owner to **type the evolution id**.
  - Only the owner UI principal can approve.
- **Checkpoint.** A tag `mx-evo-cp/<id>` on production, plus a byte backup of the data files (config and
  registry).
- **Deploy.** `git merge --ff-only`. If production moved since the sandbox was created, the evolution is
  BLOCKED.
- **Health check.** If it fails, the evolution's commits are reverted automatically (`git revert`; history
  is never rewritten), the backup is restored, and the status becomes ROLLED_BACK.
- **Verify.** The status becomes **SUCCESS only after verification passes**.

**Who may deploy.**

- The ModuleX Agent may deploy only **owner-approved LOW or MEDIUM evolutions that touch no protected
  control**.
- HIGH, CRITICAL and protected evolutions are deployed by the owner.
- Updater, rollback and compatibility changes are **never** deployed autonomously (§26).

**Protected controls (§25, §26, §33).** These are:

- the policy gateway;
- approvals;
- audit;
- credentials;
- auth and network exposure;
- worker authentication;
- the sandbox;
- backup and rollback;
- the updater;
- the evolution engine;
- the schema;
- signing.

Touching any of them makes an evolution CRITICAL, requires a typed confirmation, and makes it owner-deploy
and owner-rollback only.

## 3. Configuration changes (Mode A, §28)

`studio_config_propose` validates the candidate document and shows the owner the **exact path-level diff**,
for example `add /auto_approve/0: {"tool":"studio_asset_delete",…}`. Nothing changes until the owner
approves. The write is then a **new version**, checked against the version the proposal was based on. After
it lands, the configuration is re-read to verify it, and the change is audited.

Policy and update settings are **CRITICAL**: they need a typed confirmation and are owner-deployed.

Limits the policy schema enforces:

- raw engine tools and critical tools can never be auto-approved;
- System Evolution, extension and update tools can never be auto-approved;
- auto-approval never applies to Claude Desktop (enforced in `decide`).

The gateway reads the live policy for `auto_approve`, `cost_threshold_usd` and `approval_ttl_minutes`. An
invalid document never loosens policy; the gateway falls back to the built-in defaults.

## 4. Extensions, Skills, workflows, providers and UI panels (Mode B, §9–13, §29)

**Manifest.** Each package has a `modulex-extension.json` declaring:

- name and version;
- ModuleX compatibility (a semver range);
- kinds;
- permissions;
- network hosts;
- dependencies;
- licence (SPDX plus commercial use);
- author;
- entrypoints;
- a SHA-256 for every file.

**Install flow (scenario 3):**

1. Inspect the manifest, permissions, licence and dependencies, and check every file hash.
2. Copy exactly the declared files into the sandbox.
3. Validate the content: Skill Markdown, workflow schema plus graph, provider schema (credentials never in
   settings), panel schema (no scripts, no URLs).
4. Present the risk.
5. The owner approves and ticks any high-risk permissions.
6. Back up the registry, install, re-hash (health check) and verify.
7. Rollback re-activates the previous version, or disables the extension if it was a fresh install.

**Permissions.**

| Class | Permissions | Granted by default? |
|---|---|---|
| LOW / MEDIUM | `project:read`, `project:write-assets`, `worker:submit-jobs`, `llm:call`, `ui:panel` | Yes |
| HIGH | `tools:register`, `network:egress` | **Never**; the owner ticks each one |
| Forbidden | `secrets:read`, `fs:outside-project`, `policy:modify`, `process:execute` | Never; the manifest is refused |

**Where agents install from.** Only from the owner-managed `extensions/incoming/<package>/` folder, never
from an arbitrary path or URL.

**Skill Registry.** Each Skill shows its name, version, source, licence, permissions, required tools
(parsed from the `SKILL.md` front matter), last update and health.

**Workflow Registry.** Each workflow has:

- id and version;
- kind (comfyui, build, qa, game_generation, export);
- inputs and outputs;
- dependencies (models, custom nodes);
- worker capabilities;
- cost profile, timeout and retry policy;
- validation checks;
- licence facts (feeding [asset provenance](asset-provenance.md)).

**Version pinning:** a production project can stay on a known-good version while a newer one becomes
active (`studio_workflow_update action=pin`).

**Registering a workflow (scenario 1)** runs one **test job on a TRUSTED worker** whose declared
capabilities match. It then validates the output: GLB magic, non-empty, and provenance. With no trusted
worker, the result is **BLOCKED**, not SUCCESS.

**Providers.** A provider extension configures one of the built-in adapter families: `anthropic`,
`openai-compatible-http`, `comfyui-http`, `local-build` or `filesystem-storage`. Adding a provider is
usually just an extension; a new family is a core change. Credentials are referenced as `secret://…`
handles and never embedded.

**UI panels** are declarative blocks (text, key-value, table) bound to `studio_*` read tools. No remote code
runs automatically.

## 5. Versions, updates, migrations, Safe Mode (§8, §14–16, §20–21)

**Versions tracked (`STUDIO_VERSIONS`, parity-tested against `studio/compat.json`):**

- Studio;
- data schema;
- Godot;
- addons;
- worker protocol;
- workflows.

**Project compatibility.** An older project gets "**Upgrade Project**", with a checkpoint taken first. A
project written by a newer Studio or schema opens **read-only**. Nothing is modified silently.

**Update channels.** Stable (the default), Beta or Developer. `install_automatically` is the literal
`false`, so updates are never forced.

**Update process** (`UpdateManager`):

check → download → **verify sha256 + signature** → **backup** → install → migrate → **health check** →
mark healthy.

A failure from install onwards triggers **automatic rollback** from the backup.

**Roll Back Update (§20)** shows the current and previous versions, the reason, the backup and the health
state. It is owner-only and audited. The platform steps (Tauri updater with its signed manifest) are
injected, and the ordering and safety rules are tested with fakes.

**Migrations.** Each migration has an id, a from/to schema version and a rollback strategy. The sequence is:

1. Back up the file.
2. Migrate a **copy**.
3. Validate the copy.
4. Replace production atomically.
5. Run an integrity check.

An invalid result leaves production untouched.

**Safe Mode (§21)** is entered when:

- a version never passed its health check;
- two starts in a row failed;
- an extension keeps crashing;
- the owner asks for it (the shell also retries a failed Core start with `MODULEX_SAFE_MODE=1`).

Safe Mode runs the last known-good configuration with **every non-core extension disabled**, without
changing the owner's saved choices. From there the owner can roll back, disable an extension, inspect logs,
repair the configuration, or retry the update.

## 6. Diagnostics and repair (§24)

`studio_diagnostics_run` inspects Core, the Godot connection, the MCP server, workers, extensions (by
re-hashing them), configuration validity, update health and Safe Mode. Each finding carries a recommended
repair.

`studio_system_repair` requires the owner's approval. It can:

- restart a component;
- rebuild the connection configuration;
- restore a known-good workflow version;
- disable an extension;
- enter Safe Mode.

**Security repairs are never applied by tools.** That covers credentials, network exposure, policy and
worker trust; they are reported as owner actions.

## 7. MCP tools (§30)

All of these tools are policy-gated, and none of them is a raw filesystem or process tool.

| Tool | Tier | Note |
|---|---|---|
| `studio_system_status` | read | also available to Claude Desktop |
| `studio_config_get` / `studio_config_propose` | read / write | propose opens an owner review |
| `studio_evolution_propose` / `_plan` / `_test` / `_diff` / `_history` | write / write / write / read / read | sandbox only; `_history format="changelog"` is generated only from deployed evolutions and commits |
| `studio_evolution_approve` | read | **submits** for owner review and cannot approve |
| `studio_evolution_deploy` | write | owner-approved only; agents LOW/MEDIUM non-protected only |
| `studio_evolution_rollback` | destructive | gateway approval; protected evolutions are owner-only |
| `studio_extension_list` / `_install` / `_update` / `_disable` | read / write / write / write | install and update open owner reviews |
| `studio_extension_enable` | destructive | gateway approval |
| `studio_skill_install` / `_update`, `studio_workflow_register` / `_update`, `studio_provider_register` / `_update` | write | owner reviews; `workflow_update action=pin` is direct and audited |
| `studio_diagnostics_run` / `studio_system_repair` | read / destructive | security repairs are refused |

`studio_evolution_*`, `studio_extension_*`, `studio_skill_*`, `studio_workflow_*`, `studio_provider_*`,
`studio_config_*` and `studio_system_repair` are **protected tools**. "Always allow" and the policy
document can never make them automatic.

The owner endpoints behind the System UI (owner token only) are:

- `/system`
- `/evolutions`, `/evolutions/:id`, `/evolutions/:id/diff`, `/evolutions/:id/decision`,
  `/evolutions/:id/deploy`, `/evolutions/:id/rollback`
- `/config/:doc`
- `/extensions`, `/extensions/install`, `/extensions/:name/enable`, `/extensions/:name/disable`
- `/diagnostics`
- `/repair`
- `/updates`
- `/safe-mode`

## 8. Where things live (`%LOCALAPPDATA%\ModuleXGameStudio`)

```
config.json            versioned configuration documents (every version kept)
extensions/            registry.json, <name>/<version>/…, incoming/<package>/
evolution/             history.json, evo_<id>/{worktree, extension, backup, test-output}
install-state.json     current / previous / last-known-good, boot + update history
audit.jsonl            hash-chained audit log (every evolution transition)
```

Core evolutions need a Studio **source workspace**: `MODULEX_SOURCE_REPO`, a git checkout whose checked-out
branch is the production branch, on developer installs. Without one, core evolutions report **BLOCKED**
honestly, and config and extension evolutions still work.

**Shipping a core evolution to end users.** For installed (non-developer) copies, a deployed core evolution
reaches users as a normal signed release through the update pipeline. The evolution's verified branch is
what gets built and released.

## 9. Acceptance evidence (§27–29, §34)

| Criterion | Evidence |
|---|---|
| Configuration changes without a rebuild | scenario 2 over MCP: the policy is approved and deployed, and the gateway auto-approves `studio_asset_delete` for the ModuleX Agent **live**, while Claude Desktop is still asked |
| Skills updated safely | extension test: 1.0.0 → 1.1.0 → rollback to 1.0.0 |
| Workflows versioned | scenario 1: register 1.0.0, activate 1.1.0, the project stays pinned to 1.0.0 |
| Providers can be added | provider extensions on built-in adapter families (schema-tested) |
| Extensions can be installed | scenario 3, plus blocking of tampered, forbidden, non-commercial, missing-dependency and executable packages |
| Core patches proposed by the ModuleX Agent, run in a sandbox, tested, diffed | core test: a real git worktree, a patch, gates, a diff with counts |
| Owner approval enforced | the agent's approve call throws; a wrong diff hash is refused; changes after approval void it; CRITICAL needs a typed id |
| Backup created, deployment verified | checkpoint tag at the base commit; SUCCESS only after verify |
| A failed deployment rolls back | a health-check failure causes a `git revert` and ROLLED_BACK, and production content is restored |
| Evolution history recorded | `history()` rows and 9 audit event types per core deploy |
| Changelog from real history (§23) | `changelog()` lists the deployed commit subject and the evolution id, plus "(rolled back)" after rollback |
| Safe Mode exists | forced Safe Mode disables non-core extensions and keeps the saved choices |
| Security-sensitive changes stay owner-controlled | the protected-controls test; the policy is CRITICAL; security repairs are refused |
| No change bypasses the audit trail | every transition is audited; the patch guard blocks removal of audit calls |

**Live limits (see `PROGRESS.md`):**

- The workflow test job runs against a fake worker in the tests. A live run needs a TRUSTED ComfyUI worker
  (Phase 7 client).
- The update platform steps are the Tauri updater's (Phase 13).
- The production System screens follow the Phase 3 approval.
