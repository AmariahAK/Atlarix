# TODO

## Current Version: 4.0.0

## Next (4.1+)

- Wire full API implementations for Workforce tools (Slack, Jira, Linear, Sentry, Calendar, etc.) behind Token Vault.
- Permission queue / step-up UI for approval-required Workforce actions.
- Team Settings UI in app (invite flow, members list, add seats).

## Future

- Enterprise SSO
- Voice input
- Timeline export (GIF)
- Workspace templates (Pro)

## Done (v4.0)

- Workforce tier and pricing
- Auth0 Token Vault (env, service, IPC)
- LemonSqueezy Workforce checkout and webhook
- Teams (schema, service, IPC, effective_tier)
- Progressive Tool Reveal (ToolManifest, ToolSessionLoader, prompt integration)
- Workforce extensions (abstraction + Slack, Jira, Linear, CI, Sentry, Notion, Calendar)
- Workspace Context (Workforce-only block)
- Workforce AI tools (registry + stubs)
- DB Studio move to Workforce + grandfather + migration notice
- File revert ("Revert to here" → snapshot restore)

## Done (v3.9)

- GitHub Actions in left panel (Pro)
- Pre-exchange snapshots for conversation revert
- stream_terminal_output, stream_pipeline_logs
