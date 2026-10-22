/**
 * `--api-key-file` with `--provider-url` (QA A4, 2026-10-22): the key was pinned
 * under `--provider-id` ("anthropic") while the run talks to the seeded custom
 * provider `atlarix-headless`, so the run said "there is none for
 * atlarix-headless" and a Bedrock run could only take its key through
 * `--api-key`, in plaintext in user-settings.json.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/ipc/shared/provider_api_keys", () => ({
  getProviderApiKey: async () => undefined,
}));

import { pinApiKeyFile } from "@/headless/api-key-file";
import { headlessProviderSeed } from "@/headless/headless-runner";
import {
  getPinnedProviderKey,
  setPinnedProviderKey,
} from "@/ipc/shared/pinned-provider-key";
import { hasUsableProviderKey } from "@/ipc/utils/get_model_client";

const BEDROCK = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1";

function keyFile(key = "sk-test-123\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-keyfile-"));
  const f = path.join(dir, "key.txt");
  fs.writeFileSync(f, key);
  return f;
}

afterEach(() => {
  for (const id of ["anthropic", "atlarix-headless", "openrouter"]) setPinnedProviderKey(id, null);
});

describe("--api-key-file", () => {
  it("with --provider-id anthropic --provider-url, the run's own provider has the key", async () => {
    const f = keyFile();
    const provider = { id: "anthropic", baseUrl: BEDROCK, authHeader: "bearer" as const };
    expect(pinApiKeyFile(f, provider)).toEqual({ providerId: "atlarix-headless" });
    const runs = headlessProviderSeed({ ...provider, model: "m" }).providerId;
    expect(getPinnedProviderKey(runs)).toBe("sk-test-123");
    expect(
      await hasUsableProviderKey(runs, {} as never, {
        id: runs,
        name: "Atlarix Headless",
        type: "custom",
        apiBaseUrl: BEDROCK,
      }),
    ).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("works with --provider-url alone (an OpenAI-compatible endpoint)", () => {
    const f = keyFile();
    expect(pinApiKeyFile(f, { baseUrl: "https://api.example.com/v1" })).toEqual({ providerId: "atlarix-headless" });
    expect(getPinnedProviderKey("atlarix-headless")).toBe("sk-test-123");
  });

  it("a built-in provider without an address keeps its own id", () => {
    expect(pinApiKeyFile(keyFile(), { id: "openrouter" })).toEqual({ providerId: "openrouter" });
    expect(getPinnedProviderKey("openrouter")).toBe("sk-test-123");
  });

  it("refuses Core, no provider at all, and an empty file", () => {
    expect(pinApiKeyFile(keyFile(), { id: "compass" })).toHaveProperty("error");
    expect(pinApiKeyFile(keyFile(), {})).toHaveProperty("error");
    expect(pinApiKeyFile(keyFile("  \n"), { id: "anthropic" })).toHaveProperty("error");
  });
});
