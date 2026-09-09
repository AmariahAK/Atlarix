import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Make the non-dev branch deterministic regardless of whether createRequire picks
// up vitest's module mocking: if it does, isPackaged=true → not dev; if it bypasses
// and the real electron require throws, that also resolves to not-dev.
vi.mock("electron", () => ({ app: { isPackaged: true } }));

vi.mock("@/ipc/utils/read_env", () => ({
  getEnvVar: (k: string) =>
    (
      ({
        COMPASS_OPENROUTER_API_KEY: " sk-dev-core ",
        ATLARIX_CORE_MODEL_1: " deepseek/deepseek-v4-pro ",
      }) as Record<string, string>
    )[k],
}));

import {
  __resetDevCoreCacheForTests,
  getDevCoreApiKey,
  getDevCoreModelId,
} from "@/ipc/utils/dev_core_env";
import { CORE_TIER_1, CORE_TIER_2 } from "@/ipc/shared/compass_constants";

describe("dev_core_env (dev-only Core creds)", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  beforeEach(() => __resetDevCoreCacheForTests());
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
    __resetDevCoreCacheForTests();
  });

  it("reads local-shell Core creds in a development build", () => {
    process.env.NODE_ENV = "development";
    expect(getDevCoreApiKey()).toBe("sk-dev-core");
    expect(getDevCoreModelId(CORE_TIER_1)).toBe("deepseek/deepseek-v4-pro");
    expect(getDevCoreModelId(CORE_TIER_2)).toBeUndefined(); // not in mock env
    expect(getDevCoreModelId("core-unknown")).toBeUndefined();
  });

  it("returns undefined outside a development/unpackaged build (release-safe)", () => {
    process.env.NODE_ENV = "test"; // not 'development' → gated off
    expect(getDevCoreApiKey()).toBeUndefined();
    expect(getDevCoreModelId(CORE_TIER_1)).toBeUndefined();
  });
});
