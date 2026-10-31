import { describe, expect, it } from "vitest";
import { abbreviatePath, activityLabel, contextLabel, formatTokens } from "@/cli/tui/format";

describe("abbreviatePath", () => {
  it("uses ~ and keeps short paths whole", () => {
    expect(abbreviatePath("/Users/me/code/app", 40, "/Users/me")).toBe("~/code/app");
  });
  it("cuts from the middle, keeping the folder's own name", () => {
    const out = abbreviatePath("/Users/me/private/tmp/scratch/very/long/p2/ws", 16, "/Users/me");
    expect(out.startsWith("~/…/")).toBe(true);
    expect(out.endsWith("/p2/ws")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(16);
  });
});

describe("activityLabel", () => {
  const base = { busy: true, approvals: [] as never[] };
  it("names the running tool", () => {
    expect(
      activityLabel({ ...base, cells: [{ kind: "tool", id: "1", tool: { id: "t", verb: "Run", target: "ls", status: "running" } }] }),
    ).toBe("Running ls…");
  });
  it("says Writing while text streams, Thinking otherwise, nothing when idle", () => {
    expect(activityLabel({ ...base, cells: [{ kind: "markdown", id: "1", text: "x" }] })).toBe("Writing…");
    expect(activityLabel({ ...base, cells: [] })).toBe("Thinking…");
    expect(activityLabel({ ...base, busy: false, cells: [] })).toBeNull();
  });
  it("says Waiting for you when a prompt is up", () => {
    expect(activityLabel({ ...base, approvals: [{} as never], cells: [] })).toBe("Waiting for you");
  });
});

describe("formatTokens", () => {
  it("shortens thousands", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_000)).toBe("45k");
  });
});

describe("abbreviatePath on Windows (QA, Windows VM)", () => {
  it("keeps backslashes and cuts from the middle, with no stray /…/", () => {
    const p = "C:\\Users\\Amariah Abishai\\atlarix-qa\\ws one";
    expect(abbreviatePath(p, 80, "C:\\Users\\Amariah Abishai")).toBe("~\\atlarix-qa\\ws one");
    const cut = abbreviatePath(p, 24, "C:\\Users\\Someone");
    expect(cut).toBe("C:\\…\\atlarix-qa\\ws one");
    expect(cut).not.toContain("/");
  });
});

/**
 * The status line shows HOW FULL the session is, never the raw token pair
 * (owner, 2026-10-31): the pair invited the reader to compare two numbers that
 * are not always measured against the same window. `/context` holds the detail.
 */
describe("contextLabel", () => {
  it("shows a percentage only", () => {
    expect(contextLabel({ contextPercent: 23 })).toBe("context 23%");
  });

  it("never prints a token count, even when the session carries one", () => {
    const label = contextLabel({
      contextPercent: 83,
      contextUsed: 212_000,
      contextLimit: 256_000,
    } as Parameters<typeof contextLabel>[0]);
    expect(label).toBe("context 83%");
    expect(label).not.toMatch(/\dk\b/);
    expect(label).not.toContain("/");
  });

  it("says nothing before the first step reports", () => {
    expect(contextLabel({ contextPercent: null })).toBeNull();
  });
});
