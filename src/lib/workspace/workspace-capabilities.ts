import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { oauthConnectedFromRow } from "@/lib/mcp/oauth-token-utils";

/**
 * MCP ONLY. Skills used to be here too — first as names from the `installed_skills`
 * table, then briefly read from disk when that table was dropped — and both were
 * removed in v14.45.
 *
 * The disk version is the interesting one to have deleted: it duplicated a directory
 * enumeration `skill-index.ts` already performs every turn, to populate a field the
 * prompt then stopped printing. Two reads for one number nobody used. Skills belong to
 * `skill-index.ts`; this file is about MCP.
 */
export type WorkspaceCapabilitiesSummary = {
  mcpServers: Array<{
    name: string;
    scope: string;
    authType: string | null;
    oauthConnected: boolean;
  }>;
};

export async function loadWorkspaceCapabilitiesSummary(opts: {
  workspaceId: number;
  workspacePath: string;
}): Promise<WorkspaceCapabilitiesSummary> {
  const enabled = eq(mcpServers.enabled, true as any);
  const mcpRows = await db
    .select({
      name: mcpServers.name,
      scope: mcpServers.scope,
      authType: mcpServers.authType,
      oauthTokensJson: mcpServers.oauthTokensJson,
    })
    .from(mcpServers)
    .where(
      // Per-workspace only: the `scope = 'global'` alternative this used to carry
      // could never match (rows purged by migration 0049, and nothing creates
      // one), so it only widened the query.
      and(
        enabled,
        eq(mcpServers.scope, "workspace"),
        eq(mcpServers.appId, opts.workspaceId),
      ),
    );

  return {
    mcpServers: mcpRows.map((r) => ({
      name: r.name,
      scope: r.scope,
      authType: r.authType,
      oauthConnected: oauthConnectedFromRow({
        authType: r.authType,
        oauthTokensJson: r.oauthTokensJson,
      }),
    })),
  };
}

export function formatWorkspaceCapabilitiesForPrompt(
  summary: WorkspaceCapabilitiesSummary,
): string {
  /**
   * SAYS NOTHING WHEN THERE IS NOTHING, and that is the change worth explaining.
   *
   * This used to emit, on every turn of every workspace with nothing configured:
   *
   *   ## Workspace integrations (skills + MCP)
   *   **Skills:** none (a skill is a markdown file in `.atlarix/skills/`).
   *   **MCP servers:** none enabled for this workspace.
   *
   * ~40 tokens to report two absences, forever — and duplicated, because
   * `list_available_mcps` already answers "No MCP servers configured" at the moment the
   * model asks. Informing the model that a thing does not exist is not the same as the
   * model being able to find out; the second is what a tool is for.
   *
   * The skills half is gone entirely: `skill-index.ts` owns that line now.
   *
   * What remains is a COUNT of enabled MCP servers, for the same reason skills are a
   * count — the details are one tool call away and the tool returns them, including the
   * per-server auth state this section used to duplicate.
   */
  if (summary.mcpServers.length === 0) return "";

  const needsAuth = summary.mcpServers.filter(
    (s) => s.authType === "oauth" && !s.oauthConnected,
  ).length;

  const lines = [
    `## MCP servers (${summary.mcpServers.length} enabled)`,
    `Call \`list_available_mcps\` for their names and tools, then \`mcp_call\` to invoke one.`,
  ];
  if (needsAuth > 0) {
    // The one detail worth pre-empting: an unconnected OAuth server fails at the
    // moment of use with a remedy only the user can apply, and a model that learns
    // that from a tool error tends to retry rather than say so.
    lines.push(
      `${needsAuth} of them need the user to sign in first (Settings → MCP → Connect) and will fail until then.`,
    );
  }
  return lines.join("\n");
}
