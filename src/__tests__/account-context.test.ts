/**
 * At sign-in: the crash reporter learns the account id, and the account's
 * first surface, version and OS are recorded once per process. Most new
 * accounts never ran a turn, so where they started was never known
 * (owner, 2026-10-23).
 */
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAccountContextForTests, noteSessionAtStart, noteSignedIn, noteSignedOut } from "@/lib/analytics/account-context";

let stored: { user: { id: string } } | null = null;
vi.mock("@/lib/auth/supabase-client", () => ({ getSession: async () => stored }));

const ID = "3f0c1b9e-5a2d-4c1e-9b7a-2d6e8f1a4c3b";
const setUser = vi.fn();
const record = vi.fn(async () => {});

beforeEach(() => {
  setUser.mockClear();
  record.mockClear();
  __setAccountContextForTests({ setUser, record });
  delete process.env.ATLARIX_HOST_TELEMETRY;
  delete process.env.ATLARIX_REPORT_SURFACE;
  stored = null;
});
afterEach(() => {
  __setAccountContextForTests(null);
  delete process.env.ATLARIX_HOST_TELEMETRY;
  delete process.env.ATLARIX_REPORT_SURFACE;
});

describe("account context at sign-in", () => {
  it("gives Sentry the id only, and records surface, version and OS once per account", async () => {
    process.env.ATLARIX_REPORT_SURFACE = "vscode";
    await noteSignedIn(ID);
    await noteSignedIn(ID); // every session refresh calls it again
    expect(setUser).toHaveBeenCalledWith({ id: ID });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ p_surface: "vscode", p_os: os.platform() }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/@/);
  });

  it("records a second account signed in on the same process", async () => {
    await noteSignedIn(ID);
    await noteSignedIn("9a1b2c3d-0000-4000-8000-000000000001");
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to us when the editor's own telemetry is off", async () => {
    process.env.ATLARIX_HOST_TELEMETRY = "off";
    await noteSignedIn(ID);
    expect(record).not.toHaveBeenCalled();
  });

  it("never breaks sign-in when the record fails", async () => {
    record.mockRejectedValueOnce(new Error("offline"));
    await expect(noteSignedIn(ID)).resolves.toBeUndefined();
  });

  it("clears the crash reporter's user at sign-out", async () => {
    await noteSignedIn(ID);
    await noteSignedOut();
    expect(setUser).toHaveBeenLastCalledWith(null);
  });

  it("the terminal and the editors record the stored account when a session starts, and nothing signed out", async () => {
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    await noteSessionAtStart();
    expect(record).not.toHaveBeenCalled();
    stored = { user: { id: ID } };
    await noteSessionAtStart();
    expect(setUser).toHaveBeenCalledWith({ id: ID });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ p_surface: "acp" }));
  });
});
