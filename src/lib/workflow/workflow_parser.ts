/**
 * Workflow Parser - Phase 1 (v2+)
 * Parses n8n/Zapier-style JSON workflows for AI code generation.
 * Uses DecayAI/n8n-node-definitions for 500+ nodes (no hardcoding).
 */

import { mapWorkflowToStack } from "./n8n_node_registry";

export interface WorkflowNode {
  id: string;
  type: string;
  parameters?: Record<string, unknown>;
  position?: [number, number];
}

export interface WorkflowConnection {
  source: string;
  target: string;
  type?: "main" | "error";
}

export interface TechStack {
  backend?: string;
  database?: string | null;
  integrations: string[];
  features: string[];
  packages?: string[];
}

export interface ParsedWorkflow {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  suggestedStack: TechStack;
  requiredEnv: string[];
  raw: unknown;
}

/**
 * Try to extract workflow JSON from a string (handles wrapped JSON in markdown or text).
 */
function extractWorkflowJson(text: string): string | null {
  const jsonBlock = text.match(/\{[\s\S]*"nodes"[\s\S]*\}/);
  if (jsonBlock) {
    try {
      JSON.parse(jsonBlock[0]);
      return jsonBlock[0];
    } catch {
      // fall through
    }
  }
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (codeBlock) {
    try {
      JSON.parse(codeBlock[1]);
      return codeBlock[1];
    } catch {
      // fall through
    }
  }
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed?.nodes && Array.isArray(parsed.nodes)) return text.trim();
  } catch {
    // not valid JSON
  }
  return null;
}

/**
 * Extract connections from n8n connections format.
 */
function extractConnections(connections: unknown): WorkflowConnection[] {
  if (!connections || typeof connections !== "object") return [];
  const result: WorkflowConnection[] = [];
  const conn = connections as Record<string, unknown>;
  for (const [sourceId, outputs] of Object.entries(conn)) {
    if (!outputs || typeof outputs !== "object") continue;
    const out = outputs as Record<string, unknown>;
    const main = out.main as unknown[] | undefined;
    if (Array.isArray(main)) {
      for (const outputList of main) {
        if (!Array.isArray(outputList)) continue;
        for (const item of outputList) {
          const target = (item as { node?: string })?.node;
          if (typeof target === "string") {
            result.push({ source: sourceId, target, type: "main" });
          }
        }
      }
    }
  }
  return result;
}

/**
 * Parse workflow JSON (n8n or similar format).
 * Uses n8n-node-definitions for tech stack inference (async).
 */
export async function parseWorkflow(json: string): Promise<ParsedWorkflow | null> {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const nodesRaw = raw.nodes as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) return null;

    const nodes: WorkflowNode[] = nodesRaw.map((n) => ({
      id: String(n.id ?? ""),
      type: String(n.type ?? (n as { name?: string }).name ?? ""),
      parameters: (n.parameters as Record<string, unknown>) ?? {},
      position: n.position as [number, number] | undefined,
    }));

    const connections = extractConnections(raw.connections ?? raw.edges ?? {});

    // Use n8n-node-definitions for stack inference (no hardcoding)
    const nodeTypes = nodes.map((n) => n.type).filter(Boolean);
    const mapped = await mapWorkflowToStack(nodeTypes);

    const suggestedStack: TechStack = {
      backend: mapped.backend,
      database: mapped.database,
      integrations: mapped.integrations,
      features: mapped.displayNames,
      packages: mapped.packages,
    };

    return {
      nodes,
      connections,
      suggestedStack,
      requiredEnv: mapped.envVars,
      raw,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a string likely contains workflow JSON.
 */
export function hasWorkflowJson(text: string): boolean {
  return /"nodes"\s*:\s*\[/.test(text) || /\{[\s\S]*"nodes"[\s\S]*\}/.test(text);
}

/**
 * Generate AI prompt from parsed workflow.
 */
export function workflowToPrompt(parsed: ParsedWorkflow, extraContext?: string): string {
  const { nodes, connections, suggestedStack, requiredEnv } = parsed;
  const nodeSummary = nodes
    .map((n) => {
      const params = n.parameters ? JSON.stringify(n.parameters) : "";
      return `- ${n.type} (id: ${n.id})${params ? ` params: ${params}` : ""}`;
    })
    .join("\n");
  const connectionSummary = connections
    .map((c) => `${c.source} → ${c.target}`)
    .join(", ");
  const stackParts: string[] = [];
  if (suggestedStack.backend) stackParts.push(`Backend: ${suggestedStack.backend}`);
  if (suggestedStack.database) stackParts.push(`Database: ${suggestedStack.database}`);
  if (suggestedStack.integrations.length) stackParts.push(`Integrations: ${suggestedStack.integrations.join(", ")}`);
  if (suggestedStack.packages?.length) stackParts.push(`Packages: ${suggestedStack.packages.join(", ")}`);
  if (requiredEnv.length) stackParts.push(`Env vars: ${requiredEnv.join(", ")}`);

  let prompt = `Generate production-ready code for this workflow:

## Nodes
${nodeSummary}

## Data Flow
${connectionSummary || "(none extracted)"}

## Suggested Tech Stack (from n8n node definitions)
${stackParts.join("\n")}

## Requirements
- Error handling
- Input validation
- Environment variables for secrets
- Clean structure`;

  if (extraContext?.trim()) {
    prompt += `\n\n## Additional Context\n${extraContext.trim()}`;
  }

  return prompt;
}

/**
 * Detect workflow JSON in user message, parse, and return enhanced prompt if found.
 * Async: fetches n8n node definitions on demand.
 */
export async function processPromptForWorkflow(userMessage: string): Promise<{
  prompt: string;
  wasWorkflow: boolean;
  parsed?: ParsedWorkflow;
}> {
  if (!hasWorkflowJson(userMessage)) {
    return { prompt: userMessage, wasWorkflow: false };
  }

  const jsonStr = extractWorkflowJson(userMessage);
  if (!jsonStr) return { prompt: userMessage, wasWorkflow: false };

  const parsed = await parseWorkflow(jsonStr);
  if (!parsed) return { prompt: userMessage, wasWorkflow: false };

  const before = userMessage.slice(0, userMessage.indexOf(jsonStr)).trim();
  const after = userMessage.slice(userMessage.indexOf(jsonStr) + jsonStr.length).trim();
  const extraContext = [before, after].filter(Boolean).join("\n\n");

  const enhancedPrompt = workflowToPrompt(parsed, extraContext || undefined);
  return { prompt: enhancedPrompt, wasWorkflow: true, parsed };
}
