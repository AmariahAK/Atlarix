import {
  containsTextToolCall,
  parseTextToolCalls,
  stripToolCallXML,
} from "@/ipc/utils/text_tool_parser";
import { describe, it, expect } from "vitest";

const exploreFolderBlock = `<tool_call>
<function=explore_folder>
<parameter=include_stats>True</parameter>
<parameter=max_entries>100</parameter>
<parameter=path>mobile/components</parameter>
<parameter=sort>name</parameter>
</function>
</tool_call>`;

describe("text_tool_parser legacy <function=...> format", () => {
  it("detects angle-bracket tool_call blocks", () => {
    expect(containsTextToolCall(exploreFolderBlock)).toBe(true);
    expect(containsTextToolCall(`prefix\n<function=read_file>\n`)).toBe(true);
  });

  it("parses explore_folder with coerced booleans and numbers", () => {
    const calls = parseTextToolCalls(exploreFolderBlock);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("explore_folder");
    expect(calls[0].args.include_stats).toBe(true);
    expect(calls[0].args.max_entries).toBe(100);
    expect(calls[0].args.path).toBe("mobile/components");
    expect(calls[0].args.sort).toBe("name");
  });

  it("stripToolCallXML removes legacy blocks and leaves surrounding text", () => {
    const mixed = `Hello\n${exploreFolderBlock}\nAfter`;
    const out = stripToolCallXML(mixed).trim();
    expect(out).not.toContain("tool_call");
    expect(out.replace(/\n+/g, "\n")).toBe("Hello\nAfter");
  });

  it("stripToolCallXML removes multiple legacy blocks", () => {
    const two = `${exploreFolderBlock}\nmore\n${exploreFolderBlock.replace("mobile/components", "mobile/screens")}`;
    const out = stripToolCallXML(two);
    expect(out).not.toContain("tool_call");
    expect(out).not.toContain("explore_folder");
    expect(out.trim()).toBe("more");
  });
});

describe("sanitizeMermaid", () => {
  it("normalizes capital Style to style", async () => {
    const { sanitizeMermaid } = await import("@/lib/sanitizeMermaid");
    const input = `graph LR\n    subgraph X [A]\n        Style N fill:red\n    end`;
    expect(sanitizeMermaid(input)).toBe(
      `graph LR\n    subgraph X [A]\n        style N fill:red\n    end`,
    );
  });
});
