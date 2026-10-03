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
 * AND ONE PER ATLARIX PROCESS. The desktop app and the `atlarix` CLI can drive
 * the browser at once (the bridge carries `client` on each request). Each gets
 * its own group — "Atlarix" and "Atlarix CLI" — so neither takes over, reads
 * or closes the other's tabs. The app's groups keep the original key (the bare
 * windowId), so nothing stored before this needs migrating; the CLI's are
 * `cli:<windowId>`.
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

/** Which Atlarix a group belongs to: the desktop app (and this panel) or the CLI. */
export type GroupClient = "app" | "cli";

/** The group's name in the tab strip, and while it is working. */
export function groupTitle(client: GroupClient = "app", working = false): string {
  const base = client === "cli" ? "Atlarix CLI" : DEFAULT_TITLE;
  return working ? `${base} · working` : base;
}

function keyFor(windowId: number, client: GroupClient): string {
  return client === "app" ? String(windowId) : `${client}:${windowId}`;
}

/** The client and window a stored key names. */
function parseKey(key: string): { client: GroupClient; windowId: number } {
  const [a, b] = key.split(":");
  return b === undefined ? { client: "app", windowId: Number(a) } : { client: a === "cli" ? "cli" : "app", windowId: Number(b) };
}

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
export async function existingGroup(
  windowId: number,
  client: GroupClient = "app",
): Promise<number | null> {
  const map = await readMap();
  const key = keyFor(windowId, client);
  const groupId = map[key];
  if (typeof groupId !== "number") return null;
  try {
    await api().tabGroups.get(groupId);
    return groupId;
  } catch {
    delete map[key];
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
  title?: string,
  client: GroupClient = "app",
): Promise<number> {
  title ??= groupTitle(client);
  const existing = await existingGroup(windowId, client);

  const groupId = await api().tabs.group(
    existing !== null
      ? { tabIds: tabId, groupId: existing }
      : { tabIds: tabId, createProperties: { windowId } },
  );

  if (existing === null) {
    const map = await readMap();
    map[keyFor(windowId, client)] = groupId;
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
export async function isAgentTab(
  tabId: number,
  client: GroupClient | "any" = "app",
): Promise<boolean> {
  let tab;
  try {
    tab = await api().tabs.get(tabId);
  } catch {
    return false;
  }
  if (tab.groupId === undefined || tab.windowId === undefined) return false;
  if (tab.groupId === api().tabGroups.TAB_GROUP_ID_NONE) return false;
  const clients: GroupClient[] = client === "any" ? ["app", "cli"] : [client];
  for (const c of clients) {
    if (tab.groupId === (await existingGroup(tab.windowId, c))) return true;
  }
  return false;
}

/** Show what the agent is doing where the user is already looking. */
export async function setGroupTitle(
  windowId: number,
  title: string,
  client: GroupClient = "app",
): Promise<void> {
  const groupId = await existingGroup(windowId, client);
  if (groupId === null) return;
  await api().tabGroups.update(groupId, { title });
}

/** Hand a tab back to the user, leaving it open. */
export async function releaseTab(tabId: number): Promise<void> {
  await api().tabs.ungroup(tabId);
}

/**
 * The agent is about to close one of its own tabs.
 *
 * WHY THIS EXISTS — OBSERVED, and it is the nastiest kind of bug because both
 * halves were working exactly as designed. Chrome removes a tab group the
 * moment its last tab goes, and it fires `onRemoved` identically whether the
 * user closed the group or the agent tidied up after itself. So an agent that
 * did the polite thing — "Got both. Closing my tabs and summarizing now." —
 * emptied its own group, fired the user's stop gesture, and killed its own turn
 * one call before the answer. The transcript ended mid-sentence and the status
 * line said "Stopped", which is true and completely unhelpful.
 *
 * A TIME WINDOW RATHER THAN A COUNTER, because a counter cannot be right: the
 * agent may close two tabs and only the second empties the group, and Chrome
 * may coalesce. The window is short, and it CLOSES EARLY on the first matching
 * removal so it is not left hanging open. The residual hole is that a user who
 * closes the group in the same two seconds gets no abort — they still have the
 * Stop button, and this failure direction is strictly better than the other one.
 */
let agentClosingUntil = 0;

/** Called by `close_tab` immediately before `tabs.remove`. */
export function noteAgentClosingTab(graceMs = 2000): void {
  agentClosingUntil = Date.now() + graceMs;
}

/** Test seam, and a way for a caller to reset after a run. */
export function clearAgentClosing(): void {
  agentClosingUntil = 0;
}

/**
 * Register the stop gesture.
 *
 * Closing the group is the most discoverable stop an extension has, so it must
 * mean stop everywhere — not merely tidy our bookkeeping. The caller cancels the
 * run; this only reports which window went away and forgets the id.
 *
 * The bookkeeping happens EITHER WAY. Only the handler is suppressed when the
 * agent emptied the group itself: the stored id is dead regardless, and leaving
 * it behind is the stale-id hazard this module exists to avoid.
 */
export function onGroupClosed(
  handler: (windowId: number, client: GroupClient) => void,
): void {
  api().tabGroups.onRemoved.addListener((group) => {
    void (async () => {
      const selfInflicted = Date.now() < agentClosingUntil;
      const map = await readMap();
      for (const [key, groupId] of Object.entries(map)) {
        if (groupId !== group.id) continue;
        delete map[key];
        await writeMap(map);
        if (selfInflicted) {
          // The expected removal arrived, so stop suppressing immediately
          // rather than leaving the window open for its full duration.
          agentClosingUntil = 0;
          return;
        }
        const { windowId, client } = parseKey(key);
        handler(windowId, client);
      }
    })();
  });
}
