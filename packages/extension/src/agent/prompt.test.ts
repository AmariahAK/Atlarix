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
const base = { notes: null, now: NOW };

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

  it("does NOT restate what a competent model already knows", () => {
    // DELETED 2026-09-13, owner's call, and the desktop is the evidence: its
    // `browser` tool describes fill as "set `ref` to `value` in the SAME call"
    // and says nothing about submitting. The relationship is conveyed by
    // press_key's own description — "Enter to submit a form" — which is a fact
    // about OUR tool rather than a lecture about HTML forms.
    //
    // Over-prompting is not free: it costs tokens on every round, and a model
    // reciting rules back in its own thinking is a model spending reasoning
    // budget on the prompt instead of the task. Observed on GLM 5.3.
    const p = buildSystemPrompt(base);
    expect(p).not.toMatch(/filling does not submit/i);
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

  it("names the search tool, and says a snippet is not an answer", () => {
    // A model that has not been told assumes it has no web access at all. And
    // one that HAS a search tool will answer straight from the snippets unless
    // told they are a reason to open a page rather than the page.
    const p = buildSystemPrompt(base);
    expect(p).toContain("web_search");
    expect(p).toContain("open_tab");
    expect(p).toMatch(/never the answer/i);
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

describe("the notes index", () => {
  const twoNotes = {
    index:
      "- [Metric units](preferences.md) — wants metric and 24h times\n" +
      "- [Runs a studio](work.md) — two-person design studio in Nairobi",
    count: 2,
    limit: 30,
  };

  it("carries the index lines and no bodies", () => {
    const p = buildSystemPrompt({ ...base, notes: twoNotes });
    expect(p).toContain("- [Metric units](preferences.md)");
    expect(p).toContain("- [Runs a studio](work.md)");
    expect(p).toMatch(/Read one with read_note/);
  });

  it("NEVER injects a body — this is the whole design", () => {
    // THE ARITHMETIC THAT DECIDES EVERYTHING ELSE HERE. A note may be 26 KB,
    // which is ~6,500 tokens, against a total per-round overhead of ~4,100. One
    // body in the prompt would cost more than the entire rest of it, and would
    // be strictly worse than the 50-sentence store this replaced. Every other
    // choice in the notes design is a preference; this one is the constraint.
    const body = "SECRET_BODY_MARKER ".repeat(1_600); // ~30 KB
    const p = buildSystemPrompt({ ...base, notes: twoNotes });
    expect(p).not.toContain(body);
    expect(p).not.toContain("SECRET_BODY_MARKER");
    // And the section itself stays small enough to be worth having.
    expect(p.length).toBeLessThan(12_000);
  });

  it("tells the model the limit, because one it cannot see it will hit", () => {
    const p = buildSystemPrompt({ ...base, notes: twoNotes });
    expect(p).toMatch(/2 of 30 notes/);
    expect(p).toMatch(/26 KB/);
  });

  it("puts a full-store flag on the header line, not in a paragraph of its own", () => {
    // A FLAG, NOT A LESSON. The desktop's first version of this explained
    // itself and cost 147 tokens on every turn.
    const p = buildSystemPrompt({
      ...base,
      notes: { ...twoNotes, count: 30, flag: "FULL: merge a.md, b.md" },
    });
    const header = p.split("\n").find((l) => l.includes("WHAT ATLARIX REMEMBERS"));
    expect(header).toContain("FULL: merge a.md, b.md");
  });

  it("adds no section at all when there are no notes", () => {
    expect(buildSystemPrompt(base)).not.toMatch(/WHAT ATLARIX REMEMBERS/);
  });
});

describe("the date", () => {
  it("comes from the injected clock, so this test does not rot overnight", () => {
    expect(buildSystemPrompt(base)).toContain("Today's date is 2026-09-13.");
  });
});

describe("prefix stability, which is what makes caching work", () => {
  /**
   * EVERY CORE TIER CACHES THE REQUEST PREFIX AUTOMATICALLY — OpenAI at roughly
   * 90% off input, z.ai at 81%. A cache hit covers the LONGEST SHARED PREFIX, so
   * the first byte that differs re-prices everything after it at full rate.
   *
   * This prompt plus the tool schemas is ~4,100 tokens on every round of every
   * turn, which makes the ordering below worth more than any amount of trimming.
   */
  const notes = {
    index: "- [Metric units](preferences.md) — wants metric in every answer",
    count: 1,
    limit: 30,
  };
  const tabA = { title: "A", url: "https://a.example", granted: true };
  const tabB = { title: "B", url: "https://b.example", granted: true };
  const now = new Date("2026-09-13T00:00:00Z");

  /** How much of two prompts is byte-identical from the start. */
  const sharedPrefix = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };

  it("keeps everything stable ahead of the tab that changes every turn", () => {
    // THE REGRESSION THIS CATCHES. The active tab used to be pushed BEFORE the
    // notes index, so switching tabs re-charged the index too — for no reason
    // beyond the order two `push` calls were written in.
    const a = buildSystemPrompt({ notes, activeTab: tabA, now });
    const b = buildSystemPrompt({ notes, activeTab: tabB, now });
    const shared = sharedPrefix(a, b);

    // Everything up to the tab line is identical…
    expect(a.slice(0, shared)).toContain("[Metric units](preferences.md)");
    expect(a.slice(0, shared)).toContain("Today's date is");
    // …and the tab is what diverges.
    expect(a.slice(shared)).toContain("a.example");
    expect(b.slice(shared)).toContain("b.example");
  });

  it("puts the volatile line LAST, so nothing stable sits behind it", () => {
    const p = buildSystemPrompt({ notes, activeTab: tabA, now });
    expect(p.indexOf("[Metric units](preferences.md)")).toBeLessThan(
      p.indexOf("Today's date is"),
    );
    expect(p.indexOf("Today's date is")).toBeLessThan(p.indexOf("a.example"));
  });

  it("is byte-identical for the same inputs, so a round cannot miss its own cache", () => {
    // Anything non-deterministic here — a timestamp, a Set iteration, a random
    // id — would break the cache on EVERY round and be invisible in testing.
    const once = buildSystemPrompt({ notes, activeTab: tabA, now });
    const twice = buildSystemPrompt({ notes, activeTab: tabA, now });
    expect(once).toBe(twice);
  });

  it("shares its whole prefix with a conversation that has no notes yet", () => {
    // A user's first `remember` should not re-price the base prompt behind it.
    const without = buildSystemPrompt({ notes: null, activeTab: tabA, now });
    const with_ = buildSystemPrompt({ notes, activeTab: tabA, now });
    expect(sharedPrefix(without, with_)).toBeGreaterThan(BASE_MIN_CHARS);
  });
});

/** The fixed opening text, which every prompt shares whatever the context. */
const BASE_MIN_CHARS = 4_000;

describe("the skills index", () => {
  const skills = {
    index: "- [Cut a release](skill:cut-a-release) — when a release needs tagging",
    count: 1,
  };

  it("carries name and hook, and routes the model to read_note", () => {
    const p = buildSystemPrompt({ ...base, skills });
    expect(p).toContain("[Cut a release](skill:cut-a-release)");
    expect(p).toMatch(/Read one with read_note/);
  });

  it("never carries a body — same arithmetic as notes", () => {
    // A skill body may be 64 KB. The index exists so cost scales with the
    // NUMBER of skills, not their size.
    const p = buildSystemPrompt({ ...base, skills });
    expect(p).not.toContain("npm run release");
    expect(p.length).toBeLessThan(12_000);
  });

  it("is omitted entirely when the user has none", () => {
    expect(buildSystemPrompt({ ...base, skills: null })).not.toMatch(
      /SKILLS THE USER WROTE/,
    );
    expect(buildSystemPrompt(base)).not.toMatch(/SKILLS THE USER WROTE/);
  });

  it("sits with the notes band, ahead of the date that changes daily", () => {
    const p = buildSystemPrompt({
      ...base,
      notes: { index: "- [N](n.md) — hook", count: 1, limit: 30 },
      skills,
    });
    expect(p.indexOf("SKILLS THE USER WROTE")).toBeLessThan(
      p.indexOf("Today's date is"),
    );
  });
});

describe("connectors in the prompt", () => {
  it("explains them in BASE, which is paid for once and cached forever", () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/Connectors are services the user attached/);
    expect(p).toMatch(/NOT in your tool list/);
    // The instruction that makes discovery work: list, THEN decide.
    expect(p).toMatch(/never assume a connector exists and never assume one does not/);
  });

  it("names them, and carries nothing else about them", () => {
    const p = buildSystemPrompt({ ...base, connectors: ["Linear", "Notion"] });
    expect(p).toContain("Connectors set up on this account: Linear, Notion.");
    // NO URLs, NO descriptions, NO tool names. The `name` column is the only
    // connector field with a CHECK making it prompt-safe by construction, and a
    // remote server adding a tool must not invalidate the cached prefix.
    expect(p).not.toMatch(/https?:\/\/(?!atlarix\.dev)/);
  });

  it("says nothing at all when the account has none", () => {
    expect(buildSystemPrompt({ ...base, connectors: [] })).not.toMatch(
      /Connectors set up on this account/,
    );
    expect(buildSystemPrompt(base)).not.toMatch(/Connectors set up on this account/);
  });

  it("sits ahead of the date, so a connector edit does not re-price it", () => {
    const p = buildSystemPrompt({ ...base, connectors: ["Linear"] });
    expect(p.indexOf("Connectors set up on this account")).toBeLessThan(
      p.indexOf("Today's date is"),
    );
  });
});
