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

/** The reason a server couldn't connect, for its detail line. */
export function mcpServerDetail(s: McpServerSummary): string {
  const where = `this computer · ${s.transport}`;
  return s.enabled && s.connection && !s.connection.ok ? `${where} · ${s.connection.error}` : where;
}
