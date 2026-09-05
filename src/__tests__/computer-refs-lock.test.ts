/**
 * Refs and the desk lock — the two things that keep five concurrent workers from
 * acting on each other's snapshots.
 *
 * The lock test is the one that matters. `ipc/utils/lock_utils.withLock` awaits only
 * the ONE lock it observed, so with three contenders B and C both wake on release
 * and both acquire — it serialises two callers, not N. `plan-artifacts.ts` documents
 * that exact bug; Atlarix runs up to five `task` workers per turn, so "serialises
 * two" is the bug, not a nuance. These tests use five.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  mintRefs,
  resolveRef,
  resetRefsForTests,
  refGenerationCountForTests,
  isDriverStaleError,
  explainDriverStaleError,
} from "@/lib/computer/refs";
import {
  withDesk,
  resetDeskLockForTests,
  deskLockStateForTests,
  DeskBusyError,
} from "@/lib/computer/desk-lock";

const el = (i: number) => ({
  role: "AXButton",
  label: `button ${i}`,
  frame: { x: i * 10, y: 20, w: 80, h: 24 },
  depth: 1,
  token: `tok-${i}`,
});

beforeEach(() => {
  resetRefsForTests();
  resetDeskLockForTests();
});

describe("refs", () => {
  it("mints d<gen>.<seq> and resolves back to the driver token", () => {
    const refs = mintRefs({ appKey: "com.slack", pid: 10, elements: [el(1), el(2)] });
    expect(refs.map((r) => r.ref)).toEqual(["d1.1", "d1.2"]);

    const found = resolveRef("d1.2");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // The token is what actually addresses the element. We never fall back to a
    // bare element_index: an index without its snapshot_id is the unsafe primitive.
    expect(found.element.token).toBe("tok-2");
    expect(found.pid).toBe(10);
  });

  it("rejects a ref shape that never came from a read", () => {
    const r = resolveRef("button 2");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/is not an element ref/i);
    // And it must close off the thing a model reaches for next.
    expect(r.error).toMatch(/no coordinate form/i);
  });

  it("keeps a few generations, so interleaved reads do not invalidate each other", () => {
    // A model legitimately reads app A, reads app B, then acts on A's ref. Holding
    // only the newest read would make that a stale-ref error when nothing about A
    // changed.
    mintRefs({ appKey: "a", pid: 1, elements: [el(1)] });
    mintRefs({ appKey: "b", pid: 2, elements: [el(1)] });
    mintRefs({ appKey: "a", pid: 1, elements: [el(1)] });
    expect(resolveRef("d1.1").ok).toBe(true);
    expect(resolveRef("d2.1").ok).toBe(true);
    expect(resolveRef("d3.1").ok).toBe(true);
  });

  it("evicts the oldest generation per app, and says which reads are live", () => {
    for (let i = 0; i < 5; i++) mintRefs({ appKey: "a", pid: 1, elements: [el(i)] });
    // Three kept per app.
    expect(refGenerationCountForTests()).toBe(3);
    const gone = resolveRef("d1.1");
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error).toMatch(/no longer held/i);
    expect(gone.error).toMatch(/current reads: /i);
    // Category 4: re-reading IS the fix, so it must not say "do not retry" — only
    // that repeating THIS call is pointless.
    expect(gone.error).not.toMatch(/do not retry\b(?!.*same ref)/i);
    expect(gone.error).toMatch(/re-read/i);
    expect(gone.error).toMatch(/same ref/i);
  });

  it("names the count when a ref is absent from a read that DOES exist", () => {
    mintRefs({ appKey: "a", pid: 1, elements: [el(1), el(2)] });
    const r = resolveRef("d1.99");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not in read 1, which had 2 elements/i);
  });
});

describe("translating the driver's own stale error", () => {
  it("recognises the driver's staleness vocabulary", () => {
    expect(isDriverStaleError("element_token is stale")).toBe(true);
    expect(isDriverStaleError("superseded by a newer snapshot")).toBe(true);
    expect(isDriverStaleError("window_id_not_found")).toBe(false);
  });

  it("keeps the CAUSE and replaces the ADVICE", () => {
    const msg = explainDriverStaleError("d3.7", "element_token stale: snapshot 12 superseded");
    // The driver's message is accurate and useless to a model: it talks about
    // snapshots and tokens, neither of which the model has seen. Same lesson as
    // the browser tool's "Illegal invocation", which cost three turns by naming a
    // JavaScript invariant instead of an action.
    expect(msg).toMatch(/re-read the window/i);
    expect(msg).toMatch(/do not repeat this call with the same ref/i);
    // It must NOT claim the action happened, and must say it was refused rather
    // than applied to whatever is now there.
    expect(msg).toMatch(/refused/i);
    expect(msg).toContain("d3.7");
  });
});

describe("the desk lock", () => {
  it("serialises four admitted contenders strictly, and refuses the fifth", async () => {
    const enters: number[] = [];
    const exits: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = [1, 2, 3, 4, 5].map((n) =>
      withDesk(`task ${n}`, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        enters.push(n);
        expect(deskLockStateForTests().holder).toBe(`task ${n}`);
        await new Promise((r) => setTimeout(r, 5));
        exits.push(n);
        concurrent--;
      }),
    );

    const results = await Promise.allSettled(tasks);
    const ran = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof DeskBusyError,
    ).length;

    // EXACT, not "at least one": `ran >= 1` would pass with a completely broken
    // lock that only ever admitted the first caller. The cap is holder + 3.
    expect(ran).toBe(4);
    expect(refused).toBe(1);

    // THE ASSERTION THAT CATCHES THE withLock BUG: with that helper, B and C both
    // wake on A's release and both acquire, so this would be 2.
    expect(maxConcurrent).toBe(1);

    // FIFO: admitted in call order, and each finishes before the next starts.
    expect(enters).toEqual([1, 2, 3, 4]);
    expect(exits).toEqual([1, 2, 3, 4]);
  });

  it("refuses past the depth cap with a message that says nothing was done", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = withDesk("holder", () => held);
    // Fill the queue: the holder plus three queued is the cap.
    const queued = [1, 2, 3].map((n) => withDesk(`q${n}`, async () => {}));
    // One more must be refused outright rather than queued forever — a hang is
    // worse than a refusal, because the user sees nothing and the model learns
    // nothing.
    await expect(withDesk("overflow", async () => {})).rejects.toBeInstanceOf(DeskBusyError);
    await expect(withDesk("overflow2", async () => {})).rejects.toThrow(/Nothing was done/i);
    release();
    await first;
    await Promise.all(queued);
  });

  it("advances the chain even when a holder throws", async () => {
    // `.then(fn, fn)` in the chain: one caller's rejection must not strand every
    // later one.
    await expect(
      withDesk("boom", async () => {
        throw new Error("action failed");
      }),
    ).rejects.toThrow("action failed");
    await expect(withDesk("after", async () => "ok")).resolves.toBe("ok");
    expect(deskLockStateForTests().inFlight).toBe(0);
  });

  it("unwinds on abort rather than holding the turn open", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = withDesk("holder", () => held);

    const ac = new AbortController();
    const waiter = withDesk("waiter", async () => "never", ac.signal);
    ac.abort();
    await expect(waiter).rejects.toThrow(/cancelled/i);

    release();
    await holder;
  });

  it("releases the holder slot when the action finishes", async () => {
    await withDesk("one", async () => {});
    expect(deskLockStateForTests().holder).toBeNull();
    expect(deskLockStateForTests().inFlight).toBe(0);
  });
});
