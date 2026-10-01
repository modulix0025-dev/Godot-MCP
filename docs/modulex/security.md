# ModuleX Game Studio: security model

This document covers how the Studio controls tools, secrets, approvals, workers and external AI clients.
It describes the **code as built**. Where a control is only a contract so far, or has not been built, it
says so.

Sources of truth:

- `studio/shared/src/policy.ts`: the tool catalogue and `decide()`;
- `studio/core/src/gateway/`: enforcement, approvals and audit;
- `studio/core/src/audit/`: redaction and the hash-chained log;
- `studio/shared/src/workers.ts`: worker trust;
- `studio/app/src-tauri/src/credentials.rs`: the OS credential store.

## 1. Two tool layers

| Layer | Tools | Who sees them |
|---|---|---|
| **A · Agent-safe** (default) | `studio_*`: 63 declared, **42 live** (24 are System Evolution tools) | The ModuleX Agent (by role), Claude Desktop (a 17-tool subset) and the owner UI |
| **B · Raw Godot-MCP** | 54 ids (`node-*`, `scene-*`, `script-*`, `resource-*`, `reflection-*`, `game-*`, …) | Studio Core internally. The ModuleX Agent sees them **only in Developer Mode**. Claude Desktop **never** sees them. |

Agents never receive the Godot-MCP server URL or token. Every raw call goes through Core's gateway.

Addon-side tool hiding is not enforcement. D-010 verified that a hidden tool still executes when it is
called directly. So the **Policy Gateway is the only enforcement point**, and hiding is defence in depth.

### Tiers and the decision

`decide(tool, ctx)` returns `allow`, `ask` (approval) or `deny` with a structured error.

| Tier | ModuleX Agent | Claude Desktop | Owner UI |
|---|---|---|---|
| read | allow (role-scoped) | allow (its subset) | allow |
| write | allow if the role owns it | only the subset (currently `studio_game_create`) | allow |
| cost | ask above the threshold ($0.25 default) or when the cost is unknown | ask | allow |
| destructive | **ask** (unless the owner chose "always allow for this project", or the live policy auto-approves it) | **ask, always.** "Always allow" and policy auto-approval never apply (enforced in `decide`). | allow |
| critical (`studio_policy_change`, `studio_secret_set`, `studio_worker_register`, `studio_project_delete`) | **deny** | **deny** | ask (a confirmation) |
| raw layer | **deny** unless Developer Mode `raw-tools` is on; destructive raw tools still ask | **deny, always** | — |
| `reflection-method-call` | **deny** unless Developer Mode `reflection` is on; then **ask on every call** | **deny, always** | — |

Tests: `studio/shared/tests/policy.test.ts` and `studio/core/tests/security.test.ts`.

## 2. Developer Mode

- It is **off by default** and resets when Core restarts. It is not persisted.
- Only the owner UI session can change it, through `POST /dev-mode` with the owner token. Turning it on
  requires `confirmed: true`, which the UI sends only after a confirmation dialog. There are two
  capabilities: `raw-tools` and `reflection`.
- Every change is audited: `developer_mode_enabled`, `developer_mode_disabled` and
  `developer_capability_granted`.
- The status is always visible as the "Dev mode · off/on" pill in the top bar.
- Even in Developer Mode, raw calls are still policy-checked and approval-gated when destructive, and
  every call is logged.

## 3. Approvals

An `ask` decision creates an approval with a structured **impact**:

- What, Why and Scope;
- the Files affected;
- the Risk;
- the Rollback.

Approvals expire after 30 minutes and are **single-use**. The agent re-calls the tool with `approval_id`
and **identical arguments**. Any other arguments are refused.

- **Only the owner UI can approve or reject.** An agent that calls `resolveApproval` gets
  `APPROVAL_NOT_OWNER`, and so does Claude Desktop through `studio_approval_action`. An agent can only
  **withdraw** its own request.
- "Always allow for this project" is an owner choice. The UI never offers it for Claude Desktop requests.

## 4. Secrets

**Where secrets live.** Long-lived secrets live in **Windows Credential Manager** (DPAPI, per user):

- the Claude API key (`secret://llm/anthropic`);
- the ModuleX Agent token;
- the Claude Desktop pairing token;
- worker credentials (`secret_ref`).

The shell bridge is `credentials.rs`, using the `keyring` crate's native Windows backend.

**Status.**

- The shell stores and restores the agent and pairing tokens.
- Core stores and resolves other secrets at runtime through the **vault bridge** (D-056): `vault-request` /
  `vault-response` lines over the sidecar's private stdio. Build worker tokens use it today.
- The installed self-test proves a store, read-back and delete round-trip in Credential Manager on every Windows
  CI run.
- The UI flows that write the Claude API key arrive with the production Settings screens.
- **Core's log** (`%LOCALAPPDATA%\com.modulex.gamestudio\logs\core.log`, D-062) holds only Core's stderr and the
  shell's startup errors. Tokens never go there: the handshake travels on stdout and vault traffic on stdin/stdout.

**Code signing (Phase 13, D-057).** The Authenticode certificate is the owner's.

- It lives only in the repository's GitHub Actions secrets: `WINDOWS_SIGNING_PFX_BASE64`, the base64 of the
  `.pfx`, and `WINDOWS_SIGNING_PFX_PASSWORD`.
- CI decodes it into the runner's temp directory for the build only.
- It is never committed, logged or bundled.

Without the secret the installers are built **unsigned**, and CI says so. Windows SmartScreen then warns on first
run ("Windows protected your PC" → *More info* → *Run anyway*). A signed build accumulates SmartScreen reputation
under the certificate.

To enable signing, the owner runs `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))` locally and
adds both secrets in *Settings → Secrets and variables → Actions*.

**Where secrets never go:** SQLite, the JSON store, logs, audit events, prompts, git, project files,
screenshots, handoff links or tool results.

**Redaction.** The `Redactor` is fed every known secret value (the tokens and resolved keys). It also has
patterns for `sk-ant-…`, `Bearer …` and `key=value` pairs. It runs on every audit entry and every error
that crosses a boundary. The Claude handoff builder **refuses** to build a link that still contains
secret material.

**Identifiers vs secrets.** `worker_id=remote-gpu-01` is fine to show. `worker_token=…` never appears.
`publicWorkerView()` strips the URL and the secret reference.

**What the ModuleX Agent never receives:**

- the Godot-MCP credentials or the raw server token;
- ComfyUI credentials;
- Apple signing material;
- private worker credentials.

It gets only its own Studio token and the tool results.

## 5. Callers and transport

Core listens on **127.0.0.1 only**. The default port is 47821, falling back to a random port. Each caller
class has its own bearer token, compared in constant time:

| Principal | Token | Surface |
|---|---|---|
| owner UI | per-launch session token, known only to the shell | owner endpoints: `/approvals`, `/dev-mode`, `/audit`, `/audit/verify`, `/claude-desktop/health-test`. It is refused on `/mcp` (403). |
| ModuleX Agent | stable agent token (Credential Manager) | `/mcp` as `modulex-agent` |
| Claude Desktop | stable pairing token (Credential Manager on our side, Claude Desktop's own keychain on its side via `sensitive` user_config) | `/mcp` as `claude-desktop` |

The Claude Desktop bridge refuses any `core_url` that is not loopback.

## 6. Untrusted content

Everything an agent reads that came from outside the Studio's own logic is wrapped in
`untrusted(data, source)`. That includes game specs, manifests, owner text, asset names and worker output.
`injectionSignals()` flags phrases such as "ignore previous instructions" (including the Arabic "تجاهل")
and audits them as `untrusted_content_flagged`. It **flags only**. It never silently drops content, and it
never grants anything.

## 7. Audit

`AuditLog` is append-only. Every entry is redacted before it is hashed, and each one carries
`prev_hash`/`hash` (SHA-256), so any edit breaks the chain. `GET /audit/verify` returns the first broken
index, or `null`. Events are listed in `shared/src/audit-events.ts`; they include every tool decision and
approval transition, Developer Mode changes, worker trust changes, provenance blocks, and all `claude_*`
events.

## 8. ComfyUI workers

The trust levels are TRUSTED, DEGRADED, UNTRUSTED, QUARANTINED and OFFLINE.

- **Onboarding** runs in order: register → connectivity → auth → capabilities → version → health → test
  generation → output validation → trust decision. Registering a worker (`studio_worker_register`) is
  **critical**, so only the owner can do it. `onboardingDecision()` returns TRUSTED only when every step
  passed and the transport is acceptable. Otherwise it returns UNTRUSTED, or OFFLINE if connectivity
  failed.
- **Production jobs run only on TRUSTED workers.**
- **Quarantine.** An auth anomaly or an unexpected response type quarantines a worker immediately. Other
  anomalies quarantine it at 3. A health check never lifts QUARANTINED; only the owner can.
- **Transport.** A worker must be loopback, behind an authenticating HTTPS proxy, on Tailscale or
  WireGuard, on an SSH tunnel, on a private network, or behind a zero-trust tunnel. Plain `http://` to a
  public host is refused (`transportProblem`). **Never expose an unauthenticated ComfyUI to the internet.**

## 9. Claude

- Claude Desktop is an **MCP client of the Studio**, with the same gateway, subset and approvals.
  **Being Claude grants nothing extra.**
- The Studio never touches Claude Desktop's session. It does not extract cookies, scrape credentials,
  read browser databases, call private endpoints, fake client headers, replay tokens or work around
  subscription limits.
- The only Claude transports are:
  - the official Anthropic API, through `@anthropic-ai/sdk` and the owner's API key;
  - the official MCPB extension that the owner installs in Claude Desktop;
  - the documented `claude://` deep link.

See [`claude-integration.md`](claude-integration.md).

## 10. System Evolution (Execution Patch 2)

The Studio can change itself, but only through [System Evolution](system-evolution.md):

- a sandbox first;
- tests by risk;
- the exact diff shown to the owner;
- approval bound to the diff hash, which only the owner UI can give;
- a checkpoint;
- a health check with automatic revert;
- an audit event for every transition.

**Protected controls** are the policy gateway, approvals, audit, credentials, auth and network exposure,
worker authentication, the sandbox, backup and rollback, the updater, the evolution engine, the schema and
signing. A change that touches one is CRITICAL. It needs a typed confirmation, and only the owner can deploy
or roll it back.

A **patch guard** blocks any diff that:

- deletes or skips tests;
- removes audit calls;
- hard-codes a credential;
- binds `0.0.0.0`.

The evolution, extension, config and repair tools are **protected tools**. Neither "always allow" nor the
policy document can make them automatic. Security repairs are never applied by a tool.

Extensions are declarative. Forbidden permissions (`secrets:read`, `fs:outside-project`, `policy:modify`,
`process:execute`) make a manifest invalid, and HIGH permissions are granted only when the owner ticks them.

## 11. Test coverage (Patch 1 §45)

| Requirement | Test |
|---|---|
| Claude Desktop cannot see or call raw tools, reflection or critical tools | `core/tests/security.test.ts`, `claude-desktop/tests/extension.test.ts` |
| An agent cannot approve its own request; a replay with changed arguments is refused; approvals are single-use | `core/tests/security.test.ts` |
| Developer Mode needs the owner and a confirmation, and is audited | `core/tests/security.test.ts`, `core/tests/server.test.ts` |
| Secrets are redacted from audit, errors and handoff; the audit chain detects tampering | `core/tests/security.test.ts`, `core/tests/handoff.test.ts` |
| Tokens are per principal; the owner token is refused on `/mcp` | `core/tests/server.test.ts` |
| An unknown or non-commercial licence is BLOCKED | `shared/tests/contracts.test.ts` |
| Worker quarantine, the owner-only release and public-URL refusal | `shared/tests/contracts.test.ts` |
| Untrusted content is flagged, not obeyed | `shared/tests/contracts.test.ts`, `core/tests/security.test.ts` |
