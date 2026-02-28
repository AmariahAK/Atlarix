# Atlarix v3.5 — Full Build Guide & Cursor Prompt
**For use with Cursor AI — paste sections as needed into Cursor's composer**
**Created by: NorahLabs**
**Target Release: v3.5 (bridge to v4.0)**

---

## TABLE OF CONTENTS

1. [Project Overview & Philosophy](#1-project-overview--philosophy)
2. [Version Roadmap Context](#2-version-roadmap-context)
3. [Cursor Prompt — Full System Prompt for v3.5](#3-cursor-prompt--full-system-prompt-for-v35)
4. [Feature 1 — Two-Stage Auto Router](#4-feature-1--two-stage-auto-router)
5. [Feature 2 — Summarization System Overhaul](#5-feature-2--summarization-system-overhaul)
6. [Feature 3 — Blueprint Intelligence Upgrade](#6-feature-3--blueprint-intelligence-upgrade)
7. [Feature 4 — Visual Explainer Integration (Plan Cards)](#7-feature-4--visual-explainer-integration-plan-cards)
8. [Feature 5 — Agent-to-Agent Communication (Mesh)](#8-feature-5--agent-to-agent-communication-mesh)
9. [Feature 6 — Agent Animation System (Fixed)](#9-feature-6--agent-animation-system-fixed)
10. [Feature 7 — DB Extension (Workforce Preview)](#10-feature-7--db-extension-workforce-preview)
11. [Feature 8 — Extensions System & Left Panel](#11-feature-8--extensions-system--left-panel)
12. [Feature 9 — Enhanced Reviewer Agent](#12-feature-9--enhanced-reviewer-agent)
13. [Feature 10 — ATLARIX_PLAN.md Restructure](#13-feature-10--atlarix_planmd-restructure)
14. [Feature 11 — Reference Projects & Multi-Blueprint](#14-feature-11--reference-projects--multi-blueprint)
15. [Feature 12 — Provider Capability Registry](#15-feature-12--provider-capability-registry)
16. [Code Signing — Windows & macOS](#16-code-signing--windows--macos)
17. [Pricing & Teams Strategy](#17-pricing--teams-strategy)
18. [TODO — Workforce v4.0](#18-todo--workforce-v40)
19. [TODO — Vanguard v5.0](#19-todo--vanguard-v50)
20. [File Structure Map](#20-file-structure-map)

---

## 1. Project Overview & Philosophy

Atlarix is a premium AI coding copilot — a native desktop application (Electron) that combines intelligent code understanding, visual architecture design, and a multi-agent orchestration system. It is not an IDE. It is a **visual operations layer for developers** where the AI does the heavy lifting and the developer approves, guides, and steers.

### Core Principles for v3.5

- **Invisible infrastructure** — routing, summarization, blueprint enrichment happen silently. Users should not feel the system working; they should just experience it working correctly.
- **Provider-agnostic** — every system must work with any configured model from any provider. Nothing hardcoded to a specific model or provider.
- **Permission-first** — every AI action that mutates state (files, DB, configs) goes through the approval queue. No silent mutations.
- **Agents as specialists, not switches** — each agent has a domain. The agent mesh means specialists talk to each other directly, not through main as a relay.
- **Balanced over fast for intelligence tasks** — summarization and blueprint enrichment use balanced models for quality. Fast models handle routing classification and simple tool calls only.

---

## 2. Version Roadmap Context

```
v3.1.0  — Current (workspace storage, .atlarix folder, path fixes)
v3.2    — Code signing, initial reviewer upgrade, agent bus foundation
v3.5    — THIS DOCUMENT (auto router, summarization, blueprint upgrade,
           visual explainer, DB extension preview, extensions panel,
           agent mesh, animation fix, plan restructure)
v4.0    — Workforce full release (CI/CD, Slack, GitHub integration,
           full DB studio, team features, Jira, Log streaming)
v5.0    — Vanguard (multi-workspace, team memory, DevOps agent,
           Data agent, shared blueprints, versioned PR diagrams,
           audit log, priority routing)
```

---

## 3. Cursor Prompt — Full System Prompt for v3.5

> **Instructions for use:** Open Cursor, start a new Composer session, paste this entire block as your first message. Then reference individual feature sections below for specific implementation details.

---

```
You are building Atlarix v3.5, a premium AI coding copilot desktop application built with Electron, React, TypeScript, and React Flow. You have access to the full codebase.

CRITICAL CONTEXT:
- Atlarix is NOT an IDE. It is a visual operations layer for developers.
- All agent actions that mutate state go through a permission queue (FileDiffPanel pattern).
- The app has 8 cloud AI providers + Ollama + LM Studio. Everything must be provider-agnostic.
- Current architecture: Main agent orchestrates, delegates to Research/Architect/Builder/Reviewer agents.
- Existing files: src/lib/agents/, src/lib/blueprint/, src/components/blueprint/, src/lib/context/

YOU ARE IMPLEMENTING v3.5 which includes these systems. Work through them in order:

═══════════════════════════════════════════════════════
SYSTEM 1: TWO-STAGE AUTO ROUTER
═══════════════════════════════════════════════════════
File: src/lib/routing/auto-router.ts (NEW)
File: src/lib/routing/capability-registry.ts (NEW)
File: src/lib/routing/fallback-router.ts (NEW)

The current Auto mode is broken — it classifies but never actually overrides the active model.
Fix this completely.

The router has two stages:
STAGE 1 (heuristic, < 1ms, free):
  - Classify query into: chit_chat | simple_edit | code_generation | debugging |
    architecture | deep_research | security_review | complex_reasoning
  - Use keyword signal arrays for each category
  - If confidence > 0.85, skip Stage 2

STAGE 2 (fast model as meta-router, ~50 tokens, only for ambiguous cases):
  - Call the user's configured fast model with a classification prompt
  - Prompt returns: "category:confidence" e.g. "debugging:0.92"
  - This handles "long simple question" and "short complex question" failure modes

After classification, resolve to a model:
  - Map category → tier (fast/balanced/thinking)
  - Resolve tier → user's configured model for that tier
  - FALLBACK CHAIN: thinking → balanced → fast → last configured model
  - Never error if a tier isn't configured; always find something

For Guided/Autonomous modes:
  - Mode sets a CEILING on tier, auto router operates WITHIN that ceiling
  - Guided: main ceiling=balanced, agents ceiling=fast
  - Autonomous: main ceiling=thinking, agents ceiling=balanced, subagents ceiling=fast
  - Auto router can route BELOW the ceiling (e.g., fast for a simple agent task in Guided)
  - Auto router NEVER exceeds the ceiling for that role

CRITICAL FIX — wire into send flow:
  In src/lib/chat/send-message.ts (or equivalent):
  If auto is enabled, BEFORE calling the LLM:
    1. Run auto router
    2. SET ctx.activeModel = decision.targetModel
    3. SET ctx.activeProvider = decision.targetProvider  
    4. Emit to Activity Stream: { type: 'routing_decision', icon: 'Zap', message: `Auto → ${model} (${category})` }
  
  This override is what's currently missing. The model MUST change before the call.

Show routing preview in chat input (debounced 500ms):
  - Small indicator below textarea: "Auto → claude-sonnet-4-5 · architecture"
  - "Override" button to manually select model for this message only

Settings → AI → Auto Routing section:
  - Fast model selector (with provider dropdown)
  - Balanced model selector
  - Thinking model selector
  - Show routing reasoning in Activity Stream: toggle
  - Exchange threshold for fallback: number input (default 6, range 3-20)

═══════════════════════════════════════════════════════
SYSTEM 2: CAPABILITY REGISTRY
═══════════════════════════════════════════════════════
File: src/lib/routing/capability-registry.ts (NEW)

Every model needs these capabilities stored:
  contextWindow: number
  supportsToolCalling: boolean
  supportsVision: boolean
  tier: 'fast' | 'balanced' | 'thinking'
  provider: string

Fetch at configuration time (when user saves a model), cache in localStorage under
'atlarix:model-capabilities'.

For OpenRouter: call GET /api/v1/models, parse context_length and supported_parameters.
For Anthropic, OpenAI, Google: use their respective model list endpoints.
For unknown providers/models: infer from model name using keyword matching:
  fast:     flash, mini, haiku, small, 3b, 7b, 8b, lite, nano, tiny
  thinking: opus, o1, o3, r1, thinking, reasoning, deep, 70b, 72b, 405b, 671b
  balanced: everything else

Also add manual 3-slot model entry to provider settings:
  - Three inputs: Fast / Balanced / Thinking
  - Plus "Single model for all tiers" toggle
  - "Test tool calling" button that fires a quick tool-use verification call
  - Show inferred tier badge next to each input

═══════════════════════════════════════════════════════
SYSTEM 3: SUMMARIZATION OVERHAUL
═══════════════════════════════════════════════════════
File: src/lib/context/summarization-manager.ts (UPDATE)

Current system is too simple. Replace with trigger-based system:

TRIGGERS (evaluate in order, first match wins):
  1. Token ratio > 0.65 → summarize, urgency HIGH
  2. Token ratio > 0.50 → summarize, urgency NORMAL
  3. Exchange count >= configurable threshold AND context window unknown → summarize
  4. Recent 6 messages have >= 8 tool calls → complexity spike, summarize
  5. Idle time > 3 minutes AND exchanges > 4 → idle opportunity, summarize quietly
  6. Pending task count > 3 AND token ratio > 0.35 → pre-task compact
  7. Agent just switched AND token ratio > 0.30 → agent boundary compact

MODEL SELECTION FOR SUMMARIZATION:
  Priority order:
  1. User's explicit summarization model (Settings → AI → Summarization Model)
  2. If session has > 15 tool calls OR > 5 agent delegations → use balanced model
  3. Default: balanced model (NOT fast — sessions with topic drift need semantic coherence)
  4. Fallback: same model as active session
  
  Rationale: A session that drifts from "how is the weather" to "data structures" to 
  "architecture decisions" requires semantic coherence across topic shifts. Fast models 
  lose this. Balanced models handle it correctly. The token cost is justified because 
  a bad summary actively harms the next part of the session.

TOKEN ESTIMATION (no API call needed):
  ~4 characters per token (accurate enough for trigger decisions)
  Add 200 tokens overhead per tool call
  This is for TRIGGERING only, not billing

PER-AGENT SUMMARIZATION in Guided/Autonomous:
  Each agent has its own message thread
  Summarize per-agent independently
  Compaction thresholds by agent role:
    main:       0.60 (compact earlier — orchestration decisions most critical)
    architect:  0.65
    builder:    0.70
    reviewer:   0.70
    researcher: 0.75 (research results most disposable)

WORKSPACE vs EPHEMERAL:
  Workspace sessions: full pipeline, write to .atlarix/memory.md on compact
  Non-workspace sessions: single summary only at 65% token usage, no persistence

SUMMARY SYSTEM PROMPT (provider-agnostic, works with any model):
  "You are compressing a coding session for context window management.
   Create a dense summary preserving:
   1. What the user is building (the goal)
   2. What has been completed (files created/modified, decisions made)
   3. What is in progress or blocked
   4. Critical technical decisions and why they were made
   5. Errors encountered and how resolved
   6. Active file paths and current state
   Be specific. Include file names, function names, variable names.
   Vague summaries are useless. Target: 400-600 words.
   Format as structured markdown. No pleasantries."

═══════════════════════════════════════════════════════
SYSTEM 4: BLUEPRINT INTELLIGENCE UPGRADE
═══════════════════════════════════════════════════════
Files: src/lib/blueprint/enricher.ts (UPDATE)
       src/lib/blueprint/rte-parser.ts (UPDATE)
       src/lib/blueprint/reference-manager.ts (NEW)

ENRICHMENT MODEL CHANGE:
  Change from fast model to balanced model for enrichment.
  Rationale: large monorepos have complex interdependent nodes. Fast models produce
  vague descriptions ("handles user operations"). Balanced produces specific ones
  ("accepts POST /users/:id/permissions, validates JWT scope, writes to user_roles 
  junction table, emits permissions:updated event"). The specificity is what makes
  Blueprint useful to agents and users.

CONCURRENT ENRICHMENT:
  Run enrichment in parallel batches of 10 nodes (not sequential).
  Show loading animation while enrichment runs (Blueprint canvas skeleton state).
  A 40-node project goes from ~40s sequential to ~4s parallel.
  
  Implementation:
    async enrichAll(nodes: BlueprintNode[]) {
      const unenriched = nodes.filter(n => !cache.has(n.contentHash));
      if (unenriched.length === 0) return; // fully cached, instant
      for (const batch of chunk(unenriched, 10)) {
        await Promise.all(batch.map(n => enrichNode(n)));
      }
    }

CACHING STRATEGY:
  Cache key: contentHash of the node's source code (not file path, not node ID)
  This means: if the code doesn't change, zero LLM calls on subsequent opens
  Cache location: ~/.atlarix/blueprints/{projectHash}/enrichment-cache.json
  Invalidation: only when contentHash changes (file modified)

ENRICHMENT OUTPUT PER NODE (save all of this):
  description: one specific sentence about what this node does
  inputs: array of strings ["POST body: {email, password}", "Bearer token header"]
  outputs: array of strings ["JWT access token", "refresh token", "error 401"]
  dataFlows: array of {to: nodeId, label: string} for animated edges
  
ENRICHMENT PROMPT (balanced model, max 150 tokens per node):
  "You are enriching a blueprint node for a developer tool.
   Given RTE-parsed code data, write:
   1. A 1-sentence specific description (not vague — name the actual data/operations)
   2. inputs[] — what data this node receives (format, type, source)
   3. outputs[] — what data this node produces or emits
   4. dataFlows[] — which other nodes this connects to and what data moves
   Reply as JSON only. No preamble."

REFERENCE PROJECTS:
  Allow users to add reference projects to a workspace.
  Each reference project gets its own .atlarix/ folder and blueprint.
  
  Auto-parse on workspace open (before first AI message):
    1. Parse all projects concurrently (RTE — no LLM, fast)
    2. Enrich all new/changed nodes (balanced model, batched)
    3. Detect cross-project edges structurally (imports, shared types, API calls)
    4. Build combined blueprint with markers: [PRIMARY] [REF: months-of-year]
    5. Inject into agent context before first message
  
  Cross-project edge detection (no LLM needed):
    For each node's dependencies/imports, check if it matches any node in another project
    If match found → create edge with type: 'cross-project' and source/target project IDs
  
  Combined blueprint storage:
    ~/.atlarix/combined/{workspaceId}/combined-blueprint.json
    Keep small: structural data only (nodes, edges, types, names, descriptions)
    No full code, no embeddings in the committed file
    
  AI tool for mid-session addition (rare case):
    Tool: add_reference_project(path: string)
    Triggers same pipeline as workspace open
    Updates combined blueprint and re-injects context

FILE STRUCTURE for multiple projects:
  .atlarix/
  ├── memory.md
  ├── ATLARIX.md
  └── plans/
      ├── _index.md          ← master index (agents read this first)
      ├── backend.md
      ├── frontend.md
      ├── database.md
      └── devops.md          ← populated in Workforce/Vanguard

═══════════════════════════════════════════════════════
SYSTEM 5: VISUAL EXPLAINER PLAN CARDS
═══════════════════════════════════════════════════════
Files: src/lib/plan/plan-card-renderer.ts (NEW)
       src/components/chat/PlanCard.tsx (NEW)
       src/lib/plan/plan-manager.ts (UPDATE)

The visual-explainer (github.com/nicobailon/visual-explainer) approach is adapted
for Atlarix inline rendering. Do NOT open a browser window. Render inline below
AI responses as a card component.

PLAN CARD — shown in Ask mode after AI generates or modifies a plan:
  - Appears as a card BELOW the AI response (not collapsed, open by default)
  - Similar visual treatment to the "thinking" block — secondary card style
  - Uses visual-explainer's data-table CSS patterns rendered as React
  - NOT a separate UI — inline in the chat flow

PLAN CARD CONTENT:
  - Header: task count, estimated sessions, [Edit] button
  - Tasks grouped by domain: Backend / Frontend / Database / DevOps / Other
  - Each task shows: status badge (TBD grey / In Progress amber / Done green),
    description, assigned agent icon (Lucide), dependencies (small badges)
  - Footer: [Looks good — Switch to Build] [Keep refining] buttons

PLAN CARD INTERACTIVITY (Ask mode only):
  - Tasks are clickable — user can mark as done, edit description, change priority
  - Drag to reorder within a domain group
  - Add task button at bottom of each group
  - All edits write back to .atlarix/plans/{domain}.md immediately

SWITCHING TO BUILD MODE:
  When user clicks "Switch to Build":
  1. Lock the plan (status = 'locked', lockedAt = timestamp)
  2. Sync to .atlarix/plans/ files
  3. Update Blueprint to reflect planned architecture (add planned nodes as ghost nodes)
  4. Switch permission mode to 'build'
  5. Dismiss the plan card (it's now in the Blueprint panel)

TASK CARDS FOR COMPLETED WORK:
  After Builder completes a batch of changes, show a completion card:
  - Uses diff-review visual template style
  - Shows: files changed, tasks marked done (green), any issues found
  - Compact — not as large as the planning card

PLAN FILES — SEPARATE SPEC FROM PLAN:
  .atlarix/spec.md — TECHNICAL SPECIFICATION (rarely changes after creation)
    Created by Architect on project start
    Contains: stack, patterns, API design decisions, auth approach
    NOT a task list

  .atlarix/plans/_index.md — MASTER INDEX
    | Plan | Tasks | Status | Last Updated |
    Agents read this first to orient themselves

  .atlarix/plans/backend.md — TASK PLAN for backend
  .atlarix/plans/frontend.md — TASK PLAN for frontend
  .atlarix/plans/database.md — TASK PLAN for DB changes
  
  Each plan file header must include:
    <!-- Created by: Architect agent -->
    <!-- Domain: backend -->
    <!-- Read by: All agents -->

  This prevents the AI from confusing spec.md with a task file.
  Update all agent system prompts to reference this file structure explicitly.

═══════════════════════════════════════════════════════
SYSTEM 6: AGENT-TO-AGENT COMMUNICATION (MESH)
═══════════════════════════════════════════════════════
Files: src/lib/agents/bus.ts (NEW or UPDATE)
       src/lib/agents/orchestrator.ts (NEW)
       src/lib/agents/animation-state.ts (NEW)

AGENT BUS — replace hub-and-spoke with a message bus:
  interface AgentMessage {
    id: string
    from: AgentId  // 'main' | 'researcher' | 'architect' | 'builder' | 'reviewer'
    to: AgentId | 'broadcast'
    type: 'request' | 'response' | 'notification' | 'conflict' | 'question'
    topic: string
    payload: unknown
    requiresResponse: boolean
    timeout?: number          // ms, default 30000
    parentMessageId?: string  // for threading
    timestamp: number
  }

  AgentBus.send(message) — fire and forget
  AgentBus.request(message) — returns Promise<AgentMessage> with timeout

MAIN AS OBSERVER (not always relay):
  Main ALWAYS observes all bus messages passively
  Main ONLY intervenes when:
    - Circular conversation detected (same topic ping-ponging 3+ times)
    - Conflict escalating (agents disagree and neither yields after 2 exchanges)
    - Scope drift detected (topic diverged from the original task)
    - Critical error from monitor agent
  
  When main intervenes, it broadcasts to all agents:
    { from: 'main', to: 'broadcast', type: 'notification', 
      topic: 'orchestrator_intervention', payload: { reason, directive } }

DIRECT AGENT CONVERSATIONS (the key new behavior):
  
  Reviewer → Builder (spec mismatch):
    Reviewer detects code doesn't match spec → sends 'question' to Builder directly
    Builder responds with reasoning → Reviewer either accepts or sends 'fix_required'
    Builder self-corrects → Reviewer approves
    Main observes but does NOT intervene unless they loop

  Architect → Researcher (blueprint design):
    Architect designing a new integration → sends 'request' to Researcher
    Researcher returns findings → Architect uses them in blueprint design
    Never goes through Main

  Error Monitor → Router (new in v3.5):
    Runtime error detected → classify error type → route to correct agent directly
    Build errors → Builder
    Security errors → Reviewer  
    Architecture mismatches → Architect
    Unknown → Main

ACTIVITY STREAM — show agent messages:
  Every bus message emits to Activity Stream:
  { type: 'agent_message', icon: 'ArrowRight', 
    message: `${from} → ${to}: ${topic}` }
  
  Direct agent conversations shown as indented thread in Activity Stream
  Main interventions shown with special 'Brain' icon and amber color

═══════════════════════════════════════════════════════
SYSTEM 7: AGENT ANIMATION SYSTEM (COMPLETE REWRITE)
═══════════════════════════════════════════════════════
Files: src/lib/agents/animation-state.ts (NEW)
       src/components/blueprint/AgentNode.tsx (UPDATE)
       src/components/blueprint/AgentMessageEdge.tsx (NEW)

The current animation system does not work. Completely replace it.

ROOT CAUSE OF CURRENT FAILURE:
  Animation state is not centralized. Components don't react to agent events.
  React Flow edge animated:true uses CSS stroke-dasharray which has CPU issues at scale.

SOLUTION — Zustand animation store as single source of truth:

  useAgentAnimStore (Zustand):
    agentStates: Record<AgentId, AgentAnimState>
    activeFlows: MessageFlowState[]
    setAgentState(agentId, state)
    startFlow(flow)
    endFlow(id)

  AgentAnimState: 'idle' | 'thinking' | 'delegating' | 'reviewing' | 'waiting' | 'error' | 'done'

WIRE STORE TO AGENT BUS:
  In AgentBus.send():
    setAgentState(message.from, 'delegating')
    if message.to !== 'broadcast': setAgentState(message.to, 'waiting')
    startFlow({ id, from, to, type: 'request' })
    setTimeout(() => { endFlow(id); setAgentState(from, 'idle') }, DURATION_MS)
  
  In LLM streaming handlers:
    onStreamStart: setAgentState(activeAgent, 'thinking')
    onStreamEnd: setAgentState(activeAgent, 'idle')
    onToolCall: setAgentState(activeAgent, 'delegating')

AGENT NODE (Framer Motion):
  State → visual mapping:
    idle:       border-slate-600, no glow, icon opacity 60%
    thinking:   border-blue-400, blue glow pulse (1.5s loop), spinning ring overlay
    delegating: border-amber-400, amber glow, pulsing dot top-right corner
    reviewing:  border-purple-400, purple glow
    waiting:    border-slate-400, no glow, icon opacity 40%
    error:      border-red-400, red glow
    done:       border-green-400, green glow (fades after 2s back to idle)
  
  State label: small text below node, only visible when not idle
  
  Thinking animation: spinning partial border using Framer Motion rotate loop
  Delegating animation: pulsing dot at top-right corner (scale 1→1.4→1 loop)

PARTICLE EDGE — SVG animateMotion (NOT stroke-dasharray):
  Use <animateMotion> for particle traversal along Bezier path
  Each active flow creates one animated particle per message
  
  Particle colors by type:
    request:  amber  #f59e0b
    response: green  #22c55e
    review:   purple #a855f7
    fix:      blue   #3b82f6
  
  Particle: circle r=5 with radialGradient for glow effect
  Trailing: ellipse following behind with opacity 0.3
  Duration: 1.2s per traversal, stagger multiple simultaneous flows by 0.3s
  
  repeatCount="1" fill="freeze" — particle disappears after traversal (not looping)

AGENT CANVAS LAYOUT:
  Fixed positions for agent nodes:
    main:       center top    { x: 300, y: 50 }
    researcher: left middle   { x: 100, y: 200 }
    architect:  center middle { x: 300, y: 200 }
    builder:    right middle  { x: 500, y: 200 }
    reviewer:   center bottom { x: 300, y: 350 }
  
  Edges define ALL possible communication paths (both directions):
    main ↔ researcher, main ↔ architect, main ↔ builder, main ↔ reviewer
    reviewer ↔ builder (direct, new in v3.5)
    architect ↔ researcher (direct, new in v3.5)
    builder ↔ reviewer (direct, new in v3.5)
  
  Edge type: 'agentMessage' (custom type using AgentMessageEdge component)
  Edge animation: triggered by particle flows, NOT edge.animated = true

═══════════════════════════════════════════════════════
SYSTEM 8: DB EXTENSION (WORKFORCE PREVIEW — PRO FEATURE)
═══════════════════════════════════════════════════════
Files: src/lib/workforce/db-extension/ (NEW DIRECTORY)
       src/components/extensions/DBPanel.tsx (NEW)

Available to Pro users as an extension preview. Full Workforce in v4.

DB CONNECTIONS — user-configured, never auto-detected:
  Per workspace: dev connection + prod connection (optional staging)
  Stored globally (reusable across workspaces), workspace references by connection ID
  Active connection: one at a time per workspace
  Switching to prod: confirmation modal with red warning color

CONNECTION CONFIG:
  interface DBConnection {
    id: string
    name: string
    type: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 
          'elasticsearch' | 'mssql' | 'cassandra'
    config: { host, port, username, password, database, ssl, connectionString }
    isProd: boolean
    status: 'connected' | 'disconnected' | 'error'
    schema?: DBSchema    // cached after first connect
  }

DEPENDENCIES:
  npm install knex            // query builder, PG/MySQL/SQLite/MSSQL
  npm install pg              // PostgreSQL
  npm install mysql2          // MySQL
  npm install better-sqlite3  // SQLite
  npm install mongodb         // MongoDB

AI CONTEXT INJECTION — the key to accuracy:
  Before EVERY agent message when DB is active, inject schema into system prompt:
  
  "## Active Database: {name} ({type})
   ### Schema
   {tableName} ({rowCount} rows)
     - {columnName}: {type} [NOT NULL] [PK] [→ referencedTable.column]
   ### Relationships
   {table}.{col} → {refTable}.{refCol}
   ### Sample Data (dev only, 5 rows max, hidden for prod)
   [table preview]"
  
  This means AI understands structure BEFORE writing queries.
  AI knows column types, FK relationships, row counts, actual data formats.
  For prod: show schema only, NO sample data (privacy/security).

DB TOOLS (added to agent tool registry):
  db_query:      read-only, permission level 'ask', always requires approval
  db_mutate:     write operations, permission level 'build', shown with red warning
  db_schema:     get full schema, permission level 'ask'
  db_list:       list connections, permission level 'ask'

DB DIFF PANEL (mirrors FileDiffPanel for code):
  Show schema before/after for DDL changes
  Risk indicator: 'safe' | 'destructive' | 'irreversible'
  Irreversible changes (DROP TABLE, DROP COLUMN) show red warning banner
  SQL preview with syntax highlighting
  AI reasoning: why the AI wants to make this change
  [Execute] [Reject] buttons

DB PANEL UI (left sidebar extension):
  Schema tree: collapsible, shows tables → columns → indexes → FK relationships
  Table view: click table to see data (paginated, 50 rows)
  Query editor: small SQL input, results below
  Connection status badge: green dot / red dot
  "AI is querying..." indicator when AI uses db tools
  Animate schema tree updates (new column appears with green flash)

═══════════════════════════════════════════════════════
SYSTEM 9: EXTENSIONS SYSTEM & LEFT PANEL
═══════════════════════════════════════════════════════
Files: src/lib/extensions/extension-registry.ts (NEW)
       src/components/layout/LeftPanel.tsx (NEW)
       src/components/layout/ExtensionsIcon.tsx (NEW)

EXTENSION ICON PLACEMENT:
  Bottom of the app in the status bar / bottom bar
  Near the user/login button area (similar to VS Code / Cursor placement)
  Uses a custom icon — not the VS Code puzzle piece, design something distinct
  
EXTENSION PHILOSOPHY:
  Atlarix extensions are NOT VS Code extensions
  They are VISUAL PANELS that give the AI and user new information surfaces
  Each extension: adds a panel to the left sidebar AND adds tools to the AI
  
  Available to Pro users in v3.5 (preview):
  - DB Studio (implemented in v3.5)
  - More in v4.0 (CI/CD, GitHub, Slack, Jira)

LEFT PANEL:
  Appears when at least one extension is active
  Mirror of right panel (Blueprint/Activity) but on the left
  Width: same as right panel (collapsible)
  Max 5 extension slots (tabs at top of left panel)
  
  Tab structure: icon only when collapsed, icon + name when expanded
  Active extension highlighted
  Close button per tab (removes from left panel, doesn't uninstall)

EXTENSION MANAGER:
  Clicking extensions icon opens an Extension Manager modal
  Shows: available extensions, installed extensions, active extensions
  
  Available extensions (v3.5 — Pro only):
  ┌─────────────────────────────────────────────────────┐
  │ 🗄️ DB Studio          [Add to Panel]   PRO          │
  │   Connect to any database. AI sees live schema.     │
  └─────────────────────────────────────────────────────┘
  
  v4.0 extensions (shown as "Coming in Workforce"):
  ┌─────────────────────────────────────────────────────┐
  │ ⚙️  CI/CD Monitor      [Workforce]                  │
  │ 🐙 GitHub              [Workforce]                  │  
  │ 💬 Slack               [Workforce]                  │
  │ 📋 Jira                [Workforce]                  │
  │ 📊 Log Streamer        [Workforce]                  │
  └─────────────────────────────────────────────────────┘

EXTENSION REGISTRY:
  interface Extension {
    id: string
    name: string
    icon: LucideIconName
    description: string
    tier: 'free' | 'pro' | 'workforce' | 'vanguard'
    panelComponent: React.ComponentType
    tools: Tool[]          // AI tools this extension adds
    contextInjector?: () => string  // optional system prompt injection
  }

═══════════════════════════════════════════════════════
SYSTEM 10: ENHANCED REVIEWER AGENT
═══════════════════════════════════════════════════════
Files: src/lib/review/static-analyzer.ts (NEW)
       src/lib/review/qodo-prompt-adapter.ts (NEW)
       src/lib/review/lightning-review-memory.ts (NEW)
       src/lib/agents/reviewer.ts (UPDATE)

LAYER 1 — STATIC ANALYSIS (zero LLM cost, < 100ms):
  npm install @ast-grep/napi
  npm install oxlint
  
  Run on every file write by Builder agent
  Does NOT block the build flow — runs async, reports to Activity Stream
  
  Security patterns to check (TypeScript):
    - Hardcoded secrets: const $KEY = '$VALUE' pattern
    - eval() usage
    - innerHTML assignment
    - Prototype pollution: obj['__proto__']
    - Agent bus mutations without permission check (Atlarix-specific rule)
  
  Output: ReviewIssue[] with severity, rule, line, file, message, optional fix

LAYER 2 — SEMANTIC AI REVIEW (balanced model, only on significant changes):
  Adapted from Qodo PR-Agent prompt structure
  
  Review categories:
    1. Security (injection, auth bypass, exposed secrets, permission bypass)
    2. Logic & Correctness (matches ATLARIX_PLAN.md? edge cases? regressions?)
    3. Agent Protocol Compliance (correct permission levels, message schema valid?)
    4. Architecture Consistency (aligns with Blueprint? new nodes represented?)
    5. Performance (N+1 queries, token budget impact on LLM calls)
  
  Output format (JSON):
    {
      verdict: 'approved' | 'needs_changes' | 'critical_issues'
      score: 0-100
      issues: [{ severity, category, file, line, message, suggested_fix, agent_action }]
      summary: string (for Activity Stream)
      lightning_signal: { pattern, resolution_hint }
    }
  
  agent_action values: 'notify_builder' | 'notify_architect' | 'escalate_to_main' | null
  
  When agent_action is set, Reviewer sends directly via Agent Bus (not through main)

LAYER 3 — AGENT LIGHTNING MEMORY:
  After each review+fix cycle, record the pattern to SQLite
  
  Table: review_patterns
    workspace_id, issue_rule, issue_context, fix_applied, accepted, timestamp
  
  Before running LLM review, check if this exact pattern was seen before:
    If known pattern with accepted fix → suggest fix directly (skip LLM call)
    This grows more accurate per workspace over time

REVIEWER IN AGENT MESH:
  Reviewer talks directly to Builder for spec mismatches and fix requests
  Reviewer talks directly to Architect for blueprint violations
  Reviewer escalates to Main only for critical_issues verdict
  Main observes all reviewer conversations passively

═══════════════════════════════════════════════════════
WHAT TO FIX/REMOVE/CLEAN UP
═══════════════════════════════════════════════════════

REMOVE:
  - Any hardcoded model names or context window sizes
  - The spec.md-as-task-plan pattern (separate spec.md from plans/ directory)
  - Edge animated:true on React Flow agent communication edges (replace with particles)
  - Any auto mode that doesn't actually override the active model

FIX:
  - Auto mode must ACTUALLY change the model before the LLM call
  - Agent animations must read from Zustand store (not ad-hoc state)
  - Blueprint enrichment must be concurrent (not sequential)
  - Summarization must use balanced model (not fast)

REFINE:
  - Activity Stream: agent-to-agent messages should show as threaded conversations
  - Permission queue: add DB diff panel alongside file diff panel
  - Settings → AI: reorganize to include Auto Routing section with tier model selectors
  - Workspace open sequence: parse all projects first, then enrich, then allow first message
```

---

## 4. Feature 1 — Two-Stage Auto Router

### File Structure
```
src/lib/routing/
├── auto-router.ts          ← main router logic
├── capability-registry.ts  ← model capabilities cache
├── fallback-router.ts      ← single-model fallback
└── signal-sets.ts          ← keyword arrays for classification
```

### Signal Sets Reference

```typescript
// src/lib/routing/signal-sets.ts

export const ARCHITECTURE_SIGNALS = [
  'design', 'architecture', 'blueprint', 'structure', 'system design',
  'database schema', 'api design', 'refactor', 'restructure', 'how should i',
  'what approach', 'pattern', 'scalable', 'monolith', 'microservice',
  'how would you', 'best way to build', 'scaffold'
];

export const SECURITY_SIGNALS = [
  'security', 'vulnerability', 'exploit', 'auth', 'permission',
  'sql injection', 'xss', 'csrf', 'audit', 'sanitize', 'encrypt',
  'token', 'secret', 'password', 'hash', 'certificate', 'oauth'
];

export const RESEARCH_SIGNALS = [
  'how does', 'what is', 'explain', 'compare', 'best practice',
  'research', 'find', 'look up', 'alternatives to', 'vs ', 'versus',
  'pros and cons', 'tradeoff', 'difference between', 'should i use'
];

export const DEBUG_SIGNALS = [
  'error', 'bug', 'fix', 'broken', 'not working', 'failing',
  'crash', 'exception', 'undefined', 'null', 'typeerror', 'cannot read',
  'unexpected', 'wrong output', 'doesnt work', "doesn't work", 'issue'
];

export const REASONING_SIGNALS = [
  'should i', 'trade-off', 'pros and cons', 'approach', 'think through',
  'strategy', 'plan', 'optimize', 'improve', 'evaluate', 'decide',
  'recommend', 'advise', 'weigh', 'consider'
];

export const CHIT_CHAT_PATTERNS = [
  /^(ok|okay|thanks|thank you|got it|sounds good|great|perfect|done|yes|no|sure)\.?$/i,
  /^(can you|please|could you)\s+(continue|proceed|go ahead|keep going)/i,
  /^(hello|hi|hey|sup|what's up)/i,
];

export const FAST_MODEL_KEYWORDS = [
  'flash', 'mini', 'haiku', 'small', '3b', '7b', '8b', 'lite', 'nano', 'tiny'
];

export const THINKING_MODEL_KEYWORDS = [
  'opus', 'o1', 'o3', 'r1', 'thinking', 'reasoning', 'deep', '70b', '72b', '405b', '671b'
];
```

### Tier Ceiling Table (for Guided/Autonomous modes)

| Mode | Role | Ceiling | Auto router range |
|------|------|---------|-------------------|
| Guided | Main | balanced | fast or balanced |
| Guided | Agents | fast | fast only |
| Autonomous | Main | thinking | fast, balanced, or thinking |
| Autonomous | Agents | balanced | fast or balanced |
| Autonomous | Sub-agents | fast | fast only |
| Direct (any) | Main | thinking | full auto routing |

### Fallback Chain

```
User configured: thinking + balanced + fast → use matched tier
User configured: balanced + fast only → thinking falls back to balanced
User configured: fast only → all tiers use fast
User configured: single manual model → all tiers use that model
No model configured → show "Configure a model first" error, never crash
```

---

## 5. Feature 2 — Summarization System Overhaul

### Trigger Priority Table

| Priority | Trigger | Condition | Urgency | Note |
|----------|---------|-----------|---------|------|
| 1 | Token pressure high | ratio > 0.65 | HIGH | Immediate |
| 2 | Token pressure normal | ratio > 0.50 | NORMAL | Queue for next idle moment |
| 3 | Exchange fallback | count >= threshold AND window unknown | NORMAL | Safety net |
| 4 | Complexity spike | >= 8 tool calls in last 6 messages | NORMAL | |
| 5 | Idle opportunity | idle > 3min AND exchanges > 4 | LOW | Silent, no notification |
| 6 | Pre-task compact | pending tasks > 3 AND ratio > 0.35 | NORMAL | Before autonomous run |
| 7 | Agent boundary | agent just switched AND ratio > 0.30 | LOW | Per-agent |

### Model Selection Decision Tree

```
Has explicit summarization model configured in settings?
  YES → use it
  NO → Is this a complex session? (tool calls > 15 OR delegations > 5)
    YES → use configured balanced model
    NO → use configured balanced model (balanced is always default)
         if balanced not configured → use same as active session model
         if nothing configured → show error, don't crash
```

**Why balanced, not fast?** A session that drifts from "how is the weather" to "data structures" to "architecture decisions" requires semantic coherence to compress correctly. Fast models lose coherence across topic shifts. The summary is the foundation for the rest of the session — a bad summary compounds errors. The token cost of balanced for a 400-600 word summary is justified.

### Per-Agent Compaction Thresholds

```typescript
const AGENT_COMPACTION_THRESHOLDS: Record<AgentId, number> = {
  main:       0.60,  // compact early — orchestration decisions are most critical to preserve fully
  architect:  0.65,  // architectural decisions important but less volatile
  builder:    0.70,  // builder is more stateless (files are the record, not the chat)
  reviewer:   0.70,  // reviewer findings are summarizable
  researcher: 0.75,  // research results are the most compressible/disposable
};
```

### Non-Workspace vs Workspace Sessions

```
Non-workspace (ephemeral):
  - Single summary trigger at 65% token usage
  - No persistence
  - No memory.md write
  - Simpler prompt (no project context needed)
  - When tab closes: everything gone

Workspace:
  - Full trigger pipeline (all 7 triggers active)
  - Write to .atlarix/memory.md on every compaction
  - memory.md format:
    # Session Memory — last compacted [timestamp]
    ## Goal
    [what we're building]
    ## Completed
    [files, decisions]
    ## In Progress
    [current task]
    ## Decisions
    [technical decisions and why]
```

---

## 6. Feature 3 — Blueprint Intelligence Upgrade

### The Two-Step Pipeline (Keep Separate)

```
STEP 1: RTE PARSING
  Tool: ast-grep, language-specific parsers
  Cost: zero LLM tokens
  Trigger: file save, workspace open
  Output: raw graph (nodes, edges, function signatures, imports, call graphs)
  Speed: < 1 second per file, < 5 seconds for large monorepo
  
STEP 2: BALANCED MODEL ENRICHMENT  
  Tool: user's configured balanced model
  Cost: ~150 tokens per unenriched node
  Trigger: after RTE parsing, only for nodes with no cached enrichment
  Output: descriptions, inputs[], outputs[], dataFlows[]
  Speed: concurrent batches of 10, ~4s for 40 nodes
  Cache: never re-run if contentHash unchanged
```

### Loading States During Enrichment

While enrichment runs (which can take a few seconds for large projects), show the user something meaningful rather than a spinner:

```
Blueprint loading sequence:
1. "Parsing codebase structure..." (RTE running, instant visual)
   → Show skeleton nodes appearing one by one (staggered animation)
2. "Understanding your code..." (balanced model enriching, batched)
   → Show node cards filling in with descriptions as each batch returns
   → Progress: "12 / 40 nodes enriched"
3. "Blueprint ready" (fully enriched, cached)
   → Full canvas with all descriptions visible
   → Data flow edges animate in
```

### Node Card — What Changes in v3.5

**Before (current):**
```
[API] /users/login
```

**After (v3.5 with balanced enrichment):**
```
[API] POST /users/login
Accepts: {email: string, password: string} in body
         Bearer token optional (auto-refresh flow)
Returns: JWT access token (15min), refresh token (7d)
         Error 401 on invalid credentials
Connects to: → UsersDB (SELECT), → SessionsCache (WRITE)
```

### Reference Project Combined Blueprint

When a reference project is added:
- Both projects appear on the same canvas
- Primary project nodes: normal styling
- Reference project nodes: slightly muted, with small project badge `[REF]`
- Cross-project edges: dashed line, different color from same-project edges
- Toggle in Blueprint header: [All Projects] [Primary Only] [REF: months-of-year]

---

## 7. Feature 4 — Visual Explainer Integration (Plan Cards)

### Plan Card Component Spec

The visual-explainer approach is implemented as a React component, NOT by generating HTML files and opening a browser. The CSS patterns and layout ideas from visual-explainer are adapted inline.

```
PLAN CARD ANATOMY:
┌──────────────────────────────────────────────────────────┐
│ 📋 Implementation Plan                           [Edit]  │
│    12 tasks  ·  ~3 sessions  ·  0 critical       [⋮]    │
├──────────────────────────────────────────────────────────┤
│ BACKEND                                          3/5 ✓   │
│ ● Create /api/auth/login            [Builder] TBD        │
│ ● JWT generation + refresh logic    [Builder] TBD        │
│ ✓ Database connection setup         [Builder] Done       │
│                                                          │
│ FRONTEND                                         0/4 ✓   │
│ ● Login form component              [Builder] TBD        │
│ ● Auth context provider             [Builder] TBD        │
│                                                          │
│ DATABASE                                         2/3 ✓   │
│ ✓ Add sessions table                [Builder] Done       │
│ ✓ Add refresh_tokens table          [Builder] Done       │
│ ● Add index on sessions.user_id     [Builder] TBD        │
├──────────────────────────────────────────────────────────┤
│ [← Keep refining]              [Switch to Build mode →]  │
└──────────────────────────────────────────────────────────┘
```

### Plan Card Placement

```
Chat area layout when plan exists:

[AI Response message bubble]
─────────────────────────────
[PLAN CARD — open by default]  ← appears here, below response
─────────────────────────────
[Chat input area]
```

The plan card is NOT auto-collapsed. It stays open until the user switches to Build mode. It can be manually minimized to a one-line summary bar by clicking a chevron.

### Completion Card (After Build)

When Builder completes a task batch:

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Task batch complete                        [View diff] │
│   3 files modified  ·  2 tasks done  ·  0 issues        │
│   auth/login.ts  ·  auth/middleware.ts  ·  types/auth.ts │
└──────────────────────────────────────────────────────────┘
```

Compact, informative, dismissible. Does not block the chat flow.

---

## 8. Feature 5 — Agent-to-Agent Communication (Mesh)

### Message Flow Examples

**Reviewer → Builder (spec mismatch):**
```
Reviewer detects: auth middleware uses API key check, spec says JWT
Reviewer sends to Builder (not Main):
  { type: 'question', topic: 'spec_mismatch',
    payload: { file: 'middleware/auth.ts', line: 42,
      question: 'Spec requires JWT validation but I see API key check. Intentional?' } }

Builder responds:
  Option A: { type: 'response', payload: { intentional: false } }
    → Builder self-corrects, Reviewer re-reviews
  Option B: { type: 'response', payload: { intentional: true, reasoning: 'legacy endpoint' } }
    → Reviewer updates spec understanding, marks as intentional exception

Main observes this entire exchange but does NOT intervene.
Activity Stream shows: "Reviewer → Builder: spec_mismatch" (indented thread)
```

**Architect → Researcher (new integration design):**
```
Architect needs to design Stripe integration
Architect sends to Researcher:
  { type: 'request', topic: 'research_required',
    payload: { query: 'Stripe webhook security best practices 2025',
               depth: 'focused', maxSources: 3 } }

Researcher returns findings directly to Architect.
Architect designs blueprint with research context.
Main never involved.
Activity Stream shows: "Architect → Researcher: research_required"
```

**Error Monitor → Builder (auto-fix flow):**
```
Runtime TypeError caught in dev server
Error monitor classifies: build error
Sends to Builder:
  { type: 'notification', topic: 'runtime_error',
    payload: { error, file: 'components/Login.tsx', line: 23,
               suggestion: 'Property email may be undefined — add optional chaining' } }

Builder receives, proposes fix, goes through permission queue as normal.
No user interruption until the fix is ready for approval.
```

### Activity Stream Threading

```
Normal delegation (hub-and-spoke, current):
  > Main → Architect: design_auth_system

New direct conversation (mesh, v3.5):
  > Reviewer: detected spec mismatch in middleware/auth.ts
    ↳ Reviewer → Builder: spec_mismatch (awaiting response)
    ↳ Builder → Reviewer: intentional: false, will fix
    ↳ Reviewer → Builder: fix_required (patch provided)
    ↳ Builder: applying fix to middleware/auth.ts
    ↳ Reviewer: re-reviewing...
    ↳ Reviewer: approved ✓
```

---

## 9. Feature 6 — Agent Animation System (Fixed)

### Why the Current System Fails

The current system almost certainly fails because:
1. Animation state is local to components, not centralized
2. Agent events don't emit to a shared reactive store
3. React Flow `animated: true` has CSS-level problems at scale
4. The canvas may not re-render when agent state changes

### The Fix — Complete Rewrite

All animation state lives in Zustand. Components subscribe to it. The AgentBus writes to it. This is the only pattern that works reliably in React.

```typescript
// The store is the ONLY source of truth for animation state
// Nothing else tracks "is this agent thinking right now"
// This eliminates the sync bugs completely

import { create } from 'zustand';

export const useAgentAnimStore = create<AgentAnimStore>((set, get) => ({
  agentStates: {
    main: 'idle', researcher: 'idle', architect: 'idle',
    builder: 'idle', reviewer: 'idle'
  },
  activeFlows: [],
  
  setAgentState: (agentId, state) =>
    set(s => ({ agentStates: { ...s.agentStates, [agentId]: state } })),
  
  startFlow: (flow) =>
    set(s => ({ 
      activeFlows: [...s.activeFlows, { ...flow, progress: 0, active: true }] 
    })),
  
  endFlow: (id) =>
    set(s => ({ activeFlows: s.activeFlows.filter(f => f.id !== id) })),
    
  clearAll: () =>
    set(() => ({
      agentStates: { main: 'idle', researcher: 'idle', architect: 'idle',
                     builder: 'idle', reviewer: 'idle' },
      activeFlows: []
    }))
}));
```

### Animation Performance Notes

Use `<animateMotion>` SVG not Framer Motion for the edge particles. Framer Motion is correct for node state animations (glow, pulsing, spinning ring) but has overhead when applied to many simultaneous path animations. SVG native animations run on the compositor thread and don't block React rendering.

For the glow pulse on the thinking node: use Framer Motion `animate` with `boxShadow` array — this is one of the few cases where Framer Motion's spring physics actually helps (the glow feels organic, not mechanical).

---

## 10. Feature 7 — DB Extension (Workforce Preview)

### Safety Architecture

The DB extension has strict safety layers because database mutations are irreversible:

```
Layer 1: PERMISSION QUEUE (all mutations)
  No DB write happens without appearing in the permission queue first
  User must explicitly approve before execution
  This is the same pattern as file writes — no exceptions

Layer 2: RISK CLASSIFICATION
  safe:        SELECT, EXPLAIN, SHOW, DESCRIBE
  destructive: UPDATE, DELETE, INSERT (can be rolled back in a transaction)
  irreversible: DROP TABLE, DROP COLUMN, DROP DATABASE, TRUNCATE
  
  Irreversible operations: additional red warning banner in DBDiffPanel
  "This operation cannot be automatically rolled back"

Layer 3: PRODUCTION GUARD
  When active connection is prod:
    - Additional confirmation modal before ANY mutation
    - Irreversible operations require typing "CONFIRM" in a text input
    - Sample data hidden from AI context (privacy)
    - Schema still visible (needed for AI to work)

Layer 4: TRANSACTION WRAPPING
  destructive operations auto-wrapped in BEGIN/ROLLBACK
  User can choose to COMMIT or ROLLBACK after seeing results
  This gives a preview before permanent change
```

### DB Panel Left Sidebar Layout

```
┌─────────────────────────────────────────────┐
│ 🗄️ DB Studio          [dev ▼]  [● connected] │
├─────────────────────────────────────────────┤
│ ▼ atlarix_dev                               │
│   ▼ Tables (6)                              │
│     ▼ users                                 │
│         id: uuid PK                         │
│         email: varchar(255) NOT NULL        │
│         created_at: timestamptz             │
│       [View data] [Copy name]               │
│     ► sessions                              │
│     ► refresh_tokens                        │
│     ► workspaces                            │
│   ► Views (1)                               │
│   ► Indexes (8)                             │
├─────────────────────────────────────────────┤
│ Quick Query                                 │
│ ┌─────────────────────────────────────────┐ │
│ │ SELECT * FROM users LIMIT 10           │ │
│ └─────────────────────────────────────────┘ │
│ [▶ Run]                                     │
├─────────────────────────────────────────────┤
│ [AI is querying users table...] ⣿           │
└─────────────────────────────────────────────┘
```

---

## 11. Feature 8 — Extensions System & Left Panel

### Extension Tier Gates

```typescript
const EXTENSION_TIER_REQUIREMENTS: Record<string, Tier> = {
  'db-studio':     'pro',        // Available in v3.5
  'ci-cd-monitor': 'workforce',  // v4.0
  'github':        'workforce',  // v4.0
  'slack':         'workforce',  // v4.0
  'jira':          'workforce',  // v4.0
  'log-streamer':  'workforce',  // v4.0
  'devops-agent':  'vanguard',   // v5.0
  'data-agent':    'vanguard',   // v5.0
};
```

### Left Panel Tab Limit: 5

Why 5 and not 7? User research across developer tools (VS Code, Figma, Notion) consistently shows that sidebar panels above 5 cause scanning fatigue. The user is also simultaneously managing: the chat, the blueprint (right panel), and their code. 5 is the maximum that doesn't compete with cognition.

### Extension Icon Design

Do NOT use the VS Code puzzle piece icon. Atlarix extensions are not VS Code extensions and the visual similarity would confuse power users who use both. Design a custom icon — suggestion: a 2x2 grid of rounded squares where one square is highlighted/glowing, representing "extending the grid" of capabilities.

---

## 12. Feature 9 — Enhanced Reviewer Agent

### Reviewer Decision Tree

```
New file written by Builder
         ↓
Layer 1: Static analysis (ast-grep + oxlint)
  < 100ms, zero cost
         ↓
  Any critical issues?
  YES → emit immediately to Activity Stream, send to Builder via bus
  NO  → continue
         ↓
Layer 2: Check Agent Lightning memory
  Has this exact pattern been seen before?
  YES (accepted fix) → suggest fix directly, skip Layer 3
  NO → continue
         ↓
Layer 3: Balanced model AI review
  ~150-300 tokens, uses Qodo PR-Agent prompt structure
         ↓
  verdict == 'critical_issues'?
  YES → escalate to Main
  verdict == 'needs_changes'?
  YES → send directly to Builder via bus
  verdict == 'approved'?
  YES → mark task done, emit to Activity Stream
```

### Qodo PR-Agent Prompt Adaptation

The key insight from studying PR-Agent's open-source code: the review power is entirely in the prompt structure, not any special tooling. Their prompts are in `pr_agent/prompt_templates/`. The structure they use:

```
1. Context injection (diff + related code)
2. Category-by-category review instructions
3. Strict JSON output format
4. One review per LLM call (not multiple passes)
```

Adapt this structure into your Reviewer agent's system prompt. The categories should be Atlarix-specific (added Agent Protocol Compliance and Blueprint Consistency on top of the standard Security, Logic, Performance categories).

---

## 13. Feature 10 — ATLARIX_PLAN.md Restructure

### File Responsibility Matrix

| File | Created by | Modified by | Read by | Purpose |
|------|-----------|-------------|---------|---------|
| `spec.md` | Architect | Architect (rarely) | All agents | Technical decisions, stack, patterns |
| `plans/_index.md` | Architect | All agents | All agents (first) | Quick task status overview |
| `plans/backend.md` | Architect | Builder, Reviewer | Builder, Reviewer | Backend task list |
| `plans/frontend.md` | Architect | Builder, Reviewer | Builder, Reviewer | Frontend task list |
| `plans/database.md` | Architect | Builder, Reviewer | Builder, Reviewer | DB schema tasks |
| `plans/devops.md` | Architect | Builder | Builder | Infrastructure tasks |
| `memory.md` | Compaction system | Compaction system | Main | Session memory across compactions |
| `ATLARIX.md` | User | User | All agents | Project-specific AI instructions |

### Plan File Template

Every plan file must start with this header (prevents AI from confusing plan vs spec):

```markdown
<!-- ATLARIX TASK PLAN -->
<!-- Domain: backend -->
<!-- Created by: Architect agent -->
<!-- Modified by: Builder agent (marks tasks done), Reviewer agent (adds issues) -->
<!-- DO NOT use this file for technical specifications — use spec.md for that -->

# Backend Tasks

## In Progress
- [ ] Task name (agent: Builder, session: 5)

## Pending
- [ ] Task name

## Completed
- [x] Task name (completed session 3)
- [x] Task name (completed session 2)
```

### _index.md Template

```markdown
<!-- ATLARIX PLAN INDEX — read this first before reading individual plan files -->
<!-- Auto-updated by agents when tasks change status -->

# Plan Index

| Domain | File | Pending | In Progress | Done | Last Updated |
|--------|------|---------|-------------|------|-------------|
| Backend | plans/backend.md | 3 | 1 | 2 | session 5 |
| Frontend | plans/frontend.md | 4 | 0 | 0 | session 4 |
| Database | plans/database.md | 0 | 0 | 3 | session 3 |

## Current Focus
Backend — implementing auth middleware (session 5)

## Blockers
None
```

---

## 14. Feature 11 — Reference Projects & Multi-Blueprint

### Workspace Open Sequence (v3.5)

```
User opens workspace
         ↓
1. Load primary project config
         ↓
2. Load reference projects list (from workspace config)
         ↓
3. RTE parse all projects CONCURRENTLY (no LLM, fast)
   Show: "Parsing project structure..." with skeleton animation
         ↓
4. Enrich unenriched nodes with BALANCED model, batches of 10
   Show: "Understanding your code... (12/40 nodes)" with progress
         ↓
5. Detect cross-project edges (structural, no LLM)
         ↓
6. Build combined blueprint
   Show: completed Blueprint canvas with both projects
         ↓
7. Inject combined blueprint into agent context
         ↓
8. Allow first user message
   (AI has full architectural context before saying a word)
```

### Adding Reference Projects Mid-Session

UI: In workspace settings or Blueprint panel header → [+ Add Reference Project]

This triggers the `add_reference_project` agent tool which:
1. Pauses any active agent operation
2. Parses and enriches the new project (shows mini progress bar)
3. Rebuilds combined blueprint
4. Updates agent context
5. Resumes

This is the ONLY case where an agent tool triggers blueprint generation. Normal workspace open is automatic.

---

## 15. Feature 12 — Provider Capability Registry

### Settings UI — Manual Model Entry

For providers where the API doesn't return capability data (local models, custom endpoints):

```
Provider: Custom / Local
┌─────────────────────────────────────────────────────────┐
│ Model Entry                                             │
│                                                         │
│ ○ Single model for all tiers                            │
│   [model-name-here              ]                       │
│                                                         │
│ ● Three-tier mode                                       │
│   Fast:      [llama3.2:3b       ] [Detected: fast ✓  ] │
│              [Test tool calling ]                       │
│   Balanced:  [llama3.1:8b       ] [Detected: balanced] │
│              [Test tool calling ]                       │
│   Thinking:  [llama3.1:70b      ] [Detected: thinking] │
│              [Test tool calling ]                       │
└─────────────────────────────────────────────────────────┘
```

The "Detected: X" badge is computed from the model name keywords in real time as the user types. It's a suggestion, not a constraint — users can assign any model to any tier.

The "Test tool calling" button fires a minimal test:
```json
{
  "messages": [{"role": "user", "content": "Call the echo tool with message 'test'"}],
  "tools": [{"name": "echo", "description": "echo a message", "parameters": {...}}]
}
```
If the model returns a tool_use response: shows green "✓ Tool calling works"
If the model returns text instead: shows amber "⚠ Tool calling not supported"
If the request errors: shows red "✗ Connection failed"

---

## 16. Code Signing — Windows & macOS

### macOS — $99/year (Apple Developer Program)

The $99/year Apple Developer Program is non-negotiable for macOS distribution. There is no cheaper official alternative. What you get:

- **Developer ID Application** certificate — signs your Electron .app
- **Notarization** — Apple scans your binary and issues a notarization ticket
- Without notarization: Gatekeeper blocks your app on first launch on every macOS user's machine

**Setup steps:**
1. Enroll at developer.apple.com ($99/year, accepts business or personal)
2. Create a Developer ID Application certificate in Certificates, IDs & Profiles
3. Export as .p12 with strong password
4. Install `@electron/notarize` in your build pipeline
5. Create an app-specific password at appleid.apple.com (NOT your main Apple password)
6. Add `afterSign` hook to electron-builder

**GitHub Actions secrets needed:**
```
APPLE_CERT_P12_BASE64     (base64-encoded .p12 file)
APPLE_CERT_PASSWORD       (password for the .p12)
APPLE_ID                  (your Apple ID email)
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

### Windows — Budget Option (~$100-150/year)

**Sectigo (formerly Comodo) OV Code Signing — ~$100-149/year**

Sectigo is one of the most widely recognized certificate authorities globally, has been issuing code signing certs since 2000, and their OV (Organization Validation) certificate is accepted by all antivirus vendors and Windows SmartScreen. This is the cheapest widely-trusted option.

- **Sectigo OV Code Signing**: ~$100-149/year depending on reseller
- Buy through resellers like **NameCheap** or **SSL.com** — often cheaper than direct
- NameCheap typically offers Sectigo code signing at ~$100/year

**Important limitation of OV vs EV:**
OV certificates do NOT instantly establish SmartScreen reputation. Your app will still show the "Windows protected your PC" SmartScreen warning until your app builds reputation through user installs. This takes weeks to months depending on download volume.

**The antivirus submission workflow** (this is what helps with reputation faster than anything):

After every release build:
```bash
# 1. Get your file hashes
sha256sum Atlarix-Setup-3.5.0.exe > release-hashes.txt

# 2. Submit to VirusTotal (free API, 4 submissions/min on free tier)
# Register at virustotal.com for an API key
curl -X POST "https://www.virustotal.com/api/v3/files" \
  -H "x-apikey: YOUR_VT_KEY" \
  -F "file=@Atlarix-Setup-3.5.0.exe"

# 3. Submit to Microsoft WDSI (Windows Defender Security Intelligence)
# Portal: microsoft.com/en-us/wdsi/filesubmission
# Or automate via their submission API

# 4. Submit to major AV vendors directly (optional but effective)
# Most have developer portals for false positive reports:
# - Kaspersky: virusdesk.kaspersky.com
# - ESET: eset.com/filesamples
# - Avast: avast.com/false-positive-file-form
# - Bitdefender: bitdefender.com/consumer/support/false-positive
```

**The GitHub Actions release workflow:**
```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install signing tools
        run: |
          npm install -g electron-builder
          
      - name: Sign Windows build
        env:
          CSC_LINK: ${{ secrets.WIN_CERT_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
          WIN_CSC_LINK: ${{ secrets.WIN_CERT_P12_BASE64 }}
          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
        run: npm run build:win
        
      - name: Submit to VirusTotal
        run: node scripts/submit-virustotal.js ./dist/Atlarix-Setup-${{ github.ref_name }}.exe
        env:
          VT_API_KEY: ${{ secrets.VIRUSTOTAL_API_KEY }}
          
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Import Apple certificates
        uses: apple-actions/import-codesign-certs@v2
        with:
          p12-file-base64: ${{ secrets.APPLE_CERT_P12_BASE64 }}
          p12-password: ${{ secrets.APPLE_CERT_PASSWORD }}
          
      - name: Build and notarize
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: npm run build:mac
```

**scripts/submit-virustotal.js:**
```javascript
const fs = require('fs');
const crypto = require('crypto');
const FormData = require('form-data');
const fetch = require('node-fetch');

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node submit-virustotal.js <file>'); process.exit(1); }

async function submit() {
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  console.log(`File: ${filePath}`);
  console.log(`SHA256: ${sha256}`);
  
  // Check if already known
  const checkRes = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
    headers: { 'x-apikey': process.env.VT_API_KEY }
  });
  
  if (checkRes.status === 200) {
    console.log('Already analyzed by VirusTotal — no submission needed');
    return;
  }
  
  // Submit for analysis
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename: filePath.split('/').pop() });
  
  const res = await fetch('https://www.virustotal.com/api/v3/files', {
    method: 'POST',
    headers: { 'x-apikey': process.env.VT_API_KEY, ...form.getHeaders() },
    body: form
  });
  
  const result = await res.json();
  if (result.data?.id) {
    console.log(`Submitted successfully. Analysis ID: ${result.data.id}`);
    console.log(`View results: https://www.virustotal.com/gui/file-analysis/${result.data.id}`);
  } else {
    console.error('Submission failed:', JSON.stringify(result));
  }
}

submit().catch(console.error);
```

**SmartScreen reputation building strategy:**
1. Submit to VirusTotal immediately after each release (automated in CI/CD)
2. Submit to Microsoft WDSI manually for the first few releases, then automate
3. Set up a beta channel — more installs = faster reputation building
4. Use the same certificate across all releases — reputation is per certificate
5. Consider publishing to winget (Windows Package Manager) — Microsoft-curated apps build reputation faster

---

## 17. Pricing & Teams Strategy

### The Core Question: Individual vs Team Licensing

Both models have merit. Here is the honest analysis:

**Pure individual licensing ($19 Pro, $79 Workforce per person):**
- Simpler billing, simpler auth
- Higher revenue per user if teams buy individually
- Bad for team adoption — the person who wants to adopt it can't expense "for the team" easily
- "Can I try this for my whole team?" has no good answer

**Pure seat-based team licensing (e.g., $X per seat/month for minimum 3 seats):**
- Good for enterprise deals
- Harder to convert individual users (they need to "sell" it to their company)
- Risky for a small SaaS — large enterprise deals have long sales cycles

**Recommended: Hybrid model (individual + team add-on)**

```
Free          — $0     — individual, 1 workspace, full tools, BYOK
Pro           — $19/mo — individual, unlimited workspaces
Workforce     — $79/mo — individual OR team seat
  Team option: $59/seat/mo for 3+ seats (saves 25% vs individual)
  Team admin: one billing account, manage seats, shared team config

Vanguard      — $119/mo — individual OR team seat  
  Team option: $89/seat/mo for 3+ seats
  Team admin: + team memory, shared blueprints, audit log
```

### How Teams Work Technically

**Option A: Company email domain matching**
- Admin sets up a team account with a domain (e.g., norahlabs.com)
- Any user signing in with @norahlabs.com is automatically offered to join the team
- Pro: frictionless for orgs with consistent email domains
- Con: contractors, personal email users, multi-domain companies

**Option B: Invite-based (recommended)**
- Admin buys seats and sends invite links
- Each invite link is single-use, expires in 7 days
- Invited users can use any email
- Admin dashboard shows: seat usage, last active, member emails
- Pro: works for any org structure, contractors, etc.
- Con: slightly more friction for large teams

**Option C: Hybrid (best of both)**
- Invite-based as primary
- Domain auto-join as secondary option admin can enable
- This is how Notion, Linear, and Slack handle it

### Implementation Without Storing Chat Data

Since Atlarix doesn't store chat data (by design — BYOK, ephemeral sessions), team features are lighter than typical SaaS:

```
What the server stores (minimal):
  - User accounts (email, tier, team membership)
  - Team metadata (name, domain, seat count, billing)
  - Shared team config (ATLARIX.md templates, agent configs)
  - Blueprint snapshots (if user opts in — v5.0/Vanguard)

What the server NEVER stores:
  - Chat messages
  - Code content  
  - API keys (users bring their own)
  - File contents
```

Team membership and billing are managed server-side. Everything else stays local. This is actually a strong marketing point: "Your code never leaves your machine — even in team mode."

### Admin Dashboard (minimal viable)

```
NorahLabs Team Dashboard

Members (6/10 seats used)
┌──────────────────────────────────────────────────┐
│ Email                    Role    Last Active      │
│ sarah@norahlabs.com      Admin   Today            │
│ dev1@norahlabs.com       Member  Yesterday        │
│ dev2@norahlabs.com       Member  3 days ago       │
│ contractor@gmail.com     Member  1 week ago       │
├──────────────────────────────────────────────────┤
│ [+ Invite member]   [Manage seats]               │
└──────────────────────────────────────────────────┘

Shared Config
  ATLARIX.md template: [Edit]  ← shared across all team members' new workspaces
  Default agent mode: Guided
  Default permission mode: Ask
```

### Marketing Framing

**Individual pricing is good for:** students, freelancers, solo founders, devs who expense tools personally.

**Team pricing is good for:** startups (one person buys for the whole team), enterprises (IT buys in bulk), agencies (team works on shared projects).

The team plan is your best **marketing flywheel**: one person loves Atlarix, gets their team on it, now the whole company is talking about it. Individual plans don't have this compounding effect. The 25% discount for 3+ seats is the incentive to upgrade from individual to team rather than just buying multiple individual plans.

---

## 18. TODO — Workforce v4.0

> The following features are scoped for v4.0. Do not implement in v3.5. Document as TODO only.

### Extensions (Full Workforce Suite)

**CI/CD Monitor**
- Connect to GitHub Actions, GitLab CI, or Bitbucket Pipelines via their APIs
- Show pipeline status live in left panel extension slot
- On pipeline failure: auto-route error + full log to Builder agent
- AI reads failure, proposes fix, queues for approval
- Trigger: any CI/CD failure while workspace is open

**GitHub Extension**
- PR creation from within Atlarix (auto-generates PR description from agent activity log)
- PR review comments visible in Activity Stream
- Branch management (create, switch, merge)
- Commit with auto-generated message from session summary

**Slack / Teams Notifier**
- On session complete: send summary to configured channel
- Format: architectural changes made, tasks completed, issues found
- Link to blueprint snapshot
- Configurable: which events trigger notifications

**Jira Integration**
- Create Jira tickets from tasks in ATLARIX_PLAN.md
- Mark Jira tickets done when Builder completes tasks
- Import existing Jira backlog as tasks into plan
- Two-way sync: changes in Jira reflect in plan files

**Log Streamer**
- Tail logs from running dev server (already partially done with terminal parser)
- Connect to deployed services: Render, Railway, Fly.io, Heroku via their APIs
- Errors in deployed logs → route to Reviewer agent
- Pattern: if same error appears 3+ times in logs → auto-surface to user

### Full DB Studio
- Complete the v3.5 DB extension preview into full product
- Add: data export, import, backup functionality
- Add: migration file generation from schema changes
- Add: query history and saved queries
- Add: ER diagram view in Blueprint for DB schema

### Team Plan Rollout
- Admin dashboard (minimal: members, seats, shared config)
- Invite-based seat management
- Optional domain auto-join
- Shared ATLARIX.md template across team members
- Per-team agent configuration (shared custom agent rules)

---

## 19. TODO — Vanguard v5.0

> The following features are scoped for v5.0. Do not implement before v4.0 is complete.

### Multi-Workspace Orchestration
- AI operates across multiple workspaces simultaneously
- Change in shared auth library → auto-triggers review in dependent workspaces
- Blueprint shows cross-workspace dependency edges
- One combined Blueprint view across all related projects

### Team Memory (Shared Agent Lightning)
- Agent Lightning learning is pooled across all team members
- When one developer's session learns a pattern, it's available to all
- Opt-in per workspace (privacy: sensitive projects can exclude from shared learning)
- Team knowledge base in shared storage (not local only)

### Versioned PR Blueprints
- Every PR/branch gets a blueprint.json committed to .atlarix/
- GitHub PR view shows rendered blueprint.png inline
- Visual diff: what nodes/edges changed between base and head
- "View Blueprint diff" link in PR description
- Next developer or AI session on that branch instantly has full architectural context

### Specialist Agents
- **DevOps Agent**: owns infrastructure, Docker, Kubernetes, cloud configs, CI/CD authoring
  - Can write and modify GitHub Actions workflows, Dockerfiles, k8s manifests
  - Has access to cloud provider APIs (read-only: list resources, check status)
- **Data Agent**: owns data pipelines, transformations, schema design, query optimization
  - Specialized prompting for SQL performance, data modeling, ETL patterns
  - Integrates with dbt, Airflow, Spark if present in workspace

### Vanguard Communication (Slack/Discord/Teams)
- Event-driven summaries sent to team channels:
  - PR opened: blueprint changes summary
  - Build failed: error + suggested fix
  - Session complete: tasks done + architectural changes
- Visual: blueprint diff rendered as image in message
- Format: enough to understand what changed architecturally, not overwhelming
- Deep link: "View in Atlarix" opens the relevant workspace

### Audit Log
- Every AI action across every workspace, searchable and exportable
- Fields: timestamp, workspace, agent, action type, files affected, user approval status
- Export as CSV or JSON
- Integrate with Jira: auto-create tickets from significant agent actions
- Retention: configurable (30/90/365 days)

### Priority Routing Infrastructure
- Vanguard users get prioritized API routing through Atlarix infrastructure
- Relevant if Atlarix ever offers managed API keys (not in v3.5/v4.0)
- Backend feature: lower latency during peak usage
- Sellable differentiator: "Priority response times for your team"

---

## 20. File Structure Map

Complete file tree for all new and modified files in v3.5:

```
src/
├── lib/
│   ├── routing/                         [NEW DIRECTORY]
│   │   ├── auto-router.ts               [NEW] Two-stage router
│   │   ├── capability-registry.ts       [NEW] Model capabilities cache
│   │   ├── fallback-router.ts           [NEW] Single-model fallback
│   │   └── signal-sets.ts              [NEW] Classification keywords
│   │
│   ├── context/
│   │   └── summarization-manager.ts    [UPDATE] 7-trigger system, balanced model
│   │
│   ├── blueprint/
│   │   ├── enricher.ts                 [UPDATE] Balanced model, concurrent batches
│   │   ├── rte-parser.ts               [UPDATE] Concurrent parsing
│   │   └── reference-manager.ts        [NEW] Multi-project support
│   │
│   ├── plan/
│   │   ├── plan-card-renderer.ts       [NEW] Visual explainer plan cards
│   │   └── plan-manager.ts             [UPDATE] Separate spec.md from plans/
│   │
│   ├── agents/
│   │   ├── bus.ts                      [NEW/UPDATE] Agent message bus
│   │   ├── orchestrator.ts             [NEW] Main as observer/corrector
│   │   └── animation-state.ts          [NEW] Zustand animation store
│   │
│   ├── review/
│   │   ├── static-analyzer.ts          [NEW] ast-grep + oxlint
│   │   ├── qodo-prompt-adapter.ts      [NEW] PR-Agent inspired prompts
│   │   └── lightning-review-memory.ts  [NEW] Pattern learning
│   │
│   ├── workforce/
│   │   └── db-extension/              [NEW DIRECTORY]
│   │       ├── connection-manager.ts   [NEW] DB connection lifecycle
│   │       ├── schema-introspector.ts  [NEW] Schema fetching/caching
│   │       ├── context-injector.ts     [NEW] Schema → agent context
│   │       └── db-tools.ts            [NEW] AI tool definitions
│   │
│   └── extensions/
│       └── extension-registry.ts      [NEW] Extension system
│
├── components/
│   ├── blueprint/
│   │   ├── AgentNode.tsx              [UPDATE] Framer Motion state animations
│   │   └── AgentMessageEdge.tsx       [NEW] SVG animateMotion particle edges
│   │
│   ├── chat/
│   │   └── PlanCard.tsx               [NEW] Visual plan card below AI responses
│   │
│   ├── extensions/
│   │   └── DBPanel.tsx                [NEW] DB Studio left panel component
│   │
│   └── layout/
│       ├── LeftPanel.tsx              [NEW] Left sidebar for extensions
│       └── ExtensionsIcon.tsx         [NEW] Bottom bar extension launcher
│
.atlarix/
├── memory.md                          [EXISTING — no change]
├── ATLARIX.md                         [EXISTING — no change]
├── spec.md                            [EXISTING — clarify purpose in docs]
└── plans/                             [NEW DIRECTORY]
    ├── _index.md                      [NEW — generated by Architect agent]
    ├── backend.md                     [NEW — domain-specific task list]
    ├── frontend.md                    [NEW — domain-specific task list]
    └── database.md                    [NEW — domain-specific task list]
```

---

## Appendix A — Dependencies to Add in v3.5

```bash
# Static analysis (Reviewer agent)
npm install @ast-grep/napi
npm install oxlint

# DB Extension (Pro feature)
npm install knex
npm install pg
npm install mysql2
npm install better-sqlite3
npm install mongodb

# Animation (if not already present)
npm install framer-motion
npm install zustand

# Build/signing
npm install --save-dev @electron/notarize
npm install node-fetch form-data   # for VT submission script
```

---

## Appendix B — Environment Variables to Add

```bash
# macOS signing (GitHub Actions secrets)
APPLE_CERT_P12_BASE64=
APPLE_CERT_PASSWORD=
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
APPLE_TEAM_ID=

# Windows signing (GitHub Actions secrets)
WIN_CERT_P12_BASE64=
WIN_CERT_PASSWORD=

# VirusTotal submission
VIRUSTOTAL_API_KEY=

# Auto routing (user-configured in Settings, not env vars)
# These are in the app's config, not .env:
# autoRouting.fastModel
# autoRouting.balancedModel
# autoRouting.thinkingModel
```

---

## Appendix C — Agent System Prompt Updates

Every agent's system prompt must be updated to include the new file structure. Add this block to all agent prompts:

```
## File Structure You Must Follow

TASK PLANS (for implementation tasks):
  .atlarix/plans/_index.md     — read this FIRST for orientation
  .atlarix/plans/backend.md    — backend tasks only
  .atlarix/plans/frontend.md   — frontend tasks only
  .atlarix/plans/database.md   — database tasks only
  
TECHNICAL SPECIFICATION (NOT a task list):
  .atlarix/spec.md             — stack decisions, patterns, auth approach
                                  DO NOT put tasks here
                                  DO NOT confuse with plans/ files

SESSION MEMORY:
  .atlarix/memory.md           — auto-written by compaction system
                                  read on session start for context
                                  do not manually write to this file

PROJECT INSTRUCTIONS:
  .atlarix/ATLARIX.md          — user's project-specific AI instructions
                                  highest priority — always follow these

AGENT COMMUNICATION:
  You may communicate directly with other agents via the agent bus.
  Do NOT always route through Main.
  Direct communication is appropriate when:
    - You need information from a specialist (Architect → Researcher)
    - You need to request a fix (Reviewer → Builder)
    - You are responding to a direct question from another agent
  Escalate to Main ONLY for: unresolvable conflicts, critical security issues,
  scope decisions that affect the whole plan.
```

---

*Atlarix v3.5 Build Guide — NorahLabs*
*Do not distribute. Proprietary.*
