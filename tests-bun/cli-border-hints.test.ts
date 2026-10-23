/**
 * The composer's border line: the session's name stays while a turn runs
 * (that is when people switch tabs and come back), and gives way only after
 * the less useful key hints when the line is short.
 */
import { describe, expect, it } from "bun:test";
import { borderHints } from "../src/cli/tui/App";

const base = { queued: false, running: false, narrow: false, place: "~/proj" };

describe("borderHints", () => {
  it("names the session while it works, not only when idle", () => {
    expect(borderHints({ ...base, busy: false, title: "Login page" })).toContain("Login page");
    expect(borderHints({ ...base, busy: true, title: "Login page" })).toMatch(/^Login page · esc stop/);
  });

  it("short of room: the queue and steer hints go first, then the name; esc stop stays", () => {
    const line = borderHints({ ...base, busy: true, title: "Login page", max: 24 });
    expect(line).toBe("Login page · esc stop");
    expect(borderHints({ ...base, busy: true, title: "Login page", max: 10 })).toBe("esc stop");
  });
});
