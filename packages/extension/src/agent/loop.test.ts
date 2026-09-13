/**
 * The loop.
 *
 * Every assertion here is a failure that would otherwise be invisible until it
 * happened to a user:
 *
 *  - **Message ORDER.** A tool result whose call is not already in the history
 *    is rejected by the provider outright, and the error names the message
 *    index rather than the cause.
 *  - **The repetition guard.** Untested, it either never fires (a spin the user
 *    pays for by the token) or fires on round two (a model that legitimately
 *    re-reads a page it just navigated gets cut off).
 *  - **Abort is not an error.** The user pressing Stop must not be shown a
 *    failure, and an abort arrives from `fetch` as a DOMException rather than
 *    as anything this code threw.
 *  - **The grant retry happens exactly once.** Zero times makes the permission
 *    prompt pointless; twice asks a user who just said yes to say it again.
 */

import { describe, expect, it, vi } from "vitest";
import { CoreError, type CoreEvent, type ToolCall } from "../core/client";
import { DOOM_LOOP_THRESHOLD, runTurn, type TurnArgs } from "./loop";
import type { ToolOutcome } from "../tools/dispatch";

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** A fake `streamTurn`: one scripted round per call. */
function scriptedStream(rounds: CoreEvent[][]) {
  const seen: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
  let i = 0;
  const stream = async function* stream(a: {
    messages: unknown[];
    tools?: unknown[];
  }) {
    seen.push({ messages: [...a.messages], tools: a.tools });
    const events = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    for (const e of events) yield e;
  } as unknown as TurnArgs["stream"];
  return { stream, seen, calls: () => i };
}

const BASE = {
  model: "core-1",
  system: "you are a test",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: { windowId: 1 },
};

function textRound(text: string): CoreEvent[] {
  return [
    { type: "text", delta: text },
    { type: "done", finishReason: "stop" },
  ];
}

function toolRound(...calls: ToolCall[]): CoreEvent[] {
  return [
    { type: "tool-calls", calls },
    { type: "done", finishReason: "tool_calls" },
  ];
}

describe("a plain answer", () => {
  it("returns one assistant message and stops", async () => {
    const { stream, calls } = scriptedStream([textRound("Hi there.")]);
    const out = await runTurn({ ...BASE, stream });
    expect(out.kind).toBe("complete");
    expect(out.messages).toEqual([{ role: "assistant", content: "Hi there." }]);
    expect(calls()).toBe(1);
  });

  it("streams every delta to the UI as it arrives", async () => {
    const { stream } = scriptedStream([
      [
        { type: "text", delta: "Hel" },
        { type: "text", delta: "lo" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const deltas: string[] = [];
    await runTurn({
      ...BASE,
      stream,
      events: { onText: (d) => deltas.push(d) },
    });
    expect(deltas).toEqual(["Hel", "lo"]);
  });
});

describe("a tool round", () => {
  it("puts the assistant's tool_calls in the history BEFORE the results", async () => {
    // A tool message whose call is not already in the history is rejected by
    // the provider, and the error names a message index, not this.
    const { stream, seen } = scriptedStream([
      toolRound(toolCall("list_tabs")),
      textRound("Two tabs."),
    ]);
    const dispatch = (async () => ({
      content: "1 tab",
    })) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);

    // And the second request carries them in that order too.
    const second = seen[1].messages as Array<{ role: string }>;
    expect(second.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("quotes back the id the model sent, not one of its own", async () => {
    const { stream } = scriptedStream([
      toolRound(toolCall("list_tabs")),
      textRound("done"),
    ]);
    const dispatch = (async () => ({
      content: "ok",
    })) as unknown as TurnArgs["dispatch"];
    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_list_tabs",
      content: "ok",
    });
  });

  it("runs two calls in the order the model asked for them", async () => {
    // Sequential, not parallel: two `open_tab` calls at once race to create the
    // agent's tab group and produce two of them.
    const { stream } = scriptedStream([
      toolRound(
        toolCall("open_tab", { url: "https://a.test" }),
        toolCall("open_tab", { url: "https://b.test" }),
      ),
      textRound("opened"),
    ]);
    const order: string[] = [];
    const dispatch = (async (c: ToolCall) => {
      order.push(c.function.arguments);
      return { content: "ok" };
    }) as unknown as TurnArgs["dispatch"];

    await runTurn({ ...BASE, stream, dispatch });
    expect(order).toEqual([
      '{"url":"https://a.test"}',
      '{"url":"https://b.test"}',
    ]);
  });
});

describe("the repetition guard", () => {
  it("fires on the THIRD identical round, not the second", async () => {
    // Two is legitimate: re-reading a page just navigated is the same bytes and
    // a different page. Three is a spin the user pays for.
    const repeated = toolRound(toolCall("read_page"));
    const { stream, calls } = scriptedStream([
      repeated,
      repeated,
      repeated,
      textRound("I am stuck because the page never changes."),
    ]);
    const dispatch = (async () => ({
      content: "same page",
    })) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.kind).toBe("stuck");
    // Two full tool rounds ran; the third triggered the guard before dispatch.
    expect(calls()).toBe(DOOM_LOOP_THRESHOLD + 1);
    expect(out.messages.at(-1)).toEqual({
      role: "assistant",
      content: "I am stuck because the page never changes.",
    });
  });

  it("does not fire when the arguments change", async () => {
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page", { tab_id: 1 })),
      toolRound(toolCall("read_page", { tab_id: 2 })),
      toolRound(toolCall("read_page", { tab_id: 3 })),
      textRound("Three different tabs."),
    ]);
    const dispatch = (async () => ({
      content: "page",
    })) as unknown as TurnArgs["dispatch"];
    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.kind).toBe("complete");
  });

  it("ignores the call id, which changes every round by construction", async () => {
    // Including the id in the signature would make the guard unfireable, and
    // nothing else in the system would notice.
    const round = (n: number): CoreEvent[] =>
      toolRound({
        id: `call_${n}`,
        type: "function",
        function: { name: "read_page", arguments: "{}" },
      });
    const { stream } = scriptedStream([
      round(1),
      round(2),
      round(3),
      textRound("stuck"),
    ]);
    const dispatch = (async () => ({
      content: "x",
    })) as unknown as TurnArgs["dispatch"];
    expect((await runTurn({ ...BASE, stream, dispatch })).kind).toBe("stuck");
  });

  it("still reports stuck when even the closing round fails", async () => {
    const repeated = toolRound(toolCall("read_page"));
    let i = 0;
    const stream = async function* () {
      i += 1;
      if (i > DOOM_LOOP_THRESHOLD) throw new Error("core down");
      for (const e of repeated) yield e;
    } as unknown as TurnArgs["stream"];
    const dispatch = (async () => ({
      content: "x",
    })) as unknown as TurnArgs["dispatch"];
    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.kind).toBe("stuck");
  });
});

describe("stopping", () => {
  it("reports an abort as an abort, never as an error", async () => {
    // An abort arrives from `fetch` as a DOMException, which is not a CoreError
    // and must not be shown to the user as a failure — they did this on purpose.
    const controller = new AbortController();
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("never reached"),
    ]);
    const dispatch = (async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({
      ...BASE,
      stream,
      dispatch,
      signal: controller.signal,
    });
    expect(out.kind).toBe("aborted");
  });

  it("turns an escaped tool throw into a result rather than losing the turn", async () => {
    // `dispatchTool` converts its own failures and should never reach this
    // path. The consequence of being wrong is asymmetric: one tool would
    // discard every message the run produced.
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("Recovered."),
    ]);
    const dispatch = (async () => {
      throw new Error("something unforeseen");
    }) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.kind).toBe("complete");
    expect((out.messages[1] as { content: string }).content).toContain(
      "threw instead of returning a result",
    );
  });

  it("returns what completed when the user stops between rounds", async () => {
    const controller = new AbortController();
    const { stream } = scriptedStream([
      toolRound(toolCall("list_tabs")),
      textRound("never reached"),
    ]);
    const dispatch = (async () => {
      controller.abort();
      return { content: "one tab" } satisfies ToolOutcome;
    }) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({
      ...BASE,
      stream,
      dispatch,
      signal: controller.signal,
    });
    expect(out.kind).toBe("aborted");
    // The work already done survives — a turn that read three pages and was
    // then stopped should not lose the three pages.
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  });
});

describe("a site the user has not allowed", () => {
  const needsHostGrant: ToolOutcome = {
    content: "waiting",
    needsApproval: {
      kind: "host",
      url: "https://x.test/p",
      origin: "https://x.test",
    },
  };

  it("asks once, and on a yes retries the call exactly once", async () => {
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("Read it."),
    ]);
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(needsHostGrant)
      .mockResolvedValueOnce({ content: "the page" });
    const onApproval = vi.fn().mockResolvedValue(true);

    const out = await runTurn({
      ...BASE,
      stream,
      dispatch: dispatch as unknown as TurnArgs["dispatch"],
      events: { onApproval },
    });
    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(out.messages[1]).toMatchObject({ content: "the page" });
  });

  it("tells the model a decline is a decision, not an error to work around", async () => {
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("Understood."),
    ]);
    const dispatch = vi.fn().mockResolvedValue(needsHostGrant);
    const out = await runTurn({
      ...BASE,
      stream,
      dispatch: dispatch as unknown as TurnArgs["dispatch"],
      events: { onApproval: async () => false },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const result = out.messages[1] as { content: string };
    expect(result.content).toContain("did not allow https://x.test");
    expect(result.content).toContain("do not ask again");
  });

  it("declines when the panel offers no way to ask at all", async () => {
    // No `onApproval` hook — a caller that forgot must not spin.
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("ok"),
    ]);
    const dispatch = vi.fn().mockResolvedValue(needsHostGrant);
    await runTurn({
      ...BASE,
      stream,
      dispatch: dispatch as unknown as TurnArgs["dispatch"],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not ask a second time when the grant landed but the read still cannot", async () => {
    const { stream } = scriptedStream([
      toolRound(toolCall("read_page")),
      textRound("ok"),
    ]);
    const dispatch = vi.fn().mockResolvedValue(needsHostGrant);
    const onApproval = vi.fn().mockResolvedValue(true);
    const out = await runTurn({
      ...BASE,
      stream,
      dispatch: dispatch as unknown as TurnArgs["dispatch"],
      events: { onApproval },
    });
    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((out.messages[1] as { content: string }).content).toContain(
      "still cannot proceed",
    );
  });
});

describe("Core refusing", () => {
  it("keeps the work already done when a turn hits a 402 mid-flight", async () => {
    let i = 0;
    const stream = async function* () {
      i += 1;
      if (i === 1) {
        for (const e of toolRound(toolCall("list_tabs"))) yield e;
        return;
      }
      throw new CoreError(
        402,
        "insufficient_credit",
        "Not enough credit.",
        250,
      );
    } as unknown as TurnArgs["stream"];
    const dispatch = (async () => ({
      content: "tabs",
    })) as unknown as TurnArgs["dispatch"];

    const out = await runTurn({ ...BASE, stream, dispatch });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.error.requiredCents).toBe(250);
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  });

  it("wraps a non-Core failure so the caller has one error type", async () => {
    const stream = async function* () {
      throw new TypeError("Failed to fetch");
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    } as unknown as TurnArgs["stream"];
    const out = await runTurn({ ...BASE, stream });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.error).toBeInstanceOf(CoreError);
    expect(out.error.message).toContain("Failed to fetch");
  });
});
