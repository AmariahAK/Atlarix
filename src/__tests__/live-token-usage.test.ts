import { describe, it, expect } from "vitest";
import {
  growLiveOutput,
  type LiveUsageCheckpoint,
} from "@/lib/chat/live-token-usage";

// WS5: the meter must keep climbing between real per-step checkpoints instead of
// freezing once the first real usage arrives, and never dip.
describe("growLiveOutput (live token meter)", () => {
  it("before the first checkpoint, output tracks the cumulative estimate", () => {
    expect(
      growLiveOutput({ cur: undefined, checkpoint: undefined, estOutput: 100 }),
    ).toBe(100);
    expect(
      growLiveOutput({
        cur: { input: null, output: 100 },
        checkpoint: undefined,
        estOutput: 250,
      }),
    ).toBe(250);
  });

  it("keeps growing AFTER a real checkpoint (the freeze bug fix)", () => {
    // Step 1 committed 400 real output at estimate baseline 380.
    const cp: LiveUsageCheckpoint = { realOutput: 400, estBase: 380 };
    // Step 2 streaming: cumulative estimate climbs past the baseline → the meter
    // grows = confirmed step output + the current step's delta.
    expect(
      growLiveOutput({
        cur: { input: 12_000, output: 400 },
        checkpoint: cp,
        estOutput: 500,
      }),
    ).toBe(400 + (500 - 380)); // 520
    expect(
      growLiveOutput({
        cur: { input: 12_000, output: 520 },
        checkpoint: cp,
        estOutput: 640,
      }),
    ).toBe(400 + (640 - 380)); // 660
  });

  it("never dips on estimate jitter (floored at the current value)", () => {
    const cp: LiveUsageCheckpoint = { realOutput: 400, estBase: 380 };
    // A momentarily smaller estimate must not reduce the meter.
    expect(
      growLiveOutput({
        cur: { input: 12_000, output: 660 },
        checkpoint: cp,
        estOutput: 300, // below estBase
      }),
    ).toBe(660);
  });
});
