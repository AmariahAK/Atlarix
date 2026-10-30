/**
 * Integrations — everything you connect Atlarix TO.
 *
 * WHY THIS IS ITS OWN TOP-LEVEL PAGE
 * ----------------------------------
 * Settings was one scroll of eleven equal-weight cards doing three unrelated
 * jobs, and the first attempt at fixing it split by SCOPE (global vs
 * per-project). That was the wrong seam: it left model providers next to
 * appearance and telemetry, which are not the same kind of thing at all, and it
 * put per-project MCP and Skills on a page whose name said nothing about them.
 *
 * The seam that actually sorts these is KIND:
 *
 *   Settings      — how the app behaves for you. Appearance, voice, search,
 *                   notifications, diagnostics. Preferences.
 *   Integrations  — what the app is wired up to, and what it is allowed to do
 *                   there. Model providers, MCP servers, Skills, commit
 *                   attribution, and this project's permissions.
 *
 * The test for a new surface: are you expressing a preference, or connecting
 * Atlarix to something outside itself? The second one belongs here.
 *
 * ONE THING PER SCREEN, deliberately. Each section is a route rather than
 * another anchor on a long scroll — MCP carries a marketplace tab and Skills a
 * paginated registry browser, so stacking them would have rebuilt the clutter
 * this page exists to remove, just under a better title.
 *
 * Sections are a mix of global (providers, co-author) and per-project (MCP,
 * Skills, permissions). That is fine, and it is why the per-project ones show
 * the active workspace in their own header rather than the page claiming a
 * single scope for everything.
 */

import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { SettingsWorkspaceNav } from "@/components/settings/SettingsWorkspaceNav";
import {
  Plug,
  Cpu,
  Server,
  Sparkles,
  GitCommitHorizontal,
  Shield,
  Puzzle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollableTabNav } from "@/components/ScrollableTabNav";

const SECTIONS = [
  {
    to: "/integrations",
    label: "Models & providers",
    icon: Cpu,
    hint: "Atlarix Core, your own API keys, and local models",
  },
  {
    to: "/integrations/mcp",
    label: "MCP servers",
    icon: Server,
    hint: "External tools, per project",
  },
  {
    to: "/integrations/skills",
    label: "Skills",
    icon: Sparkles,
    hint: "Agent behaviors, per project",
  },
  {
    to: "/integrations/silks",
    label: "Silks",
    icon: Puzzle,
    hint: "Skills, agents, commands, edicts and MCP servers you add",
  },
  {
    to: "/integrations/co-author",
    label: "Co-author",
    icon: GitCommitHorizontal,
    hint: "Whether Atlarix is credited on commits it makes",
  },
  {
    to: "/integrations/permissions",
    label: "Project permissions",
    icon: Shield,
    hint: "What the agent may run and write, per project",
  },
] as const;

function IntegrationsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <ScrollableTabNav label="Integrations" className="mb-8">
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        // Exact match for the index route, prefix match for children — so
        // /integrations/mcp does not also light up "Models & providers".
        const active =
          s.to === "/integrations"
            ? pathname === "/integrations" || pathname === "/integrations/"
            : pathname.startsWith(s.to);
        return (
          <Link
            key={s.to}
            to={s.to}
            title={s.hint}
            className={cn(
              "inline-flex shrink-0 whitespace-nowrap items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary/50 bg-primary/10 text-foreground font-medium"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {s.label}
          </Link>
        );
      })}
    </ScrollableTabNav>
  );
}

export function IntegrationsLayout() {
  return (
    <div className="flex-1 min-h-0 bg-background overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-6 pb-20">
        {/*
          THE WAY OUT. The left rail is `showWorkspaceChrome = selectedAppId != null`
          (`app/layout.tsx`), so with no workspace picked there is NO sidebar on any
          route — and this page had no back control of its own. Arriving here without
          a workspace therefore stranded the user completely: no nav, and a body that
          says "open a workspace from the welcome screen or sidebar" while showing
          neither. Settings has carried this nav for exactly this reason; Integrations
          was the one that did not, and the onboarding walked people straight into it.
        */}
        <SettingsWorkspaceNav className="mb-4" />
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Plug className="w-5 h-5 text-primary" aria-hidden />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Integrations</h1>
        </div>
        <p className="text-muted-foreground mb-8 max-w-2xl">
          What Atlarix is connected to, and what it is allowed to do there.
        </p>

        <IntegrationsNav />
        <Outlet />
      </div>
    </div>
  );
}
