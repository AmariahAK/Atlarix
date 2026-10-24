/**
 * What the composer shows as a chat's model and effort (15.11.1): a peer-set
 * model, else the chat's stored choice, else the app's default. And the stored
 * shape round-trips.
 */
import { describe, expect, it } from "vitest";
import { resolveChatModel } from "@/hooks/useChatModel";
import {
  defaultSessionModel,
  defaultSessionWorkMode,
  parseSessionModel,
  serializeSessionModel,
} from "@/lib/session-choices";

const settings = {
  selectedModel: { provider: "anthropic", name: "claude-haiku-4-5" },
  effort: "max",
  deepThinking: true,
};

describe("resolveChatModel", () => {
  it("a chat with its own choice shows it, not the app's pick", () => {
    const r = resolveChatModel({
      settings,
      session: { provider: "openai", name: "gpt-5", effort: "low", deepThinking: false },
      peer: undefined,
    });
    expect(r).toEqual({ model: { provider: "openai", name: "gpt-5" }, effort: "low", deepThinking: false });
  });

  it("a chat with nothing stored shows the app's default", () => {
    expect(resolveChatModel({ settings, session: null, peer: undefined })).toEqual({
      model: settings.selectedModel,
      effort: "max",
      deepThinking: true,
    });
  });

  it("a model another session set wins; its effort stays only for the same model", () => {
    const session = { provider: "openai", name: "gpt-5", effort: "low" };
    expect(resolveChatModel({ settings, session, peer: { provider: "openai", name: "gpt-5" } }).effort).toBe("low");
    const other = resolveChatModel({ settings, session, peer: { provider: "bedrock", name: "nova" } });
    expect(other).toEqual({ model: { provider: "bedrock", name: "nova" }, effort: undefined, deepThinking: false });
  });
});

describe("the stored choice", () => {
  it("round-trips, keeps a custom model's id, and reads junk as nothing", () => {
    const c = { provider: "custom::x", name: "m", customModelId: 7, effort: "high", deepThinking: false };
    expect(parseSessionModel(serializeSessionModel(c))).toEqual(c);
    expect(parseSessionModel(null)).toBeNull();
    expect(parseSessionModel("{not json")).toBeNull();
    expect(parseSessionModel(JSON.stringify({ provider: "", name: "m" }))).toBeNull();
  });

  it("a new chat starts with the app's current model, effort and resolved mode", () => {
    expect(defaultSessionModel(settings)).toEqual({ ...settings.selectedModel, effort: "max", deepThinking: true });
    expect(defaultSessionModel({ selectedModel: undefined as never })).toBeNull();
    expect(defaultSessionWorkMode({ intentMode: "ask", workModePreference: "debug", selectedChatMode: "ask" })).toBe("debug");
    expect(defaultSessionWorkMode({ intentMode: "auto", workModePreference: "debug", selectedChatMode: "build" })).toBe("build");
  });
});
