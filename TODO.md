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
- [ ] **Rate Limiting**: GitHub API rate limit errors in logs
  - Shows "403 rate limit exceeded" when fetching templates
  - Doesn't block functionality but clutters logs
  - Consider caching template metadata

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

### 🧠 Intelligent Code Generation (Dyad + StackSense) 🔥 CURRENT PRIORITY
Combining Dyad's template engine with StackSense's context awareness:
- [ ] **Smart Scaffolding**: Generate entire project structures using Dyad templates
- [ ] **AI-Powered Templates**: "Create a FastAPI app with auth" → Full project scaffold
- [ ] **Context-Aware Edits**: RAG-based understanding of project patterns
- [ ] **Live Diffing**: Preview changes in right panel before applying (Aider/Cursor style)
- [ ] **Atomic Batching**: Apply multi-file changes safely
- [ ] **Interactive Proposals**: View/edit/approve changes before commit

### 📊 Advanced Diagrams (PlantUML + StackSense)
Elevating diagrams from static images to interactive tools:
- [ ] **Live Modification**: "Add a node here" → Diagram updates instantly
- [ ] **Interactive Nodes**: Click class → Jump to code
- [ ] **Architecture Analysis**: Auto-generate high-level views
- [ ] **Full PlantUML**: Support for complex component/sequence diagrams

### 🔍 Search Enhancements
- [x] ~~**Fix Config Sync**~~: Resolved with database-backed storage ✅
- [ ] **Citation Graph**: Visualizing connections between search results
- [ ] **Date Context**: Pass current date to AI for time-aware searches

---

**Last Updated**: 2025-12-25
**Version**: v0.4.0 (Released)

