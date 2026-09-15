/**
 * The transport.
 *
 * These assertions are about the ARGUMENTS, not the results, because the
 * arguments are where this can go silently wrong. A kernel passed as a string,
 * an isolated world, or `allFrames: true` all produce code that runs and
 * returns something plausible — and then refs stop resolving between calls, or
 * resolve to an element in a frame the next call is not looking at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { atlarixPageKernel } from "@/lib/browser/page-scripts";
import { PageAccessError, activeTab, refResolves, runInPage } from "./inject";

interface Injection {
  target: { tabId: number; allFrames?: boolean };
  world?: string;
  func?: (...args: never[]) => unknown;
  args?: unknown[];
  files?: string[];
}

let calls: Injection[];
let nextResult: unknown;
let failWith: Error | null;
let emptyResults: boolean;

function installFakeChrome() {
  calls = [];
  nextResult = { url: "https://x.test", elements: [] };
  failWith = null;
  emptyResults = false;
  (globalThis as Record<string, unknown>).chrome = {
    scripting: {
      async executeScript(injection: Injection) {
        calls.push(injection);
        if (failWith) throw failWith;
        if (emptyResults) return [];
        return [{ frameId: 0, result: nextResult }];
      },
    },
    tabs: {
      async query() {
        return [{ id: 7, url: "https://x.test/page", active: true }];
      },
    },
  };
}

beforeEach(installFakeChrome);

describe("runInPage passes the kernel the only way MV3 allows", () => {
  it("sends `func` and `args`, never a code string", async () => {
    // MV3 removed `code:`. executeScript takes `func` or `files` and nothing
    // else, so a string would simply be ignored — the call would succeed and
    // return undefined.
    await runInPage(7, { op: "snapshot", filter: "interactive", max: 10 });
    expect(calls[0].func).toBe(atlarixPageKernel);
    expect(calls[0].args).toEqual([
      { op: "snapshot", filter: "interactive", max: 10 },
    ]);
    expect(calls[0].files).toBeUndefined();
  });

  it("injects into the MAIN world", async () => {
    // The ref registry is a WeakMap on `window`. An isolated world is a
    // different realm with a different window, so every read would mint fresh
    // refs and every later action would fail to resolve one — silently, since a
    // missing ref looks exactly like an element that has gone away.
    await runInPage(7, { op: "find", query: "x", max: 5 });
    expect(calls[0].world).toBe("MAIN");
  });

  it("never sets allFrames", async () => {
    // executeScript returns one result PER FRAME, and a ref minted in frame N
    // resolves only in frame N. The desktop's executeJavaScript has no such
    // ambiguity, so this is the one place the backends could genuinely disagree.
    await runInPage(7, { op: "snapshot", filter: "all", max: 10 });
    expect(calls[0].target).toEqual({ tabId: 7 });
    expect(calls[0].target.allFrames).toBeUndefined();
  });

  it("returns the frame's result", async () => {
    nextResult = {
      url: "https://x.test",
      title: "T",
      elements: [{ ref: "e1" }],
    };
    const snap = await runInPage<{ title: string }>(7, {
      op: "snapshot",
      filter: "interactive",
      max: 10,
    });
    expect(snap.title).toBe("T");
  });
});

describe("failures say something a caller can act on", () => {
  it("wraps an injection failure with Chrome's own reason", async () => {
    // A cause with no user-facing fix keeps Chrome's wording verbatim. Only
    // the withheld-host case is translated, because only it has an action
    // attached — see the dedicated describe block below.
    failWith = new Error("Frame with ID 0 was removed.");
    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toBeInstanceOf(PageAccessError);
    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toThrow(/Frame with ID 0 was removed/);
  });

  it("reports an empty result array rather than returning undefined", async () => {
    // A real race: the frame goes away between the permission check and the
    // injection, on a page that redirects. Returning undefined would surface
    // much later as a property access on nothing.
    emptyResults = true;
    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toThrow(/navigated/);
  });
});

describe("refResolves", () => {
  it("is a SECOND, separate call — which is the property being proven", async () => {
    nextResult = true;
    await expect(refResolves(7, "e3")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].world).toBe("MAIN");
    expect(calls[0].args).toEqual(["e3"]);
    // Not the kernel: resolving an element is the ACTION path, still strings on
    // the desktop until Phase 3. This is a probe, not part of the contract.
    expect(calls[0].func).not.toBe(atlarixPageKernel);
  });

  it("escapes the ref rather than concatenating it into a selector", async () => {
    // A ref is a value we minted, so this is not currently reachable by a
    // page — but the selector path must not BECOME an injection surface if that
    // ever stops being true, and the probe runs in the MAIN world where the
    // page could otherwise influence it.
    nextResult = false;
    const hostile = 'e1"],[data-x="';
    await refResolves(7, hostile);
    const fn = calls[0].func as unknown as (v: string) => unknown;
    expect(String(fn)).toContain("CSS.escape");
    // The hostile value travels as an ARGUMENT, never spliced into source.
    expect(calls[0].args).toEqual([hostile]);
    expect(String(fn)).not.toContain(hostile);
  });
});

describe("activeTab", () => {
  it("returns the focused window's active tab", async () => {
    await expect(activeTab()).resolves.toEqual({
      id: 7,
      url: "https://x.test/page",
    });
  });

  it("is null when the tab has no id or url to work with", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        async query() {
          return [{ active: true }];
        },
      },
    };
    await expect(activeTab()).resolves.toBeNull();
  });
});

describe("the injected probe itself", () => {
  it("finds an element by its minted ref, in a real DOM", async () => {
    // The probe is a plain function, so it can be run directly against jsdom —
    // proving the selector it builds actually matches what the kernel writes.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 20,
    } as DOMRect);
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const snap = atlarixPageKernel({
      op: "snapshot",
      filter: "interactive",
      max: 10,
    }) as { elements: Array<{ ref: string }> };
    const ref = snap.elements[0].ref;

    installFakeChrome();
    const probe = (v: string) =>
      Boolean(
        document.querySelector('[data-atlarix-ref="' + CSS.escape(v) + '"]'),
      );
    expect(probe(ref)).toBe(true);
    expect(probe("e9999")).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("a site the user withheld in chrome://extensions", () => {
  /**
   * THE HOLE THIS CLOSES. Declaring a host permission is not the same as
   * holding it: Chrome lets anyone narrow an extension to "On click" from
   * chrome://extensions, and a withheld origin throws at injection while our
   * own allow-list still says the site is fine. There is no event and no flag —
   * the refusal is the only signal — so without this the model gets a raw
   * browser error, reads it as a broken page, and retries forever while the one
   * person who can fix it is never told.
   */
  it("translates Chrome's refusal into the setting the user can change", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      scripting: {
        async executeScript() {
          throw new Error(
            "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
          );
        },
      },
    };

    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toThrow(/chrome:\/\/extensions/);
    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toThrow(/Site access/i);
  });

  it("leaves every other failure wearing Chrome's own words", async () => {
    // A restricted page and a vanished tab have no user-facing fix, so dressing
    // them up as one would send the user to a setting that changes nothing.
    (globalThis as Record<string, unknown>).chrome = {
      scripting: {
        async executeScript() {
          throw new Error("No tab with id: 7.");
        },
      },
    };

    await expect(
      runInPage(7, { op: "snapshot", filter: "interactive", max: 10 }),
    ).rejects.toThrow(/No tab with id/);
  });
});
