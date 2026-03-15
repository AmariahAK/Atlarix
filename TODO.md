# TODO

**Current Version:** v3.9.0  
**Next:** v4.0

---

## Done

### v3.9
- AI clarifying questions (system-prompt-driven, one block per turn).
- Conversation revert and message edit (revert to assistant message, edit user message, continue).
- Stream tools: stream_terminal_output, stream_pipeline_logs.
- GitHub Actions in left panel (Pro extension, same pattern as DB Studio); Extensions list in Settings; suggestions removed.
- Resizable left panel (drag handle, 200px–60% width, localStorage persistence).
- Chat tab in right panel when chat area is hidden (same session, compact model search).
- Panel keyboard shortcuts (Pro): Cmd+I / Ctrl+I (left), Cmd+O / Ctrl+O (right).
- Compact model search in main chat area when right panel is open.
- GitHub Actions token from Supabase session.provider_token.

### v3.8
- Screen-by-screen onboarding; DB extension; GitHub OAuth; Pro gating for Extensions/DB.

---

## v4.0+

- **Code revert on conversation revert** – When user hits "Revert to here" on an assistant message, restore file state from the snapshot taken at that exchange (v3.9 records snapshot id; v4.0+ to implement restore).
