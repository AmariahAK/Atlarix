# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

## 🔥 Critical Bugs (v0.9.1 Fixes)

### Must Fix Immediately
- [ ] **Permission Not Triggering**: AI hallucinates tool calls instead of actual execution
  - Permission system wired but tools not actually being called
  - Need to verify Build mode tool execution flow

- [ ] **Input Box Clipping**: Text input hides bottom half after first prompt
  - Cannot see/press Build/Model/Attach buttons
  - UI layout issue in ChatInput component

- [ ] **Chat Scroll**: Cannot scroll up to see previous messages
  - First prompt gets cut off after second prompt
  - MessagesList or ChatPanel scroll container issue

- [ ] **ThinkingCard Glitch**: Flickers in/out until response completes
  - Needs stable keys + React.memo
  - Component in `src/components/chat/ThinkingSection.tsx`

- [ ] **Right Panel Empty**: Shows "No content to display"
  - File code should show like web search results
  - Need to wire file content to CodePreviewPanel

- [ ] **Diagrams Not Showing**: Timeline filter not displaying diagrams
  - Past/present diagrams not appearing
  - Check diagramStateAtom population

### Enhancements for v0.9.1
- [ ] **Chat Memory Cache**: Cache last 5 chats for AI context continuity
  - AI hallucinates on previous context without memory
  - Store in-memory or localStorage

---

## 🎯 Medium Priority (v1.0)

### Features
- [ ] **Model Switching Mid-Chat**: Switch models during a conversation
- [ ] **Search in Chat**: Ctrl/Cmd + F to search messages
- [ ] **Chat Templates**: Pre-filled prompts for common tasks

### UI/UX
- [ ] **Keyboard Shortcuts**: Ctrl+N, Ctrl+K, Esc
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

**Last Updated**: 2025-12-28
**Version**: v0.9.0
