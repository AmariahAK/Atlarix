/**
 * Custom React Flow node: room card with type-based color, label, function count, handles.
 * Connection handles shown only on hover to avoid accidental edges when dragging.
 */

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { FileCode, GripVertical } from "lucide-react";
import type { BlueprintRoom } from "@/shared/blueprint-types";
import { getRoomStyle } from "@/lib/blueprint/room_colors";
import { cn } from "@/lib/utils";

export type RoomNodeData = {
  room: BlueprintRoom;
  /** v2.5: Agent phase for canvas animations */
  agentPhase?: "architect" | "builder" | "reviewer";
  agentPhaseActive?: boolean;
};

interface RoomNodeProps {
  data: RoomNodeData;
  selected?: boolean;
}

function BlueprintRoomNodeComponent({ data, selected }: RoomNodeProps) {
  const { room, agentPhase, agentPhaseActive } = data;
  const count = room.functions?.length ?? 0;
  const style = getRoomStyle(room);
  const active = agentPhaseActive === true;
  const architectOn = agentPhase === "architect" && active;
  const builderOn = agentPhase === "builder" && active;

  return (
    <div
      className={cn(
        "relative min-w-[120px] rounded-lg border px-2 py-1.5 pl-5 shadow-sm transition-all cursor-pointer",
        style.bg,
        style.border,
        selected ? "ring-2 ring-offset-2 ring-offset-background ring-muted-foreground shadow-md scale-[1.02]" : "hover:shadow-md hover:scale-[1.01]",
        architectOn && "atlarix-container-forming",
        builderOn && "atlarix-beacon-highlight"
      )}
    >
      <div
        className={cn("room-drag-handle absolute left-1 top-1.5 p-0.5 rounded cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none")}
        title="Drag to move"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      <div
        className="flex items-center gap-1.5 min-w-0 flex-1"
        title={[room.label || "Container", count ? `${count} beacon${count !== 1 ? "s" : ""}` : null, room.intent].filter(Boolean).join(" · ")}
      >
        <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded border", style.badgeClass)}>
          {style.label}
        </span>
        <span className="font-medium text-xs truncate text-foreground">
          {room.label || "Container"}
        </span>
        {count > 0 && (
          <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <FileCode className="h-2.5 w-2.5" />
            {count}
          </span>
        )}
      </div>
    </div>
  );
}

export const BlueprintRoomNode = memo(BlueprintRoomNodeComponent);
