/**
 * Tools page – feature catalog with search, categories, and deep links into the app.
 */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Search,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Category =
  | "all"
  | "ai"
  | "code"
  | "blueprint"
  | "skills"
  | "mcp"
  | "preview"
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
  { id: "blueprint", label: "Blueprint" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "preview", label: "Preview" },
  { id: "models", label: "Models" },
  { id: "integration", label: "Workforce" },
];

const FEATURES: ToolFeature[] = [
  {
    id: "modes",
    title: "Work modes (Ask, Plan, Build, Debug, Review)",
    shortDescription:
      "Match the chat to the job: read-only exploration, structured planning, executing edits, debugging, or review passes.",
    category: "ai",
    steps: [
      "Pick a mode from the chat toolbar",
      "Ask stays read-only (no project writes)",
      "Plan shapes work before Build runs commands and file edits through approvals",
    ],
    howItWorks:
      "Modes change which tools the model may call. Build unlocks writes and terminal runs behind the permission queue; Ask limits you to safe, read-only tools.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "auto-routing",
    title: "Auto & Compass tiers",
    shortDescription:
      "Compass is the managed provider (no API key). Free gets Fast only; Pro and Workforce unlock Balanced and Thinking with higher monthly allowances.",
    category: "models",
    steps: [
      "Sign in for Compass, or add BYOK keys under Settings → Model Providers",
      "Toggle Auto in Config to route Fast / Balanced / Thinking when your plan allows",
      "Watch the context bar for long threads—Balanced/Thinking use tier-aware windows",
    ],
    howItWorks:
      "Compass tiers are enforced server-side. BYOK (OpenRouter, OpenAI, Anthropic, Gemini, local Ollama, etc.) can run alongside Compass—pick the active model per chat.",
    link: { label: "Settings → Providers", to: "/settings" },
  },
  {
    id: "workspace-open",
    title: "Open a workspace",
    shortDescription:
      "Start from the welcome screen with Open folder or Clone repo — no global chat without a project folder.",
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
    title: "Explore & Review sub-agents",
    shortDescription:
      "Up to five readonly sub-agents per turn, scoped to paths you choose — shown in the Sub-agents panel.",
    category: "ai",
    steps: [
      "In Build, ask to explore or review specific folders",
      "Watch scoped cards (e.g. Mapping: api) in the chat stream",
      "Expand a card for nested tools and progress",
    ],
    howItWorks:
      "Explore and Review sub-agents map repos in parallel with grouped tool summaries; Plan/Build/Debug do not expose delegation tools.",
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
      "Ask uses a read-only allowlist; workspace chats avoid merging every MCP tool by default",
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
    steps: ["Ask in Build mode to locate symbols, routes, or text", "Mention files or folders to narrow scope", "Pair with Blueprint for graph-backed structural lookups"],
    howItWorks:
      "Search modes share one entry point; structural mode leans on Blueprint data after you load the graph.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "editing",
    title: "Edits & codegen",
    shortDescription: "Natural-language edits land as diffs you approve before they hit disk.",
    category: "code",
    steps: ["Build mode", "Describe the change", "Approve in Permissions", "Iterate from Errors if tests fail"],
    howItWorks: "File writes and shell commands queue in the right panel with previews.",
    link: { label: "Right panel → Permissions", to: "/" },
  },
  {
    id: "tests-env",
    title: "Tests, environment & git",
    shortDescription: "Run tests, check toolchains, and inspect git + session summaries from chat tools.",
    category: "code",
    steps: ["Ask the model to run targeted tests", "Use git summaries before pushing", "check_environment before new toolchain work"],
    howItWorks: "These tools share the same approval rules as other command executions.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "autofix",
    title: "Errors panel",
    shortDescription: "Surface TypeScript, lint, and runtime issues; jump back into chat to fix.",
    category: "code",
    steps: ["Open Errors in the right stack", "Click a row to jump to code", "Use Fix with AI when you want a guided patch"],
    howItWorks: "Diagnostics aggregate preview + terminal output so you do not hunt tabs manually.",
    link: { label: "Right panel → Errors", to: "/" },
  },
  {
    id: "blueprint-graph",
    title: "Live Code Map (Blueprint)",
    shortDescription:
      "Section-scoped architecture via get_blueprint with focus_path—one folder at a time in monorepos, with path validation and compact Markdown for the model.",
    category: "blueprint",
    steps: [
      "Open a workspace with your repo",
      "In Build, ask the agent to map one top-level folder (e.g. packages/api) via get_blueprint",
      "Use the Blueprint canvas for Live view; chat uses the tool output, not whole-repo dumps",
    ],
    howItWorks:
      "Ctags symbols plus ast-grep import/call/route edges feed a richness gate; thin graphs get hybrid file-tree supplement. Default scope is full section; typos return did-you-mean suggestions. Agents follow the blueprint-section-first skill in-repo.",
    link: { label: "Home → Blueprint", to: "/" },
  },
  {
    id: "blueprint-commit",
    title: "Blueprint snapshot to git (Workforce)",
    shortDescription: "Serialize approved Blueprint snapshots back into the repository—gated to Workforce.",
    category: "blueprint",
    steps: ["Upgrade to Workforce", "Finalize a Blueprint layout", "Run commit_blueprint / snapshot flow from chat when enabled"],
    howItWorks: "This keeps design artifacts versioned beside code; Pro and Free tiers can still edit locally without auto-commit.",
    link: { label: "Settings → Subscription", to: "/settings" },
  },
  {
    id: "skills-marketplace",
    title: "Skills marketplace (Pro / Workforce)",
    shortDescription:
      "Install Apache-licensed playbooks from the public registry—five global slots and five per workspace.",
    category: "skills",
    steps: ["Settings → Skills", "Browse and install", "Use Build/Review modes to activate compatible skills"],
    howItWorks:
      "Skills shrink repetitive prompt boilerplate; they never replace your workspace instructions in `.atlarix/ATLARIX.md`.",
    link: { label: "Settings → Skills", to: "/settings" },
  },
  {
    id: "repo-skills",
    title: "Repo skills & Workforce priority",
    shortDescription:
      "Drop markdown skills under `.atlarix/skills/`. The priority flag is honored only for Workforce seats.",
    category: "skills",
    steps: ["Add skill files to `.atlarix/skills/`", "Commit them like other project docs", "Upgrade to Workforce to enforce priority ordering"],
    howItWorks: "Free and Pro still read the folder for context, but priority ordering remains a Workforce feature.",
    link: { label: "Open workspace folder", to: "/" },
  },
  {
    id: "mcp-manual",
    title: "MCP servers (manual)",
    shortDescription:
      "Wire stdio or HTTP MCP servers globally or per workspace. Free tier: one global server; Pro/Workforce: up to five global and five per workspace.",
    category: "mcp",
    steps: ["Settings → Tools → MCP", "Add command or URL + env", "Approve tool calls per capability"],
    howItWorks:
      "Manual entries are unchanged by the marketplace; they are ideal for private or bespoke servers.",
    link: { label: "Settings → MCP", to: "/settings" },
  },
  {
    id: "mcp-marketplace",
    title: "MCP marketplace (Pro / Workforce)",
    shortDescription:
      "One-click installs from the curated atlarix-mcps registry; pagination matches the skills browser.",
    category: "mcp",
    steps: ["Open MCP → Marketplace tab", "Filter or search", "Connect with env vars, choose scope"],
    howItWorks:
      "Registry rows carry installUrl metadata; installs still respect the same caps as manual servers. Some entries may be Workforce-only.",
    link: { label: "Settings → MCP marketplace", to: "/settings" },
  },
  {
    id: "mcp-ondemand",
    title: "On-demand MCP in workspace chat",
    shortDescription: "list_available_mcps and mcp_call attach external tools without flooding every turn.",
    category: "mcp",
    steps: ["Work inside a workspace chat", "Let the model list servers when needed", "Approve individual MCP tool calls"],
    howItWorks: "Workspace sessions no longer auto-merge every MCP definition into the initial tool bundle.",
    link: { label: "Workspace chat", to: "/" },
  },
  {
    id: "preview",
    title: "Live preview & dev server",
    shortDescription: "Embed your local dev server, parse output, and keep preview/errors linked.",
    category: "preview",
    steps: ["Start the dev command from Build", "Open Preview tab", "Resize breakpoints and watch hot reload"],
    howItWorks: "Preview shares state with the Errors tab so UI stack traces line up with code.",
    link: { label: "Right panel → Preview", to: "/" },
  },
  {
    id: "websearch",
    title: "Web & deep research",
    shortDescription: "Built-in web search when the provider supports it; optional local SearxNG via Docker.",
    category: "integration",
    steps: ["Ask for external docs or CVEs", "Review citations in Search tab", "Use deep research sparingly—it's multi-step"],
    howItWorks: "Remote calls obey your networking and consent settings; local search keeps traffic on-machine.",
    link: { label: "Home → Search tab", to: "/" },
  },
  {
    id: "workspace-workforce",
    title: "Workforce: teams, MCP integrations, session scope",
    shortDescription:
      "Workforce unlocks team billing (default five seats), the largest Compass pool, MCP-based team integrations, repo skill priority, Blueprint commit, and Workforce-only MCP catalog rows.",
    category: "integration",
    steps: [
      "Upgrade in Settings → Subscription",
      "Connect Slack, Jira, Linear, Sentry, CI, calendar under Settings → Workspace",
      "When a tool needs context, pick org/repo/channel scope for that chat session (clears on New Chat)",
    ],
    howItWorks:
      "Effective tier can follow your personal plan or team membership. Integrations never bypass the permission queue for writes.",
    link: { label: "Settings → Workspace", to: "/settings" },
  },
];

const PER_PAGE = 4;

export default function ToolsPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [page, setPage] = useState(0);

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
          f.shortDescription.toLowerCase().includes(q)
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
            What the desktop app can do today—modes, section-scoped Blueprint (Live Code Map), Skills, MCP, previews, and team features.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium text-foreground mb-1">Models & tiers</p>
          <p className="text-muted-foreground mb-2">
            Free includes Compass Fast plus BYOK/local models. Pro and Workforce unlock Compass Balanced &amp; Thinking, the Skills and MCP marketplaces, and higher MCP capacity.
            Workforce adds MCP-based team integrations, repo skill priority, Blueprint git snapshots, and pooled team usage.
          </p>
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
                    : "bg-muted text-muted-foreground hover:text-foreground"
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
              <h3 className="font-semibold text-foreground text-sm">{f.title}</h3>
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
