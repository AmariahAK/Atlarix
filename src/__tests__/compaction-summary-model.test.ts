import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whose model writes the summary, and what the user is told when it cannot.
 *
 * Live, 2 of 2 (2026-10-20, a CLI session on Bedrock MiniMax M2.5): /compact
 * asked the APP's selected model (Atlarix Auto) for the summary, which was not
 * available — "Atlarix Auto isn't offered right now" — and the CLI then said
 * "Nothing to compact yet: the conversation is still short." Same class as
 * fa83d88e: a CLI, editor or user-agent session runs on its own model, and its
 * conversation must not be sent to (and billed by) one it never picked.
 */

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: async () => "s-1",
  persistWorkspaceSessionUserMessage: async () => {},
}));

const llm = vi.hoisted(() => ({
  fail: false,
  generateText: vi.fn(async () => {
    if (llm.fail) throw new Error("Atlarix Auto isn't offered right now");
    return { text: "Goal: X. Done: Y.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }),
}));
vi.mock("ai", () => ({ generateText: llm.generateText }));

const APP_MODEL = { provider: "compass", name: "auto" };
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/main/settings", () => ({ readSettings: () => settings.value }));

const asked = vi.hoisted(() => ({ models: [] as Array<{ provider: string; name: string }> }));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async (model: { provider: string; name: string }) => {
    asked.models.push(model);
    return { modelClient: { model: {} } };
  },
  getEffectiveModel: (s: { selectedModel: unknown }) => s.selectedModel,
}));
vi.mock("@/lib/context/resolve-model-context-limit", () => ({
  resolveModelContextLimit: async () => ({ tierLimit: 200_000, rawContextLength: 200_000 }),
}));

import { createStreamTransport, hydrateStreamTransport } from "@/lib/chat/stream-transport";
import { lastStreamRequest } from "@/ipc/handlers/chat_stream/stream-state";
import { forceCompactEphemeralChat } from "@/lib/tools/workspace";
import { compactResultMessage } from "@/lib/context/compact-result-message";

const SESSION_MODEL = { provider: "bedrock", name: "minimax.minimax-m2.5" };

function chatWithHistory(): number {
  const chatId = createStreamTransport(1);
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ id: i * 2 + 1, role: "user", content: `ask ${i} ${"word ".repeat(600)}` });
    rows.push({ id: i * 2 + 2, role: "assistant", content: `reply ${i} ${"word ".repeat(600)}` });
  }
  hydrateStreamTransport(chatId, rows);
  return chatId;
}

beforeEach(() => {
  llm.fail = false;
  asked.models.length = 0;
  settings.value = { selectedModel: APP_MODEL };
  lastStreamRequest.clear();
});

describe("the summary is written by the session's own model", () => {
  it("the model the caller names (the CLI's /compact)", async () => {
    const done = await forceCompactEphemeralChat(chatWithHistory(), "bedrock", { summarize: true, model: SESSION_MODEL });
    expect(done.ok).toBe(true);
    expect(asked.models).toEqual([SESSION_MODEL]);
  });

  it("else the chat's last request's model (an editor, a user agent, the overflow retry)", async () => {
    const chatId = chatWithHistory();
    lastStreamRequest.set(chatId, { chatId, prompt: "x", modelOverride: SESSION_MODEL } as never);
    await forceCompactEphemeralChat(chatId, "bedrock", { summarize: true });
    expect(asked.models).toEqual([SESSION_MODEL]);
  });

  it("the app's model only for a chat that runs on it", async () => {
    await forceCompactEphemeralChat(chatWithHistory(), undefined, { summarize: true });
    expect(asked.models).toEqual([APP_MODEL]);
  });

  it("an explicit summarization model in settings still wins", async () => {
    const custom = { provider: "openai", name: "gpt-5-mini" };
    settings.value = {
      selectedModel: APP_MODEL,
      aiConfiguration: { contextSummarization: { summarizationModel: "custom", customSummarizationModel: custom } },
    };
    await forceCompactEphemeralChat(chatWithHistory(), "bedrock", { summarize: true, model: SESSION_MODEL });
    expect(asked.models).toEqual([custom]);
  });
});

describe("a summary that fails is not 'still short'", () => {
  it("says it could not compact", async () => {
    llm.fail = true;
    const done = await forceCompactEphemeralChat(chatWithHistory(), "bedrock", { summarize: true, model: SESSION_MODEL });
    expect(done).toEqual({ ok: false, reason: "failed" });
    const said = compactResultMessage(done).message;
    expect(said).not.toMatch(/still short/);
    expect(said).toMatch(/Couldn't compact/);
  });

  it("a genuinely short chat is still 'still short'", async () => {
    const chatId = createStreamTransport(1);
    hydrateStreamTransport(chatId, [
      { id: 1, role: "user", content: "hi" },
      { id: 2, role: "assistant", content: "hello" },
    ]);
    const done = await forceCompactEphemeralChat(chatId, "bedrock", { summarize: true, model: SESSION_MODEL });
    expect(compactResultMessage(done).message).toMatch(/still short/);
  });
});

describe("a session's title comes from its own model too", () => {
  it("not the app's", async () => {
    const { resolveTitleModel } = await import("@/lib/session-title/generate-title");
    const local = { provider: "ollama", name: "qwen3:8b" };
    expect(await resolveTitleModel({ selectedModel: APP_MODEL } as never, local)).toEqual(local);
  });
});
