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
    expect(inferArtifactTitle("markmap", "# My App\n## API\n- routes")).toBe("My App");
  });

  it("reads mermaid gantt title", () => {
    const code = `gantt
  title Project timeline
  dateFormat YYYY-MM-DD
  section Phase 1
  Design :a1, 2026-01-01, 7d`;
    expect(inferArtifactTitle("mermaid", code)).toBe("Project timeline");
  });

  it("falls back for mermaid flowchart", () => {
    expect(inferArtifactTitle("mermaid", "flowchart TD\n  A --> B")).toBe("Diagram");
  });

  it("falls back for markmap without heading", () => {
    expect(inferArtifactTitle("markmap", "- item")).toBe("Mind map");
  });
});
