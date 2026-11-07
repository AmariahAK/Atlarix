/**
 * The composer's model chip names the provider beside the model ("Claude Haiku
 * 4.5 · AWS Bedrock"), muted, with the whole text as its tooltip. On Atlarix it
 * stays the model alone.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const chat = vi.hoisted(() => ({ model: { provider: "bedrock", name: "us.anthropic.claude-haiku-4-5" } as { provider: string; name: string } }));

vi.mock("@/hooks/useChatModel", () => ({ useChatModel: () => ({ model: chat.model, effort: undefined, deepThinking: false }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ settings: { selectedModel: chat.model }, updateSettings: vi.fn() }) }));
vi.mock("@/hooks/useSelectModel", () => ({ useSelectModel: () => vi.fn() }));
vi.mock("@/hooks/useModelPickerOpen", () => ({ useModelPickerOpen: () => ({ open: false, setOpen: vi.fn() }) }));
vi.mock("@/hooks/useAccountKind", () => ({ useAccountKind: () => "free", fetchAccountKind: async () => "free" }));
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({
  useLanguageModelsByProviders: () => ({
    data: {
      bedrock: [{ apiName: "us.anthropic.claude-haiku-4-5", displayName: "Claude Haiku 4.5" }],
      "custom::my-server": [{ apiName: "qwen2.5:3b", displayName: "qwen2.5:3b", type: "custom" }],
      compass: [{ apiName: "core-auto", displayName: "Atlarix Auto" }],
    },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useLanguageModelProviders", () => ({
  useLanguageModelProviders: () => ({
    data: [
      { id: "compass", name: "Atlarix Core", type: "cloud" },
      { id: "bedrock", name: "AWS Bedrock", type: "cloud" },
      { id: "openrouter", name: "OpenRouter (BYOK)", type: "cloud" },
      { id: "custom::my-server", name: "My Server", type: "custom" },
    ],
  }),
}));
vi.mock("@/hooks/useAtlarixCoreCatalog", () => ({ useAtlarixCoreCatalog: () => ({ data: [] }) }));
vi.mock("@/hooks/useLocalModels", () => ({ useLocalModels: () => ({ models: [] }) }));
vi.mock("@/hooks/useLMStudioModels", () => ({ useLocalLMSModels: () => ({ models: [] }) }));
vi.mock("@/components/billing/UpgradeActions", () => ({ UpgradeButtons: () => null }));
vi.mock("@/components/AtlarixAutoConsentDialog", () => ({ AtlarixAutoConsentDialog: () => null }));

import { ModelPicker } from "@/components/ModelPicker";

const chip = () => screen.getByTestId("model-picker-trigger");

describe("the model chip's provider", () => {
  it("names the provider of your own key, muted, with the full text as its tooltip", () => {
    chat.model = { provider: "bedrock", name: "us.anthropic.claude-haiku-4-5" };
    render(<ModelPicker />);
    expect(chip().textContent).toBe("Claude Haiku 4.5 · AWS Bedrock");
    expect(chip().getAttribute("title")).toBe("Claude Haiku 4.5 · AWS Bedrock");
    expect(screen.getByTestId("model-picker-provider").textContent).toBe(" · AWS Bedrock");
  });

  it("names a custom endpoint once", () => {
    chat.model = { provider: "custom::my-server", name: "qwen2.5:3b" };
    render(<ModelPicker />);
    // resolveModelDisplayLabel gives "Qwen2.5:3b (My Server)": the bracket isn't repeated.
    expect(chip().textContent).toBe("Qwen2.5:3b · My Server");
  });

  it("adds nothing on Atlarix", () => {
    chat.model = { provider: "compass", name: "core-auto" };
    render(<ModelPicker />);
    expect(chip().textContent).not.toContain("·");
    expect(screen.queryByTestId("model-picker-provider")).toBeNull();
  });
});
