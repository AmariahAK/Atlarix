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

/**
 * A run against an endpoint the user named, with no key for it: refused with
 * how to give one. It went on to the app's own fallback, Atlarix Core, and
 * failed "Sign in to use Atlarix Core" (QA, ai-95). An address on this machine
 * needs no key, and a named vendor (--provider-id) may take its key from its
 * environment variable, so both run as before.
 */
export async function missingEndpointKey(o: {
  providerId?: string;
  providerUrl?: string;
  apiKey?: string;
  apiKeyFile?: string;
}): Promise<string | null> {
  if (!o.providerUrl || o.providerId || o.apiKey || o.apiKeyFile) return null;
  const { isLoopbackUrl } = await import("@/ipc/utils/get_model_client");
  if (isLoopbackUrl(o.providerUrl)) return null;
  return `--provider-url ${o.providerUrl} needs its key: --api-key-file <file> (or --api-key). Only an address on this machine runs without one.`;
}
