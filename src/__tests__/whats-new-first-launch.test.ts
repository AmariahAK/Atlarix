/**
 * W6 (Windows fresh-install QA, 2026-11-07): a brand-new install's first window
 * showed "What's new" ("Sessions that review each other… In the CLI, ctrl+s…")
 * over the sign-in buttons. Release notes are news only to someone who ran the
 * version before, so the first launch shows none.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/nonexistent-atlarix-test" },
}));

const dir = mkdtempSync(path.join(tmpdir(), "atlarix-whats-new-"));
process.env.ATLARIX_USER_DATA_DIR = dir;

import {
  __resetWhatsNewForTests,
  getWhatsNewEntry,
  refreshWhatsNew,
  suppressWhatsNewThisLaunch,
} from "@/main/whats-new";

const note = {
  entries: [{ id: "15.13.0", title: "Sessions that review each other", body: "In the CLI, ctrl+s…" }],
};

beforeEach(() => {
  __resetWhatsNewForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => note })),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ATLARIX_USER_DATA_DIR;
});

describe("What's new on the first launch", () => {
  it("is shown to someone who ran Atlarix before", async () => {
    await refreshWhatsNew();
    expect(getWhatsNewEntry()?.id).toBe("15.13.0");
  });

  it("is not shown on a fresh install's first launch (W6)", async () => {
    suppressWhatsNewThisLaunch();
    await refreshWhatsNew();
    expect(getWhatsNewEntry()).toBeNull();
  });
});
