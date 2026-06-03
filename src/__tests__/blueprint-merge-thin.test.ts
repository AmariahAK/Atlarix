import { describe, expect, it } from "vitest";
import { mergeBlueprintWithFileTree } from "@/lib/blueprint/blueprint-merge";
import { assessBlueprintRichness } from "@/lib/blueprint/blueprint-quality";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

function rteRoom(id: string, label: string, fns: Array<{ name: string; file?: string }>): BlueprintRoom {
  return {
    id,
    label,
    path: label,
    functions: fns.map((f, i) => ({
      id: `${id}-fn-${i}`,
      name: f.name,
      kind: "function" as const,
      file: f.file,
    })),
  };
}

function fileTreeRoom(id: string, label: string, files: string[]): BlueprintRoom {
  return {
    id,
    label,
    path: `/proj/${label}`,
    functions: files.map((f) => ({
      id: `${id}::${f.split("/").pop()}`,
      name: f.split("/").pop()!.replace(/\.\w+$/, ""),
      kind: "function" as const,
      description: f,
      file: `/proj/${f}`,
    })),
  };
}

describe("mergeBlueprintWithFileTree", () => {
  it("skips merge for rich ast-grep graphs with edges", () => {
    const rooms = Array.from({ length: 10 }, (_, i) =>
      rteRoom(
        `r${i}`,
        `mod${i}`,
        Array.from({ length: 5 }, (_, j) => ({
          name: `fn${j}`,
          file: `src/mod${i}/file${j}.ts`,
        })),
      ),
    );
    const bp: Blueprint = {
      rooms,
      edges: [{ from: rooms[0].id, to: rooms[1].id, type: "import" }],
      envRefs: [],
    };
    expect(assessBlueprintRichness(bp).quality).toBe("rich");
    const merged = mergeBlueprintWithFileTree(
      bp,
      [fileTreeRoom("ft1", "extra", ["src/extra.ts"])],
      [],
      { engine: "ast-grep+ctags" },
    );
    expect(merged.rooms.length).toBe(bp.rooms.length);
  });

  it("appends file-tree rooms when RTE graph is thin despite edges", () => {
    const sparse: Blueprint = {
      rooms: [
        rteRoom("room_src", "src", [{ name: "main", file: "src/index.ts" }]),
      ],
      edges: [{ from: "room_src", to: "room_src", type: "call" }],
      envRefs: [],
    };
    expect(assessBlueprintRichness(sparse).quality).toBe("thin");

    const inferred = [
      fileTreeRoom("mcp", "mcp", ["src/mcp/server.ts", "src/mcp/tools.ts"]),
      fileTreeRoom("gchat", "gchat", ["src/gchat/server.ts"]),
      fileTreeRoom("db", "db", ["src/db/schema.sql"]),
    ];

    const merged = mergeBlueprintWithFileTree(sparse, inferred, [], {
      engine: "ast-grep+ctags",
    });

    expect(merged.rooms.length).toBeGreaterThan(1);
    const labels = merged.rooms.map((r) => r.label.toLowerCase());
    expect(labels.some((l) => l.includes("mcp") || l.includes("gchat") || l.includes("db"))).toBe(
      true,
    );
    const fnCount = merged.rooms.reduce((n, r) => n + (r.functions?.length ?? 0), 0);
    expect(fnCount).toBeGreaterThan(3);
  });

  it("backfills functions on matching rooms", () => {
    const sparse: Blueprint = {
      rooms: [rteRoom("mcp", "mcp", [])],
      edges: [],
      envRefs: [],
    };
    const inferred = [fileTreeRoom("mcp", "mcp", ["src/mcp/server.ts"])];
    const merged = mergeBlueprintWithFileTree(sparse, inferred, [], { engine: "file-tree" });
    const mcp = merged.rooms.find((r) => r.label === "mcp");
    expect(mcp?.functions?.length).toBeGreaterThan(0);
  });
});
