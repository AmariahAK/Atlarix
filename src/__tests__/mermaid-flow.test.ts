import { describe, expect, it } from "vitest";
import { mermaidFlowchart } from "@/lib/chat/mermaid-flow";

describe("a mermaid flowchart as nodes and edges", () => {
  it("reads shapes, labels, chains and & groups", () => {
    const g = mermaidFlowchart(
      [
        "flowchart TD",
        "  A[Web app] --> B(API)",
        '  B -->|reads| C[("Postgres")]',
        "  B -- caches in --> D{Redis}",
        "  B --> E & F",
        "  E --> G --> H",
        "  classDef hot fill:#f00",
        "  %% a comment",
      ].join("\n"),
    )!;
    expect(g.nodes.map((n) => n.name)).toEqual(["Web app", "API", "Postgres", "Redis", "E", "F", "G", "H"]);
    expect(g.edges).toContainEqual({ source: "B", target: "C", label: "reads" });
    expect(g.edges).toContainEqual({ source: "B", target: "D", label: "caches in" });
    expect(g.edges).toContainEqual({ source: "B", target: "F" });
    expect(g.edges).toContainEqual({ source: "G", target: "H" });
  });

  it("leaves other mermaid diagrams alone", () => {
    expect(mermaidFlowchart("sequenceDiagram\n  A->>B: hi")).toBeNull();
    expect(mermaidFlowchart("")).toBeNull();
  });
});
