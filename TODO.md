# Atlarix TODO

This file tracks upcoming features, improvements, and known issues.

## 🔥 High Priority

### Critical Fixes
- [ ] **Token Count Handler**: Update `token_count_handlers.ts` to support ephemeral chats
  - Currently throws "Chat not found" for negative IDs
  - Need to check `isEphemeralChatId()` before querying database
  - File: `src/ipc/handlers/token_count_handlers.ts:46`

### Performance
- [ ] **Ephemeral Chat Cleanup**: Add memory management for long-running sessions
  - Currently ephemeral chats stay in memory until app closes
  - Consider TTL (time-to-live) for inactive chats
  - Add manual cleanup option in settings

## 🎯 Medium Priority

### Features
- [ ] **Chat History Export**: Allow users to save ephemeral chats before closing
  - Add "Save Chat" button in header
  - Export as markdown or JSON
  - Optional: Convert ephemeral chat to workspace chat

- [ ] **Model Switching Mid-Chat**: Switch models during a conversation
  - Add model selector in chat header
  - Preserve conversation history
  - Show which model was used for each response (already done!)

- [ ] **Search in Chat**: Add search functionality for chat messages
  - Ctrl/Cmd + F to search
  - Highlight matches
  - Navigate between results

### UI/UX Improvements
- [ ] **Chat Templates**: Pre-filled prompts for common tasks
  - "Explain this code"
  - "Find bugs"
  - "Write tests"
  - "Optimize performance"

- [ ] **Keyboard Shortcuts**: Add more keyboard shortcuts
  - `Ctrl/Cmd + N` - New chat
  - `Ctrl/Cmd + K` - Clear chat
  - `Ctrl/Cmd + /` - Toggle help
  - `Esc` - Close modals

- [ ] **Loading States**: Better loading indicators
  - Skeleton screens while loading templates
  - Progress bars for file operations
  - Animated transitions

### Documentation
- [ ] **User Guide**: Create comprehensive user documentation
  - Getting started guide
  - Tool reference
  - Best practices
  - Troubleshooting

- [ ] **API Documentation**: Document IPC handlers for contributors
  - Handler signatures
  - Request/response types
  - Error handling patterns

## 🌟 Low Priority

### Enhancements
- [ ] **Chat Themes**: Allow users to customize chat appearance
  - Light/Dark/Auto
  - Custom colors
  - Font size options

- [ ] **Voice Input**: Add speech-to-text for prompts
  - Click-to-speak button
  - Continuous listening mode
  - Multiple language support

- [ ] **Code Playground**: Interactive code testing
  - Run code snippets inline
  - Support multiple languages
  - Show output in chat

### Analytics
- [ ] **Usage Stats**: Show user statistics
  - Prompts used today
  - Most used tools
  - Model preferences
  - Token consumption

## 🐛 Known Issues

### Major Issues
- [x] ~~**SearxNG Config Sync**: Settings revert to default on app restart~~ ✅ Fixed in v0.4.0
  - Solution: Database-backed storage + in-memory fallback
  - One-click Docker setup added

### Minor Bugs
- [x] ~~**Rate Limiting**: GitHub API rate limit errors in logs~~ ✅ Fixed with disk cache
  - Templates now cached to disk with midnight expiry
  - Shuffle on load provides variety

- [ ] **Build Script**: `npm run build` shows "Missing script: 'build'"
  - App runs fine with `npm start`
  - May need to add build script to package.json
  - Or update documentation to use `npm run package`

### Edge Cases
- [ ] **Long Messages**: Very long AI responses may cause scroll issues
  - Test with responses >10,000 characters
  - Ensure smooth scrolling
  - Consider pagination or "Show more" button

- [ ] **Network Errors**: Better handling of network failures
  - Retry logic for transient errors
  - Offline mode detection
  - Clear error messages

## 📋 Completed ✅

### v0.4.0 (2025-12-25)
- [x] **3-Panel Layout**: Sidebar, Chat, and Context Panel
- [x] **Live Preview**: Code iframe and Mermaid/PlantUML diagrams
- [x] **Smart Search**: 3-tier search (SearxNG + Public + DDG)
- [x] **Config Sync**: IPC-based settings sync  
- [x] **One-Click SearxNG**: Docker auto-setup with embedded config
- [x] **Auto-Stop on Quit**: Docker container cleanup when app closes
- [x] **Database-Backed Settings**: SearxNG config persists in SQLite
- [x] **Context Awareness**: Right panel adapts to content (Search, Diff, Preview)

---

## 🚀 Roadmap: v0.5.0 - The Ultimate IDE

### Phase 1: Template Rate Limiting ✅ DONE
- [x] **Disk-Based Cache**: Templates cached with midnight expiry
- [x] **Visual Variety**: Shuffle on load (top 3 preserved)

### Phase 2: Diagram-First Analysis ✅ DONE (Dec 26)
- [x] **Workspace Analyzer**: Regex-based parsing of code files
- [x] **Diagram Generator**: Mermaid architecture diagrams
- [x] **Hash-Based Cache**: Invalidation via file modification times
- [x] **AI Context Injection**: Compact summary in system prompts
- [x] **Collapsible Sidebar**: Workspace folders with nested chats
- [x] **Template Diagrams**: Architecture diagram after clone

### Phase 3: Diagram-First Context System ✅ DONE (Dec 27)
**Core Insight**: The diagram IS the learned understanding - no separate "memory" system needed!

#### Phase 3A: Remove Token Overflow ✅
- [x] Removed `extractCodebase()` call in `chat_stream_handlers.ts:568`
- [x] Added `createDiagramFirstPrompt()` - instructs AI to use file tools
- [x] File tools verified: `read_file`, `search_code`, `list_files`, `find_file`
- [x] **97% token reduction**: 218K → ~4K tokens

#### Phase 3B: Schema Changes ✅
- [x] Added `dailyLogs` table with AI-generated micro-changelog
- [x] Enhanced `diagramVersions` with `trigger`, `summary` fields

#### Phase 3C: AI-Powered Logging ✅
- [x] Created `src/lib/context/daily-logs.ts` - selective tool logging
- [x] Session action buffer for state-changing tools
- [x] Daily log storage and retrieval functions

#### Phase 3D: Full Context System ✅
- [x] Created `src/lib/context/context-builder.ts` - assembles diagram + logs + actions
- [x] `buildDiagramContext()` function for lightweight AI context

### Phase 4: Advanced Diagrams (PlantUML + StackSense)
- [ ] **Live Modification**: "Add a node here" → Diagram updates
- [ ] **Interactive Nodes**: Click class → Jump to code
- [ ] **Full PlantUML**: Complex component/sequence diagrams

### Phase 5: Code Generation (Dyad + StackSense)
- [ ] **Smart Scaffolding**: AI-powered project generation
- [ ] **Live Diffing**: Preview changes before applying
- [ ] **Atomic Batching**: Safe multi-file edits

### v0.6.0 (2025-12-27) - Diagram Timeline System ✅
- [x] **Workspace Diagrams**: Persist diagrams while chats remain ephemeral
- [x] **Time Granularity**: Hybrid view (simple range + detailed drill-down)
- [x] **Diff Indicators**: Visualization of architecture/dependency changes (🔵🟢⚪)
- [x] **Smart Capture**: Debounced auto-capture triggers on file changes
- [x] **Deduplication**: SHA-256 hash comparison to prevent duplicates 
- [x] **Compression**: Automatic cleanup of old snapshots (30-day retention)
- [x] **Protected Snapshots**: Annotated snapshots never deleted
- [x] **Integration**: Initial capture on import, flush on app close

#### 6G: v2.0 Features (Later)
- [ ] Export timeline as animated GIF
- [ ] Compare mode: Side-by-side diagram comparison
- [ ] Rewind mode: View past state

---

**Last Updated**: 2025-12-27
**Version**: v0.5.0-alpha (In Development)


