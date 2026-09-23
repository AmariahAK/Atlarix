/**
 * `voice:transcribe-model` streams: the composer gets the transcript so far as
 * it arrives (a preview), and the final return value stays the source of truth.
 * A provider failure must still come back as an error — streamText reports it
 * through onError instead of throwing, which would otherwise read as "no speech".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
      handlers[ch] = fn;
    },
  },
}));
vi.mock("@/main/settings", () => ({
  readSettings: () => ({ selectedModel: { provider: "openai", name: "m" } }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} } }),
}));
const recordAuxUsage = vi.fn();
vi.mock("@/lib/usage/turn-usage-aggregator", () => ({ recordAuxUsage }));

let script: { deltas: string[]; error?: Error } = { deltas: [] };
vi.mock("ai", () => ({
  streamText: (opts: { onError?: (e: { error: unknown }) => void }) => {
    const { deltas, error } = script;
    return {
      textStream: (async function* () {
        for (const d of deltas) yield d;
        if (error) opts.onError?.({ error });
      })(),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 3 }),
      text: Promise.resolve(deltas.join("")),
    };
  },
}));

import { registerVoiceHandlers } from "@/ipc/handlers/voice_handlers";

function fakeEvent() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    event: {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) =>
          sent.push({ channel, payload }),
      },
    },
  };
}

describe("voice:transcribe-model streaming", () => {
  beforeEach(() => {
    recordAuxUsage.mockClear();
    registerVoiceHandlers();
  });

  it("pushes the transcript so far, then returns the final text", async () => {
    script = { deltas: ["Hello", " there", " world "] };
    const { sent, event } = fakeEvent();
    const res = await handlers["voice:transcribe-model"](event, {
      mimeType: "audio/ogg",
      dataBase64: "AAAA",
      requestId: "r1",
    });
    expect(res).toEqual({ ok: true, text: "Hello there world" });
    expect(sent.map((s) => s.payload)).toEqual([
      { requestId: "r1", text: "Hello" },
      { requestId: "r1", text: "Hello there" },
      { requestId: "r1", text: "Hello there world" },
    ]);
    expect(recordAuxUsage).toHaveBeenCalledOnce();
  });

  it("returns the provider error instead of an empty transcript", async () => {
    script = { deltas: [], error: new Error("audio input not supported") };
    const { event } = fakeEvent();
    const res = await handlers["voice:transcribe-model"](event, {
      mimeType: "audio/ogg",
      dataBase64: "AAAA",
    });
    expect(res).toEqual({ ok: false, error: "audio input not supported" });
  });
});
