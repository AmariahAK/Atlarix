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
  runtimeFailuresSince,
  ensurePreviewBaseline,
  clearPreviewBaseline,
  buildRuntimeNotice,
} from "@/lib/agent/preview-verify";

const err = (
  type: BrowserSurfaceError["type"],
  timestamp: number,
  level?: "error" | "warning",
): BrowserSurfaceError => ({ type, message: `${type}@${timestamp}`, timestamp, level });

describe("runtimeFailuresSince", () => {
  it("keeps error-level console but DROPS warnings (React/Next dev noise)", () => {
    const entries = [
      err("console-error", 10, "error"),
      err("console-error", 11, "warning"),
    ];
    const blocking = runtimeFailuresSince(entries);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].level).toBe("error");
  });

  it("always keeps load-failed / render-gone / network-failed", () => {
    const entries = [
      err("load-failed", 1),
      err("render-gone", 2),
      err("network-failed", 3),
    ];
    expect(runtimeFailuresSince(entries)).toHaveLength(3);
  });

  it("respects the sinceTs baseline (ignores older entries)", () => {
    const entries = [
      err("render-gone", 5),
      err("network-failed", 50),
    ];
    expect(runtimeFailuresSince(entries, 20)).toEqual([
      expect.objectContaining({ type: "network-failed", timestamp: 50 }),
    ]);
  });
});

describe("buildRuntimeNotice", () => {
  beforeEach(() => {
    mockErrors = [];
    clearPreviewBaseline("t1");
  });

  it("reports warnings too — it is information, not a verdict", () => {
    // Under the old GATE a warning was deliberately ignored, because React/Next
    // dev mode emits them constantly and they must never block a turn. The notice
    // has the opposite job: it cannot block anything, so withholding what the
    // browser saw would just hide context the model might want.
    ensurePreviewBaseline("t1", 0);
    mockErrors = [err("console-error", 100, "warning")];
    expect(buildRuntimeNotice("t1")).toContain("recorded");
  });

  it("returns null when nothing was recorded — a quiet turn adds nothing", () => {
    ensurePreviewBaseline("t1", 0);
    mockErrors = [];
    expect(buildRuntimeNotice("t1")).toBeNull();
  });

  it("is a POINTER, never a payload — entry text is not inlined", () => {
    ensurePreviewBaseline("t1", 0);
    mockErrors = Array.from({ length: 50 }, () =>
      err("console-error", 100, "error"),
    );
    const notice = buildRuntimeNotice("t1")!;
    // A chatty page must cost one line, not fifty.
    expect(notice.split("\n")).toHaveLength(1);
    expect(notice).toContain("browser_inspect");
  });

  it("returns a nudge when a runtime error occurs after the baseline", () => {
    ensurePreviewBaseline("t1", 50);
    mockErrors = [err("render-gone", 100)];
    const fb = buildRuntimeNotice("t1");
    expect(fb).toContain("recorded");
    expect(fb).toContain("console entr");
  });

  it("ignores errors that predate the turn baseline", () => {
    ensurePreviewBaseline("t1", 200);
    mockErrors = [err("load-failed", 100)]; // before baseline
    expect(buildRuntimeNotice("t1")).toBeNull();
  });

  it("ensurePreviewBaseline keeps the earliest baseline (idempotent)", () => {
    ensurePreviewBaseline("t1", 50);
    ensurePreviewBaseline("t1", 999); // ignored
    mockErrors = [err("network-failed", 100)];
    // 100 >= 50 → blocking
    expect(buildRuntimeNotice("t1")).toContain("failed request");
  });
});

// ── Errors from another tab are `unrelated` and must not block a turn ──
//
// Surface errors buffer per WINDOW, not per tab. So a docs page, dashboard, or any
// browsing the user has open alongside the agent's work pushed errors into the same
// list — where they read as the agent's own failures, appeared in
// browser_inspect(mode:"console"), and blocked the completion gate for a page the
// agent never touched.
//
// `unrelated` marks them without hiding them, exactly like a plan step's `external`
// state: still reported to the model, explicitly not its work, never blocking.
describe("runtimeFailuresSince — unrelated tabs", () => {
  const err = (over: Partial<BrowserSurfaceError> = {}): BrowserSurfaceError => ({
    type: "console-error",
    message: "boom",
    timestamp: 100,
    level: "error",
    ...over,
  });

  it("excludes an unrelated error even when it would otherwise block", () => {
    // A hard console error — blocking in every other respect.
    expect(runtimeFailuresSince([err({ unrelated: true })])).toEqual([]);
  });

  it("still blocks on the agent's own error", () => {
    expect(runtimeFailuresSince([err({ unrelated: false })])).toHaveLength(1);
    // Absent means related — the field is optional and must default to "mine".
    expect(runtimeFailuresSince([err()])).toHaveLength(1);
  });

  it("excludes unrelated load-failed / render-gone / network-failed too", () => {
    // These are "always blocking" by type, so the unrelated check must sit BEFORE
    // that branch, not after it.
    for (const type of ["load-failed", "render-gone", "network-failed"] as const) {
      expect(runtimeFailuresSince([err({ type, level: undefined, unrelated: true })])).toEqual([]);
      expect(runtimeFailuresSince([err({ type, level: undefined })])).toHaveLength(1);
    }
  });

  it("keeps only the agent's own errors from a mixed buffer", () => {
    const kept = runtimeFailuresSince([
      err({ message: "mine" }),
      err({ message: "other tab", unrelated: true }),
      err({ message: "mine too", type: "network-failed", level: undefined }),
    ]);
    expect(kept.map((e) => e.message)).toEqual(["mine", "mine too"]);
  });

  it("composes with the per-turn baseline rather than replacing it", () => {
    // An unrelated error from THIS turn and an own error from a PRIOR turn are both
    // excluded, for different reasons.
    const kept = runtimeFailuresSince(
      [
        err({ message: "old but mine", timestamp: 50 }),
        err({ message: "new but theirs", timestamp: 200, unrelated: true }),
        err({ message: "new and mine", timestamp: 200 }),
      ],
      100,
    );
    expect(kept.map((e) => e.message)).toEqual(["new and mine"]);
  });
});
