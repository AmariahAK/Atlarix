# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

---

## ✅ v0.9.19 - Language Detection & Setup UI (Complete)

### Language Detection System ✅
- [x] **Language Registry**: 12 languages (Node.js, Python, Go, Rust, Ruby, Java, PHP, .NET, Deno, Bun, Elixir, Docker)
- [x] **Project Detector**: Auto-detect languages from indicator files (package.json, Cargo.toml, etc.)
- [x] **Lazy Validation**: Only check when running/building, not on startup
- [x] **AI Tools**: Added `check_language_installed` and `detect_project_languages` (57 total)

### SetupBanner & Settings UI ✅
- [x] **Removed Node.js Block**: Banner no longer blocks for Node.js (lazy detection)
- [x] **Removed Google Gemini Card**: Simplified to OpenRouter + Atlarix Pro only
- [x] **OpenRouter Credits Note**: Added info about paid vs free models
- [x] **Fixed Banner Visibility**: Now checks database for API keys (hides when configured)
- [x] **Workflow Settings**: Disabled toggles with "Coming Soon" badge
- [x] **Fixed Atlarix Pro Logo**: Uses correct `/logo/Atlarix.png`

### API Key Fix ✅
- [x] **OpenRouter Production Fix**: Added database fallback in `get_model_client.ts`
- [x] **Provider Detection**: `useLanguageModelProviders` now checks DB

---


## ✅ v0.9.18 - Authentication & Polish (Complete)

### Authentication & Session ✅
- [x] **Google OAuth**: Supabase Auth integration with Deep Linking (`atlarix://`)
- [x] **Session Persistence**: Custom file-based storage for Electron
- [x] **Auth UI**: User profile, plan status, sign out

### UI Improvements ✅
- [x] **App Icon**: Updated to Split design
- [x] **Theme-Aware Logos**: Home page auto-switches dark/light logos
- [x] **Success Flow**: Toast notification to close browser tab

---

## ✅ v0.9.17 - Session Tracker & Architecture (Complete)

### Core Systems ✅
- [x] **SessionTracker**: Implemented "Mini-Git" to track uncommitted changes
- [x] **Staleness Logic**: Added <5%, 5-15%, >15% thresholds for diagram updates
- [x] **New Tools**: `get_session_changes` and `get_dev_server_port`
- [x] **Right Panel**: Fixed global prompt diagram staleness bug

### Documentation ✅
- [x] **Architecture Rewrite**: Removed Dyad references, documented Atlarix accurately
- [x] **Tool Docs**: Added new tools to AGENTS.md and AGENTS_COMPACT.md

---

## 🚧 v1.0.0 - Business Logic (Next)

### Authentication ✅
- [x] Choose provider (Supabase)
- [x] Implement Login/Signup (Google OAuth)
- [x] Session Persistence (Electron file-based storage)

### Monetization (LemonSqueezy Integration) ✅
- [x] Integrate Payment Provider (LemonSqueezy)
- [x] Subscription checkout flow (Upgrade button)
- [x] Unsubscribe button with direct API cancellation
- [x] Supabase Realtime for instant plan updates
- [x] LemonSqueezy webhook handling (subscription lifecycle)
- [x] Customer portal URL storage for subscription management
- [x] Subscription expiry handling (access until billing period ends)

### Workspace Limits Strategy
**Free Tier (1 Workspace):**
- ✅ Full feature access: All 57 tools, live preview, diagrams, any AI model
- ✅ Unlimited incognito/non-workspace chats (free, ephemeral)
- ❌ Limit: 1 workspace - delete to create another, or upgrade

**Pro Tier ($19/mo):**
- ✅ Unlimited workspaces
- ✅ Workspace switching (no setup loss)
- ✅ (Future) Cross-workspace memory
- ✅ (Future) Workspace templates

**Implementation:**
- [ ] `canCreateWorkspace(userId)` - check tier + workspace count
- [ ] Delete confirmation modal with data loss warning
- [ ] Upgrade prompt when hitting limit

### Template System ✅
- [x] **Git Clone UX**: Clicking template triggers `apply_template` (clone → rm .git → init)
- [x] **Template Search**: SearxNG-powered template discovery (not hardcoded)
- [ ] **Visual Previews**: Show diagram/preview *before* cloning (Future v1.1+)

### Other TBD Items
- [ ] **SetupBanner Video**: Replace Dyad video with Atlarix-specific content
- [ ] **Help Docs Button**: Update Open Docs to point to Atlarix documentation
- [ ] **LemonSqueezy Live Mode**: Switch from test to production mode before release
- [ ] **SearxNG for web_search**: Add fallback when API rate limits hit
- [ ] **"Other AI Providers" section**: Complete settings UI

---

## 🔮 Future Versions (v1.1+)

### Workspace Templates (Pro Feature)
- [ ] Save workspace config as template (prompts, diagram style, tool preferences)
- [ ] Apply to new workspaces in 1 click
- [ ] Useful for freelancers/agencies with similar project setups

### Enhanced Features
- [ ] Cross-workspace AI memory (remembers patterns across projects)
- [ ] Team collaboration features
- [ ] Priority support for Pro users

---

## ✅ v0.9.15 - Error Handling & UI Fixes (Complete)

All 4 bugs fixed and verified on 2026-01-09.

---

### Fix 1: AI Missing File Paths ✅
**File:** `src/components/RightPanel.tsx`

- [x] Changed `error.source` → `error.file` in function signature
- [x] Added `error.line` to include line number in AI prompt

---

### Fix 2: Errors Not Clearing ✅
**Files:** `console_debugger.ts`, `useBrowserErrorListener.ts`, `preload.ts`, `interceptor.ts`

- [x] Added `clearConsoleBuffer()` and `clearAllConsoleBuffers()` functions
- [x] Added `browser-console-cleared` IPC channel to preload whitelist
- [x] Added listener in `useBrowserErrorListener.ts` to reset error state
- [x] Call `clearAllConsoleBuffers()` after operations complete in interceptor

---

### Fix 3: Monaco Cursor Jumping ✅
**File:** `src/components/preview_panel/ErrorFileEditor.tsx`

- [x] Added `isInitialLoad` state to track first load vs user editing
- [x] Only apply decorations and cursor positioning on initial load
- [x] Set `isInitialLoad=false` in onChange handler

---

### Fix 4: Duplicate Messages ✅
**File:** `src/hooks/useAIPanelListener.ts`

- [x] Added `processedTimestamps` ref to track handled events
- [x] Skip events with already-processed timestamps
- [x] Limit set size to prevent memory leak

---

### Verification ✅
- [x] TypeScript check passed (`npx tsc --noEmit`)
- [ ] Manual test: "Fix with AI" shows file path + line number
- [ ] Manual test: Errors clear after fix
- [ ] Manual test: Cursor stays in place while typing
- [ ] Manual test: Messages appear only once


---

## 🔥 v0.9.16 - Right Panel & AGENTS.md Updates (Complete)

### AGENTS.md Right Panel Documentation ✅
- [x] Added comprehensive "Right Panel Overview" section
- [x] Documented all 7 tabs (Preview, Code, Terminal, Errors, Permissions, Search, Diagram)
- [x] Clarified port info (Atlarix 5173 vs user projects 5174+)
- [x] Added common user Q&A responses
- [x] Clarified Mermaid diagrams (not PlantUML)
- [x] Added guidance for diagram syntax errors

### AGENTS_COMPACT.md Updates ✅
- [x] Added right panel tabs list
- [x] Added Mermaid clarification
- [x] Added port warning

### Known Diagram Limitations (TBD v1.0)
- [ ] **Retry button** only re-renders same code (doesn't call AI to fix syntax)
- [ ] **Staleness detection** may not trigger on all workspace changes
- [ ] Consider adding "Fix with AI" button for diagram errors

---

## 🔥 v0.9.14 - AGENTS.md Context Optimization (In Progress)

Goal: Make AGENTS.md the single source of truth for AI guidance (StackSense approach)

### Phase 1: Create AGENTS.md Full Reference ✅
- [x] Document all 55 tools with full descriptions, parameters, examples
- [x] Add decision trees (workspace exploration, bug fixing, feature adding)
- [x] Add common workflows (CLI → template → manual priorities)
- [x] Add critical rules section (code style, sequential commands)
- [x] **Result: 1464 lines, 34KB (~8500 tokens)**

### Phase 2: Create AGENTS_COMPACT.md for Small Models ✅
- [x] Essential tools and workflows only
- [x] Critical rules and decision trees
- [x] **Result: ~100 lines, 3KB (~750 tokens)**

### Phase 3: Simplify system_prompt.ts ✅
- [x] Strip from 770 lines → **153 lines** (80% reduction!)
- [x] Remove agent mode (UI only has build/ask)
- [x] AGENTS.md is now primary guidance source
- [x] Add model-aware `getAgentsMdForContextSize()`

### Phase 4: Trim Tool Descriptions ✅
- [x] Trimmed `web_search` description
- [x] Trimmed `check_command_status`, `get_project_structure`, `get_diagram`
- [x] Trimmed `create_workspace`, `search_templates`, `apply_template`
- [x] Trimmed `preview_changes`, `batch_read_files`
- [x] 9 verbose tool descriptions → one-liners

### Phase 5: Test & Validate
- [X] Test with Ollama 8K context model
- [X] Verify all tools still work correctly
- [X] Measure actual token usage before/after

---

## 🔥 v0.9.13 - AI-Controlled Diagram System (In Progress)

### Phase 1: DiagramManager Creation
- [X] Create `/src/lib/DiagramManager.ts` static utility class
  - [X] Add `generatingWorkspaces` Set for tracking in-progress generation
  - [X] Add `generationPromises` Map for deduplication
  - [X] Implement `hasAnyDiagram(workspaceId)` - check if diagram exists
  - [X] Implement `isGenerating(workspaceId)` - check generation status
  - [X] Implement `waitForGeneration(workspaceId, timeout)` - wait for completion
  - [X] Implement `generateInitialDiagram(workspaceId, appPath)` - with deduplication
  - [X] Implement `regenerateForWorkspace(workspaceId, options)` - for AI updates

### Phase 2: update_diagram Tool
- [X] Modify `diagram-tools.ts` - replace existing `update_diagram` with permission-based version
  - [X] Schema: updateType (minor/major/new_component), affectedComponents, changeDescription, suggestedFocus
  - [X] Return `__permission_required: true` for approval flow
  - [X] Add comprehensive description for AI guidance (when to use/not use)

### Phase 3: Cold Start Handling
- [X] Modify `chat_stream_handlers.ts`
  - [X] Check `hasAnyDiagram()` before first workspace message
  - [X] Start background generation (non-blocking) for new workspaces
  - [X] Emit `diagram:initial-ready` IPC when generation completes

### Phase 4: get_diagram Enhancement
- [X] Modify `diagram-tools.ts` - update `get_diagram` handler
  - [X] Wait for in-progress generation if `isGenerating()` is true
  - [X] Start on-demand generation if no diagram exists

### Phase 5: Permission System Integration
- [X] Modify `interceptor.ts`
  - [X] Add case for `update_diagram` operation in `executeOperation()`
  - [X] Call `DiagramManager.regenerateForWorkspace()` on approval
  - [X] Return result with diagramId

### Phase 6: UI Components
- [X] Modify `PermissionQueuePanel.tsx`
  - [X] Add diagram update card for `update_diagram` operation
  - [X] Show updateType badge, affected components, description
  - [X] Emerald theme styling to match diagram panel

### Phase 7: System Prompt & Preload
- [X] Modify `system_prompt.ts`
  - [X] Add "Diagram Management" section with examples
  - [X] Document when to use/not use `update_diagram`
- [X] Modify `preload.ts`
  - [X] Whitelist `diagram:initial-ready` channel

### Phase 8: PlantUML → Mermaid Migration
- [X] Remove PlantUML references from type definitions
  - [X] `db/schema.ts` - Remove "plantuml" from diagram type enum
  - [X] `atoms/sourceAtoms.ts` - Remove "plantuml" from DiagramState type
  - [X] `ipc/ipc_client.ts` - Remove "plantuml" from DiagramInput type
  - [X] `ipc/handlers/diagram_handlers.ts` - Remove "plantuml" from DiagramInput type
- [X] Remove PlantUML components
  - [X] `components/preview_panel/DiagramPanel.tsx` - Remove PlantUMLPreview component
  - [X] `lib/tools/meta-tools.ts` - Remove PlantUML detection from explain_diagram tool
- [X] Update comments to reference only Mermaid

---

## ✅ v0.9.12 - Live Code Editor & Session Persistence (COMPLETED)

### Chat Session Persistence ✅
- [x] **Hidden Div Approach**: Chat mounted in invisible div during navigation
- [x] **Streaming Persists**: AI continues streaming when navigating away
- [x] **Route Detection**: Shows/hides based on current path

### Diagram State Notifiers ✅
- [x] **Staleness IPC**: `diagram:staleness-detected` sent after file operations
- [x] **Atom Updates**: `diagramStalenessAtom` tracks outdated state
- [x] **Staleness Banner**: DiagramPanel shows when diagram needs refresh
- [x] **Preload Whitelist**: Added staleness channel

### Live Code Editor ✅
- [x] **ErrorFileEditor**: Monaco-based editor for error files
- [x] **File List**: Collapsible list with error counts
- [x] **Save Shortcut**: Cmd/Ctrl+S saves changes
- [x] **Error Markers**: Squiggly underlines at error locations
- [x] **Auto-Position**: Cursor moves to first error
- [x] **File IPC**: Read/write/stats handlers added

### UI Improvements ✅
- [x] **Simplified Toolbar**: Removed top 4-icon bar, now single 7-tab row
- [x] **Diagram Tab**: Added to secondary toolbar
- [x] **URL Cleanup**: Parses `http://localhost:5174/src/...` → `src/...`
- [x] **Error Filtering**: Ignores Monaco, CDN, extension errors

---


## ✅ v0.9.11 - Error Capture UX Improvements (COMPLETED)

### CDP-Based Error Capture ✅
- [x] **Electron Debugger API**: Replaced proxy with `webContents.debugger` for reliability
- [x] **Filter Atlarix Errors**: Skip port 5173 (Atlarix dev server) and internal Electron errors
- [x] **IPC Whitelisting**: Added `browser-console-error` channel to preload.ts

### "Fix with AI" Button ✅
- [x] **SimpleChatInput Atom**: Changed from local useState to global `chatInputValueAtom`
- [x] **Textarea Auto-Resize**: Added useEffect to expand when pre-filled
- [x] **Clean Prompt Format**: Simplified to "Error: ... File: ..." (no redundant markdown)

### "Suggest" Button ✅
- [x] **Notes Input**: User can add suggestions when sending error to AI
- [x] **Inline UI**: Input appears below Suggest button when clicked
- [x] **Combined Prompt**: Error + user suggestion sent together

---

## ✅ v0.9.8 - Permission Queue & Workspace Delete Fixes (COMPLETED)

### Permission Queue Integration ✅
- [x] **Unified FileDiffPanel**: Merged PermissionQueuePanel into Approve tab
- [x] **Simplified routing**: `show-permissions` intent → `file-diff` panel
- [x] **Real-time IPC**: Added `permission-request` event emission
- [x] **useEffect loading**: Permissions load on panel mount

### Workspace Delete UI ✅
- [x] **Instant UI update**: Optimistic delete removes workspace immediately
- [x] **"Already deleted" handling**: Errors ignored gracefully
- [x] **Auto-navigate**: Returns to home when current workspace deleted

### Bug Fixes ✅
- [x] **AI prompt error**: Restored `chat_stream_handlers.ts` to stable 4a2b440
- [x] **PlantUML code removal**: DiagramPanel no longer shows raw code
- [x] **IPC whitelist**: Added `operation-status` and `auto-recovery-needed` channels

---

---

## ✅ v0.9.7 - Command Execution & Smart Context Management (COMPLETED)

### Core Command Wait Fix ✅
- [x] **Move resolveApproval()**: Call AFTER command execution, not before
- [x] **Store command results**: Add `CommandExecutionResult` with stdout/stderr/exitCode/duration
- [x] **Sequential executeAllOperations()**: Commands wait for completion before next starts

### Smart Output Formatting ✅
- [x] **Priority slicing**: Errors → Warnings → First 5 lines → Last 5 lines
- [x] **formatCommandOutput()**: Intelligent 1500-char limit for AI context
- [x] **Include output in getExecutionResult()**: AI sees terminal results

### Timeout Protection ✅
- [x] **5-minute timeout**: Configurable timeout with Promise.race()
- [x] **Progress updates**: UI updates every 2 seconds for long commands
- [x] **Error storage**: Capture timeout/failure info for AI context

### Command Error Handling ✅
- [x] **Distinguish errors vs rejection**: Command failures include terminal output for AI
- [x] **Dev server detection**: `npm run dev`, `vite` etc. timeout as success after 10s
- [x] **Terminal UI feedback**: CommandOutputCard shows running commands with spinner

### Smart Context Management (Solving AI "Blindness") ✅
- [x] **Smart read_file**: Add `max_lines`, `context` mode, `line_range` parameters
- [x] **Smart search_code**: Add `context_lines` for surrounding context
- [x] **get_file_outline tool**: Table of contents for files (imports, functions, classes)
- [x] **view_symbol tool**: Read single function/class by name
- [x] **list_files stats**: Add file size/line count to help AI decide
- [x] **ContextManager**: Model-aware token budgets (8K Ollama → 200K Claude)
- [x] **System prompt update**: Context management hints for AI

### Surgical Edit Tools (Precise Code Changes) ✅
- [x] **replace_code tool**: Find and replace specific code snippet
- [x] **insert_code tool**: Insert code at specific line
- [x] **delete_lines tool**: Delete specific line range
- [x] **Updated system prompt**: Document new tools prominently
- [x] **Updated request_tools**: Document core tools already available

### Diagram Stale Detection ✅
- [x] **Workspace fingerprint**: Track file counts, types, and hash per workspace
- [x] **Staleness severity**: none/minor/moderate/major based on % change
- [x] **diagram:check-staleness IPC**: Compare stored vs current fingerprint
- [x] **Schema columns**: `fingerprintHash`, `fingerprintData`, `createdFromFileCount`
- [x] **StalenessBanner UI**: Color-coded banner with refresh button
- [x] **Empty state enhancement**: "Generate First Diagram" CTA

### UI Bug Fixes ✅
- [x] **Dev server detection fix**: Exclude `npm install` from timeouts
- [x] **AI text deduplication**: Filter consecutive identical responses
- [x] **Copy button fix**: Exclude thoughts and tool calls from copy
- [x] **Unified diff view**: +/- line style with theme colors
- [x] **Command queue status**: Queued/Done labels in FilesTab

### Live Preview (Lovable-style) ✅
- [x] **Preload whitelist**: Added `dev-server:*` IPC channels
- [x] **DevServerProvider**: Auto-detects frontend, starts server
- [x] **RightPanel Preview tab**: Iframe with viewport controls
- [x] **Framework detection**: Vite, Next, CRA, Nuxt, Astro

### Todo: Timeline & Evolution ✅
- [x] **Timeline auto-capture**: queueCapture() in interceptor.ts after file ops
- [x] **AI preview awareness**: System prompt teaches Lovable-style workflow
- [x] **Project evolution view**: Added 11 timeline IPC channels to preload.ts

### Token-Saving Stop Button ✅
- [x] **chat:abort IPC handler**: Cancels backend AI stream immediately
- [x] **abortAllStreams()**: Cleanup on app quit
- [x] **Stop button wired**: Both SimpleChatInput and ChatInput call abort
- [x] **Preload whitelist**: chat:abort added for frontend access

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
