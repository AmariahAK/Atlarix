# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

## 🔥 Critical Bugs (v0.9.1 Fixes)

### ✅ COMPLETED: Permission System (Option B Hybrid)
- [x] **Permission Not Triggering**: Fixed - AI now uses native tool calls that block for approval
  
  **Fix completed (4 phases)**:
  1. [x] **Backend Foundation** - `file-tools.ts` returns `{__permission_required: true}`, `interceptor.ts` has `waitForApproval()` blocking
  2. [x] **Chat Stream Integration** - `chat_stream_handlers.ts` detects permissions, blocks, sends to UI
  3. [x] **Frontend Wiring** - `pendingProposalsAtom`, `ipc_client.ts` permission methods, `FileDiffPanel.tsx` approve/reject
  4. [x] **Testing** - Verified with MiniMax on OpenRouter, blocking works, UI displays

### Other Bugs (Lower Priority)
- [x] **Input Box Clipping**: Fixed - Added `min-h-0` to flex containers + `flex-shrink-0` to input
- [x] **Chat Scroll**: Fixed - Added `min-h-0` to enable proper overflow
- [x] **ThinkingCard in Ask Mode**: Fixed - Added `<think>` tag instructions to chat-only prompt
- [ ] **Right Panel Toggle**: TBD - Keyboard shortcuts not working (Cmd+B conflict with system)
- [ ] **Diagrams Page Empty**: TBD - Diagrams not showing in sidebar page (cache/fresh analysis issue)

### Enhancements for v0.9.1
- [x] **Session Memory**: In-memory buffer of last 5 exchanges for conversation continuity

---

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

### v3.0 - Advanced AI
- [ ] **Multi-Agent**: Parallel AI queries for complex tasks
- [ ] **Custom Agents**: User-defined tool sets and personas
- [ ] **Team Collaboration**: Shared workspaces and permissions

---

**Last Updated**: 2025-12-29
**Version**: v0.9.1
