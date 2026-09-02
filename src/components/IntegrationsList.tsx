import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";

/**
 * Sidebar sub-nav for /integrations.
 *
 * Mirrors `SettingsList`, with one deliberate difference: these entries are
 * ROUTE LINKS, not scroll targets. Each Integrations section is its own route
 * because two of them (the MCP marketplace, the Skills registry browser) are
 * substantial pages in their own right — stacking them on one scroll would have
 * rebuilt the clutter the split exists to remove, just under a better title.
 *
 * So there is no scroll-spy here and no id-parity hazard: the router decides
 * what is active, and a wrong path fails at COMPILE time because TanStack's
 * `to` is a typed union. That is a strictly better guard than the one
 * `settings-nav-parity.test.ts` had to be written to provide for the other list.
 */

const items = [
  { to: "/integrations", label: "Models & providers" },
  { to: "/integrations/mcp", label: "MCP servers" },
  { to: "/integrations/skills", label: "Skills" },
  { to: "/integrations/co-author", label: "Co-author" },
  { to: "/integrations/permissions", label: "Project permissions" },
] as const;

export function IntegrationsList({ show }: { show: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (!show) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 p-4">
        <h2 className="text-lg font-semibold tracking-tight">Integrations</h2>
      </div>
      <ScrollArea className="flex-grow">
        <div className="space-y-1 p-4 pt-4">
          {items.map((item) => {
            // Exact match for the index, prefix for children — otherwise
            // /integrations/mcp would also light up "Models & providers".
            const active =
              item.to === "/integrations"
                ? pathname === "/integrations" || pathname === "/integrations/"
                : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "block w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                    : "hover:bg-sidebar-accent",
                )}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
