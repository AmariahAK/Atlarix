import { describe, expect, it } from "vitest";
import {
  buildSlice,
  buildSliceWithResolve,
  isSectionRootPath,
  resolveSliceParams,
  roomMatchesScope,
  stripFocusPathPrefix,
} from "@/lib/blueprint/blueprint-slice";
import { blueprintToMarkdown } from "@/lib/blueprint/blueprint-markdown";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

function room(id: string, path: string, file?: string): BlueprintRoom {
  return {
    id,
    label: path,
    path,
    functions: file
      ? [{ id: `${id}-fn`, name: "main", kind: "function", file }]
      : [{ id: `${id}-fn`, name: "main", kind: "function" }],
  };
}

function mockBlueprint(rooms: BlueprintRoom[]): Blueprint {
  return {
    rooms,
    edges: rooms.length > 1 ? [{ from: rooms[0].id, to: rooms[1].id, type: "import" }] : [],
    envRefs: [],
  };
}

describe("isSectionRootPath", () => {
  it("treats . and missing path as section root", () => {
    expect(isSectionRootPath(undefined)).toBe(true);
    expect(isSectionRootPath(".")).toBe(true);
    expect(isSectionRootPath("./")).toBe(true);
    expect(isSectionRootPath("spacinsider-cli", "spacinsider-cli")).toBe(true);
  });

  it("does not treat subfolders as section root", () => {
    expect(isSectionRootPath("src")).toBe(false);
    expect(isSectionRootPath("spacinsider-cli/src", "spacinsider-cli")).toBe(false);
  });
});

describe("stripFocusPathPrefix", () => {
  it("strips focus_path prefix from workspace-relative paths", () => {
    expect(stripFocusPathPrefix("spacinsider-cli/src", "spacinsider-cli")).toBe("src");
    expect(stripFocusPathPrefix("spacinsider-cli", "spacinsider-cli")).toBe("");
  });
});

describe("resolveSliceParams", () => {
  it("widens folder + . to full section", () => {
    expect(resolveSliceParams("folder", ".", "spacinsider-cli")).toEqual({
      scope: "full",
      path: undefined,
    });
  });

  it("widens folder without path to full section", () => {
    expect(resolveSliceParams("folder", undefined, "spacinsider-cli")).toEqual({
      scope: "full",
      path: undefined,
    });
  });

  it("keeps folder drill-down for section-relative path", () => {
    expect(resolveSliceParams("folder", "src", "spacinsider-cli")).toEqual({
      scope: "folder",
      path: "src",
    });
  });

  it("strips focus_path from path before folder match", () => {
    expect(resolveSliceParams("folder", "spacinsider-cli/src", "spacinsider-cli")).toEqual({
      scope: "folder",
      path: "src",
    });
  });
});

describe("buildSlice", () => {
  const bp = mockBlueprint([
    room("r1", "src"),
    room("r2", "commands"),
    room("r3", "utils"),
  ]);

  it("returns all rooms for scope full", () => {
    const slice = buildSlice(bp, "full", undefined, 0);
    expect(slice.nodes.length).toBe(3);
  });

  it("matches RTE-style room path for folder scope path . via resolve", () => {
    const { slice } = buildSliceWithResolve(bp, "folder", ".", "spacinsider-cli", 0);
    expect(slice.nodes.length).toBe(3);
  });

  it("matches folder scope src", () => {
    const slice = buildSlice(bp, "folder", "src", 0);
    expect(slice.nodes.length).toBe(1);
    expect(slice.nodes[0].path).toBe("src");
  });

  it("matches file-tree absolute room path for folder src", () => {
    const abs = "/Users/me/repo/spacinsider-cli/src";
    const treeBp = mockBlueprint([room("r1", abs, `${abs}/index.ts`)]);
    const slice = buildSlice(treeBp, "folder", "src", 0);
    expect(slice.nodes.length).toBe(1);
  });
});

describe("buildSliceWithResolve auto-widen", () => {
  it("widens when drill-down matches nothing but section has rooms", () => {
    const bp = mockBlueprint([room("r1", "src"), room("r2", "commands")]);
    const { slice, sliceWidened } = buildSliceWithResolve(
      bp,
      "folder",
      "nonexistent",
      "spacinsider-cli",
      0,
    );
    expect(sliceWidened).toBe(true);
    expect(slice.nodes.length).toBe(2);
  });
});

describe("blueprintToMarkdown emptyReason", () => {
  it("uses slice_empty message instead of RTE unparsed text", () => {
    const md = blueprintToMarkdown(
      { rooms: [], edges: [], envRefs: [] },
      { emptyReason: "slice_empty", parsedRoomCount: 10 },
    );
    expect(md).toContain("Parse found 10 room(s)");
    expect(md).not.toContain("let the RTE parse it");
  });

  it("uses topic_filter message when topic zeroes rooms", () => {
    const md = blueprintToMarkdown(
      { rooms: [], edges: [], envRefs: [] },
      { emptyReason: "topic_filter" },
    );
    expect(md).toContain("topic filter");
  });
});

describe("roomMatchesScope file scope", () => {
  it("matches by function file basename", () => {
    const r = room("r1", "src", "/proj/spacinsider-cli/src/index.ts");
    expect(roomMatchesScope(r, "file", "index.ts")).toBe(true);
  });
});
