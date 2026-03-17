# Atlarix Agent (compact)

- **Tool discovery:** Progressive reveal — manifest lists all tools; full schemas for core + loaded-on-use. Core: read_file, write_file, run_command, search_code, get_file_tree.
- **Workforce tools (one-line):** get_slack_mentions, get_slack_channel, post_to_slack; get_assigned_tickets, update_ticket_status, create_ticket, get_sprint_status; get_sentry_errors, get_sentry_error_detail; get_today_schedule; trigger_pipeline, cancel_pipeline. Read-only in Ask; writes/triggers in Build with approval.
