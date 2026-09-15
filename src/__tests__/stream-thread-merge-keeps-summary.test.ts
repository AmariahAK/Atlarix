/**
 * A same-rank tool re-merge must not erase the summary.
 *
 * ══ THE CRASH THIS REPRODUCES ══
 *
 * Reported from the released v14.46.0 desktop app, mid-turn, after a long
 * stream with sub-agents running while files were being read:
 *
 *     TypeError: Cannot read properties of undefined (reading 'trim')
 *
 * caught by the ROUTE error boundary, which replaces the entire app with a
 * crash card. Not a boot failure — the app had been working for minutes.
 *
 * ══ THE MECHANISM, WHICH IS ORDINARY JAVASCRIPT ══
 *
 * `mergeToolItems`' equal-rank branch returned `{ ...prev, ...next, … }`.
 * Object spread copies an OWN property even when its value is `undefined`, so
 * `next.summary === undefined` does not fall through to `prev.summary` — it
 * ERASES it. Every other optional field on `next` was re-fixed by hand
 * immediately below the spread (`toolArgs`, `resultText`, `detail`, `expand`);
 * `summary` was the single omission, and it is the one the renderer calls
 * `.trim()` on.
 *
 * The rank-INCREASE branch never had the bug — it recomputes `summary` through
 * a full fallback chain. The asymmetry between the two branches is the whole
 * defect.
 *
 * ══ WHY IT TOOK A REAL SESSION TO FIND ══
 *
 * An equal-rank merge only happens when two calls to the SAME tool are in
 * flight at once. The crashing turn ran two parallel `run_command`s. One tool
 * at a time — every unit test until now, and most real use — takes the
 * rank-increase path and never touches the broken branch.
 *
 * The types do not help: `summary` is declared `string` on a `kind: "tool"`
 * item, so nothing about this is visible to `tsc`. The items are built by a
 * reducer from streamed events, and one of them handing over an explicit
 * `summary: undefined` satisfies the compiler and breaks the app.
 */

import { describe, expect, it } from "vitest";
import {
  upsertStreamThreadItem,
  type StreamThreadItem,
} from "@/lib/chat/stream-thread";

type ToolItem = Extract<StreamThreadItem, { kind: "tool" }>;

function toolItem(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "call_1",
    toolName: "run_command",
    summary: "Ran a command",
    status: "done",
    ts: 1_000,
    ...over,
  } as ToolItem;
}

/**
 * The merge is not exported, so it is driven the way the app drives it: append
 * the same tool id twice. Testing through the public reducer also means a
 * future refactor that moves the merge cannot quietly bypass this.
 */
function mergeThroughReducer(prev: ToolItem, next: ToolItem): ToolItem {
  const thread = upsertStreamThreadItem(upsertStreamThreadItem([], prev), next);
  const found = thread.find(
    (i): i is ToolItem => i.kind === "tool" && i.id === prev.id,
  );
  if (!found) throw new Error("the reducer dropped the tool item entirely");
  return found;
}

describe("an equal-rank re-merge", () => {
  it("KEEPS the summary when the newer item carries an explicit undefined", () => {
    // The headline. `{ ...prev, ...next }` copies `summary: undefined` over a
    // perfectly good string, and the renderer then calls `.trim()` on it.
    const merged = mergeThroughReducer(
      toolItem({ summary: "Ran a command" }),
      toolItem({ summary: undefined as unknown as string, ts: 2_000 }),
    );

    expect(merged.summary).toBe("Ran a command");
    // The actual property the crash was about: it must be callable.
    expect(() => merged.summary.trim()).not.toThrow();
  });

  it("keeps it when the key is absent rather than undefined", () => {
    // How it arrives after a JSON round trip through `displaySnapshot`:
    // `JSON.stringify` drops an undefined value, so the key is simply missing.
    const next = toolItem({ ts: 2_000 }) as Record<string, unknown>;
    delete next.summary;

    const merged = mergeThroughReducer(
      toolItem({ summary: "Ran a command" }),
      next as unknown as ToolItem,
    );
    expect(merged.summary).toBe("Ran a command");
  });

  it("still lets a real newer summary win", () => {
    // The guard must not freeze the first summary in place — a tool that
    // reports better detail as it goes has to be able to say so.
    const merged = mergeThroughReducer(
      toolItem({ summary: "Running…" }),
      toolItem({ summary: "Read 12 files", ts: 2_000 }),
    );
    expect(merged.summary).toBe("Read 12 files");
  });

  it("treats an empty summary as no summary", () => {
    // `||` rather than `??`, matching the rank-increase branch: an empty label
    // renders as a blank line, which is not better than the previous one.
    const merged = mergeThroughReducer(
      toolItem({ summary: "Ran a command" }),
      toolItem({ summary: "", ts: 2_000 }),
    );
    expect(merged.summary).toBe("Ran a command");
  });

  it("does not disturb the fields the branch already re-fixed", () => {
    const merged = mergeThroughReducer(
      toolItem({ detail: "old detail", resultText: "old result" }),
      toolItem({ ts: 2_000, detail: undefined, resultText: "new result" }),
    );
    expect(merged.detail).toBe("old detail");
    expect(merged.resultText).toBe("new result");
  });
});
