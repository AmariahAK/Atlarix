/**
 * Mini React Flow node for one function inside a room (Phase C/D).
 * Connection handles shown only on hover to avoid accidental edges when dragging.
 */

import { memo } from "react";
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
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div
        className="flex items-center gap-1.5 min-w-0 flex-1"
        title={[
          fn.name || "(unnamed)",
          hasConnections
            ? [connectedOut?.length ? `→ ${connectedOut.join(", ")}` : "", connectedIn?.length ? `← ${connectedIn.join(", ")}` : ""].filter(Boolean).join(" · ")
            : null,
          fn.aiGenerated ? "AI-generated" : null,
        ].filter(Boolean).join(" · ")}
      >
        <Icon className={cn("w-3 h-3 shrink-0", iconClass)} />
        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">{label}</span>
        <span className="text-xs font-medium text-foreground truncate min-w-0 max-w-[5rem]" title={fn.name || "(unnamed)"}>{fn.name ? (fn.name.length > 12 ? fn.name.slice(0, 11) + "…" : fn.name) : "(unnamed)"}</span>
        {hasConnections && (
          <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-primary/15 text-primary text-[9px] font-medium">
            <GitBranch className="w-2.5 h-2.5" />
            {(connectedOut?.length ?? 0) + (connectedIn?.length ?? 0)}
          </span>
        )}
      </div>
    </div>
  );
}

export const BlueprintFunctionNode = memo(BlueprintFunctionNodeComponent);
