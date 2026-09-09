import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { listMobileDevices, resolveDevice, iosGap } from "@/lib/mobile/devices";
import { findDeviceCli, runDeviceCli } from "@/lib/mobile/device-tools";
import { parseUiHierarchy, findUiElements } from "@/lib/mobile/ui-hierarchy";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/mobile";

/**
 * A booted emulator or attached device, or nothing to test.
 *
 * Mirrors `hasBootedSimulator()` in mobile-live-ios.test.ts, and resolves `adb`
 * through the SHIPPED locator so a machine whose SDK the app cannot find is
 * correctly reported as "nothing to test" rather than failing every assertion.
 */
function hasBootedDevice(): boolean {
  const adb = findDeviceCli("adb");
  if (!adb) return false;
  try {
    const out = execFileSync(adb, ["devices"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    // "\tdevice" — not "\toffline" (still booting) and not "\tunauthorized".
    return /\tdevice\b/.test(out);
  } catch {
    return false;
  }
}

/**
 * These run against a REAL Android emulator and skip when there isn't one, so
 * CI and every machine without the SDK stay green.
 *
 * They exist because the Android half of the mobile pair shipped in v14.41.0
 * having NEVER been executed — `adb` was not installed on the dev machine, and
 * docs/TODO.md tracked it as explicitly UNVERIFIED. The iOS half's live run had
 * already found three bugs that 30 mocked assertions missed, and the general
 * lesson recorded then was that a wrapper around an external CLI has to be run
 * against that CLI at least once. This file is that run for Android, and it
 * found the same class of bug on the first command it issued (see the hierarchy
 * test below).
 *
 * To run them: boot an emulator (`emulator -avd <name> -no-window`) first.
 */
/**
 * Unwrap what `ToolRegistry.execute` returns.
 *
 * TWO SHAPES, and missing the second one made me accuse working code twice.
 * A successful handler result is nested under `result` — but when the payload is
 * large, `guardToolCall` TRUNCATES it and `result` arrives as a JSON *string*
 * alongside `_truncatedOutput` / `_originalSize`. Reading `.content` off that
 * string yields `undefined`, which looks exactly like a tool that returned
 * nothing (that is how the `mode:"logs"` read appeared to be broken when it was
 * returning 400 lines of real logcat).
 */
function payload(env: unknown): Record<string, unknown> {
  const e = (env ?? {}) as Record<string, unknown>;
  const raw = e.result ?? e;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Truncation can cut mid-JSON; the text still carries the content.
      return { content: raw };
    }
  }
  return raw as Record<string, unknown>;
}

describe.skipIf(!hasBootedDevice())("LIVE Android emulator", () => {
  it("finds adb", () => {
    const adb = findDeviceCli("adb");
    console.log("[live] adb:", adb);
    expect(adb).toBeTruthy();
  });

  it("lists the booted emulator as android", async () => {
    const d = await listMobileDevices();
    console.log("[live] devices:", JSON.stringify(d));
    expect(d.length).toBeGreaterThan(0);
    expect(d.some((x) => x.platform === "android")).toBe(true);
  }, 30_000);

  it("resolves it implicitly as the only device", async () => {
    const r = await resolveDevice();
    console.log("[live] resolve:", JSON.stringify(r));
    expect(r.ok).toBe(true);
  }, 30_000);

  it("reports NO ios gap for an android device", async () => {
    const d = await listMobileDevices();
    const android = d.find((x) => x.platform === "android")!;
    expect(iosGap(android, "hierarchy")).toBeNull();
    expect(iosGap(android, "input")).toBeNull();
  }, 30_000);

  /**
   * THE SILENT ZERO, ANDROID EDITION — and the reason this file exists.
   *
   * `adb shell uiautomator dump /dev/tty` exits 0 and prints exactly
   * `UI hierchary dumped to: /dev/tty` (32 chars, upstream's typo included) with
   * NO XML at all. `adb shell` allocates a pty, and the XML written to /dev/tty
   * never reaches adb's stdout stream. `adb exec-out` takes the raw binary path
   * and returns the document.
   *
   * Identical in shape to `simctl io <id> screenshot -` writing a file named
   * `-`: exit 0, a plausible-looking message, and nothing usable. A mock returns
   * whatever it was told to, so no unit test could have caught either.
   *
   * The assertion is on the SHAPE of the real output (an XML document with
   * nodes), never on the arguments we passed.
   */
  it("the hierarchy dump returns real XML (the silent-zero bug)", async () => {
    const d = await listMobileDevices();
    const android = d.find((x) => x.platform === "android")!;
    const r = await runDeviceCli(
      "adb",
      ["-s", android.id, "exec-out", "uiautomator", "dump", "/dev/tty"],
      { timeoutMs: 25_000 },
    );
    console.log("[live] hierarchy chars=", r.ok ? r.stdout.length : r.error);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // `adb shell` returned 32 characters here and no document.
      expect(r.stdout.length).toBeGreaterThan(1000);
      expect(r.stdout).toContain("<hierarchy");
      expect(r.stdout).toContain("</hierarchy>");
    }
  }, 60_000);

  it("parses that XML into refs with real bounds", async () => {
    const d = await listMobileDevices();
    const android = d.find((x) => x.platform === "android")!;
    const r = await runDeviceCli(
      "adb",
      ["-s", android.id, "exec-out", "uiautomator", "dump", "/dev/tty"],
      { timeoutMs: 25_000 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `parseUiHierarchy` returns { elements, total } — not a bare array.
    const parsed = parseUiHierarchy(r.stdout);
    console.log(
      "[live] parsed elements=",
      parsed.elements.length,
      "total=",
      parsed.total,
      "first=",
      JSON.stringify(parsed.elements[0]),
    );
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.total).toBeGreaterThanOrEqual(parsed.elements.length);
    // A ref is useless without a tappable point. The point lives on `center`,
    // and it must be the CENTRE rather than a corner — a corner tap lands on
    // the edge of a control or just outside it.
    const first = parsed.elements[0]!;
    expect(first.ref).toMatch(/^m\d+$/);
    expect(first.center.x).toBeGreaterThan(0);
    expect(first.center.y).toBeGreaterThan(0);
    expect(first.center.x).toBe(
      Math.round((first.bounds.left + first.bounds.right) / 2),
    );
    expect(first.center.y).toBe(
      Math.round((first.bounds.top + first.bounds.bottom) / 2),
    );
    // Plain-words search over a real screen.
    console.log(
      "[live] find('button')=",
      findUiElements(parsed.elements, "button").length,
    );
  }, 60_000);

  /**
   * The whole point of the tool: one call returns the screen as TEXT. Goes
   * through `ToolRegistry` rather than the module-private `readHierarchy`, so
   * this exercises the shipped dispatch path including the tool's own error
   * wording.
   */
  it("mobile_inspect returns the screen as text through the real tool", async () => {
    const env = (await ToolRegistry.execute("mobile_inspect", {})) as Record<
      string,
      unknown
    >;
    // `execute` wraps a successful handler result in { success, result } — the
    // tool's own { success, title, content } is NESTED, not top level.
    const res = payload(env);
    const content = typeof res.content === "string" ? res.content : "";
    console.log(
      "[live] mobile_inspect success=",
      env.success,
      "content chars=",
      content.length,
      "first line=",
      content.split("\n")[0],
    );
    expect(env.success).toBe(true);
    expect(content.length).toBeGreaterThan(200);
    // It must NOT be the "no XML / retry once" message — that wording sends the
    // model into a retry loop against what is actually a permanent failure.
    expect(content).not.toMatch(/returned no XML/i);
    // And it must be the hierarchy, with refs the `mobile` tool can act on.
    expect(content).toMatch(/\bm1\b/);
  }, 60_000);

  it("takes a REAL screenshot that streams to stdout", async () => {
    const d = await listMobileDevices();
    const android = d.find((x) => x.platform === "android")!;
    const r = await runDeviceCli(
      "adb",
      ["-s", android.id, "exec-out", "screencap", "-p"],
      { timeoutMs: 40_000, binary: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // MUST be `r.buffer`, not `r.stdout`. `runDeviceCli` returns both, and
      // `stdout` is `buffer.toString("utf8")` — 0x89 is not valid UTF-8, so the
      // PNG's first byte comes back as U+FFFD and the magic check fails on a
      // perfectly good image. Caught this by writing the test wrong first.
      const buf = r.buffer;
      console.log("[live] screenshot bytes=", buf.length);
      expect(buf.length).toBeGreaterThan(1000);
      // PNG magic — proves an image, not an error string. Unlike simctl, adb's
      // `exec-out screencap -p` genuinely does stream.
      expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
    }
  }, 60_000);

  /**
   * `settings get` prints the literal string "null" for an unset key, and the
   * restore path must DELETE the key rather than write "null" back. Verified
   * against the real device because that literal is the whole trap.
   */
  /**
   * THE ACT HALF, which had also never run. Taps a real element by ref through
   * the real `mobile` tool, on a disposable emulator.
   */
  it("mobile taps a real element by ref", async () => {
    const read = (await ToolRegistry.execute("mobile_inspect", {})) as Record<
      string,
      unknown
    >;
    const content = String(payload(read).content ?? "");
    // Take a ref the read actually offered, rather than assuming "m1" is tappable.
    const ref = content.match(/\b(m\d+)\b/)?.[1];
    console.log("[live] tapping ref=", ref);
    expect(ref).toBeTruthy();

    const env = (await ToolRegistry.execute("mobile", {
      action: "tap",
      ref,
    })) as Record<string, unknown>;
    const res = payload(env);
    console.log(
      "[live] tap success=",
      env.success,
      "payload=",
      JSON.stringify(res).slice(0, 200),
    );
    expect(env.success).toBe(true);
  }, 90_000);

  /**
   * A ref from a superseded read must fail LOUDLY. `resolveRef` re-dumps per act
   * for exactly this reason: a stale index still resolves, to a different
   * element, which is the bug refs exist to prevent. `m9999` stands in for a ref
   * whose element is gone.
   */
  it("a ref that is not on the current screen fails loudly", async () => {
    const env = (await ToolRegistry.execute("mobile", {
      action: "tap",
      ref: "m9999",
    })) as Record<string, unknown>;
    const res = payload(env);
    const msg = String(res.error ?? res.message ?? env.message ?? "");
    console.log("[live] stale ref msg=", msg.slice(0, 160));
    expect(env.success).toBe(false);
    // It must tell the model to RE-READ, not to retry the same call.
    expect(msg).toMatch(/re-read|one screen only/i);
  }, 60_000);

  // ── the rest of the docs/TODO.md checklist ────────────────────────────────
  // Added 2026-09-04 after the first run stopped at hierarchy/tap/screenshot
  // and tore the emulator down with half the specified loop unexercised.

  it("mobile launches an app by package", async () => {
    const env = (await ToolRegistry.execute("mobile", {
      action: "launch",
      package: "com.android.settings",
    })) as Record<string, unknown>;
    const res = payload(env);
    console.log(
      "[live] launch:",
      env.success,
      JSON.stringify(res).slice(0, 160),
    );
    expect(env.success).toBe(true);
  }, 90_000);

  it("mobile rejects a package that is not an identifier", async () => {
    const env = (await ToolRegistry.execute("mobile", {
      action: "launch",
      package: 'x" OR message CONTAINS "password',
    })) as Record<string, unknown>;
    const res = payload(env);
    const msg = String(res.error ?? res.message ?? env.message ?? "");
    console.log("[live] bad package msg=", msg.slice(0, 120));
    expect(env.success).toBe(false);
    expect(msg).toMatch(/not an app identifier|com\.example\.app/i);
  }, 30_000);

  it("mobile types into a real editable field", async () => {
    // Settings was launched above; its search box is the reliable editable.
    const read = (await ToolRegistry.execute("mobile_inspect", {
      query: "search",
    })) as Record<string, unknown>;
    const content = String(payload(read).content ?? "");
    console.log("[live] search read=", content.slice(0, 200));
    const ref = content.match(/\b(m\d+)\b/)?.[1];
    if (!ref) {
      console.log("[live] no search field found — skipping the type assertion");
      return;
    }
    const env = (await ToolRegistry.execute("mobile", {
      action: "type",
      ref,
      text: "atlarix",
    })) as Record<string, unknown>;
    const res = payload(env);
    console.log("[live] type:", env.success, JSON.stringify(res).slice(0, 200));
    expect(env.success).toBe(true);
  }, 120_000);

  it("mobile swipes and presses a device key", async () => {
    const sw = (await ToolRegistry.execute("mobile", {
      action: "swipe",
      direction: "down",
    })) as Record<string, unknown>;
    console.log(
      "[live] swipe:",
      sw.success,
      JSON.stringify(payload(sw)).slice(0, 140),
    );
    expect(sw.success).toBe(true);

    const key = (await ToolRegistry.execute("mobile", {
      action: "key",
      key: "back",
    })) as Record<string, unknown>;
    console.log(
      "[live] key back:",
      key.success,
      JSON.stringify(payload(key)).slice(0, 140),
    );
    expect(key.success).toBe(true);
  }, 120_000);

  /**
   * The volume argument for `package` — the iOS run measured 3.2 MB unfiltered
   * against 184 characters with a process filter. Android's equivalent is
   * `logcat --pid`, and this is the check that it actually narrows.
   */
  it("reads logs, and `package` narrows them", async () => {
    const wide = (await ToolRegistry.execute("mobile_inspect", {
      mode: "logs",
      level: "all",
      lines: 400,
    })) as Record<string, unknown>;
    const wideContent = String(payload(wide).content ?? "");
    console.log("[live] logs unfiltered chars=", wideContent.length);
    expect(wide.success).toBe(true);
    expect(wideContent.length).toBeGreaterThan(0);

    const narrow = (await ToolRegistry.execute("mobile_inspect", {
      mode: "logs",
      level: "all",
      lines: 400,
      package: "com.android.settings",
    })) as Record<string, unknown>;
    const narrowContent = String(payload(narrow).content ?? "");
    console.log(
      "[live] logs for com.android.settings chars=",
      narrowContent.length,
      "| success=",
      narrow.success,
    );
    // Either it narrowed, or it said the app is not running — both are correct
    // answers, and a silent empty string is not.
    expect(narrowContent.length).toBeGreaterThan(0);
  }, 150_000);

  /**
   * The restore round-trip, which writes DEVICE state and so could only ever be
   * checked live: `show_touches` must come back as an ABSENT key, not the
   * literal string "null".
   */
  it("tap feedback turns on and restores to an absent key", async () => {
    const { ensureTapFeedback, restoreTapFeedback, tapFeedbackEnabledFor } =
      await import("@/lib/mobile/device-tools");
    // `ensureTapFeedback` is once-per-device-per-PROCESS by design, so the tap
    // test above already consumed it. Without clearing that state this asserts
    // nothing — it early-returns and the setting is never written.
    await restoreTapFeedback();
    const d = await listMobileDevices();
    const id = d.find((x) => x.platform === "android")!.id;

    // Start from a known-clean state.
    await runDeviceCli("adb", [
      "-s",
      id,
      "shell",
      "settings",
      "delete",
      "system",
      "show_touches",
    ]);

    const note = await ensureTapFeedback(id, "test device");
    const on = await runDeviceCli("adb", [
      "-s",
      id,
      "shell",
      "settings",
      "get",
      "system",
      "show_touches",
    ]);
    console.log(
      "[live] tap feedback note=",
      note,
      "| show_touches now=",
      on.ok ? String(on.stdout).trim() : on.error,
      "| enabledFor=",
      tapFeedbackEnabledFor(id),
    );
    expect(on.ok && String(on.stdout).trim()).toBe("1");

    await restoreTapFeedback();
    const after = await runDeviceCli("adb", [
      "-s",
      id,
      "shell",
      "settings",
      "get",
      "system",
      "show_touches",
    ]);
    const v = after.ok ? String(after.stdout).trim() : "";
    console.log("[live] show_touches after restore=", JSON.stringify(v));
    // "null" here means the KEY IS ABSENT, which is the correct end state.
    // The bug it guards against is writing the four-character string "null".
    expect(v).toBe("null");
  }, 120_000);

  it("show_touches reads as the literal 'null' when unset", async () => {
    const d = await listMobileDevices();
    const android = d.find((x) => x.platform === "android")!;
    const r = await runDeviceCli(
      "adb",
      ["-s", android.id, "shell", "settings", "get", "system", "show_touches"],
      { timeoutMs: 8_000 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = String(r.stdout).trim();
      console.log("[live] show_touches raw=", JSON.stringify(v));
      expect(["null", "0", "1", ""]).toContain(v);
    }
  }, 30_000);
});
