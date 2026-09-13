import { describe, expect, it } from "vitest";
import type { ContextStatus } from "../context/budget";
import { contextBarView } from "./context-bar";

const status = (over: Partial<ContextStatus> = {}): ContextStatus => ({
  usedTokens: 1_000,
  usable: 10_000,
  ratio: 0.1,
  health: "healthy",
  willCompact: false,
  exact: false,
  ...over,
});

describe("when the bar is hidden", () => {
  it("hides when the tier has no known window", () => {
    // The proxy reports `context_window: null` when models.dev has no row.
    // Unknown is not zero, and a bar drawn from zero reads as permanently full.
    expect(contextBarView(null).hidden).toBe(true);
  });

  it("hides on an empty conversation", () => {
    // A 0% bar above an empty composer is chrome on the screen the user looks at
    // most, and it never changes there.
    expect(contextBarView(status(), { hasMessages: false }).hidden).toBe(true);
  });

  it("shows while compacting even if the transcript reads as empty", () => {
    // Compaction is the one moment the bar has something to say regardless.
    const view = contextBarView(status(), {
      hasMessages: false,
      compacting: true,
    });
    expect(view.hidden).toBe(false);
    expect(view.busy).toBe(true);
  });
});

describe("what the label says", () => {
  it("is just a percentage while there is room", () => {
    expect(
      contextBarView(status({ ratio: 0.23 }), { hasMessages: true }).label,
    ).toBe("Context 23%");
  });

  it("names the event once it is getting full", () => {
    // "Context 88%" alone tells a user nothing they can act on. What happens at
    // 100% is the part worth knowing BEFORE it happens.
    const view = contextBarView(status({ ratio: 0.88, health: "over" }), {
      hasMessages: true,
    });
    expect(view.label).toContain("88%");
    expect(view.label).toMatch(/summaris/i);
  });

  it("does not mention summarising while the conversation is short", () => {
    const view = contextBarView(status({ ratio: 0.4, health: "healthy" }), {
      hasMessages: true,
    });
    expect(view.label).not.toMatch(/summaris/i);
  });

  it("says compaction is due on the next message once over budget", () => {
    const view = contextBarView(
      status({ ratio: 1.4, health: "over", willCompact: true }),
      { hasMessages: true },
    );
    expect(view.label).toMatch(/next message/i);
    expect(view.fill).toBe(1);
  });

  it("quotes no token figure, because the count is an estimate", () => {
    // `len / 4` runs ±20%. "48,213 tokens" is a more confident claim than that
    // supports; a percentage is not.
    for (const ratio of [0.1, 0.6, 0.9, 1.5]) {
      const view = contextBarView(status({ ratio, health: "over" }), {
        hasMessages: true,
      });
      expect(view.label).not.toMatch(/\d{4,}/);
      expect(view.label).not.toMatch(/token/i);
    }
  });
});

describe("the fill", () => {
  it("never exceeds full, however far over budget the transcript is", () => {
    expect(contextBarView(status({ ratio: 9 }), { hasMessages: true }).fill).toBe(
      1,
    );
  });

  it("carries the health so the colour and the label cannot disagree", () => {
    expect(
      contextBarView(status({ ratio: 0.6, health: "warning" }), {
        hasMessages: true,
      }).health,
    ).toBe("warning");
  });
});
