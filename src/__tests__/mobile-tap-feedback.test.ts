/**
 * Tap feedback: Android's `show_touches`, which is the emulator's answer to the
 * browser's injected AI cursor.
 *
 * This WRITES A SETTING on someone's device, so the behaviour that needs pinning
 * is not "does it turn on" but the restraint around it: once per device, on an
 * ACT and never a read, previous value captured, restored on quit, and silent
 * on every failure.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  ensureTapFeedback,
  restoreTapFeedback,
  tapFeedbackEnabledFor,
  setDeviceCliRunnerForTests,
} from "@/lib/mobile/device-tools";

const calls: string[][] = [];
let getOut = "null";
let putOk = true;

setDeviceCliRunnerForTests(async (cli, args) => {
  calls.push([cli, ...args]);
  if (args.includes("get")) {
    return { ok: true as const, stdout: getOut, buffer: Buffer.from("") };
  }
  if (args.includes("put") && !putOk) {
    return { ok: false as const, error: "settings put failed" };
  }
  return { ok: true as const, stdout: "", buffer: Buffer.from("") };
});

afterAll(() => setDeviceCliRunnerForTests(null));

beforeEach(async () => {
  await restoreTapFeedback();
  calls.length = 0;
  getOut = "null";
  putOk = true;
});

describe("tap feedback", () => {
  it("reads the previous value BEFORE writing", async () => {
    const note = await ensureTapFeedback("emulator-5554", "Pixel 7");
    const order = calls.map((c) => (c.includes("get") ? "get" : "put"));
    // Writing first would lose the value restore needs.
    expect(order).toEqual(["get", "put"]);
    expect(note).toMatch(/Tap feedback enabled on Pixel 7/);
    expect(note).toMatch(/Restored when Atlarix quits/);
  });

  it("is once per device — a second act says nothing and writes nothing", async () => {
    await ensureTapFeedback("emulator-5554", "Pixel 7");
    calls.length = 0;
    const second = await ensureTapFeedback("emulator-5554", "Pixel 7");
    expect(second).toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves a device that ALREADY had it on completely alone", async () => {
    getOut = "1";
    const note = await ensureTapFeedback("emulator-5554", "Pixel 7");
    // No note (we changed nothing) and no `put`.
    expect(note).toBeNull();
    expect(calls.some((c) => c.includes("put"))).toBe(false);
    // And restore must not turn OFF the user's own setting.
    calls.length = 0;
    await restoreTapFeedback();
    expect(calls).toEqual([]);
  });

  it("DELETES the key on restore when it was unset, rather than writing 'null'", async () => {
    // `settings get` prints "null" for an unset key. Writing that back would
    // leave a literal string "null" in the device's settings table.
    getOut = "null";
    await ensureTapFeedback("emulator-5554", "Pixel 7");
    calls.length = 0;
    await restoreTapFeedback();
    const restore = calls[0]!;
    expect(restore).toContain("delete");
    expect(restore).not.toContain("null");
  });

  it("restores a previous 0 as 0", async () => {
    getOut = "0";
    await ensureTapFeedback("emulator-5554", "Pixel 7");
    calls.length = 0;
    await restoreTapFeedback();
    expect(calls[0]!.slice(-2)).toEqual(["show_touches", "0"]);
  });

  it("stays silent when the write fails, and does not claim it worked", async () => {
    putOk = false;
    const note = await ensureTapFeedback("emulator-5554", "Pixel 7");
    expect(note).toBeNull();
    // Not recorded, so restore has nothing to undo — the alternative would
    // "restore" a setting that was never changed.
    expect(tapFeedbackEnabledFor("emulator-5554")).toBe(false);
  });

  it("restore is safe with nothing to restore, and is idempotent", async () => {
    await expect(restoreTapFeedback()).resolves.toBeUndefined();
    await ensureTapFeedback("emulator-5554", "Pixel 7");
    await restoreTapFeedback();
    calls.length = 0;
    await restoreTapFeedback();
    expect(calls).toEqual([]);
  });

  it("tracks devices independently", async () => {
    await ensureTapFeedback("emulator-5554", "Pixel 7");
    expect(tapFeedbackEnabledFor("emulator-5554")).toBe(true);
    expect(tapFeedbackEnabledFor("emulator-5556")).toBe(false);
    const note = await ensureTapFeedback("emulator-5556", "Pixel Tablet");
    expect(note).toMatch(/Pixel Tablet/);
  });
});
