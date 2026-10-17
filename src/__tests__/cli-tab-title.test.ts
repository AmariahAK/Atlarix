import { describe, expect, it } from "vitest";
import { TAB_FRAMES, tabTitle, titleSequence } from "@/cli/tui/tab-title";

describe("the CLI's tab title", () => {
  it("pulses the diamond while Atlarix works", () => {
    const frames = TAB_FRAMES.map((_, i) => tabTitle({ busy: true, waiting: false, title: "Fix login" }, i));
    expect(frames).toEqual(["◇ Fix login", "◈ Fix login", "◆ Fix login", "◈ Fix login"]);
    expect(tabTitle({ busy: true, waiting: false, title: "Fix login" }, 4)).toBe("◇ Fix login");
  });

  it("says when it needs you with its own icon, and holds still", () => {
    expect(tabTitle({ busy: true, waiting: true, title: "Fix login" }, 2)).toBe("<!> needs you · Fix login");
  });

  it("is the session title when idle, atlarix before there is one", () => {
    expect(tabTitle({ busy: false, waiting: false, title: "Fix login" }, 3)).toBe("◆ Fix login");
    expect(tabTitle({ busy: false, waiting: false }, 0)).toBe("◆ atlarix");
  });

  it("never lets a title end the escape sequence early", () => {
    const t = tabTitle({ busy: false, waiting: false, title: "evil\x07\x1b]0;x" }, 0);
    expect(t).not.toMatch(/[\x00-\x1f]/);
    expect(titleSequence(t)).toMatch(/^\x1b\]0;[^\x07\x1b]*\x07$/);
  });
});
