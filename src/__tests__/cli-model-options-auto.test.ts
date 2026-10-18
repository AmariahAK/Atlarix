import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ kind: "free" as string }));

vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [{ id: "compass", name: "Atlarix" }],
  getLanguageModelsByProviders: async () => ({
    compass: [
      { apiName: "core-auto", displayName: "Atlarix Auto", description: "Free · prompts are shared with model providers", contextWindow: 128_000 },
      { apiName: "core-1", displayName: "Glm 5.3", description: "", contextWindow: 200_000 },
    ],
  }),
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/ipc/utils/token_utils", () => ({
  getContextWindow: async (m: { name: string }) => (m.name === "core-1" ? 1_000_000 : 128_000),
}));
vi.mock("@/cli/agent/services", () => ({ realServices: { account: { kind: async () => state.kind } } }));

import { loadModelOptions } from "@/cli/agent/models";

const auto = async () => (await loadModelOptions()).find((o) => o.name === "core-auto")!;

beforeEach(() => {
  state.kind = "free";
});

describe("Atlarix Auto in the terminal's model list", () => {
  it("says Free on a free account", async () => {
    expect(await auto()).toMatchObject({ free: true, detail: "Free · prompts are shared with model providers · 128K context" });
  });

  it.each(["pro", "payg"])("is not Free on a %s account, which pays for it", async (kind) => {
    state.kind = kind;
    expect(await auto()).toMatchObject({ free: false, detail: "128K context", context: "128K" });
  });
});

describe("a Core model's window in the terminal's model list", () => {
  it("is the one the context meter uses, not the row's placeholder", async () => {
    const core1 = (await loadModelOptions()).find((o) => o.name === "core-1")!;
    expect(core1).toMatchObject({ context: "1M", detail: "1M context" });
  });
});
