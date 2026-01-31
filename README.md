# 🌌 Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot - a powerful desktop application that brings together 57 intelligent tools for modern software development.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

*Current: v1.8.0 · v2.0 (Phase 6) in progress*

---

## ✨ Features

### 🚀 Smart Scaffolding (v0.9.2+)
- **CLI-First Approach** - AI uses `npx create-vite`, `npx create-next-app` etc. instead of writing files manually
- **25+ Framework Support** - React, Next.js, Vue, Svelte, Astro, Express, NestJS, Electron, and more
- **Template Fallback** - Falls back to SearxNG template search when GitHub API is rate-limited

### 🔐 Authentication & Security (v0.9.18+)
- **Google OAuth** - Secure sign-in with your Google account
- **Session Persistence** - Stay logged in across restarts (file-based storage)
- **Deep Linking** - Seamless redirect handling (`atlarix://`)

### 📊 AI Diagram System (NEW in v0.9.4!)
- **Real AI Generation** - Diagrams created by analyzing your actual codebase
- **Pan/Zoom Controls** - Drag to pan, scroll to zoom, control buttons (+, -, Reset, Center)
- **Version History** - Browse and restore previous diagram versions
- **Professional UX** - Like Figma/Excalidraw for architecture diagrams

### 🧠 Session Change Tracking (NEW in v0.9.17!)
- **"Mini-Git" Functionality** - Tracks live file changes *before* you commit
- **Smart Staleness** - AI knows when the architecture diagram is outdated (<5%, 5-15%, >15% drift)
- **Auto-Update Suggestions** - Proactively suggests updating diagrams after major refactors

### 📝 Global & Workspace Prompts (NEW in v0.9.6!)
- **Custom AI Instructions** - Define behavior rules that persist across chats
- **Global Prompts** - Apply to all incognito/general chats
- **Workspace Prompts** - Project-specific AI context and guidelines
- **Library Page** - Easy management with character counter

### 📋 Smart Diff Preview (v1.5.0)
- **Hunk View** - Changed sections with ±3 lines of context
- **Expand All** - Toggle full diff for large files
- **AI Summary** - Change description at top of each file diff
- **Permission Queue** - Integrated SmartDiffView for write_file, replace_code, insert_code, delete_lines

### 🔍 Codebase Search Upgrade (v1.5.0)
- **Natural Language** - "Find the authentication logic" style queries
- **Results in Context** - ±3 lines of surrounding code per match
- **Recent Searches** - Dropdown with up to 10 previous queries
- **Search Tab** - CodebaseSearchBox in Right Panel Search tab

### 💰 Token Budget System (v1.7.5)
- **Per-provider caps** - Optional token limits in Settings to control API costs
- **Real-time display** - Color-coded bar (amber 70%+, red 90%+)
- **Warnings** - "Approaching token limit" at 80%, critical message at 90%

### 📊 Diagram Refinements (v1.7.5)
- **Smarter tracking** - Fewer refreshes for bug fixes; ±3 files often skip
- **Version history** - Previous versions dropdown in Diagram tab

### 🛠️ Right Panel Refinements (v1.5.0)
- **Code Tab** - Edit button opens correct file when switching from Errors tab
- **Errors Tab** - No stacking; build errors replace, runtime errors preserved
- **Terminal** - Multi-tab support for backend + frontend dev servers

### 🔐 Permission System (v0.9.0+)
- **Tool Approval Flow** - AI proposes changes, you approve before execution
- **FileDiffPanel** - Preview file changes with syntax highlighting
- **Batch Approval** - Approve All / Reject All / Execute Selected buttons
- **Sound Notifications** - Hear when new proposals arrive after batch approval

### 🎭 Incognito Chat Mode
- **Ephemeral Chats** - Ask anything without saving to database
- **Privacy-First** - Chats disappear when you close/leave
- **In-Memory Only** - Lightning-fast, truly private
- **Session Persistence** - Chats survive navigation to Settings and back

### 🔍 Ask Mode with Smart Tools
- **Read-Only Exploration** - 21 safe tools for exploring any workspace
- **Claude-Style Tool Display** - Grouped tool badges
- **Workspace Aware** - Tools automatically resolve paths

### 🤖 Multi-Provider AI Support
- **Ollama** - Free, local models (llama3.2, codellama)
- **LMStudio** - Local models with friendly error messages
- **OpenRouter** - Cloud access to 100+ models (including MiniMax 2.1)
- **Model Name Display** - See which model generated each response

### 🧠 Smart Context System (NEW in v0.9.14!)
- **AGENTS.md Reference** - Single source of truth for all 57 tools
- **Model-Aware Loading** - Full guidance for 32K+, compact for 8K models
- **~80% Prompt Reduction** - system_prompt.ts stripped from 770 to 153 lines
- **Small Model Support** - Actually fits in Ollama 8K context now!

### 🛠️ 57 Intelligent Tools
**File Operations** - Read, write, search, modify files  
**Code Intelligence** - Semantic search, architecture diagrams  
**Web & Research** - web_search, deep_search, read_url  
**Development** - Command execution, template scaffolding

### 📊 Diagram Timeline System
- **Project Evolution** - Visualize architecture changes over time
- **Smart Snapshots** - Auto-capture when code changes
- **Time Drill-Down** - Navigate from "All Time" to hourly
### 🛡️ Hybrid Error Detection (v0.9.11)
Atlarix uses multiple strategies to ensure no error is missed:
1.  **Terminal Parser**: Reads output from your dev server (Vite, Next.js) to catch build errors.
2.  **Type Watcher (LSP-Lite)**: Runs `tsc --watch` in the background to catch type errors.
3.  **CDP Browser Debugger**: Uses Electron's debugger API to capture runtime errors (filters out Atlarix's own errors).

This ensures you see:
*   Build Errors (Syntax)
*   Type Errors (Missing imports/props)
*   Runtime Errors (Crashes)

### 🧩 Smart Error Actions (NEW in v0.9.11!)
- **Fix with AI**: One-click button to pre-fill chat with error context
- **Suggest Button**: Add your own notes/suggestions when sending errors to AI
- **Clean Prompts**: Simplified format without redundant markdown

### 📝 Live Code Editor (NEW in v0.9.12!)
- **Monaco Editor**: Edit error files directly in the Code tab
- **Error Underlines**: Red/yellow squiggly lines at exact error locations
- **File List**: Collapsible list of files with error counts
- **Save Shortcut**: Cmd/Ctrl+S saves changes directly
- **Auto-Focus**: Cursor positions at first error automatically


### 🎯 AI-Controlled Right Panel (NEW in v0.9.5!)
- **Explicit AI Intent** - AI tells the panel what to show (no more heuristic guessing)
- **Permission Panel** - Dedicated view for showing pending tool approvals
- **Priority System** - AI state → User pinned → Heuristic fallback

### 🌐 Live Preview (NEW in v0.9.7!)
- **Lovable-Style Preview** - Auto-starts dev server for frontend projects
- **Responsive Iframe** - Mobile, tablet, desktop viewport controls
- **Framework Detection** - Vite, Next.js, Create React App, Nuxt, Astro
- **Backend Fallback** - Auto-shows diagram panel for backend projects

### 💰 Token-Saving Stop Button (NEW in v0.9.7!)
- **Instant Cancel** - Stop AI mid-response to save API tokens
- **Backend Abort** - Actually cancels the API call, not just UI
- **App Quit Cleanup** - All active streams aborted on close

### 🔧 Unified Permission Queue (NEW in v0.9.8!)
- **Merged into FileDiffPanel** - Permissions show in Approve tab alongside file changes
- **Real-time Updates** - IPC events populate queue as AI requests arrive
- **Simplified Routing** - Single panel handles both files and permissions

### 🗑️ Instant Workspace Delete (NEW in v0.9.8!)
- **Optimistic UI** - Workspace disappears immediately before backend confirms
- **Auto-Navigate** - Returns to home when current workspace deleted
- **Graceful Errors** - "Already deleted" scenarios handled silently

### ⚠️ Known Issues (v0.9.8)
- ~~**AI Prompt Error** - Message format incompatibility~~ **FIXED**
- ~~**PlantUML Code Shown** - Raw code visible in DiagramPanel~~ **FIXED**
- ~~**Workspace Delete Lag** - UI didn't update after deletion~~ **FIXED**

### 🔮 Coming in v2.0 (Phase 6)
- **Context Bar** - Claude Code-style fillable context; auto-summarize on fill, continue session
- **Smart Model Routing** - 3-tier favorites (Fast/Balanced/Deep), provider prefs, task-based selection
- **IDE-like Workspace** - File tree in sidebar, click file → Code tab, collapse on switch
- **Command Chaining UI** - Visual dependency graph, partial approvals, rollback hints

---

## 🚀 Installation

### Prerequisites
- **Node.js 20+**
- **macOS / Windows / Linux**

### Development Setup

```bash
git clone https://github.com/norahlabs/atlarix.git
cd atlarix
npm install
cp .env.example .env
npm start
```

---

---

## 🎯 Pricing

### Free Tier
- Unlimited non-workspace chats
- 1 Workspace chat (Full features)
- Full access to all 57 tools
- BYOK (Bring Your Own Keys)

### Pro - $19/month
- Unlimited workspaces
- Unlimited prompts
- Priority support

---

## 📜 License

PROPRIETARY - All Rights Reserved.  
Copyright © 2024-2025 NorahLabs.

---

**Built with ❤️ by NorahLabs**
