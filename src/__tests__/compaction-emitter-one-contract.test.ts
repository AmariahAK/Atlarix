/**
 * Every compaction trigger announces itself the same way.
 *
 * v14.39.0 unified compaction into ONE compactor with three triggers — the right
 * consolidation — and left the ANNOUNCING hand-rolled at six call sites across
 * four files, with three different labels ("Context compacted automatically",
 * "Context compressed", "Summarizing in-task context") and inconsistent types.
 *
 * That had a user-visible cost, reported 2026-09-02 with the context ring pinned
 * at 100% and no indicator at all: **the AUTOMATIC pre-dispatch compaction
 * emitted only `type: "compaction"`**, which `chat-activity-normalize.ts` drops
 * by design, and never the `background` event the mid-stream pill reads. So the
 * trigger nobody asks for — the one most likely to be noticed as an unexplained
 * pause — was the only one with no UI. A model no-op had the same defect, from a
 * different cause (`if (outcome.success)` gated the background event).
 *
 * What this pins is the CONTRACT, not the wording: both events, every time, with
 * a label the renderer's filter matches.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: Array<Record<string, unknown>> = [];

vi.mock("@/ipc/utils/safe_sender", () => ({
  safeSend: (_s: unknown, _ch: string, payload: Record<string, unknown>) => {
    sent.push(payload);
  },
}));

const { emitCompactionActivity } = await import(
  "@/ipc/handlers/chat_stream/compaction-activity"
);
const { normalizeChatActivityPayload, upsertActivityStreamItem } = await import(
  "@/lib/chat-activity-normalize"
);
const { streamThreadItemFromActivity, upsertStreamThreadItem } = await import(
  "@/lib/chat/stream-thread"
);

/** The filter InlineStreamStatus and useCompactionTokenVisuals both use. */
const COMPACTION_LABEL_FILTER = /summariz|compress|compact/i;

const fakeSender = {} as never;

beforeEach(() => {
  sent.length = 0;
});

describe("one compaction emitter, three triggers", () => {
  for (const trigger of ["automatic", "mid-loop", "model"] as const) {
    it(`${trigger}: emits a background event that SURVIVES normalisation`, () => {
      emitCompactionActivity(fakeSender, 7, {
        id: `c-${trigger}`,
        trigger,
        status: "running",
      });

      const bg = sent.find((p) => p.type === "background");
      expect(bg, "a background event is the only user-visible one").toBeTruthy();
      // The defect was here: dropped by the normaliser, so no pill.
      const item = normalizeChatActivityPayload(bg!);
      expect(item, "must survive normalize").not.toBeNull();
      // And the label has to match the filter, or the pill ignores it.
      expect(COMPACTION_LABEL_FILTER.test(String(bg!.label))).toBe(true);
    });

    it(`${trigger}: also emits the raw compaction signal, which IS dropped`, () => {
      emitCompactionActivity(fakeSender, 7, {
        id: `c-${trigger}`,
        trigger,
        status: "running",
      });
      const banner = sent.find((p) => p.type === "compaction");
      expect(banner).toBeTruthy();
      // Dropped on purpose: one moment must not produce two activity rows.
      expect(normalizeChatActivityPayload(banner!)).toBeNull();
      // Distinct ids, so the two never collide in the atom.
      expect(banner!.id).not.toBe(sent.find((p) => p.type === "background")!.id);
    });
  }

  it("labels by phase, not by call site — which is how the three drifted", () => {
    const label = (args: Parameters<typeof emitCompactionActivity>[2]) => {
      sent.length = 0;
      emitCompactionActivity(fakeSender, 7, args);
      return String(sent.find((p) => p.type === "background")!.label);
    };
    expect(label({ id: "a", trigger: "automatic", status: "running" })).toBe(
      "Compressing context",
    );
    expect(label({ id: "a", trigger: "automatic", status: "done" })).toBe(
      "Context compressed",
    );
    // A completed run that found nothing to do must not claim it compressed.
    expect(label({ id: "a", trigger: "model", status: "done", noop: true })).toBe(
      "Context already compact",
    );
    expect(label({ id: "a", trigger: "model", status: "error" })).toBe(
      "Context compression failed",
    );
  });

  it("marks only the model trigger as model-initiated", () => {
    emitCompactionActivity(fakeSender, 7, { id: "a", trigger: "model", status: "done" });
    expect(sent[0]!.modelInitiated).toBe(true);
    sent.length = 0;
    emitCompactionActivity(fakeSender, 7, { id: "b", trigger: "automatic", status: "done" });
    expect(sent[0]!.modelInitiated).toBe(false);
  });

  it("carries the chat id on both events, so another chat's pill stays quiet", () => {
    emitCompactionActivity(fakeSender, 42, { id: "a", trigger: "automatic", status: "done" });
    expect(sent.every((p) => p.chatId === 42)).toBe(true);
  });

  it("omits detail rather than sending an empty string", () => {
    emitCompactionActivity(fakeSender, 7, { id: "a", trigger: "automatic", status: "done" });
    expect(sent.every((p) => !("detail" in p))).toBe(true);
  });
});

/**
 * A running leg and a done leg are ONE episode, and must leave ONE row.
 *
 * This file already existed and every test in it called the emitter ONCE — which
 * is exactly the gap that let the bug ship. Reported 2026-09-04: a finished
 * message carrying "Compressing context ✓" and "Context compressed ✓" stacked,
 * because the callers passed `${base}-run` and `${base}-done` (and the model path
 * minted a second `Date.now()`), and BOTH upsert layers key on the id alone.
 *
 * These rows persist into `session_messages.display_snapshot`, so a duplicate is
 * not transient clutter — it stays in the transcript.
 */
describe("a running+done pair collapses to one row", () => {
  /** Replay what the renderer does with the two payloads, in order. */
  function rowsFor(episodes: Array<{ id: string; detail?: string }>) {
    sent.length = 0;
    for (const ep of episodes) {
      emitCompactionActivity(fakeSender, 7, {
        id: ep.id,
        trigger: "automatic",
        status: "running",
        detail: "context at 92%",
      });
      emitCompactionActivity(fakeSender, 7, {
        id: ep.id,
        trigger: "automatic",
        status: "done",
        detail: ep.detail ?? "120000 → 40000 tokens",
      });
    }
    let items: ReturnType<typeof normalizeChatActivityPayload>[] = [];
    for (const payload of sent) {
      const item = normalizeChatActivityPayload(payload);
      if (item) items = upsertActivityStreamItem(items as never, item) as never;
    }
    return items.filter((i) => i && i.type === "background");
  }

  it("yields ONE activity row, ending in `done`", () => {
    const rows = rowsFor([{ id: "predispatch-compact-7-1000" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
  });

  it("yields ONE background card at the layer that PERSISTS", () => {
    // The activity atom is wiped at stream end; the thread is what gets frozen
    // into the display snapshot, so it has to collapse too.
    sent.length = 0;
    const id = "predispatch-compact-7-1000";
    emitCompactionActivity(fakeSender, 7, { id, trigger: "automatic", status: "running" });
    emitCompactionActivity(fakeSender, 7, {
      id,
      trigger: "automatic",
      status: "done",
      detail: "120000 → 40000 tokens",
    });

    let thread: unknown[] = [];
    for (const payload of sent) {
      const item = normalizeChatActivityPayload(payload);
      if (!item) continue;
      const threadItem = streamThreadItemFromActivity(item);
      if (threadItem) thread = upsertStreamThreadItem(thread as never, threadItem) as never;
    }
    const cards = (thread as Array<{ kind: string; status?: string; label?: string }>)
      .filter((t) => t.kind === "background");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("done");
    // The saving has to be in the LABEL: streamThreadItemFromActivity drops
    // `detail`, and AssistantMessageBody renders only `summary={item.label}`.
    expect(cards[0]!.label).toContain("120000 → 40000 tokens");
  });

  it("puts the saving in the done label, and keeps matching the pill's filter", () => {
    const rows = rowsFor([{ id: "e1", detail: "98000 → 31000 tokens" }]);
    const label = String(rows[0]!.label);
    expect(label).toBe("Context compressed · 98000 → 31000 tokens");
    // A label that stops matching this silently opts itself out of the pill AND
    // of useCompactionTokenVisuals.
    expect(/summariz|compress|compact/i.test(label)).toBe(true);
  });

  it("leaves the RUNNING label clean — the saving is not known yet", () => {
    sent.length = 0;
    emitCompactionActivity(fakeSender, 7, {
      id: "e1",
      trigger: "automatic",
      status: "running",
      detail: "context at 92%",
    });
    const bg = sent.find((p) => p.type === "background")!;
    expect(bg.label).toBe("Compressing context");
    // Still carried separately, because the pill renders it.
    expect(bg.detail).toBe("context at 92%");
  });

  it("TWO episodes in one turn still yield two rows", () => {
    // The negative control for the fix's warning: an id shared by construction
    // (chat + trigger) would collapse these into one and lose the first, and
    // mid-loop compaction really can fire twice in a long turn.
    const rows = rowsFor([
      { id: "midloop-compact-7-1000" },
      { id: "midloop-compact-7-2000" },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("an error leg replaces the running row rather than stacking", () => {
    sent.length = 0;
    emitCompactionActivity(fakeSender, 7, { id: "e1", trigger: "model", status: "running" });
    emitCompactionActivity(fakeSender, 7, {
      id: "e1",
      trigger: "model",
      status: "error",
      detail: "provider timeout",
    });
    let items: ReturnType<typeof normalizeChatActivityPayload>[] = [];
    for (const payload of sent) {
      const item = normalizeChatActivityPayload(payload);
      if (item) items = upsertActivityStreamItem(items as never, item) as never;
    }
    const rows = items.filter((i) => i && i.type === "background");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.label).toBe("Context compression failed");
  });
});
