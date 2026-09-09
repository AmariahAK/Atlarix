/**
 * The `uiautomator dump` parser and its rendering.
 *
 * This is the half of the mobile tools that can be tested without a device, and
 * it is the half that decides whether an agent can act at all: no refs, no taps.
 * The device half (`adb`/`simctl` invocation) needs a real emulator and is
 * verified by hand — see docs/TODO.md.
 *
 * The fixture is a trimmed real dump: single-line, attribute-only XML with
 * `bounds`, `resource-id`, `content-desc` and the flag attributes.
 */

import { describe, expect, it } from "vitest";
import {
  parseUiHierarchy,
  formatUiHierarchy,
  findUiElements,
} from "@/lib/mobile/ui-hierarchy";

const DEVICE = { label: "Pixel 7", platform: "android" };

const DUMP =
  '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' +
  // A layout container: no text, not interactive → pure token cost, dropped.
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.x" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" scrollable="false" long-clickable="false" bounds="[0,0][1080,2400]">' +
  '<node index="0" text="Sign in" resource-id="com.x:id/title" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" focusable="false" bounds="[100,300][980,380]" />' +
  '<node index="1" text="" resource-id="com.x:id/email" class="android.widget.EditText" content-desc="Email address" clickable="true" enabled="true" focusable="true" bounds="[100,500][980,620]" />' +
  '<node index="2" text="Continue" resource-id="com.x:id/submit" class="android.widget.Button" content-desc="" clickable="true" enabled="true" focusable="true" bounds="[100,700][980,820]" />' +
  '<node index="3" text="Forgot password?" resource-id="" class="android.widget.TextView" content-desc="" clickable="true" enabled="true" bounds="[100,900][500,960]" />' +
  // Zero-area node: a real dump contains these, and a tap on one goes nowhere.
  '<node index="4" text="hidden" resource-id="com.x:id/ghost" class="android.widget.Button" clickable="true" bounds="[0,0][0,0]" />' +
  "</node></hierarchy>";

describe("uiautomator dump → refs", () => {
  it("keeps the interactive nodes and drops layout containers", () => {
    const { elements } = parseUiHierarchy(DUMP);
    const names = elements.map((e) => e.name);
    expect(names).toContain("Email address");
    expect(names).toContain("Continue");
    expect(names).toContain("Forgot password?");
    // The FrameLayout has no text and no interactivity — nothing can refer to it.
    expect(elements.some((e) => e.role === "FrameLayout")).toBe(false);
  });

  it("drops zero-area nodes, which a tap would silently miss", () => {
    // The failure this prevents: `input tap 0 0` SUCCEEDS, nothing happens, and
    // the agent reads an unchanged screen and blames the app.
    const { elements } = parseUiHierarchy(DUMP);
    expect(elements.some((e) => e.name === "hidden")).toBe(false);
  });

  it("computes a centre point from bounds, not a corner", () => {
    const { elements } = parseUiHierarchy(DUMP);
    const submit = elements.find((e) => e.name === "Continue")!;
    expect(submit.center).toEqual({ x: 540, y: 760 });
  });

  it("prefers text, then content-desc, then the resource-id tail", () => {
    const { elements } = parseUiHierarchy(DUMP);
    // The EditText has no text, so its content-desc names it.
    expect(elements.find((e) => e.role === "EditText")?.name).toBe(
      "Email address",
    );
    // And it is marked editable so `action:"type"` is obviously applicable.
    expect(elements.find((e) => e.role === "EditText")?.editable).toBe(true);
  });

  it("includes non-interactive TEXT when asked for everything", () => {
    // resolveRef reads with interactiveOnly:false, because a ref handed out by a
    // filtered read must still resolve.
    const { elements } = parseUiHierarchy(DUMP, { interactiveOnly: false });
    expect(elements.map((e) => e.name)).toContain("Sign in");
  });

  it("assigns refs in document order so a ref means the same element twice", () => {
    const a = parseUiHierarchy(DUMP, { interactiveOnly: false, max: 500 });
    const b = parseUiHierarchy(DUMP, { interactiveOnly: false, max: 500 });
    expect(a.elements.map((e) => `${e.ref}:${e.name}`)).toEqual(
      b.elements.map((e) => `${e.ref}:${e.name}`),
    );
  });

  it("decodes XML entities in labels", () => {
    const xml =
      '<hierarchy><node text="Terms &amp; Conditions" class="android.widget.Button" clickable="true" bounds="[0,0][100,50]" /></hierarchy>';
    expect(parseUiHierarchy(xml).elements[0]?.name).toBe("Terms & Conditions");
  });

  it("reports the REAL total when capped, not just the cap", () => {
    // "12 elements" reads as the whole screen; "showing 12 of 40" does not.
    const many =
      "<hierarchy>" +
      Array.from(
        { length: 40 },
        (_, i) =>
          `<node text="Row ${i}" class="android.widget.Button" clickable="true" bounds="[0,${i * 60}][100,${i * 60 + 50}]" />`,
      ).join("") +
      "</hierarchy>";
    const parsed = parseUiHierarchy(many, { max: 12 });
    expect(parsed.elements).toHaveLength(12);
    expect(parsed.total).toBe(40);
    const out = formatUiHierarchy(parsed, DEVICE);
    expect(out).toContain("showing 12 of 40");
  });

  it("names the custom-surface case when nothing is found, rather than 'no elements'", () => {
    // A Flutter/game/video screen dumps nothing useful. An agent told only
    // "0 elements" retries; told WHY, it reaches for the screenshot.
    const out = formatUiHierarchy({ elements: [], total: 0 }, DEVICE);
    expect(out).toMatch(/screenshot/i);
    expect(out).toMatch(/own surface|Flutter/i);
  });

  it("tells the model refs are per-screen, in the read itself", () => {
    const out = formatUiHierarchy(parseUiHierarchy(DUMP), DEVICE);
    expect(out).toMatch(/THIS screen only/i);
    expect(out).toContain('action:"tap"');
  });

  it("ranks a plain-words query", () => {
    const { elements } = parseUiHierarchy(DUMP);
    expect(findUiElements(elements, "email field")[0]?.name).toBe(
      "Email address",
    );
    expect(findUiElements(elements, "continue")[0]?.name).toBe("Continue");
    expect(findUiElements(elements, "nothing here at all")).toEqual([]);
  });

  it("survives a dump that is not XML at all", () => {
    // adb prints device warnings to stdout; the tool slices from the first "<",
    // but a truncated dump must not throw.
    expect(parseUiHierarchy("").elements).toEqual([]);
    expect(parseUiHierarchy("<hierarchy><node bounds=").elements).toEqual([]);
  });
});
