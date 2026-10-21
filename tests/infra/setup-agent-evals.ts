import { vi } from "vitest";
import { isStreamStopAbort } from "@/lib/stream/stream-stop-sentinels";

/**
 * Mirror main.ts's production safety net: the AI SDK rejects aux promises
 * (usage/finishReason/…) at flush after mid-stream aborts; main.ts swallows
 * NoOutputGenerated-class rejections process-wide. Without this, vitest flags
 * them as unhandled errors on every abort-path eval (loop guard, task stop).
 * v13.3 (ai@6): detached SDK promises also reject with the intentional
 * stream-stop abort reason itself (ask_user end-turn, loop guard) AFTER the
 * turn finalized — same benign family, same swallow as main.ts.
 */
process.on("unhandledRejection", (reason: unknown) => {
  const name =
    reason && typeof reason === "object"
      ? String((reason as Error).name ?? "")
      : "";
  if (
    name.includes("NoOutputGeneratedError") ||
    name.includes("NoContentGeneratedError") ||
    isStreamStopAbort(reason)
  ) {
    return; // handled upstream or benign flush — same policy as main.ts
  }
  throw reason;
});

/**
 * Setup for the `agent-evals` vitest project (see vitest.config.ts).
 *
 * Runs IN ADDITION to ./vitest.setup.ts (electron + sentry stubs). Adds the
 * partial mocks agent evals need to drive the real `chat:stream` handler:
 *
 * - `@/paths/paths`: route `getUserDataPath()` to a per-test temp dir
 *   (real sqlite DB + app data) via tests/infra/user-data-override.ts.
 * - `@/lib/auth/supabase-client`: a fake authed session so
 *   `requireAuthSession()` passes without network.
 */
vi.mock("@/paths/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/paths/paths")>();
  const { getUserDataDirOverride } = await import("./user-data-override");
  return {
    ...actual,
    getUserDataPath: () => getUserDataDirOverride() ?? actual.getUserDataPath(),
  };
});

vi.mock("@/lib/auth/supabase-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/supabase-client")>();
  return {
    ...actual,
    getSession: vi.fn(async () => ({
      user: {
        id: "agent-eval-user",
        email: "agent-evals@test.local",
      },
      access_token: "agent-eval-token",
    })),
  };
});

/**
 * Session titling (v14.52.0) runs in the BACKGROUND the moment a first user
 * message is saved, and would send its own request to the scripted fake LLM —
 * consuming a response some scenario scripted for its turn. Evals exercise the
 * turn, not the namer, so the model call is stubbed out here; the placeholder
 * path still runs. `session-title-first-message.eval.test.ts` overrides this
 * with a controllable fake.
 */
vi.mock("@/lib/session-title/generate-title", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/session-title/generate-title")>();
  return { ...actual, generateSessionTitle: vi.fn(async () => null) };
});

/**
 * Memory recall makes a side model call on a user message when the workspace has
 * notes — the same hazard as titling above, so the call is stubbed the same way.
 * The index and change-notice paths still run; recall's own tests drive it.
 */
vi.mock("@/lib/memory/recall", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/memory/recall")>();
  return { ...actual, selectRelevantMemories: vi.fn(async () => []) };
});
