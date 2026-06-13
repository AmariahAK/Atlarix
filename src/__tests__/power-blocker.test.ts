import { afterEach, describe, expect, it, vi } from "vitest";

/** Local electron mock — the shared setup doesn't stub powerSaveBlocker. */
const started = new Set<number>();
let nextId = 1;
vi.mock("electron", () => ({
  powerSaveBlocker: {
    start: vi.fn(() => {
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      started.delete(id);
    }),
    isStarted: vi.fn((id: number) => started.has(id)),
  },
}));

import {
  acquirePowerSaveBlocker,
  releasePowerSaveBlocker,
  resetPowerSaveBlocker,
} from "@/ipc/utils/power-blocker";

describe("power-blocker ref-counting", () => {
  afterEach(() => {
    resetPowerSaveBlocker();
    started.clear();
  });

  it("starts one blocker for N concurrent runs and stops only at zero", () => {
    acquirePowerSaveBlocker(); // run A
    acquirePowerSaveBlocker(); // run B
    acquirePowerSaveBlocker(); // run C
    expect(started.size).toBe(1); // single OS blocker for all three

    releasePowerSaveBlocker(); // A done
    releasePowerSaveBlocker(); // B done
    expect(started.size).toBe(1); // C still active → still held

    releasePowerSaveBlocker(); // C done
    expect(started.size).toBe(0); // last one out stops it
  });

  it("reset force-stops regardless of ref count (bulk abort/quit)", () => {
    acquirePowerSaveBlocker();
    acquirePowerSaveBlocker();
    expect(started.size).toBe(1);
    resetPowerSaveBlocker();
    expect(started.size).toBe(0);
  });

  it("never drops below zero on extra releases", () => {
    releasePowerSaveBlocker(); // no active runs — no-op, no throw
    expect(started.size).toBe(0);
    acquirePowerSaveBlocker();
    expect(started.size).toBe(1);
    releasePowerSaveBlocker();
    releasePowerSaveBlocker(); // extra release stays at zero
    expect(started.size).toBe(0);
  });
});
