/**
 * Tools page – 4 features per view, search, categories, short descriptions and in-app links.
 */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Sparkles,
  Search,
  Network,
  Wrench,
  Globe,
  Eye,
  Zap,
  MessageSquare,
  FileCode,
  Database,
  Server,
  Workflow,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Category =
  | "all"
  | "ai"
  | "code"
  | "diagram"
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
  { id: "ai", label: "AI" },
  { id: "code", label: "Code" },
  { id: "diagram", label: "Diagram" },
  { id: "mcp", label: "MCP" },
  { id: "preview", label: "Preview" },
  { id: "models", label: "Models" },
  { id: "integration", label: "Integration" },
];

const FEATURES: ToolFeature[] = [
  {
    id: "codegen",
    title: "Intelligent Code Generation",
    shortDescription: "Generate apps from natural language. Context-aware, multi-framework.",
    category: "ai",
    steps: ["Open Home", "Select workspace", "Describe what you want in chat", "Review and iterate"],
    howItWorks: "Uses your selected model and workspace context to produce runnable code.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "chat",
    title: "Context-Aware Chat",
    shortDescription: "Ask questions, refactor, debug. Full workspace and history context.",
    category: "ai",
    steps: ["Select a workspace", "Use Ask or Build mode", "Reference files in chat", "Use right panel for preview/diagram"],
    howItWorks: "Chat is tied to the active workspace and shares context with Code/Diagram panels.",
    link: { label: "Home → Config", to: "/" },
  },
  {
    id: "editing",
    title: "Smart Code Editing",
    shortDescription: "Request precise edits in natural language. Structure and types preserved.",
    category: "code",
    steps: ["Build mode in chat", "Describe the change", "Approve edits in Permissions tab if prompted", "Save with Cmd+S"],
    howItWorks: "AI suggests file changes; you approve in the right panel. Errors tab shows issues.",
    link: { label: "Home → Code tab", to: "/" },
  },
  {
    id: "autofix",
    title: "Automated Problem Fixing",
    shortDescription: "Detect and fix TypeScript/lint errors. Optional auto-fix in settings.",
    category: "code",
    steps: ["Run dev server or build", "Open Errors tab in right panel", "Use Fix with AI or Mark done", "View code jumps to file/line"],
    howItWorks: "Errors from preview/terminal appear in the Errors tab. Fix with AI sends context to chat.",
    link: { label: "Right panel → Errors", to: "/" },
  },
  {
    id: "diagram",
    title: "Architecture Diagrams",
    shortDescription: "Generate and view project structure. Version history and restore.",
    category: "diagram",
    steps: ["Select workspace", "Open Diagram tab or generate from chat", "Toggle Live / History", "Export or copy Mermaid"],
    howItWorks: "Diagrams are generated from your codebase and stored per workspace.",
    link: { label: "Diagram full screen", to: "/diagram" },
  },
  {
    id: "preview",
    title: "Live Preview & Hot Reload",
    shortDescription: "See changes instantly. Mobile/tablet/desktop viewports.",
    category: "preview",
    steps: ["Start dev server (Build mode)", "Open Preview tab in right panel", "Resize or switch viewport", "Hot reload updates automatically"],
    howItWorks: "Iframe loads your app URL. Use Run command to start the dev server.",
    link: { label: "Right panel → Preview", to: "/" },
  },
  {
    id: "mcp",
    title: "MCP Servers & Tools",
    shortDescription: "Use external tools (e.g. filesystem, APIs) in chat. Global and per-workspace.",
    category: "mcp",
    steps: ["Settings → Tools (MCP)", "Add server (command or URL)", "In chat, open Config → Manage MCP tools", "Set consent per tool (Ask / Always / Deny)"],
    howItWorks: "In a workspace, chat sees global + that workspace's MCPs. No workspace = global only.",
    link: { label: "Settings → MCP", to: "/settings" },
  },
  {
    id: "models",
    title: "Models & Providers",
    shortDescription: "OpenRouter, Ollama, LM Studio, and others. Auto mode: one provider, 3 models.",
    category: "models",
    steps: ["Settings → Model Providers", "Add API keys for providers", "Config → Change model or Configure Auto (provider + Fast/Medium/Thinking)"],
    howItWorks: "Select a single model or turn on Auto and pick one provider + 3 models for routing.",
    link: { label: "Settings → Providers", to: "/settings" },
  },
  {
    id: "websearch",
    title: "Web Search",
    shortDescription: "Search the web from chat. Docs, Stack Overflow, examples.",
    category: "integration",
    steps: ["Ask in chat for docs or examples", "AI can use web search", "Results appear in Sources/Search tab"],
    howItWorks: "Web search is available when the provider supports it; results are shown in the panel.",
    link: { label: "Home → Search tab", to: "/" },
  },
  {
    id: "db",
    title: "Database (Supabase / Neon)",
    shortDescription: "Connect DBs, schemas, migrations. AI assistance for data layer.",
    category: "integration",
    steps: ["Settings → Supabase or Neon", "Connect project", "Reference in chat for schemas/migrations"],
    howItWorks: "Credentials stored securely; AI can generate SQL and migrations.",
    link: { label: "Settings", to: "/settings" },
  },
  {
    id: "agent-delegation",
    title: "Agent Delegation (delegate_to_agent)",
    shortDescription: "Hand off to Research, Architect, Builder, or Reviewer. Guided (flat) or Autonomous (nested) delegation.",
    category: "ai",
    steps: ["Select Guided or Autonomous mode in chat", "Ask for research, architecture, or implementation", "AI delegates to the right agent; see activity in the response"],
    howItWorks: "In Guided mode the main model delegates once to a specialist. In Autonomous mode agents can delegate to each other up to a depth limit.",
    link: { label: "Home → Chat", to: "/" },
  },
  {
    id: "blueprint-containers-beacons",
    title: "Blueprint — Containers & Beacons",
    shortDescription: "Design architecture with containers and beacons. get_blueprint, compare_blueprint_to_live, add/update rooms, functions, edges. Generate code from Blueprint.",
    category: "diagram",
    steps: ["Open Diagram tab, switch to Blueprint mode", "Add containers and beacons manually or ask AI (add_blueprint_room, add_blueprint_function, add_blueprint_edge)", "Use compare_blueprint_to_live to see desired vs actual", "Generate code from Blueprint delta when ready"],
    howItWorks: "Blueprint tools (get_blueprint, add_blueprint_room, add_blueprint_function, add_blueprint_edge, update_blueprint, compare_blueprint_to_live) let the AI or you design the architecture; then compare to live and generate code.",
    link: { label: "Diagram tab → Blueprint", to: "/" },
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
            Features, where to use them, and how to set up.
          </p>
        </div>

        {/* Setup models */}
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium text-foreground mb-1">Setup models</p>
          <p className="text-muted-foreground mb-2">
            Add API keys in Settings → Model Providers. For Auto mode, use Config → Configure Auto (provider + 3 models).
          </p>
          <Button variant="outline" size="sm" onClick={() => goTo("/settings")}>
            Open Settings
          </Button>
        </div>

        {/* Search + categories */}
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

        {/* Grid: 4 per view */}
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

        {/* Pagination */}
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
