# Atlarix Changelog

All notable changes to Atlarix will be documented in this file.

## [v0.4.0] - 2025-12-25

### 🎉 Major Features

#### 3-Panel Layout (StackSense-style)
- **Left Panel**: Sidebar & navigation
- **Middle Panel**: Chat interface (Ask/Build modes)
- **Right Panel**: Context-aware auxiliary view
  - **Web Search**: Live search results with favicons & previews
  - **File Diff**: Side-by-side code changes
  - **Tasks**: Usage & credits tracking

#### Live Code & Diagram Preview (PlantUML+StackSense)
- **Code Preview**: Live iframe for HTML/JS/React components
- **Diagrams**: Mermaid & PlantUML diagrams rendered instantly in Right Panel
- **Interactive**: Zoom, pan, and click nodes (coming soon)

#### Smart 3-Tier Web Search
- **Tier 1 (Best)**: Self-hosted SearxNG (unlimited, no rate limits)
- **Tier 2 (Good)**: Public SearxNG instances (fallback)
- **Tier 3 (Reliable)**: DuckDuckGo Instant API (always works)
- **Intelligent Selection**: AI prioritizes 'general' for news and 'stackoverflow/github' for code queries
- **Settings Sync**: Configure SearxNG URL in Settings (syncs to main process)

### ✨ Improvements

#### Configuration Sync
- **Bypass CORS**: Search requests now proxied through Main process to avoid CORS errors
- **IPC Sync**: Search settings synced from Renderer (UI) to Main (Tools) via IPC
- **Health Checks**: Automatic health validation for SearxNG instances

### 🐛 Known Issues
- **SearxNG Sync**: In some cases, config may revert to default on restart until manually saved. Fix in progress.

---

## [v0.3.0] - 2025-12-24

### 🎉 Major Features

#### Web Search Tools (Multi-Source Search)
- **`web_search`** - Searches StackOverflow, GitHub, Reddit, MDN, and DuckDuckGo in parallel
- **`deep_search`** - Comprehensive research: searches → fetches full URLs → aggregates content
- **`read_url`** - Fetch and extract readable content from any URL
- **`get_current_time`** - Returns current date/time with timezone support
- **Structured Sources** - All search tools return structured `sources[]` array for UI display
- **1-Hour Caching** - Search results cached for performance

#### Source Display (Perplexica-style)
- **MessageSources Component** - Displays sources as clickable cards with favicons
- **Preview Dialog** - Click source to see iframe preview
- **"X sources" Badge** - Shows source count with favicon previews
- **Grid Layout** - First 3 sources shown, "+X more" expands all

#### Aurora Color Scheme
- **Light Theme**: Emerald (#059669), Amber (#F59E0B), Rose (#E11D48)
- **Dark Theme**: Deep teal backgrounds, vibrant accents
- **Gradient Effects**: Teal → Gold gradients on buttons and banners
- **Premium Feel**: Consistent theming across all components

### ✨ Improvements

#### Line Break Preservation
- **Fixed**: Multi-line user input now displays correctly in messages
- **Added**: `white-space: pre-wrap` to message content
- **Works**: In both user and assistant messages

#### Tool Execution Logging
- **Timestamps**: Console shows `🔧 [tool_name] Starting...` and `✅ Completed in Xms`
- **Source Count**: `📚 [web_search] Found X sources`
- **Duration Tracking**: Performance visibility for all tool calls

#### Query Validation
- **Undefined Query Fix**: Web search now validates query parameter
- **Helpful Errors**: Returns error message if query is missing, helping AI retry correctly

### 🐛 Bug Fixes

- **Fixed**: `fetching: undefined` - web_search called without query parameter
- **Fixed**: Sources not appearing in UI - final chunk didn't include sources
- **Fixed**: Line breaks displayed as single line in chat messages
- **Fixed**: Model display sometimes throwing errors

### 🔧 Technical Changes

- `src/lib/tools/web-tools.ts` - Complete web search implementation with caching
- `src/ipc/handlers/chat_only_handlers.ts` - Source collection and timing
- `src/components/MessageSources.tsx` - Enhanced source display with previews
- `src/components/SimpleMessage.tsx` - Line break preservation

---

## [v0.2.0] - 2025-12-24

### 🎉 Major Features

#### Incognito Chat Mode 
- **Ephemeral Chats**: Chat-only sessions are now fully ephemeral (in-memory only)
- **No Database Storage**: Chat conversations are NOT saved to the database
- **Privacy-First**: Like incognito browsing - chats disappear when you close/leave
- **Negative IDs**: Ephemeral chats use negative IDs (e.g., -1, -2) to distinguish from workspace chats
- **Perfect for Quick Questions**: Ask anything without cluttering your chat history

#### OAuth Integration in Sidebar
- **Login Button**: Added OAuth login above "Help" in the app sidebar
- **Google & GitHub**: Sign in with Google or GitHub OAuth
- **User Avatar**: Shows your avatar and name when logged in
- **Plan Display**: See your Free/Pro plan status
- **Sign Out**: Easy dropdown menu with sign-out option

### ✨ Improvements

#### Enhanced Web Search (DuckDuckGo)
- **Real Web Results**: Now uses DuckDuckGo lite HTML endpoint for actual search results
- **Better Context**: Previous implementation only returned Wikipedia-like summaries (Instant Answers)
- **Fallback Support**: Falls back to Instant Answers API if HTML parsing fails
- **More Relevant**: Much better results for current events, news, and documentation queries

#### Model Name Display (StackSense-style)
- **Visible Model**: Each AI response now shows the model name above it
- **Formatted Names**: Clean display (e.g., "GPT 4o", "DeepSeek V3", "Claude Sonnet 3.5")
- **Bot Icon**: Small bot icon + model name in muted text
- **Transparency**: Always know which model generated the response

#### Sticky "New Chat" Header
- **Always Visible**: Header stays at top while scrolling through chat messages
- **Backdrop Blur**: Semi-transparent background with blur effect
- **Better UX**: No more scrolling to top to start a new chat
- **Z-index Fix**: Properly layered with `sticky top-0 z-10`

### 🐛 Bug Fixes

#### Proposal Handler Error (Critical Fix)
- **Fixed**: `Cannot read properties of null (reading 'path')` error
- **Root Cause**: Chat-only sessions don't have an `app` object/workspace
- **Solution**: Added null check for `chat.app` before accessing `path` and `chatContext`
- **Impact**: Chat-only sessions now work without errors

#### Chat Stream Handler (Critical Fix)
- **Fixed**: "Chat not found: -1" error when starting ephemeral chats
- **Root Cause**: Handler was querying database for ephemeral chat IDs
- **Solution**: Check for ephemeral chat ID BEFORE querying database
- **Impact**: Incognito chats now stream correctly

### 🔧 Technical Changes

#### Files Modified
- `src/ipc/handlers/chat_only_handlers.ts` - Complete rewrite for ephemeral storage
- `src/ipc/handlers/chat_handlers.ts` - Support for ephemeral chat creation and retrieval
- `src/ipc/handlers/chat_stream_handlers.ts` - Route ephemeral chats correctly
- `src/ipc/handlers/proposal_handlers.ts` - Null safety for chat-only sessions
- `src/components/app-sidebar.tsx` - OAuth login integration
- `src/components/SimpleMessage.tsx` - Model name display
- `src/pages/atlarix-home.tsx` - Sticky header
- `src/lib/tools/web-tools.ts` - Improved DuckDuckGo search

#### Architecture
- **In-Memory Storage**: Ephemeral chats stored in `Map<number, EphemeralChat>`
- **Negative ID Convention**: Ephemeral chats use negative IDs starting from -1
- **Auto-Cleanup**: Ephemeral chats cleared on app close
- **Backward Compatible**: Regular workspace chats still use database

### 📝 Documentation
- Updated README.md with latest features
- Created CHANGELOG.md
- Created TODO.md for upcoming work

---

## [v0.1.0] - 2024-12-20

### Initial Release
- Multi-provider AI support (Ollama, LMStudio, OpenRouter)
- 41 intelligent tools from StackSense
- Premium Dark Cockpit UI
- Unified permission system
- OAuth authentication
- Free tier (5 prompts/day)
- Pro tier ($19/month)
