import { describe, expect, it } from "vitest";
import {
  extractSourcesFromMessageParts,
  preprocessCitationMarkers,
} from "@/lib/chat/citation-sources";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";

describe("preprocessCitationMarkers", () => {
  it("converts [^n] to atlarix-citation tags", () => {
    expect(preprocessCitationMarkers("Hello world.[^2]")).toContain(
      '<atlarix-citation index="2">',
    );
  });
});

describe("extractSourcesFromMessageParts", () => {
  it("reads sources from web_search tool result JSON", () => {
    const parts: AssistantMessagePart[] = [
      {
        type: "tool",
        id: "web_search_0",
        toolName: "web_search",
        status: "success",
        resultText: JSON.stringify({
          success: true,
          text: "answer",
          sources: [
            {
              title: "Example",
              url: "https://example.com/page",
              snippet: "snippet",
            },
          ],
        }),
      },
    ];
    const sources = extractSourcesFromMessageParts(parts);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("https://example.com/page");
  });
});
