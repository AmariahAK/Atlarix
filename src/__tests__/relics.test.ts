/**
 * Relics in the app (src/lib/relics, src/lib/tools/relic.ts): who gets a hosted
 * link (paid Core) and who gets a local file (own keys, free Auto); the local
 * file the tool writes; how the chat reads the result; and that the inline
 * preview only ever reads a relic, never an arbitrary file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/relics/hosting-tier", async (orig) => ({
  ...(await orig<typeof import("@/lib/relics/hosting-tier")>()),
  relicHostingForChat: vi.fn(async () => ({ hosted: false, reason: "this turn runs on Atlarix Auto" })),
}));

import { decideRelicHosting } from "@/lib/relics/hosting-tier";
import { relicSlug, runRelic } from "@/lib/tools/relic";
import { parseRelicResult } from "@/lib/relics/relic-result";
import { isLocalRelicPath } from "@/ipc/handlers/relic_handlers";
import { planPageHtml } from "@/lib/relics/plan-page";

const core = { provider: "compass", name: "core-pro" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("where a relic goes", () => {
  it("hosted only on paid Atlarix Core", () => {
    expect(decideRelicHosting({ model: core, signedIn: true, isPro: true, balanceCents: null })).toEqual({ hosted: true });
    expect(decideRelicHosting({ model: core, signedIn: true, isPro: false, balanceCents: 250 })).toEqual({ hosted: true });
    expect(decideRelicHosting({ model: core, signedIn: true, isPro: false, balanceCents: 0 }).hosted).toBe(false);
    expect(decideRelicHosting({ model: core, signedIn: false, isPro: true, balanceCents: 999 }).hosted).toBe(false);
  });

  it("a local file on your own key or on Atlarix Auto, even when paid", () => {
    expect(decideRelicHosting({ model: { provider: "anthropic", name: "x" }, signedIn: true, isPro: true, balanceCents: 999 })).toMatchObject({
      hosted: false,
      reason: expect.stringContaining("own API key"),
    });
    expect(decideRelicHosting({ model: { provider: "compass", name: "core-auto" }, signedIn: true, isPro: true, balanceCents: 999 })).toMatchObject({
      hosted: false,
      reason: expect.stringContaining("Auto"),
    });
  });
});

describe("the relic tool, locally", () => {
  it("writes the page into .atlarix/relics/<slug>/ and updates it in place", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "relic-ws-"));
    dirs.push(ws);
    const made = await runRelic({ title: "Billing Page — Design!", html: "<h1>v1</h1>", workspace: ws });
    expect(made).toMatchObject({ success: true, hosted: false, id: "local:billing-page-design" });
    expect(fs.readFileSync(made.path!, "utf8")).toBe("<h1>v1</h1>");
    expect(made.note).toContain("Atlarix Auto");

    const updated = await runRelic({
      id: made.id,
      files: [
        { path: "index.html", content: "<h1>v2</h1>" },
        { path: "css/a.css", content: "h1{}" },
      ],
      workspace: ws,
    });
    expect(updated.path).toBe(made.path);
    expect(fs.readFileSync(made.path!, "utf8")).toBe("<h1>v2</h1>");
    expect(fs.existsSync(path.join(path.dirname(made.path!), "css", "a.css"))).toBe(true);
  });

  it("refuses what the server would: no index.html, escaping paths", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "relic-ws-"));
    dirs.push(ws);
    expect(await runRelic({ title: "x", files: [{ path: "a.html", content: "" }], workspace: ws })).toMatchObject({ success: false });
    expect(await runRelic({ title: "x", files: [{ path: "../index.html", content: "" }], workspace: ws })).toMatchObject({ success: false });
    expect(relicSlug("   ")).toBe("relic");
  });
});

describe("the chat's view of a relic", () => {
  it("reads the result bare or in the registry envelope", () => {
    const r = { success: true, hosted: true, id: "rl_1", title: "Design", kind: "design", url: "https://atlarix.dev/r/rl_1", version: 2 };
    expect(parseRelicResult(JSON.stringify(r))).toMatchObject({ id: "rl_1", hosted: true, kind: "design", url: r.url });
    expect(parseRelicResult(JSON.stringify({ success: true, result: r }))).toMatchObject({ id: "rl_1" });
    expect(parseRelicResult(JSON.stringify({ success: false, error: "no" }))).toBeNull();
    expect(parseRelicResult("not json")).toBeNull();
  });

  it("previews only an index.html inside a workspace's .atlarix/relics", () => {
    const ws = "/Users/me/proj";
    expect(isLocalRelicPath("/Users/me/proj/.atlarix/relics/x/index.html", [ws])).toBe(true);
    expect(isLocalRelicPath("/Users/me/proj/.atlarix/relics/x/secret.txt", [ws])).toBe(false);
    expect(isLocalRelicPath("/Users/me/proj/.atlarix/relics/../../.env/index.html", [ws])).toBe(false);
    expect(isLocalRelicPath("/etc/index.html", [ws])).toBe(false);
  });
});

describe("a plan as a page", () => {
  it("keeps the plan readable without the CDN, and can't be broken out of", () => {
    const html = planPageHtml("Ship <it>", "# Ship\n- [ ] a </script><script>alert(1)</script>");
    expect(html).toContain("<title>Ship &lt;it&gt;</title>");
    expect(html).toContain('<pre id="raw"># Ship');
    expect(html).not.toContain("</script><script>alert(1)");
  });
});
