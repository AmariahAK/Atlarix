import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type VisualArtifactLayout = "content" | "canvas";

export function VisualArtifactCard({
  title,
  children,
  defaultExpanded = true,
  className,
  /** content = tables/charts (fill width); canvas = diagrams (child owns scroll/center) */
  layout = "content",
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  className?: string;
  layout?: VisualArtifactLayout;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isCanvas = layout === "canvas";

  return (
    <Card className={cn("my-2 overflow-hidden not-prose", className)}>
      <CardHeader className="flex flex-row items-center gap-2 py-2 px-3 space-y-0">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 text-left text-sm font-medium hover:bg-muted/40 rounded-md -mx-1 px-1"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{title}</span>
        </button>
      </CardHeader>
      {expanded ? (
        <CardContent className="pt-0 pb-3 px-3 min-h-0">
          <div
            className={cn(
              "w-full rounded-md border border-border/30",
              isCanvas
                ? "h-[min(420px,55vh)] overflow-hidden"
                : "max-h-[min(420px,55vh)] overflow-auto overscroll-contain",
            )}
          >
            <div
              className={cn(
                isCanvas
                  ? "h-full w-full min-h-0 flex flex-col"
                  : "w-full min-w-0 p-2",
              )}
            >
              {children}
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
