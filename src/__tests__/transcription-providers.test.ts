/**
 * The composer's transcription picker.
 *
 * The engine was de-hardcoded first (any provider id; STT model and base URL
 * resolved from the live catalog), but the menu still listed a curated three,
 * so that generality was unreachable. This list is the bridge — and it must
 * only ever offer something that would actually work: a provider with no key
 * fails at transcription time, and a provider with no audio model has nothing
 * to transcribe with.
 */

import { describe, expect, it } from "vitest";
import { buildTranscriptionProviderOptions } from "@/ipc/handlers/voice_handlers";

const AUDIO_BY_PROVIDER: Record<string, string[]> = {
  openai: ["gpt-4o-transcribe"],
  gemini: ["gemini-3-flash"],
  groq: ["whisper-large-v3-turbo"],
  // Configured, but nothing that accepts audio.
  anthropic: [],
  mistral: [],
};

const build = (configured: string[]) =>
  buildTranscriptionProviderOptions({
    configuredProviders: async () => configured,
    audioModelIds: async (id) => AUDIO_BY_PROVIDER[id] ?? [],
  });

describe("buildTranscriptionProviderOptions", () => {
  it("offers on-device first, always", async () => {
    const none = await build([]);
    expect(none).toEqual([{ id: "local", label: "On-device (free)" }]);
    const some = await build(["openai"]);
    expect(some[0].id).toBe("local");
  });

  it("lists only providers that are BOTH key-configured and audio-capable", async () => {
    const opts = await build(["openai", "anthropic", "gemini", "mistral"]);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("gemini");
    // Configured but no audio model — offering these would fail at use time.
    expect(ids).not.toContain("anthropic");
    expect(ids).not.toContain("mistral");
  });

  it("never offers a provider the user has no key for", async () => {
    const ids = (await build(["openai"])).map((o) => o.id);
    expect(ids).not.toContain("groq");
    expect(ids).not.toContain("gemini");
  });

  it("collapses google and gemini into one entry", async () => {
    // Same provider, same key — listing both would offer the same thing twice.
    const opts = await build(["google", "gemini"]);
    expect(opts.filter((o) => o.id === "gemini")).toHaveLength(1);
    expect(opts.map((o) => o.id)).not.toContain("google");
  });

  it("keeps a provider whose catalog row lacks audio but has a fallback model", async () => {
    // OpenAI/Groq ship known STT endpoints; a catalog gap shouldn't drop them.
    const ids = (
      await buildTranscriptionProviderOptions({
        configuredProviders: async () => ["groq"],
        audioModelIds: async () => [],
      })
    ).map((o) => o.id);
    expect(ids).toContain("groq");
  });

  it("labels entries from the cloud catalog", async () => {
    const opts = await build(["openai"]);
    expect(opts.find((o) => o.id === "openai")?.label).toMatch(/OpenAI/);
  });
});
