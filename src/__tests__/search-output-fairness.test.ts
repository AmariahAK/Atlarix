/**
 * A deep search must keep SOMETHING from every page it read.
 *
 * This is the measurement that exposed the bug, turned into a guard. Before the
 * fix, a 100,937-char assembled result reached the model as 6,129 chars — 6.1%
 * retained — and of five pages only PAGE_1 survived, because the registry's
 * head+tail envelope kept the first 1,500 tokens and the last 500 of the whole
 * document. Four sources were fetched, paid for in latency and bandwidth, and
 * discarded unread, under a header claiming "analyzed 5 pages in depth".
 *
 * Head+tail is right for one command's stdout — you want the start and the error
 * at the end. It is wrong for N independent documents, and only the tool knows
 * which of those it is producing. Hence `web_search` in `SELF_PAGINATED_TOOLS`
 * and this budget living in `web.ts`.
 */
import { describe, expect, it } from "vitest";
import { renderFetchedPages } from "@/lib/tools/web";
import { maybeTruncateToolOutput } from "@/lib/tools/registry";

const page = (n: number, chars: number) => ({
  title: `Title ${n}`,
  url: `https://example.com/page-${n}`,
  content: `UNIQUE_MARKER_PAGE_${n} ` + "x".repeat(chars),
});

describe("deep search keeps something from every page", () => {
  it("includes ALL five markers — the exact assertion that used to fail", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => page(n, 20_000));
    const { text } = renderFetchedPages(pages);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(text, `page ${n} was dropped`).toContain(
        `UNIQUE_MARKER_PAGE_${n}`,
      );
    }
  });

  it("stays inside the budget it is now solely responsible for", () => {
    // web_search is exempt from the registry envelope, so this number is the only
    // thing between a 100 KB fetch and the model's context.
    const pages = [1, 2, 3, 4, 5].map((n) => page(n, 20_000));
    const { text } = renderFetchedPages(pages);
    expect(text.length).toBeLessThanOrEqual(24_000);
  });

  it("gives a single result more room than one of five", () => {
    const one = renderFetchedPages([page(1, 50_000)]).text.length;
    const each =
      renderFetchedPages([1, 2, 3, 4, 5].map((n) => page(n, 50_000))).text
        .length / 5;
    expect(one).toBeGreaterThan(each);
  });

  it("marks a complete page '(complete)' and gives it NO footer", () => {
    // Absence of the footer is the terminal signal, copied from read_file.
    const { text, fullyIncluded } = renderFetchedPages([page(1, 100)]);
    expect(text).toContain("(complete)");
    expect(text).not.toContain("call read_url");
    expect(fullyIncluded).toBe(1);
  });

  it("names the EXACT next call on a truncated page, not a vague hint", () => {
    const { text, fullyIncluded } = renderFetchedPages([page(1, 60_000)]);
    expect(text).toContain(
      'call read_url with url="https://example.com/page-1"',
    );
    expect(text).toContain("more chars");
    expect(fullyIncluded).toBe(0);
  });

  it("states position in the whole on every page, complete or not", () => {
    const { text } = renderFetchedPages([page(1, 60_000), page(2, 50)]);
    expect(text).toMatch(/chars 1-\d+ of \d+/);
    expect(text).toContain("(complete)");
  });

  it("handles zero pages without emitting a section", () => {
    expect(renderFetchedPages([])).toEqual({ text: "", fullyIncluded: 0 });
  });

  it("never starves a page to nothing, even with many results", () => {
    // The floor matters: 24_000/20 minus chrome would go negative without it.
    const pages = Array.from({ length: 20 }, (_, i) => page(i + 1, 5_000));
    const { text } = renderFetchedPages(pages);
    for (let n = 1; n <= 20; n++) {
      expect(text).toContain(`UNIQUE_MARKER_PAGE_${n}`);
    }
  });

  it("is exempt from the registry envelope, so nothing re-cuts it", async () => {
    const pages = [1, 2, 3, 4, 5].map((n) => page(n, 20_000));
    const { text } = renderFetchedPages(pages);
    const out = await maybeTruncateToolOutput("web_search", {
      text,
      sources: [],
    });
    expect(out.truncated).toBe(false);
    const v = out.value as { text: string };
    for (const n of [1, 2, 3, 4, 5]) {
      expect(v.text).toContain(`UNIQUE_MARKER_PAGE_${n}`);
    }
  });
});
