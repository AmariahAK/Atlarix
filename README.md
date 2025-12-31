# 🌌 Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot - a powerful desktop application that brings together 41 intelligent tools for modern software development.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

---

## ✨ Features

### 🚀 Smart Scaffolding (v0.9.2+)
- **CLI-First Approach** - AI uses `npx create-vite`, `npx create-next-app` etc. instead of writing files manually
- **25+ Framework Support** - React, Next.js, Vue, Svelte, Astro, Express, NestJS, Electron, and more
- **Template Fallback** - Falls back to SearxNG template search when GitHub API is rate-limited

### 📊 AI Diagram System (NEW in v0.9.4!)
- **Real AI Generation** - Diagrams created by analyzing your actual codebase
- **Pan/Zoom Controls** - Drag to pan, scroll to zoom, control buttons (+, -, Reset, Center)
- **Version History** - Browse and restore previous diagram versions
- **Professional UX** - Like Figma/Excalidraw for architecture diagrams

### 🔐 Permission System (v0.9.0+)
- **Tool Approval Flow** - AI proposes changes, you approve before execution
- **FileDiffPanel** - Preview file changes with syntax highlighting
- **Batch Approval** - Approve All / Reject All / Execute Selected buttons
- **Sound Notifications** - Hear when new proposals arrive after batch approval

### 🎭 Incognito Chat Mode
- **Ephemeral Chats** - Ask anything without saving to database
- **Privacy-First** - Chats disappear when you close/leave
- **In-Memory Only** - Lightning-fast, truly private

### 🔍 Ask Mode with Smart Tools
- **Read-Only Exploration** - 21 safe tools for exploring any workspace
- **Claude-Style Tool Display** - Grouped tool badges
- **Workspace Aware** - Tools automatically resolve paths

### 🤖 Multi-Provider AI Support
- **Ollama** - Free, local models (llama3.2, codellama)
- **LMStudio** - Local models with GUI
- **OpenRouter** - Cloud access to 100+ models
- **Model Name Display** - See which model generated each response

### 🛠️ 41 Intelligent Tools
**File Operations** - Read, write, search, modify files  
**Code Intelligence** - Semantic search, architecture diagrams  
**Web & Research** - web_search, deep_search, read_url  
**Development** - Command execution, template scaffolding

### 📊 Diagram Timeline System
- **Project Evolution** - Visualize architecture changes over time
- **Smart Snapshots** - Auto-capture when code changes
- **Time Drill-Down** - Navigate from "All Time" to hourly

### 🎯 AI-Controlled Right Panel (NEW in v0.9.5!)
- **Explicit AI Intent** - AI tells the panel what to show (no more heuristic guessing)
- **Permission Panel** - Dedicated view for showing pending tool approvals
- **Priority System** - AI state → User pinned → Heuristic fallback

### ⚠️ Known Issues (v0.9.5)
- ~~**Prompt Box Clipping** - Mode/model controls hidden after first message~~ **FIXED**
- **AI Repetition** - Model occasionally repeats previous messages

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

## ⚠️ Known Issues (v0.9.4)

- **Command Approval** - AI tool calls for `run_command` may not appear in right panel
- **AI Repetition** - Model sometimes repeats previous messages (model behavior, not code issue)

See [TODO.md](./TODO.md) for full list and roadmap.

---

## 🎯 Pricing

### Free Tier
- 5 prompts per day
- Full access to all 41 tools
- BYOK (Bring Your Own Keys)

### Pro - $19/month
- Unlimited prompts
- Priority support

---

## 📜 License

PROPRIETARY - All Rights Reserved.  
Copyright © 2024-2025 NorahLabs.

---

**Built with ❤️ by NorahLabs**
