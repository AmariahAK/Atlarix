import type { McpServerSummary } from "@/cli/agent/services";
import type { Tone } from "./dialogs";

/**
 * The right-hand state of a server on this computer in /mcp: whether it
 * connects, not just its switch. A server that was on but couldn't connect
 * read "✓ on" here while the editor said "Couldn't connect" (15.7.0 QA).
 */
export function mcpServerRight(s: McpServerSummary): { text: string; tone: Tone } {
  if (s.needsSignIn) return { text: "sign in", tone: "muted" };
  if (!s.enabled) return { text: "○ off", tone: "muted" };
  if (!s.connection) return { text: "connecting…", tone: "muted" };
  return s.connection.ok ? { text: "✓ connected", tone: "accent" } : { text: "✗ couldn't connect", tone: "error" };
}

/**
 * The words that say why, first: the row is one line cut to the dialog's
 * width, and "Connection closed: Error" was all that fitted of
 * "Connection closed: Error: Cannot find module …" (QA B1b). The SDK's own
 * prefix and a bare "Error:" say nothing.
 */
function telling(reason: string): string {
  const said = reason.replace(/^MCP error -?\d+:\s*/, "").replace(/^Connection closed:\s*(?=\S)/, "");
  return said.replace(/^Error:\s*/, "") || reason;
}

/** The reason a server couldn't connect, for its detail line. */
export function mcpServerDetail(s: McpServerSummary): string {
  const where = `this computer · ${s.transport}`;
  return s.enabled && s.connection && !s.connection.ok ? `${where} · ${telling(s.connection.error)}` : where;
}
