# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

## 🔥 Critical Bugs (v0.9.3 Fixes)

### Known Issues
- [ ] **Command Approval Not Showing**: `run_command` permissions not appearing in right panel (needs IPC debugging)
- [ ] **AI Message Repetition**: Model sometimes repeats previous messages (model behavior issue)
- [ ] **Right Panel Toggle**: TBD - Keyboard shortcuts not working (Cmd+B conflict with system)
- [ ] **Diagram Persistence**: TBD - Diagrams need proper database saving/retrieval

### ✅ COMPLETED: v0.9.2 Enhancements
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
