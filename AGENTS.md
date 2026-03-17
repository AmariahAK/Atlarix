# Atlarix Agent Instructions

This file is used by the AI to understand available tools and behavior. Tool count and capabilities are updated per release.

## Tool Discovery System (v4.0)

- **Progressive reveal:** The system prompt includes a compact **manifest** (one line per tool). Full parameter schemas are provided only for tools that have been **loaded** in this session (first use) plus **core** tools, which are always loaded.
- **Core tools** (always fully specified): `read_file`, `write_file`, `run_command`, `search_code`, `get_file_tree`.
- **Call by name:** To use any tool, call it by name; when the model invokes a tool, its full schema is then available for subsequent turns.

## Workforce Tools (v4.0, Workforce tier)

- **Slack:** `get_slack_mentions`, `get_slack_channel`, `post_to_slack` (approval).
- **Jira / Linear:** `get_assigned_tickets`, `update_ticket_status` (approval), `create_ticket` (approval), `get_sprint_status`.
- **Sentry:** `get_sentry_errors`, `get_sentry_error_detail`.
- **Calendar:** `get_today_schedule`.
- **CI:** `trigger_pipeline`, `cancel_pipeline` (approval) — GitHub, GitLab, Bitbucket.

Read-only Workforce tools are available in Ask mode; write/trigger tools require Build mode and approval.

## Other Tools

See the in-app tool manifest and schema for the full list (file, edit, search, git, execution, memory, blueprint, DB, stream, meta, agent, mode, and Workforce tools).
