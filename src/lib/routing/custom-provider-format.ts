/**
 * Providers the user added that speak the Anthropic Messages API rather than
 * OpenAI's (Bedrock's /anthropic endpoint, gateways, proxies).
 *
 * Their wire id is their own (`custom::my-gateway`), but every capability that
 * keys on Anthropic — extended thinking, /effort levels, cache markers — belongs
 * to them too, and the catalog row that answers is Anthropic's. So capability
 * lookups translate the id here instead of each checking `=== "anthropic"`.
 *
 * MAIN-PROCESS state, like the models.dev registries: written by
 * `getLanguageModelProviders` each time it reads the providers table, which
 * every model list and every model client goes through first.
 */

const anthropicFormat = new Set<string>();

/** Replace the set from the providers just read. */
export function rememberCustomProviderFormats(
  providers: ReadonlyArray<{ id: string; apiFormat?: string }>,
): void {
  anthropicFormat.clear();
  for (const p of providers) {
    if (p.apiFormat === "anthropic") anthropicFormat.add(p.id);
  }
}

/** A provider the user added that speaks the Anthropic format. */
export function isCustomAnthropicFormat(providerId: string | undefined): boolean {
  return Boolean(providerId && anthropicFormat.has(providerId));
}

/** The provider id capability lookups use: `anthropic` for these, else unchanged. */
export function anthropicFormatCapabilityId<T extends string | undefined>(
  providerId: T,
): T | "anthropic" {
  return isCustomAnthropicFormat(providerId) ? "anthropic" : providerId;
}

/**
 * A model id as Anthropic's own catalog names it. Bedrock prefixes a region
 * scope and the vendor and suffixes a version (`us.anthropic.claude-haiku-4-5-
 * 20251001-v1:0`); the catalog row is `claude-haiku-4-5-20251001`.
 */
export function anthropicCatalogModelId(modelId: string): string {
  return modelId
    .trim()
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./i, "")
    .replace(/-v\d+(?::\d+)?$/i, "");
}

export function __resetCustomProviderFormatsForTests(): void {
  anthropicFormat.clear();
}
