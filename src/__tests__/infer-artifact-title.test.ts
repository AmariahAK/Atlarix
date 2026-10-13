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

// QA (app) #23: "Add `--top N` CLI" kept its backticks as a title.
import { describe as describe23, it as it23, expect as expect23 } from "vitest";
import { inferArtifactTitle as infer23 } from "@/lib/visual-artifacts/infer-title";
import { planDisplayTitle } from "@/components/chat/PlanArtifactCard";
describe23("titles are text, not markdown (QA #23)", () => {
  it23("a mind map's heading loses its code and bold marks", () => {
    expect23(infer23("markmap", "# Add `--top N` **CLI**\n## Steps")).toBe("Add --top N CLI");
  });
  it23("a plan's title too, stored or from its first line", () => {
    expect23(planDisplayTitle("Add `--top N` CLI to tally", "")).toBe("Add --top N CLI to tally");
    expect23(planDisplayTitle(null, "# Fix `src/tally.js`\n\n1. [ ] x")).toBe("Fix src/tally.js");
  });
});
