import { describe, expect, it } from "vitest";
import {
  parseGraphSpec,
  formatGraphFence,
  normalizeDiagramAiOutput,
  isLegacyMermaidContent,
} from "@/lib/visual-artifacts/graph-spec";

describe("parseGraphSpec", () => {
  it("parses minimal nodes and edges", () => {
    const raw = JSON.stringify({
      title: "Workspace flow",
      nodes: [
        { id: "0", name: "User" },
        { id: "1", name: "Workspace" },
      ],
      edges: [{ source: "0", target: "1" }],
    });
    const spec = parseGraphSpec(raw);
    expect(spec?.title).toBe("Workspace flow");
    expect(spec?.nodes).toHaveLength(2);
    expect(spec?.edges).toEqual([{ source: "0", target: "1" }]);
    expect(spec?.layout).toBe("force");
  });

  it("strips graph code fence", () => {
    const fenced = '```graph\n{"nodes":[{"id":"a","name":"A"}],"edges":[]}\n```';
    expect(parseGraphSpec(fenced)?.nodes[0]?.name).toBe("A");
  });

  it("returns null for invalid JSON", () => {
    expect(parseGraphSpec("not json")).toBeNull();
  });

  it("formatGraphFence round-trips essentials", () => {
    const spec = parseGraphSpec(
      JSON.stringify({
        nodes: [{ id: "a", name: "Alpha" }],
        edges: [],
      }),
    );
    expect(spec).not.toBeNull();
    if (!spec) return;
    const fence = formatGraphFence(spec);
    expect(fence).toContain("```graph");
    expect(parseGraphSpec(fence)?.nodes[0]?.id).toBe("a");
  });

  it("normalizeDiagramAiOutput extracts fenced graph", () => {
    const out = normalizeDiagramAiOutput(
      '```graph\n{"nodes":[{"id":"x","name":"X"}],"edges":[]}\n```',
    );
    expect(out).toContain('"nodes"');
    expect(JSON.parse(out).nodes[0].id).toBe("x");
  });

  it("detects legacy mermaid content", () => {
    expect(isLegacyMermaidContent("flowchart TD\n  A --> B")).toBe(true);
    expect(isLegacyMermaidContent('{"nodes":[]}')).toBe(false);
  });
});
