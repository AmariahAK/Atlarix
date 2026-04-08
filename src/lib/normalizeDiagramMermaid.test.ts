import { describe, it, expect } from "vitest";
import {
  prepareMermaidForParse,
  normalizeDiagramAiOutput,
  stripStandaloneMermaidLanguageLine,
} from "./normalizeDiagramMermaid";

describe("normalizeDiagramMermaid", () => {
  it("strips standalone mermaid language line", () => {
    const raw = "mermaid\ngraph TB\n  A --> B";
    expect(prepareMermaidForParse(raw)).toBe("graph TB\n  A --> B");
  });

  it("strips mermaid prefix before graph on same line", () => {
    expect(prepareMermaidForParse("mermaid graph TB\n  A --> B")).toBe("graph TB\n  A --> B");
  });

  it("normalizeDiagramAiOutput extracts fenced block", () => {
    const ai = 'Here:\n```mermaid\ngraph LR\n  x --> y\n```';
    expect(normalizeDiagramAiOutput(ai)).toBe("graph LR\n  x --> y");
  });

  it("scrubs non-hex junk in linkStyle colors", () => {
    const line = "linkStyle default stroke-width:2px,fill:none,stroke:#333ab;";
    const out = prepareMermaidForParse(`graph TB\n  A --> B\n${line}`);
    expect(out).toContain("stroke:#333ab");
    expect(out).not.toMatch(/333[^\n;0-9a-fA-F]/);
  });

  it("sanitizes invalid style identifiers containing & and spaces", () => {
    const raw = "graph TB\n  A[Ok]\n  A --> B\n  style Auth & Services fill:#fff,stroke:#333";
    const out = prepareMermaidForParse(raw);
    expect(out).toContain("style Auth_Services fill:#fff,stroke:#333");
    expect(out).not.toContain("style Auth & Services");
  });

  it("stripStandaloneMermaidLanguageLine handles CRLF", () => {
    expect(stripStandaloneMermaidLanguageLine("mermaid\r\ngraph TB")).toBe("graph TB");
  });
});
