/**
 * The provider a person is on, as every surface names it beside the model: the
 * CLI header, the editors' pickers and chips, the desktop chip. Pure, with no
 * imports: the VS Code webview, the TUI's first frame and the renderer all use it.
 *
 * - Atlarix (compass): null, so the caller keeps the plan ("Free", "Pro").
 * - An endpoint the user added (`custom::…`, or the CLI's `--provider-url`
 *   endpoints, `atlarix-cli-dev-<hash>`): its name exactly as given ("Work (EU)").
 * - Anything else: the catalog's name without its one bracketed note
 *   ("OpenRouter (BYOK)" → "OpenRouter", "Kimi (Moonshot)" → "Kimi").
 */
export function providerLabel(p: { id: string; name?: string | null; type?: "cloud" | "local" | "custom" }): string | null {
  if (p.id === "compass") return null;
  const name = p.name?.trim() || "";
  if (p.type === "custom" || p.id.startsWith("custom::") || p.id.startsWith("atlarix-cli-dev")) {
    return name || p.id.replace(/^custom::/, "");
  }
  return (name || p.id).replace(/\s*\([^()]*\)\s*$/, "") || name || p.id;
}

/**
 * A model label without a trailing "(Provider)" that only repeats the provider
 * shown beside it ("qwen2.5:3b (My Server)" → "qwen2.5:3b"). A bracket that is
 * part of the model's own name ("Nova Micro (US)") stays.
 */
export function withoutProviderSuffix(label: string, provider: string | null | undefined): string {
  const tail = provider?.trim() ? ` (${provider.trim()})`.toLowerCase() : null;
  const trimmed = label.trimEnd();
  if (!tail || !trimmed.toLowerCase().endsWith(tail) || trimmed.length === tail.length) return label;
  return trimmed.slice(0, -tail.length).trimEnd();
}
