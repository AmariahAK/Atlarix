/**
 * Fallback Blueprint generation: file-tree beacons when ctags/ast-grep unavailable.
 */

import * as path from "path";
import type { BlueprintFunctionKind } from "@/shared/blueprint-types";
import { buildBlueprintFromFileTree } from "@/lib/blueprint/fileTreeSource";
import type { BlueprintNode, BlueprintNodeType, FrameworkInfo, RTEParseResult } from "./parsers/types";

function kindToNodeType(kind: BlueprintFunctionKind): BlueprintNodeType {
  switch (kind) {
    case "api":
      return "api";
    case "webhook":
      return "webhook";
    default:
      return "function";
  }
}

function relFilePath(projectPath: string, file: string | undefined): string {
  if (!file) return "";
  const normRoot = path.normalize(projectPath).replace(/\\/g, "/");
  const normFile = path.normalize(file).replace(/\\/g, "/");
  if (path.isAbsolute(file) && normFile.startsWith(normRoot)) {
    return path.relative(projectPath, file).replace(/\\/g, "/");
  }
  return file.replace(/\\/g, "/");
}

/** Convert file-tree Blueprint rooms/beacons into flat RTE nodes (edges from ast-grep when available). */
export function blueprintRoomsToNodes(
  projectPath: string,
  rooms: Awaited<ReturnType<typeof buildBlueprintFromFileTree>>["rooms"],
): BlueprintNode[] {
  const nodes: BlueprintNode[] = [];
  for (const room of rooms) {
    if (room.hidden) continue;
    for (const fn of room.functions ?? []) {
      const rel = relFilePath(projectPath, fn.file ?? fn.description);
      nodes.push({
        id: fn.id,
        type: kindToNodeType(fn.kind),
        name: fn.name,
        file: rel || (fn.description ?? "").replace(/\\/g, "/"),
        description: fn.description,
        simpleDescription: fn.simpleDescription,
        descriptionSource: fn.descriptionSource,
        roomId: room.id,
      });
    }
  }
  return nodes;
}

export async function generateBlueprintFromFileTree(
  projectPath: string,
  options: {
    framework?: FrameworkInfo;
    atlarixIgnoreSource?: string;
  } = {},
): Promise<RTEParseResult> {
  const { rooms } = await buildBlueprintFromFileTree(projectPath);
  const nodes = blueprintRoomsToNodes(projectPath, rooms);
  const framework = options.framework ?? { name: "file-tree", confidence: 0.5 };
  return {
    nodes,
    edges: [],
    framework,
    ...(options.atlarixIgnoreSource ? { atlarixIgnoreSource: options.atlarixIgnoreSource } : {}),
  };
}
