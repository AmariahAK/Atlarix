# Atlarix TODO

**Current Version:** v2.0.0  
**Next Version:** v2.1.0 — Agent System and Project Understanding  
**Target Version:** v2.2.0 — Blueprint Intelligence System  
**Last Updated:** 2026-02-08

---

## v2.1 — Agent System and Project Understanding (implemented)

- **Schema and settings:** Agent mode, permission mode (Ask/Build), Auto, three favorites per provider, AI Configuration options.
- **Project instructions:** Load/save `.atlarix/ATLARIX.md` and `~/.atlarix/ATLARIX.md`; precedence in system prompt; context window from resolved model.
- **Summarization model:** Fast/same/custom for compaction and title generation.
- **Built-in agents and delegate_to_agent:** Research, Architect, Builder, Reviewer; Guided flat delegation; Autonomous nested with depth limit.
- **Chat UI:** Mode (Direct/Guided/Autonomous) + Permission (Ask/Build); Auto toggle; active context bar.
- **Activity Stream:** Right-panel tab; events for delegation, compaction, self-review, turn summary.
- **Self-review:** Runtime stub (Activity Stream); settings schema in place.
- **Autonomous mode:** Nested delegation with max depth; shared context and approval modal can be extended later.
- **Agent Lightning:** Trace collection to `.atlarix/training_data/`; training entry point (placeholder).
- **Token budget:** Turn summary in Activity Stream; per-provider budget in schema.

v2.2 will be updated to build on v2.1 systems (e.g. Architect/Builder for Blueprint, project instructions).

---

## Overview: Atlarix 2.2 — Blueprint Intelligence System

Atlarix 2.2 transforms the Blueprint from a static diagram into a **living knowledge system** that progressively learns project architecture, remembers it across sessions, and uses that understanding to plan and implement changes accurately.

**Core Insight:** The Blueprint is not just a visualization—it's a compressed, AI-readable representation of the project that serves as persistent memory.

### Key Components

1. **Progressive Extraction** — Fast initial load, detail on demand
2. **Framework-Aware Patterns** — Accurate detection of APIs, webhooks, models
3. **Blueprint cache + future memory** — Relationship-aware memory that persists
4. **Motia-Style Visual UI** — Nodes with descriptions, connectors, click-to-expand
5. **Guided Natural Language** — Users describe in plain English, AI structures
6. **Blueprint-Driven Planning** — Compare desired vs actual, generate tasks via `ATLARIX_PLAN.md`

---

## Phase 1: Extraction Layer

**Goal:** Convert source code into structured architectural data accurately.

### 1.1 Framework Detection
- [ ] Create `src/lib/extraction/framework-detector.ts`
- [ ] Detect framework from package.json, imports, file patterns
- [ ] Support: Express, Next.js, FastAPI, Django, Flask, NestJS, Hono, Elysia
- [ ] Return: framework name, version, confidence score

### 1.2 Framework Patterns
- [ ] Create `src/lib/extraction/framework-patterns.ts`
- [ ] Define patterns per framework:
  - [ ] **Express**: `app.get`, `app.post`, `router.*`, middleware patterns
  - [ ] **Next.js**: `pages/api/**`, `app/**/route.ts`, `export default function`
  - [ ] **FastAPI**: `@app.get`, `@app.post`, `@router.*`, Pydantic models
  - [ ] **Django**: `path()`, `@api_view`, `urlpatterns`, `models.Model`
  - [ ] **Flask**: `@app.route`, `@blueprint.route`
  - [ ] **NestJS**: `@Controller`, `@Get`, `@Post`, `@Injectable`
- [ ] Extract: method, route, handler name, file, line number
- [ ] Detect webhooks: `/webhook`, `/hook`, service-specific patterns (Stripe, GitHub)

### 1.3 Dependency Graph
- [ ] Integrate `dependency-cruiser` or build custom import follower
- [ ] Create `src/lib/extraction/dependency-graph.ts`
- [ ] Extract: module dependencies, circular imports, external packages
- [ ] Map imports to rooms/steps for connection visualization

### 1.4 Enhanced Tree-sitter Integration
- [ ] Extend `treesitter-parser.ts` for step extraction
- [ ] Extract classes with methods and properties
- [ ] Extract conditional branches (if/else around routes)
- [ ] Support all current Atlarix languages (JS, TS, Python, Go, Rust, etc.)

---

## Phase 2: Blueprint Cache & Storage

**Goal:** Persist extracted architecture across sessions.

### 2.1 Cache Structure
- [ ] Create `~/.atlarix/blueprints/{projectHash}/` directory structure
- [ ] Create `src/lib/cache/blueprint-cache.ts`
- [ ] Implement:
  - [ ] `manifest.json` — Metadata, staleness info, framework
  - [ ] `overview.json` — High-level rooms and connections
  - [ ] `rooms/{roomId}.json` — Detailed room data
  - [ ] `functions/{functionId}.json` — Function-level detail

### 2.2 Cache Schemas
- [ ] Create `src/shared/blueprint-cache-types.ts`
- [ ] Define interfaces:
  - [ ] `BlueprintManifest` — projectId, projectHash, framework, detailLevel
  - [ ] `BlueprintOverview` — rooms[], connections[]
  - [ ] `RoomDetail` — ascii, summary, apis[], webhooks[], functions[], models[]
  - [ ] `FunctionDetail` — description, logic[], inputs[], outputs[], dependencies

### 2.3 Staleness Detection
- [ ] Create `src/lib/cache/staleness.ts`
- [ ] Compute project hash from file structure
- [ ] Compare cached hash vs current hash
- [ ] Identify which rooms are stale (changed files map to rooms)
- [ ] Return: isStale, staleRooms[], recommendation

---

## Phase 3: Blueprint Memory / Knowledge Graph

**Goal:** Enable relationship-aware queries and persistent "memory" of the project (Blueprint cache + future memory; v2.2 will be updated to build on v2.1).

### 3.1 Graph / memory setup
- [ ] Create `~/.atlarix/blueprints/{projectHash}/` or similar for graph storage
- [ ] Create `src/lib/blueprint-memory.ts` (or equivalent)

### 3.2 Indexing Pipeline
- [ ] Create `src/lib/cognee/indexer.ts`
- [ ] Index entities:
  - [ ] Rooms (name, type, summary)
  - [ ] APIs (method, route, purpose)
  - [ ] Webhooks (route, service, trigger)
  - [ ] Functions (name, purpose, file)
  - [ ] Models (name, fields)
  - [ ] External services (name, type)
- [ ] Index relationships:
  - [ ] Room contains API/Function/Model
  - [ ] Function calls Function
  - [ ] API uses Model
  - [ ] Room connects to Room

### 3.3 Query API
- [ ] Create `src/lib/cognee/queries.ts`
- [ ] Implement queries:
  - [ ] `getConnections(entityId)` — What does this connect to?
  - [ ] `searchRelated(query)` — Find everything related to X
  - [ ] `getImpact(entityId)` — If I change this, what's affected?
  - [ ] `traverseGraph(from, depth)` — Explore relationships

---

## Phase 4: Progressive Extraction Flow

**Goal:** Load fast, detail on demand, cache everything.

### 4.1 Initial Load (Fast)
- [ ] On workspace open: check cache exists
- [ ] If cached: load `overview.json`, render immediately
- [ ] If not cached: run Phase 1 structure scan (<2 seconds)
- [ ] Detect framework, group files into rooms by directory/module
- [ ] Show rooms as boxes (no detail yet)

### 4.2 On-Demand Room Detail
- [ ] Create `src/lib/extraction/progressive-extractor.ts`
- [ ] When user clicks room:
  - [ ] Check room cache (cached & fresh → load)
  - [ ] Check room cache (cached & stale → load + badge)
  - [ ] Not cached → extract now with loader
- [ ] Gather context for RAG:
  - [ ] All files in room's directory
  - [ ] Tree-sitter AST for those files
  - [ ] Framework pattern matches
  - [ ] Dependency graph subset
- [ ] AI generates: ASCII blueprint, API list, function summaries
- [ ] Cache result + index in Cognee

### 4.3 Deep Function Detail
- [ ] When user clicks function inside room:
  - [ ] Gather focused context (function code + deps + callers)
  - [ ] AI generates: description, logic steps, inputs/outputs
  - [ ] Show in Guided NL format (editable)
  - [ ] Cache result

---

## Phase 5: Motia-Style Visual UI

**Goal:** Provide a visual canvas with nodes, descriptions, and connectors.

### 5.1 Step Types & Icons
- [ ] Define step types in `src/shared/blueprint-step-types.ts`:
  - [ ] `[API]` — HTTP endpoint
  - [ ] `[WH]` — Webhook handler
  - [ ] `[EVT]` — Event handler
  - [ ] `[FN]` — Function
  - [ ] `[CLS]` — Class
  - [ ] `[CRON]` — Scheduled job
  - [ ] `[AI]` — AI agent
  - [ ] `[DB]` — Database operation
  - [ ] `[3P]` — Third-party service
  - [ ] `[IF]` — Conditional branch
  - [ ] `[STREAM]` — WebSocket/SSE

### 5.2 Canvas Node Component
- [ ] Modify `BlueprintRoomNode.tsx` for Motia-style appearance:
  - [ ] Type badge in corner (e.g., `[API]`)
  - [ ] Name as title
  - [ ] Description (2-3 lines) below name
  - [ ] Route/schedule/trigger info at bottom
  - [ ] Credential reference if applicable
- [ ] Add connection handles (top, bottom, left, right)

### 5.3 Connection Styles
- [ ] Dashed lines for event/async connections
- [ ] Solid lines for direct calls
- [ ] Arrows showing direction
- [ ] Labels on connections (optional)

### 5.4 Canvas Interactions
- [ ] Drag nodes to reposition
- [ ] Click node → open detail panel (right side)
- [ ] Drag from handle → create connection
- [ ] Right-click → context menu (delete, duplicate)
- [ ] Double-click canvas → add new node
- [ ] Cmd+K → search nodes

### 5.5 Detail Panels
- [ ] Create `src/components/preview_panel/StepDetailPanel.tsx`
- [ ] Panels for each step type:
  - [ ] `[API]` — Method, path, inputs, outputs, emits
  - [ ] `[WH]` — Path, service, events handled, credential
  - [ ] `[FN]` — Parameters, returns, logic steps
  - [ ] `[CLS]` — Methods list, properties
  - [ ] `[IF]` — Condition expression, branches
  - [ ] `[3P]` — Service, operations, credentials
  - [ ] `[DB]` — Operation type, table, description
- [ ] Editable fields with auto-save
- [ ] "View Code" and "Generate Code" buttons

### 5.6 Vault Integration
- [ ] Credential reference in step detail (dropdown of Vault keys)
- [ ] "Edit in Vault" link opens Vault tab
- [ ] Show "Used by" list in Vault for each credential
- [ ] Sync credentials to `.env.local`

---

## Phase 6: Guided Natural Language Editor

**Goal:** Let users describe behavior in plain English with smart structure.

### 6.1 Input Component
- [ ] Create `src/components/preview_panel/GuidedNLEditor.tsx`
- [ ] Text area for natural language description
- [ ] "Parse" button to process input

### 6.2 Parsing Pipeline
- [ ] Create `src/lib/guided-nl/parser.ts`
- [ ] Send description to AI for structured extraction
- [ ] Extract: trigger, actions, data inputs/outputs
- [ ] Return parsed structure with confidence scores

### 6.3 Structured Preview
- [ ] Create `src/lib/guided-nl/structured-preview.ts`
- [ ] Display "We understood:" section
- [ ] Show parsed elements with edit buttons
- [ ] Allow inline refinement of each element
- [ ] Validation errors if ambiguous

### 6.4 Save to Blueprint
- [ ] Convert parsed structure to BlueprintStep
- [ ] Add to room or create new room
- [ ] Update canvas visualization
- [ ] Index in Cognee

### 6.5 Add New Step Modal
- [ ] Type selector (API, Webhook, Function, etc.)
- [ ] Or: describe in natural language
- [ ] Templates for common patterns

---

## Phase 7: AI Blueprint Editing

**Goal:** AI can propose and execute blueprint changes with user approval.

### 7.1 Tool Calls (Option A: AI Proposes, User Reviews)
- [ ] Update `src/lib/tools/blueprint-tools.ts`:
  - [ ] `add_blueprint_step` — Add new step to blueprint
  - [ ] `update_blueprint_step` — Modify existing step
  - [ ] `remove_blueprint_step` — Delete step
  - [ ] `connect_steps` — Create connection
  - [ ] `disconnect_steps` — Remove connection
- [ ] Each tool returns structured diff for preview

### 7.2 Diff Preview UI
- [ ] Create `src/components/preview_panel/BlueprintDiffPreview.tsx`
- [ ] Show: ADD (new steps), MODIFY (changed steps), REMOVE (deleted steps)
- [ ] Visual preview on canvas (ghost nodes for proposed changes)
- [ ] Approve / Reject / Edit buttons

### 7.3 Real-time Updates
- [ ] Emit `blueprint:ai-editing` with humanized action
- [ ] Show prominent indicator: "AI is editing the blueprint"
- [ ] Emit `blueprint:updated` when changes applied
- [ ] Canvas updates in real-time

---

## Phase 8: Blueprint-Driven Task Planning

**Goal:** Use the detailed blueprint to plan and execute code changes via `ATLARIX_PLAN.md`.

### 8.1 Blueprint vs Live Comparison
- [ ] Create `src/lib/planning/blueprint-diff.ts`
- [ ] Compare blueprint (desired) to extracted code (actual)
- [ ] Identify:
  - [ ] Additions — In blueprint but not in code
  - [ ] Orphaned — In code but not in blueprint
  - [ ] Modifications — Different between blueprint and code

### 8.2 Task Generation
- [ ] Create `src/lib/planning/task-generator.ts`
- [ ] From diff, generate ordered tasks:
  - [ ] Create file/function/API
  - [ ] Modify existing code
  - [ ] Add connections/integrations
- [ ] Estimate complexity per task
- [ ] Identify dependencies between tasks

### 8.3 ATLARIX_PLAN.md Integration
- [ ] Use `get_plan_scope` to determine placement:
  - [ ] **Monorepo/single project**: One `ATLARIX_PLAN.md` at root with sections (## Frontend, ## Backend, ## Shared)
  - [ ] **Polyrepo/multi-workspace**: One plan per workspace/subproject
  - [ ] **Non-repo**: Place in workspace root
- [ ] Update `read_implementation_plan` / `write_implementation_plan` tools
- [ ] Plan file structure:
  ```markdown
  # ATLARIX_PLAN.md
  
  ## Overview
  [Summary of what's being built]
  
  ## Frontend
  - [ ] Task 1: Description
  - [ ] Task 2: Description
  
  ## Backend
  - [ ] Task 1: Description
  - [ ] Task 2: Description
  
  ## Completed
  - [x] Task: Description (completed 2026-02-05)
  ```

### 8.4 Exchange-by-Exchange Implementation
- [ ] AI implements one task per exchange (user message → AI response)
- [ ] After each task: AI asks for user review/test
- [ ] User confirms → AI proceeds to next task
- [ ] User reports issue → AI fixes before proceeding
- [ ] Quality gate: Don't proceed until current task passes

### 8.5 Plan Cleanup
- [ ] When task completed and approved: move to "Completed" section
- [ ] Option to delete completed tasks to save space
- [ ] Track completion timestamps

---

## Phase 9: UI Polish & UX

**Goal:** Production-ready interface with good user experience.

### 9.1 Progress Indicators
- [ ] Room detail level indicator: `[████████░░] 80% detailed`
- [ ] Overall blueprint exploration progress
- [ ] "Refresh outdated" button for stale rooms

### 9.2 Loading States
- [ ] Skeleton loaders for room detail extraction
- [ ] "Understanding [Room Name]..." message
- [ ] Progress bar for initial extraction

### 9.3 Error Handling
- [ ] Graceful fallback if extraction fails
- [ ] Retry mechanism with exponential backoff
- [ ] User-friendly error messages

### 9.4 Bottom Tabs (Future)
- [ ] Tracing — Execution flow visualization
- [ ] Logs — Relevant log entries
- [ ] Connections — All connections in/out

### 9.5 Keyboard Shortcuts
- [ ] `Cmd+K` — Search nodes
- [ ] `Cmd+N` — Add new node
- [ ] `Delete` — Remove selected
- [ ] `Cmd+S` — Save changes
- [ ] `Cmd+Z` — Undo

---

## Phase 10: Documentation & Testing

### 10.1 Documentation
- [ ] Update AGENTS.md with new tools and workflow
- [ ] Update AGENTS_COMPACT.md for smaller models
- [ ] Add blueprint workflow examples
- [ ] Document Guided NL syntax

### 10.2 Testing
- [ ] Unit tests for extraction patterns
- [ ] Unit tests for cache operations
- [ ] Unit tests for Cognee queries
- [ ] Integration tests for progressive extraction
- [ ] E2E tests for blueprint editing flow

---

## File Structure (New/Modified)

```
src/
├── lib/
│   ├── extraction/
│   │   ├── framework-detector.ts      # NEW
│   │   ├── framework-patterns.ts      # NEW
│   │   ├── dependency-graph.ts        # NEW
│   │   └── progressive-extractor.ts   # NEW
│   │
│   ├── cache/
│   │   ├── blueprint-cache.ts         # NEW
│   │   ├── staleness.ts               # NEW
│   │   └── cache-types.ts             # NEW
│   │
│   ├── cognee/
│   │   ├── blueprint-memory.ts        # NEW
│   │   ├── indexer.ts                 # NEW
│   │   └── queries.ts                 # NEW
│   │
│   ├── planning/
│   │   ├── blueprint-diff.ts          # NEW
│   │   ├── task-generator.ts          # NEW
│   │   └── implementation-flow.ts     # NEW
│   │
│   ├── guided-nl/
│   │   ├── parser.ts                  # NEW
│   │   ├── structured-preview.ts      # NEW
│   │   └── types.ts                   # NEW
│   │
│   └── tools/
│       └── blueprint-tools.ts         # MODIFY
│
├── components/
│   └── preview_panel/
│       ├── BlueprintEditor.tsx        # MODIFY
│       ├── BlueprintCanvas.tsx        # MODIFY
│       ├── StepDetailPanel.tsx        # NEW
│       ├── GuidedNLEditor.tsx         # NEW
│       ├── BlueprintDiffPreview.tsx   # NEW
│       └── BlueprintProgress.tsx      # NEW
│
├── ipc/
│   └── handlers/
│       ├── blueprint_handlers.ts      # MODIFY
│       └── cognee_handlers.ts         # NEW
│
└── shared/
    ├── blueprint-step-types.ts        # NEW
    ├── blueprint-cache-types.ts       # NEW
    └── guided-nl-types.ts             # NEW
```

---

## Dependencies to Add

```bash
npm install cognee              # Knowledge graph
npm install dependency-cruiser  # Module dependency analysis (optional)
```

---

## Summary

Atlarix 2.2 transforms Blueprint from a visualization into an **intelligent knowledge system**:

| Feature | Description |
|---------|-------------|
| Progressive Extraction | Fast initial load, detail on demand |
| Framework Patterns | Accurate detection of APIs, webhooks, models |
| Cognee Knowledge Graph | Relationship-aware memory that persists |
| Motia-Style UI | Nodes with descriptions, connectors, click-to-expand |
| Guided Natural Language | Users describe in plain English, AI structures |
| Blueprint-Driven Planning | Compare desired vs actual, generate tasks |
| ATLARIX_PLAN.md | Version-controllable task breakdown |

The result: An AI that doesn't just scan your code—it **understands and remembers** your project architecture.

---

**Next Steps:**
1. Phase 1: Framework detection + patterns
2. Phase 2: Blueprint cache structure
3. Phase 3: Cognee integration
4. Phase 4: Progressive extraction flow
5. Phase 5: Motia-style UI
