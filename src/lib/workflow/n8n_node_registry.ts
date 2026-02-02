/**
 * n8n Node Registry - Fetches node definitions from DecayAI/n8n-node-definitions
 * Credentials from n8n-io/n8n (auto env vars, heuristic packages).
 * No hardcoding.
 */

import { getCredentialMapping } from "./n8n_credential_loader";
import { DATABASE_NODE_PATTERNS } from "./credential_mappings";

const N8N_DEFINITIONS_BASE =
  "https://raw.githubusercontent.com/DecayAI/n8n-node-definitions/main/nodes";

export interface N8nNodeDefinition {
  name: string;
  displayName: string;
  description?: string;
  credentials?: Array<{ name: string; required?: boolean }>;
  properties?: unknown[];
  group?: string[];
  codex?: { categories?: string[] };
}

const cache = new Map<string, N8nNodeDefinition | null>();

/** Friendly display names for inferred atlaflow.* nodes (all languages) */
const ATLAFLOW_DISPLAY_NAMES: Record<string, string> = {
  atlaflow_reactApp: "React App",
  atlaflow_nextApp: "Next.js App",
  atlaflow_vueApp: "Vue App",
  atlaflow_apiServer: "API Server",
  atlaflow_app: "App",
  atlaflow_pythonApp: "Python App",
  atlaflow_pythonApi: "FastAPI",
  atlaflow_djangoApp: "Django App",
  atlaflow_flaskApp: "Flask App",
  atlaflow_goApp: "Go App",
  atlaflow_rustApp: "Rust App",
  atlaflow_rubyApp: "Ruby App",
  atlaflow_javaApp: "Java App",
  atlaflow_phpApp: "PHP App",
  atlaflow_dotnetApp: ".NET App",
  atlaflow_denoApp: "Deno App",
  atlaflow_elixirApp: "Elixir App",
  atlaflow_module: "Module",
};

/**
 * Fetch a single node definition from n8n-node-definitions.
 * Caches results; returns null for unknown/failed fetches.
 * For atlaflow.* inferred nodes, returns a minimal def with displayName.
 */
export async function getNodeDefinition(
  nodeType: string
): Promise<N8nNodeDefinition | null> {
  if (nodeType.startsWith("atlaflow.")) {
    const key = nodeType.replace(/\./g, "_");
    const displayName =
      ATLAFLOW_DISPLAY_NAMES[key] ||
      nodeType.replace("atlaflow.", "").replace(/([A-Z])/g, " $1").trim() ||
      nodeType;
    return {
      name: nodeType,
      displayName,
      group: ["inferred"],
    };
  }

  const normalized = nodeType.startsWith("n8n-nodes-base.")
    ? nodeType
    : `n8n-nodes-base.${nodeType}`;
  const fileName = `${normalized}.json`;
  const cached = cache.get(normalized);
  if (cached !== undefined) return cached;

  try {
    const url = `${N8N_DEFINITIONS_BASE}/${fileName}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      cache.set(normalized, null);
      return null;
    }
    const def = (await res.json()) as N8nNodeDefinition;
    if (!def.name) def.name = normalized;
    if (!def.displayName) def.displayName = normalized.replace("n8n-nodes-base.", "");
    cache.set(normalized, def);
    return def;
  } catch {
    cache.set(normalized, null);
    return null;
  }
}

export interface MappedStack {
  backend: string;
  database: string | null;
  integrations: string[];
  packages: string[];
  envVars: string[];
  displayNames: string[];
}

/**
 * Map a node type to tech stack using n8n definition + credential mappings.
 */
export async function mapNodeToStack(
  nodeType: string
): Promise<Partial<MappedStack>> {
  const def = await getNodeDefinition(nodeType);
  const result: Partial<MappedStack> = {
    integrations: [],
    packages: [],
    envVars: [],
    displayNames: [],
  };

  if (!def) {
    result.displayNames = [nodeType];
    return result;
  }

  result.displayNames = [def.displayName];

  // Webhook/trigger → Express
  const lowerName = (def.displayName || "").toLowerCase();
  const isWebhook =
    lowerName.includes("webhook") ||
    (def.group || []).some((g) => g.toLowerCase().includes("trigger"));
  if (isWebhook) {
    result.backend = "Express";
  }

  // Database nodes
  const dbKey = (def.name || "").replace("n8n-nodes-base.", "").toLowerCase();
  const dbMatch = DATABASE_NODE_PATTERNS[dbKey];
  if (dbMatch) {
    result.database = dbMatch.database;
    if (dbMatch.orm) result.integrations = [dbMatch.orm];
  }

  // Credentials → env, packages (from n8n source, auto-generated)
  for (const cred of def.credentials || []) {
    const mapping = await getCredentialMapping(cred.name);
    if (mapping.env.length) result.envVars!.push(...mapping.env);
    if (mapping.package) result.packages!.push(mapping.package);
    if (mapping.integration) result.integrations!.push(mapping.integration);
  }

  // If no credential mapping but we have displayName, use it as integration
  if (
    result.integrations!.length === 0 &&
    def.displayName &&
    !isWebhook
  ) {
    result.integrations = [def.displayName];
  }

  return result;
}

/**
 * Map all nodes in a workflow to combined tech stack.
 */
export async function mapWorkflowToStack(
  nodeTypes: string[]
): Promise<MappedStack> {
  const stack: MappedStack = {
    backend: "Express",
    database: null,
    integrations: [],
    packages: ["express"],
    envVars: [],
    displayNames: [],
  };

  const seenIntegrations = new Set<string>();
  const seenPackages = new Set<string>(["express"]);
  const seenEnv = new Set<string>();

  for (const type of nodeTypes) {
    const partial = await mapNodeToStack(type);
    if (partial.backend) stack.backend = partial.backend;
    if (partial.database) stack.database = partial.database;
    for (const i of partial.integrations || []) {
      if (!seenIntegrations.has(i)) {
        seenIntegrations.add(i);
        stack.integrations.push(i);
      }
    }
    for (const p of partial.packages || []) {
      if (!seenPackages.has(p)) {
        seenPackages.add(p);
        stack.packages.push(p);
      }
    }
    for (const e of partial.envVars || []) {
      seenEnv.add(e);
    }
    for (const d of partial.displayNames || []) {
      if (!stack.displayNames.includes(d)) stack.displayNames.push(d);
    }
  }

  stack.packages = Array.from(seenPackages);
  stack.envVars = Array.from(seenEnv);
  return stack;
}
