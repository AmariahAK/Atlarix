/**
 * The `relic` tool's result, as the chat shows it. Renderer-safe (no Node).
 * The result may arrive bare or in the registry's `{success, result}` envelope.
 */
export interface RelicView {
  id: string;
  title: string;
  kind: "page" | "design";
  hosted: boolean;
  url?: string;
  path?: string;
  version?: number;
}

export function parseRelicResult(resultText: string | undefined): RelicView | null {
  if (!resultText) return null;
  let v: unknown;
  try {
    v = JSON.parse(resultText);
  } catch {
    return null;
  }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const r = (o.result && typeof o.result === "object" ? o.result : o) as Record<string, unknown>;
  if (r.success === false || typeof r.id !== "string") return null;
  if (typeof r.url !== "string" && typeof r.path !== "string") return null;
  return {
    id: r.id,
    title: typeof r.title === "string" && r.title ? r.title : r.id,
    kind: r.kind === "design" ? "design" : "page",
    hosted: r.hosted === true,
    url: typeof r.url === "string" ? r.url : undefined,
    path: typeof r.path === "string" ? r.path : undefined,
    version: typeof r.version === "number" ? r.version : undefined,
  };
}
