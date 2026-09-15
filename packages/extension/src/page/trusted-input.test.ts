/**
 * Trusted input.
 *
 * Two things here are worth more than the rest:
 *
 *   - **Attach is refused outside the agent's group.** Getting that wrong puts
 *     a debugger banner on a tab the user is working in and evicts its
 *     DevTools. It is the containment, so it is asserted first.
 *   - **Detach is a NORMAL path.** The banner has a Cancel button and the user
 *     is entitled to press it mid-run. Treating that as a fault turns an
 *     ordinary action into a crash; ignoring it leaves every later keystroke
 *     going nowhere with no error.
 *
 * The key-code assertions matter for a subtler reason: an event without
 * `windowsVirtualKeyCode` arrives with `keyCode: 0`, which every framework's
 * "was that Enter?" check reads as no. That is the same silent-nothing this
 * whole module exists to avoid, one layer down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NONE = -1;

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

interface Fake {
  sent: Sent[];
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  fireDetach: (tabId: number, reason: string) => void;
  attachError: Error | null;
  sendError: Error | null;
}

let fake: Fake;

function installFakeChrome(agentTabIds: number[] = [1]): Fake {
  const sent: Sent[] = [];
  const detachListeners: Array<
    (source: { tabId?: number }, reason: string) => void
  > = [];
  const state = {
    attachError: null as Error | null,
    sendError: null as Error | null,
  };

  const attach = vi.fn(async () => {
    if (state.attachError) throw state.attachError;
  });
  const detach = vi.fn(async () => {});

  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        async get() {
          return { "atlarix.tabGroups.v1": { "10": 100 } };
        },
        async set() {},
        async remove() {},
        async clear() {},
      },
    },
    tabs: {
      async get(id: number) {
        return {
          id,
          windowId: 10,
          groupId: agentTabIds.includes(id) ? 100 : NONE,
        };
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: NONE,
      async get(id: number) {
        return { id };
      },
      update: async () => ({}),
      onRemoved: { addListener: () => {} },
    },
    debugger: {
      attach,
      detach,
      async sendCommand(
        _target: unknown,
        method: string,
        params: Record<string, unknown>,
      ) {
        if (state.sendError) throw state.sendError;
        sent.push({ method, params });
      },
      onDetach: {
        addListener(cb: (s: { tabId?: number }, r: string) => void) {
          detachListeners.push(cb);
        },
      },
    },
  };

  return {
    sent,
    attach,
    detach,
    fireDetach: (tabId, reason) => {
      for (const cb of detachListeners) cb({ tabId }, reason);
    },
    get attachError() {
      return state.attachError;
    },
    set attachError(e: Error | null) {
      state.attachError = e;
    },
    get sendError() {
      return state.sendError;
    },
    set sendError(e: Error | null) {
      state.sendError = e;
    },
  } as Fake;
}

/** Fresh module per test: `attached` is module-level session state. */
async function load() {
  vi.resetModules();
  return import("./trusted-input");
}

beforeEach(() => {
  fake = installFakeChrome();
});

describe("attach is scoped to the agent's own tabs", () => {
  it("REFUSES a tab outside the group, and says why", async () => {
    const { attach, TrustedInputError } = await load();
    await expect(attach(2)).rejects.toBeInstanceOf(TrustedInputError);
    await expect(attach(2)).rejects.toThrow(/not in Atlarix's tab group/);
    expect(fake.attach).not.toHaveBeenCalled();
  });

  it("attaches to a tab in the group, once", async () => {
    const { attach, isAttached } = await load();
    await attach(1);
    await attach(1);
    expect(fake.attach).toHaveBeenCalledTimes(1);
    expect(fake.attach).toHaveBeenCalledWith({ tabId: 1 }, "1.3");
    expect(isAttached(1)).toBe(true);
  });

  it("explains the DevTools collision, which is the commonest failure", async () => {
    fake.attachError = new Error("Another debugger is already attached");
    const { attach } = await load();
    await expect(attach(1)).rejects.toThrow(/Close DevTools/);
  });
});

describe("detach is a normal path", () => {
  it("forgets a session the user cancelled, so the next call re-attaches", async () => {
    const { attach, isAttached, watchDetach } = await load();
    const seen: Array<[number, string]> = [];
    watchDetach((tabId, reason) => seen.push([tabId, reason]));

    await attach(1);
    expect(isAttached(1)).toBe(true);

    fake.fireDetach(1, "canceled_by_user");
    expect(isAttached(1)).toBe(false);
    expect(seen).toEqual([[1, "canceled_by_user"]]);

    await attach(1);
    expect(fake.attach).toHaveBeenCalledTimes(2);
  });

  it("drops the record when a command reports it detached mid-flight", async () => {
    // The user can press Cancel between our attach and our send.
    const { attach, pressKey, isAttached } = await load();
    await attach(1);
    fake.sendError = new Error("Detached while handling command");
    await expect(pressKey(1, "Enter")).rejects.toThrow(/Detached/);
    expect(isAttached(1)).toBe(false);
  });

  it("detaching when not attached is a no-op", async () => {
    const { detach } = await load();
    await expect(detach(1)).resolves.toBeUndefined();
    expect(fake.detach).not.toHaveBeenCalled();
  });
});

describe("pressKey", () => {
  it("sends the virtual key code — without it keyCode is 0 and Enter is missed", async () => {
    const { pressKey } = await load();
    await pressKey(1, "Enter");

    const [down, up] = fake.sent;
    expect(down.method).toBe("Input.dispatchKeyEvent");
    expect(down.params).toMatchObject({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
    });
    expect(up.params).toMatchObject({ type: "keyUp", key: "Enter" });
  });

  it("uses rawKeyDown for a key that produces no character", async () => {
    const { pressKey } = await load();
    await pressKey(1, "Escape");
    expect(fake.sent[0].params).toMatchObject({ type: "rawKeyDown" });
    expect(fake.sent[0].params.text).toBeUndefined();
  });

  it("lists what it CAN press when asked for something it cannot", async () => {
    const { pressKey } = await load();
    await expect(pressKey(1, "F13")).rejects.toThrow(/Enter/);
  });

  it("attaches on demand rather than requiring a separate call", async () => {
    const { pressKey } = await load();
    await pressKey(1, "Tab");
    expect(fake.attach).toHaveBeenCalledTimes(1);
  });
});

describe("typeText", () => {
  it("sends per-character key events, not one insertText", async () => {
    // `Input.insertText` is one call and produces NO key events, so an
    // autocomplete that opens on keydown never opens and a field that validates
    // as you type never runs.
    const { typeText } = await load();
    await typeText(1, "hi");
    expect(fake.sent.map((s) => s.params.text)).toEqual(["h", "h", "i", "i"]);
    expect(fake.sent.every((s) => s.method === "Input.dispatchKeyEvent")).toBe(
      true,
    );
  });

  it("handles characters outside the BMP as single units", async () => {
    // `for...of` over a string iterates code POINTS; indexing would split an
    // emoji into two lone surrogates and type neither.
    const { typeText } = await load();
    await typeText(1, "😀");
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0].params.text).toBe("😀");
  });
});

describe("pointer", () => {
  it("moves before pressing — :hover is compositor state, not an event", async () => {
    const { clickAt } = await load();
    await clickAt(1, 12, 34);
    expect(fake.sent.map((s) => s.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(fake.sent[1].params).toMatchObject({
      x: 12,
      y: 34,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    // Release must report no buttons held, or the page sees a drag.
    expect(fake.sent[2].params).toMatchObject({ buttons: 0 });
  });

  it("moves with no button held", async () => {
    const { movePointer } = await load();
    await movePointer(1, 5, 6);
    expect(fake.sent[0].params).toMatchObject({
      type: "mouseMoved",
      button: "none",
      buttons: 0,
    });
  });
});

describe("degrading loudly", () => {
  it("hands back the capability layer's wording, not its own", async () => {
    const { unavailableMessage } = await load();
    const message = unavailableMessage("key");
    expect(message).toMatch(/nothing was done/i);
    expect(message).toContain('target:"app"');
  });
});
