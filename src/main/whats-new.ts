/**
 * The "what's new" note, fetched rather than bundled.
 *
 * WHY FETCHED. A note shipped inside a release only reaches people who have
 * already updated, which is backwards for the one thing it is for: telling
 * somebody an update exists. `atlarix-releases/updates.json` sits beside
 * `core-models.json`, which the app has read live for months — this is the same
 * mechanism, deliberately, rather than a second way of doing it.
 *
 * Mirrors `src/lib/routing/core-model-overrides.ts` down to the cache-busting
 * query param and the "never throws" contract. The one difference is the
 * fallback ladder: Core has a build-time env fallback because a missing model
 * map breaks dispatch, whereas a missing note breaks nothing. So there is NO
 * bundled copy, and a failed fetch with no cache means the panel does not
 * render. **An empty panel is worse than no panel** — a blank card with a close
 * button reads as a bug, and the changelog on the website is where the real
 * information lives anyway.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import { BrowserWindow } from "electron";
import { getUserDataPath } from "../paths/paths";

const logger = log.scope("whats-new");

const FETCH_TIMEOUT_MS = 15_000;
/** Same cadence as core-models. A note is not more urgent than a model lineup. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const REMOTE_URL =
  process.env.ATLARIX_UPDATES_URL ??
  "https://raw.githubusercontent.com/AmariahAK/atlarix-releases/main/updates.json";

/** One note. `id` is the dismissal key, so it must be stable per note. */
export interface WhatsNewEntry {
  id: string;
  title: string;
  body: string;
  link?: string;
  linkLabel?: string;
}

let refreshTimer: NodeJS.Timeout | null = null;
/** Last applied payload, serialized — so a refresh that changes nothing is silent. */
let lastAppliedSerialized: string | null = null;
let current: WhatsNewEntry | null = null;

function getCachePath(): string {
  return path.join(getUserDataPath(), "cache", "updates.json");
}

/**
 * Validate hard, and return null rather than a partial entry.
 *
 * The panel renders whatever this returns, so a payload with a title and no body
 * would draw a half-empty card. Anything not fully usable is treated as no note
 * at all, which is the state the UI handles well.
 */
export function parseUpdatesPayload(raw: unknown): WhatsNewEntry | null {
  const payload = raw as { entries?: unknown } | null;
  const entries = payload?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // The FIRST entry, not the newest by date: the file is hand-edited and a date
  // field would be one more thing to get wrong. Order in the file is the order.
  const first = entries[0] as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

  const id = str(first?.id);
  const title = str(first?.title);
  const body = str(first?.body);
  if (!id || !title || !body) return null;

  const link = str(first?.link);
  // Only https, and validated here rather than at the click: the renderer would
  // otherwise hand an arbitrary string to `openExternalUrl` on a user gesture.
  const safeLink = link && /^https:\/\//i.test(link) ? link : undefined;

  return {
    id,
    title,
    body,
    link: safeLink,
    linkLabel: (safeLink && str(first?.linkLabel)) || undefined,
  };
}

function broadcastWhatsNewChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("whats-new:changed");
    } catch {
      // A window closing mid-broadcast is not an error worth surfacing.
    }
  }
}

function applyAndNotify(raw: unknown): void {
  const entry = parseUpdatesPayload(raw);
  const serialized = entry ? JSON.stringify(entry) : null;
  if (serialized === lastAppliedSerialized) return;
  lastAppliedSerialized = serialized;
  current = entry;
  broadcastWhatsNewChanged();
}

async function saveToCache(raw: unknown): Promise<void> {
  try {
    const file = getCachePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(raw), "utf-8");
  } catch (e) {
    logger.warn("could not write updates cache", e);
  }
}

async function loadRawFromCache(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(getCachePath(), "utf-8"));
  } catch {
    return null;
  }
}

/** The note the renderer should show, or null. Never throws, never blocks. */
export function getWhatsNewEntry(): WhatsNewEntry | null {
  return current;
}

/**
 * Fetch, validate, cache, apply. Falls back to the on-disk cache; if that is
 * missing too, leaves the current note alone (which at boot means none).
 * Never throws.
 */
export async function refreshWhatsNew(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // Cache-bust: the raw.githubusercontent CDN can serve a stale body for
    // minutes after a commit, which for a "what's new" note is the one thing
    // that would make it useless.
    const url = `${REMOTE_URL}${REMOTE_URL.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Atlarix/1.0",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    if (parseUpdatesPayload(raw)) {
      await saveToCache(raw);
      applyAndNotify(raw);
      return;
    }
    // A well-formed file with no usable entry is a deliberate "nothing to say",
    // so it CLEARS the note rather than leaving a stale one on screen.
    applyAndNotify(raw);
    logger.info("updates.json carries no usable entry");
  } catch (e) {
    logger.warn("updates fetch failed, trying cache", e);
    const cachedRaw = await loadRawFromCache();
    if (cachedRaw && parseUpdatesPayload(cachedRaw)) applyAndNotify(cachedRaw);
  }
}

/**
 * Boot hook. Reads the disk cache SYNCHRONOUSLY first so the panel can appear on
 * the first paint with last-known-good content, then refreshes in the background
 * and hourly after that. `unref` so it never holds the process open — the
 * packaged self-test already has one Windows exit mystery and does not need a
 * second suspect.
 */
export function warmWhatsNew(): void {
  try {
    const raw = JSON.parse(readFileSync(getCachePath(), "utf-8"));
    if (parseUpdatesPayload(raw)) applyAndNotify(raw);
  } catch {
    // No cache yet — no panel until the network refresh below lands.
  }
  void refreshWhatsNew();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshWhatsNew();
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
  }
}

/** Test seam: reset module state between cases. */
export function __resetWhatsNewForTests(): void {
  lastAppliedSerialized = null;
  current = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
