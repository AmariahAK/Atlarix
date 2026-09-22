/**
 * The composer's transcription picker.
 *
 * The engine was de-hardcoded first (any provider id; STT model and base URL
 * resolved from the live catalog), but the menu still listed a curated three,
 * so that generality was unreachable. This list is the bridge — and it must
 * only ever offer something that would actually work: a provider with no key
 * fails at transcription time, and a provider with no audio model has nothing
 * to transcribe with.
 *
 * IT MAY NOW BE EMPTY, which it could not be before. The list used to be seeded
 * with an always-present on-device entry, so "no transcription provider" was
 * unrepresentable and every caller could assume at least one option. With the
 * local engine deleted, empty is the honest answer and it is what tells the
 * composer to fall back to the selected model's own audio input — or to hide the
 * mic. A stray fallback entry here would put back a provider the user has no key
 * for, which is the exact failure this function exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  audioFilename,
  buildTranscriptionProviderOptions,
} from "@/ipc/handlers/voice_handlers";

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
  it("is empty when nothing is configured, rather than inventing an entry", async () => {
    expect(await build([])).toEqual([]);
  });

  it("never offers the deleted on-device engine", async () => {
    // It used to be unconditionally first. Re-adding it would offer an engine
    // that no longer exists, and the mic would fail on click instead of hiding.
    const ids = (await build(["openai", "groq", "gemini"])).map((o) => o.id);
    expect(ids).not.toContain("local");
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

/**
 * The upload's FILENAME, which OpenAI validates independently of the part's
 * content type.
 *
 * The renderer no longer always records webm: `audio/ogg;codecs=opus` is asked
 * for first, because it is the one container both OpenAI's `/audio/transcriptions`
 * and Gemini's inline audio part accept (webm is absent from Gemini's list, and
 * webm is what Chromium's MediaRecorder produces by default). A hardcoded
 * `audio.webm` filename over ogg bytes is rejected with an unhelpful 400.
 */
describe("audioFilename", () => {
  it("follows the container, including the codec-parameter form", () => {
    expect(audioFilename("audio/ogg;codecs=opus")).toBe("audio.ogg");
    expect(audioFilename("audio/ogg")).toBe("audio.ogg");
    expect(audioFilename("audio/webm;codecs=opus")).toBe("audio.webm");
    expect(audioFilename("AUDIO/WAV")).toBe("audio.wav");
  });

  it("falls back to an extension OpenAI accepts, never to none", () => {
    // A name with no extension is the failure case; anything recognised beats it.
    expect(audioFilename("")).toBe("audio.webm");
    expect(audioFilename("application/octet-stream")).toBe("audio.webm");
  });
});
