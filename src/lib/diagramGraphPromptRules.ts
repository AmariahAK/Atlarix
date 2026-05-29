/**
 * Shared diagram-generation graph JSON rules (keep in sync with visual-artifacts skill).
 */

/** Verbatim copy for all architecture diagram system prompts. */
export const DIAGRAM_GRAPH_CRITICAL_RULES = `
CRITICAL GRAPH JSON RULES — NEVER VIOLATE:
- Respond with ONLY a JSON object (no prose, no markdown fences in raw API output).
- Required shape:
  {
    "title": "optional short title",
    "nodes": [{ "id": "uniqueId", "name": "Label shown on node" }],
    "edges": [{ "source": "sourceId", "target": "targetId" }]
  }
- Every edge source/target MUST reference an existing node id.
- Node ids: use camelCase or short strings — no spaces.
- Do NOT include x/y coordinates unless explicitly asked for a fixed layout.
- Do NOT output Mermaid, flowchart syntax, or rendering code.
`.trim();
