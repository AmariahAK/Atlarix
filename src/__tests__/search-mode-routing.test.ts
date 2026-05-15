import { describe, expect, it } from "vitest";
import {
  detectAutoSearchMode,
  normalizeRequestedSearchMode,
  resolveSearchMode,
  searchEngineLabel,
} from "../lib/search/search-mode-routing";

describe("search-mode-routing", () => {
  describe("normalizeRequestedSearchMode", () => {
    it("maps legacy semantic to semantic-graph", () => {
      expect(normalizeRequestedSearchMode("semantic")).toBe("semantic-graph");
    });
    it("falls unknown modes back to auto", () => {
      expect(normalizeRequestedSearchMode("bogus" as any)).toBe("auto");
    });
  });

  describe("detectAutoSearchMode", () => {
    it("uses structural only for phrase markers", () => {
      expect(detectAutoSearchMode("what calls handleLogin")).toBe("structural");
      expect(detectAutoSearchMode("what imports react")).toBe("structural");
      expect(detectAutoSearchMode("callers of foo")).toBe("structural");
      expect(detectAutoSearchMode("dependencies of auth")).toBe("structural");
    });
    it("does not treat bare imports as structural", () => {
      expect(detectAutoSearchMode("find imports in src")).toBe("text");
    });
    it("does not treat related as semantic-lite", () => {
      expect(detectAutoSearchMode("related modules")).toBe("text");
    });
    it("uses semantic-lite for concept-style queries", () => {
      expect(detectAutoSearchMode("error handling patterns")).toBe("semantic-lite");
      expect(detectAutoSearchMode("how does authentication work")).toBe("semantic-lite");
    });
    it("defaults to text", () => {
      expect(detectAutoSearchMode("TODO")).toBe("text");
      expect(detectAutoSearchMode("handleSubmit")).toBe("text");
    });
  });

  describe("resolveSearchMode", () => {
    it("auto never returns semantic-graph", () => {
      for (const q of [
        "what calls x",
        "pattern in code",
        "grep me",
        "related things",
      ]) {
        const r = resolveSearchMode("auto", q);
        expect(r).not.toBe("semantic-graph");
      }
    });
    it("explicit semantic-graph is preserved", () => {
      expect(resolveSearchMode("semantic-graph", "anything")).toBe("semantic-graph");
    });
    it("explicit structural is preserved", () => {
      expect(resolveSearchMode("structural", "x")).toBe("structural");
    });
  });

  describe("searchEngineLabel", () => {
    it("labels engines", () => {
      expect(searchEngineLabel("text")).toBe("ripgrep");
      expect(searchEngineLabel("semantic-lite")).toBe("file_scan");
      expect(searchEngineLabel("semantic-graph")).toBe("bm25_blueprint");
      expect(searchEngineLabel("structural")).toBe("blueprint_graph");
    });
  });
});
