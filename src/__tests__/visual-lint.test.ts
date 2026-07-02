import { describe, expect, it } from "vitest";
import {
  runVisualLint,
  formatVisualLintReport,
  runDesignSnapshot,
  formatDesignSnapshot,
  detectBlankRender,
  type VisualLintReport,
  type DesignSnapshot,
} from "@/lib/browser/visual-lint";

/**
 * Fake WebContents that routes executeJavaScript by matching on script content,
 * so we can exercise the merge/rank/format logic without a real browser.
 */
function fakeWc(handlers: {
  axePresent?: boolean;
  lint?: unknown;
  design?: unknown;
  blank?: unknown;
  url?: string;
}): Electron.WebContents {
  return {
    getURL: () => handlers.url ?? "http://localhost:3000/",
    executeJavaScript: async (script: string) => {
      if (script.includes("typeof window.axe")) return handlers.axePresent ?? true;
      if (script.includes("window.__atlarixCLS") && script.includes("defects"))
        return handlers.lint ?? null;
      if (script.includes("colorCount")) return handlers.design ?? null;
      if (script.includes("empty body")) return handlers.blank ?? { blank: false, reason: "" };
      return null;
    },
  } as unknown as Electron.WebContents;
}

describe("runVisualLint — merge, rank, cap", () => {
  it("merges hand-rolled + axe defects and ranks by impact", async () => {
    const wc = fakeWc({
      lint: {
        url: "http://localhost:3000/",
        title: "App",
        cls: 0.05,
        elementCount: 120,
        defects: [
          { rule: "collapsed-layout", impact: "moderate", message: "collapsed" },
          { rule: "blank-render", impact: "critical", message: "blank" },
        ],
        axeViolations: [
          { rule: "color-contrast", impact: "serious", message: "low contrast", count: 3 },
        ],
        truncated: false,
      },
    });
    const report = await runVisualLint(wc);
    expect(report).not.toBeNull();
    // critical first, then serious, then moderate.
    expect(report!.defects.map((d) => d.impact)).toEqual([
      "critical",
      "serious",
      "moderate",
    ]);
    expect(report!.defects[0]!.rule).toBe("blank-render");
    expect(report!.cls).toBe(0.05);
  });

  it("returns null when the page script yields nothing", async () => {
    expect(await runVisualLint(fakeWc({ lint: null }))).toBeNull();
  });
});

describe("formatVisualLintReport", () => {
  const base: VisualLintReport = {
    url: "http://localhost:3000/",
    title: "App",
    cls: 0.2,
    elementCount: 80,
    defects: [],
    truncated: false,
  };

  it("reports a clean page with the good/over-threshold CLS note", () => {
    const clean = formatVisualLintReport({ ...base, cls: 0.02 });
    expect(clean).toContain("no defects found");
    expect(clean).toContain("(good)");
  });

  it("flags CLS over the 0.1 threshold and lists defects", () => {
    const out = formatVisualLintReport({
      ...base,
      defects: [{ rule: "broken-image", impact: "serious", message: "img failed", target: "img.hero" }],
    });
    expect(out).toContain("above the 0.1");
    expect(out).toContain("[serious] broken-image");
    expect(out).toContain("img.hero");
  });
});

describe("design snapshot", () => {
  it("formats palette/fonts/type/spacing/layout as text", async () => {
    const snap: DesignSnapshot = {
      url: "http://localhost:3000/",
      title: "App",
      palette: [{ color: "rgb(0, 0, 0)", count: 40 }],
      fontFamilies: ["Inter"],
      typeScale: ["14px / 400", "24px / 700"],
      spacing: ["8px", "16px"],
      layout: ["header: 1200×64", "main: 1200×800"],
    };
    const wc = fakeWc({ design: snap });
    const got = await runDesignSnapshot(wc);
    expect(got).not.toBeNull();
    const text = formatDesignSnapshot(got!);
    expect(text).toContain("rgb(0, 0, 0) (×40)");
    expect(text).toContain("Inter");
    expect(text).toContain("14px / 400");
    expect(text).toContain("header: 1200×64");
  });
});

describe("detectBlankRender — conservative gate", () => {
  it("returns null for un-navigated pages (never false-blocks)", async () => {
    expect(await detectBlankRender(fakeWc({ url: "about:blank" }))).toBeNull();
    expect(await detectBlankRender(fakeWc({ url: "" }))).toBeNull();
  });

  it("reports a blank page when the body is empty", async () => {
    const wc = fakeWc({ blank: { blank: true, reason: "empty body — no text, elements, or media" } });
    const res = await detectBlankRender(wc);
    expect(res?.blank).toBe(true);
    expect(res?.reason).toContain("empty body");
  });

  it("reports not-blank for a rendered page", async () => {
    const res = await detectBlankRender(fakeWc({ blank: { blank: false, reason: "" } }));
    expect(res?.blank).toBe(false);
  });
});
