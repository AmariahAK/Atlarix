/**
 * The agent's tab group — a boundary, a status light and a stop gesture, in one
 * piece of UI the browser already ships.
 *
 * WHY A GROUP RATHER THAN A LIST WE KEEP. Three things fall out of it that a
 * private list cannot give:
 *
 *   1. **The user can see what the agent is touching**, without opening the
 *      panel. A coloured, titled group in the tab strip is the honest answer to
 *      "what is it doing" for an extension that reads pages you are signed into.
 *   2. **Closing the group is a stop.** Every agent needs an unmistakable one,
 *      and a user under any confusion reaches for the close button long before
 *      they find ours. `onRemoved` is that signal.
 *   3. **It scopes `chrome.debugger`.** Attaching shows a banner and evicts
 *      DevTools on that tab, so it must never touch a tab the user is working
 *      in. "Is it in the agent's group" is the check, and it is cheap.
 *
 * ONE GROUP PER WINDOW. A group cannot span windows, and the agent may be asked
 * about a tab in any of them, so the mapping is windowId → groupId.
 *
 * THE GROUP ID IS NOT A DURABLE HANDLE. The user can close the group, drag the
 * last tab out (which destroys it), or restart the browser. Every read goes
 * through `tabGroups.get`, which throws for a group that no longer exists —
 * so a stale id becomes "no group" rather than a write into someone else's.
 */

import { api } from "../shared/browser-api";

/** Where the windowId → groupId map lives. Device-local and disposable. */
const STORAGE_KEY = "atlarix.tabGroups.v1";

/**
 * Emerald, to match everything else Atlarix puts on screen.
 *
 * `tabGroups.Color` is a fixed enum — there is no hex — so "green" is as close
 * to the brand as the platform allows.
 */
const GROUP_COLOR = "green" as const;

const DEFAULT_TITLE = "Atlarix";

type GroupMap = Record<string, number>;

async function readMap(): Promise<GroupMap> {
  const bag = await api().storage.local.get(STORAGE_KEY);
  const raw = (bag as Record<string, unknown>)[STORAGE_KEY];
  return typeof raw === "object" && raw !== null ? (raw as GroupMap) : {};
}

async function writeMap(map: GroupMap): Promise<void> {
  await api().storage.local.set({ [STORAGE_KEY]: map });
}

/**
 * The agent's group for this window, if it still exists.
 *
 * Verified against the browser rather than trusted from storage: a group the
 * user closed leaves its id behind, and `tabs.group({groupId})` with a dead id
 * is an error at best and someone else's group at worst.
 */
export async function existingGroup(windowId: number): Promise<number | null> {
  const map = await readMap();
  const groupId = map[String(windowId)];
  if (typeof groupId !== "number") return null;
  try {
    await api().tabGroups.get(groupId);
    return groupId;
  } catch {
    delete map[String(windowId)];
    await writeMap(map);
    return null;
  }
}

/**
 * Move `tabId` into the agent's group for its window, creating it if needed.
 *
 * Returns the group id. `tabs.group` creates the group when no `groupId` is
 * given, which is why creation and adoption are the same call rather than two.
 */
export async function adoptTab(
  tabId: number,
  windowId: number,
  title: string = DEFAULT_TITLE,
): Promise<number> {
  const existing = await existingGroup(windowId);

  const groupId = await api().tabs.group(
    existing !== null
      ? { tabIds: tabId, groupId: existing }
      : { tabIds: tabId, createProperties: { windowId } },
  );

  if (existing === null) {
    const map = await readMap();
    map[String(windowId)] = groupId;
    await writeMap(map);
  }

  // Title and colour every time, not just on creation: the user can rename or
  // recolour a group, and a group that stops saying Atlarix stops doing the one
  // job it has.
  await api().tabGroups.update(groupId, { title, color: GROUP_COLOR });
  return groupId;
}

/**
 * Is this tab one the agent opened?
 *
 * The gate for anything intrusive — `chrome.debugger` above all, since
 * attaching shows a banner and takes DevTools away from whoever was using it.
 */
export async function isAgentTab(tabId: number): Promise<boolean> {
  let tab;
  try {
    tab = await api().tabs.get(tabId);
  } catch {
    return false;
  }
  if (tab.groupId === undefined || tab.windowId === undefined) return false;
  if (tab.groupId === api().tabGroups.TAB_GROUP_ID_NONE) return false;
  return tab.groupId === (await existingGroup(tab.windowId));
}

/** Show what the agent is doing where the user is already looking. */
export async function setGroupTitle(
  windowId: number,
  title: string,
): Promise<void> {
  const groupId = await existingGroup(windowId);
  if (groupId === null) return;
  await api().tabGroups.update(groupId, { title });
}

/** Hand a tab back to the user, leaving it open. */
export async function releaseTab(tabId: number): Promise<void> {
  await api().tabs.ungroup(tabId);
}

/**
 * Register the stop gesture.
 *
 * Closing the group is the most discoverable stop an extension has, so it must
 * mean stop everywhere — not merely tidy our bookkeeping. The caller cancels the
 * run; this only reports which window went away and forgets the id.
 */
export function onGroupClosed(handler: (windowId: number) => void): void {
  api().tabGroups.onRemoved.addListener((group) => {
    void (async () => {
      const map = await readMap();
      for (const [windowId, groupId] of Object.entries(map)) {
        if (groupId !== group.id) continue;
        delete map[windowId];
        await writeMap(map);
        handler(Number(windowId));
      }
    })();
  });
}
