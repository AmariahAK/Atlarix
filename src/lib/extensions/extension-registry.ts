/**
 * Extension Registry — Atlarix Extensions System (v3.5)
 * Extensions add left-panel tabs and optional AI tools. Not VS Code extensions.
 */

import type { ComponentType } from "react";

export type ExtensionTier = "free" | "pro" | "workforce" | "vanguard";

export interface ExtensionToolDescriptor {
  name: string;
  description: string;
  /** Permission level: ask = read-only, build = can modify */
  permissionLevel?: "ask" | "build";
}

export interface Extension<P = { workspaceId: number | null }> {
  id: string;
  name: string;
  /** Lucide icon name (e.g. "Database", "Github") for sidebar/manager */
  icon: string;
  description: string;
  tier: ExtensionTier;
  /** Panel component shown in the left panel when extension is active. Lazy-loaded to avoid circular deps. */
  getPanelComponent: () => Promise<ComponentType<P>>;
  /** AI tools this extension adds (registered when extension is activated) */
  tools: ExtensionToolDescriptor[];
  /** Optional: inject context into system prompt (e.g. schema summary) */
  contextInjector?: (workspaceId: number | null) => Promise<string>;
}



/** Placeholder panel for extensions not yet implemented. */
function PlaceholderPanel() {
  return null;
}

/** Extensions available in v3.5 (DB Studio Pro preview). Placeholders for v4. */
export const BUILTIN_EXTENSIONS: Extension[] = [
  {
    id: "db-studio",
    name: "DB Studio",
    icon: "Database",
    description: "Connect to any database. AI sees live schema and can run approved queries.",
    tier: "pro",
    getPanelComponent: async () => {
      const { DBPanel } = await import("@/components/extensions/DBPanel");
      return DBPanel as ComponentType<{ workspaceId: number | null }>;
    },
    tools: [
      { name: "db_query", description: "Run a read-only SQL query", permissionLevel: "ask" },
      { name: "db_schema", description: "Get full schema for the active connection", permissionLevel: "ask" },
      { name: "db_list", description: "List configured database connections", permissionLevel: "ask" },
      { name: "db_mutate", description: "Execute a write SQL statement (requires approval)", permissionLevel: "build" },
    ],
  },
  {
    id: "github-actions",
    name: "GitHub Actions",
    icon: "Workflow",
    description: "View workflow runs, jobs, and stream job logs. Connect GitHub in Settings → Extensions.",
    tier: "pro",
    getPanelComponent: async () => {
      const { GitHubActionsPanelWrapper } = await import("@/components/extensions/GitHubActionsPanelWrapper");
      return GitHubActionsPanelWrapper as ComponentType<{ workspaceId: number | null }>;
    },
    tools: [],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "Github",
    description: "PR creation, review comments in Activity, branch management.",
    tier: "workforce",
    getPanelComponent: async () => PlaceholderPanel as ComponentType<{ workspaceId: number | null }>,
    tools: [],
  },
  {
    id: "slack",
    name: "Slack",
    icon: "MessageCircle",
    description: "Slack integration for Workforce.",
    tier: "workforce",
    getPanelComponent: async () => PlaceholderPanel as ComponentType<{ workspaceId: number | null }>,
    tools: [],
  },
  {
    id: "jira",
    name: "Jira",
    icon: "CheckSquare",
    description: "Jira integration for Workforce.",
    tier: "workforce",
    getPanelComponent: async () => PlaceholderPanel as ComponentType<{ workspaceId: number | null }>,
    tools: [],
  },
  {
    id: "log-streamer",
    name: "Log Streamer",
    icon: "ScrollText",
    description: "Connect to deployed services; errors in logs surface to Reviewer.",
    tier: "workforce",
    getPanelComponent: async () => PlaceholderPanel as ComponentType<{ workspaceId: number | null }>,
    tools: [],
  },
];

export function getExtensionById(id: string): Extension | undefined {
  return BUILTIN_EXTENSIONS.find((e) => e.id === id);
}
