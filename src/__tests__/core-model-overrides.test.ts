/**
 * Runtime Core-tier model overrides: a hosted core-models.json can change which
 * model each Core tier uses without repackaging, with build-time env as the
 * fallback. Validates precedence, validation, and cache fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";

const { TMP } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  return {
    TMP: path.join(os.tmpdir(), `atlarix-core-models-${process.pid}-${Date.now()}`),
  };
});

vi.mock("@/paths/paths", () => ({ getUserDataPath: () => TMP }));
vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: () => {}, warn: () => {} }) },
}));

import { refreshCoreModelOverrides } from "@/lib/routing/core-model-overrides";
import {
  setCoreModelOverrides,
  isCoreModelWebSearchEnabled,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import { getOpenRouterModelIdForCoreTier } from "@/ipc/shared/compass_constants";

const ENV_KEYS = [
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
] as const;

function fetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => body });
}

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  __resetCoreModelOverridesForTests();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  await fsp.rm(TMP, { recursive: true, force: true });
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fsp.rm(TMP, { recursive: true, force: true });
});

describe("core-model-overrides", () => {
  it("a valid hosted JSON overrides the build-time env", async () => {
    process.env.ATLARIX_CORE_MODEL_1 = "env/one";
    global.fetch = fetchOk({
      version: 1,
      models: { "core-1": "ovr/one", "core-2": "ovr/two" },
    });
    await refreshCoreModelOverrides();
    expect(getOpenRouterModelIdForCoreTier("core-1")).toBe("ovr/one");
    expect(getOpenRouterModelIdForCoreTier("core-2")).toBe("ovr/two");
  });

  it("an empty/malformed JSON leaves the env fallback intact", async () => {
    process.env.ATLARIX_CORE_MODEL_1 = "env/one";
    global.fetch = fetchOk({ version: 1, models: {} });
    await refreshCoreModelOverrides();
    expect(getOpenRouterModelIdForCoreTier("core-1")).toBe("env/one");
  });

  it("drops unknown tiers and empty values (those fall back to env)", async () => {
    process.env.ATLARIX_CORE_MODEL_2 = "env/two";
    global.fetch = fetchOk({
      version: 1,
      models: { "core-1": "ovr/one", "core-2": "  ", "core-9": "nope" },
    });
    await refreshCoreModelOverrides();
    expect(getOpenRouterModelIdForCoreTier("core-1")).toBe("ovr/one");
    expect(getOpenRouterModelIdForCoreTier("core-2")).toBe("env/two");
  });

  it("falls back to the on-disk cache when the fetch fails", async () => {
    // First, a successful refresh persists the cache.
    global.fetch = fetchOk({ version: 1, models: { "core-3": "cached/three" } });
    await refreshCoreModelOverrides();
    __resetCoreModelOverridesForTests(); // simulate a fresh process

    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    await refreshCoreModelOverrides();
    expect(getOpenRouterModelIdForCoreTier("core-3")).toBe("cached/three");
  });

  it("normalizes legacy compass-* keys to core-N", async () => {
    global.fetch = fetchOk({ version: 1, models: { "compass-thinking": "ovr/three" } });
    await refreshCoreModelOverrides();
    expect(getOpenRouterModelIdForCoreTier("core-3")).toBe("ovr/three");
  });

  it("parses the optional per-tier webSearch capability (default enabled, false opts out)", async () => {
    global.fetch = fetchOk({
      version: 1,
      models: { "core-1": "ovr/one", "core-2": "ovr/two" },
      webSearch: { "core-1": false, "core-9": false, "core-2": "nope" },
    });
    await refreshCoreModelOverrides();
    expect(isCoreModelWebSearchEnabled("core-1")).toBe(false); // explicit opt-out
    expect(isCoreModelWebSearchEnabled("core-2")).toBe(true); // non-boolean dropped → default on
    expect(isCoreModelWebSearchEnabled("core-3")).toBe(true); // absent → default on
  });
});

describe("core-model-override-store precedence", () => {
  it("override wins over env; null clears back to env", () => {
    process.env.ATLARIX_CORE_MODEL_1 = "env/one";
    setCoreModelOverrides({ "core-1": "store/one" });
    expect(getOpenRouterModelIdForCoreTier("core-1")).toBe("store/one");
    setCoreModelOverrides(null);
    expect(getOpenRouterModelIdForCoreTier("core-1")).toBe("env/one");
  });
});
