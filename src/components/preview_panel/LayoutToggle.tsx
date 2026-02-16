/**
 * Toggle between Diagram (grid) and Tree (hierarchical ELK) layout for Blueprint canvas.
 */

import { LayoutGrid, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

export type BlueprintLayoutMode = "diagram" | "tree";

interface LayoutToggleProps {
  mode: BlueprintLayoutMode;
  onChange: (mode: BlueprintLayoutMode) => void;
  className?: string;
}

export function LayoutToggle({ mode, onChange, className }: LayoutToggleProps) {
  return (
    <div
      className={cn(
        "inline-flex rounded-md border border-border bg-muted/50 p-0.5",
        className
      )}
      role="tablist"
      aria-label="Layout mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "diagram"}
        onClick={() => onChange("diagram")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border transition-colors",
          mode === "diagram"
            ? "bg-background text-foreground border-border shadow-sm"
            : "border-transparent text-muted-foreground hover:text-foreground"
        )}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        Diagram
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "tree"}
        onClick={() => onChange("tree")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border transition-colors",
          mode === "tree"
            ? "bg-background text-foreground border-border shadow-sm"
            : "border-transparent text-muted-foreground hover:text-foreground"
        )}
      >
        <GitBranch className="w-3.5 h-3.5" />
        Tree
      </button>
    </div>
  );
}
