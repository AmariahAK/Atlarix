# MCP Servers – Design for Atlarix

This doc answers how to make MCP servers usable in workspaces/regular chats and how to categorize them, using Claude Code and OpenCode as reference.

---

## 1. How to make MCP used in workspaces / regular chats

### Claude Code

- **Scope**: MCP is **plugin-scoped**. Plugins declare servers in `.mcp.json` or `plugin.json` → `mcpServers`.
- **When tools are available**: When the plugin is enabled, its MCP servers start and tools are registered with names like `mcp__plugin_<plugin>_<server>__<tool>`.
- **Usage**: Tools are available in **all sessions** where the plugin is active (no per-workspace or per-chat toggle in the docs).
- **Config**: stdio (local process), SSE, HTTP, WebSocket; env vars like `${CLAUDE_PLUGIN_ROOT}`.

### OpenCode

- **Scope**: MCP is **config-scoped** in `opencode.json` under `mcp`.
- **When tools are available**: Once a server is configured and enabled, its tools are **global** – “available as tools in OpenCode, alongside built-in tools”.
- **Usage**: Same tools in every session; enable/disable is global via `tools: { "my-mcp-foo": false }`.
- **Config**: `type: "local"` (command + env) or `type: "remote"` (url + headers/oauth).

### Recommendation for Atlarix

Two scopes, similar to **Library (Global vs Workspace prompts)**:

1. **Global MCP**
   - Stored in user settings (e.g. `~/.Atlarix/config/` or DB).
   - **Used in**: incognito/general chats and any workspace chat when no workspace override exists.
   - Same idea as “Global prompts” – apply everywhere by default.

2. **Workspace MCP**
   - Stored per workspace (e.g. workspace settings or `.atlarix/mcp.json` in project).
   - **Used in**: only when that workspace is the current app.
   - Same idea as “Workspace prompts” – project-specific tools (DB, APIs, repo-specific scripts).

**Implementation sketch**

- When building the tool list for a chat:
  - **Always** include Global MCP tools.
  - If the chat has a workspace (workspace chat): **also** include that workspace’s MCP tools.
- So: **workspaces/regular chats** = Global MCP in all cases; workspace chats additionally get Workspace MCP for the active workspace.

---

## 2. How to categorize MCP servers

Again, mirroring the **Library page (Global vs Workspace prompts)** is the most consistent approach.

### Option A: Global vs Workspace (recommended)

- **Global MCP servers**
  - One list in Settings (e.g. Settings → MCP).
  - Used in every chat (incognito + workspace).
  - Example: filesystem, generic HTTP, Slack, etc.

- **Workspace MCP servers**
  - One list per workspace (e.g. workspace settings or Library “Workspace” section).
  - Used only when that workspace is active.
  - Example: project DB, internal API, repo-specific CLI.

UI can mirror Library: **“Global MCP”** vs **“Workspace MCP”** (with workspace selector for the latter).

### Option B: Single list with “scope” flag

- Each server has a scope: **Global** or **Workspace** (and if Workspace, which workspace).
- Single list in UI, filterable by scope.
- Same behavior as Option A, different UX.

### Option C: By project type

- Categories like “All projects”, “Frontend”, “Backend”, “Data”.
- More complex and not clearly better than Global/Workspace for Atlarix.

### Recommendation

Use **Option A (Global vs Workspace)**, same mental model as:

- **Global prompts** → **Global MCP**
- **Workspace prompts** → **Workspace MCP**

So:

1. **Use in workspaces/regular chats**: Global MCP in all chats; Workspace MCP only in workspace chats for that workspace.
2. **Categorization**: Two categories – **Global MCP** and **Workspace MCP** – implemented like the Library page for prompts.

---

## References

- Claude Code: `plugins/plugin-dev/skills/mcp-integration/SKILL.md` (server types, config, tool naming).
- OpenCode: `packages/web/src/content/docs/mcp-servers.mdx` (local/remote, OAuth, global enable/disable).
