/**
 * The injected `fetch`/XHR wrapper, actually EXECUTED.
 *
 * This script is a string blob that runs inside pages the user browses. Reading
 * it is not verification — a wrapper that throws, or that consumes the response
 * body its caller was going to read, breaks a real website. So run it against a
 * DOM and check both halves: that records come out, and that the page is left
 * exactly as it would have been.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NETWORK_BODY_MAX,
  NETWORK_HOOK_SCRIPT,
  tryParseNetworkSentinel,
  type CapturedResponseBody,
} from "@/lib/browser/network-hook";

/**
 * The wrapper reaches for real browser globals, and the fakes below are
 * deliberately partial — a full `Response` is not needed to prove `clone()` was
 * used instead of `text()`. Reach the globals as a loose bag so the fakes do not
 * have to impersonate the whole DOM.
 */
const win = globalThis as unknown as {
  __atlarixNetHook?: boolean;
  fetch?: (input: unknown, init?: unknown) => Promise<unknown>;
  XMLHttpRequest?: unknown;
};

/** Records the wrapper emitted through the console sentinel. */
let captured: CapturedResponseBody[] = [];

function install(): void {
  // The script is written as an IIFE for executeJavaScript; eval is how you run
  // that here, and the input is our own compile-time constant.
  // eslint-disable-next-line no-eval
  (0, eval)(NETWORK_HOOK_SCRIPT);
}

function jsonResponse(body: string, status = 200) {
  let consumed = false;
  const res = {
    status,
    url: "https://api.test/thing",
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => body }),
    text: async () => {
      consumed = true;
      return body;
    },
    wasConsumed: () => consumed,
  };
  return res;
}

beforeEach(() => {
  captured = [];
  delete win.__atlarixNetHook;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const rec = tryParseNetworkSentinel(String(args[0] ?? ""));
    if (rec) captured.push(rec);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetch wrapper", () => {
  it("records the body without consuming the page's own response", async () => {
    const response = jsonResponse('{"ok":true}');
    const original = vi.fn(async () => response);
    win.fetch = original;

    install();
    const returned = await win.fetch!("https://api.test/thing", {
      method: "POST",
    } as RequestInit);

    // The page still gets the real response object, unread.
    expect(returned).toBe(response);
    expect(response.wasConsumed()).toBe(false);
    expect(original).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/thing",
      status: 200,
      body: '{"ok":true}',
      truncated: false,
    });
  });

  it("truncates a large body at the cap", async () => {
    const huge = "x".repeat(NETWORK_BODY_MAX + 1_000);
    win.fetch = vi.fn(async () => jsonResponse(huge));

    install();
    await win.fetch!("https://api.test/thing");

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body).toHaveLength(NETWORK_BODY_MAX);
    expect(captured[0].truncated).toBe(true);
  });

  it("skips the body of a non-textual response but still records the row", async () => {
    const binary = {
      status: 200,
      url: "https://api.test/img",
      headers: { get: () => "image/png" },
      clone: () => {
        throw new Error("must not clone a binary response");
      },
    };
    win.fetch = vi.fn(async () => binary);

    install();
    await win.fetch!("https://api.test/img");

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body).toBeUndefined();
    expect(captured[0].status).toBe(200);
  });

  it("records a rejected fetch and still rejects for the page", async () => {
    win.fetch = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });

    install();
    await expect(win.fetch!("https://api.test/down")).rejects.toThrow(
      "Failed to fetch",
    );

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toMatchObject({
      failed: true,
      errorText: "Failed to fetch",
    });
  });

  it("installs once per document", async () => {
    win.fetch = vi.fn(async () => jsonResponse("{}"));
    install();
    const afterFirst = win.fetch;
    install();
    expect(win.fetch).toBe(afterFirst);
  });

  it("survives a page that has no fetch at all", () => {
    delete win.fetch;
    expect(() => install()).not.toThrow();
  });
});

describe("XHR wrapper", () => {
  /**
   * A FRESH class per test. The wrapper patches `XMLHttpRequest.prototype`, so a
   * class shared across tests accumulates one wrapper layer per install and every
   * request then emits several records — through the previous test's restored
   * console spy, straight to stderr. That is a test artifact, not a product bug
   * (in a real tab the prototype dies with the document), but it makes the suite
   * lie in both directions.
   */
  function freshXHR() {
    return class FakeXHR {
      status = 0;
      responseType = "";
      responseText = "";
      opened: [string, string] | null = null;
      sent = false;
      private listeners: Array<() => void> = [];

      open(method: string, url: string) {
        this.opened = [method, url];
      }
      send() {
        this.sent = true;
      }
      addEventListener(_evt: string, fn: () => void) {
        this.listeners.push(fn);
      }
      finish(status: number, text?: string) {
        this.status = status;
        // Skipped when responseText has been redefined as a throwing getter,
        // which is what a real XHR does for a binary responseType.
        if (text !== undefined) this.responseText = text;
        for (const fn of this.listeners) fn();
      }
    };
  }

  type FakeXHR = InstanceType<ReturnType<typeof freshXHR>>;

  beforeEach(() => {
    win.XMLHttpRequest = freshXHR();
  });

  function newXhr(): FakeXHR {
    const Ctor = win.XMLHttpRequest as ReturnType<typeof freshXHR>;
    return new Ctor();
  }

  it("records a completed request and still opens/sends for the page", () => {
    install();
    const xhr = newXhr();
    xhr.open("GET", "https://api.test/list");
    xhr.send();

    expect(xhr.opened).toEqual(["GET", "https://api.test/list"]);
    expect(xhr.sent).toBe(true);

    xhr.finish(200, '{"items":[]}');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: "GET",
      url: "https://api.test/list",
      status: 200,
      body: '{"items":[]}',
    });
  });

  it("treats status 0 as a failure rather than a 0-status success", () => {
    install();
    const xhr = newXhr();
    xhr.open("GET", "https://api.test/blocked");
    xhr.send();
    xhr.finish(0, "");

    expect(captured[0]).toMatchObject({
      failed: true,
      url: "https://api.test/blocked",
    });
  });

  it("does not read responseText for a binary responseType", () => {
    install();
    const xhr = newXhr();
    xhr.open("GET", "https://api.test/blob");
    xhr.send();
    xhr.responseType = "arraybuffer";
    Object.defineProperty(xhr, "responseText", {
      get() {
        throw new Error("InvalidStateError");
      },
    });
    xhr.finish(200);

    expect(captured).toHaveLength(1);
    expect(captured[0].body).toBeUndefined();
  });
});
