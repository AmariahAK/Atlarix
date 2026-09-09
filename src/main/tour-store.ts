/**
 * Local tour completion state (UI preference).
 * Persists to userData/atlarix-tours.json (same role as electron-store for this app).
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("tour-store");

export interface TourState {
  firstRunCompleted: boolean;
  firstRunStep: number;
  dismissedAt: string | null;
  /** Per-feature: completed + resume step index */
  featureTours: Record<string, { completed: boolean; step: number }>;
}

const defaults: TourState = {
  firstRunCompleted: false,
  firstRunStep: 0,
  dismissedAt: null,
  featureTours: {},
};

function filePath(): string {
  return path.join(app.getPath("userData"), "atlarix-tours.json");
}

export function readTourState(): TourState {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...defaults, featureTours: {} };
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<TourState>;
    return {
      ...defaults,
      ...raw,
      featureTours:
        raw.featureTours && typeof raw.featureTours === "object"
          ? raw.featureTours
          : {},
    };
  } catch (e) {
    logger.warn("readTourState failed:", e);
    return { ...defaults, featureTours: {} };
  }
}

export function writeTourState(partial: Partial<TourState>): TourState {
  const cur = readTourState();
  const next: TourState = {
    ...cur,
    ...partial,
    featureTours:
      partial.featureTours !== undefined
        ? partial.featureTours
        : cur.featureTours,
  };
  try {
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    logger.error("writeTourState failed:", e);
  }
  return next;
}
