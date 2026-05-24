import { describe, expect, it } from "vitest";
import { blueprintToMarkdown } from "@/lib/blueprint/blueprint-markdown";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

describe("blueprintToMarkdown toolMode", () => {
  it("includes summary and file paths", () => {
    const room: BlueprintRoom = {
      id: "r1",
      label: "mcp",
      path: "mcp",
      functions: [
        {
          id: "f1",
          name: "server",
          kind: "function",
          file: "src/mcp/server.ts",
        },
      ],
    };
    const bp: Blueprint = { rooms: [room], edges: [], envRefs: [] };
    const md = blueprintToMarkdown(bp, { toolMode: true, maxLines: 100 });
    expect(md).toContain("1 room(s)");
    expect(md).toContain("file: src/mcp/server.ts");
    expect(md).toContain("`server`");
  });
});
