import { describe, it, expect } from "vitest";
import {
  db,
  beginDatabaseClosing,
  isDatabaseClosing,
  DatabaseClosingError,
} from "@/db/index";

describe("database closing guard", () => {
  it("short-circuits db access with DatabaseClosingError once shutdown begins", () => {
    expect(isDatabaseClosing()).toBe(false);
    beginDatabaseClosing();
    expect(isDatabaseClosing()).toBe(true);
    // Any property access on the db proxy now throws the recognizable error
    // instead of an opaque "connection is not open" deep in a query.
    expect(() => db.select).toThrow(DatabaseClosingError);
  });

  /**
   * The guard's error NAME is part of its contract, not an implementation detail.
   *
   * `main.ts`'s `browser-window-focus` handler matches on `err.name ===
   * "DatabaseClosingError"` to tell an expected shutdown race apart from a real
   * failure — by name rather than `instanceof`, because the error crosses a
   * dynamic-import boundary. Renaming the class would not break a build; it would
   * quietly downgrade that branch, and the noise would come back.
   */
  it("throws under the exact name callers match on", () => {
    let caught: unknown;
    try {
      void db.select;
    } catch (e) {
      caught = e;
    }
    expect((caught as { name?: string })?.name).toBe("DatabaseClosingError");
  });

  /**
   * And the path that actually produced the paging alert: this broadcast reads the
   * `apps` table and is fired from a focus event, which keeps arriving while the
   * app tears down. It must surface as a REJECTION so the caller's `.catch` can
   * see it — before that catch existed, this became an unhandled rejection and
   * reached Sentry as `handled = no`.
   */
  it("surfaces as a rejection from the workspace-path broadcast", async () => {
    const { broadcastWorkspacePathStatusesIfChanged } = await import(
      "@/ipc/utils/workspace_path_status_broadcast"
    );
    await expect(broadcastWorkspacePathStatusesIfChanged()).rejects.toMatchObject(
      { name: "DatabaseClosingError" },
    );
  });
});
