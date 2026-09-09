/**
 * Two calls of the same tool must not show each other's results.
 *
 * The live failure, from a real session: the agent ran two `web_search` calls in one
 * turn. The Wendell Berry card read "0 results" while the Dostoevsky card displayed
 * Berry's results. The search log proves both searches behaved correctly
 * (`"the impeded stream one that sings"` → 19 results, `"the mystery human existence
 * lies not"` → none) and the model's own reasoning shows it received them the right
 * way round — so only the DISPLAY was wrong, which is the worst place for it: the
 * transcript then contradicts what the agent says it found.
 *
 * Cause: the card was matched by `toolCallId` but its CONTENT was fetched by tool
 * NAME, scanning last→first, so the most recently finished call supplied the body for
 * every card of that name.
 */

import { describe, it, expect } from "vitest";
import {
  findToolActivityResult,
  type ToolActivityLike,
} from "@/lib/chat/find-tool-activity-result";

const CHAT = 42;

const berry: ToolActivityLike = {
  chatId: CHAT,
  type: "tool_use",
  toolName: "web_search",
  toolCallId: "call-berry",
  resultText:
    '{"sources":[{"url":"https://example.com/berry","title":"Our Real Work"}]}',
};

const dostoevsky: ToolActivityLike = {
  chatId: CHAT,
  type: "tool_use",
  toolName: "web_search",
  toolCallId: "call-dostoevsky",
  resultText: '{"sources":[]}',
};

describe("concurrent calls of one tool keep their own results", () => {
  // Berry finished FIRST, Dostoevsky second — the order that produced the bug,
  // because the name scan runs last→first and would hand Dostoevsky's empty result
  // to both cards (or Berry's to Dostoevsky's card, depending on which leg wrote last).
  const activities = [berry, dostoevsky];

  it("gives each call its own result", () => {
    expect(
      findToolActivityResult(activities, CHAT, "web_search", "call-berry"),
    ).toEqual({ resultText: berry.resultText, detail: undefined });
    expect(
      findToolActivityResult(activities, CHAT, "web_search", "call-dostoevsky"),
    ).toEqual({ resultText: dostoevsky.resultText, detail: undefined });
  });

  it("does not hand the later call's result to the earlier one", () => {
    const forBerry = findToolActivityResult(
      activities,
      CHAT,
      "web_search",
      "call-berry",
    );
    expect(forBerry.resultText).not.toBe(dostoevsky.resultText);
  });

  it("is unaffected by which call finished last", () => {
    const reversed = [dostoevsky, berry];
    expect(
      findToolActivityResult(reversed, CHAT, "web_search", "call-berry")
        .resultText,
    ).toBe(berry.resultText);
  });

  it("returns nothing for a call id that has not reported yet", () => {
    expect(
      findToolActivityResult(activities, CHAT, "web_search", "call-third"),
    ).toEqual({});
  });
});

describe("the name fallback still works where there is no call id", () => {
  it("matches by name for a legacy row", () => {
    const legacy: ToolActivityLike = {
      chatId: CHAT,
      type: "tool_use",
      toolName: "web_search",
      detail: "legacy detail",
    };
    expect(findToolActivityResult([legacy], CHAT, "web_search")).toEqual({
      resultText: undefined,
      detail: "legacy detail",
    });
  });

  it("never crosses chats", () => {
    const otherChat: ToolActivityLike = { ...berry, chatId: CHAT + 1 };
    expect(
      findToolActivityResult([otherChat], CHAT, "web_search", "call-berry"),
    ).toEqual({});
  });
});
