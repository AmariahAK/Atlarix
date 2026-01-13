# Atlarix Architecture

This document describes the high-level architecture of Atlarix v0.9.x.

## Overview

Atlarix is a local-first, AI-powered development environment built on **Electron**. It combines a VS Code-like editor experience with an intelligent agent that can read, write, and understand code.

### Tech Stack
- **Core**: Electron (Main + Renderer processes)
- **Frontend**: React, Tailwind CSS, Radix UI
- **State Management**: **Jotai** (Atomic state)
- **AI Integration**: Custom Tool Registry (55+ tools)
- **Language**: TypeScript

---

## Core Systems

### 1. The Right Panel (Context Engine)
Unlike typical chat apps, Atlarix features a context-aware **Right Panel** that adapts to user intent.
- **Preview Tab**: Live `iframe` of the user's running web app (localhost proxy).
- **Code Tab**: Monaco Editor for quick file edits.
- **Terminal Tab**: Real-time shell output (xterm.js).
- **Diagram Tab**: Mermaid.js architecture visualization.
- **Search Tab**: Web search results (SearxNG/Google).

**Logic**: `src/hooks/useRightPanelContext.ts` determines which tab to show based on:
1. **AI Intent** (Explicit instruction)
2. **Heuristics** (e.g., "User just ran a command" → Show Terminal)

### 2. Session Tracking ("Mini-Git")
Atlarix maintains a live **SessionTracker** (`src/lib/SessionTracker.ts`) to monitor AI changes *before* they are committed to git.
- **Purpose**: Detects when the AI's internal model of the code (the diagram) becomes stale.
- **Thresholds**:
  - **<5% change**: No action.
  - **5-15% change**: Minor drift (suggest update).
  - **>15% change**: Major drift (force regeneration).

### 3. Tool Registry
The AI interacts with the system via **55+ strictly typed tools** (`src/lib/tools/registry.ts`).
- **File Ops**: `read_file`, `write_file`, `replace_code`
- **Intelligence**: `get_project_structure` (primary entry point), `view_symbol`
- **Execution**: `run_command`, `git_status`
- **Special**: `get_session_changes`, `get_dev_server_port`

### 4. Permission Interceptor
Safety layer `src/ipc/handlers/permissions/interceptor.ts` that sits between the AI and the filesystem.
- **Reads**: Auto-approved.
- **Writes/Executes**: Requires user approval via the Permission UI.
- **Batching**: Supports batching multiple file changes into a single approval request.

---

## Data Flow

1. **User Prompt** → Sent to main process.
2. **Context Assembly** → `get_project_structure` + `read_file` (smart truncation) + Session state.
3. **AI Response** → Returns Tool Calls (not just text).
4. **Interceptor** → Catches tool calls, prompts user for permission.
5. **Execution** → Main process executes fs/shell commands.
6. **Feedback** → Result sent back to AI + SessionTracker updated.
7. **UI Update** → Jotai atoms update React components (Right Panel, Chat).

---

## Key Directories

```
~/.Atlarix/                # Global config & storage
src/
├── app/                   # React Frontend (Renderer)
│   ├── atoms/             # Jotai state definitions
│   └── components/        # UI Components (RightPanel, Chat)
├── ipc/                   # Electron IPC Handlers (Main)
│   └── handlers/          # Tool implementations
├── lib/
│   ├── tools/             # Tool definitions
│   └── SessionTracker.ts  # Change tracking logic
└── prompts/               # System prompts (AGENTS.md)
```

---

## Design Principles

1. **Local-First**: All code stays on the user's machine.
2. **Transparency**: User approves all side-effects (writes/commands).
3. **Context-Aware**: The UI reacts to what the AI is doing (e.g., showing the diagram when architecture changes).
4. **Agnostic**: Works with any provider (OpenAI, Anthropic, Ollama).
