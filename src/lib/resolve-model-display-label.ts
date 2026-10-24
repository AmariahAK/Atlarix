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
import { anthropicCatalogModelId } from "@/lib/routing/custom-provider-format";

/**
 * The name another provider's list gives this model id (the catalog's: Anthropic
 * lists `claude-haiku-4-5-20251001` as "Claude Haiku 4.5"), for an endpoint of
 * your own whose own list doesn't name it. Exact id first, then the id as
 * Anthropic's catalog writes it (Bedrock's `us.anthropic.…-v1:0`).
 */
function nameFromAnyProvider(
  modelsByProviders: Record<string, LanguageModel[]> | undefined,
  apiName: string,
): string | undefined {
  if (!modelsByProviders) return undefined;
  for (const id of [...new Set([apiName, anthropicCatalogModelId(apiName)])]) {
    for (const models of Object.values(modelsByProviders)) {
      const m = models.find((x) => x.apiName === id);
      if (m?.displayName && m.displayName !== m.apiName) return m.displayName;
    }
  }
  return undefined;
}

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
    /**
     * An endpoint of your own, whatever its id looks like (the CLI's are
     * `atlarix-cli-dev-<hash>`, with no `custom::`): shown by its name, never
     * its id (15.11.1 QA: "Claude Haiku 4.5 20251001 (atlarix-cli-dev-ee0d96d8)").
     */
    customProvider?: boolean;
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

  const ownEndpoint =
    selectedModel.provider.startsWith("custom::") ||
    // The CLI's `--provider-url` endpoints, known by their id even where this
    // app has no row for them (a reply read on another profile).
    selectedModel.provider.startsWith("atlarix-cli-dev") ||
    options.customProvider === true;
  // An endpoint of your own lists a model under its raw id until something
  // names it: that is not a name.
  const named = (m: LanguageModel | undefined) =>
    m?.displayName && !(ownEndpoint && m.displayName === m.apiName) ? m.displayName : undefined;
  const providerModels = modelsByProviders?.[selectedModel.provider];
  if (providerModels) {
    const custom = providerModels.find(
      (m) => m.type === "custom" && m.id === selectedModel.customModelId,
    );
    if (named(custom)) return custom!.displayName;
    const byApi = providerModels.find((m) => m.apiName === selectedModel.name);
    if (named(byApi)) return byApi!.displayName;
  }

  // An endpoint of your own by its name, never its id ("custom::<id>", QA #26;
  // "atlarix-cli-dev-<hash>", 15.11.1), and the model by the catalog's name.
  if (ownEndpoint) {
    const model =
      nameFromAnyProvider(modelsByProviders, selectedModel.name) ??
      formatModelApiNameForDisplay(selectedModel.name);
    return options.providerName ? `${model} (${options.providerName})` : model;
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
