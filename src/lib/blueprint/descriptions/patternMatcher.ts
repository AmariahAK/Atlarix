/**
 * Heuristic pattern matcher for human-readable descriptions when JSDoc/docstring is missing.
 */

export type NodeKind = "api" | "webhook" | "function" | "feature" | "class";

/**
 * Generate a simple description from node name, kind, and optional path.
 */
export function getSimpleDescriptionFromPattern(
  name: string,
  kind: NodeKind,
  path?: string
): string | null {
  const n = name.trim();
  if (!n) return null;

  if (kind === "api") {
    if (n.startsWith("GET ")) return `API endpoint to retrieve ${n.slice(4).trim() || "resource"}`;
    if (n.startsWith("POST ")) return `API endpoint to create ${n.slice(5).trim() || "resource"}`;
    if (n.startsWith("PUT ")) return `API endpoint to update ${n.slice(4).trim() || "resource"}`;
    if (n.startsWith("PATCH ")) return `API endpoint to partially update ${n.slice(6).trim() || "resource"}`;
    if (n.startsWith("DELETE ")) return `API endpoint to delete ${n.slice(7).trim() || "resource"}`;
    return `API endpoint: ${n}`;
  }

  if (kind === "webhook") return `Webhook handler for ${n}`;

  if (n.startsWith("create") && n.length > 6) {
    const rest = n.slice(6).replace(/([A-Z])/g, " $1").trim();
    return `Creates a new ${rest || "entity"}`;
  }
  if (n.startsWith("use") && n.length > 3 && n[3] === n[3].toUpperCase()) {
    const rest = n.slice(3).replace(/([A-Z])/g, " $1").trim();
    return `React hook for ${rest.toLowerCase() || "state"}`;
  }
  if (n.startsWith("get") && n.length > 3 && n[3] === n[3].toUpperCase()) {
    const rest = n.slice(3).replace(/([A-Z])/g, " $1").trim();
    return `Retrieves ${rest.toLowerCase() || "data"}`;
  }
  if (n.startsWith("set") && n.length > 3 && n[3] === n[3].toUpperCase()) {
    const rest = n.slice(3).replace(/([A-Z])/g, " $1").trim();
    return `Sets ${rest.toLowerCase() || "value"}`;
  }
  if (n.startsWith("handle") && n.length > 6) {
    const rest = n.slice(6).replace(/([A-Z])/g, " $1").trim();
    return `Handles ${rest.toLowerCase() || "event"}`;
  }
  if (n.startsWith("fetch") && n.length > 5) {
    return `Fetches ${n.slice(5).replace(/([A-Z])/g, " $1").trim().toLowerCase() || "data"}`;
  }
  if (n.endsWith("Provider")) {
    const rest = n.slice(0, -8).replace(/([A-Z])/g, " $1").trim();
    return `Context provider for ${rest.toLowerCase() || "app"}`;
  }
  if (n.endsWith("Context")) {
    const rest = n.slice(0, -7).replace(/([A-Z])/g, " $1").trim();
    return `Context for ${rest.toLowerCase() || "state"}`;
  }
  if (n[0] === n[0].toUpperCase() && n.length > 1) {
    return `${n.replace(/([A-Z])/g, " $1").trim()} component`;
  }
  const withSpaces = n.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim().toLowerCase();
  return `${withSpaces.charAt(0).toUpperCase()}${withSpaces.slice(1)}`;
}
