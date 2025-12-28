# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

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

### 🐛 Known Issues (To Fix in v0.9.1)

#### Critical Bugs
- [ ] **Permission Not Triggering**: AI hallucinates tool calls instead of actual execution
- [ ] **Input Box Clipping**: Text input hides bottom half after first prompt
- [ ] **Chat Scroll**: Cannot scroll up to see previous messages
- [ ] **ThinkingCard Glitch**: Flickers in/out until response completes
- [ ] **Right Panel Empty**: Shows "No content to display" instead of file code
- [ ] **Diagrams Not Showing**: Timeline filter not displaying past/present diagrams

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
