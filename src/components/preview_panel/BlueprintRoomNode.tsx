/**
 * Custom React Flow node: room card with type-based color, label, function count, handles.
 * Click to select; type colors: API, Backend, Frontend, DB, Webhook, DevOps, etc.
 */

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { FileCode, GripVertical } from "lucide-react";
import type { BlueprintRoom } from "@/shared/blueprint-types";
import { getRoomStyle } from "@/lib/blueprint/room_colors";
import { cn } from "@/lib/utils";

export type RoomNodeData = {
  room: BlueprintRoom;
};

interface RoomNodeProps {
  data: RoomNodeData;
  selected?: boolean;
}

function BlueprintRoomNodeComponent({ data, selected }: RoomNodeProps) {
  const { room } = data;
  const count = room.functions?.length ?? 0;
  const style = getRoomStyle(room);

  return (
    <div
      className={cn(
        "relative min-w-[140px] rounded-lg border px-3 py-2 pl-6 shadow-sm transition-all cursor-pointer",
        style.bg,
        style.border,
        selected ? "ring-2 ring-offset-2 ring-offset-background ring-muted-foreground shadow-md scale-[1.02]" : "hover:shadow-md hover:scale-[1.01]"
      )}
    >
      <div
        className={cn("room-drag-handle absolute left-1 top-1.5 p-0.5 rounded cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none")}
        title="Drag to move"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-muted-foreground/70" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-muted-foreground/70" />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-muted-foreground/70" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-muted-foreground/70" />

      <div className="flex items-start gap-2">
        <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border", style.badgeClass)}>
          {style.label}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate text-foreground" title={room.label}>
            {room.label || "Room"}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
            <FileCode className="h-3 w-3 shrink-0" />
            <span>{count} function{count !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>
      {room.intent && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={room.intent}>
          {room.intent}
        </div>
      )}
    </div>
  );
}

export const BlueprintRoomNode = memo(BlueprintRoomNodeComponent);
