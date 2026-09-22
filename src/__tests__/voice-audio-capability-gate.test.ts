/**
 * Which models the microphone appears on.
 *
 * With the on-device engine deleted, dictation needs somewhere to go, and one of
 * the two routes is the selected model's own `audio` input modality. That gate is
 * resolved in MAIN and stamped onto the model row as `supportsAudioInput`, for
 * the same reason Deep thinking is: the modality registry and the Core
 * tier→vendor routing map are both main-process module state, so a renderer-side
 * lookup misses every time.
 *
 * THE CASE THAT ALREADY SHIPPED BROKEN ONCE, for reasoning: an Atlarix Core row
 * carries the synthetic provider `compass` and a TIER ID (`core-1`) as its model
 * name, and the catalog has a row for neither. Asking the registry about
 * `(compass, core-1)` therefore answers false for the entire Core lineup while
 * the identical model on BYOK answers true. The gate must resolve the tier to its
 * vendor coordinates first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron-log", () => {
  const scope = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  });
  return { default: { scope, ...scope() } };
});
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  detectAudioCapability,
  registerModelsDevVision,
} from "@/lib/routing/model-capability-profile";
import {
  setCoreModelOverrides,
  setCoreModelRouting,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import { stampDeepThinkingSupport } from "@/ipc/shared/language_model_helpers";
import type { LanguageModel } from "@/ipc/ipc_types";

/**
 * Drives the REAL stamping function, not a reconstruction of it.
 *
 * The bug worth catching is a call site that stops resolving Core tiers, and a
 * helper that rebuilt the resolver chain here would keep answering correctly
 * while the shipped one regressed — which is the whole failure mode.
 */
function stampedAudioSupport(provider: string, apiName: string): boolean {
  const row = { apiName, displayName: apiName } as LanguageModel;
  const stamped = stampDeepThinkingSupport({ [provider]: [row] });
  return stamped[provider][0].supportsAudioInput === true;
}

beforeEach(() => {
  __resetCoreModelOverridesForTests();
  registerModelsDevVision([
    // Hears. Real shape: Gemini declares `audio` on 20 catalog rows.
    {
      providerId: "google",
      modelId: "gemini-2.5-flash-lite",
      acceptsImages: true,
      acceptsPdf: true,
      acceptsAudio: true,
    },
    // Sees and reads documents but does NOT hear — the case that makes this
    // per-model rather than per-provider, on a provider that has both.
    {
      providerId: "openai",
      modelId: "gpt-6-astra",
      acceptsImages: true,
      acceptsPdf: true,
      acceptsAudio: false,
    },
    {
      providerId: "openai",
      modelId: "gpt-4o-audio-preview",
      acceptsImages: true,
      acceptsPdf: false,
      acceptsAudio: true,
    },
    // Text only. Anthropic declares audio on ZERO catalog models, which is why
    // BYOK transcription is load-bearing rather than a nicety.
    {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      acceptsImages: true,
      acceptsPdf: true,
      acceptsAudio: false,
    },
  ]);
});

describe("the audio gate is per model", () => {
  it("opens for a model that declares audio input", () => {
    expect(detectAudioCapability("google", "gemini-2.5-flash-lite")).toBe(true);
    expect(detectAudioCapability("openai", "gpt-4o-audio-preview")).toBe(true);
  });

  it("stays shut for one that does not, on the same provider", () => {
    expect(detectAudioCapability("openai", "gpt-6-astra")).toBe(false);
    expect(detectAudioCapability("anthropic", "claude-sonnet-4-6")).toBe(false);
  });

  it("stays shut for a model the catalog has never heard of", () => {
    // False is the safe answer: the mic hides instead of recording into a model
    // that will describe an attachment it cannot hear.
    expect(detectAudioCapability("openai", "gpt-99-unreleased")).toBe(false);
    expect(detectAudioCapability(undefined, "")).toBe(false);
  });
});

describe("an Atlarix Core tier resolves to its vendor before the lookup", () => {
  it("REGRESSION: the raw (compass, core-N) pair matches nothing", () => {
    // Not a hypothetical — this is what the gate did before the resolvers were
    // added, and it is how the same bug hid Deep thinking for the whole lineup.
    setCoreModelRouting({
      "core-1": { provider: "google", apiModelId: "gemini-2.5-flash-lite" },
    });
    expect(detectAudioCapability("compass", "core-1")).toBe(false);
  });

  it("…while the resolved pair answers for the model actually serving the turn", () => {
    setCoreModelRouting({
      "core-1": { provider: "google", apiModelId: "gemini-2.5-flash-lite" },
    });
    expect(stampedAudioSupport("compass", "core-1")).toBe(true);
  });

  it("follows a lineup change without a release", () => {
    // The whole reason this rides the model-row payload: `core-models:changed`
    // already invalidates it, so re-pointing a tier at a text-only model takes
    // the mic away on the next refresh with no extra wiring.
    setCoreModelRouting({
      "core-1": { provider: "google", apiModelId: "gemini-2.5-flash-lite" },
    });
    expect(stampedAudioSupport("compass", "core-1")).toBe(true);

    setCoreModelRouting({
      "core-1": { provider: "openai", apiModelId: "gpt-6-astra" },
    });
    expect(stampedAudioSupport("compass", "core-1")).toBe(false);
  });

  it("falls back to the slashed wire id when a tier has no routing block", () => {
    // An OpenRouter-routed tier carries `vendor/model` and no `routing` entry.
    setCoreModelOverrides({ "core-2": "google/gemini-2.5-flash-lite" });
    expect(stampedAudioSupport("compass", "core-2")).toBe(true);
  });

  it("leaves every non-Core provider exactly as it was", () => {
    // The resolvers are identity outside `compass`; if that ever stopped being
    // true, every BYOK model's gate would start going through a map it has no
    // entry in.
    expect(stampedAudioSupport("google", "gemini-2.5-flash-lite")).toBe(true);
    expect(stampedAudioSupport("anthropic", "claude-sonnet-4-6")).toBe(false);
  });
});
