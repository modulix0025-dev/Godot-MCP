# ModuleX Game Studio: Claude integration

Claude is a **provider and an external operator**, not a second orchestrator. **The ModuleX Agent stays
authoritative** for planning and running the pipeline. Claude reaches the Studio through the same Policy
Gateway, approvals and audit log as every other caller. Being Claude grants nothing extra.

| Mode | What it is | Status |
|---|---|---|
| **A · Anthropic API** | Studio calls the Claude API with the owner's API key | **Implemented** (`studio/core/src/providers/anthropic.ts`) |
| **B · Claude Desktop → Studio MCP** | Claude Desktop is an MCP client of the Studio, through an MCPB extension | **Implemented** (`studio/claude-desktop/`) |
| **C · Local Agent SDK** | Local Claude Agent SDK sessions | **Not offered** (see §4) |

## 1. Mode A: the Anthropic API

**Transport.** The official SDK, `@anthropic-ai/sdk`, calling `client.beta.messages.create`. There are no
raw HTTP shims and no compatibility layers.

**Model.** The default is `claude-opus-5-5`. The catalogue (`shared/src/llm.ts`) lists Opus 5.5, Sonnet 5.5
and Haiku 4.5, and the Settings UI offers only those models.

**Effort.**

- Opus 5.5 supports `low`, `medium`, `high`, `xhigh` and `max`. The default is **`medium`**.
- Settings shows Low / Medium / High / Max as the patch asks. Each value is filtered by
  `effortChoices(model)`, so a model never shows an unsupported value.
- `validateModelSettings()` runs **before** a request is sent. An invalid combination returns
  `PROVIDER_BAD_REQUEST` without any network call.

**Thinking.** Opus 5.5 always uses adaptive thinking, so the Studio sends no `thinking` parameter and
shows no on/off switch. Effort is the only depth control.

**Refusal fallback.** By default the request carries `fallbacks: "default"` under the beta
`server-side-fallback-2026-07-01`. Settings can turn it off.

**API key.**

- It lives in **Windows Credential Manager** under `secret://llm/anthropic`, and the provider resolves it
  through Core's `SecretVault`.
- The resolved value is registered with the redactor immediately, so it can never appear in a result, an
  error, a log line or an audit row.
- If the key is missing, the result is `PROVIDER_AUTH`, with the next step "Add an API key in Settings →
  AI Providers → Claude API".

**Structured errors.** The SDK's typed exceptions map to Studio errors:

| SDK error | Studio code | Retryable |
|---|---|---|
| `AuthenticationError`, `PermissionDeniedError` | `PROVIDER_AUTH` | no |
| `NotFoundError` | `PROVIDER_MODEL_UNAVAILABLE` | no |
| `BadRequestError` | `PROVIDER_BAD_REQUEST` | no |
| `RateLimitError` | `PROVIDER_RATE_LIMIT` | yes |
| `APIConnectionTimeoutError` | `PROVIDER_TIMEOUT` | yes |
| `APIConnectionError` | `PROVIDER_UNAVAILABLE` | yes |
| any other `APIError` (such as 529) | `PROVIDER_UNAVAILABLE` | yes for status ≥ 500, otherwise no |
| `stop_reason: "refusal"` | `PROVIDER_REFUSAL` | no |

**Audit.** Each call writes `claude_provider_call`, which records the model, effort and token usage, and
never the prompt or the key. Failures write `claude_provider_error`.

**Tests.** `core/tests/provider.test.ts` covers, against a mock `fetch`:

- the success path;
- 401, 404, 400, 429, 529 and timeout;
- a refusal;
- a missing key;
- the request body: no `thinking`, effort present, fallback beta present;
- the key never appearing in results or audit.

**Routing.** `RoutingSchema` / `routeFor()` choose a provider, model and effort for each purpose: Primary,
Planning, QA, Fast and Fallback. An unset purpose falls back to Primary.

## 2. Mode B: Claude Desktop as an MCP client

```
Claude Desktop ──stdio──▶ ModuleX extension (MCPB bridge) ──HTTP, loopback──▶ Studio Core /mcp ──▶ Policy Gateway
                          user_config: core_url, pairing_token (sensitive)          caller = claude-desktop
```

**The extension.** It is built as `studio/claude-desktop/dist/modulex-game-studio.mcpb` by `npm run build`,
which runs:

1. `tsc`;
2. an esbuild bundle;
3. `scripts/build-manifest.mjs`;
4. `mcpb validate`;
5. `mcpb pack`.

CI uploads the `.mcpb` as an artifact.

**The manifest.** It uses manifest version 0.3 and is **generated** from `advertisedTools('claude-desktop')`,
so it can never list a tool the gateway would refuse. It has two `user_config` fields:

- `pairing_token`, marked `sensitive: true`, so Claude Desktop keeps it in the OS keychain;
- `core_url`, defaulting to `http://127.0.0.1:47821`.

**The bridge.** `src/bridge.ts` is a plain forwarder.

- It lists and calls tools on Core `/mcp` with the pairing token and has no logic of its own.
- It refuses a non-loopback `core_url`.
- If Core is down, it returns `STUDIO_UNAVAILABLE` and reconnects on the next call.

**The tools Claude Desktop sees.** 17 are live:

- `studio_ping`;
- `studio_project_list`, `studio_project_status`;
- `studio_game_create`;
- `studio_game_spec_get`, `studio_scene_manifest_get`, `studio_asset_manifest_get`,
  `studio_test_manifest_get`, `studio_task_graph_get`;
- `studio_pipeline_status`;
- `studio_asset_status`, `studio_asset_delete` (**destructive: always needs owner approval**);
- `studio_build_status`;
- `studio_worker_status`;
- `studio_approval_list`;
- `studio_approval_action` (**withdraw only**);
- `studio_system_status` (read-only versions and System summary, Execution Patch 2).

Claude Desktop gets **none** of the System Evolution, extension, config or repair tools (D-038).

Three more are declared for Claude Desktop and appear automatically once they are implemented:
`studio_asset_generate`, `studio_test_run`, and `studio_build` / `studio_export`.

**What Claude Desktop never sees:**

- raw Godot-MCP tools, even in Developer Mode;
- `reflection-*`;
- critical tools;
- secrets and worker URLs.

**Model-aware descriptions.** Every tool description ends with its authorization class ("Authorization:
…"), "Destructive: yes/no" and the structured-error contract. So Claude knows ahead of time which calls
will pause for the owner, and what `PENDING_APPROVAL`, `BLOCKED` and `NEEDS_HUMAN` mean.

**Interactive approvals.** A destructive call returns `PENDING_APPROVAL` with an `approval_id` and the
impact (What / Why / Scope / Files / Risk / Rollback). The owner decides **in the Studio**. Claude re-calls
the tool with the `approval_id` and the same arguments. The approval is single-use, and a forged id or
changed arguments are refused.

**Pairing (Settings → AI Providers → Claude Desktop).**

1. **Install Claude Desktop Extension.** This opens the `.mcpb`, and Claude Desktop shows its own install
   dialog.
2. **Copy pairing token.** The owner pastes it into the extension's settings. The token is stored in
   Windows Credential Manager on the Studio side and stays stable across launches.
3. **Verify connection** runs the **MCP health test**, `POST /claude-desktop/health-test`, which does list
   tools → `studio_ping` → `studio_project_status`. The result is written to Activity as
   `claude_health_test`.
4. The UI states are **Not Connected**, **Connected**, **Unavailable** and **Permission Required**.

**Deep-link handoff.** "Open in Claude Desktop" offers Continue task, Review failure, Review build and
Review QA report. It uses the documented link `claude://claude.ai/new?q=<url-encoded prompt>` (Claude Help
Center, "Open Claude Desktop with a link"). The prompt:

- is pre-filled but **not sent**: the user reviews it and sends it;
- is built from the project's structured status and marked as data, not instructions;
- is capped at 13,500 characters (Claude's limit is about 14,000), trimming the context first;
- is refused if any secret is detected in it.

**Audit.** Claude Desktop activity is logged as `claude_tool_call`, `claude_approval_requested`,
`claude_approval_granted`, `claude_approval_rejected` and `claude_health_test`.

`claude_desktop_connected`, `claude_desktop_disconnected` and `claude_session_opened` are declared in the
event catalogue, but nothing emits them yet. They arrive with the production Settings screen (pairing and
disconnect) and the handoff button (Phase 13).

## 3. What the Studio never does

The Studio never interacts with Claude Desktop's own authenticated session. There is:

- no cookie extraction;
- no credential scraping;
- no reading of browser or app databases;
- no calls to private or internal endpoints;
- no fake desktop-client headers;
- no token replay;
- no browser automation used as a hidden API transport;
- no working around subscription limits.

If a capability is not available through the public API, the MCPB extension or the documented deep link,
the Studio uses Mode A (the API) instead.

## 4. Why Mode C (the local Agent SDK) is not offered

The Claude Agent SDK documentation says:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or
> rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key
> authentication methods described in this document instead."
> — code.claude.com/docs/en/agent-sdk/overview

- A subscription-login Agent SDK mode is therefore **not permitted** for ModuleX Game Studio.
- An API-key Agent SDK mode would bill exactly like Mode A. It would also bring its own file and shell
  tools, which work **outside** the Studio's Policy Gateway.
- The Settings card shows **Local Agent SDK: Unavailable**, with this reason and a "Use Claude API
  instead" action.

This is recorded as D-025.

## 5. Health cluster

The top bar's **Claude** dot summarises:

- the last Mode A call or test (ok, auth error or unavailable);
- the Claude Desktop pairing and the last health test.

The tooltip shows both, and the dot never shows a secret.
