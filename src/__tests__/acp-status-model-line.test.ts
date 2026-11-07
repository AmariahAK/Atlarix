/**
 * /status in an editor with no Atlarix panel (Zed, JetBrains) names the model
 * and, off Atlarix, the provider it runs on; the Plan line stays the account's.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() }) },
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/cli/agent/services", () => ({
  realServices: {
    account: { email: async () => "me@example.com", balanceCents: async () => 0, kind: async () => "free" },
  },
}));

const { accountCommandText, statusModel } = await import("@/cli/acp/account-commands");
const session = { appId: 1, state: { sessionTokens: 0, costUsd: 0, contextPercent: null } } as unknown as import("@/cli/agent/session").AgentSession;

const configOptions = (currentValue: string) => [
  { id: "mode", name: "Mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] },
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue,
    options: [
      { group: "favorites", name: "Favourites", options: [{ value: "nvidia_nim/glm", name: "GLM 5.3", _meta: { atlarix: { provider: "NVIDIA NIM" } } }] },
      { group: "compass", name: "Atlarix", options: [{ value: "compass/core-auto", name: "Atlarix Auto", description: "Free" }] },
    ],
  },
] as never;

describe("/status's Model line", () => {
  it("reads the chosen row, wherever it is listed", () => {
    expect(statusModel(configOptions("nvidia_nim/glm"))).toEqual({ name: "GLM 5.3", provider: "NVIDIA NIM" });
    expect(statusModel(configOptions("compass/core-auto"))).toEqual({ name: "Atlarix Auto", provider: null });
    expect(statusModel([] as never)).toBeNull();
  });

  it("names the model and its provider off Atlarix", async () => {
    const text = await accountCommandText("status", session, [], statusModel(configOptions("nvidia_nim/glm")));
    expect(text).toContain("- Model: GLM 5.3 · NVIDIA NIM");
    expect(text).toContain("- Plan: Free");
  });

  it("names only the model on Atlarix", async () => {
    const text = await accountCommandText("status", session, [], statusModel(configOptions("compass/core-auto")));
    expect(text).toContain("- Model: Atlarix Auto\n");
    expect(text).toContain("- Plan: Free");
  });

  it("leaves the line out when the model isn't known", async () => {
    expect(await accountCommandText("status", session)).not.toContain("- Model:");
  });
});
