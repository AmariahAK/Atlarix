import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { appendIndexLine, memoryDirFor, memoryIndexPathFor } from "@/lib/agent-memory";

/**
 * Project memory as the provider receives it, through the real `chat:stream`.
 *
 * The cache claim is the point. Memory used to ride a per-turn context section in
 * the SYSTEM block, so writing a note changed the cached prefix and re-priced every
 * request after it. Now the index rides the first user row, saved with it and
 * replayed byte for byte — so the system block must be identical across a note
 * being added, and the first message must still carry the index on later turns.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/x.ts": "export const x = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type WireMessage = { role?: string; content?: unknown };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

function firstRequest(id: string): { system: string; users: string[] } {
  const reqs = ctx.server.requestsFor(id) as Array<{ system?: unknown; messages?: WireMessage[] }>;
  expect(reqs.length, `no request recorded for ${id}`).toBeGreaterThan(0);
  const msgs = reqs[0]!.messages ?? [];
  // The FIRST system message is the cached header (the per-turn tail follows it).
  const system = text(reqs[0]!.system) || text(msgs.find((m) => m.role === "system")?.content);
  return { system, users: msgs.filter((m) => m.role === "user").map((m) => text(m.content)) };
}

function writeNote(name: string, body: string) {
  const dir = memoryDirFor(ctx.ws.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    `---\nname: ${name.replace(/\.md$/, "")}\ndescription: ${body}\nmetadata:\n  type: project\n---\n\n${body}\n`,
  );
}

describe("project memory on the wire", () => {
  it("index once, saved and replayed; system block unchanged by a new note", async () => {
    writeNote("deploy-order.md", "deploy the proxy first");
    await appendIndexLine(ctx.ws.dir, "- [Deploy order](deploy-order.md) — proxy first");
    const index = memoryIndexPathFor(ctx.ws.dir);

    ctx.server.register(scenario("mw-1").text("Done.").repeatLast().build());
    ctx.server.register(scenario("mw-2").text("Done.").repeatLast().build());
    const chatId = await ctx.newChat();

    await runTurn(ctx, { chatId, prompt: "sc=mw-1 hello", mode: "build", timeoutMs: 30_000 });
    const t1 = firstRequest("mw-1");
    // The harness may add its own reminder rows after it; find the user's message.
    const u1 = t1.users.find((u) => u.includes("sc=mw-1 hello"))!;
    expect(u1).toContain(`Contents of ${index}`);
    expect(u1).toContain("- [Deploy order](deploy-order.md) — proxy first");
    // The index reminder folds in FRONT of the user's words, so the saved row
    // keeps them after it. The per-turn dynamic tail (current date + ask_user
    // guidance) legitimately follows the user text on the wire — the stream
    // appends it to the newest user message for cache stability — so the user
    // text is no longer the final bytes. What must hold is the ORDER: the
    // index comes before the user's own words, never after them.
    expect(u1.indexOf(`Contents of ${index}`)).toBeLessThan(
      u1.indexOf("sc=mw-1 hello"),
    );
    expect(t1.system).toContain("# Project memory");
    expect(t1.system).not.toContain("- [Deploy order](deploy-order.md)");

    // A note written between turns, outside this session's own edit_file.
    writeNote("release-gate.md", "owner green-lights each release");
    await appendIndexLine(ctx.ws.dir, "- [Release gate](release-gate.md) — owner decides");

    await runTurn(ctx, { chatId, prompt: "sc=mw-2 next", mode: "build", timeoutMs: 30_000 });
    const t2 = firstRequest("mw-2");

    // The cached header did not move.
    expect(t2.system).toBe(t1.system);
    // Turn 1's row is replayed with its index, byte for byte. The per-turn
    // dynamic tail (current date + ask_user guidance) is appended at stream
    // time to the NEWEST message, so in turn 2 it rides turn 2's row — the
    // replayed row is the persisted prefix, u1 up to where the tail began.
    const r1 = t2.users.find((u) => u.includes("sc=mw-1 hello"))!;
    expect(r1).toBe(u1.slice(0, u1.indexOf("# Current date")).trimEnd());
    // Turn 2 carries only what changed, not the index again.
    const u2 = t2.users.find((u) => u.includes("sc=mw-2 next"))!;
    expect(u2).toContain("MEMORY.md changed on disk since you last read it");
    expect(u2).toContain("+ - [Release gate](release-gate.md) — owner decides");
    expect(u2).not.toContain("Contents of");
  });

  it("reaches the read-only modes too (they rebuild their own header)", async () => {
    ctx.server.register(scenario("mw-ask").text("Done.").repeatLast().build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, { chatId, prompt: "sc=mw-ask what do you know?", mode: "ask", timeoutMs: 30_000 });
    const t = firstRequest("mw-ask");
    const u = t.users.find((x) => x.includes("sc=mw-ask"))!;
    expect(u).toContain(`Contents of ${memoryIndexPathFor(ctx.ws.dir)}`);
    expect(t.system).toContain("# Project memory");
  });
});
