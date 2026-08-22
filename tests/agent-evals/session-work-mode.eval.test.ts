import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";

/**
 * `sessions:set-work-mode` against a REAL database.
 *
 * The unit tests cover precedence (session beats global). What they cannot cover
 * is the part that only exists once there is a table: that the column round-trips,
 * that a session starts with NO mode rather than a defaulted one, and that a
 * junk mode is refused before it reaches the DB. A stored mode decides whether a
 * turn may write to the workspace, so an unvalidated string landing in that
 * column is a permission bug, not a data-quality one.
 */

let ctx: EvalContext;

async function call(channel: string, ...args: unknown[]) {
  const handler = await getIpcHandler(channel);
  return (handler as unknown as (e: unknown, ...a: unknown[]) => Promise<unknown>)(
    {},
    ...args,
  );
}

beforeAll(async () => {
  ctx = await setupEvalContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("sessions:set-work-mode", () => {
  it("starts with no stored mode, then keeps what is set", async () => {
    const created = (await call("sessions:create", ctx.appId)) as {
      id: string;
      workMode: string | null;
    };

    // NULL, not a default. A new session resolves from the global preference
    // until someone deliberately picks a mode in it — the same rule that keeps
    // every session written before this column behaving as it always did.
    expect(created.workMode).toBeNull();

    const updated = (await call("sessions:set-work-mode", created.id, "plan")) as {
      workMode: string | null;
    };
    expect(updated.workMode).toBe("plan");

    // And it survives a re-read, which is the whole point: reopening the session
    // from a window whose global preference says Build must still give you Plan.
    const listed = (await call("sessions:list", ctx.appId)) as Array<{
      id: string;
      workMode: string | null;
    }>;
    expect(listed.find((s) => s.id === created.id)?.workMode).toBe("plan");
  });

  it("can be changed again", async () => {
    const created = (await call("sessions:create", ctx.appId)) as { id: string };
    await call("sessions:set-work-mode", created.id, "review");
    const after = (await call("sessions:set-work-mode", created.id, "debug")) as {
      workMode: string | null;
    };
    expect(after.workMode).toBe("debug");
  });

  it("refuses a mode that is not a mode", async () => {
    const created = (await call("sessions:create", ctx.appId)) as { id: string };
    // A mode gates workspace writes, so this has to fail before the DB, not be
    // sanitized after it.
    for (const junk of ["", "BUILD", "yolo", "build; drop table", null, 7, {}]) {
      await expect(
        call("sessions:set-work-mode", created.id, junk),
      ).rejects.toThrow(/Invalid work mode/);
    }
    const listed = (await call("sessions:list", ctx.appId)) as Array<{
      id: string;
      workMode: string | null;
    }>;
    expect(listed.find((s) => s.id === created.id)?.workMode).toBeNull();
  });

  it("reports a missing session instead of silently doing nothing", async () => {
    await expect(
      call("sessions:set-work-mode", "no-such-session", "build"),
    ).rejects.toThrow(/not found/i);
  });
});
