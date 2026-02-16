/**
 * Mini React Flow node for one function inside a room (Phase C/D).
 * Connection handles shown only on hover to avoid accidental edges when dragging.
 */

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import type { BlueprintFunction, BlueprintFunctionKind } from "@/shared/blueprint-types";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import { cn } from "@/lib/utils";

export type FunctionNodeData = {
  fn: BlueprintFunction;
  /** Names of nodes this function connects to (outgoing) */
  connectedOut?: string[];
  /** Names of nodes that connect to this function (incoming) */
  connectedIn?: string[];
};

interface FunctionNodeProps {
  data: FunctionNodeData;
  selected?: boolean;
}

function BlueprintFunctionNodeComponent({ data, selected }: FunctionNodeProps) {
  const [showHandles, setShowHandles] = useState(false);
  const { fn, connectedOut, connectedIn } = data;
  const config = FUNCTION_KIND_CONFIG[fn.kind as BlueprintFunctionKind] ?? FUNCTION_KIND_CONFIG.feature;
  const { Icon, label, borderClass, iconClass } = config;
  const hasConnections = (connectedOut?.length ?? 0) > 0 || (connectedIn?.length ?? 0) > 0;

  return (
    <div
      className={cn(
        "rounded-lg border-l-4 border border-border bg-card/80 px-2 py-1.5 min-w-[100px] shadow-sm transition-all cursor-pointer",
        borderClass,
        selected ? "ring-2 ring-offset-1 ring-offset-background ring-primary" : "hover:shadow-md"
      )}
      onMouseEnter={() => setShowHandles(true)}
      onMouseLeave={() => setShowHandles(false)}
    >
      {showHandles && (
        <>
          <Handle type="target" position={Position.Top} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
          <Handle type="source" position={Position.Bottom} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
          <Handle type="target" position={Position.Left} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
          <Handle type="source" position={Position.Right} className="!w-1.5 !h-1.5 !bg-muted-foreground/70" />
        </>
      )}
      <div className="flex items-center gap-1.5">
        <Icon className={cn("w-3 h-3 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground truncate">
              {label}
            </div>
            {hasConnections && (
              <span
                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-primary/15 text-primary text-[9px] font-medium shrink-0"
                title={[
                  connectedOut?.length ? `→ ${connectedOut.join(", ")}` : "",
                  connectedIn?.length ? `← ${connectedIn.join(", ")}` : "",
                ].filter(Boolean).join(" · ")}
              >
                <GitBranch className="w-2.5 h-2.5" />
                {(connectedOut?.length ?? 0) + (connectedIn?.length ?? 0)}
              </span>
            )}
          </div>
          <div className="text-xs font-medium text-foreground truncate" title={fn.name}>
            {fn.name || "(unnamed)"}
          </div>
          {fn.aiGenerated && (
            <div className="text-[9px] text-muted-foreground italic truncate" title="Created by AI from container prompt">
              (AI-generated)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const BlueprintFunctionNode = memo(BlueprintFunctionNodeComponent);
