# 🌌 Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot - a powerful desktop application that brings together 41 intelligent tools for modern software development.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

---

## ✨ Features

### 🚀 Smart Scaffolding (NEW in v0.9.2!)
- **CLI-First Approach** - AI uses `npx create-vite`, `npx create-next-app` etc. instead of writing files manually
- **25+ Framework Support** - React, Next.js, Vue, Svelte, Astro, Express, NestJS, Electron, and more
- **Template Fallback** - Falls back to SearxNG template search when GitHub API is rate-limited

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

### ⚠️ Known Issues (v0.9.2)
- **Command Approval** - `run_command` permissions not showing in right panel
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

## ⚠️ Known Issues (v0.9.0)

- **Permission Not Triggering** - AI may hallucinate tool calls
- **Input Box Clipping** - Bottom half hidden after first prompt
- **Chat Scroll** - Cannot scroll to previous messages
- **ThinkingCard Glitch** - Flickers during streaming
- **Right Panel Empty** - May show "No content" instead of code
- **Diagrams** - Timeline filter needs fixes

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
