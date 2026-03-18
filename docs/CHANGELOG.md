# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## Atlarix product summary (for model and blueprint accuracy)

- **PIVOT:** From Code to Canvas, Canvas to Code. **Containers** and **Beacons** are the main diagram concepts. The **Blueprint** is the living diagram (RTE + RAG). **RTE** (Round-Trip Engineering): parsers (TypeScript, Python) extract structure; single and **combined blueprints**; diagram types: architecture, dependencies, flows. **RAG:** queryBlueprint, getCodeForNodes; file watcher for incremental updates.
- **Modes:** **Ask** = read-only (code search, web search, read_file, list_files, get_diagram, git_status; no terminal, no code gen/modification). **Build** = full tools (run_command, write_file, delete_file, etc.). Permission flow: user approves before execution.
- **Agents:** Research, Architect, Builder, Reviewer. Delegation: **Guided** (flat) or **Autonomous** (nested, depth limit). Model tiers: **Fast** / **Balanced** / **Thinking** (e.g. OpenRouter favorites); Auto routes by mode/role.
- **Workspace:** `.atlarix/memory.md`, `.atlarix/spec.md`; project instructions; token budget per provider; context bar + auto-summarize.

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
