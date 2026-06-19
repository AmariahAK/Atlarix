import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { Globe, MousePointerClick, Keyboard, Eye, Camera, Compass } from "lucide-react";

/**
 * Browser session record — the ordered list of what the agent did in the
 * built-in browser (navigate/click/fill/read/screenshot), Antigravity-style,
 * with an optional final screenshot. Sourced from the in-memory recorder.
 */

const STEP_ICON: Record<string, typeof Globe> = {
  navigate: Compass,
  click: MousePointerClick,
  fill: Keyboard,
  read: Eye,
  screenshot: Camera,
};

const STEP_LABEL: Record<string, string> = {
  navigate: "Navigate",
  click: "Click",
  fill: "Fill",
  read: "Read",
  screenshot: "Screenshot",
};

export function ToolBrowserRecordingExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "browser_recording" }>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <Globe className="h-3 w-3 shrink-0" />
        <span>
          Browser session · {view.steps.length} step{view.steps.length === 1 ? "" : "s"}
        </span>
      </div>
      <ol className="space-y-0.5">
        {view.steps.map((step, i) => {
          const Icon = STEP_ICON[step.type] ?? Globe;
          return (
            <li
              key={i}
              className="flex items-start gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted/40"
            >
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/60">
                {i + 1}
              </span>
              <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium text-foreground/80">
                {STEP_LABEL[step.type] ?? step.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={step.detail}>
                {step.detail}
                {step.url ? (
                  <span className="ml-1 text-muted-foreground/50">· {step.url}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {view.dataUrl ? (
        <div className="max-h-72 overflow-auto rounded border border-border">
          <img
            src={view.dataUrl}
            alt={`Screenshot of ${view.title || view.url || "page"}`}
            className="w-full"
          />
        </div>
      ) : null}
    </div>
  );
}
