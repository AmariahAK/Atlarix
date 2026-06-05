import { vi } from "vitest";

/**
 * Mirror main.ts's production safety net: the AI SDK rejects aux promises
 * (usage/finishReason/…) at flush after mid-stream aborts; main.ts:76 swallows
 * NoOutputGenerated-class rejections process-wide. Without this, vitest flags
 * them as unhandled errors on every abort-path eval (loop guard, task stop).
 */
process.on("unhandledRejection", (reason: unknown) => {
  const name =
    reason && typeof reason === "object"
      ? String((reason as Error).name ?? "")
      : "";
  if (
    name.includes("NoOutputGeneratedError") ||
    name.includes("NoContentGeneratedError")
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
    getUserDataPath: () =>
      getUserDataDirOverride() ?? actual.getUserDataPath(),
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
