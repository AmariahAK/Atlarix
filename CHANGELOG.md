# Changelog

## v3.9.0 (2026-03-15)

- **AI clarifying questions** – System can ask up to 4 clarifying questions in a single block; user answers via widget, then conversation continues with answers in context. No manual trigger; controlled by system prompt. Chat-level flag `has_answered_questions` so questions are only asked once per chat.
- **Conversation revert and message edit** – Edit any user message (inline) or revert to a prior assistant message. Truncates conversation from that point; divider "conversation restarted from here". Clearing questions flag on edit/revert. Snapshot taken at start of Build-mode exchange for future file revert (v4.0).
- **Stream tools** – `stream_terminal_output` (collect live terminal output from run_command in this chat, with optional pattern filter) and `stream_pipeline_logs` (collect CI/CD job logs, e.g. GitHub Actions). Both read-only, available in Ask and Build.
- **GitHub Actions in left panel** – GitHub Actions is a left-panel extension (Pro), same pattern as DB Studio. Add "GitHub Actions" from the extension list; view workflow runs, jobs, stream logs, Send to AI. Token is read from Supabase session (`session.provider_token`) when signed in with GitHub.
- **Resizable left panel** – Drag handle on the right edge of the left panel; min width 200px, max 60% of window. Width persisted in `localStorage` (`atlarix-left-panel-width`).
- **Chat tab when chat area is hidden** – When left + right panel widths leave &lt;80px for the chat area, a **Chat** tab appears in the right panel. Same session (messages, input, new chat, MCP); model selection uses the compact search bar.
- **Panel keyboard shortcuts (Pro)** – **Cmd+I** / **Ctrl+I** toggles the left panel; **Cmd+O** / **Ctrl+O** toggles the right panel. Open at 30% window width; close does not change stored width. Non-Pro users see an upgrade prompt.
- **Compact model search when right panel is open** – When the right panel is open, the main chat area model selector shows an inline compact search (filter providers/models) instead of opening the full model sheet, to avoid layout conflict.
- **Extensions in Settings** – Extensions section lists DB Connections and GitHub Actions with status (e.g. Connected / Connect GitHub).
- **Suggestions removed** – The previous prompt suggestions feature has been removed from the system prompt and UI.

---

## v3.8.0

- Screen-by-screen onboarding (workspace → Blueprint intro → Ask vs Build → Settings AI → Done).
- DB extension: connection string parser, Test connection, Parse button.
- GitHub OAuth; Pro gating for Extensions/DB (log in first, then upgrade).
