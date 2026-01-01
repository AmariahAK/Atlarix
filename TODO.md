# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

---

## 🔥 v0.9.6 - Prompts, Persistence & Polish ✅

### Global & Workspace Prompts ✅
- [x] **Global Prompt**: Custom AI instructions for all incognito chats
- [x] **Workspace Prompts**: Per-project AI instructions with workspace binding
- [x] **Library Page Redesign**: Two sections - Global (single) + Workspace (paginated list)
- [x] **Character Limit**: 2000 chars with visual counter
- [x] **DB Schema Update**: New prompts table with type/workspaceId fields

### Session Persistence ✅
- [x] **activeChatIdAtom**: Chat sessions persist across navigation (Settings → Home)
- [x] **New Chat Button**: Subtle "← New Chat" in header resets session
- [x] **Jotai State**: Replaced useState with atom for global persistence

### Error Handling ✅
- [x] **LM Studio Errors**: Friendly "LM Studio not running" message instead of stack traces
- [x] **MiniMax Deduplication**: Fixed content repeating twice with reasoning models
- [x] **Ephemeral History**: Full chat history displayed, not just current exchange

### Bug Fixes ✅
- [x] **Permission Requests**: Sequential requests now display correctly (timestamp fix)
- [x] **Auto-scroll**: Only scrolls after streaming starts, preserves scroll position
- [x] **Chat History Clipping**: Fixed by waiting for DOM render with requestAnimationFrame

---

## 🔥 v0.9.5 - AI-Controlled Right Panel ✅

### AI-Controlled Panel System ✅
- [x] **Explicit AI Intent**: AI now explicitly sets what right panel shows via `aiControlledPanelAtom`
- [x] **Priority Order**: AI state → Pinned → Heuristics (replaces brittle detection logic)
- [x] **Permission Panel**: New panel type for showing pending permission requests
- [x] **IPC Integration**: Backend sends `right-panel:set-view` events when permissions buffered

### UI Fixes ✅
- [x] **Prompt Box Clipping**: Fixed - Mode/model controls no longer hidden after first message
- [x] **flex-shrink-0 Wrapper**: ChatInput wrapped to prevent compression
- [x] **Stream Cancel Error**: Silenced non-critical "no callbacks" error for cancelled streams

### Workspace Registration ✅
- [x] **Direct Path Storage**: Workspaces registered by original path (no copying to ~/atlarix-apps)
- [x] **Duplicate Detection**: Smart check for existing path OR name duplicates
- [x] **Safe Delete**: Only removes database records, never deletes user source files

---

## 🔥 v0.9.4 - Diagram System Overhaul ✅

### AI-Powered Diagram Generation ✅
- [x] **Real AI Diagrams**: Replaced hardcoded placeholders with actual AI analysis
- [x] **Codebase Analysis**: `diagram:generate-ai` extracts and analyzes project structure
- [x] **Path Bug Fix**: Correctly handles imported apps with absolute paths

### Pan/Zoom Controls ✅
- [x] **react-zoom-pan-pinch**: Installed and integrated
- [x] **Drag to Pan**: Click and drag to navigate large diagrams
- [x] **Scroll to Zoom**: Mouse wheel zooms in/out
- [x] **Zoom Controls**: +, -, Reset, Center buttons in top-right

### Version History Sidebar ✅
- [x] **History Toggle**: "History" button in diagram header
- [x] **Collapsible Sidebar**: Shows all past versions with timestamps
- [x] **Restore Functionality**: Click "Restore" to revert to any version
- [x] **Smart Dates**: Shows "Today at 2:30 PM" vs "Dec 31, 2:30 PM"

---

## 📋 v0.9.3 Implementation Plan (Completed)

### Phase 1: Core Command Execution Fix ✅
- [x] **Fix interceptor.ts**: Add `executeRunCommand()` method to actually execute commands
  - Import `runShellCommand` utility
  - Store command output for UI display
  - Handle exit codes and errors
- [x] **Fix execution-tools.ts**: Return JSON permission request instead of legacy string
  - Use structured `{ __permission_required: true, operation: "run_command", preview: {...} }`
- [x] **Fix useStreamChat.ts**: Parse command proposals by checking `request.operation`
  - Check `request.operation === 'run_command'` instead of `p.command`

### Phase 2: Collapsed Terminal Output Card ✅
- [x] **New: CommandOutputCard.tsx**: Collapsed card showing terminal output (like ThinkingCard)
  - Auto-collapse on success, auto-expand on error
  - Show spinner while running, checkmark/error on complete
  - Click to expand full terminal output
  - Display: `⚡ npx create-vite my-app → ✓ Completed in 8.3s [View ▼]`

### Phase 3: Project Environment Detection ✅
- [x] **New: project_environment.ts**: Read package.json to detect project context
  - Detect framework (vite, next, cra, nuxt, astro)
  - Extract available scripts (dev, start, build, test)
  - Determine correct dev command (`npm run dev` vs `npm start`)
- [x] **New: get_project_info tool**: Read-only tool for AI to query project details
  - Prevents hallucination (AI calls this BEFORE running npm commands)

### Phase 4: TensorFlow + Heuristics Smart Slicing (StackSense Approach) ✅
- [x] **New: SliceExtractorAgent.ts**: Port from StackSense's slice_extractor_agent.py
  - Language-specific parsing (Python, JavaScript/TypeScript, generic)
  - Heuristic scoring: keyword density + function/class name matching
  - TensorFlow semantic scoring (optional, using @tensorflow/tfjs-node)
  - Combined score: 60% heuristic + 40% TensorFlow
  - Context budget management (select within token limit)
  - Context integrity (don't cut mid-function, merge adjacent slices)
- [x] **New: TerminalOutputSlicer.ts**: Real-time terminal output slicing
  - Categorize lines: errors, warnings, normal
  - Priority: Errors > Warnings > Last 5 lines > First 5 lines
  - Prevents AI context overflow from long command output

### Phase 5: Wire Everything Together
- [x] **Text-Based Tool Parser**: Added `text_tool_parser.ts` to handle models that output tool calls as XML text (MiniMax, etc.)
- [x] **Integrated into chat_stream_handlers.ts**: Parses and executes text-based tool calls after stream completes
- [x] **Integrated into chat_only_handlers.ts**: Same for ephemeral chats
- [x] **Agentic Tool Loop**: Feeds tool results back to AI so it can continue (up to 5 iterations)
- [ ] **Modify chat_stream_handlers.ts**: Use SliceExtractorAgent for file context
- [ ] **Emit terminal output**: Send to frontend for CommandOutputCard
- [ ] **Test end-to-end**: Create project → Approve command → See collapsed output


---

## ⏳ Known Issues (Ongoing)
- [x] **AI Message Repetition (MiniMax)**: ✅ FIXED in v0.9.6 - Deduplication logic added
- [x] **Prompt Box Clipping**: ✅ FIXED in v0.9.5 - Mode/model controls now always visible
- [x] **Diagram Persistence**: ✅ FIXED - Diagrams now persist and display correctly
- [x] **Right Panel Heuristics**: ✅ FIXED in v0.9.5 - AI now explicitly controls panel state
- [x] **LM Studio Errors**: ✅ FIXED in v0.9.6 - User-friendly error messages

---

## ✅ COMPLETED: v0.9.2 Enhancements
- [x] **Smart Project Scaffolding**: AI now uses CLI commands first (npx create-vite, etc.)
- [x] **Session Memory Persistence**: Memory persists across Ask → Build mode switches
- [x] **Permission Sound Notification**: Plays `remaining.mp3` when new proposals arrive
- [x] **SearxNG Template Fallback**: Templates fetched via SearxNG when GitHub rate-limited
- [x] **Code Copy Button**: Fixed - Copy button now visible on ALL code blocks
- [x] **Diagram Page Reset**: Fixed - Selected diagram resets when switching workspaces
- [x] **Sidebar Workspace Selection**: Fixed - Click to select, double-click for new chat
- [x] **Individual File Approval**: Added "Execute Selected" button for granular file acceptance
- [x] **Command Safety Wrapper**: Added dangerous pattern blocklist (rm -rf, sudo, curl|bash)


## 🎯 Medium Priority (v1.0)

### Features
- [ ] **Model Switching Mid-Chat**: Switch models during a conversation
- [ ] **Search in Chat**: Ctrl/Cmd + F to search messages
- [ ] **Chat Templates**: Pre-filled prompts for common tasks

### UI/UX
- [ ] **Keyboard Shortcuts**: Cmd+B (right panel), Cmd+/ (sidebar), Cmd+[ ] (resize), Esc (close)
- [ ] **Loading States**: Skeleton screens, progress bars

### Documentation
- [ ] **User Guide**: Getting started, tool reference
- [ ] **API Documentation**: IPC handler signatures

---

## 📋 Completed ✅

### v0.9.0 (2025-12-28)
- [x] **Permission System**: JSON-based tool permissions with FileDiffPanel
- [x] **PermissionInterceptor**: Buffer, validate, execute approved operations
- [x] **IPC Client Methods**: executePermission, rejectPermission, etc.
- [x] **Right Panel Cleanup**: Removed Tools tab (ThinkingCard handles it)
- [x] **Diagram Wiring**: Tool results populate diagramStateAtom

### v0.8.0 (2025-12-27)
- [x] **ThinkingCard**: Two independent cards, collapsed by default
- [x] **Absolute Paths**: Projects store full paths

### v0.7.0 (2025-12-27)
- [x] **Ask Mode Tools**: 21 read-only tools
- [x] **Tool Summary UI**: Claude-style grouped badges

### v0.6.0 (2025-12-27)
- [x] **Diagram Timeline**: Architecture evolution visualization

### v0.4.0 (2025-12-25)
- [x] **3-Panel Layout**: Left, Middle, Right panels
- [x] **SearxNG Setup**: One-click Docker

---

## 🚀 Roadmap: Future Versions

### v2.0 - Premium Features
- [ ] **Command Chaining UI**: Group related commands (e.g., create-vite → cd → npm install)
  - Show dependency graph
  - Partial approval (approve some, reject others)
  - Handle middle command failures
- [ ] **Token Budget System**: Adaptive token allocation based on provider
  - Ollama (8K), LMStudio (16K), OpenRouter (128K+)
  - Dynamic adjustment based on real-world user feedback
- [ ] **Dangerous Command UX**: Enhanced security for risky commands
  - Require "I understand" checkbox for rm -rf, sudo, etc.
  - Show command explanation in plain English
  - Log all dangerous command approvals
- [ ] **Persistent Memory (MEMORY.md)**: Claude Code-style file-based memory that persists across sessions
  - `.atlarix/MEMORY.md` - AI-summarized session memory
  - `.atlarix/PROJECT.md` - User-defined project context
  - Auto-updated on session end
- [ ] **Chat Themes**: Light/Dark/Auto, custom colors, font sizes
- [ ] **Voice Input**: Speech-to-text for prompts
- [ ] **Code Playground**: Run code snippets inline
- [ ] **Usage Stats**: Prompts used, most used tools, token consumption
- [ ] **Timeline Export**: Animated GIF of architecture evolution
- [ ] **Compare Mode**: Side-by-side diagram comparison
- [ ] **Multiple Diagram Types**: Class diagrams, Function maps, Sequence diagrams, ER diagrams
  - AI generates different views of the same codebase
  - Type selector dropdown in diagram header

### v3.0 - Advanced AI
- [ ] **Multi-Agent**: Parallel AI queries for complex tasks
- [ ] **Custom Agents**: User-defined tool sets and personas
- [ ] **Team Collaboration**: Shared workspaces and permissions

---

**Last Updated**: 2026-01-01
**Version**: v0.9.6 (Prompts, Persistence & Polish)
