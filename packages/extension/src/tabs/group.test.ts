/**
 * The agent's tab group.
 *
 * The assertion that carries weight is that a stored group id is never trusted
 * on its own. A group the user closed leaves its id behind in storage, and
 * `tabs.group({groupId})` with a dead id either errors or — worse — lands a tab
 * in whatever group has since taken that number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptTab,
  clearAgentClosing,
  existingGroup,
  isAgentTab,
  noteAgentClosingTab,
  onGroupClosed,
  releaseTab,
  setGroupTitle,
} from "./group";

interface Fake {
  store: Map<string, unknown>;
  groups: Map<number, { id: number; title?: string; color?: string }>;
  tabs: Map<number, { id: number; windowId: number; groupId: number }>;
  group: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  ungroup: ReturnType<typeof vi.fn>;
  fireRemoved: (groupId: number) => void;
}

const NONE = -1;

// The suppression window is module state, so a test that arms it would leak
// into the next one.
afterEach(() => clearAgentClosing());

function installFakeChrome(): Fake {
  const store = new Map<string, unknown>();
  const groups = new Map<
    number,
    { id: number; title?: string; color?: string }
  >();
  const tabs = new Map<
    number,
    { id: number; windowId: number; groupId: number }
  >();
  let nextGroupId = 100;
  const removedListeners: Array<(g: { id: number }) => void> = [];

  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };

  const group = vi.fn(
    async (opts: {
      tabIds: number;
      groupId?: number;
      createProperties?: { windowId: number };
    }) => {
      const id = opts.groupId ?? nextGroupId++;
      if (!groups.has(id)) groups.set(id, { id });
      const tab = tabs.get(opts.tabIds);
      if (tab) tab.groupId = id;
      return id;
    },
  );

  const update = vi.fn(
    async (groupId: number, props: { title?: string; color?: string }) => {
      const g = groups.get(groupId);
      if (!g) throw new Error("No group with id " + groupId);
      Object.assign(g, props);
      return g;
    },
  );

  const ungroup = vi.fn(async (tabIds: number | number[]) => {
    for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      const tab = tabs.get(id);
      if (tab) tab.groupId = NONE;
    }
  });

  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
    tabs: {
      group,
      ungroup,
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab with id " + id);
        return tab;
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: NONE,
      async get(id: number) {
        const g = groups.get(id);
        if (!g) throw new Error("No group with id " + id);
        return g;
      },
      update,
      onRemoved: {
        addListener(cb: (g: { id: number }) => void) {
          removedListeners.push(cb);
        },
      },
    },
  };

  return {
    store,
    groups,
    tabs,
    group,
    update,
    ungroup,
    fireRemoved: (groupId: number) => {
      groups.delete(groupId);
      for (const cb of removedListeners) cb({ id: groupId });
    },
  };
}

let fake: Fake;
beforeEach(() => {
  fake = installFakeChrome();
  fake.tabs.set(1, { id: 1, windowId: 10, groupId: NONE });
  fake.tabs.set(2, { id: 2, windowId: 10, groupId: NONE });
  fake.tabs.set(3, { id: 3, windowId: 20, groupId: NONE });
});

describe("adoptTab", () => {
  it("creates the group on the first tab and reuses it on the second", async () => {
    const first = await adoptTab(1, 10);
    const second = await adoptTab(2, 10);
    expect(second).toBe(first);
    // Created with createProperties, then joined by id — two different calls.
    expect(fake.group.mock.calls[0][0]).toMatchObject({
      createProperties: { windowId: 10 },
    });
    expect(fake.group.mock.calls[1][0]).toMatchObject({ groupId: first });
  });

  it("keeps one group PER WINDOW — a group cannot span windows", async () => {
    const inTen = await adoptTab(1, 10);
    const inTwenty = await adoptTab(3, 20);
    expect(inTwenty).not.toBe(inTen);
  });

  it("re-applies the title and colour every time, not only on creation", async () => {
    // The user can rename or recolour a group, and one that stops saying
    // Atlarix stops doing the only job it has.
    await adoptTab(1, 10);
    await adoptTab(2, 10);
    expect(fake.update).toHaveBeenCalledTimes(2);
    expect(fake.update.mock.calls[1][1]).toEqual({
      title: "Atlarix",
      color: "green",
    });
  });
});

describe("existingGroup", () => {
  it("is null before anything has been adopted", async () => {
    await expect(existingGroup(10)).resolves.toBeNull();
  });

  it("VERIFIES against the browser and forgets a group that is gone", async () => {
    // The core hazard: the id outlives the group, and a later `tabs.group`
    // would put a tab into whatever group has since taken that number.
    const groupId = await adoptTab(1, 10);
    fake.groups.delete(groupId);

    await expect(existingGroup(10)).resolves.toBeNull();
    // And the stale id is dropped rather than re-checked forever.
    expect(fake.store.get("atlarix.tabGroups.v1")).toEqual({});
  });

  it("creates a fresh group after the old one went away", async () => {
    const first = await adoptTab(1, 10);
    fake.groups.delete(first);
    const second = await adoptTab(2, 10);
    expect(second).not.toBe(first);
  });
});

describe("isAgentTab", () => {
  it("is true for a tab in the agent's group", async () => {
    await adoptTab(1, 10);
    await expect(isAgentTab(1)).resolves.toBe(true);
  });

  it("is false for an ungrouped tab", async () => {
    await adoptTab(1, 10);
    await expect(isAgentTab(2)).resolves.toBe(false);
  });

  it("is false for a tab in SOMEONE ELSE'S group", async () => {
    // The gate for chrome.debugger. Getting this wrong puts a debugger banner
    // on a tab the user is working in and takes away its DevTools.
    await adoptTab(1, 10);
    fake.groups.set(999, { id: 999 });
    fake.tabs.set(4, { id: 4, windowId: 10, groupId: 999 });
    await expect(isAgentTab(4)).resolves.toBe(false);
  });

  it("is false for a tab that no longer exists", async () => {
    await expect(isAgentTab(4242)).resolves.toBe(false);
  });
});

describe("the stop gesture", () => {
  it("reports the window whose group the user closed", async () => {
    // Closing the group is the most discoverable stop an extension has — a user
    // under any confusion reaches for it long before they find ours.
    const groupId = await adoptTab(1, 10);
    const closed: number[] = [];
    onGroupClosed((windowId) => closed.push(windowId));

    fake.fireRemoved(groupId);
    await vi.waitFor(() => expect(closed).toEqual([10]));
    await expect(existingGroup(10)).resolves.toBeNull();
  });

  /**
   * OBSERVED, and the nastiest kind: both halves worked exactly as designed.
   *
   * Chrome deletes a tab group the moment its last tab goes, and fires
   * `onRemoved` identically whether the USER closed the group or the AGENT
   * tidied up after itself. So an agent doing the polite thing — "Got both.
   * Closing my tabs and summarizing now." — emptied its own group, fired the
   * user's stop gesture, and killed its own turn one call before the answer.
   * The transcript ended mid-sentence under a status line reading "Stopped",
   * which was true and useless.
   */
  it("does NOT stop the run when the agent emptied the group itself", async () => {
    const groupId = await adoptTab(1, 10);
    const closed: number[] = [];
    onGroupClosed((windowId) => closed.push(windowId));

    noteAgentClosingTab();
    fake.fireRemoved(groupId);
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toEqual([]);
    // The bookkeeping still happens: the stored id is dead either way, and
    // leaving it behind is the stale-id hazard this module exists to avoid.
    await expect(existingGroup(10)).resolves.toBeNull();
  });

  it("stops suppressing as soon as the expected removal arrives", async () => {
    // Otherwise the window stays open for its full duration and a REAL stop a
    // second later is swallowed too.
    const first = await adoptTab(1, 10);
    const closed: number[] = [];
    onGroupClosed((windowId) => closed.push(windowId));

    noteAgentClosingTab();
    fake.fireRemoved(first);
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toEqual([]);

    const second = await adoptTab(2, 10);
    fake.fireRemoved(second);
    await vi.waitFor(() => expect(closed).toEqual([10]));
  });

  it("stops the run once the grace window has passed", async () => {
    const groupId = await adoptTab(1, 10);
    const closed: number[] = [];
    onGroupClosed((windowId) => closed.push(windowId));

    noteAgentClosingTab(0);
    fake.fireRemoved(groupId);
    await vi.waitFor(() => expect(closed).toEqual([10]));
  });

  it("ignores a group that was never ours", async () => {
    await adoptTab(1, 10);
    const closed: number[] = [];
    onGroupClosed((windowId) => closed.push(windowId));
    fake.fireRemoved(777);
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toEqual([]);
  });
});

describe("releaseTab and setGroupTitle", () => {
  it("hands a tab back without closing it", async () => {
    await adoptTab(1, 10);
    await releaseTab(1);
    expect(fake.ungroup).toHaveBeenCalledWith(1);
    await expect(isAgentTab(1)).resolves.toBe(false);
  });

  it("retitles the group to show what the agent is doing", async () => {
    await adoptTab(1, 10);
    await setGroupTitle(10, "Atlarix · reading");
    expect(fake.update).toHaveBeenLastCalledWith(expect.any(Number), {
      title: "Atlarix · reading",
    });
  });

  it("retitling a window with no group is a no-op, not a throw", async () => {
    await expect(setGroupTitle(99, "x")).resolves.toBeUndefined();
  });
});
