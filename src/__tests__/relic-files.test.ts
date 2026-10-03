/**
 * What a relic may contain (supabase/functions/_shared/relic-files.ts): checked
 * by the edge function before anything is stored, and by the app before it
 * writes a local relic.
 */
import { describe, expect, it } from "vitest";
import { RELIC_LIMITS, cleanRelicPath, newRelicId, prepareRelicFiles } from "../../supabase/functions/_shared/relic-files";

describe("relic files", () => {
  it("accepts a page with assets, typed by extension", () => {
    const out = prepareRelicFiles([
      { path: "index.html", content: "<h1>Hi</h1>" },
      { path: "css/site.css", content: "h1{}" },
      { path: "img/dot.png", content: btoa("\x89PNG"), encoding: "base64" },
    ]);
    if ("error" in out) throw new Error(out.error);
    expect(out.files.map((f) => [f.path, f.contentType])).toEqual([
      ["index.html", "text/html; charset=utf-8"],
      ["css/site.css", "text/css; charset=utf-8"],
      ["img/dot.png", "image/png"],
    ]);
    expect(out.bytes).toBe(11 + 4 + 4);
  });

  it("refuses paths that escape, odd names, and unknown types", () => {
    for (const p of ["../x.html", "/etc/passwd", "a/../b.html", "a b.html", "a//b.html", ""]) expect(cleanRelicPath(p)).toBeNull();
    expect(cleanRelicPath("./site/index.html")).toBe("site/index.html");
    expect(prepareRelicFiles([{ path: "index.html", content: "x" }, { path: "run.exe", content: "x" }])).toMatchObject({ error: expect.stringContaining("run.exe") });
  });

  it("needs an index.html, and stays within the caps", () => {
    expect(prepareRelicFiles([{ path: "a.html", content: "x" }])).toMatchObject({ error: expect.stringContaining("index.html") });
    expect(prepareRelicFiles([])).toMatchObject({ error: expect.any(String) });
    const many = Array.from({ length: RELIC_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `p${i}.html`, content: "x" }));
    expect(prepareRelicFiles(many)).toMatchObject({ error: expect.stringContaining(String(RELIC_LIMITS.maxFiles)) });
    const big = [{ path: "index.html", content: "x".repeat(RELIC_LIMITS.maxBytes + 1) }];
    expect(prepareRelicFiles(big)).toMatchObject({ error: expect.stringContaining("MB") });
  });

  it("makes short unguessable ids", () => {
    const a = newRelicId();
    expect(a).toMatch(/^rl_[a-z0-9]{20}$/);
    expect(newRelicId()).not.toBe(a);
  });
});
