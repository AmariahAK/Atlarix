# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## [v0.9.2] - 2025-12-30

### 🚀 New Features
- **Smart Project Scaffolding**: AI now uses CLI commands first (`npx create-vite`, `npx create-next-app`, etc.) instead of writing files from scratch
- **Session Memory Persistence**: Memory now persists across Ask → Build mode switches (keyed by appId instead of chatId)
- **Permission Sound Notification**: Plays `remaining.mp3` when new file proposals arrive after initial batch approved
- **SearxNG Template Fallback**: When GitHub API is rate-limited, templates are fetched via SearxNG search

### 🔧 Technical Improvements
- **scaffold_commands.ts**: New library with 25+ framework CLI mappings
- **Command Approval UI**: Extended `FileProposal` type to support `command` operations
- **FileDiffPanel**: Commands now grouped under "⚡ Commands" with purple icon

### 🐛 Known Issues
- **Command Approval Not Showing**: `run_command` permissions not appearing in right panel (needs deeper investigation)
- **AI Repetition**: Model sometimes repeats previous messages (model behavior, not code issue)

---

## [v0.9.1] - 2025-12-29

### ✅ Bug Fixes
- **Input Box Clipping**: Fixed - Added `min-h-0` to flex containers + `flex-shrink-0` to input
- **Chat Scroll**: Fixed - Added `min-h-0` to enable proper overflow
- **ThinkingCard in Ask Mode**: Fixed - Added `<think>` tag instructions to chat-only prompt
- **Permission System**: All 4 phases complete - AI tools properly block for user approval

### 🚀 Enhancements
- **Session Memory**: In-memory buffer of last 5 exchanges for conversation continuity
- **Session Cleanup**: Memory cleared on new chat creation and app quit
- **Right Panel Empty State**: Improved empty state with mode explanations

### 🐛 Known Issues (v1.0)
- **Right Panel Toggle**: Keyboard shortcuts not fully working (Cmd+B system conflict)
- **Diagrams Page Empty**: Diagrams not persisting to sidebar page

---

## [v0.9.0] - 2025-12-28

### 🎉 Major Features

#### Permission System (Build Mode)
- **Structured JSON Permissions**: Tools return JSON permission requests for user approval
- **PermissionInterceptor**: Buffers operations, validates with Zod schemas
- **FileDiffPanel**: Shows file proposals with Approve All / Reject All buttons
- **IPC Integration**: Frontend communicates with backend via executePermission/rejectPermission

#### Right Panel Improvements
- **Context-Aware Display**: Auto-switches based on content (file-diff, diagram, web-search)
- **Removed Tools Tab**: ThinkingCard now handles tool display
- **Diagram Wiring**: Diagram tools now populate diagramStateAtom automatically

#### Planned Fixes
- [ ] **Chat Memory Cache**: Cache last 5 chats for AI context continuity
- [ ] **Web Search Sources**: Make file code show like web search results

### 🔧 Technical Changes

#### Files Created
- `src/lib/tools/permissions/schema.ts` - Zod schemas for permission requests
- `src/ipc/handlers/permissions/interceptor.ts` - Permission buffering and execution
- `src/ipc/handlers/permissions/handlers.ts` - IPC handlers for approve/reject
- `src/ipc/handlers/permissions/index.ts` - Module exports

#### Files Modified
- `src/lib/tools/file-tools.ts` - write_file returns JSON permission request
- `src/ipc/handlers/chat_stream_handlers.ts` - Integrated PermissionInterceptor
- `src/ipc/ipc_client.ts` - Added 5 permission methods + onPermissionRequest handler
- `src/hooks/useStreamChat.ts` - Wires permissions to pendingProposalsAtom
- `src/hooks/useRightPanelContext.ts` - Removed tools panel from routing
- `src/components/preview_panel/FileDiffPanel.tsx` - IPC buttons with loading state
- `src/components/RightPanel.tsx` - Removed Tools button from toolbar

---

## [v0.8.0] - 2025-12-27

### 🎉 Major Features

#### ThinkingCard UI (Claude-style)
- **Two Independent Cards**: Thinking and Response as separate, non-connected cards
- **Collapsed by Default**: ThinkingCard shows summary, click to expand details
- **No Streaming Lag**: Cards are independent, streaming doesn't cause UI bugs
- **Clean Layout**: Answer always visible, thinking tucked away

#### Absolute Path Storage
- **Full Path Support**: Projects now store absolute paths in database
- **Backward Compatible**: `resolveAppPath()` helper handles both old relative and new absolute paths
- **Fresh Import**: New projects correctly point to their original location

---

## [v0.7.0] - 2025-12-27

### 🎉 Major Features

#### Ask Mode with Read-Only Tools
- **Smart Tool Filtering**: `isReadOnly` flag on all tools enables safe Ask mode exploration
- **21 Read-Only Tools**: `read_file`, `list_files`, `search_code`, `find_file`, `get_diagram`, etc.
- **Workspace Aware**: Tools automatically resolve paths relative to workspace
- **Memory Integration**: `recall_memory` and `search_memory` tools for context retrieval

#### Compact Tool Summary UI (Claude-style)
- **Grouped Badges**: Consecutive tool calls grouped into one compact bar
- **Expandable Details**: Click to see individual tool calls and results
- **Native Tool Tags**: Ask mode now uses `atlarix-tool-call` tags

---

## [v0.6.0] - 2025-12-27

### Diagram Timeline System
- **Project Evolution**: Visualize architecture changes over time
- **Smart Snapshots**: Auto-capture on file changes with deduplication
- **Time Drill-Down**: Navigate from "All Time" down to hourly changes

---

## [v0.4.0] - 2025-12-25

### 3-Panel Layout
- Left, Middle (Chat), Right (Context) panels
- Web search, File diff, Diagrams in right panel
- One-click SearxNG Docker setup

---

**Last Updated**: 2025-12-28
**Version**: v0.9.0 (Permission System + Build Mode)
