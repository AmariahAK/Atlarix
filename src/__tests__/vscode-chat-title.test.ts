/**
 * The chat's name on its VS Code tab and the sidebar's header (owner,
 * 2026-10-22): the title as it is, nothing until there is one, short enough
 * for a tab.
 */
import { describe, expect, it } from "vitest";
import { PANEL_TITLE_MAX, panelTitle } from "../../packages/vscode/src/chat-title";

describe("the panel's chat name", () => {
  it("is the session's title", () => {
    expect(panelTitle("Fix the login redirect")).toBe("Fix the login redirect");
  });

  it("is nothing for a chat with no name yet", () => {
    for (const t of [null, undefined, "", "  ", "Untitled", "New chat", "new conversation"]) expect(panelTitle(t)).toBeNull();
  });

  it("is cut short for a tab, on one line", () => {
    const long = "Refactor the payment webhook handler to retry idempotently on 5xx";
    const out = panelTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(PANEL_TITLE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(panelTitle("two\nlines")).toBe("two lines");
  });
});
