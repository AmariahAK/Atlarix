import { describe, expect, it } from "vitest";
import {
  mergeBrokenSequenceMessageLines,
  repairSequenceDiagramMessages,
  sanitizeMermaid,
} from "@/lib/sanitizeMermaid";

describe("sequence diagram mermaid repair", () => {
  it("quotes messages containing braces", () => {
    const input = [
      "sequenceDiagram",
      "API->>GoogleChat: 200{} (ack, continue as normal)",
    ].join("\n");
    const out = repairSequenceDiagramMessages(input);
    expect(out).toContain('"200');
    expect(out).not.toContain("200{}");
  });

  it("merges continuation lines into arrow messages", () => {
    const input = [
      "sequenceDiagram",
      "API->>GoogleChat: 200 (ack, continue as",
      "normal)",
    ].join("\n");
    const merged = mergeBrokenSequenceMessageLines(input);
    expect(merged.split("\n")).toHaveLength(2);
    expect(merged).toContain("continue as normal)");
  });

  it("sanitizeMermaid applies sequence repairs", () => {
    const input = [
      "sequenceDiagram",
      "A->>B: status 200{} ok",
    ].join("\n");
    const out = sanitizeMermaid(input);
    expect(out).not.toMatch(/200\{\}/);
  });
});
