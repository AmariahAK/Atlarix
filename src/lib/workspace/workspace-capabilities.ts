import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { installedSkills, mcpServers } from "@/db/schema";
import { oauthConnectedFromRow } from "@/lib/mcp/oauth-token-utils";
import { normalizeSkillWorkspacePath } from "@/paths/paths";

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
      and(
        enabled,
        or(
          eq(mcpServers.scope, "global"),
          and(
            eq(mcpServers.scope, "workspace"),
            eq(mcpServers.appId, opts.workspaceId),
          ),
        ),
      ),
    );

  const skillRows = await db
    .select({ name: installedSkills.name, scope: installedSkills.scope, workspacePath: installedSkills.workspacePath })
    .from(installedSkills)
    .where(
      or(
        eq(installedSkills.scope, "global"),
        eq(installedSkills.scope, "workspace"),
      ),
    );

  const normalizedWs = normalizeSkillWorkspacePath(opts.workspacePath);
  const skillNames = skillRows
    .filter(
      (r) =>
        r.scope === "global" ||
        (r.workspacePath != null &&
          normalizeSkillWorkspacePath(r.workspacePath) === normalizedWs),
    )
    .map((r) => r.name);

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
  const lines: string[] = [
    "## Workspace integrations (installed skills + MCP)",
    "",
  ];

  if (summary.skillNames.length > 0) {
    lines.push(`**Installed skills (${summary.skillNames.length}):** ${summary.skillNames.join(", ")}`);
  } else {
    lines.push("**Installed skills:** none (browse Settings → Skills to install).");
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
