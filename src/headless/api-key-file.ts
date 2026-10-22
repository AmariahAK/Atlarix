/**
 * `--api-key-file`: the user's own provider key, read once, the file deleted,
 * the key held in memory only (pinned-provider-key.ts), like `--api-key`'s.
 * Never written to user-settings.json, and never put in the environment.
 *
 * The key is pinned under the provider id the RUN uses. With `--provider-url`
 * that is the seeded custom provider (`atlarix-headless`), whatever
 * `--provider-id` says: pinning it under "anthropic" left the run keyless
 * ("there is none for atlarix-headless"), so a Bedrock run could only take its
 * key through `--api-key`, in plaintext on disk (QA A4, 2026-10-22).
 */
import fs from "node:fs";
import { setPinnedProviderKey } from "@/ipc/shared/pinned-provider-key";
import { headlessProviderSeed } from "./headless-runner";

export function pinApiKeyFile(
  file: string,
  provider: { id?: string; baseUrl?: string; authHeader?: "x-api-key" | "bearer" },
): { providerId: string } | { error: string } {
  if (provider.id === "compass") {
    return { error: "--api-key-file is for your own provider's key, not Atlarix Core (use --core-token-file)" };
  }
  if (!provider.id && !provider.baseUrl) {
    return { error: "--api-key-file needs --provider-id (e.g. anthropic) or --provider-url" };
  }
  let providerId: string;
  try {
    providerId = headlessProviderSeed({ ...provider, model: "" }).providerId;
  } catch (e) {
    return { error: (e as Error).message };
  }
  const key = fs.readFileSync(file, "utf8");
  fs.rmSync(file, { force: true });
  if (!key.trim()) return { error: "the --api-key-file was empty" };
  setPinnedProviderKey(providerId, key);
  return { providerId };
}
