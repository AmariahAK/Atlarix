import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { oauthConnectedFromRow } from "@/lib/mcp/oauth-token-utils";
import { loadPrioritySkillsForWorkspace } from "@/lib/skills/priority-skill-loader";

// No cap. This is a NAMES list — a truncated one told the model that skills 11+
// simply did not exist, which is the worst possible failure for a summary whose
// entire job is to say what is available. (The bodies were the expensive part
// and they no longer travel in the prompt at all; see skill-index.ts.)

export type WorkspaceCapabilitiesSummary = {
  skillNames: string[];
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

  /**
   * Read the skills from DISK, not from a table.
   *
   * This used to select from `installed_skills`, which the v14.45 marketplace deletion
   * drops. Left alone it would not have errored — it would have quietly returned nothing
   * forever, and the prompt below would have told the model on every single turn that
   * there are no skills and to "browse Settings → Skills to install", advertising a page
   * that no longer exists. A summary that is confidently wrong is worse than an absent
   * one, and nothing would have failed to reveal it.
   *
   * `.atlarix/skills/*.md` is where skills actually live, so that is what this reports.
   */
  let skillNames: string[] = [];
  try {
    const skills = await loadPrioritySkillsForWorkspace(
      opts.workspacePath,
      false,
    );
    skillNames = skills.map((s) => s.name);
  } catch {
    // A workspace with no `.atlarix/skills/` is the common case, not an error.
  }

  return {
    skillNames,
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
  // Only the DYNAMIC state lives here (which skills/MCP servers this workspace
  // has, + oauth status). The static "how to invoke MCP/skills" guidance is in
  // <tools_registry> (mode-tool-registry.ts) — not duplicated here.
  const lines: string[] = ["## Workspace integrations (skills + MCP)", ""];

  if (summary.skillNames.length > 0) {
    lines.push(
      `**Skills (${summary.skillNames.length}):** ${summary.skillNames.join(", ")}`,
    );
  } else {
    // No "browse Settings to install" any more — there is nowhere to install FROM,
    // and pointing the model at a deleted page is how it starts telling users to
    // visit it.
    lines.push(
      "**Skills:** none (a skill is a markdown file in `.atlarix/skills/`).",
    );
  }

  if (summary.mcpServers.length > 0) {
    lines.push("");
    lines.push("**MCP servers (enabled):**");
    for (const s of summary.mcpServers) {
      const oauthNote =
        s.authType === "oauth"
          ? s.oauthConnected
            ? "oauth: connected"
            : "oauth: sign-in required (Settings → MCP → Connect)"
          : s.authType && s.authType !== "none"
            ? `auth: ${s.authType}`
            : "auth: none";
      lines.push(`- ${s.name} (${s.scope}) — ${oauthNote}`);
    }
  } else {
    lines.push("");
    lines.push("**MCP servers:** none enabled for this workspace.");
  }

  return lines.join("\n");
}
