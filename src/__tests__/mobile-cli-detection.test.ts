/**
 * Locating `adb` / `xcrun`, and the fact that it happens ONCE.
 *
 * The memoization is the point of the module. An agent driving an emulator makes
 * tens of tool calls per turn, and `which adb` per call is a process spawn to
 * answer a question whose answer cannot change mid-session. That is latency the
 * user feels, for nothing — so this asserts the cache exists rather than trusting
 * the comment that says so.
 *
 * Deliberately NOT mocked: the thing under test is the lookup itself. It runs
 * against whatever this machine has, so it asserts on the SHAPE of the answer
 * (a path or null, consistently) rather than on adb being installed.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs";
import {
  findDeviceCli,
  resetDeviceToolCacheForTests,
  missingCliMessage,
  quoteForDeviceShell,
  isValidPackageId,
} from "@/lib/mobile/device-tools";

beforeEach(() => {
  resetDeviceToolCacheForTests();
});

describe("device CLI detection", () => {
  it("returns an absolute path or null, never a bare name", () => {
    // A bare "adb" would be spawned through the PATH of whatever environment
    // Electron inherited, which on macOS is NOT the user's shell PATH.
    const adb = findDeviceCli("adb");
    expect(
      adb === null || adb.startsWith("/") || /^[A-Za-z]:\\/.test(adb),
    ).toBe(true);
  });

  it("answers the same way twice, and touches the filesystem only once", () => {
    // Observed through `fs.existsSync`, which every branch of the lookup calls:
    // a cached answer must do ZERO filesystem work. Asserting only that the two
    // answers match would pass just as happily with no cache at all.
    const spy = vi.spyOn(fs, "existsSync");
    const first = findDeviceCli("adb");
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = findDeviceCli("adb");
    const third = findDeviceCli("adb");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });

  it("caches a NEGATIVE result too", () => {
    // The easy bug: `if (cached) return cached` treats null as "not looked up
    // yet", so a machine WITHOUT adb pays the failed lookup on every call —
    // exactly the case where the spawn is pure waste. The cache is keyed on
    // `undefined`, not falsiness.
    resetDeviceToolCacheForTests();
    const a = findDeviceCli("xcrun");
    const b = findDeviceCli("xcrun");
    expect(b).toBe(a);
    if (process.platform !== "darwin") {
      expect(a).toBeNull();
    }
  });

  it("does not look for xcrun off macOS", () => {
    if (process.platform === "darwin") {
      expect(findDeviceCli("xcrun")).toBe("/usr/bin/xcrun");
    } else {
      expect(findDeviceCli("xcrun")).toBeNull();
    }
  });

  it("the missing-CLI message says what to install and not to work around it", () => {
    // An agent that reads "not found" and nothing else tries `sudo apt install`
    // or writes its own tap script. The message has to close that door.
    const adb = missingCliMessage("adb");
    expect(adb).toMatch(/platform-tools|ANDROID_HOME/);
    expect(adb).toMatch(/tell the user/i);
    expect(missingCliMessage("xcrun")).toMatch(/xcode|macOS-only/i);
  });

  it("reset actually clears, so one test cannot poison the next", () => {
    const before = findDeviceCli("adb");
    resetDeviceToolCacheForTests();
    expect(findDeviceCli("adb")).toBe(before);
  });
});

/**
 * `adb shell` runs its joined arguments through `/system/bin/sh -c` ON THE
 * DEVICE. `execFile` with an argv array stops a LOCAL shell and does nothing
 * about the far one — so text the agent types has to be quoted for it.
 *
 * Why this is worth a test rather than a comment: the string is not always the
 * model's own words. An agent types what it READ — a page, a file, a fixture it
 * was asked to replay — which makes this the path by which prompt-injected
 * content would reach a device shell. It is not an escalation of what the agent
 * MAY do (it could call `adb` through run_command), it is about content it
 * merely handled.
 */
describe("quoting for the device shell", () => {
  it("neutralises a command separator", () => {
    const q = quoteForDeviceShell("hello; rm -rf /sdcard/x");
    // Wrapped whole, so the device shell sees one argument.
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
    // The `;` is inside the quotes, so it is text and not a separator.
    expect(q).toBe("'hello; rm -rf /sdcard/x'");
  });

  it("survives an embedded single quote", () => {
    // The classic hole: a naive `'…'` wrap lets `'` close the quote early and
    // everything after it becomes shell syntax again.
    const q = quoteForDeviceShell("it's fine");
    // POSIX: close the quote, emit an escaped quote, reopen. Anything simpler
    // lets the `'` end the quoting early and turns the tail back into syntax.
    expect(q).toBe(`'it'\\''s fine'`);
  });

  it("neutralises backticks, $(), and newlines", () => {
    for (const payload of ["`id`", "$(id)", "a\nid", "&& id", "| id"]) {
      const q = quoteForDeviceShell(payload);
      expect(q.startsWith("'") && q.endsWith("'"), payload).toBe(true);
      expect(q.slice(1, -1)).toBe(payload);
    }
  });

  it("leaves a literal percent alone, which adb's %s trick did not", () => {
    // The previous approach replaced spaces with `%s` (adb's substitution),
    // which mangles any real percent in the user's text. Quoting does not.
    expect(quoteForDeviceShell("100% done")).toBe("'100% done'");
  });

  it("package ids are VALIDATED, not quoted", () => {
    // A weird package id is a model mistake worth reporting, not a string to
    // pass through carefully.
    expect(isValidPackageId("com.example.app")).toBe(true);
    expect(isValidPackageId("com.example.app-debug")).toBe(true);
    expect(isValidPackageId("MyApp_2")).toBe(true);
    expect(isValidPackageId("com.example.app; id")).toBe(false);
    expect(isValidPackageId("`id`")).toBe(false);
    expect(isValidPackageId("../../etc/passwd")).toBe(false);
    expect(isValidPackageId("")).toBe(false);
    expect(isValidPackageId(".leading")).toBe(false);
    expect(isValidPackageId("a".repeat(256))).toBe(false);
  });
});

/**
 * The identifier check is the boundary for TWO call sites, not one.
 *
 * Found by the v14.41.0 release security review: `mode:"logs"` interpolated its
 * `package` straight into an iOS NSPredicate (`process CONTAINS "…"`), while
 * `action:"launch"` validated the same kind of value and the Android logs path
 * quoted it. Three call sites, three different treatments — and the one that did
 * neither was the one reaching an expression evaluator.
 *
 * `.split(".").pop()` was standing in for a sanitiser there, which it is not: a
 * payload containing no dot passes through unchanged.
 */
describe("package identifiers as an injection boundary", () => {
  it("rejects the predicate-injection payload", () => {
    // Would have produced: process CONTAINS "x" OR message CONTAINS "password"
    expect(isValidPackageId('x" OR message CONTAINS "password')).toBe(false);
  });

  it("rejects every NSPredicate and shell metacharacter that matters", () => {
    for (const bad of [
      'a"b',
      "a\\b",
      "a'b",
      "a b",
      "a;b",
      "a&&b",
      "a|b",
      "a$b",
      "a`b`",
      "a\nb",
      "FUNCTION(self,'x')",
      "*",
    ]) {
      expect(isValidPackageId(bad), bad).toBe(false);
    }
  });

  it("`.split('.').pop()` does not make a payload safe — the reason validation replaced it", () => {
    // The old iOS path applied only this. A dotless payload survives it whole.
    const payload = 'x" OR message CONTAINS "secret';
    expect(payload.split(".").pop()).toBe(payload);
    expect(isValidPackageId(payload.split(".").pop()!)).toBe(false);
  });

  it("still accepts the identifiers people actually pass", () => {
    for (const ok of [
      "com.example.app",
      "com.example.app-debug",
      "com.example.app_v2",
      "MyApp2",
      "a",
    ]) {
      expect(isValidPackageId(ok), ok).toBe(true);
    }
  });
});
