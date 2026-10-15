import { describe, expect, it, vi } from "vitest";

/**
 * /mcp in an editor without an Atlarix panel (Zed, JetBrains) offers the user's
 * default servers that aren't added yet, not a fixed Verified list.
 */

const defaults = vi.fn();
vi.mock("@/cli/agent/services", () => ({
  realServices: {
    account: { email: async () => "a@b.c" },
    mcp: {
      account: async () => [],
      list: async () => [],
      found: async () => [],
      defaults: (...a: unknown[]) => defaults(...a),
    },
  },
}));

const { accountCommandText } = await import("@/cli/acp/account-commands");
const session = {
  appId: 4,
} as unknown as import("@/cli/agent/session").AgentSession;

describe("/mcp lists the user's defaults", () => {
  it("offers the ones not added here, by title", async () => {
    defaults.mockResolvedValue([
      { name: "app.linear/linear", title: "Linear", state: "not-added" },
      {
        name: "com.notion/mcp",
        title: "Notion",
        state: "on",
        where: "account",
        id: "c1",
      },
    ]);
    const text = await accountCommandText("mcp", session);
    expect(defaults).toHaveBeenCalledWith(4);
    expect(text).toContain("**Your defaults**");
    expect(text).toContain("- Linear: `/mcp add linear`");
    expect(text).not.toContain("Notion: `/mcp add");
    expect(text).not.toContain("**Verified**");
  });

  it("has no section when every default is added", async () => {
    defaults.mockResolvedValue([
      {
        name: "com.notion/mcp",
        title: "Notion",
        state: "off",
        where: "local",
        id: 2,
      },
    ]);
    expect(await accountCommandText("mcp", session)).not.toContain(
      "**Your defaults**",
    );
  });
});
