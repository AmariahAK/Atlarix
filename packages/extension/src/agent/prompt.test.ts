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
  it("names the tab-group limit on trusted input, not only in the tool list", () => {
    // Told once in the prompt, a model plans around it; told only in a tool
    // description it reads when it already wants the tool, it discovers the
    // limit by failing — one wasted round every time.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/only work on tabs you opened yourself/i);
    expect(p).toMatch(/open_tab/);
  });

  it("says refs go stale, which is the commonest way an action wastes a turn", () => {
    expect(buildSystemPrompt(base)).toMatch(/read it again/i);
  });

  it("tells it to LEAVE tabs open — they are how the user checks the work", () => {
    // Observed: the agent opened two Wikipedia articles, read them, and closed
    // both before the user could look. A claim about a page they cannot open is
    // a claim they have to take on trust. (It also emptied the agent's tab
    // group, which used to fire the stop gesture and kill the turn.)
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/leave the tabs you opened open/i);
    expect(p).toMatch(/never as a finishing flourish/i);
  });

  it("says filling does not submit", () => {
    expect(buildSystemPrompt(base)).toMatch(/filling does not submit/i);
  });

  it("says WHEN THE TURN IS DONE, which it never used to", () => {
    // Codex's guide calls this "Done when". Without it a turn can spiral or end
    // early with equal ease, and neither failure has anything to push back on.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/## When you are done/);
    expect(p).toMatch(/is there anything left that would change my answer/i);
    expect(p).toMatch(/do not keep going to look thorough/i);
  });

  it("carries WORKED EXAMPLES, which are the biggest single lever", () => {
    // Anthropic's context-engineering guidance: "for an LLM, examples are the
    // 'pictures' worth a thousand words." The prompt had none.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/## Worked examples/);
    // Diverse and canonical rather than exhaustive: a pure read, a multi-tab
    // research task, a form fill that STOPS, and a credential wall.
    expect(p).toMatch(/One call\. Do not open anything/);
    expect(p).toMatch(/then STOP/);
    expect(p).toMatch(/the password is theirs to type/i);
  });

  it("is organised into labelled sections rather than one wall", () => {
    const headers = buildSystemPrompt(base).match(/^## .+$/gm) ?? [];
    expect(headers.length).toBeGreaterThanOrEqual(5);
  });

  it("frames an always-ask stop as a decision, not an obstacle to route around", () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/not something to route around/i);
    expect(p).toMatch(/do not try to reach the same outcome another way/i);
  });

  it("frames a permission prompt as normal, not as a failure", () => {
    // Without this the first approval request reads as a refusal, and the model
    // apologises and abandons the task instead of waiting.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/has not failed/i);
    expect(p).toMatch(/do not apologise/i);
  });

  it("says outright that there are no sub-agents", () => {
    // Otherwise the model works it out from the tool list every single time,
    // spends a paragraph of thinking on it, and narrates the conclusion to the
    // user as though it were news. Observed twice.
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/there are no sub-agents/i);
    expect(p).toMatch(/do not narrate the limitation or apologise/i);
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
