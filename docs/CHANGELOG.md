# Atlarix Changelog

## [Unreleased]

_(Nothing yet.)_

---

## [9.1.0] (2026-05-28) — Attachments, LSP diagnostics, quieter workspace open

### Added

- **Post-send attachment UI:** Pasted text, terminal snippets, and file/PDF attachments render as chips in user bubbles (not raw XML). `displayPrompt` / `modelContent` split so the model receives full bodies while the thread stays readable.
- **Attachment persistence:** `paste_attachments` and `file_attachments` columns (migrations `0052`–`0055`); `AttachmentStore` rehydrates across session reload; workspace session user turns persist attachment payloads from the stream handler.
- **Bundled LSP servers:** `typescript-language-server` and `vscode-langservers-extracted` (JSON/HTML/CSS) in app `node_modules`; spawn resolves absolute paths under `.bin` with `ELECTRON_RUN_AS_NODE` for Node-based servers on macOS.

### Changed

- **Explore mode:** `removeAtlarixTags` preserves `atlarix-text-attachment` and `atlarix-terminal-attachment` bodies so pasted context reaches the model in read-only mode.
- **Self-correction:** TSC worker and Problems tab removed; follow-ups use [`collect-workspace-diagnostics.ts`](src/lib/lsp/collect-workspace-diagnostics.ts) (LSP) via [`self_correction_followup.ts`](src/ipc/handlers/self_correction_followup.ts).
- **Atlarix Core labels:** Settings and model picker show real catalog names from the provider registry (not raw tier ids like `compass-fast`).
- **Workspace open:** No automatic `get-app-files` / `git ls-files` on load; file tree loads on demand (Code tab, sidebar expand). Removed multi-repo header badge and `workspaceDiscoveryHints` on `get-app`.
- **File discovery cascade:** [`project-files.ts`](src/ipc/utils/project-files.ts) uses `fd` → ripgrep → bounded walk only (no Strategy 1 git index or multi-repo aggregate).

### Fixed

- **LSP init:** `connection.listen()` before `initialize`; failed spawns add `brokenServers` cache key to stop retry storms.
- **LSP spawn:** Registry uses `typescript-language-server --stdio` (not raw `tsserver`); macOS PATH via [`read_env.ts`](src/ipc/utils/read_env.ts) `shellEnvSync()` for external servers (rust-analyzer, etc.).
- **Welcome dark mode:** Outline button hover visibility on the launcher.
- **Renderer attachments:** Removed `node:crypto` from attachment persistence (browser-safe hashing).
- **Sentry noise:** Plan-limit and TextMate grammar stub errors filtered from reporting.

---

## [9.0.0] (2026-05-28) — Welcome launcher hotfix

### Fixed

- **Welcome → Open folder:** `openWorkspaceFolder` no longer imports `node:path` in renderer code (fixes Vite externalized-module error when picking a directory).
- **Welcome UI:** Right-panel toggle and panel chrome hidden until a workspace is selected (`selectedAppId` set).

---
