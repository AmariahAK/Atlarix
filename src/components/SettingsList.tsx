import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import { useScrollAndNavigateTo } from "@/hooks/useScrollAndNavigateTo";
import { useAtom } from "jotai";
import { activeSettingsSectionAtom } from "@/atoms/viewAtoms";

// Every id here MUST match a real `<div id="…">` in src/pages/settings.tsx —
// the sidebar scrolls to the element by id, so an entry with no section is a
// dead link that silently does nothing. ("team" was exactly that, left behind
// when the Team tier was removed in the pricing reframe.)
const settingsItems = [
  { id: "general", label: "General" },
  { id: "workflow", label: "Workflow" },
  { id: "ai", label: "AI" },
  { id: "search", label: "Search" },
  { id: "mcp", label: "MCP Servers" },
  { id: "skills", label: "Skills" },
  { id: "integrations", label: "Integrations" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "community", label: "Community" },
  { id: "danger-zone", label: "Danger Zone" },
];

export function SettingsList({ show }: { show: boolean }) {
  const [activeSection, setActiveSection] = useAtom(activeSettingsSectionAtom);
  const scrollAndNavigateTo = useScrollAndNavigateTo("/settings", {
    behavior: "smooth",
    block: "start",
  });

  /**
   * Scroll-spy: highlight whichever section you're actually looking at.
   *
   * The previous IntersectionObserver never ran. This sidebar lives in
   * `app-sidebar.tsx` and mounts with the whole app, so its one-shot effect
   * fired long before `/settings` existed — every `getElementById` returned
   * null and nothing was ever observed. It also used
   * `rootMargin: "-20% 0px -80% 0px"`, which insets 20% from the top and 80%
   * from the bottom: a detection band of exactly ZERO height.
   *
   * Replaced with a direct scroll listener over the settings page's own scroll
   * container. It computes the active section from live geometry on every
   * frame, so it can't get out of sync with the DOM, and it re-attaches when
   * the panel is shown.
   */
  useEffect(() => {
    if (!show) return;

    let raf = 0;
    let detach: (() => void) | null = null;

    /** The section whose heading has most recently passed the read line. */
    const recompute = () => {
      raf = 0;
      const line = window.innerHeight * 0.25;
      let current: string | null = null;
      for (const section of settingsItems) {
        const el = document.getElementById(section.id);
        if (!el) continue;
        const { top, bottom } = el.getBoundingClientRect();
        // Above the line and not yet scrolled past → this is the one. Sections
        // are in document order, so the last match wins.
        if (top <= line && bottom > 0) current = section.id;
      }
      // Before the first heading reaches the line, keep the first section lit
      // rather than blanking the sidebar.
      setActiveSection(current ?? settingsItems[0].id);
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(recompute);
    };

    /**
     * The page renders on a later tick than this effect, so poll briefly for
     * the scroll container instead of assuming it's already there — that
     * mount-order assumption is what broke the original.
     */
    let tries = 0;
    const attach = () => {
      const first = document.getElementById(settingsItems[0].id);
      const scroller = first?.closest<HTMLElement>(".overflow-auto");
      if (!scroller) {
        if (tries++ < 60) raf = requestAnimationFrame(attach);
        return;
      }
      scroller.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
      detach = () => {
        scroller.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      };
      recompute();
    };
    attach();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      detach?.();
    };
  }, [show, setActiveSection]);

  if (!show) {
    return null;
  }

  const handleScrollAndNavigateTo = scrollAndNavigateTo;
  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 p-4">
        <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
      </div>
      <ScrollArea className="flex-grow">
        {/* Settings Sections */}
        <div className="space-y-1 p-4 pt-4">
          {settingsItems.map((section) => (
            <button
              key={section.id}
              onClick={() => handleScrollAndNavigateTo(section.id)}
              className={cn(
                "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                activeSection === section.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                  : "hover:bg-sidebar-accent",
              )}
            >
              {section.label}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
