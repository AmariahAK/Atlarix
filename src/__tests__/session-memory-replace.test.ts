import { describe, it, expect } from "vitest";
import { SessionMemory } from "@/lib/session-memory";

describe("SessionMemory.replaceLastExchange", () => {
  it("replaces the last exchange instead of growing the buffer", () => {
    const mem = new SessionMemory({ maxExchanges: 7 });
    mem.addExchange("first user", "first assistant");
    mem.replaceLastExchange("edited user", "new assistant");
    expect(mem.getExchangeCount()).toBe(1);
    const ctx = mem.getContextForPrompt();
    expect(ctx).toContain("edited user");
    expect(ctx).toContain("new assistant");
    expect(ctx).not.toContain("first user");
  });

  it("adds when buffer is empty", () => {
    const mem = new SessionMemory();
    mem.replaceLastExchange("user", "assistant");
    expect(mem.getExchangeCount()).toBe(1);
  });
});
