/**
 * The header's "who": the plan on Atlarix, else the provider the turn runs on
 * ("GLM 5.3 · Build · NVIDIA NIM"). Pure, so it is tested without a renderer.
 */
import { providerLabel, withoutProviderSuffix } from "@/lib/provider-label";
// Plain data (its one import is provider-sdk-factories, the AI SDK's provider
// factories): no database, no electron.
import { CLOUD_PROVIDERS, LOCAL_PROVIDERS } from "@/ipc/shared/language_model_constants";

export type AccountKind = "signed-out" | "free" | "pro" | "payg";

export const ACCOUNT_LABEL: Record<AccountKind, string> = {
  "signed-out": "Not signed in",
  free: "Free",
  pro: "Pro",
  payg: "Pay as you go",
};

type Ref = { provider: string; name: string };

/**
 * The model the header names: the session's, else the one this terminal chose,
 * else the desktop's selected model, which is what a turn runs on then.
 */
export function headerModelRef(session: Ref | undefined, chosen: Ref | undefined, desktop: Ref | undefined): Ref | undefined {
  return session ?? chosen ?? desktop;
}

/**
 * `provider`: the provider's label once the model list has named it (or as
 * remembered in cli-state). Until then the built-in catalog's name ("NVIDIA
 * NIM"; local data, no fetch), else nothing: an internal id ("nvidia_nim",
 * "custom::my-gateway") is never shown, and the header has no provider part.
 */
export function headerAccount(model: Ref | undefined, plan: AccountKind | null, provider: string | null | undefined): string | null {
  if (!model || model.provider === "compass") return plan ? ACCOUNT_LABEL[plan] : null;
  if (provider) return provider;
  const name = (CLOUD_PROVIDERS[model.provider] ?? LOCAL_PROVIDERS[model.provider])?.displayName;
  return name ? providerLabel({ id: model.provider, name }) : null;
}

/** The model part: a custom endpoint's name is beside it already, so not in brackets too. */
export function headerModel(modelLabel: string, provider: string | null | undefined): string {
  return withoutProviderSuffix(modelLabel, provider);
}
