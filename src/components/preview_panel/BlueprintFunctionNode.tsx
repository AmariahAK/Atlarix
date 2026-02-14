/**
 * Mini React Flow node for one function inside a room (Phase C/D).
 * Shows type icon + label + name; same styling as list.
 */

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { BlueprintFunction, BlueprintFunctionKind } from "@/shared/blueprint-types";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import { cn } from "@/lib/utils";

export type FunctionNodeData = {
  fn: BlueprintFunction;
};

interface FunctionNodeProps {
  data: FunctionNodeData;
  selected?: boolean;
}

function BlueprintFunctionNodeComponent({ data, selected }: FunctionNodeProps) {
  const { fn } = data;
  const config = FUNCTION_KIND_CONFIG[fn.kind as BlueprintFunctionKind] ?? FUNCTION_KIND_CONFIG.feature;
  const { Icon, label, borderClass, iconClass } = config;

  return (
    <div
      className={cn(
        "rounded-lg border-l-4 border border-border bg-card/80 px-2 py-1.5 min-w-[100px] shadow-sm transition-all cursor-pointer",
        borderClass,
        selected ? "ring-2 ring-offset-1 ring-offset-background ring-primary" : "hover:shadow-md"
      )}
    >
      <Handle type="target" position={Position.Top} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
      <Handle type="source" position={Position.Bottom} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
      <Handle type="target" position={Position.Left} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
      <Handle type="source" position={Position.Right} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
      <div className="flex items-center gap-1.5">
        <Icon className={cn("w-3 h-3 shrink-0", iconClass)} />
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground truncate">
            {label}
          </div>
          <div className="text-xs font-medium text-foreground truncate" title={fn.name}>
            {fn.name || "(unnamed)"}
          </div>
        </div>
      </div>
    </div>
  );
}

export const BlueprintFunctionNode = memo(BlueprintFunctionNodeComponent);
