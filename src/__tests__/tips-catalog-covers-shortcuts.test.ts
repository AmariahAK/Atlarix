/**
 * QA (app) #28: the composer tip read "TIP ⌘N shortcuts.new-window" — the raw
 * key — because the new-window shortcut was advertised with no line in the
 * tips catalog. Every advertised shortcut has one.
 */
import { describe, it, expect } from "vitest";
import { SHORTCUTS } from "@/lib/shortcuts";
import tips from "@/lib/i18n/locales/en-us/tips.json";

describe("the tips catalog", () => {
  it("has a line for every advertised shortcut", () => {
    const lines = (tips as { shortcuts: Record<string, string> }).shortcuts;
    const missing = SHORTCUTS.filter((s) => s.status === "advertised" && !lines[s.id]).map((s) => s.id);
    expect(missing).toEqual([]);
  });
});
