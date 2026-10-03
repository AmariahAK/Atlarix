import { describe, expect, it } from "vitest";
import { abbreviatePath, activityLabel, formatTokens } from "@/cli/tui/format";

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
