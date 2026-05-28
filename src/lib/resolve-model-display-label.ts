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

function providerSlugFromApiName(apiName: string): string {
  const trimmed = apiName.trim();
  if (!trimmed.includes("/")) return "local";
  return trimmed.split("/")[0]?.toLowerCase() || "openrouter";
}

export function resolveModelDisplayLabel(
  selectedModel: LargeLanguageModel | undefined | null,
  options: {
    catalog?: AtlarixCoreTierPresentation[];
    modelsByProviders?: Record<string, LanguageModel[]>;
    ollamaDisplayName?: string;
    lmStudioDisplayName?: string;
  },
): string {
  if (!selectedModel?.name) return "—";
  const { catalog = [], modelsByProviders } = options;

  if (selectedModel.provider === "auto") {
    return "Select a model";
  }

  if (
    selectedModel.provider === "compass" ||
    isCompassTierId(selectedModel.name)
  ) {
    const entry = findCatalogEntryByInternalTierId(catalog, selectedModel.name);
    if (entry?.labelWithProvider) return entry.labelWithProvider;
    const fromList = modelsByProviders?.compass?.find(
      (m) => m.apiName === selectedModel.name,
    )?.displayName;
    return displayLabelForCompassTier(
      selectedModel.name,
      catalog,
      fromList,
    );
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

  const slug = providerSlugFromApiName(selectedModel.name);
  return formatModelWithProvider(
    formatModelApiNameForDisplay(selectedModel.name),
    slug,
  );
}
