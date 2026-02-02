/**
 * Atlaflow Node - Custom node for ReactFlow
 * Displays n8n node type with a clean card style.
 */

import { memo } from "react";
import { Handle, type NodeProps, Position } from "@xyflow/react";

function AtlaflowNodeComponent({ data, selected }: NodeProps) {
  const label = (data?.label as string) ?? "Node";
  const nodeType = (data?.nodeType as string) ?? "";

  return (
    <div
      className={`
        px-3 py-2 rounded-lg border-2 min-w-[120px] bg-background shadow-sm
        ${selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-primary/50"}
      `}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-primary" />
      <div className="text-xs font-medium truncate" title={nodeType}>
        {label}
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-primary" />
    </div>
  );
}

export const AtlaflowNode = memo(AtlaflowNodeComponent);
