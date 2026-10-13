import type { LargeLanguageModel } from "@/lib/schemas";
import type { LanguageModel } from "@/ipc/ipc_types";
import type { AtlarixCoreTierPresentation } from "@/lib/atlarix-core-catalog";
import {
  displayLabelForCompassTier,
  findCatalogEntryByInternalTierId,
} from "@/lib/atlarix-core-catalog";
import { isCompassTierId } from "@/shared/compass_product_copy";
import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";

/**
 * The provider to SHOW beside a model name.
 *
 * A vendor-prefixed name (`anthropic/claude-…`) is more informative than the
 * account it came through, so the prefix wins for those — that is why this
 * function exists at all.
 *
 * For a bare name it used to return the literal `"local"`, which was wrong in
 * every case it could actually reach. Reproduced: pick a CLOUD model with an API
 * key, lose the key (the keystore bug fixed earlier this release did exactly
 * that), reopen — the provider is no longer configured, so it drops out of
 * `modelsByProviders`, the lookup above misses, and `gpt-5` rendered as
 * "GPT-5 (local)" while Atlarix Core quietly answered every message. The app
 * was telling the user the opposite of what it was doing.
 *
 * `selectedModel.provider` is the authoritative answer and was in scope the
 * whole time. Genuinely local models never reached here anyway — ollama and
 * lmstudio have their own branches above.
 */
function providerSlugFromApiName(apiName: string, provider?: string): string {
  const trimmed = apiName.trim();
  if (!trimmed.includes("/")) return provider?.trim() || "local";
  return trimmed.split("/")[0]?.toLowerCase() || "openrouter";
}

export function resolveModelDisplayLabel(
  selectedModel: LargeLanguageModel | undefined | null,
  options: {
    catalog?: AtlarixCoreTierPresentation[];
    modelsByProviders?: Record<string, LanguageModel[]>;
    ollamaDisplayName?: string;
    lmStudioDisplayName?: string;
    /** The provider's name as it was added (a custom provider's id is internal). */
    providerName?: string;
  },
): string {
  if (!selectedModel?.name) return "—";
  const { catalog = [], modelsByProviders } = options;

  if (
    selectedModel.provider === "compass" ||
    isCompassTierId(selectedModel.name)
  ) {
    const entry = findCatalogEntryByInternalTierId(catalog, selectedModel.name);
    if (entry?.labelWithProvider) return entry.labelWithProvider;
    const fromList = modelsByProviders?.compass?.find(
      (m) => m.apiName === selectedModel.name,
    )?.displayName;
    return displayLabelForCompassTier(selectedModel.name, catalog, fromList);
  }

  if (selectedModel.provider === "ollama") {
    return (
      options.ollamaDisplayName ??
      formatModelWithProvider(
        formatModelApiNameForDisplay(selectedModel.name),
        "ollama",
      )
    );
  }

  if (selectedModel.provider === "lmstudio") {
    return (
      options.lmStudioDisplayName ??
      formatModelWithProvider(
        formatModelApiNameForDisplay(selectedModel.name),
        "lmstudio",
      )
    );
  }

  const providerModels = modelsByProviders?.[selectedModel.provider];
  if (providerModels) {
    const custom = providerModels.find(
      (m) => m.type === "custom" && m.id === selectedModel.customModelId,
    );
    if (custom?.displayName) return custom.displayName;
    const byApi = providerModels.find((m) => m.apiName === selectedModel.name);
    if (byApi?.displayName) return byApi.displayName;
  }

  // A custom provider by its name, not "custom::<id>" (QA #26).
  if (selectedModel.provider.startsWith("custom::") && options.providerName) {
    return `${formatModelApiNameForDisplay(selectedModel.name)} (${options.providerName})`;
  }
  const slug = providerSlugFromApiName(
    selectedModel.name,
    selectedModel.provider,
  );
  return formatModelWithProvider(
    formatModelApiNameForDisplay(selectedModel.name),
    slug,
  );
}
