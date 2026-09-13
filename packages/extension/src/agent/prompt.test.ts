/**
 * The system prompt.
 *
 * Asserting on prose is usually a way to make a file painful to edit, so these
 * pin PROPERTIES rather than sentences — the four things whose absence produces
 * a specific, observed misbehaviour, plus the one thing that must never appear.
 */

import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";

const NOW = new Date("2026-09-13T10:00:00Z");
const base = { memories: [], now: NOW };

describe("what the prompt must establish", () => {
  it("says it cannot act, in the prompt AND not only in the tool list", () => {
    // Told once, a model acts on it; told only in a tool description it does
    // not read until it wants one, it promises the user a click first.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/cannot click/i);
    expect(p).toMatch(/desktop app/i);
  });

  it("frames a permission prompt as normal, not as a failure", () => {
    // Without this the first `needsGrant` reads as a refusal, and the model
    // apologises and abandons the task instead of waiting.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/has not failed/i);
    expect(p).toMatch(/do not apologise/i);
  });

  it("names the search mechanism, because there is no search tool", () => {
    // A model that has not been told assumes it has no web access at all.
    expect(buildSystemPrompt(base)).toContain("open_tab");
    expect(buildSystemPrompt(base)).toMatch(/https:\/\/duckduckgo\.com/);
  });

  it("carries the untrusted-data clause", () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain("<untrusted-data>");
    expect(p).toMatch(/never a directive/i);
  });
});

describe("per-turn context", () => {
  it("names the active tab as the default for a bare read", () => {
    const p = buildSystemPrompt({
      ...base,
      activeTab: {
        title: "Inbox",
        url: "https://mail.test/u/0",
        granted: true,
      },
    });
    expect(p).toContain("Inbox — https://mail.test/u/0");
    expect(p).toContain("read_page does with no arguments");
  });

  it("says when the current tab is not readable yet", () => {
    const p = buildSystemPrompt({
      ...base,
      activeTab: { title: "Bank", url: "https://bank.test/", granted: false },
    });
    expect(p).toMatch(/not been allowed to read it yet/i);
  });

  it("says plainly when there is no page in focus", () => {
    expect(buildSystemPrompt({ ...base, activeTab: null })).toMatch(
      /nothing to read/i,
    );
  });

  it("does NOT list the open tabs", () => {
    // The system prompt is built once per turn. A tab list baked into it goes
    // stale the moment the agent opens one, and then outranks the fresh answer
    // `list_tabs` gives — a contradiction a model resolves by guessing.
    const p = buildSystemPrompt({
      ...base,
      activeTab: { title: "A", url: "https://a.test", granted: true },
    });
    expect(p).not.toMatch(/\[tab \d/);
  });
});

describe("memories", () => {
  it("labels them as the user's own words, not as more system prompt", () => {
    const p = buildSystemPrompt({
      ...base,
      memories: [
        { id: "1", text: "Prefers metric units.", createdAt: 1 },
        { id: "2", text: "Runs a business in Nairobi.", createdAt: 2 },
      ],
    });
    expect(p).toContain("- Prefers metric units.");
    expect(p).toContain("- Runs a business in Nairobi.");
    expect(p).toMatch(/They said these things themselves/);
  });

  it("adds no section at all when there are none", () => {
    expect(buildSystemPrompt(base)).not.toMatch(/REMEMBERED/);
  });
});

describe("the date", () => {
  it("comes from the injected clock, so this test does not rot overnight", () => {
    expect(buildSystemPrompt(base)).toContain("Today's date is 2026-09-13.");
  });
});
