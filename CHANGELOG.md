# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## [v0.9.7] - 2026-01-02

### 🚀 Command Execution Wait Fix (Critical)

#### Core Fix
- **FIXED**: AI now waits for commands to complete before issuing next command
- **Root Cause**: `resolveApproval()` was called BEFORE command execution, not after
- **Solution**: Moved approval resolution to AFTER `executeRunCommand()` completes
- **Sequential Execution**: `executeAllOperations()` now runs commands sequentially

#### Smart Output Formatting
- **Priority Slicing**: Command output limited to 1500 chars with intelligent truncation
- **Extraction Order**: Errors → Warnings → First 5 lines → Last 5 lines
- **AI Context**: AI now receives formatted terminal output for decision making

#### Timeout Protection
- **5-Minute Default**: Commands timeout after 300 seconds (configurable)
- **Progress Updates**: UI updates every 2 seconds for long-running commands
- **Error Storage**: Timeout/failure info captured for AI context

### 🔧 Technical Changes

#### Files Modified
- `src/ipc/handlers/permissions/interceptor.ts`
  - Moved `resolveApproval()` to after execution completes
  - Added `CommandExecutionResult` interface with timing info
  - Added `formatCommandOutput()` with smart slicing
  - Changed `executeAllOperations()` to sequential execution
  - Added timeout with `Promise.race()` and progress interval
  - Added `queueCapture()` for timeline auto-capture after file ops

### 🌐 Live Preview (Lovable-style)
- **Auto-Start Dev Server**: DevServerProvider detects frontend projects and starts server
- **Iframe Preview**: RightPanel Preview tab with responsive viewport controls
- **Framework Detection**: Vite, Next.js, Create React App, Nuxt, Astro
- **Backend Fallback**: Auto-pins diagram panel for non-frontend projects

### 📊 Timeline & Project Evolution
- **Auto-Capture**: Diagram snapshots on AI file changes (5-min debounce)
- **11 Timeline IPC Channels**: Full timeline API for project evolution
- **AI Awareness**: System prompt teaches Lovable-style workflow

### 💰 Token-Saving Stop Button
- **chat:abort IPC**: Cancels backend AI stream immediately
- **abortAllStreams()**: Cleanup on app quit
- **Stop Button Wired**: SimpleChatInput + ChatInput call abort to save tokens

### 🐛 Bug Fixes
- **PlantUMLPreview null check**: Fixed undefined split error
- **Database paths documented**: Dev vs Production DB locations

## [v0.9.6] - 2026-01-01

### 🎉 New Features

#### Global & Workspace Prompts System
- **Global AI Behavior**: Define custom instructions that apply to all incognito chats
- **Workspace Prompts**: Per-project AI instructions for workspace-specific context
- **Library Page Redesign**: Clean UI with Global prompt editor + paginated workspace prompts
- **Character Limit**: 2000 characters with visual counter

#### New Chat Button
- **Hover-Reveal Header**: Subtle "← New Chat" button appears at top of active chats
- **Session Persistence**: Chat sessions now persist across navigation (Settings → Home)
- **Jotai Atom**: `activeChatIdAtom` ensures chat state survives component unmounts

### 🐛 Bug Fixes

#### LM Studio Error Handling
- **FIXED**: Technical stack traces replaced with user-friendly messages
- **New Message**: "LM Studio not running. Please start LM Studio and load a model."
- **Graceful Degradation**: Connection errors no longer crash the model picker

#### MiniMax Content Duplication
- **FIXED**: MiniMax 2.1 "Interleaved Thinking" caused responses to appear twice
- **Deduplication Logic**: `cleanFullResponse.ts` now detects and removes exact content repeats
- **Reasoning Support**: Works with both `<think>` block responses and plain text

#### Chat History Display
- **FIXED**: Ephemeral chat history now shows all previous messages, not just current exchange
- **Scroll Preservation**: Auto-scroll only triggers after streaming starts, not on initial load

#### Permission Request Flow
- **FIXED**: Sequential AI permission requests now display correctly
- **Timestamp Fix**: Unique timestamps force frontend to re-process intents

### 🔧 Technical Changes

#### Files Created
- None

#### Files Modified
- `src/atoms/chatAtoms.ts` - Added `activeChatIdAtom` for session persistence
- `src/pages/atlarix-home.tsx` - New Chat button, session persistence via Jotai
- `src/pages/library.tsx` - Complete redesign for Global + Workspace prompts
- `src/ipc/handlers/prompt_handlers.ts` - New prompt system IPC handlers
- `src/ipc/handlers/local_model_lmstudio_handler.ts` - Friendly error handling
- `src/ipc/ipc_types.ts` - Added `error` field to `LocalModelListResponse`
- `src/ipc/utils/cleanFullResponse.ts` - Content deduplication for reasoning models
- `src/hooks/useLMStudioModels.ts` - Parse error field from response
- `src/db/schema.ts` - New prompts table with type/workspaceId fields

---

## [v0.9.5] - 2025-12-31

### 🎉 Major Features

#### AI-Controlled Right Panel
- **Explicit AI Intent**: AI now explicitly sets what the right panel shows instead of heuristic guessing
- **aiControlledPanelAtom**: New Jotai atom that takes priority over pinned/heuristic panel detection
- **Permission Panel**: New dedicated panel type (`'permission'`) for showing pending approval requests
- **IPC Integration**: Backend emits `right-panel:set-view` events when permissions are buffered
- **useAIPanelListener Hook**: Frontend hook that receives and applies AI panel updates

### 🐛 Bug Fixes

#### Prompt Box Clipping (Critical)
- **FIXED**: Mode switcher (Build/Ask) and model picker were hidden after first message
- **Root Cause**: ChatInput area was being compressed due to missing flex-shrink-0
- **Solution**: Wrapped ChatInput in flex-shrink-0 container in ChatPanel.tsx

#### Stream Cancel Error
- **FIXED**: "No callbacks found for chat -1" error when stopping generation
- **Changed**: console.error → console.debug (expected behavior when cancelling)

### 🔧 Technical Changes

#### Files Created
- `src/hooks/useAIPanelListener.ts` - Listens for AI panel updates from main process

#### Files Modified
- `src/atoms/sourceAtoms.ts` - Added AIPanelState interface and aiControlledPanelAtom
- `src/hooks/useRightPanelContext.ts` - Prioritizes AI state over heuristics
- `src/components/RightPanel.tsx` - Added PermissionPanel component
- `src/components/ChatPanel.tsx` - Fixed prompt box clipping with flex-shrink-0
- `src/ipc/handlers/permissions/handlers.ts` - Sends panel updates via IPC
- `src/preload.ts` - Whitelisted 'right-panel:set-view' channel
- `src/ipc/ipc_client.ts` - Silenced expected stream-end debug message

---

## [v0.9.4] - 2025-12-31

### 🎉 Major Features

#### Real AI Diagram Generation
- **AI-Powered Analysis**: Diagrams now generated by analyzing actual codebase structure
- **Codebase Extraction**: Reads project files (respecting .gitignore) and sends to AI
- **Smart Prompting**: System prompt guides AI to create architecture-focused Mermaid diagrams
- **Path Bug Fix**: Correctly handles imported apps with absolute paths

#### Pan/Zoom Diagram Controls
- **react-zoom-pan-pinch**: Professional pan/zoom library integration
- **Drag to Pan**: Click and drag to navigate large diagrams
- **Scroll to Zoom**: Mouse wheel zooms in/out smoothly
- **Zoom Controls**: +, -, Reset View, Center View buttons
- **Hint Bar**: Shows "Drag to pan • Scroll to zoom • Double-click to reset"

#### Version History Sidebar
- **History Toggle**: "History" button in diagram header toolbar
- **Collapsible Panel**: Side panel shows all historical versions
- **Smart Timestamps**: "Today at 2:30 PM" vs "Dec 31, 2:30 PM"
- **Restore Button**: One-click restore to any previous version
- **Empty State**: Friendly message when no history exists

### 🔧 Technical Changes

#### Files Created
- None (used existing infrastructure)

#### Files Modified
- `src/components/MermaidRenderer.tsx` - Complete rewrite with TransformWrapper
- `src/pages/diagram.tsx` - Added history state, handlers, sidebar UI
- `src/ipc/handlers/diagram_handlers.ts` - Added `diagram:generate-ai` handler
- `src/ipc/ipc_client.ts` - Added `generateAiDiagram()` method
- `src/preload.ts` - Whitelisted `diagram:generate-ai` channel
- `package.json` - Added `react-zoom-pan-pinch` dependency

---

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
