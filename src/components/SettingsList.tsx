import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";

/**
 * Sidebar sub-nav for /settings.
 *
 * THIS USED TO BE A SCROLL-SPY. Sections were anchors on one long page, so
 * knowing which one you were looking at took ~60 lines of live geometry: a
 * scroll listener recomputing on every frame, after an earlier
 * IntersectionObserver attempt that never ran (it mounted with the whole app,
 * long before /settings existed) and whose `rootMargin` described a detection
 * band of exactly zero height.
 *
 * Every section is a ROUTE now, so the router answers the question and all of
 * that is deleted. Two hazards go with it: `settings-nav-parity.test.ts` had to
 * exist because an entry whose id no longer matched a `<div id="…">` was a
 * silently dead link — a route path is a typed union, so a wrong one fails to
 * compile — and there is no longer an ordering coupling between this list and
 * the page's document order.
 */

const items = [
  { to: "/settings", label: "General" },
  { to: "/settings/diagnostics", label: "Diagnostics" },
  { to: "/settings/browser", label: "Browser" },
  { to: "/settings/search", label: "Search" },
  { to: "/settings/notifications", label: "Notifications" },
  { to: "/settings/voice", label: "Voice input" },
  { to: "/settings/community", label: "Community" },
  { to: "/settings/danger", label: "Danger zone" },
] as const;

export function SettingsList({ show }: { show: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (!show) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 p-4">
        <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
      </div>
      <ScrollArea className="flex-grow">
        <div className="space-y-1 p-4 pt-4">
          {items.map((item) => {
            // Exact match for the index, prefix for children — otherwise
            // /settings/browser would also light up "General".
            const active =
              item.to === "/settings"
                ? pathname === "/settings" || pathname === "/settings/"
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
