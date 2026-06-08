# Atlarix v12.7.0 — Discord technical post

> Paste-ready for the announcements channel. Small, focused reliability follow-up to v12.6.

---

**Atlarix v12.7.0 released** 🔧

Release notes (technical):

A reliability pass — fixes a real tool-schema bug that broke strict providers, tidies the chat config menu, and quiets some Sentry noise.

- **Tool-schema sanitizer (the big one):** a Core turn routed to Mistral (via OpenRouter) was failing with `400 "Invalid tool schema: False is not of type 'array'"`. Root cause was ours, not the provider: several tools encoded a property's optionality as a JSON-Schema-invalid `required: true/false` boolean (`required` must be an array of property names). Lenient providers silently ignored it; strict validators rejected the whole request → empty/failed turn. New `sanitizeJsonSchemaForProvider` in `normalize-tool-schema.ts` strips those booleans and hoists the `required: true` ones into the proper top-level `required` array, applied at both tool-wiring sites in `chat_stream_handlers.ts`.
- **Bonus fix from the same root cause:** tools that hand-wrote `parameters` as a bare `{ prop: {…} }` map with no `type`/`properties` wrapper (e.g. `live_preview`, `rename_file`, `create_workspace`) were being downgraded to an empty permissive schema — i.e. sent to **every** provider with no parameter hints. The normalizer now wraps and preserves them.
- **Tidier chat config:** removed the unused "Manage MCP tools" entry from the chat Config dropdown. MCP management still lives in **Settings → MCP Servers**.
- **Quieter Sentry:** benign, already-handled empty-output stream errors (`AI_NoOutputGeneratedError` / `NoContentGenerated` / `EmptyModelOutputAfterRetry`) are no longer reported. Genuine provider errors still surface.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
