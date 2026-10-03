/**
 * The relic store behind the app's Relics tab and the CLI's /relics.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let session: object | null = null;
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => session,
  getSupabaseClient: () => ({ functions: { invoke } }),
}));

import { isLocalRelicPath, listRelics, removeRelic } from "@/lib/relics/relic-store";

const dirs: string[] = [];
function workspace(relics: Record<string, string>): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "relic-store-"));
  dirs.push(ws);
  for (const [slug, html] of Object.entries(relics)) {
    fs.mkdirSync(path.join(ws, ".atlarix", "relics", slug), { recursive: true });
    fs.writeFileSync(path.join(ws, ".atlarix", "relics", slug, "index.html"), html);
  }
  return ws;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  invoke.mockReset();
  session = null;
});

describe("listRelics", () => {
  it("lists local relics by their <title>, and hosted ones when signed in, newest first", async () => {
    const ws = workspace({ report: "<title>Perf report</title>", plain: "<p>no title</p>" });
    session = { access_token: "t" };
    invoke.mockResolvedValue({
      data: { relics: [{ id: "rl_1", title: "Billing design", kind: "design", url: "https://atlarix.dev/r/rl_1", visibility: "link", updated_at: new Date(Date.now() + 60_000).toISOString() }] },
      error: null,
    });
    const out = await listRelics(ws);
    expect(out[0]).toMatchObject({ id: "rl_1", hosted: true, visibility: "link", kind: "design" });
    expect(out.map((r) => r.title).sort()).toEqual(["Billing design", "Perf report", "plain"]);
  });

  it("signed out or offline, local relics still list", async () => {
    const ws = workspace({ a: "<title>A</title>" });
    expect((await listRelics(ws)).map((r) => r.title)).toEqual(["A"]);
    session = { access_token: "t" };
    invoke.mockRejectedValue(new Error("offline"));
    expect((await listRelics(ws)).map((r) => r.title)).toEqual(["A"]);
  });
});

describe("removeRelic", () => {
  it("deletes a local relic's folder, and nothing outside a workspace's relics folder", async () => {
    const ws = workspace({ a: "<title>A</title>" });
    const index = path.join(ws, ".atlarix", "relics", "a", "index.html");
    await expect(removeRelic({ id: "x", hosted: false, path: path.join(ws, "index.html") }, [ws])).rejects.toThrow();
    await expect(removeRelic({ id: "x", hosted: false, path: index }, ["/somewhere/else"])).rejects.toThrow();
    expect(fs.existsSync(index)).toBe(true);
    await removeRelic({ id: "local:a", hosted: false, path: index }, [ws]);
    expect(fs.existsSync(path.dirname(index))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".atlarix", "relics"))).toBe(true);
  });

  it("the guard: only <workspace>/.atlarix/relics/<slug>/index.html", () => {
    const ws = "/Users/me/proj";
    expect(isLocalRelicPath(`${ws}/.atlarix/relics/x/index.html`, [ws])).toBe(true);
    expect(isLocalRelicPath(`${ws}/.atlarix/relics/index.html`, [ws])).toBe(false);
    expect(isLocalRelicPath(`${ws}/.atlarix/relics/x/y/index.html`, [ws])).toBe(false);
    expect(isLocalRelicPath(`${ws}/.atlarix/relics/../../.env/index.html`, [ws])).toBe(false);
  });
});
