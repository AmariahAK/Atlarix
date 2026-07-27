import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserSurfaceError } from "@/ipc/utils/browser_view_manager";

// The gate reads the browser-tab error buffer via getBrowserSurfaceErrors(); mock
// it so we can drive deterministic states.
let mockErrors: BrowserSurfaceError[] = [];
vi.mock("@/ipc/utils/browser_view_manager", () => ({
  // The browser is per-window now, so the gate resolves a scope before reading
  // errors. A truthy stand-in is enough — these tests exercise the baseline
  // filtering, not scope resolution.
  resolveBrowserScope: () => ({ window: {}, tabs: new Map() }),
  getBrowserSurfaceErrors: () => mockErrors,
  getActiveTabView: () => null,
}));

import {
  blockingPreviewErrors,
  ensurePreviewBaseline,
  clearPreviewBaseline,
  getPreviewRuntimeFeedback,
} from "@/lib/agent/preview-verify";

const err = (
  type: BrowserSurfaceError["type"],
  timestamp: number,
  level?: "error" | "warning",
): BrowserSurfaceError => ({ type, message: `${type}@${timestamp}`, timestamp, level });

describe("blockingPreviewErrors", () => {
  it("keeps error-level console but DROPS warnings (React/Next dev noise)", () => {
    const entries = [
      err("console-error", 10, "error"),
      err("console-error", 11, "warning"),
    ];
    const blocking = blockingPreviewErrors(entries);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].level).toBe("error");
  });

  it("always keeps load-failed / render-gone / network-failed", () => {
    const entries = [
      err("load-failed", 1),
      err("render-gone", 2),
      err("network-failed", 3),
    ];
    expect(blockingPreviewErrors(entries)).toHaveLength(3);
  });

  it("respects the sinceTs baseline (ignores older entries)", () => {
    const entries = [
      err("render-gone", 5),
      err("network-failed", 50),
    ];
    expect(blockingPreviewErrors(entries, 20)).toEqual([
      expect.objectContaining({ type: "network-failed", timestamp: 50 }),
    ]);
  });
});

describe("getPreviewRuntimeFeedback", () => {
  beforeEach(() => {
    mockErrors = [];
    clearPreviewBaseline("t1");
  });

  it("returns null when the preview only logged warnings", () => {
    ensurePreviewBaseline("t1", 0);
    mockErrors = [err("console-error", 100, "warning")];
    expect(getPreviewRuntimeFeedback("t1")).toBeNull();
  });

  it("returns a nudge when a runtime error occurs after the baseline", () => {
    ensurePreviewBaseline("t1", 50);
    mockErrors = [err("render-gone", 100)];
    const fb = getPreviewRuntimeFeedback("t1");
    expect(fb).toContain("runtime");
    expect(fb).toContain("render-gone");
  });

  it("ignores errors that predate the turn baseline", () => {
    ensurePreviewBaseline("t1", 200);
    mockErrors = [err("load-failed", 100)]; // before baseline
    expect(getPreviewRuntimeFeedback("t1")).toBeNull();
  });

  it("ensurePreviewBaseline keeps the earliest baseline (idempotent)", () => {
    ensurePreviewBaseline("t1", 50);
    ensurePreviewBaseline("t1", 999); // ignored
    mockErrors = [err("network-failed", 100)];
    // 100 >= 50 → blocking
    expect(getPreviewRuntimeFeedback("t1")).toContain("network-failed");
  });
});
