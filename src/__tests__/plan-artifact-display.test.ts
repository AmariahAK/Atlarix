import { describe, expect, it } from "vitest";
import {
  contentHasPlanArtifactMarker,
  extractPlanFromContent,
  splitContentByPlanMarkers,
  stripAssistantPlanForDisplay,
  stripPlanArtifactEchoFromDisplay,
} from "@/lib/plan-cards/plan-card-renderer";

describe("plan artifact display", () => {
  const marker =
    "<!-- atlarix-plan-artifact:787bb61d-51c9-4476-9370-ee0d7a6a7832 -->";
  const body =
    "Plan created with 26 improvements across 8 categories. Here's the executive summary:";

  it("detects plan artifact markers", () => {
    expect(contentHasPlanArtifactMarker(`${marker}\n${body}`)).toBe(true);
  });

  it("does not duplicate PlanSection for artifact-only messages", () => {
    expect(extractPlanFromContent(`${marker}\n${body}`)).toBeNull();
  });

  it("strips artifact markers from displayed markdown", () => {
    const stripped = stripAssistantPlanForDisplay(`${marker}\n${body}`);
    expect(stripped).not.toContain("atlarix-plan-artifact");
    expect(stripped).toContain("executive summary");
  });

  it("splits content by plan markers in order", () => {
    const id = "787bb61d-51c9-4476-9370-ee0d7a6a7832";
    const segments = splitContentByPlanMarkers(
      `Intro.\n<!-- atlarix-plan-artifact:${id} -->\nTail.`,
    );
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "markdown", content: "Intro.\n" });
    expect(segments[1]).toEqual({ type: "plan-artifact", planId: id });
    expect(segments[2]).toEqual({ type: "markdown", content: "\nTail." });
  });

  it("drops duplicated long plan tables after artifact marker", () => {
    const longPlan = `${marker}\n${body}\n\n## 1. Foo\n\n| # | Item |\n|---|------|\n| 1.1 | x |\n`.repeat(
      20,
    );
    const stripped = stripPlanArtifactEchoFromDisplay(longPlan);
    expect(stripped).not.toContain("| 1.1 |");
    expect(stripped).toContain("executive summary");
  });
});
