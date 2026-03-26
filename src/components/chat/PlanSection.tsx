import React, { useState } from "react";
import { ChevronDown, ChevronUp, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlanCard } from "./PlanCard";
import type { PlanCardData } from "@/lib/plan-cards/plan-card-renderer";

interface PlanSectionProps {
  data: PlanCardData;
}

export function PlanSection({ data }: PlanSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={cn("mt-3 rounded-lg border border-border/70 bg-muted/20 overflow-hidden")}>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Plan</span>
          <span className="text-xs text-muted-foreground">
            {data.taskGroups.length} group{data.taskGroups.length === 1 ? "" : "s"}
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 border-t border-border/70">
          <PlanCard data={data} embedded />
        </div>
      )}
    </div>
  );
}

export default PlanSection;
