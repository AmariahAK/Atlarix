/**
 * 15.11.0 (ai-c8, filming): after a denied edit came back through a writer
 * sub-agent, the "While you were away" recap said "updated ants.js", and no
 * file had changed. The recap is told what the turns really changed on disk
 * (their snapshots), and held to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn(async () => ({ text: "Adding the tunnel filter; nothing changed on disk yet.", usage: {} }));
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...(a as [])) }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({ selectedModel: { provider: "openai", name: "gpt-x" } }) }));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} }, fellBackToCore: false }),
}));
vi.mock("@/lib/usage/turn-usage-aggregator", () => ({ recordAuxUsage: () => {} }));

const turns: Array<{ turnId: string }> = [];
const manifests: Record<string, { filesChanged: string[]; revertedAt?: string; revertedFiles?: string[] }> = {};
vi.mock("@/db", () => {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [...turns].reverse() };
  return { db: { select: () => chain, query: { chatSessions: { findFirst: async () => null }, apps: { findFirst: async () => null } } } };
});
vi.mock("@/lib/snapshot/snapshot-manager", () => ({
  listSnapshotFiles: async (_ws: string, turnId: string) => ({ endRecorded: true, createdFiles: [], ...manifests[turnId] }),
}));

import { generateRecap } from "@/lib/recap/recap";
import { recentChangedFiles } from "@/lib/recap/changed-files";

const call = () => (generateText.mock.calls.at(-1) as unknown as [{ system: string; prompt: string }])[0];

beforeEach(() => {
  generateText.mockClear();
  turns.length = 0;
  for (const k of Object.keys(manifests)) delete manifests[k];
});

describe("the recap and what really changed", () => {
  it("is told no file changed, and held to it, when none did", async () => {
    await generateRecap("assistant: Done. Here's what I changed: updated ants.js", { chatId: 1, force: true, filesChanged: [] });
    expect(call().prompt).toContain("<files_changed_on_disk>\nnone\n</files_changed_on_disk>");
    expect(call().system).toMatch(/changed only if it is in <files_changed_on_disk>/);
  });

  it("is given the files that did change", async () => {
    await generateRecap("assistant: updated server.js", { chatId: 1, force: true, filesChanged: ["src/server.js"] });
    expect(call().prompt).toContain("<files_changed_on_disk>\nsrc/server.js\n</files_changed_on_disk>");
  });

  it("says nothing about files when that can't be known", async () => {
    await generateRecap("assistant: hi", { chatId: 1, force: true, filesChanged: null });
    expect(call().prompt).not.toContain("files_changed_on_disk");
  });
});

describe("recentChangedFiles", () => {
  it("lists what the turns' snapshots changed, minus what a later revert put back", async () => {
    turns.push({ turnId: "t1" }, { turnId: "t2" }, { turnId: "t3" });
    manifests.t1 = { filesChanged: ["src/server.js", "src/ants.js"] };
    manifests.t2 = { filesChanged: ["src/ants.js"], revertedAt: "2026-10-24T07:00:00Z", revertedFiles: ["src/ants.js"] };
    manifests.t3 = { filesChanged: ["test\\ants.test.js"] };
    expect(await recentChangedFiles({ sessionId: "s", workspacePath: "/w" })).toEqual(["src/server.js", "test/ants.test.js"]);
  });

  it("an empty list when no turn changed anything", async () => {
    expect(await recentChangedFiles({ sessionId: "s", workspacePath: "/w" })).toEqual([]);
  });
});
