/**
 * Provider model-listing accuracy.
 *
 * Two invariants this locks down:
 *
 *  1. The native `/models` fetchers must not list models that can't drive the
 *     tool loop. The models.dev path always enforced this; the native path
 *     didn't, so "first-class" providers leaked image/realtime/guard models
 *     into the picker while the long tail stayed clean.
 *  2. Provider ids must resolve to their models.dev counterparts. An unmapped
 *     id is silent: Bedrock (no native fetcher) listed ZERO models, and NVIDIA
 *     NIM lost its limit/cost enrichment and fell back to a guessed context
 *     window — with nothing logged either time.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { LanguageModel } from "@/ipc/ipc_types";

// Seeding the catalog goes through refreshModelsDev, which also persists a
// disk cache. Point that at a temp dir: the real path is the dev app's
// userData, and a fixture catalog written there would leave the running app
// believing there are four providers in the world.
const TMP_USER_DATA = path.join(os.tmpdir(), "atlarix-provider-accuracy-test");
vi.mock("@/paths/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/paths/paths")>()),
  getUserDataPath: () => TMP_USER_DATA,
}));
import {
  annotateToolCapability,
  getAudioInputModelIds,
  getModelsDevCatalogRows,
  getModelsDevProviderCatalog,
  getModelsFromModelsDev,
  getProviderApiBaseUrl,
  refreshModelsDev,
  resetModelsDevCache,
} from "@/lib/models_dev";

const CATALOG = {
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5.6": {
        name: "GPT-5.6",
        tool_call: true,
        limit: { context: 400000, output: 128000 },
      },
      "gpt-image-2": { name: "GPT Image 2", tool_call: false },
      o3: {
        name: "o3",
        tool_call: true,
        limit: { context: 200000, output: 100000 },
      },
      "gpt-4o-transcribe": {
        name: "GPT-4o Transcribe",
        tool_call: false,
        modalities: { input: ["audio"], output: ["text"] },
      },
      "gpt-legacy-transcribe": {
        name: "Legacy Transcribe",
        tool_call: false,
        status: "deprecated",
        modalities: { input: ["audio"], output: ["text"] },
      },
    },
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    api: "https://bedrock-runtime.amazonaws.com",
    env: ["AWS_BEARER_TOKEN_BEDROCK"],
    models: {
      "us.anthropic.claude-sonnet-4": {
        name: "Claude Sonnet 4",
        tool_call: true,
        limit: { context: 200000, output: 64000 },
      },
    },
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    api: "https://integrate.api.nvidia.com/v1",
    env: ["NVIDIA_NIM_API_KEY"],
    models: {
      "meta/llama-3.3-70b-instruct": {
        name: "Llama 3.3 70B",
        tool_call: true,
        limit: { context: 128000, output: 32768 },
        cost: { input: 0.12, output: 0.3 },
      },
      "nvidia/nemotron-safety": { name: "Nemotron Safety", tool_call: false },
    },
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    api: "https://api.perplexity.ai",
    env: ["PERPLEXITY_API_KEY"],
    models: {
      sonar: {
        name: "Sonar",
        tool_call: false,
        limit: { context: 128000, output: 4096 },
      },
      "sonar-pro": {
        name: "Sonar Pro",
        tool_call: false,
        limit: { context: 200000, output: 8192 },
      },
    },
  },
};

const cloud = (
  apiName: string,
  extra: Partial<LanguageModel> = {},
): LanguageModel =>
  ({
    apiName,
    displayName: apiName,
    description: "",
    type: "cloud",
    ...extra,
  }) as LanguageModel;

beforeEach(async () => {
  resetModelsDevCache();
  // Seed the catalog through the public refresh path — on a 200 it calls
  // setCachedData directly, so no disk cache or network is consulted after.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => CATALOG })),
  );
  await refreshModelsDev({ notify: false });
});

afterAll(async () => {
  await fs.rm(TMP_USER_DATA, { recursive: true, force: true }).catch(() => {});
});

describe("tool-capability funnel (annotateToolCapability)", () => {
  it("drops models the catalog explicitly marks as non-tool-calling", async () => {
    const out = await annotateToolCapability("openai", [
      cloud("gpt-5.6"),
      cloud("gpt-image-2"),
      cloud("o3"),
    ]);
    expect(out.map((m) => m.apiName)).toEqual(["gpt-5.6", "o3"]);
  });

  it("marks surviving models as tool-capable", async () => {
    const [model] = await annotateToolCapability("openai", [cloud("gpt-5.6")]);
    expect(model.type === "cloud" && model.supportsToolChoice).toBe(true);
  });

  it("KEEPS models the catalog has never heard of", async () => {
    // The whole point of native fetch is beating the hourly catalog. Dropping
    // unknown ids would trade an accuracy bug for a freshness bug.
    const out = await annotateToolCapability("openai", [
      cloud("gpt-6-unreleased"),
    ]);
    expect(out.map((m) => m.apiName)).toEqual(["gpt-6-unreleased"]);
  });

  it("respects a fetcher that deliberately declared supportsToolChoice: false", async () => {
    // Perplexity's Sonar family is non-tool-calling by design but still worth
    // listing; the funnel must not drop it out from under the fetcher.
    const out = await annotateToolCapability("perplexity", [
      cloud("sonar", { supportsToolChoice: false }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type === "cloud" && out[0].supportsToolChoice).toBe(false);
  });

  it("returns input untouched for a provider models.dev doesn't know", async () => {
    const input = [cloud("some-model"), cloud("another")];
    await expect(
      annotateToolCapability("not-a-provider", input),
    ).resolves.toEqual(input);
  });

  it("returns input untouched when the catalog is empty", async () => {
    // Cold first run with no disk cache and no network: models.dev resolves to
    // {}. The funnel must degrade to today's behaviour, never to an empty picker.
    resetModelsDevCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await refreshModelsDev({ notify: false });
    const input = [cloud("gpt-image-2")];
    await expect(annotateToolCapability("openai", input)).resolves.toEqual(
      input,
    );
  });

  it("matches OpenRouter-style vendor/model ids against bare catalog ids", async () => {
    const out = await annotateToolCapability("openai", [
      cloud("openai/gpt-image-2"),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("provider id mapping", () => {
  it("resolves bedrock to the amazon-bedrock catalog", async () => {
    // Bedrock has NO native fetcher, so models.dev is its only source. Before
    // the mapping existed this returned [] and the provider looked empty.
    const models = await getModelsFromModelsDev("bedrock");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].apiName).toBe("us.anthropic.claude-sonnet-4");
  });

  it("resolves nvidia_nim to the nvidia catalog with real limits and cost", async () => {
    const models = await getModelsFromModelsDev("nvidia_nim");
    const llama = models.find(
      (m) => m.apiName === "meta/llama-3.3-70b-instruct",
    );
    expect(llama?.contextWindow).toBe(128000);
    expect(llama?.type === "cloud" && llama.cost).toEqual({
      input: 0.12,
      output: 0.3,
    });
  });

  it("reverse-maps both ids so the long tail doesn't duplicate built-in providers", async () => {
    const ids = (await getModelsDevProviderCatalog()).map((p) => p.id);
    expect(ids).toContain("bedrock");
    expect(ids).toContain("nvidia_nim");
    // The raw models.dev ids must NOT leak through — they'd sail past the
    // de-dup in getLanguageModelProviders and show up twice in the picker.
    expect(ids).not.toContain("amazon-bedrock");
    expect(ids).not.toContain("nvidia");
  });
});

describe("voice transcription catalog lookups", () => {
  it("finds audio-input models and skips deprecated ones", async () => {
    // Voice used to pin `gemini-2.0-flash` / `gpt-4o-transcribe` in the handler;
    // sourcing them from the catalog keeps STT off that treadmill.
    await expect(getAudioInputModelIds("openai")).resolves.toEqual([
      "gpt-4o-transcribe",
    ]);
  });

  it("returns an empty list for a provider with no audio models", async () => {
    await expect(getAudioInputModelIds("perplexity")).resolves.toEqual([]);
    await expect(getAudioInputModelIds("not-a-provider")).resolves.toEqual([]);
  });

  it("resolves a provider's API base URL, honouring the id map", async () => {
    await expect(getProviderApiBaseUrl("openai")).resolves.toBe(
      "https://api.openai.com/v1",
    );
    await expect(getProviderApiBaseUrl("nvidia_nim")).resolves.toBe(
      "https://integrate.api.nvidia.com/v1",
    );
    await expect(
      getProviderApiBaseUrl("not-a-provider"),
    ).resolves.toBeUndefined();
  });
});

describe("getModelsDevCatalogRows", () => {
  it("gates on tool_call by default", async () => {
    await expect(getModelsDevCatalogRows("perplexity")).resolves.toEqual([]);
  });

  it("returns the non-tool-calling family when the gate is lifted", async () => {
    const rows = await getModelsDevCatalogRows("perplexity", {
      requireToolCall: false,
    });
    expect(rows.map((m) => m.apiName).sort()).toEqual(["sonar", "sonar-pro"]);
    // Real limits the old hardcoded Perplexity list omitted entirely.
    expect(rows.find((m) => m.apiName === "sonar-pro")?.contextWindow).toBe(
      200000,
    );
  });
});
