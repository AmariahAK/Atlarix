import { describe, expect, it } from "vitest";
import { inferArtifactTitle } from "@/lib/visual-artifacts/infer-title";

describe("inferArtifactTitle", () => {
  it("reads chart title from JSON", () => {
    const code = JSON.stringify({
      type: "bar",
      title: "Dominant themes",
      labels: ["A"],
      values: [1],
    });
    expect(inferArtifactTitle("chart", code)).toBe("Dominant themes");
  });

  it("reads markmap root heading", () => {
    expect(inferArtifactTitle("markmap", "# My App\n## API\n- routes")).toBe(
      "My App",
    );
  });

  it("reads graph title from JSON", () => {
    const code = JSON.stringify({
      title: "Project architecture",
      nodes: [{ id: "a", name: "API" }],
      edges: [],
    });
    expect(inferArtifactTitle("graph", code)).toBe("Project architecture");
  });

  it("falls back to first node name for graph", () => {
    const code = JSON.stringify({
      nodes: [{ id: "a", name: "Workspace" }],
      edges: [],
    });
    expect(inferArtifactTitle("graph", code)).toBe("Workspace");
  });

  it("falls back for markmap without heading", () => {
    expect(inferArtifactTitle("markmap", "- item")).toBe("Mind map");
  });
});
