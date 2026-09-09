/**
 * A session owns its work mode.
 *
 * The mode used to live only in global settings, so it belonged to the app rather
 * than to the conversation: reopening a session you had been planning in, from a
 * window whose global preference was Build, silently made the next turn a Build
 * turn — writes allowed on a thread you were only exploring, with nothing on
 * screen having changed. Two sessions open at once could not disagree at all.
 *
 * These tests pin the resolution ORDER (session > global) and the migration rule
 * (a session with no stored mode keeps resolving from the global preference, and
 * is stamped only by a deliberate pick). The DB column and its handler are
 * covered by the migration seed verification; what is easy to regress is the
 * precedence, so that is what is asserted here.
 */
import { describe, expect, it } from "vitest";
import { resolveEffectiveWorkMode } from "@/lib/work-mode";

/**
 * How the renderer resolves the mode to SHOW, and how a turn resolves the mode to
 * RUN — the two must agree, or the chip advertises one mode while the sandbox
 * enforces another. Both read the session first and fall back to the global.
 */
function resolveForTurn(args: {
  sessionWorkMode: "ask" | "plan" | "build" | "debug" | "review" | null;
  globalPreference: "ask" | "plan" | "build" | "debug" | "review";
  perTurnOverride?: "ask" | "plan" | "build" | "debug" | "review";
}) {
  return resolveEffectiveWorkMode({
    // This mirrors useStreamChat: the per-turn override (edit/resend, plan panel,
    // automation) wins, else the session's stored mode is sent as the override.
    workModeOverride: args.perTurnOverride ?? args.sessionWorkMode ?? undefined,
    intentMode: "ask",
    workModePreference: args.globalPreference,
    selectedChatMode: "ask",
  });
}

describe("a session's stored mode beats the global preference", () => {
  it("runs the SESSION's mode, not the window's", () => {
    // The exact reported shape: planning in this session, global says build.
    expect(
      resolveForTurn({ sessionWorkMode: "plan", globalPreference: "build" }),
    ).toBe("plan");
  });

  it("keeps two sessions from colliding", () => {
    const globalPreference = "build" as const;
    expect(resolveForTurn({ sessionWorkMode: "plan", globalPreference })).toBe(
      "plan",
    );
    expect(
      resolveForTurn({ sessionWorkMode: "review", globalPreference }),
    ).toBe("review");
    // …and neither is disturbed by the global they share.
    expect(resolveForTurn({ sessionWorkMode: "ask", globalPreference })).toBe(
      "ask",
    );
  });

  it("a per-turn override still wins over the session (edit/resend, plan panel)", () => {
    expect(
      resolveForTurn({
        sessionWorkMode: "ask",
        globalPreference: "ask",
        perTurnOverride: "build",
      }),
    ).toBe("build");
  });
});

describe("sessions with no stored mode (every row written before the column)", () => {
  // The migration rule the owner chose: legacy sessions read the global until a
  // mode is deliberately picked in them. Nothing silently acquires a mode.
  it("falls back to the global preference, exactly as before", () => {
    expect(
      resolveForTurn({ sessionWorkMode: null, globalPreference: "debug" }),
    ).toBe("debug");
    expect(
      resolveForTurn({ sessionWorkMode: null, globalPreference: "plan" }),
    ).toBe("plan");
  });

  it("following the global is not the same as being stamped with it", () => {
    // A legacy session reads "build" today…
    expect(
      resolveForTurn({ sessionWorkMode: null, globalPreference: "build" }),
    ).toBe("build");
    // …and if the global later moves, it moves with it — because it still has no
    // mode of its own. Stamping on OPEN instead would have frozen it to whatever
    // the preference happened to be at that moment, which nobody chose.
    expect(
      resolveForTurn({ sessionWorkMode: null, globalPreference: "review" }),
    ).toBe("review");
  });

  it("once stamped, it stops following the global", () => {
    expect(
      resolveForTurn({ sessionWorkMode: "plan", globalPreference: "review" }),
    ).toBe("plan");
  });
});
