## v6.0.3 — Main Vite `?raw` SQL for embedded migrations (2026-04-02)

- **Build / SQLite:** [`vite.main.config.mts`](../vite.main.config.mts) — `assetsInclude: ["**/*.sql"]` and a **`raw-sql`** plugin (`enforce: "pre"`) with `load()` that reads `pathOnly` from `*.sql?raw` ids via `fs.readFileSync` and emits `export default …`. Ensures [`bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) Drizzle `?raw` imports embed migration SQL in the main bundle (avoids empty strings on Linux fresh builds and related `no such table` failures).

---

## v6.0.2 — Workforce workspace UI, FallbackModel doGenerate (2026-04-02)

- **Workforce / workspaces:** [`AppList.tsx`](../src/components/AppList.tsx) `canAddWorkspace` now respects `status.canCreateWorkspace` and treats **Workforce** like Pro for the add/import affordance (previously only `plan === 'pro'` was unlimited; Workforce users were incorrectly limited to one workspace in the UI).
- **Diagrams / Auto:** [`FallbackModel`](../src/ipc/utils/fallback_ai_model.ts) implements `doGenerate` by delegating to the current chain model inside the existing `retry` helper, matching `doStream` semantics. Fixes AI diagram generation when Auto wraps models in `createFallback` (`generateText` → `doGenerate`).

---

## v6.0.1 — Reasoning stream closure, thinking-tag hygiene, agent docs (2026-04-02)

- **Streaming (`processStreamChunks`):** Treat `reasoning-end` like other non-reasoning parts so an open stream thinking wrapper is closed; after the stream iterator, flush the matching closing tag if still inside a reasoning block and run a final `processResponseChunkUpdate` + `cleanFullResponse`.
- **Tags / dedupe:** `removeThinkingTags` moved to [`src/ipc/utils/thinking_tags.ts`](../src/ipc/utils/thinking_tags.ts) (strip long- and short-form thinking wrappers). [`cleanFullResponse.ts`](../src/ipc/utils/cleanFullResponse.ts) `deduplicateContent` finds the earliest recognized thinking closing tag after duplicated model output.
- **Tokens:** `getMaxTokensWithFloor` in [`token_utils.ts`](../src/ipc/utils/token_utils.ts) (8192 floor when catalog omits `maxOutputTokens`); main `streamText` uses it for `maxOutputTokens`.
- **Prompt bundle:** `AGENTS.md`, `AGENTS_COMPACT.md` — identity, modes, Compass, delegation, Workforce session scope, 6.0.x version line.

---

## v6.0.0 — Workforce session scope, autonomous agents, UX hardening, Thoughts & routing (2026-04-02)

- **Workforce — Change 1 / 2:** Removed stored “base of origin” / default group-repo-workspace pre-selection for Workforce services; selections are **in-memory per chat** (`workforce-chat-session`, IPC `workforce:session:*`, `WorkforceSessionPromptDialog`). First tool use can prompt for scope; **New Chat** clears session. `buildWorkforceWorkspaceContextBlock` and stream handlers append **Connected workspace contexts (this session only)** to the Workforce prompt block. Token Vault OAuth unchanged.
- **Workforce — gate:** `ToolRegistry` / `runToolExecuteWithWorkforceSessionGate` block Workforce tools until session scope is set where required (`// Fix: Workforce-Change-N` trace comments in touched files).
- **Autonomous — Change 3:** Nested autonomous sub-agents auto-execute permissioned tools (no user queue); `logger.info('[Autonomous] Tool executed without user approval: …')`. Guided delegation permission flow unchanged. Delegation summaries append autonomous tool footers where applicable.
- **Onboarding — Change 4:** Extra steps for chat continuity, right panel resize, autonomous expectations, and session-only Workforce context (`onboarding.ts`, home/settings UI).
- **Tester findings (pre-6.0 pass):** Fullscreen IPC + `data-fullscreen` / layout CSS; pinned New Chat + workforce session clear; code route `file`/`tab` params; Ask/Plan prompts and tool gating (`write_file` Plan-only paths, blueprint tool Ask rules); streaming `chat:stream:phase`, `chat:tool:start/end`, human labels; `models.dev` 30s timeout + Sentry + `models-dev:status` IPC; Compass strip in header + inline milestone banner; `RightPanel` resize grip.
- **UI:** `ThoughtsPanel` from `activityStreamItemsAtom` (guided/autonomous); `ActivityDisplay` wiring; removed legacy `ActivityStream` / `GuidedPipeline` / `AutonomousGraph`; `AppLoadingScreen` + `atlarix-home` loading use `AtlarixAnimation`; canvas `setTransform` reset before `scale`.
- **Auto router:** `runAutoRouterAsync` + optional Stage-2 `classifyAutoRouteWithFastLLM` via `getFastModelForCurrentProvider` in `chat_stream_handlers.ts`; `RoutingDecision.recommendedAgent`; `routing_decision` activity label may include `delegate: …`.
- **Blueprint:** `BlueprintCanvas` overlay controls moved outside ReactFlow `<Panel>` to fix misaligned hit targets on **Re-layout** / **Add container** (and related overlays).
- **Hygiene:** Fixed invalid escaped quotes in `classifyAutoRouteWithFastLLM` (esbuild parse error).

---

## v5.2.3 — Linux launch, OAuth, and local-model reliability (2026-04-01)

- **Linux packaging:** Disabled Chromium sandboxing for packaged Linux builds in `forge.config.ts` and added `x-scheme-handler/atlarix` registration parity for both `.deb` and `.rpm` makers to reduce launch failures and improve deep-link install behavior.
- **OAuth / deep links:** Tightened Linux deep-link handling in `src/main.ts` so `atlarix://auth/callback` can be processed reliably both when an existing app instance receives the callback and when the app is cold-started from the protocol URL.
- **PATH / local models:** Centralized PATH refresh into `src/lib/resolve-path.ts`, reused it from startup and `reload-env-path`, and now show non-blocking warnings when Ollama or LM Studio are unreachable instead of relying on console-only failure paths.

---

## v5.2.2 — Rename reserved `type` columns in SQLite graph tables (2026-04-01)

- **SQLite / PIVOT:** Added migration `0033_rename_type_columns.sql` to rename `pivot_nodes.type` -> `node_type`, `pivot_edges.type` -> `edge_type`, and `diagrams.type` -> `diagram_type`. This fixes production crashes in packaged builds when SQLite prepares queries against those graph/diagram tables (`no such column: "type"` on `/diagram` -> `/tools` flows).
- **Drizzle ORM:** Updated `src/db/schema.ts` and the affected persistence/query code to use `nodeType`, `edgeType`, and `diagramType`, while keeping renderer IPC responses normalized to `diagram.type` for UI compatibility.

---

## v5.2.1 — Supabase OAuth browser-open fallback (2026-03-31)

- **Auth:** `src/lib/auth/supabase-client.ts` now wraps `shell.openExternal()` for Supabase OAuth in a nested `try/catch`, logs success/failure explicitly, and on **Linux** shows a fallback dialog with the OAuth URL plus **Copy Link** when the browser cannot be opened automatically. This avoids silent sign-in failure while leaving the existing `atlarix://auth/callback` deep-link handling unchanged.

---

## v5.2.0 — Embedded SQLite migrations (2026-03-31)

- **SQLite:** Replaced filesystem `drizzle/` + Drizzle `migrate()` with **embedded SQL** in the main bundle (Vite `?raw`, [`src/db/migrations/bundled.generated.ts`](../src/db/migrations/bundled.generated.ts) generated by `npm run db:bundle-sql` / `postdb:generate`). New ledger **`__atlarix_migrations`**; legacy **`__drizzle_migrations`** rows are **bridged** by SHA-256 hash map. **Unknown hashes:** `logger.error` + **Sentry** + thrown `UnknownDrizzleMigrationHashError` (no silent swallow); DB wipe retry is **skipped** for that error. Packaged apps no longer need `drizzle` in Forge `extraResource`; `drizzle/` is excluded from the asar via [`forge.config.ts`](../forge.config.ts) ignore (SQL still lives in repo for Drizzle Kit).
- **Drizzle ORM:** Unchanged for schema types and queries (`schema.ts` untouched).

---

## v5.1.5 — Move ensure* safety nets after migrate() (2026-03-31)

- **Fix:** Moved all `ensure*` table-bootstrap calls (mcp_servers, blueprints, pivot tables, etc.) to run **after** `migrate()` instead of before. On a fresh DB (e.g. after auto-recovery deletes the corrupt one), `ensure*` would create tables like `mcp_servers`, then `migrate()` would fail with `CREATE TABLE mcp_servers` (no `IF NOT EXISTS` in migration SQL). Now `migrate()` runs first on a clean slate, and `ensure*` only fills gaps for legacy DBs afterward.

---

## v5.1.4 — SQLite auto-recovery on bad local DB (2026-03-31)

- **SQLite:** After `migrate()`, the app verifies core tables (`apps`, `chats`, `messages`, `language_model_providers`, `language_models`, `prompts`) and, when bundled migrations are available, that `__drizzle_migrations` exists with at least one row. If validation fails, it closes the DB, deletes `sqlite.db` plus `-wal`/`-shm`, and retries initialization **once** (only when a `drizzle/` folder is found on disk—no infinite wipe if migrations are missing). Fixes partial “bootstrap-only” DBs (e.g. ensure* tables without `chats`). The renderer stays on the existing loading gate until init succeeds.
- **Hygiene:** Removed temporary debug ingest `fetch` calls from `src/db/index.ts`.

---

## v5.1.3 — Packaged app: Drizzle migrations path (2026-03-30)

- **Production:** `drizzle/` is bundled via Electron Forge `extraResource` (unpacked under `Resources/drizzle`) so SQLite migrations are always on a real filesystem path.
- **Runtime:** `resolveDrizzleMigrationsCandidateFolders()` tries `process.cwd()`, `process.resourcesPath`, `app.getAppPath()`, then `__dirname`-relative paths; logs each candidate’s existence and the folder used. Fixes packaged builds where `migrate()` never ran (`no such table: chats`, `language_model_providers`, etc.) while `npm start` worked.

---

## v5.1.2 — Verified Drizzle journal seed + maintainer docs (2026-03-30)

- **SQLite:** `seedDrizzleMigrationsIfNeeded` now inserts `__drizzle_migrations` rows only while each journal migration’s effects are detectable in the DB; `migrate()` applies genuinely pending SQL. Prevents “empty journal + partial schema” installs from skipping migrations and breaking features (`chats`, MCP, etc.). Verifiers live in [`src/db/migration_seed_verification.ts`](../src/db/migration_seed_verification.ts).
- **Docs:** README Development Setup documents the requirement to update `migration_seed_verification.ts` whenever `_journal.json` gains a migration.

---

## v5.1.1 — SQLite MCP tables bootstrap (2026-03-30)

- **SQLite:** `ensureMcpBaseTablesIfNeeded()` creates `mcp_servers` and `mcp_tool_consents` when missing (migration 0012 baseline). Fixes `mcp:list-servers` → `no such table: mcp_servers` when `__drizzle_migrations` was seeded so Drizzle skipped applying migration 0012.

---

## v5.1.0 – Compass, usage limits, onboarding (2026-03-29)

- **Compass:** Managed cloud provider (OpenRouter-backed, single build-time key). Default model **Compass Fast**; Pro/Workforce unlock Balanced and Thinking. OpenRouter removed from user-facing settings and model labels.
- **Supabase:** `compass_tokens` + `get_compass_usage_state` / `record_compass_usage` for monthly token accounting (30-day reset). See `docs/compass-limits.md`.
- **Settings:** Collapsible model-provider grid with search and pagination (Compass pinned on page 1); Compass card shows tier copy and usage bar.
- **Chat:** Usage strip + exhausted state with upgrade / Settings CTAs; milestone toasts at ~50% / 25% / 10% remaining; usage refetches after Compass turns.
- **Onboarding:** Three post-login product steps (Compass → BYOK in Settings); diagram/workspace funnel steps removed from the default tour.
- **CI:** `COMPASS_*` secrets in `release.yml` and `vite.main.config.mts` `MAIN_KEYS` (main process only).

## v5.0.0 – Blueprint context & memory (2026-03-26)

- **Tiered Blueprint prompt injection (Sections 1, 3, 4):** Blueprint context is now routed through `blueprintPromptTiers.ts` with explicit Ask / Plan / Build / Debug tiers. Settings and the chat Config dropdown can force a tier per session, and Auto mode falls back to heuristics based on work mode and prompt.
- **Project memory & snapshots (Section 2):** New `project_snapshots` and `project_memory` tables (migration `0031_project_memory.sql`) plus `ensureProjectMemoryTablesIfNeeded` in `db/index.ts`. Snapshots track blueprint + plan state across sessions; tools (`get_project_history`, `set_project_memory`, `revert_to_snapshot`) expose this to the AI with an approval-gated `revert_project_snapshot` action.
- **`.atlarixignore` end‑to‑end:** Gitignore-style patterns are respected in RTE parsing, Blueprint cache loading, and prompt assembly. A default `.atlarixignore` is created on first parse; `get_atlarixignore` / `update_atlarixignore` tools and the Blueprint panel editor keep AI context bounded to relevant files.
- **Work modes + Auto routing:** Ask / Plan / Build / Debug / Review work modes now bind cleanly to Blueprint tiers and model routing. Auto decides between Fast / Balanced / Thinking based on mode/role, while manual mode selection and overrides still work as before.
- **MCP server tier gating:** MCP free-tier limits now respect the authenticated subscription (via `SubscriptionManager.isPro()` and `useAuth().status.plan`) instead of raw credit budget, so Pro/Workforce users can add multiple MCP servers without seeing the “Free tier is limited to 1 MCP server” banner.
- **Auto model configuration UX:** Auto mode lets you pick one provider and up to three models (Fast / Balanced / Thinking). The Config dropdown seeds tiers from provider favorites, supports 1–3 configured tiers, and uses an ordered fallback chain when a model fails.

---

For detailed historical notes (v1.x–v4.x) and implementation phases, see [`docs/previous-versions.md`](previous-versions.md) and the v5.0 tables in [`docs/TODO.md`](TODO.md).

# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## Atlarix product summary (for model and blueprint accuracy)

- **PIVOT:** From Code to Canvas, Canvas to Code. **Containers** and **Beacons** are the main diagram concepts. The **Blueprint** is the living diagram (RTE + RAG). **RTE** (Round-Trip Engineering): parsers (TypeScript, Python) extract structure; single and **combined blueprints**; diagram types: architecture, dependencies, flows. **RAG:** queryBlueprint, getCodeForNodes; file watcher for incremental updates.
- **Modes:** **Ask** = read-only (code search, web search, read_file, list_files, get_diagram, git_status; no terminal, no code gen/modification). **Build** = full tools (run_command, write_file, delete_file, etc.). Permission flow: user approves before execution.
- **Agents:** Research, Architect, Builder, Reviewer. Delegation: **Guided** (flat) or **Autonomous** (nested, depth limit). Model tiers: **Fast** / **Balanced** / **Thinking** (e.g. OpenRouter favorites); Auto routes by mode/role.
- **Workspace:** `.atlarix/memory.md`, `.atlarix/spec.md`; project instructions; token budget per provider; context bar + auto-summarize.

---

## v4.3.0 — UX and workflow update (2026-03-23)

### Added

- **Batch workforce permissions:** New `request_workspace_permissions(services[])` flow opens one unified Token Auth panel for multi-service access.
- **Ollama recommender panel:** Hardware-aware model recommendations with one-click pull and quick model selection in provider settings.

### Changed

- **Workforce Ask/Build behavior:** Ask mode is strictly read-only for Workforce tools; write/trigger actions are Build-only with approval.
- **Ask-mode planning:** ATLARIX plan-writing tools are available in Ask mode with approval, while code changes remain Build-only.
- **Release docs and metadata:** README/TODO/changelog/version metadata aligned to the 4.3 release.

### Fixed

- **Session persistence:** Secure auth session restore and refresh on startup, plus explicit logout secret clearing.
- **Subscription UX:** Correct active vs cancelled-within-period vs expired messaging and entitlement timing.
- **Token Auth lifecycle:** New chat clears prior Token Auth sessions and exposes connected-service indicators in chat UI.

---

## v4.2.0 — Bug fixes and security (2026-03-18)

### Improvements

- **Easier onboarding**: Sign-in and “Skip” buttons are now fully visible and no longer hidden under the window controls, so you can get started without any hassle.
- **More secure and stable**: The app now uses a simpler, more secure sign-in flow and has removed legacy backend pieces for a more reliable experience.
- **Under the hood**: Updated integrations and stability improvements across the app for better compatibility.

---

## v4.0.0 — Workforce (2026-03-16)

### Added

- **Workforce tier** ($79/mo): Up to 20 seats; extra seats $10/mo. Teams, Token Vault, Workspace Context, and all Workforce extensions.
- **Auth0 Token Vault**: Secure agent authentication; step-up for high-stakes actions; fallback to stored credentials when vault unavailable.
- **Workspace Context** (Workforce only): Injected block after system prompt with open PRs, failing pipelines, assigned tickets, unread mentions, Sentry errors, today's meetings from connected extensions.
- **Teams**: Create team, invite members, manage seats; shared .atlarix (team-memory.md, Blueprint) via Git; effective tier = max(own plan, team plan).
- **Workforce extensions**: Slack, Google Chat, Jira, Linear, Sentry, Notion, Google Calendar, GitLab CI, Bitbucket Pipelines — connect via Token Vault.
- **Progressive Tool Reveal**: Tool manifest (one line per tool) in system prompt; full schemas loaded on first use; core tools always loaded.
- **New AI tools**: get_slack_mentions, get_slack_channel, post_to_slack; get_assigned_tickets, update_ticket_status, create_ticket, get_sprint_status; get_sentry_errors, get_sentry_error_detail; get_today_schedule; trigger_pipeline, cancel_pipeline. Read-only in Ask mode; write/trigger with approval in Build.
- **GitLab CI & Bitbucket Pipelines**: CIPlatform implementations using Token Vault; list runs, jobs, logs, stream.
- **File revert**: "Revert to here" on an assistant message restores workspace file state from the snapshot taken at that exchange.

### Changed

- **DB Studio** moved from Pro to Workforce; existing Pro subscribers grandfathered (has_db_studio_legacy).
- **Pricing**: Three tiers — Free ($0), Pro ($19/mo), Workforce ($79/mo).
- **Build mode tools**: Manifest includes all tools; progressive reveal filters full schemas to loaded + core.

### Technical

- Drizzle migrations: teams, team_members, users.team_id, users.effective_tier, users.has_db_studio_legacy; workforce_connected_services; tool_session_loads.
- Supabase migrations and RLS for teams.
- LemonSqueezy webhook extended for Workforce and teams (idempotent).
