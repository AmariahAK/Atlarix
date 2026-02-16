/**
 * File-tree style view of containers and beacons.
 * Roots = top-level containers; children = beacons and sub-containers.
 */

import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FileCode } from "lucide-react";
import type { BlueprintRoom, BlueprintFunction } from "@/shared/blueprint-types";
import { cn } from "@/lib/utils";

interface BlueprintTreeProps {
  rooms: BlueprintRoom[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  className?: string;
}

function getRootRooms(rooms: BlueprintRoom[]): BlueprintRoom[] {
  return rooms.filter((r) => !r.parentId);
}

function getSubRooms(rooms: BlueprintRoom[], parentId: string): BlueprintRoom[] {
  return rooms.filter((r) => r.parentId === parentId);
}

function getTopLevelFunctions(functions: BlueprintFunction[]): BlueprintFunction[] {
  return functions.filter((f) => !f.parentId);
}

function getSubBeacons(functions: BlueprintFunction[], parentId: string): BlueprintFunction[] {
  return functions.filter((f) => f.parentId === parentId);
}

interface RoomRowProps {
  room: BlueprintRoom;
  allRooms: BlueprintRoom[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  level: number;
}

function RoomRow({ room, allRooms, selectedRoomId, onSelectRoom, level }: RoomRowProps) {
  const [expanded, setExpanded] = useState(level < 1);
  const subRooms = getSubRooms(allRooms, room.id);
  const topBeacons = getTopLevelFunctions(room.functions ?? []);
  const hasChildren = subRooms.length > 0 || topBeacons.length > 0;
  const isSelected = selectedRoomId === room.id;

  return (
    <li className="list-none">
      <div
        className={cn(
          "flex items-center gap-1 py-0.5 px-1.5 rounded text-xs cursor-pointer hover:bg-muted/60",
          isSelected && "bg-primary/15 text-foreground"
        )}
        style={{ paddingLeft: level * 12 + 4 }}
        onClick={() => onSelectRoom(room.id)}
      >
        <button
          type="button"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
          aria-expanded={expanded}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )
          ) : (
            <span className="w-3 h-3 inline-block" />
          )}
        </button>
        <Folder className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1 min-w-0">{room.label || "Container"}</span>
        {(room.functions?.length ?? 0) > 0 && (
          <span className="text-muted-foreground shrink-0">{room.functions!.length}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <ul className="ml-0">
          {topBeacons.map((fn) => (
            <li key={fn.id} className="list-none">
              <div
                className="flex items-center gap-1 py-0.5 px-1.5 rounded text-xs text-muted-foreground"
                style={{ paddingLeft: (level + 1) * 12 + 4 }}
              >
                <span className="w-3 h-3 inline-block" />
                <FileCode className="w-3 h-3 shrink-0" />
                <span className="truncate">{fn.name || fn.kind}</span>
              </div>
            </li>
          ))}
          {subRooms.map((sub) => (
            <RoomRow
              key={sub.id}
              room={sub}
              allRooms={allRooms}
              selectedRoomId={selectedRoomId}
              onSelectRoom={onSelectRoom}
              level={level + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function BlueprintTree({ rooms, selectedRoomId, onSelectRoom, className }: BlueprintTreeProps) {
  const roots = getRootRooms(rooms);
  if (roots.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground py-2", className)}>
        No containers yet. Add one on the canvas or from the toolbar.
      </p>
    );
  }
  return (
    <ul className={cn("space-y-0 py-1", className)}>
      {roots.map((room) => (
        <RoomRow
          key={room.id}
          room={room}
          allRooms={rooms}
          selectedRoomId={selectedRoomId}
          onSelectRoom={onSelectRoom}
          level={0}
        />
      ))}
    </ul>
  );
}
