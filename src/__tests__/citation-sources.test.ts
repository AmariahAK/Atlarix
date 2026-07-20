import { describe, expect, it } from "vitest";
import {
  extractInlineSourcesFromContent,
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

describe("extractInlineSourcesFromContent (provider-native + Atlarix Core)", () => {
  it("parses the <atlarix-sources>[{url,title}] tag the Core web search emits", () => {
    // Exact shape persisted by a real Atlarix Core (OpenRouter server-tool) search.
    const content =
      "Here's the news…\n<atlarix-sources>" +
      JSON.stringify([
        { url: "https://www.channelnewsasia.com/a", title: "Singapore GenAI labels - CNA" },
        { url: "https://timesofindia.indiatimes.com/b", title: "OpenAI CFO - Times of India" },
      ]) +
      "</atlarix-sources>";
    const sources = extractInlineSourcesFromContent(content);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.url)).toEqual([
      "https://www.channelnewsasia.com/a",
      "https://timesofindia.indiatimes.com/b",
    ]);
    expect(sources[0]!.title).toBe("Singapore GenAI labels - CNA");
  });

  it("returns nothing when there is no tag (and dedupes by url)", () => {
    expect(extractInlineSourcesFromContent("no sources here")).toHaveLength(0);
    const dup =
      "<atlarix-sources>" +
      JSON.stringify([
        { url: "https://x.com/1", title: "A" },
        { url: "https://x.com/1", title: "A dup" },
      ]) +
      "</atlarix-sources>";
    expect(extractInlineSourcesFromContent(dup)).toHaveLength(1);
  });
});
