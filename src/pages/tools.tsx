/**
 * Tools page – feature catalog with search, categories, and deep links into the app.
 */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { cn } from "@/lib/utils";
import { CORE_PAYMENT_SUMMARY } from "@/shared/billing_copy";

type Category =
  | "all"
  | "ai"
  | "code"
  | "skills"
  | "mcp"
  | "browser"
  | "models"
  | "integration";

interface ToolFeature {
  id: string;
  title: string;
  shortDescription: string;
  category: Category;
  steps: string[];
  howItWorks: string;
  link: { label: string; to: string; search?: Record<string, number> };
}

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ai", label: "AI & modes" },
  { id: "code", label: "Code" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "browser", label: "Browser" },
  { id: "models", label: "Models" },
  { id: "integration", label: "Connectors" },
];

const FEATURES: ToolFeature[] = [
  {
    id: "modes",
    title: "Work modes (Explore, Plan, Build, Debug, Review)",
    shortDescription:
      "Match the chat to the job: read-only exploration, structured planning, executing edits, debugging, or review passes.",
    category: "ai",
    steps: [
      "Pick a mode from the chat toolbar",
      "Explore stays read-only (no project writes)",
      "Plan shapes work before Build runs commands and file edits through approvals",
    ],
    howItWorks:
      "Modes change which tools the model may call. Build unlocks writes and terminal runs behind the permission queue; Explore limits you to safe, read-only tools.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "atlarix-core",
    title: "Atlarix Core",
    // Copy carries NO model count and no fast→capable ordering. Both were wrong:
    // the lineup is config-driven (`core-models.json`, slots omitted when unmapped)
    // so "all four" over-promised, and the fast/balanced/thinking framing was
    // deliberately dropped — CORE_TIER_ROWS ships empty descriptions for that reason.
    // The live lineup is rendered from `useAtlarixCoreCatalog()` instead, so this
    // cannot go stale again.
    shortDescription:
      "Atlarix Core is the managed provider (no API key) — Core models appear in the picker under their real model names, with Atlarix Auto first: free for accounts with no credit. Pro ($19/month) includes Core usage; or add credit and it's metered per use.",
    category: "models",
    steps: [
      "Sign in for Atlarix Core, or add BYOK keys under Settings → Model Providers",
      "Pick a Core model in the model picker — each row shows the real model and provider",
      "Watch the context bar on long threads; each Core model uses its own context window",
    ],
    howItWorks:
      "Atlarix Auto is free for accounts with no credit; with Pro or credit, Auto and every Core model draw on your allowance or balance, metered per use. Your own keys (OpenAI, Anthropic, Gemini, local Ollama, etc.) run alongside Core — pick the active model per chat.",
    link: { label: "Settings → Providers", to: "/settings" },
  },
  {
    id: "attachments",
    title: "Attachments (files, paste, terminal)",
    shortDescription:
      "Attach files, pasted text, or terminal output to a message. After send they appear as chips with preview and persist when you reload the session.",
    category: "ai",
    steps: [
      "Paste into the composer or use the attachment control for files/PDFs",
      "Send — chips show in your bubble; click to preview full content",
      "Switch sessions or restart — attachments rehydrate from the database",
    ],
    howItWorks:
      "The model receives full bodies in modelContent while the thread shows compact chips. Explore mode keeps paste and terminal tags so read-only chats still see your context.",
    link: { label: "Workspace chat", to: "/" },
  },
  {
    id: "code-in-chat",
    title: "Code in chat",
    shortDescription:
      "Code blocks, write proposals, and diffs render with syntax highlighting inline in chat — file editing stays in your own IDE.",
    category: "code",
    steps: [
      "Open a workspace from the welcome screen",
      "Ask the agent to read, search, or change code",
      "Review proposals and diffs inline; use @ mentions to reference files",
    ],
    howItWorks:
      "Atlarix works beside your editor rather than replacing it. The agent explores via grep, glob, and explicit file tools.",
    link: { label: "Workspace chat", to: "/" },
  },
  {
    id: "workspace-open",
    title: "Open a workspace",
    shortDescription:
      "Start from the welcome screen with Open folder — no global chat without a project folder.",
    category: "ai",
    steps: [
      "Sign in and land on the welcome launcher",
      "Open folder or pick a recent workspace",
      "Chat, sessions, and MCP/skills are scoped to that workspace",
    ],
    howItWorks:
      "Every conversation runs inside a workspace folder. Project memory lives under `.atlarix/` in that repo.",
    link: { label: "Welcome → Open folder", to: "/" },
  },
  {
    id: "sessions",
    title: "Workspace sessions & new chat",
    shortDescription:
      "Saved sessions in the sidebar; + starts a fresh ephemeral chat without leaving the workspace.",
    category: "ai",
    steps: [
      "Expand your workspace in the left sidebar",
      "Switch sessions — background streams keep running",
      "Use + or New chat in the header for a blank thread",
    ],
    howItWorks:
      "Sessions are stored per workspace. Ephemeral chats are not listed until you send a message.",
    link: { label: "Open workspace", to: "/" },
  },
  {
    id: "subagents",
    title: "Sub-agents: explore and build",
    shortDescription:
      "Up to five sub-agents per turn: explore searches code and the web read-only, build drafts a scoped change for review.",
    category: "ai",
    steps: [
      "Ask to map several areas, research a question, or implement a scoped change",
      "Watch each sub-agent's card in the chat stream",
      "Review a build sub-agent's proposed edits file by file before they are written",
    ],
    howItWorks:
      "explore is read-only — code search plus web_search and read_url, so deep research happens here. build returns per-file proposals the main agent reviews; nothing is written without the normal approval. Define your own in .atlarix/agents/.",
    link: { label: "Workspace chat", to: "/" },
  },
  {
    id: "tool-manifest",
    title: "How tools surface to the model",
    shortDescription:
      "Build mode progressively registers core tools; the prompt still carries a manifest of names. Workspace MCP attaches via list_available_mcps + mcp_call.",
    category: "ai",
    steps: [
      "Start in Build: common file/search/git tools are callable immediately",
      "After a tool runs, it stays hot for the rest of the chat where allowed",
      "Explore uses a read-only allowlist; workspace chats avoid merging every MCP tool by default",
    ],
    howItWorks:
      "This keeps small chats fast while still advertising the full catalog to the planner. MCP-heavy workflows opt in per call.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "search-unified",
    title: "Unified search",
    shortDescription:
      "Single search tool for keyword, semantic, or structural queries across the repo (replaces scattered find helpers).",
    category: "code",
    steps: [
      "Ask in Build mode to locate symbols, routes, or text",
      "Mention files or folders to narrow scope",
      "Narrow with a path or include glob for a tighter sweep",
    ],
    howItWorks:
      "glob finds files by name; grep searches contents with ripgrep (respecting .gitignore) and returns matches grouped by file — the same fast primitive Claude Code / opencode use.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "editing",
    title: "Edits & codegen",
    shortDescription:
      "Natural-language edits land as diffs you approve before they hit disk.",
    category: "code",
    steps: [
      "Build mode",
      "Describe the change",
      "Accept or reject the diff in chat",
      "Iterate from Errors if tests fail",
    ],
    // Approvals moved INLINE into chat in v14.15.0 when the Preview pane was removed;
    // there is no right-panel Permissions tab to send anyone to (the right panel is
    // Browser / Terminal / Plan / Automations / Errors).
    howItWorks:
      "File writes and shell commands wait for approval inline in chat with a diff preview — you can accept or reject individual hunks, not just whole files.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "tests-env",
    title: "Tests, environment & git",
    shortDescription:
      "Run tests, check toolchains, and inspect git + session summaries from chat tools.",
    category: "code",
    steps: [
      "Ask the model to run targeted tests",
      "Use git summaries before pushing",
      "check_environment before new toolchain work",
    ],
    howItWorks:
      "These tools share the same approval rules as other command executions.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "repo-skills",
    title: "Skills (.atlarix/skills/)",
    shortDescription:
      "Markdown files under `.atlarix/skills/` that teach Atlarix a repeatable job.",
    category: "skills",
    steps: [
      "Add a markdown file to `.atlarix/skills/` — or ask Atlarix to write one",
      "Commit it like other project docs",
      "Atlarix reads it when the job comes up",
    ],
    howItWorks:
      "Atlarix sees every skill's name and description on each turn, and reads the full file only when one is relevant — so the count does not cost you prompt space. Settings → Skills lists what a workspace has and shows you any of them.",
    link: { label: "Settings → Skills", to: "/integrations/skills" },
  },
  {
    id: "mcp-manual",
    title: "MCP servers (manual)",
    shortDescription:
      "Wire stdio or HTTP MCP servers globally or per workspace, up to ten per workspace.",
    category: "mcp",
    steps: [
      "Settings → Tools → MCP",
      "Add command or URL + env",
      "Approve tool calls per capability",
    ],
    howItWorks:
      "Manual entries are unchanged by the MCP marketplace; they are ideal for private or bespoke servers.",
    link: { label: "Settings → MCP", to: "/settings" },
  },
  {
    id: "mcp-marketplace",
    title: "MCP marketplace",
    shortDescription:
      "One-click installs from the curated atlarix-mcps registry.",
    category: "mcp",
    steps: [
      "Open MCP → Marketplace tab",
      "Filter or search",
      "Connect with env vars, choose scope",
    ],
    howItWorks:
      "Registry rows carry installUrl metadata; installs still respect the same caps as manual servers.",
    link: { label: "Settings → MCP marketplace", to: "/settings" },
  },
  {
    id: "mcp-ondemand",
    title: "On-demand MCP in workspace chat",
    shortDescription:
      "list_available_mcps and mcp_call attach external tools without flooding every turn.",
    category: "mcp",
    steps: [
      "Work inside a workspace chat",
      "Let the model list servers when needed",
      "Approve individual MCP tool calls",
    ],
    howItWorks:
      "Workspace sessions no longer auto-merge every MCP definition into the initial tool bundle.",
    link: { label: "Workspace chat", to: "/" },
  },
  {
    id: "agent-browser",
    title: "Agent browser & dev-server testing",
    shortDescription:
      "The agent opens your local dev server (or any public site) in its own background browser and drives it — navigate, click, fill, screenshot, and verify. For sites you are signed into, it works in your Chrome through the Atlarix extension.",
    category: "browser",
    steps: [
      "Start the dev command from Build",
      "Ask the agent to open the URL and test the flow",
      "Check the Errors and Network tabs in the right panel",
    ],
    howItWorks:
      "The agent's browser captures runtime errors (console, uncaught exceptions with stack, failed requests) into the Errors and Network tabs, so UI failures line up with code. Anything that needs your logins goes to your own Chrome via the extension.",
    link: { label: "Right panel → Errors", to: "/" },
  },
  {
    id: "websearch",
    title: "Web search",
    shortDescription:
      "Two plain tools: web_search returns the top results, read_url reads one page.",
    category: "integration",
    steps: [
      "Ask for external docs, versions, error strings or CVEs",
      "The agent searches, reads the promising pages, and searches again",
      "For a broad question it hands the research to the explore sub-agent",
    ],
    howItWorks:
      "Search runs through Atlarix's own hidden browser, with nothing to install; models with built-in search use their provider's instead. Every answer cites the pages it read.",
    link: { label: "Settings → Search", to: "/settings" },
  },
  {
    id: "workspace-connectors",
    title: "One-click connectors",
    shortDescription:
      "Connect Slack, Jira, Linear, Notion, Sentry, CI, and calendar as MCP servers with one click — pick org/repo/channel scope per chat session.",
    category: "integration",
    steps: [
      "Connect a service from Settings → MCP marketplace",
      "When a tool needs context, pick org/repo/channel scope for that chat session (clears on New Chat)",
    ],
    howItWorks:
      "Connectors run as MCP servers and never bypass the permission queue for writes.",
    link: { label: "Settings → MCP marketplace", to: "/settings" },
  },
];

const PER_PAGE = 4;

export default function ToolsPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [page, setPage] = useState(0);
  // Same source the model picker reads, so the page can't claim a lineup that isn't
  // configured. Empty while loading or when this build has no Core — the card just
  // omits the line rather than guessing.
  const { data: coreModels } = useAtlarixCoreCatalog();

  const filtered = useMemo(() => {
    let list = FEATURES;
    if (category !== "all") {
      list = list.filter((f) => f.category === category);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          f.shortDescription.toLowerCase().includes(q),
      );
    }
    return list;
  }, [category, searchQuery]);

  const paginated = useMemo(() => {
    const start = page * PER_PAGE;
    return filtered.slice(start, start + PER_PAGE);
  }, [filtered, page]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

  const goTo = (to: string, search?: Record<string, number>) => {
    navigate({ to, search });
  };

  return (
    <div className="flex-1 bg-background p-6 overflow-auto">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Tools</h1>
          <p className="text-muted-foreground text-sm">
            {/* "section-scoped Blueprint" named a tool removed in 2026-06, and "team
                features" named the Team tier that was killed in the pricing reframe.
                Both were advertised here after they stopped existing. */}
            What the desktop app can do today — modes, attachments, search,
            skills, MCP, the browser, and automations.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium text-foreground mb-1">Models</p>
          <p className="text-muted-foreground mb-2">
            {CORE_PAYMENT_SUMMARY} Every feature is on every plan — workspaces,
            skills, the MCP marketplace, one-click connectors, automations —
            plus your own keys and local models. What you pay for is Atlarix
            Core inference.
          </p>
          {/* The live lineup, so this card states what is ACTUALLY configured rather
              than a hardcoded count. `useAtlarixCoreCatalog` omits unmapped slots, so
              the list length follows `core-models.json` on its own. */}
          {coreModels.length > 0 ? (
            <p className="text-muted-foreground mb-2">
              Available now:{" "}
              <span className="text-foreground">
                {coreModels.map((m) => m.labelWithProvider).join(", ")}
              </span>
            </p>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => goTo("/settings")}>
            Open Settings
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tools..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setCategory(c.id);
                  setPage(0);
                }}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  category === c.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {paginated.map((f) => (
            <div
              key={f.id}
              className="p-4 border border-border rounded-lg bg-card flex flex-col gap-3"
            >
              <h3 className="font-semibold text-foreground text-sm">
                {f.title}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {f.shortDescription}
              </p>
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                {f.steps.slice(0, 3).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground/80 italic">
                {f.howItWorks}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-auto w-fit text-xs"
                onClick={() => goTo(f.link.to, f.link.search)}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                {f.link.label}
              </Button>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground text-sm">
            No tools match your search.
          </p>
        )}

        {totalPages > 1 && (
          <div className="flex justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground self-center">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
