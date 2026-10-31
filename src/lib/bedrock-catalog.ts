/**
 * Bedrock catalog filtering (0i).
 *
 * models.dev lists one bare on-demand id AND one inference profile per region
 * for each Claude model. The bare `anthropic.*` id is refused for every current
 * Claude model (\"…on-demand throughput isn't supported…\"), and only the profile
 * for the CONFIGURED region (plus the cross-region `global.`) can be invoked from
 * it. Keep those, drop the rest, so the picker only offers models that will
 * actually answer.
 */

/** AWS region → Bedrock inference-profile prefix (\"\" when the region has none). */
export function bedrockInferencePrefixForRegion(region: string): string {
  const code = (region || "").trim().toLowerCase().split("-")[0] ?? "";
  if (code === "us") return "us.";
  if (code === "eu") return "eu.";
  if (code === "ap") return "apac.";
  return "";
}

/** The region prefixes Bedrock puts in front of inference-profile ids. */
const BEDROCK_REGION_PREFIXES = new Set([
  "us",
  "eu",
  "apac",
  "au",
  "jp",
  "in",
  "global",
]);

/** The region prefix of a Bedrock inference-profile id (\"us.\"), or null when not one. */
function bedrockRegionProfilePrefix(id: string): string | null {
  const m = /^([a-z0-9]+)\./.exec(id);
  if (!m) return null;
  const p = m[1].toLowerCase();
  return BEDROCK_REGION_PREFIXES.has(p) ? `${p}.` : null;
}

/**
 * Keep only the Bedrock entries invocable from `region`, and make any two
 * survivors that share a catalog name distinguishable by their profile.
 */
export function filterBedrockCatalogModels<T extends { name: string }>(
  models: Record<string, T>,
  region: string,
): Record<string, T> {
  const want = bedrockInferencePrefixForRegion(region);
  const out: Record<string, T> = {};
  for (const [id, m] of Object.entries(models)) {
    const prefix = bedrockRegionProfilePrefix(id);
    if (prefix !== null) {
      // A region inference profile: keep the configured region's and `global.`.
      if (prefix === "global." || prefix === want) out[id] = m;
      continue;
    }
    // No region profile. A bare `anthropic.*` id is refused by Bedrock (it needs
    // a profile); other vendors' bare on-demand ids still work.
    if (id.startsWith("anthropic.")) continue;
    out[id] = m;
  }

  // If two survivors share a name (e.g. a live catalog that doesn't suffix its
  // names), tell them apart by profile so a broken one is never picked by
  // accident.
  const nameCounts = new Map<string, number>();
  for (const m of Object.values(out))
    nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
  for (const [id, m] of Object.entries(out)) {
    const prefix = bedrockRegionProfilePrefix(id);
    if (prefix !== null && (nameCounts.get(m.name) ?? 0) > 1) {
      out[id] = { ...m, name: `${m.name} (${prefix.slice(0, -1)})` };
    }
  }
  return out;
}
