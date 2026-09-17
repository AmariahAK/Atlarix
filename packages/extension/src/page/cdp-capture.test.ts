/**
 * Console and network capture — and above all, the distinction it exists for.
 *
 * ══ THE ASSERTION THAT MATTERS ══
 *
 * "The page logged nothing" and "Atlarix could not watch" must never render as
 * the same thing. Reporting both as `[]` is precisely the lie that kept this
 * capability from being written for so long — the refusal said an empty console
 * read is indistinguishable from a clean page, and it was right, which is why
 * `unavailable` is carried separately and asserted here before anything else.
 *
 * Events are driven through the real `debugger.onEvent` listener the module
 * installs, rather than by poking its buffers: the mapping from CDP's vocabulary
 * to ours is most of the code and all of the risk.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const attachMock = vi.fn();
const detachMock = vi.fn();
const sendCommandMock = vi.fn();
let onEventCb:
  | ((source: { tabId?: number }, method: string, params?: unknown) => void)
  | null = null;

vi.mock("./trusted-input", () => ({
  attach: (...a: unknown[]) => attachMock(...a),
  detach: (...a: unknown[]) => detachMock(...a),
}));
vi.mock("../shared/browser-api", () => ({
  api: () => ({
    debugger: {
      sendCommand: (...a: unknown[]) => sendCommandMock(...a),
      onEvent: {
        addListener: (cb: typeof onEventCb) => {
          onEventCb = cb;
        },
      },
    },
  }),
}));

/** A fresh module per test — the buffers and the listener flag are module state. */
async function fresh() {
  vi.resetModules();
  onEventCb = null;
  return import("./cdp-capture");
}

const emit = (tabId: number, method: string, params: unknown) =>
  onEventCb?.({ tabId }, method, params);

beforeEach(() => {
  attachMock.mockReset().mockResolvedValue(undefined);
  detachMock.mockReset().mockResolvedValue(undefined);
  sendCommandMock.mockReset().mockResolvedValue({});
});

describe("empty is not the same as unavailable", () => {
  it("a watched tab that logged nothing reports an EMPTY console, no reason", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    const read = cap.readConsole(7);
    expect(read.entries).toEqual([]);
    expect(read.unavailable).toBeUndefined();
  });

  it("a tab whose debugger is held by DevTools reports the REASON, not empty", async () => {
    const cap = await fresh();
    attachMock.mockRejectedValueOnce(
      new Error("Another debugger is already attached to this tab"),
    );
    await cap.beginCapture(7);
    const read = cap.readConsole(7);
    expect(read.entries).toEqual([]);
    expect(read.unavailable).toContain("Another debugger");
    // And it says so in terms the reader can act on.
    expect(read.unavailable).toContain("NOT an empty console");
  });

  it("a tab that was never watched says so rather than claiming it was clean", async () => {
    const cap = await fresh();
    const read = cap.readConsole(99);
    expect(read.unavailable).toContain("was not watching");
  });

  it("never fails beginCapture when the debugger is unavailable", async () => {
    // Reading and clicking still work on such a tab; failing the whole op would
    // trade a capability for a diagnostic.
    const cap = await fresh();
    attachMock.mockRejectedValueOnce(new Error("nope"));
    await expect(cap.beginCapture(7)).resolves.toBeUndefined();
  });
});

describe("console events", () => {
  it("records a log with its level and text", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    emit(7, "Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "saved ok" }],
    });
    const [entry] = cap.readConsole(7).entries;
    expect(entry?.level).toBe("warning");
    expect(entry?.message).toBe("saved ok");
    expect(entry?.tabId).toBe(7);
  });

  it("keeps the stack off an uncaught exception — it is the fixable part", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    emit(7, "Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: x is not a function\\n  at a.js:1" },
      },
    });
    const [entry] = cap.readConsole(7).entries;
    expect(entry?.level).toBe("error");
    expect(entry?.stack).toContain("a.js:1");
  });

  it("filters to errors when asked, without losing them from the buffer", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    emit(7, "Runtime.consoleAPICalled", { type: "log", args: [] });
    emit(7, "Runtime.consoleAPICalled", { type: "error", args: [] });
    expect(cap.readConsole(7, "errors").entries).toHaveLength(1);
    expect(cap.readConsole(7, "all").entries).toHaveLength(2);
  });

  it("ignores events for tabs it is not watching", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    emit(8, "Runtime.consoleAPICalled", { type: "error", args: [] });
    expect(cap.readConsole(7).entries).toEqual([]);
  });
});

describe("network events", () => {
  it("assembles a request across its CDP lifecycle", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    await cap.armNetwork(7);
    emit(7, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x.test/a", method: "GET" },
      type: "XHR",
    });
    emit(7, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 500, statusText: "Server Error" },
    });
    emit(7, "Network.loadingFinished", { requestId: "r1", encodedDataLength: 12 });

    const [row] = cap.readNetwork(7, "all").entries;
    expect(row?.url).toBe("https://x.test/a");
    expect(row?.status).toBe(500);
    expect(row?.size).toBe(12);
    expect(row?.source).toBe("cdp");
  });

  it("defaults to failures only, and a 500 is one", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    await cap.armNetwork(7);
    emit(7, "Network.requestWillBeSent", {
      requestId: "ok",
      request: { url: "https://x.test/ok", method: "GET" },
    });
    emit(7, "Network.responseReceived", { requestId: "ok", response: { status: 200 } });
    emit(7, "Network.requestWillBeSent", {
      requestId: "bad",
      request: { url: "https://x.test/bad", method: "GET" },
    });
    emit(7, "Network.responseReceived", { requestId: "bad", response: { status: 500 } });

    expect(cap.readNetwork(7).entries.map((e) => e.url)).toEqual([
      "https://x.test/bad",
    ]);
    expect(cap.readNetwork(7, "all").entries).toHaveLength(2);
  });

  it("records a transport failure distinctly from a 4xx", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    await cap.armNetwork(7);
    emit(7, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x.test/a", method: "GET" },
    });
    emit(7, "Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED" });
    const [row] = cap.readNetwork(7).entries;
    expect(row?.failed).toBe(true);
    expect(row?.errorText).toContain("ERR_FAILED");
    expect(row?.status).toBeUndefined();
  });

  it("says it is not armed rather than reporting no requests", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    const read = cap.readNetwork(7);
    expect(read.entries).toEqual([]);
    expect(read.unavailable).toContain("not armed");
  });
});

describe("Network.enable is raced, because the trap is a HANG", () => {
  it("degrades to not-armed instead of blocking forever", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    // A promise that never settles — exactly what Network.enable does on a tab
    // that has never navigated (v14.31.0). An unguarded await here would hold
    // the bridged request open until the desktop's 30s timeout.
    sendCommandMock.mockImplementation((_t: unknown, method: string) =>
      method === "Network.enable" ? new Promise(() => {}) : Promise.resolve({}),
    );
    await expect(cap.armNetwork(7)).resolves.toBeUndefined();
    const read = cap.readNetwork(7);
    expect(read.unavailable).toContain("not armed");
    // A timeout must stay RECOVERABLE — the tab may navigate a moment later.
    expect(read.unavailable).not.toContain("could not watch");
  }, 10_000);
});

describe("endCapture", () => {
  it("gives the debugger back and drops the buffer", async () => {
    const cap = await fresh();
    await cap.beginCapture(7);
    emit(7, "Runtime.consoleAPICalled", { type: "log", args: [] });
    expect(cap.isCapturing(7)).toBe(true);

    await cap.endCapture(7);
    expect(detachMock).toHaveBeenCalledWith(7);
    expect(cap.isCapturing(7)).toBe(false);
    expect(cap.readConsole(7).unavailable).toContain("was not watching");
  });
});
