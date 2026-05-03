/**
 * Shared diagram-generation Mermaid rules (keep in sync with product expectations).
 */

/** Verbatim copy for all architecture diagram system prompts. */
export const DIAGRAM_MERMAID_CRITICAL_RULES = `
CRITICAL MERMAID SYNTAX RULES — NEVER VIOLATE:
- NEVER use parentheses ( ) inside square bracket node labels [ ]
  WRONG:  [Client Tier (TypeScript)]
  RIGHT:  [Client Tier - TypeScript]
  RIGHT:  [Client Tier: TypeScript]
- NEVER use special characters { } ( ) | < > inside any node label
- Subgraph titles must be plain words only, no punctuation
- For type annotations, use a dash or colon as separator
- Mentally check every node label before outputting — if it contains ( or ), rewrite it
`.trim();
