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

### v0.3.0 (2025-12-24)
- [x] Multi-source web search (StackOverflow, GitHub, Reddit, MDN, DuckDuckGo)
- [x] `deep_search` tool - comprehensive research with URL fetching
- [x] Structured sources array for UI display
- [x] MessageSources component with favicon previews
- [x] Source preview dialog with iframe
- [x] Search result caching (1-hour TTL)
- [x] Query validation to prevent undefined searches
- [x] Tool execution timing and logging
- [x] Line break preservation in messages
- [x] Aurora color scheme implementation

### v0.2.0
- [x] Incognito chat mode (ephemeral/in-memory only)
- [x] OAuth integration in sidebar
- [x] Model name display on responses
- [x] Sticky "New Chat" header
- [x] Improved DuckDuckGo search
- [x] Fixed proposal handler null error
- [x] Fixed chat stream handler for ephemeral chats

---

## 🚀 Upcoming: 3-Panel Layout (v0.4.0)

### Interactive Source Preview Panel
A Gemini/Claude-style 3-panel layout for Ask mode:

```
┌────────┬─────────────────┬──────────────────┐
│Sidebar │     Chat        │  Source Preview  │
│        │                 │                  │
│History │ Conversation    │ 📄 Selected URL  │
│        │ [6 sources ▼]   │ [iframe preview] │
│        │                 │                  │
│        │ [Input]         │ ⏱ Tool Timeline  │
└────────┴─────────────────┴──────────────────┘
```

**Features:**
- [ ] `SourcePreviewPanel.tsx` - Right panel component
- [ ] Click source → opens in right panel with iframe
- [ ] Tool execution timeline with durations
- [ ] Tab navigation: Sources | Tools | Preview
- [ ] Resizable panels using `react-resizable-panels`
- [ ] Atoms for selected source state

**Files to Create/Modify:**
- `[NEW]` `src/components/SourcePreviewPanel.tsx`
- `[MODIFY]` `src/pages/atlarix-home.tsx` - 3-panel layout
- `[MODIFY]` `src/components/MessageSources.tsx` - Click to open
- `[NEW]` `src/atoms/sourceAtoms.ts` - State management

---

**Last Updated**: 2025-12-24  
**Version**: v0.3.0

