// @vitest-environment jsdom
/**
 * The composer's model chip names the model a chat runs on: one another
 * session set for it (item 9) wins over the app's selected model, as it does
 * for the turn (QA A15: the chip kept "Claude Haiku 4.5 (US)" while every turn
 * ran on Nova Micro).
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const models = {
  bedrock: [
    { apiName: "us.anthropic.claude-haiku-4-5", displayName: "Claude Haiku 4.5 (US)" },
    { apiName: "us.amazon.nova-micro-v1:0", displayName: "Nova Micro (US)" },
  ],
};
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { selectedModel: { provider: "bedrock", name: "us.anthropic.claude-haiku-4-5", customModelId: 7 } } }),
}));
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({ useLanguageModelsByProviders: () => ({ data: models }) }));
vi.mock("@/hooks/useLocalModels", () => ({ useLocalModels: () => ({ models: [] }) }));
vi.mock("@/hooks/useLMStudioModels", () => ({ useLocalLMSModels: () => ({ models: [] }) }));
vi.mock("@/hooks/useAtlarixCoreCatalog", () => ({ useAtlarixCoreCatalog: () => ({ data: [] }) }));
vi.mock("@/hooks/useLanguageModelProviders", () => ({
  useLanguageModelProviders: () => ({ data: [{ id: "bedrock", name: "Amazon Bedrock" }] }),
}));

describe("the model chip (QA A15)", () => {
  it("names the model another session set for the chat, not the app's selected one", async () => {
    const { useModelDisplayName } = await import("@/hooks/useModelDisplayName");
    const { resolveChatModel } = await import("@/hooks/useChatModel");
    const selected = { provider: "bedrock" as const, name: "us.anthropic.claude-haiku-4-5", customModelId: 7 };
    const peer = { provider: "bedrock", name: "us.amazon.nova-micro-v1:0", label: "Nova Micro (US)" };
    const chipModel = (settingsModel: typeof selected, p: typeof peer | undefined) =>
      resolveChatModel({ settings: { selectedModel: settingsModel }, session: null, peer: p }).model;
    const shown = chipModel(selected, peer);
    expect(shown).toEqual({ provider: "bedrock", name: "us.amazon.nova-micro-v1:0" });
    const { result } = renderHook(() => useModelDisplayName(shown));
    expect(result.current).toContain("Nova Micro");
    expect(result.current).not.toContain("Haiku");
    const none = renderHook(() => useModelDisplayName(chipModel(selected, undefined)));
    expect(none.result.current).toContain("Haiku");
  });
});
